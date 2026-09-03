import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, SYNC_BATCH_SIZE } from "./protocol";
import { sync } from "./sync-engine";
import { entry } from "./test-support/entry-fixture";
import { InMemoryCommentStore } from "./test-support/in-memory-comment-store";
import { InMemoryEntryStore } from "./test-support/in-memory-entry-store";
import { InMemoryLabelStore } from "./test-support/in-memory-label-store";
import { InMemoryProjectStore } from "./test-support/in-memory-project-store";
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
    day_order: "V",
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
    description: null,
    ...overrides,
  };
}

// Every stream empty on both request-echoing fields it might carry —
// most tests below exercise one stream at a time and don't care what the
// others answer, so this is the baseline every partial `WireSyncResponse`
// literal spreads onto rather than each test having to spell out every
// one of issue #182's four new streams by hand.
const emptyResponse: WireSyncResponse = {
  entries: [],
  cursor: 0,
  tasks: [],
  task_cursor: 0,
  projects: [],
  project_cursor: 0,
  sections: [],
  section_cursor: 0,
  labels: [],
  label_cursor: 0,
  comments: [],
  comment_cursor: 0,
};

// A fresh set of the four stores issue #182 added, alongside `store` and
// `taskStore` — every `sync()` call in this file needs all six now
// (SyncEngineOptions' own doc comment on why each is required, not
// optional), so this is the one place that plumbing lives rather than six
// stores constructed at every call site.
function newStores() {
  const store = new InMemoryEntryStore();
  const taskStore = new InMemoryTaskStore();
  return {
    store,
    taskStore,
    projectStore: new InMemoryProjectStore(taskStore),
    labelStore: new InMemoryLabelStore(),
    commentStore: new InMemoryCommentStore(),
  };
}

