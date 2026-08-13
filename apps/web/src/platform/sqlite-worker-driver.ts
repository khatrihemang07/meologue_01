import type { SqliteDriver, SqliteMethod, SqliteResult } from "@meologue/core";
import { SecondTabError, StorageUnavailableError } from "@/lib/entry-store-errors";

export type WorkerRequest =
  | { type: "open" }
  | { type: "execute"; id: number; sql: string; params: unknown[]; method: SqliteMethod };

export type WorkerResponse =
  | { type: "open"; ok: true }
  | { type: "open"; ok: false; kind: "second-tab" | "unavailable"; message: string }
  | { type: "execute"; id: number; ok: true; rows: unknown[] }
  | { type: "execute"; id: number; ok: false; message: string };

/** The slice of the `Worker` API this driver needs — narrow enough to fake in tests. */
export interface WorkerPort {
  postMessage(message: WorkerRequest): void;
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
}

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
  }

  /**
   * Tells the worker to install the OPFS pool VFS and open the database.
   * Named `connect` rather than `open` so a call site reads unambiguously
   * next to core's `open(driver)` (../../../packages/core/src/sqlite/open.ts),
   * which does something different (migrate, resolve the Device id) with a
   * driver that's already connected.
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.openWaiter = { resolve, reject };
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
}

function classifyOpenFailure(
  response: Extract<WorkerResponse, { type: "open"; ok: false }>,
): Error {
  return response.kind === "second-tab"
    ? new SecondTabError(response.message)
    : new StorageUnavailableError(response.message);
}
