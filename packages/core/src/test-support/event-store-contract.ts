import { beforeEach, describe, expect, it } from "vitest";
import type { EventStore } from "../event-store";
import { event } from "./event-fixture";

/**
 * The behaviour every EventStore implementation (issue #184) must
 * satisfy — the Event-shaped sibling of commentStoreContract
 * (./comment-store-contract.ts), mirrored section for section so a
 * reader who knows one recognises the other. What's *not* here, on
 * purpose: no edit()/remove() section (an Event has neither — see
 * ../event-store.ts's own header comment), and no tombstone section for
 * the identical reason.
 */
export function eventStoreContract(createStore: () => EventStore | Promise<EventStore>): void {
  let store: EventStore;

  beforeEach(async () => {
    store = await createStore();
  });

  it("returns a locally recorded Event immediately, before any sync", async () => {
    const local = event({ id: "local-1", seq: null });

    await store.record(local);

    expect(await store.list()).toEqual([local]);
  });

  it("record() is a no-op against an id already held — an Event is never rewritten", async () => {
    const first = event({ id: "dup-1", eventType: "added" });
    const second = event({ id: "dup-1", eventType: "deleted", seq: 1 });

    await store.record(first);
    await store.record(second);

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(first);
  });

  it("upsert() confirms a locally recorded Event's own pending push, filling in the seq the server assigned", async () => {
    const pending = event({ id: "local-1", seq: null, syncedAt: null });
    await store.record(pending);
    expect(await store.pending()).toEqual([pending]);

    // The server's own echo of this exact push — same id, same content,
    // now carrying a real seq. See ../event-store.ts's own `upsert()`
    // doc comment for why this must overwrite rather than no-op: a
    // record()-then-upsert() sequence under the same id is Sync
    // confirming this Device's own write, not a second, independent
    // Event arriving.
    const confirmed = { ...pending, seq: 7, syncedAt: "2026-01-01T00:05:00.000Z" };
    await store.upsert([confirmed]);

    expect(await store.pending()).toEqual([]);
    expect(await store.list()).toEqual([confirmed]);
  });

  it("upserting the same confirmed Event twice (a redelivered response) does not duplicate it", async () => {
    const confirmed = event({ id: "a", seq: 1, syncedAt: "2026-01-01T00:05:00.000Z" });

    await store.upsert([confirmed]);
    await store.upsert([confirmed]);

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(confirmed);
  });

  it("orders Events newest first, breaking ties by id descending", async () => {
    const earlier = event({ id: "a", occurredAt: "2026-01-01T00:00:00.000Z" });
    const later = event({ id: "b", occurredAt: "2026-01-02T00:00:00.000Z" });
    const tieA = event({ id: "tie-a", occurredAt: "2026-01-03T00:00:00.000Z" });
    const tieB = event({ id: "tie-b", occurredAt: "2026-01-03T00:00:00.000Z" });

    await store.upsert([earlier, later, tieA, tieB]);

    expect((await store.list()).map((e) => e.id)).toEqual(["tie-b", "tie-a", "b", "a"]);
  });

  describe("listByTask()", () => {
    it("returns only the Events concerning that Task, newest first", async () => {
      const onA1 = event({ id: "a1", taskId: "task-a", occurredAt: "2026-01-01T00:00:00.000Z" });
      const onA2 = event({ id: "a2", taskId: "task-a", occurredAt: "2026-01-02T00:00:00.000Z" });
      const onB = event({ id: "b1", taskId: "task-b" });

      await store.upsert([onA1, onA2, onB]);

      expect((await store.listByTask("task-a")).map((e) => e.id)).toEqual(["a2", "a1"]);
    });

    it("returns an empty array for a Task with no Events", async () => {
      expect(await store.listByTask("no-such-task")).toEqual([]);
    });

    it("includes a Comment Event whose taskId names the parent Task", async () => {
      const commentEvent = event({
        id: "c1",
        eventType: "added",
        objectType: "comment",
        objectId: "comment-1",
        taskId: "task-a",
      });

      await store.upsert([commentEvent]);

      expect((await store.listByTask("task-a")).map((e) => e.id)).toEqual(["c1"]);
    });
  });

  describe("listByProject()", () => {
    it("returns only the Events snapshotted to that Project, newest first", async () => {
      const onA1 = event({
        id: "a1",
        projectId: "project-a",
        occurredAt: "2026-01-01T00:00:00.000Z",
      });
      const onA2 = event({
        id: "a2",
        projectId: "project-a",
        occurredAt: "2026-01-02T00:00:00.000Z",
      });
      const onB = event({ id: "b1", projectId: "project-b" });

      await store.upsert([onA1, onA2, onB]);

      expect((await store.listByProject("project-a")).map((e) => e.id)).toEqual(["a2", "a1"]);
    });

    it("null reads Inbox's own history", async () => {
      const inInbox = event({ id: "inbox-1", projectId: null });
      const inProject = event({ id: "project-1", projectId: "project-a" });

      await store.upsert([inInbox, inProject]);

      expect((await store.listByProject(null)).map((e) => e.id)).toEqual(["inbox-1"]);
    });
  });

  it("returns only Events with a null sequence from pending() — exactly seq IS NULL", async () => {
    const unsynced = event({ id: "unsynced", seq: null });
    const synced = event({ id: "synced", seq: 42 });

    await store.upsert([unsynced, synced]);

    expect((await store.pending()).map((e) => e.id)).toEqual(["unsynced"]);
  });

  it("starts the cursor at 0 and reflects whatever it's set to", async () => {
    expect(await store.getCursor()).toBe(0);

    await store.setCursor(7);

    expect(await store.getCursor()).toBe(7);
  });

  it("carries extra data through untouched", async () => {
    const withExtra = event({
      id: "a",
      eventType: "updated",
      extra: { content: "new title", lastContent: "old title" },
    });

    await store.upsert([withExtra]);

    expect((await store.list())[0]?.extra).toEqual({
      content: "new title",
      lastContent: "old title",
    });
  });
}
