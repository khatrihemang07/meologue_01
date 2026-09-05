import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, ROW_SHAPE_EPOCH, SYNC_BATCH_SIZE } from "./protocol";
import { sync } from "./sync-engine";
import { entry } from "./test-support/entry-fixture";
import { event } from "./test-support/event-fixture";
import { InMemoryCommentStore } from "./test-support/in-memory-comment-store";
import { InMemoryEntryStore } from "./test-support/in-memory-entry-store";
import { InMemoryEventStore } from "./test-support/in-memory-event-store";
import { InMemoryLabelStore } from "./test-support/in-memory-label-store";
import { InMemoryProjectStore } from "./test-support/in-memory-project-store";
import { InMemoryTaskStore } from "./test-support/in-memory-task-store";
import { task } from "./test-support/task-fixture";
import type {
  WireEntryOutput,
  WireEventOutput,
  WireSyncRequest,
  WireSyncResponse,
  WireTaskOutput,
} from "./wire";

const DEVICE_ID = "device-1";

function wireEntryOutput(overrides: Partial<WireEntryOutput> = {}): WireEntryOutput {
  return {
    id: "entry-1",
    device_id: DEVICE_ID,
    body: "hello meologue",
    created_at: "2026-01-01T00:00:00.000Z",
    // Issue #196 — a freshly-created row's own updated_at starts equal
    // to created_at.
    updated_at: "2026-01-01T00:00:00.000Z",
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
    // Issue #196 — see wireEntryOutput's own identical comment above.
    updated_at: "2026-01-01T00:00:00.000Z",
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

// Issue #184: the Event-shaped sibling of wireTaskOutput above.
function wireEventOutput(overrides: Partial<WireEventOutput> = {}): WireEventOutput {
  return {
    id: "event-1",
    device_id: DEVICE_ID,
    event_type: "added",
    object_type: "task",
    object_id: "task-1",
    task_id: "task-1",
    project_id: null,
    occurred_at: "2026-01-01T00:00:00.000Z",
    extra: null,
    seq: 1,
    ...overrides,
  };
}

// Every stream empty on both request-echoing fields it might carry —
// most tests below exercise one stream at a time and don't care what the
// others answer, so this is the baseline every partial `WireSyncResponse`
// literal spreads onto rather than each test having to spell out every
// one of issue #182's four new streams (or issue #184's Event stream) by
// hand.
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
  events: [],
  event_cursor: 0,
  // Issue #194: `acknowledged_*` is always present on the wire (mirroring
  // `entries`/`tasks`/etc. above), and empty here for the identical reason
  // every other array above is — most tests below never push anything the
  // Server would have something to acknowledge.
  acknowledged_entries: [],
  acknowledged_tasks: [],
  acknowledged_projects: [],
  acknowledged_sections: [],
  acknowledged_labels: [],
  acknowledged_comments: [],
  acknowledged_events: [],
};

// A fresh set of the five stores issue #182/#184 added, alongside `store`
// and `taskStore` — every `sync()` call in this file needs all seven now
// (SyncEngineOptions' own doc comment on why each is required, not
// optional), so this is the one place that plumbing lives rather than
// seven stores constructed at every call site.
function newStores() {
  const store = new InMemoryEntryStore();
  const taskStore = new InMemoryTaskStore();
  return {
    store,
    taskStore,
    projectStore: new InMemoryProjectStore(taskStore),
    labelStore: new InMemoryLabelStore(),
    commentStore: new InMemoryCommentStore(),
    eventStore: new InMemoryEventStore(),
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
            updated_at: "2026-01-01T00:00:00.000Z",
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
        since_event_seq: 0,
        events: [],
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
          updated_at: "2026-01-01T00:00:00.000Z",
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
    // Issue #196 / ADR 0057: this Device is already caught up on the
    // current row-shape epoch, mirroring "advances the Task Cursor..."
    // below — otherwise the first sync() call's own one-time catch-up
    // reset (now that entries gained updated_at) would zero this Cursor
    // before either transport below ever runs.
    await stores.store.catchUpRowShapeEpoch(ROW_SHAPE_EPOCH.entries);
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
    // Issue #186 / ADR 0057: this Device is already caught up on the
    // current row-shape epoch, so the assertions below exercise only the
    // "never regresses" guarantee, not the separate one-time catch-up
    // reset those tests cover on their own.
    await stores.taskStore.catchUpRowShapeEpoch(ROW_SHAPE_EPOCH.tasks);
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
  it("advances the Project, Section, Label, Comment and Event Cursors independently and never regresses any of them", async () => {
    const stores = newStores();
    // Issue #196 / ADR 0057: Projects, Sections, Labels and Comments each
    // gained updated_at, bumping their own ROW_SHAPE_EPOCH — catch each up
    // first, mirroring "advances the Task Cursor..." above, so this test
    // exercises only the never-regresses guarantee. Events gained no
    // field (this map's own doc comment), so it needs no catch-up call.
    await stores.projectStore.catchUpProjectRowShapeEpoch(ROW_SHAPE_EPOCH.projects);
    await stores.projectStore.catchUpSectionRowShapeEpoch(ROW_SHAPE_EPOCH.sections);
    await stores.labelStore.catchUpRowShapeEpoch(ROW_SHAPE_EPOCH.labels);
    await stores.commentStore.catchUpRowShapeEpoch(ROW_SHAPE_EPOCH.comments);
    await stores.projectStore.setProjectCursor(10);
    await stores.projectStore.setSectionCursor(20);
    await stores.labelStore.setCursor(30);
    await stores.commentStore.setCursor(40);
    await stores.eventStore.setCursor(50);

    const staleTransport = vi.fn(async () => ({
      ...emptyResponse,
      project_cursor: 1,
      section_cursor: 2,
      label_cursor: 3,
      comment_cursor: 4,
      event_cursor: 5,
    }));
    await sync({ ...stores, transport: staleTransport, deviceId: DEVICE_ID });
    expect(await stores.projectStore.getProjectCursor()).toBe(10);
    expect(await stores.projectStore.getSectionCursor()).toBe(20);
    expect(await stores.labelStore.getCursor()).toBe(30);
    expect(await stores.commentStore.getCursor()).toBe(40);
    expect(await stores.eventStore.getCursor()).toBe(50);

    const advancingTransport = vi.fn(async () => ({
      ...emptyResponse,
      project_cursor: 11,
      section_cursor: 21,
      label_cursor: 31,
      comment_cursor: 41,
      event_cursor: 51,
    }));
    await sync({ ...stores, transport: advancingTransport, deviceId: DEVICE_ID });
    expect(await stores.projectStore.getProjectCursor()).toBe(11);
    expect(await stores.projectStore.getSectionCursor()).toBe(21);
    expect(await stores.labelStore.getCursor()).toBe(31);
    expect(await stores.commentStore.getCursor()).toBe(41);
    expect(await stores.eventStore.getCursor()).toBe(51);
  });

  // The Event-shaped sibling of "pushes pending Tasks..." above — same
  // push/confirm shape, over Sync's seventh stream (issue #184). Unlike
  // every stream above it, a re-`record()`ed Event is never expected —
  // there is no edit or tombstone for a confirmed round trip to reflect
  // — so this only proves push-then-pull-back, not a subsequent local
  // mutation surviving a second sync.
  it("pushes pending Events and confirms them when the server echoes back a sequence", async () => {
    const stores = newStores();
    await stores.eventStore.record(event({ id: "local-event-1", seq: null }));

    const transport = vi.fn(async (request) => {
      expect(request.since_event_seq).toBe(0);
      expect(request.events).toEqual([
        {
          id: "local-event-1",
          device_id: DEVICE_ID,
          event_type: "added",
          object_type: "task",
          object_id: "task-1",
          task_id: "task-1",
          project_id: null,
          occurred_at: "2026-01-01T00:00:00.000Z",
          extra: null,
        },
      ]);
      return {
        ...emptyResponse,
        events: [wireEventOutput({ id: "local-event-1", seq: 1 })],
        event_cursor: 1,
      } satisfies WireSyncResponse;
    });

    await sync({
      ...stores,
      transport,
      deviceId: DEVICE_ID,
      now: () => "2026-01-01T00:05:00.000Z",
    });

    expect(await stores.eventStore.pending()).toEqual([]);
    const [confirmed] = await stores.eventStore.list();
    expect(confirmed).toEqual(
      event({ id: "local-event-1", seq: 1, syncedAt: "2026-01-01T00:05:00.000Z" }),
    );
  });

  // A redelivered response — the server echoing the same, already-
  // confirmed Event a second time (a retried poll, say) — must not
  // duplicate it. Proves this at the sync-engine level, not only the
  // store-level guarantee event-store-contract.ts already covers.
  it("does not duplicate an Event the server echoes twice under the same id", async () => {
    const stores = newStores();
    await stores.eventStore.upsert([event({ id: "e1", seq: 1 })]);

    const transport = vi.fn(async () => ({
      ...emptyResponse,
      events: [wireEventOutput({ id: "e1", seq: 1 })],
      event_cursor: 1,
    }));
    await sync({ ...stores, transport, deviceId: DEVICE_ID });

    const all = await stores.eventStore.list();
    expect(all).toHaveLength(1);
  });

  // Issue #194: the exact bug this ticket fixes, reproduced at the
  // sync-engine level rather than only server-side (server/tests/sync.rs's
  // own `a_no_op_replay_past_the_cursor_is_still_acknowledged`) — a
  // transport whose ordinary `entries` comes back empty (the row's own seq
  // genuinely didn't move) must still clear this Device's `pending()` when
  // `acknowledged_entries` names the pushed row. Before `acknowledged_*`
  // existed, nothing in this response would have told the Device its push
  // was received at all, and `pending()` would return this Entry forever.
  describe("acknowledged rows clear pending() even when the ordinary read comes back empty (issue #194)", () => {
    it("for Entries", async () => {
      const stores = newStores();
      await stores.store.upsert([entry({ id: "local-1", seq: null })]);

      const transport = vi.fn(async () => ({
        ...emptyResponse,
        entries: [],
        acknowledged_entries: [wireEntryOutput({ id: "local-1", seq: 1 })],
      }));

      await sync({
        ...stores,
        transport,
        deviceId: DEVICE_ID,
        now: () => "2026-01-01T00:05:00.000Z",
      });

      expect(await stores.store.pending()).toEqual([]);
      // Acknowledging a no-op must not advance the Cursor either —
      // `response.cursor` (0, from `emptyResponse`) never exceeded this
      // Device's own starting Cursor (also 0), so `setCursor` is never
      // called and the Cursor stays exactly where it started.
      expect(await stores.store.getCursor()).toBe(0);
    });

    it("for Tasks", async () => {
      const stores = newStores();
      await stores.taskStore.upsert([task({ id: "local-task-1", seq: null })]);

      const transport = vi.fn(async () => ({
        ...emptyResponse,
        tasks: [],
        acknowledged_tasks: [wireTaskOutput({ id: "local-task-1", seq: 1 })],
      }));

      await sync({
        ...stores,
        transport,
        deviceId: DEVICE_ID,
        now: () => "2026-01-01T00:05:00.000Z",
      });

      expect(await stores.taskStore.pending()).toEqual([]);
      expect(await stores.taskStore.getCursor()).toBe(0);
    });

    it("for Events", async () => {
      const stores = newStores();
      await stores.eventStore.record(event({ id: "local-event-1", seq: null }));

      const transport = vi.fn(async () => ({
        ...emptyResponse,
        events: [],
        acknowledged_events: [wireEventOutput({ id: "local-event-1", seq: 1 })],
      }));

      await sync({
        ...stores,
        transport,
        deviceId: DEVICE_ID,
        now: () => "2026-01-01T00:05:00.000Z",
      });

      expect(await stores.eventStore.pending()).toEqual([]);
      expect(await stores.eventStore.getCursor()).toBe(0);
    });
  });

  // Issue #194: pushes are now chunked the same way reads have always
  // been paged — a backlog larger than one batch must complete across
  // multiple round trips rather than building one oversized request body.
  it("chunks a push larger than SYNC_BATCH_SIZE across multiple requests, none of which carries more than SYNC_BATCH_SIZE rows in any stream", async () => {
    const stores = newStores();
    const total = SYNC_BATCH_SIZE + 10;
    await stores.store.upsert(
      Array.from({ length: total }, (_, i) => entry({ id: `entry-${i}`, seq: null })),
    );

    const transport = vi.fn(async (request: WireSyncRequest) => {
      // The acceptance bar itself: no single request's `entries` (or any
      // other stream) may exceed SYNC_BATCH_SIZE, even though this
      // Device's own backlog does.
      expect(request.entries.length).toBeLessThanOrEqual(SYNC_BATCH_SIZE);
      expect((request.tasks ?? []).length).toBeLessThanOrEqual(SYNC_BATCH_SIZE);
      // Acknowledge whatever this request actually pushed, mirroring a
      // real server's `acknowledged_entries` — this is what lets
      // `pending()` actually drain between iterations, the same way a
      // real Cursor-read response would.
      return {
        ...emptyResponse,
        acknowledged_entries: request.entries.map((e): WireEntryOutput => ({ ...e, seq: 1 })),
      };
    });

    await sync({ ...stores, transport, deviceId: DEVICE_ID });

    // The backlog didn't fit in one push, so the loop must have run a
    // second time to carry the remainder — `pushWasFull`, not merely
    // `batchWasFull` off a full *response*, since every response here is
    // otherwise empty.
    expect(transport).toHaveBeenCalledTimes(2);
    const pushedCounts = transport.mock.calls.map(([request]) => request.entries.length);
    expect(pushedCounts).toEqual([SYNC_BATCH_SIZE, 10]);
    expect(await stores.store.pending()).toEqual([]);
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
    // Issue #196 / ADR 0057: already caught up, mirroring the Task
    // Cursor's own identical guard below — otherwise the one-time catch-up
    // reset (entries also gained updated_at) would zero this Cursor before
    // the network call even runs, which this test isn't testing for.
    await stores.store.catchUpRowShapeEpoch(ROW_SHAPE_EPOCH.entries);
    await stores.store.setCursor(3);
    await stores.taskStore.upsert([task({ id: "local-task-1", seq: null })]);
    // Issue #186 / ADR 0057: already caught up, so the Task Cursor below
    // is genuinely untouched by anything sync() does before the network
    // call that then fails — not merely reset-and-then-never-reassigned.
    await stores.taskStore.catchUpRowShapeEpoch(ROW_SHAPE_EPOCH.tasks);
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

  // Issue #186 / ADR 0057.
  describe("row-shape catch-up", () => {
    // The exact bug observed while verifying #182, reproduced directly:
    // a Task this Device already pulled and already advanced its Cursor
    // past, whose Server-side row has since gained a `description` this
    // Device has never asked for again, because its Cursor has no memory
    // of what shape the row had when it last passed by. Before ADR 0057's
    // fix, this Device would poll forever at `since_task_seq: 1` and
    // never see it — exactly the second Device in the ticket's own
    // account, before the unrelated rename that rescued it.
    it("a field added to an existing row's wire shape reaches a Task this Device already holds, without editing it", async () => {
      const stores = newStores();
      await stores.taskStore.upsert([task({ id: "task-1", seq: 1 })]);
      await stores.taskStore.setCursor(1);

      const transport = vi.fn(async (request) => {
        if (request.since_task_seq === 0) {
          // The full re-walk this Device has never done: the Server's own
          // copy of task-1 already carries a description written on
          // another Device.
          return {
            ...emptyResponse,
            tasks: [wireTaskOutput({ id: "task-1", description: "oat milk, not soy", seq: 1 })],
            task_cursor: 1,
          };
        }
        // An ordinary poll past seq 1 sees nothing new — task-1's own seq
        // never moved, so it never resurfaces on its own (the bug, absent
        // the fix below).
        return { ...emptyResponse, task_cursor: request.since_task_seq };
      });

      await sync({ ...stores, transport, deviceId: DEVICE_ID });

      expect((await stores.taskStore.get("task-1"))?.description).toBe("oat milk, not soy");
    });

    // Criterion 2: on an ordinary sync, once this Device has already
    // caught up to the current row-shape epoch, nothing resets — the
    // request carries this Device's real, advanced Cursor, not 0.
    it("does not reset an already-caught-up stream's Cursor, and sends its real Cursor, on an ordinary sync", async () => {
      const stores = newStores();
      await stores.taskStore.catchUpRowShapeEpoch(ROW_SHAPE_EPOCH.tasks);
      await stores.taskStore.setCursor(42);

      const transport = vi.fn(async (request) => {
        expect(request.since_task_seq).toBe(42);
        return { ...emptyResponse, task_cursor: 42 };
      });

      await sync({ ...stores, transport, deviceId: DEVICE_ID });

      expect(transport).toHaveBeenCalledTimes(1);
      expect(await stores.taskStore.getCursor()).toBe(42);
    });

    // Criterion 3: a Device that has never synced this stream (Cursor
    // already 0, no epoch ever recorded) is unaffected by the catch-up —
    // no reset to observe, and indistinguishable afterward from a Device
    // that has always been on the current epoch.
    it("leaves a never-synced Device's Task Cursor at 0, indistinguishable from one that's always been caught up", async () => {
      const stores = newStores();

      const firstSync = vi.fn(async (request) => {
        expect(request.since_task_seq).toBe(0);
        return { ...emptyResponse, task_cursor: 0 };
      });
      await sync({ ...stores, transport: firstSync, deviceId: DEVICE_ID });
      expect(await stores.taskStore.getCursor()).toBe(0);

      // A later, ordinary sync sends whatever this Device's own Cursor
      // has since become — no further reset, exactly as if this Device
      // had recorded the current epoch from the start.
      await stores.taskStore.setCursor(5);
      const secondSync = vi.fn(async (request) => {
        expect(request.since_task_seq).toBe(5);
        return { ...emptyResponse, task_cursor: 5 };
      });
      await sync({ ...stores, transport: secondSync, deviceId: DEVICE_ID });
    });

    // Criterion 4: re-walking a stream during catch-up must not
    // resurrect a tombstone — `fetch_entries_since`'s own doc comment
    // (server/src/sync.rs) is explicit that a poll carries tombstones
    // through unfiltered, so a full re-walk necessarily re-delivers every
    // tombstone this Device already applied, and the upsert path must
    // treat that exactly like any other re-delivery: a no-op, not a
    // revival.
    it("re-pulling a Task during row-shape catch-up carries a tombstone through without resurrecting it", async () => {
      const stores = newStores();
      await stores.taskStore.upsert([
        task({ id: "task-1", seq: 1, deletedAt: "2026-01-02T00:00:00.000Z", content: "" }),
      ]);
      await stores.taskStore.setCursor(1);

      const transport = vi.fn(async (request) => {
        if (request.since_task_seq === 0) {
          return {
            ...emptyResponse,
            tasks: [
              wireTaskOutput({
                id: "task-1",
                content: "",
                deleted_at: "2026-01-02T00:00:00.000Z",
                seq: 1,
              }),
            ],
            task_cursor: 1,
          };
        }
        return { ...emptyResponse, task_cursor: request.since_task_seq };
      });

      await sync({ ...stores, transport, deviceId: DEVICE_ID });

      expect(transport).toHaveBeenCalledWith(expect.objectContaining({ since_task_seq: 0 }));
      expect(await stores.taskStore.get("task-1")).toBeUndefined();
      expect(await stores.taskStore.pending()).toEqual([]);
    });

    // Criterion 4, restated: calling the catch-up itself twice at the
    // same epoch — sync() does this on every call — must not repeat the
    // reset once this Device has already caught up and moved its Cursor
    // on. Store-level pinning of this lives in each contract suite
    // (e.g. task-store-contract.ts); this proves it holds through two
    // real sync() calls in a row, the shape production code actually
    // takes (a long-lived Device calls sync() repeatedly forever).
    it("running sync() twice after catch-up does not reset the Cursor a second time", async () => {
      const stores = newStores();
      await stores.taskStore.upsert([task({ id: "task-1", seq: 1 })]);
      await stores.taskStore.setCursor(1);

      const catchUpTransport = vi.fn(async () => ({
        ...emptyResponse,
        tasks: [wireTaskOutput({ id: "task-1", description: "first pass", seq: 1 })],
        task_cursor: 1,
      }));
      await sync({ ...stores, transport: catchUpTransport, deviceId: DEVICE_ID });
      expect(await stores.taskStore.getCursor()).toBe(1);

      await stores.taskStore.setCursor(99);
      const secondTransport = vi.fn(async (request) => {
        expect(request.since_task_seq).toBe(99);
        return { ...emptyResponse, task_cursor: 99 };
      });
      await sync({ ...stores, transport: secondTransport, deviceId: DEVICE_ID });
      expect(await stores.taskStore.getCursor()).toBe(99);
    });
  });
});
