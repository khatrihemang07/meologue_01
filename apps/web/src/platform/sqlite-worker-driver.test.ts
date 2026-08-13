import { describe, expect, it } from "vitest";
import { SecondTabError, StorageUnavailableError } from "@/lib/entry-store-errors";
import type { WorkerPort, WorkerRequest, WorkerResponse } from "./sqlite-worker-driver";
import { SqliteWorkerDriver } from "./sqlite-worker-driver";

/**
 * Stands in for the real Worker, so this suite verifies the driver's
 * request/response correlation and error classification without a real
 * Worker or OPFS — mirrors how sync-transport.test.ts injects `fetch`.
 */
class FakePort implements WorkerPort {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  readonly sent: WorkerRequest[] = [];

  postMessage(message: WorkerRequest): void {
    this.sent.push(message);
  }

  reply(response: WorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>);
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
        message: "already open elsewhere",
      });

      await expect(opened).rejects.toBeInstanceOf(SecondTabError);
    });

    it("rejects with StorageUnavailableError for any other open failure", async () => {
      const port = new FakePort();
      const driver = new SqliteWorkerDriver(port);

      const opened = driver.connect();
      port.reply({ type: "open", ok: false, kind: "unavailable", message: "no OPFS here" });

      await expect(opened).rejects.toBeInstanceOf(StorageUnavailableError);
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
