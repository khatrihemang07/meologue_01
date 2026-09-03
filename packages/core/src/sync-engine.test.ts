import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, SYNC_BATCH_SIZE } from "./protocol";
import { sync } from "./sync-engine";
import { entry } from "./test-support/entry-fixture";
import { InMemoryEntryStore } from "./test-support/in-memory-entry-store";
import { InMemoryTaskStore } from "./test-support/in-memory-task-store";
import { task } from "./test-support/task-fixture";
import type { WireEntryOutput, WireSyncResponse, WireTaskOutput } from "./wire";

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

// Issue #172 / ADR 0051: the Task-shaped sibling of wireEntryOutput above.
function wireTaskOutput(overrides: Partial<WireTaskOutput> = {}): WireTaskOutput {
  return {
    id: "task-1",
    device_id: DEVICE_ID,
    content: "buy milk",
    completed_at: null,
    order_key: "V",
    created_at: "2026-01-01T00:00:00.000Z",
    seq: 1,
    deleted_at: null,
    date: null,
    deadline: null,
    priority: 1,
    label_ids: [],
    date_string: null,
    project_id: null,
    section_id: null,
    parent_id: null,
    ...overrides,
  };
}

// An empty response on both streams — most tests below exercise one stream
// at a time and don't care what the other one answers, so this is the
// baseline every partial `WireSyncResponse` literal spreads onto rather
// than each test having to spell out `tasks: [], task_cursor: 0` (or the
// entry-side equivalent) by hand.
const emptyResponse: WireSyncResponse = { entries: [], cursor: 0, tasks: [], task_cursor: 0 };