describe("sync engine", () => {
  it("pushes pending Entries and confirms them when the server echoes back a sequence", async () => {
    const stores = newStores();
    await stores.store.upsert([entry({ id: "local-1", seq: null })]);

    const transport = vi.fn(async (request) => {
      expect(request).toEqual({
        // Asserted via the constant, not a hardcoded number, so this test
        // doesn't have to be hand-updated the next time PROTOCOL_VERSION
        // moves (ADR 0028 already moved it once, 1 -> 2; issue #172 moved
        // it again, 4 -> 5; issue #182 moved it again, 5 -> 6).
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
        since_project_seq: 0,
        projects: [],
        since_section_seq: 0,
        sections: [],
        since_label_seq: 0,
        labels: [],
        since_comment_seq: 0,
        comments: [],
      });
      return {
        ...emptyResponse,
        entries: [wireEntryOutput({ id: "local-1", seq: 1 })],
        cursor: 1,
      } satisfies WireSyncResponse;
    });

    await sync({
      ...stores,
      transport,
      deviceId: DEVICE_ID,
      now: () => "2026-01-01T00:05:00.000Z",
    });

    expect(await stores.store.pending()).toEqual([]);
    const [confirmed] = await stores.store.list();
    expect(confirmed).toEqual(
      entry({ id: "local-1", seq: 1, syncedAt: "2026-01-01T00:05:00.000Z" }),
    );
  });

  // The Task-shaped sibling of the test above — same push/confirm shape,
  // over the second stream.
  it("pushes pending Tasks and confirms them when the server echoes back a sequence", async () => {
    const stores = newStores();
    await stores.taskStore.upsert([task({ id: "local-task-1", seq: null })]);

    const transport = vi.fn(async (request) => {
      expect(request.since_task_seq).toBe(0);
      expect(request.tasks).toEqual([
        {
          id: "local-task-1",
          device_id: DEVICE_ID,
          content: "buy milk",
          completed_at: null,
          order_key: "V",
          day_order: "V",
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
          description: null,
        },
      ]);
      return {
        ...emptyResponse,
        tasks: [wireTaskOutput({ id: "local-task-1", seq: 1 })],
        task_cursor: 1,
      } satisfies WireSyncResponse;
    });

    await sync({
      ...stores,
      transport,
      deviceId: DEVICE_ID,
      now: () => "2026-01-01T00:05:00.000Z",
    });

    expect(await stores.taskStore.pending()).toEqual([]);
    const confirmed = await stores.taskStore.get("local-task-1");
    expect(confirmed).toEqual(
      task({ id: "local-task-1", seq: 1, syncedAt: "2026-01-01T00:05:00.000Z" }),
    );
  });

  // ADR 0051's whole reason for one endpoint rather than two: a pending
  // Entry and a pending Task travel in the *same* request, so a Server
  // never sees one without the other for however long a second round trip
  // would otherwise take.
  it("carries pending Entries and pending Tasks in the same request", async () => {
    const stores = newStores();
    await stores.store.upsert([entry({ id: "local-1", seq: null })]);
    await stores.taskStore.upsert([task({ id: "local-task-1", seq: null })]);

    const transport = vi.fn(async (request) => {
      expect(request.entries).toHaveLength(1);
      expect(request.tasks).toHaveLength(1);
      return emptyResponse;
    });

    await sync({ ...stores, transport, deviceId: DEVICE_ID });

    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("advances the Entry Cursor to the last sequence received and never regresses it", async () => {
    const stores = newStores();
    await stores.store.setCursor(10);

    const staleTransport = vi.fn(async () => ({ ...emptyResponse, cursor: 5 }));
    await sync({ ...stores, transport: staleTransport, deviceId: DEVICE_ID });
    expect(await stores.store.getCursor()).toBe(10);

    const advancingTransport = vi.fn(async () => ({ ...emptyResponse, cursor: 15 }));
    await sync({ ...stores, transport: advancingTransport, deviceId: DEVICE_ID });
    expect(await stores.store.getCursor()).toBe(15);
  });

  // The Task-shaped sibling of the test above, over `task_cursor` instead
  // of `cursor` — the two Cursors are tracked, and must never regress,
  // completely independently of one another.
  it("advances the Task Cursor to the last sequence received and never regresses it", async () => {
    const stores = newStores();
    await stores.taskStore.setCursor(10);

    const staleTransport = vi.fn(async () => ({ ...emptyResponse, task_cursor: 5 }));
    await sync({ ...stores, transport: staleTransport, deviceId: DEVICE_ID });
    expect(await stores.taskStore.getCursor()).toBe(10);

    const advancingTransport = vi.fn(async () => ({ ...emptyResponse, task_cursor: 15 }));
    await sync({ ...stores, transport: advancingTransport, deviceId: DEVICE_ID });
    expect(await stores.taskStore.getCursor()).toBe(15);
  });

  // Issue #182: the identical Cursor-never-regresses guarantee, once per
  // new stream — each Cursor is its own independent watermark (ADR 0051's
  // own reasoning for `TASK_SYNC_INSERT_LOCK_KEY`, applied a fourth time
  // to why there are four more Cursors rather than one shared number).
  it("advances the Project, Section, Label and Comment Cursors independently and never regresses any of them", async () => {
    const stores = newStores();
    await stores.projectStore.setProjectCursor(10);
    await stores.projectStore.setSectionCursor(20);
    await stores.labelStore.setCursor(30);
    await stores.commentStore.setCursor(40);

    const staleTransport = vi.fn(async () => ({
      ...emptyResponse,
      project_cursor: 1,
      section_cursor: 2,
      label_cursor: 3,
      comment_cursor: 4,
    }));
    await sync({ ...stores, transport: staleTransport, deviceId: DEVICE_ID });
    expect(await stores.projectStore.getProjectCursor()).toBe(10);
    expect(await stores.projectStore.getSectionCursor()).toBe(20);
    expect(await stores.labelStore.getCursor()).toBe(30);
    expect(await stores.commentStore.getCursor()).toBe(40);

    const advancingTransport = vi.fn(async () => ({
      ...emptyResponse,
      project_cursor: 11,
      section_cursor: 21,
      label_cursor: 31,
      comment_cursor: 41,
    }));
    await sync({ ...stores, transport: advancingTransport, deviceId: DEVICE_ID });
    expect(await stores.projectStore.getProjectCursor()).toBe(11);
    expect(await stores.projectStore.getSectionCursor()).toBe(21);
    expect(await stores.labelStore.getCursor()).toBe(31);
    expect(await stores.commentStore.getCursor()).toBe(41);
  });

  it("immediately runs another round when the Entry batch comes back full", async () => {
    const stores = newStores();
    const fullBatch = Array.from({ length: SYNC_BATCH_SIZE }, (_, i) =>
      wireEntryOutput({ id: `entry-${i}`, seq: i + 1 }),
    );

    const transport = vi.fn(async (request) => {
      if (request.since_seq === 0) {
        return { ...emptyResponse, entries: fullBatch, cursor: SYNC_BATCH_SIZE };
      }
      return { ...emptyResponse, cursor: request.since_seq };
    });

    await sync({ ...stores, transport, deviceId: DEVICE_ID });

    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ since_seq: SYNC_BATCH_SIZE }),
    );
    expect(await stores.store.getCursor()).toBe(SYNC_BATCH_SIZE);
  });

  // The Task-shaped sibling of the test above — a full *Task* batch alone
  // (the Entry stream stays empty throughout) must also drive another
  // round, proving the loop's continuation check reads every stream
  // rather than only the one every other test here happens to exercise.
  it("immediately runs another round when the Task batch comes back full", async () => {
    const stores = newStores();
    const fullBatch = Array.from({ length: SYNC_BATCH_SIZE }, (_, i) =>
      wireTaskOutput({ id: `task-${i}`, seq: i + 1 }),
    );

    const transport = vi.fn(async (request) => {
      if (request.since_task_seq === 0) {
        return { ...emptyResponse, tasks: fullBatch, task_cursor: SYNC_BATCH_SIZE };
      }
      return { ...emptyResponse, task_cursor: request.since_task_seq };
    });

    await sync({ ...stores, transport, deviceId: DEVICE_ID });

    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ since_task_seq: SYNC_BATCH_SIZE }),
    );
    expect(await stores.taskStore.getCursor()).toBe(SYNC_BATCH_SIZE);
  });

  it("leaves pending Entries and pending Tasks pending, and both Cursors unchanged, when sync fails", async () => {
    const stores = newStores();
    await stores.store.upsert([entry({ id: "local-1", seq: null })]);
    await stores.store.setCursor(3);
    await stores.taskStore.upsert([task({ id: "local-task-1", seq: null })]);
    await stores.taskStore.setCursor(7);

    const transport = vi.fn(async () => {
      throw new Error("network unreachable");
    });

    await expect(sync({ ...stores, transport, deviceId: DEVICE_ID })).rejects.toThrow(
      "network unreachable",
    );

    expect(await stores.store.getCursor()).toBe(3);
    expect(await stores.store.pending()).toEqual([entry({ id: "local-1", seq: null })]);
    expect(await stores.taskStore.getCursor()).toBe(7);
    expect(await stores.taskStore.pending()).toEqual([task({ id: "local-task-1", seq: null })]);
  });

  // Issue #172's own decision (recorded in ADR 0051): a Task can arrive
  // over the wire naming a `projectId` this Device has never seen a
  // Project row for — issue #182 gives Projects their own Sync stream, but
  // does not retroactively validate every dangling reference that
  // predates it, so this must still round-trip honestly. mapping.ts's
  // fromWireTaskOutput carries it straight through, and this proves the
  // whole pull path (transport response -> upsert -> a reader like
  // list()) preserves it end to end, rather than only unit-testing the
  // mapping function in isolation.
  it("keeps a Task's Project reference intact even when the Project has never synced to this Device", async () => {
    const stores = newStores();
    const unknownProjectId = "project-not-yet-seen";

    const transport = vi.fn(async () => ({
      ...emptyResponse,
      tasks: [wireTaskOutput({ id: "orphaned-task", project_id: unknownProjectId, seq: 1 })],
      task_cursor: 1,
    }));

    await sync({ ...stores, transport, deviceId: DEVICE_ID });

    // Not silently dropped into Inbox (`projectId: null`), and not
    // rejected outright — the dangling id round-trips honestly.
    const pulled = await stores.taskStore.get("orphaned-task");
    expect(pulled?.projectId).toBe(unknownProjectId);
    // And the Task must never vanish because its Project hasn't arrived
    // (ADR 0051's own acceptance bar): it still surfaces through the
    // ordinary active-Task feed, exactly like any other Task.
    expect((await stores.taskStore.list()).map((t) => t.id)).toContain("orphaned-task");
  });

  // Issue #182's own guarantee: `description` now has a wire field
  // (mapping.ts's toWireTaskInput/fromWireTaskOutput), so an ordinary sync
  // round trip carries it through like any other wire-covered field —
  // this is the ordinary case that regresses if a future edit accidentally
  // reintroduces the #180 workaround this ticket retired.
  it("carries a Task's description through an ordinary sync round trip", async () => {
    const stores = newStores();

    const transport = vi.fn(async () => ({
      ...emptyResponse,
      tasks: [
        wireTaskOutput({ id: "task-with-description", description: "oat milk, not soy", seq: 1 }),
      ],
      task_cursor: 1,
    }));

    await sync({ ...stores, transport, deviceId: DEVICE_ID });

    expect((await stores.taskStore.get("task-with-description"))?.description).toBe(
      "oat milk, not soy",
    );
  });

  // The Today-shaped sibling of the test above — `dayOrder` (issue #182)
  // was the mapping's `existing`-fallback mechanism's example right up
  // until this same ticket put it on the wire too, so this is now the
  // identical ordinary case `description`'s own test just proved, over a
  // second field, mirroring it deliberately: a Today drag reaches another
  // Device the same round trip a rename already does, and a `dayOrder`
  // that differs from `orderKey` must survive the trip rather than being
  // collapsed to it.
  it("carries a Task's dayOrder through an ordinary sync round trip, independent of orderKey", async () => {
    const stores = newStores();

    const transport = vi.fn(async () => ({
      ...emptyResponse,
      tasks: [
        wireTaskOutput({
          id: "task-with-day-order",
          order_key: "project-position",
          day_order: "today-position",
          seq: 1,
        }),
      ],
      task_cursor: 1,
    }));

    await sync({ ...stores, transport, deviceId: DEVICE_ID });

    const pulled = await stores.taskStore.get("task-with-day-order");
    expect(pulled?.orderKey).toBe("project-position");
    expect(pulled?.dayOrder).toBe("today-position");
  });

  // The regression `fromWireTaskOutput`'s `existing`-fallback mechanism
  // (mapping.ts's own doc comment) exists to guard against, proven from
  // the opposite direction now that every field on `Task` is wire-covered:
  // an incoming Task's own fields must always come from `output`, never
  // from this Device's `existing` copy, for any field the wire actually
  // carries. `existing` is given a Task whose every field disagrees with
  // `output`'s — if a future edit ever widened the fallback beyond the one
  // field that genuinely needs it (mapping.ts's own doc comment warns
  // against exactly this), this is the test that would catch it, by
  // finding `existing`'s stale values leaking into the result instead of
  // `output`'s current ones.
  it("an incoming Task takes every wire-covered field from the wire, never from this Device's existing copy", async () => {
    const stores = newStores();
    await stores.taskStore.upsert([
      task({
        id: "shared-task",
        content: "stale content",
        orderKey: "stale-order-key",
        dayOrder: "stale-day-order",
        seq: 1,
      }),
    ]);

    const transport = vi.fn(async () => ({
      ...emptyResponse,
      tasks: [
        wireTaskOutput({
          id: "shared-task",
          content: "fresh content",
          order_key: "fresh-order-key",
          day_order: "fresh-day-order",
          seq: 2,
        }),
      ],
      task_cursor: 2,
    }));

    await sync({ ...stores, transport, deviceId: DEVICE_ID });

    const updated = await stores.taskStore.get("shared-task");
    expect(updated?.content).toBe("fresh content");
    expect(updated?.orderKey).toBe("fresh-order-key");
    expect(updated?.dayOrder).toBe("fresh-day-order");
  });

  // A Task this Device has never held any copy of has nothing in
  // `existing` to fall back to regardless — every field, `dayOrder`
  // included, comes straight off `output`.
  it("a Task synced for the first time takes its dayOrder straight off the wire", async () => {
    const stores = newStores();

    const transport = vi.fn(async () => ({
      ...emptyResponse,
      tasks: [
        wireTaskOutput({
          id: "brand-new-task",
          order_key: "fresh-order-key",
          day_order: "fresh-day-order",
          seq: 1,
        }),
      ],
      task_cursor: 1,
    }));

    await sync({ ...stores, transport, deviceId: DEVICE_ID });

    const pulled = await stores.taskStore.get("brand-new-task");
    expect(pulled?.orderKey).toBe("fresh-order-key");
    expect(pulled?.dayOrder).toBe("fresh-day-order");
  });
});
