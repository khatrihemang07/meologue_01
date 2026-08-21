import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, SYNC_BATCH_SIZE } from "./protocol";
import { sync } from "./sync-engine";
import { entry } from "./test-support/entry-fixture";
import { InMemoryEntryStore } from "./test-support/in-memory-entry-store";
import type { WireEntryOutput, WireSyncResponse } from "./wire";

const DEVICE_ID = "device-1";

function wireEntryOutput(overrides: Partial<WireEntryOutput> = {}): WireEntryOutput {
  return {
    id: "entry-1",
    device_id: DEVICE_ID,
    body: "hello meologue",
    created_at: "2026-01-01T00:00:00.000Z",
    seq: 1,
    ...overrides,
  };
}

describe("sync engine", () => {
  it("pushes pending Entries and confirms them when the server echoes back a sequence", async () => {
    const store = new InMemoryEntryStore();
    await store.upsert([entry({ id: "local-1", seq: null })]);

    const transport = vi.fn(async (request) => {
      expect(request).toEqual({
        // Asserted via the constant, not a hardcoded 1, so this test
        // doesn't have to be hand-updated the next time PROTOCOL_VERSION
        // moves (ADR 0028 already moved it once, 1 -> 2).
        protocol_version: PROTOCOL_VERSION,
        device_id: DEVICE_ID,
        since_seq: 0,
        entries: [
          {
            id: "local-1",
            device_id: DEVICE_ID,
            body: "hello meologue",
            created_at: "2026-01-01T00:00:00.000Z",
            deleted_at: null,
          },
        ],
      });
      return {
        entries: [wireEntryOutput({ id: "local-1", seq: 1 })],
        cursor: 1,
      } satisfies WireSyncResponse;
    });

    await sync({ store, transport, deviceId: DEVICE_ID, now: () => "2026-01-01T00:05:00.000Z" });

    expect(await store.pending()).toEqual([]);
    const [confirmed] = await store.list();
    expect(confirmed).toEqual(
      entry({ id: "local-1", seq: 1, syncedAt: "2026-01-01T00:05:00.000Z" }),
    );
  });

  it("advances the Cursor to the last sequence received and never regresses it", async () => {
    const store = new InMemoryEntryStore();
    await store.setCursor(10);

    const staleTransport = vi.fn(
      async () => ({ entries: [], cursor: 5 }) satisfies WireSyncResponse,
    );
    await sync({ store, transport: staleTransport, deviceId: DEVICE_ID });
    expect(await store.getCursor()).toBe(10);

    const advancingTransport = vi.fn(
      async () => ({ entries: [], cursor: 15 }) satisfies WireSyncResponse,
    );
    await sync({ store, transport: advancingTransport, deviceId: DEVICE_ID });
    expect(await store.getCursor()).toBe(15);
  });

  it("immediately runs another round when a batch comes back full", async () => {
    const store = new InMemoryEntryStore();
    const fullBatch = Array.from({ length: SYNC_BATCH_SIZE }, (_, i) =>
      wireEntryOutput({ id: `entry-${i}`, seq: i + 1 }),
    );

    const transport = vi.fn(async (request) => {
      if (request.since_seq === 0) {
        return { entries: fullBatch, cursor: SYNC_BATCH_SIZE } satisfies WireSyncResponse;
      }
      return { entries: [], cursor: request.since_seq } satisfies WireSyncResponse;
    });

    await sync({ store, transport, deviceId: DEVICE_ID });

    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ since_seq: SYNC_BATCH_SIZE }),
    );
    expect(await store.getCursor()).toBe(SYNC_BATCH_SIZE);
  });

  it("leaves pending Entries pending and the Cursor unchanged when sync fails", async () => {
    const store = new InMemoryEntryStore();
    await store.upsert([entry({ id: "local-1", seq: null })]);
    await store.setCursor(3);

    const transport = vi.fn(async () => {
      throw new Error("network unreachable");
    });

    await expect(sync({ store, transport, deviceId: DEVICE_ID })).rejects.toThrow(
      "network unreachable",
    );

    expect(await store.getCursor()).toBe(3);
    expect(await store.pending()).toEqual([entry({ id: "local-1", seq: null })]);
  });
});
