import type { SqliteDriver, SqliteMethod, SqliteResult } from "@meologue/core";
import {
  OpenTimeoutError,
  SecondTabError,
  StorageUnavailableError,
  WorkerLoadError,
} from "@/lib/entry-store-errors";

export type WorkerRequest =
  | { type: "open" }
  | { type: "execute"; id: number; sql: string; params: unknown[]; method: SqliteMethod };

export type WorkerResponse =
  | { type: "open"; ok: true }
  // `name` (issue #159) is the originating DOMException's (or Error's)
  // `.name` — the detail `classifyOpenFailure` below needs to make a
  // collapsed "unavailable" cause inspectable again. See
  // sqlite-worker.web.ts's own comment on why this travels as a field
  // rather than being folded into `message`.
  | { type: "open"; ok: false; kind: "second-tab" | "unavailable"; name: string; message: string }
  | { type: "execute"; id: number; ok: true; rows: unknown[] }
  | { type: "execute"; id: number; ok: false; message: string };

/**
 * The slice of the `Worker` API this driver needs — narrow enough to fake in
 * tests. `onerror`/`onmessageerror` (issue #159) are the DOM's own signal
 * that the worker failed *outside* its message protocol entirely — a script
 * that never loaded, threw at module scope, or posted something this side
 * couldn't deserialize. Nothing in `WorkerResponse` above can represent that
 * case, because producing a `WorkerResponse` requires the worker script to
 * have run far enough to call `postMessage` at all.
 */
export interface WorkerPort {
  postMessage(message: WorkerRequest): void;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}

// A cold OPFS pool install (sqlite-worker.web.ts's handleOpen — creating and
// formatting a whole pool of backing files the first time a Device ever
// opens the store) is measurably slower on some engines than others; ADR
// 0044 records a WebKit-specific slowdown in a different corner of this same
// storage stack, and there is no reason to assume opening is exempt from
// that pattern. 20 seconds is chosen to sit well clear of any realistic
// cold-install time on the slowest browser this app supports, while still
// being short enough that a reader staring at a disabled Composer sees an
// explanation within the span of one sitting rather than never — the entire
// point of this timeout is to eventually say *something* instead of hanging
// silently forever (issue #159).
const OPEN_TIMEOUT_MS = 20_000;

/**
 * The main-thread half of the web target's SqliteDriver (ticket 21):
 * everything that actually touches SQLite/OPFS runs in `sqlite-worker.web.ts`
 * (a dedicated Worker, required by the OPFS pool VFS); this class only
 * shuttles requests across `postMessage` and correlates responses by id, so
 * that concurrent `execute()` calls — drizzle can issue several before the
 * first resolves — don't race each other's results.
 */
export class SqliteWorkerDriver implements SqliteDriver {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (rows: unknown[]) => void; reject: (error: Error) => void }
  >();
  private openWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private readonly port: WorkerPort;

  constructor(port: WorkerPort) {
    this.port = port;
    port.onmessage = (event) => this.handleMessage(event.data);
    // Issue #159: without these, a worker script that fails to load or
    // throws at module scope never posts anything at all — no `WorkerResponse`
    // is ever produced, so `handleMessage` never runs, `openWaiter` (and any
    // in-flight `execute()`s) sit unsettled forever, and the Composer is
    // disabled with no explanation, indistinguishable from still loading.
    // `onerror` fires for a script-load/runtime failure; `onmessageerror`
    // fires when a posted message couldn't be deserialized (e.g. it
    // contained something structured-clone can't handle) — different DOM
    // events, but both mean "this worker did not, and now cannot,
    // participate in the postMessage protocol," so both are treated the
    // same way here.
    port.onerror = (event) => {
      this.handleWorkerFailure(
        new WorkerLoadError(
          `sqlite worker failed to load or threw at top level: ${event.message} (${event.filename}:${event.lineno})`,
        ),
      );
    };
    port.onmessageerror = () => {
      this.handleWorkerFailure(
        new WorkerLoadError(
          "sqlite worker posted a message that could not be deserialized (messageerror)",
        ),
      );
    };
  }

  /**
   * Tells the worker to install the OPFS pool VFS and open the database.
   * Named `connect` rather than `open` so a call site reads unambiguously
   * next to core's `open(driver)` (../../../packages/core/src/sqlite/open.ts),
   * which does something different (migrate, resolve the Device id) with a
   * driver that's already connected.
   *
   * Issue #159: this used to return a promise with nothing bounding how
   * long it could stay pending — a worker that never posts an `open`
   * response (because it never loaded, or because whatever's slow inside it
   * never finishes) left this hanging forever, indistinguishable from still
   * loading. The timeout below (`OPEN_TIMEOUT_MS`, see its own comment for
   * why 20s) gives a definite, identifiable end to that wait: it rejects
   * with `OpenTimeoutError` rather than the driver just sitting silent.
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handleWorkerFailure(
          new OpenTimeoutError(
            `sqlite worker did not respond to "open" within ${OPEN_TIMEOUT_MS}ms`,
          ),
        );
      }, OPEN_TIMEOUT_MS);
      this.openWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.port.postMessage({ type: "open" });
    });
  }

  async execute(sql: string, params: unknown[], method: SqliteMethod): Promise<SqliteResult> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (rows) => resolve({ rows }), reject });
      this.port.postMessage({ type: "execute", id, sql, params, method });
    });
  }

  private handleMessage(response: WorkerResponse): void {
    if (response.type === "open") {
      const waiter = this.openWaiter;
      this.openWaiter = null;
      if (!waiter) {
        return;
      }
      if (response.ok) {
        waiter.resolve();
      } else {
        waiter.reject(classifyOpenFailure(response));
      }
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      return;
    }
    this.pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response.rows);
    } else {
      pending.reject(new Error(response.message));
    }
  }

  // Issue #159: a worker that has failed outside the postMessage protocol
  // (onerror/onmessageerror) or that never answered `open` in time is dead
  // for every purpose, not just the one waiter that happens to be reading
  // this file's comments — any `execute()` still in flight is exactly as
  // stuck as `connect()` was, for the identical reason (nothing will ever
  // post a response for it). Rejecting the open waiter but leaving
  // `pending` untouched would just move the same silent-hang defect one
  // call later.
  private handleWorkerFailure(error: Error): void {
    const waiter = this.openWaiter;
    this.openWaiter = null;
    waiter?.reject(error);

    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
  }
}

function classifyOpenFailure(
  response: Extract<WorkerResponse, { type: "open"; ok: false }>,
): Error {
  if (response.kind === "second-tab") {
    return new SecondTabError(response.message);
  }

  // Issue #159: `classifyOpenError` (sqlite-worker.web.ts) only ever
  // distinguishes "second tab" from "everything else" — every other cause
  // (a WebKit quirk, an insecure-context edge case, storage genuinely full,
  // something not yet seen) lands here with nothing more specific than
  // "unavailable" to act on programmatically. That's still the right user
  // *action* to give (entry-store-layout.tsx's fixed copy for this branch
  // stays exactly as it reads), but it used to also be where the trail went
  // cold for a developer: the real DOMException's name and message never
  // survived past this point. They do now (`response.name`/`response.message`,
  // carried across postMessage instead of discarded) — logged here, the one
  // place this classification happens, and attached to the thrown error via
  // `cause` so a debugger inspecting the rejected promise sees the real
  // failure too, not just "unavailable".
  console.error(`sqlite worker: store open failed — ${response.name}: ${response.message}`);
  return new StorageUnavailableError(`${response.name}: ${response.message}`, {
    cause: response,
  });
}
