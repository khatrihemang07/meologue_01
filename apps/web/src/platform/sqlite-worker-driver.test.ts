import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OpenTimeoutError,
  SecondTabError,
  StorageUnavailableError,
  WorkerLoadError,
} from "@/lib/entry-store-errors";
import type { WorkerPort, WorkerRequest, WorkerResponse } from "./sqlite-worker-driver";
import { SqliteWorkerDriver } from "./sqlite-worker-driver";

/**
 * Stands in for the real Worker, so this suite verifies the driver's
 * request/response correlation and error classification without a real
 * Worker or OPFS — mirrors how sync-transport.test.ts injects `fetch`.
 * `fail`/`failToDeserialize` (issue #159) stand in for the DOM's own
 * `onerror`/`onmessageerror` events — the signal a real `Worker` gives when
 * it fails *outside* the postMessage protocol these `reply()`-driven tests
 * otherwise exercise.
 */
class FakePort implements WorkerPort {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  readonly sent: WorkerRequest[] = [];

  postMessage(message: WorkerRequest): void {
    this.sent.push(message);
  }

  reply(response: WorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
  }

  fail(message: string): void {
    this.onerror?.({ message, filename: "sqlite-worker.web.ts", lineno: 1 } as ErrorEvent);
  }

  failToDeserialize(): void {
    this.onmessageerror?.({ data: undefined } as MessageEvent);
  }
}

describe("SqliteWorkerDriver", () => {
  describe("connect", () => {
    it("resolves when the worker confirms the store opened", async () => {
      const port = new FakePort();
      const driver = new SqliteWorkerDriver(port);

      const opened = driver.connect();
      port.reply({ type: "open", ok: true });

      await expect(opened).resolves.toBeUndefined();
      expect(port.sent).toEqual([{ type: "open" }]);
    });

    it("rejects with SecondTabError when the worker reports the pool is already locked", async () => {
      const port = new FakePort();
      const driver = new SqliteWorkerDriver(port);

      const opened = driver.connect();
      port.reply({
        type: "open",
        ok: false,
        kind: "second-tab",
        name: "NoModificationAllowedError",
        message: "already open elsewhere",
      });

      await expect(opened).rejects.toBeInstanceOf(SecondTabError);
    });

    it("rejects with StorageUnavailableError for any other open failure", async () => {
      const port = new FakePort();
      const driver = new SqliteWorkerDriver(port);

      const opened = driver.connect();
      port.reply({
        type: "open",
        ok: false,
        kind: "unavailable",
        name: "SecurityError",
        message: "no OPFS here",
      });

      await expect(opened).rejects.toBeInstanceOf(StorageUnavailableError);
    });

    // Issue #159: the originating DOMException's name and message used to be
    // discarded the moment a failure was reduced to "unavailable" — this
    // asserts they instead survive onto the thrown error, inspectable by a
    // developer, not just onto the fixed sentence the reader sees.
    it("carries the originating error's name and message onto the thrown StorageUnavailableError", async () => {
      const port = new FakePort();
      const driver = new SqliteWorkerDriver(port);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      const opened = driver.connect();
      port.reply({
        type: "open",
        ok: false,
        kind: "unavailable",
        name: "SecurityError",
        message: "The operation is insecure",
      });

      await expect(opened).rejects.toThrow(/SecurityError.*The operation is insecure/);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("SecurityError: The operation is insecure"),
      );

      consoleError.mockRestore();
    });

    // Issue #159: a worker script that fails to load, or throws at module
    // scope, never gets far enough to post an `open` response at all — the
    // old code left `connect()` hanging forever in this case, because
    // nothing was listening for the DOM's own `error` event on the Worker.
    it("rejects with WorkerLoadError when the worker fails outside the postMessage protocol (onerror)", async () => {
      const port = new FakePort();
      const driver = new SqliteWorkerDriver(port);

      const opened = driver.connect();
      port.fail("Uncaught SyntaxError: Unexpected token");

      await expect(opened).rejects.toBeInstanceOf(WorkerLoadError);
    });

    it("rejects with WorkerLoadError when the worker posts something undeserializable (onmessageerror)", async () => {
      const port = new FakePort();
      const driver = new SqliteWorkerDriver(port);

      const opened = driver.connect();
      port.failToDeserialize();

      await expect(opened).rejects.toBeInstanceOf(WorkerLoadError);
    });

    // Issue #159: an onerror/onmessageerror failure means the worker is dead
    // for every purpose, not just the open in flight when it happened — a
    // concurrent execute() would otherwise be left hanging exactly as
    // connect() used to be.
    it("also rejects any in-flight execute() when the worker fails outside the postMessage protocol", async () => {
      const port = new FakePort();
      const driver = new SqliteWorkerDriver(port);

      const opened = driver.connect();
      port.reply({ type: "open", ok: true });
      await opened;

      const pending = driver.execute("select 1", [], "all");
      port.fail("Uncaught TypeError: something broke");

      await expect(pending).rejects.toBeInstanceOf(WorkerLoadError);
    });
  });

  describe("connect timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // Issue #159: a worker that never responds to "open" at all — not
    // erroring, not timing out inside itself, just never posting anything —
    // used to leave connect() pending forever. This is the case the timeout
    // exists for: nothing else in this driver would ever settle it.
    it("rejects with OpenTimeoutError if the worker never responds", async () => {
      const port = new FakePort();
      const driver = new SqliteWorkerDriver(port);

      const opened = driver.connect();
      const assertion = expect(opened).rejects.toBeInstanceOf(OpenTimeoutError);

      await vi.runAllTimersAsync();
      await assertion;
    });

    it("does not time out if the worker responds before the deadline", async () => {
      const port = new FakePort();
      const driver = new SqliteWorkerDriver(port);

      const opened = driver.connect();
      port.reply({ type: "open", ok: true });
      await expect(opened).resolves.toBeUndefined();

      // If the timer weren't cleared on resolution, letting it run out here
      // would throw (or otherwise disturb) an already-settled promise.
      await vi.runAllTimersAsync();
    });
  });

  describe("execute", () => {
    it("correlates concurrent calls by id, even when responses arrive out of order", async () => {
      const port = new FakePort();
      const driver = new SqliteWorkerDriver(port);

      const first = driver.execute("select 1", [], "all");
      const second = driver.execute("select 2", [], "all");

      const [firstId, secondId] = port.sent.map((request) => {
        if (request.type !== "execute") throw new Error("expected execute requests");
        return request.id;
      });

      // Reply to the second request first.
      port.reply({ type: "execute", id: secondId as number, ok: true, rows: [["b"]] });
      port.reply({ type: "execute", id: firstId as number, ok: true, rows: [["a"]] });

      await expect(first).resolves.toEqual({ rows: [["a"]] });
      await expect(second).resolves.toEqual({ rows: [["b"]] });
    });

    it("rejects when the worker reports a query error", async () => {
      const port = new FakePort();
      const driver = new SqliteWorkerDriver(port);

      const result = driver.execute("select bogus", [], "all");
      const request = port.sent[0];
      if (request?.type !== "execute") throw new Error("expected an execute request");

      port.reply({ type: "execute", id: request.id, ok: false, message: "no such column: bogus" });

      await expect(result).rejects.toThrow("no such column: bogus");
    });
  });
});