describe("sync engine", () => {
  it("pushes pending Entries and confirms them when the server echoes back a sequence", async () => {
    const store = new InMemoryEntryStore();
    await store.upsert([entry({ id: "local-1", seq: null })]);
    const taskStore = new InMemoryTaskStore();

    const transport = vi.fn(async (request) => {
      expect(request).toEqual({
        // Asserted via the constant, not a hardcoded 1, so this test
        // doesn't have to be hand-updated the next time PROTOCOL_VERSION
        // moves (ADR 0028 already moved it once, 1 -> 2; issue #172 moved
        // it again, 4 -> 5).
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
        since_task_seq: 0,
        tasks: [],
      });
      return {
        entries: [wireEntryOutput({ id: "local-1", seq: 1 })],
        cursor: 1,
        tasks: [],
        task_cursor: 0,
      } satisfies WireSyncResponse;
    });

    await sync({
      store,
      taskStore,
      transport,
      deviceId: DEVICE_ID,
      now: () => "2026-01-01T00:05:00.000Z",
    });

    expect(await store.pending()).toEqual([]);
    const [confirmed] = await store.list();
    expect(confirmed).toEqual(
      entry({ id: "local-1", seq: 1, syncedAt: "2026-01-01T00:05:00.000Z" }),
    );
  });

  // The Task-shaped sibling of the test above — same push/confirm shape,
  // over the second stream.
  it("pushes pending Tasks and confirms them when the server echoes back a sequence", async () => {
    const store = new InMemoryEntryStore();
    const taskStore = new InMemoryTaskStore();
    await taskStore.upsert([task({ id: "local-task-1", seq: null })]);

    const transport = vi.fn(async (request) => {
      expect(request.since_task_seq).toBe(0);
      expect(request.tasks).toEqual([
        {
          id: "local-task-1",
          device_id: DEVICE_ID,
          content: "buy milk",
          completed_at: null,
          order_key: "V",
          created_at: "2026-01-01T00:00:00.000Z",
          deleted_at: null,
          date: null,
          deadline: null,
          priority: 1,
          label_ids: [],
          date_string: null,
          project_id: null,
          section_id: null,
          parent_id: null,
        },
      ]);
      return {
        ...emptyResponse,
        tasks: [wireTaskOutput({ id: "local-task-1", seq: 1 })],
        task_cursor: 1,
      } satisfies WireSyncResponse;
    });

    await sync({
      store,
      taskStore,
      transport,
      deviceId: DEVICE_ID,
      now: () => "2026-01-01T00:05:00.000Z",
    });

    expect(await taskStore.pending()).toEqual([]);
    const confirmed = await taskStore.get("local-task-1");
    expect(confirmed).toEqual(
      task({ id: "local-task-1", seq: 1, syncedAt: "2026-01-01T00:05:00.000Z" }),
    );
  });

  // ADR 0051's whole reason for one endpoint rather than two: a pending
  // Entry and a pending Task travel in the *same* request, so a Server
  // never sees one without the other for however long a second round trip
  // would otherwise take.
  it("carries pending Entries and pending Tasks in the same request", async () => {
    const store = new InMemoryEntryStore();
    await store.upsert([entry({ id: "local-1", seq: null })]);
    const taskStore = new InMemoryTaskStore();
    await taskStore.upsert([task({ id: "local-task-1", seq: null })]);

    const transport = vi.fn(async (request) => {
      expect(request.entries).toHaveLength(1);
      expect(request.tasks).toHaveLength(1);
      return emptyResponse;
    });

    await sync({ store, taskStore, transport, deviceId: DEVICE_ID });

    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("advances the Entry Cursor to the last sequence received and never regresses it", async () => {
    const store = new InMemoryEntryStore();
    await store.setCursor(10);
    const taskStore = new InMemoryTaskStore();

    const staleTransport = vi.fn(async () => ({ ...emptyResponse, cursor: 5 }));
    await sync({ store, taskStore, transport: staleTransport, deviceId: DEVICE_ID });
    expect(await store.getCursor()).toBe(10);

    const advancingTransport = vi.fn(async () => ({ ...emptyResponse, cursor: 15 }));
    await sync({ store, taskStore, transport: advancingTransport, deviceId: DEVICE_ID });
    expect(await store.getCursor()).toBe(15);
  });

  // The Task-shaped sibling of the test above, over `task_cursor` instead
  // of `cursor` — the two Cursors are tracked, and must never regress,
  // completely independently of one another.
  it("advances the Task Cursor to the last sequence received and never regresses it", async () => {
    const store = new InMemoryEntryStore();
    const taskStore = new InMemoryTaskStore();
    await taskStore.setCursor(10);

    const staleTransport = vi.fn(async () => ({ ...emptyResponse, task_cursor: 5 }));
    await sync({ store, taskStore, transport: staleTransport, deviceId: DEVICE_ID });
    expect(await taskStore.getCursor()).toBe(10);

    const advancingTransport = vi.fn(async () => ({ ...emptyResponse, task_cursor: 15 }));
    await sync({ store, taskStore, transport: advancingTransport, deviceId: DEVICE_ID });
    expect(await taskStore.getCursor()).toBe(15);
  });

  it("immediately runs another round when the Entry batch comes back full", async () => {
    const store = new InMemoryEntryStore();
    const taskStore = new InMemoryTaskStore();
    const fullBatch = Array.from({ length: SYNC_BATCH_SIZE }, (_, i) =>
      wireEntryOutput({ id: `entry-${i}`, seq: i + 1 }),
    );

    const transport = vi.fn(async (request) => {
      if (request.since_seq === 0) {
        return { ...emptyResponse, entries: fullBatch, cursor: SYNC_BATCH_SIZE };
      }
      return { ...emptyResponse, cursor: request.since_seq };
    });

    await sync({ store, taskStore, transport, deviceId: DEVICE_ID });

    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ since_seq: SYNC_BATCH_SIZE }),
    );
    expect(await store.getCursor()).toBe(SYNC_BATCH_SIZE);
  });

  // The Task-shaped sibling of the test above — a full *Task* batch alone
  // (the Entry stream stays empty throughout) must also drive another
  // round, proving the loop's continuation check reads both streams
  // rather than only the one every other test here happens to exercise.
  it("immediately runs another round when the Task batch comes back full", async () => {
    const store = new InMemoryEntryStore();
    const taskStore = new InMemoryTaskStore();
    const fullBatch = Array.from({ length: SYNC_BATCH_SIZE }, (_, i) =>
      wireTaskOutput({ id: `task-${i}`, seq: i + 1 }),
    );

    const transport = vi.fn(async (request) => {
      if (request.since_task_seq === 0) {
        return { ...emptyResponse, tasks: fullBatch, task_cursor: SYNC_BATCH_SIZE };
      }
      return { ...emptyResponse, task_cursor: request.since_task_seq };
    });

    await sync({ store, taskStore, transport, deviceId: DEVICE_ID });

    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ since_task_seq: SYNC_BATCH_SIZE }),
    );
    expect(await taskStore.getCursor()).toBe(SYNC_BATCH_SIZE);
  });

  it("leaves pending Entries and pending Tasks pending, and both Cursors unchanged, when sync fails", async () => {
    const store = new InMemoryEntryStore();
    await store.upsert([entry({ id: "local-1", seq: null })]);
    await store.setCursor(3);
    const taskStore = new InMemoryTaskStore();
    await taskStore.upsert([task({ id: "local-task-1", seq: null })]);
    await taskStore.setCursor(7);

    const transport = vi.fn(async () => {
      throw new Error("network unreachable");
    });

    await expect(sync({ store, taskStore, transport, deviceId: DEVICE_ID })).rejects.toThrow(
      "network unreachable",
    );

    expect(await store.getCursor()).toBe(3);
    expect(await store.pending()).toEqual([entry({ id: "local-1", seq: null })]);
    expect(await taskStore.getCursor()).toBe(7);
    expect(await taskStore.pending()).toEqual([task({ id: "local-task-1", seq: null })]);
  });

  // Issue #172's own decision (recorded in ADR 0051): Projects, Sections
  // and Labels do not sync in this ticket, so a Task can arrive over the
  // wire naming a `projectId` this Device has never seen a Project row
  // for. That must not make the Task disappear, error, or have the
  // reference silently dropped — mapping.ts's fromWireTaskOutput carries
  // it straight through, and this proves the whole pull path (transport
  // response -> upsert -> a reader like list()) preserves it end to end,
  // rather than only unit-testing the mapping function in isolation.
  it("keeps a Task's Project reference intact even when the Project has never synced to this Device", async () => {
    const store = new InMemoryEntryStore();
    const taskStore = new InMemoryTaskStore();
    const unknownProjectId = "project-not-yet-seen";

    const transport = vi.fn(async () => ({
      ...emptyResponse,
      tasks: [wireTaskOutput({ id: "orphaned-task", project_id: unknownProjectId, seq: 1 })],
      task_cursor: 1,
    }));

    await sync({ store, taskStore, transport, deviceId: DEVICE_ID });

    // Not silently dropped into Inbox (`projectId: null`), and not
    // rejected outright — the dangling id round-trips honestly.
    const pulled = await taskStore.get("orphaned-task");
    expect(pulled?.projectId).toBe(unknownProjectId);
    // And the Task must never vanish because its Project hasn't arrived
    // (ADR 0051's own acceptance bar): it still surfaces through the
    // ordinary active-Task feed, exactly like any other Task.
    expect((await taskStore.list()).map((t) => t.id)).toContain("orphaned-task");
  });

  // Issue #180's own data-loss bug, reproduced end to end and pinned down
  // at the layer it actually lives at: `description` has no wire field
  // yet (mapping.ts's fromWireTaskOutput own doc comment), so an
  // *ordinary* round trip that changes nothing but a wire-covered field
  // — a rename, here — must not let that absence get treated as "the
  // wire confirms this Task has no description" and silently overwrite
  // whatever this Device already held locally. Reproduced live before
  // this fix: renaming a Task with a description, syncing, and pulling
  // the Server's echo back cleared the description in the store, not
  // only on screen.
  it("preserves a Task's locally-held description across a sync round trip that changes an unrelated, wire-covered field", async () => {
    const store = new InMemoryEntryStore();
    const taskStore = new InMemoryTaskStore();
    await taskStore.upsert([
      task({
        id: "local-task-1",
        content: "buy milk",
        description: "oat milk, not soy",
        seq: 1,
      }),
    ]);

    // The Server echoes back a rename — `content` changed and gets a
    // fresh `seq` (ADR 0051's `is distinct from` guard), but the wire
    // itself carries nothing about `description` either way; nothing in
    // `wireTaskOutput`'s own fixture has a field to even omit.
    const transport = vi.fn(async () => ({
      ...emptyResponse,
      tasks: [wireTaskOutput({ id: "local-task-1", content: "buy milk Q", seq: 2 })],
      task_cursor: 2,
    }));

    await sync({ store, taskStore, transport, deviceId: DEVICE_ID });

    const updated = await taskStore.get("local-task-1");
    expect(updated?.content).toBe("buy milk Q");
    expect(updated?.description).toBe("oat milk, not soy");
  });

  // The mirror case: a Task this Device has never held any copy of has
  // nothing to carry through, and correctly lands the same "nothing
  // chosen yet" `null` a brand-new Task starts with either way — proving
  // the fix reads `existing`, not merely refusing to ever apply `null`.
  it("a Task synced for the first time starts with no description to carry through", async () => {
    const store = new InMemoryEntryStore();
    const taskStore = new InMemoryTaskStore();

    const transport = vi.fn(async () => ({
      ...emptyResponse,
      tasks: [wireTaskOutput({ id: "brand-new-task", seq: 1 })],
      task_cursor: 1,
    }));

    await sync({ store, taskStore, transport, deviceId: DEVICE_ID });

    expect((await taskStore.get("brand-new-task"))?.description).toBeNull();
  });
});
