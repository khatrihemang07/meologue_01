import { beforeEach, describe, expect, it } from "vitest";
import type { CommentStore } from "../comment-store";
import { comment } from "./comment-fixture";

/**
 * The behaviour every CommentStore implementation (issue #180) must
 * satisfy — the Comment-shaped sibling of labelStoreContract
 * (./label-store-contract.ts), mirrored section for section so a reader
 * who knows one recognises the other. Call this from inside a `describe`
 * block, passing a factory for the implementation under test.
 */
export function commentStoreContract(
  createStore: () => CommentStore | Promise<CommentStore>,
): void {
  let store: CommentStore;

  beforeEach(async () => {
    store = await createStore();
  });

  it("returns a locally created Comment immediately, before any sync", async () => {
    const local = comment({ id: "local-1", seq: null });

    await store.upsert([local]);

    expect(await store.list()).toEqual([local]);
  });

  it("deduplicates Comments arriving twice by id, rather than appending twice", async () => {
    const first = comment({ id: "dup-1", text: "first version" });
    const second = comment({ id: "dup-1", text: "second version", seq: 1 });

    await store.upsert([first]);
    await store.upsert([second]);

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(second);
  });

  it("orders Comments oldest first, breaking ties by id", async () => {
    const later = comment({ id: "b", createdAt: "2026-01-02T00:00:00.000Z" });
    const earlier = comment({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" });
    const tieB = comment({ id: "tie-b", createdAt: "2026-01-03T00:00:00.000Z" });
    const tieA = comment({ id: "tie-a", createdAt: "2026-01-03T00:00:00.000Z" });

    await store.upsert([later, earlier, tieB, tieA]);

    expect((await store.list()).map((c) => c.id)).toEqual(["a", "b", "tie-a", "tie-b"]);
  });

  describe("listByTask()", () => {
    it("returns only the Comments belonging to that Task, in the same oldest-first order as list()", async () => {
      const onA1 = comment({ id: "a1", taskId: "task-a", createdAt: "2026-01-02T00:00:00.000Z" });
      const onA2 = comment({ id: "a2", taskId: "task-a", createdAt: "2026-01-01T00:00:00.000Z" });
      const onB = comment({ id: "b1", taskId: "task-b" });

      await store.upsert([onA1, onA2, onB]);

      expect((await store.listByTask("task-a")).map((c) => c.id)).toEqual(["a2", "a1"]);
    });

    it("returns an empty array for a Task with no Comments", async () => {
      expect(await store.listByTask("no-such-task")).toEqual([]);
    });
  });

  describe("edit()", () => {
    it("changes text and clears seq", async () => {
      const synced = comment({ id: "a", text: "original", seq: 5 });
      await store.upsert([synced]);

      await store.edit("a", "changed");

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", text: "changed", seq: null });
    });

    it("refuses an empty or whitespace-only text", async () => {
      await store.upsert([comment({ id: "a", seq: 1 })]);

      await expect(store.edit("a", "")).rejects.toThrow();
      await expect(store.edit("a", "   ")).rejects.toThrow();
    });

    // Issue #196: every setter that clears seq/syncedAt also stamps
    // updatedAt with a fresh value.
    it("stamps updatedAt with a fresh value", async () => {
      const original = comment({ id: "a", text: "original", seq: 5 });
      await store.upsert([original]);

      await store.edit("a", "changed");

      const [found] = await store.list();
      expect((found?.updatedAt as string) > original.updatedAt).toBe(true);
    });
  });

  describe("remove() — tombstone, not hard delete", () => {
    it("removes a Comment from list()/listByTask()/get()", async () => {
      await store.upsert([comment({ id: "a", taskId: "task-a", text: "sounds good", seq: 1 })]);

      await store.remove("a");

      expect(await store.list()).toEqual([]);
      expect(await store.listByTask("task-a")).toEqual([]);
      expect(await store.get("a")).toBeUndefined();
    });

    // Mirrors labelStoreContract's identical, most-important case: `seq
    // IS NULL` means "no acknowledgement from the server yet," which
    // also covers "pushed, but the response was lost" — a store that
    // hard-deletes here instead of leaving a tombstone would let the
    // next sync bring the Comment back permanently.
    it("removing a Comment whose seq is already null still leaves a tombstone pending(), not nothing", async () => {
      await store.upsert([comment({ id: "a", text: "not yet synced", seq: null })]);

      await store.remove("a");

      const pending = await store.pending();
      expect(pending.map((c) => c.id)).toEqual(["a"]);
      expect(pending[0]?.deletedAt).not.toBeNull();
    });

    it("removing a Comment blanks its text", async () => {
      await store.upsert([comment({ id: "a", text: "something", seq: 1 })]);

      await store.remove("a");

      const [tombstone] = await store.pending();
      expect(tombstone).toMatchObject({ id: "a", text: "" });
    });

    it("edit() is a no-op against a tombstone", async () => {
      await store.upsert([comment({ id: "a", text: "something", seq: 1 })]);
      await store.remove("a");

      await store.edit("a", "trying to bring it back");

      expect(await store.list()).toEqual([]);
      const [tombstone] = await store.pending();
      expect(tombstone).toMatchObject({ id: "a", text: "" });
      expect(tombstone?.deletedAt).not.toBeNull();
    });

    it("upserting a tombstone arriving from sync removes the Comment from list()", async () => {
      await store.upsert([comment({ id: "a", text: "sounds good", seq: 1 })]);
      expect((await store.list()).map((c) => c.id)).toEqual(["a"]);

      const tombstone = comment({
        id: "a",
        text: "",
        seq: 2,
        deletedAt: "2026-01-03T00:00:00.000Z",
      });
      await store.upsert([tombstone]);

      expect(await store.list()).toEqual([]);
    });
  });

  describe("get()", () => {
    it("returns a live Comment by id", async () => {
      await store.upsert([comment({ id: "a" })]);

      expect(await store.get("a")).toEqual(comment({ id: "a" }));
    });

    it("returns undefined for an unknown id", async () => {
      expect(await store.get("never-seen")).toBeUndefined();
    });
  });

  it("returns only Comments with a null sequence from pending() — exactly seq IS NULL", async () => {
    const unsynced = comment({ id: "unsynced", seq: null });
    const synced = comment({ id: "synced", seq: 42 });

    await store.upsert([unsynced, synced]);

    expect((await store.pending()).map((c) => c.id)).toEqual(["unsynced"]);
  });

  // Issue #218: Sync's pull write path — everything above exercises
  // upsert(), which stays deliberately wholesale; these are the cases
  // that separate applyPulled() from it. See CommentStore.applyPulled's
  // own doc comment (../comment-store.ts) and EntryStore.applyPulled's
  // (../store.ts, mirrored section for section by entry-store-
  // contract.ts's own "applyPulled() (issue #215)" block) for the rule
  // and every reason behind it.
  describe("applyPulled() (issue #218)", () => {
    it("applies an incoming row over a local row with nothing pending", async () => {
      await store.upsert([comment({ id: "a", text: "as this Device last saw it", seq: 1 })]);

      await store.applyPulled([
        comment({
          id: "a",
          text: "edited on another Device",
          updatedAt: "2026-01-02T00:00:00.000Z",
          seq: 2,
        }),
      ]);

      expect(await store.get("a")).toMatchObject({
        id: "a",
        text: "edited on another Device",
        seq: 2,
      });
    });

    it("inserts a Comment this Device has never seen", async () => {
      await store.applyPulled([comment({ id: "fresh", text: "from another Device", seq: 7 })]);

      expect(await store.get("fresh")).toMatchObject({ id: "fresh" });
    });

    it("does not overwrite a local edit that has not been pushed yet", async () => {
      await store.upsert([comment({ id: "a", text: "before the local edit", seq: 1 })]);
      await store.edit("a", "the local edit nobody has pushed");

      await store.applyPulled([comment({ id: "a", text: "before the local edit", seq: 1 })]);

      expect(await store.get("a")).toMatchObject({ text: "the local edit nobody has pushed" });
    });

    it("leaves the surviving local edit pending, so the next Sync still pushes it", async () => {
      await store.upsert([comment({ id: "a", text: "before", seq: 1 })]);
      await store.edit("a", "the local edit nobody has pushed");

      await store.applyPulled([comment({ id: "a", text: "before", seq: 1 })]);

      const pending = await store.pending();
      expect(pending.map((c) => c.id)).toEqual(["a"]);
      expect(pending[0]).toMatchObject({ text: "the local edit nobody has pushed", seq: null });
    });

    it("applies an incoming row that is newer than the pending local edit", async () => {
      await store.upsert([comment({ id: "a", text: "before", seq: 1 })]);
      await store.edit("a", "the local edit");

      await store.applyPulled([
        comment({
          id: "a",
          text: "a later edit from another Device",
          updatedAt: "2099-01-01T00:00:00.000Z",
          seq: 9,
        }),
      ]);

      expect(await store.get("a")).toMatchObject({
        text: "a later edit from another Device",
        seq: 9,
      });
    });

    it("applies an incoming row whose updatedAt ties the pending local row", async () => {
      await store.upsert([comment({ id: "a", text: "before", seq: 1 })]);
      await store.edit("a", "the local edit");
      const local = await store.get("a");

      await store.applyPulled([
        comment({ id: "a", text: "the local edit", updatedAt: local?.updatedAt as string, seq: 9 }),
      ]);

      expect(await store.pending()).toEqual([]);
      expect(await store.get("a")).toMatchObject({ id: "a", seq: 9 });
    });

    it("applies an incoming tombstone even over a newer pending local edit", async () => {
      await store.upsert([comment({ id: "a", text: "a live Comment", seq: 1 })]);
      await store.edit("a", "the local edit nobody has pushed");

      await store.applyPulled([
        comment({
          id: "a",
          text: "",
          updatedAt: "2026-01-02T00:00:00.000Z",
          seq: 9,
          deletedAt: "2026-01-02T00:00:00.000Z",
        }),
      ]);

      expect(await store.get("a")).toBeUndefined();
    });

    it("refuses only the rows it must, applying the rest of the batch", async () => {
      await store.upsert([
        comment({ id: "a", text: "before", seq: 1 }),
        comment({ id: "b", text: "b before", seq: 2 }),
      ]);
      await store.edit("a", "the local edit nobody has pushed");

      await store.applyPulled([
        comment({ id: "a", text: "before", seq: 1 }),
        comment({
          id: "b",
          text: "b, edited elsewhere",
          updatedAt: "2026-01-02T00:00:00.000Z",
          seq: 3,
        }),
      ]);

      const a = await store.get("a");
      const b = await store.get("b");
      expect(a).toMatchObject({ text: "the local edit nobody has pushed", seq: null });
      expect(b).toMatchObject({ text: "b, edited elsewhere", seq: 3 });
    });

    it("is a no-op on an empty batch", async () => {
      await store.upsert([comment({ id: "a", seq: 1 })]);

      await store.applyPulled([]);

      expect(await store.get("a")).toMatchObject({ id: "a" });
    });
  });

  it("starts the cursor at 0 and reflects whatever it's set to", async () => {
    expect(await store.getCursor()).toBe(0);

    await store.setCursor(7);

    expect(await store.getCursor()).toBe(7);
  });

  // Issue #186 / ADR 0057 — see EntryStore.catchUpRowShapeEpoch's own doc
  // comment (../store.ts) for the mechanism these pin.
  describe("catchUpRowShapeEpoch", () => {
    it("does nothing for a Device that has never synced this stream", async () => {
      expect(await store.getCursor()).toBe(0);

      await store.catchUpRowShapeEpoch(1);

      expect(await store.getCursor()).toBe(0);
    });

    it("resets an already-advanced Cursor to 0 the first time it sees a higher epoch", async () => {
      await store.setCursor(50);

      await store.catchUpRowShapeEpoch(1);

      expect(await store.getCursor()).toBe(0);
    });

    it("is idempotent: catching up to the same epoch again does not reset a Cursor that has since advanced", async () => {
      await store.catchUpRowShapeEpoch(1);
      await store.setCursor(50);

      await store.catchUpRowShapeEpoch(1);

      expect(await store.getCursor()).toBe(50);
    });

    it("does not reset when asked to catch up to an epoch no higher than one already recorded", async () => {
      await store.catchUpRowShapeEpoch(2);
      await store.setCursor(50);

      await store.catchUpRowShapeEpoch(1);

      expect(await store.getCursor()).toBe(50);
    });
  });

  describe("search() (issue #183)", () => {
    it("matches a fragment from the middle of a word, not just a prefix", async () => {
      await store.upsert([comment({ id: "a", text: "let's schedule a follow-up" })]);

      expect((await store.search("hedul")).map((c) => c.id)).toEqual(["a"]);
    });

    it("ignores case and folds accents", async () => {
      await store.upsert([comment({ id: "a", text: "grab a café later" })]);

      expect((await store.search("CAFE")).map((c) => c.id)).toEqual(["a"]);
    });

    it("requires every word, in any order, but never spans two Comments", async () => {
      await store.upsert([
        comment({ id: "a", text: "BetaqqZ AlphaqqZ" }),
        comment({ id: "b", text: "AlphaqqZ only" }),
      ]);

      expect((await store.search("AlphaqqZ BetaqqZ")).map((c) => c.id)).toEqual(["a"]);
    });

    it("matches punctuation literally rather than stripping it", async () => {
      await store.upsert([comment({ id: "a", text: "Test-Punct! done" })]);

      expect(await store.search("TestPunct")).toEqual([]);
      expect((await store.search("punct done")).map((c) => c.id)).toEqual(["a"]);
    });

    it("treats a quote as a literal character, never a phrase operator", async () => {
      await store.upsert([comment({ id: "a", text: "a b" })]);

      expect(await store.search('"a b"')).toEqual([]);
    });

    it("excludes a tombstoned Comment", async () => {
      await store.upsert([comment({ id: "a", text: "sounds good", seq: 1 })]);

      await store.remove("a");

      expect(await store.search("sounds")).toEqual([]);
    });

    it("treats an empty or whitespace-only query as matching nothing", async () => {
      await store.upsert([comment({ id: "a", text: "anything at all" })]);

      expect(await store.search("")).toEqual([]);
      expect(await store.search("   ")).toEqual([]);
    });

    it("orders results oldest-first, the same order list() returns", async () => {
      await store.upsert([
        comment({ id: "b", text: "match me", createdAt: "2026-01-02T00:00:00.000Z" }),
        comment({ id: "a", text: "match me too", createdAt: "2026-01-01T00:00:00.000Z" }),
      ]);

      expect((await store.search("match")).map((c) => c.id)).toEqual(["a", "b"]);
    });
  });

  // Issue #332: Sync's acknowledgement write path, the Comment-shaped
  // sibling of taskStoreContract's own "applyAcknowledged() (issue #244)"
  // block and mirrored case for case against it. The defect it closes is
  // the same one #244 found for Tasks and #216 found for Entries: a local
  // write landing between the push going out and the response coming back
  // — here an edit, fixing a typo seconds after posting being the most
  // ordinary version of it — reverted by the acknowledgement AND stamped
  // with a `seq`, so `pending()` stops seeing it and nothing ever
  // re-pushes it. It cannot reuse applyPulled's rule: ADR 0065 tolerates
  // the Server holding an OLDER `updated_at`, so an ordering guard would
  // refuse the acknowledgement forever and the row would re-push every
  // tick. See CommentStore.applyAcknowledged's own doc comment
  // (../comment-store.ts).
  describe("applyAcknowledged() (issue #332)", () => {
    it("confirms a Comment that has not changed since it was pushed, clearing pending", async () => {
      const pushed = comment({ id: "a", text: "sounds good", seq: null });
      await store.upsert([pushed]);

      await store.applyAcknowledged([
        {
          asPushed: pushed,
          confirmed: comment({
            id: "a",
            text: "sounds good",
            seq: 7,
            syncedAt: "2026-01-02T00:00:00.000Z",
          }),
        },
      ]);

      expect(await store.pending()).toEqual([]);
      expect(await store.get("a")).toMatchObject({ id: "a", seq: 7 });
    });

    // ADR 0065's tolerated divergence, exactly as the Task contract pins
    // it: an edit landing on identical content leaves the Server with an
    // OLDER updatedAt than this Device. The acknowledgement must still
    // land, or the Comment never clears pending and re-pushes forever.
    it("confirms an unchanged Comment even when the Server's updatedAt is older than this Device's", async () => {
      const pushed = comment({
        id: "a",
        text: "same text",
        updatedAt: "2026-02-01T00:00:00.000Z",
        seq: null,
      });
      await store.upsert([pushed]);

      await store.applyAcknowledged([
        {
          asPushed: pushed,
          confirmed: comment({
            id: "a",
            text: "same text",
            updatedAt: "2026-01-01T00:00:00.000Z",
            seq: 7,
            syncedAt: "2026-01-02T00:00:00.000Z",
          }),
        },
      ]);

      expect(await store.pending()).toEqual([]);
    });

    // **The defect issue #332 reported, at store level.** The Comment was
    // edited while the request carrying its creation was still in flight,
    // so the acknowledgement coming back is for the pre-edit text.
    it("does not undo an edit made after the push went out", async () => {
      const pushed = comment({ id: "a", text: "sounds godo", seq: null });
      await store.upsert([pushed]);
      await store.edit("a", "sounds good");

      await store.applyAcknowledged([
        {
          asPushed: pushed,
          confirmed: comment({
            id: "a",
            text: "sounds godo",
            seq: 7,
            syncedAt: "2026-01-02T00:00:00.000Z",
          }),
        },
      ]);

      expect(await store.get("a")).toMatchObject({ text: "sounds good" });
    });

    // The half that is the actual lost write. Surviving in the store is
    // not what issue #332 is about; it's about `pending()` being exactly
    // `seq IS NULL` and the acknowledgement having stamped a real `seq`
    // over it, so nothing re-pushes the edit ever again.
    it("leaves that edit pending, so the next Sync pushes it", async () => {
      const pushed = comment({ id: "a", text: "sounds godo", seq: null });
      await store.upsert([pushed]);
      await store.edit("a", "sounds good");

      await store.applyAcknowledged([
        {
          asPushed: pushed,
          confirmed: comment({
            id: "a",
            text: "sounds godo",
            seq: 7,
            syncedAt: "2026-01-02T00:00:00.000Z",
          }),
        },
      ]);

      const pending = await store.pending();
      expect(pending.map((c) => c.id)).toEqual(["a"]);
      expect(pending[0]).toMatchObject({ seq: null, text: "sounds good" });
    });

    // ADR 0059: full rows are acknowledged precisely so a write the Server
    // REFUSED (because the row is tombstoned there) teaches this Device
    // the tombstone. That has to keep working for Comments too — remove()
    // is the local mutation that produces a tombstone, the Comment-shaped
    // version of Task's rename().
    it("carries back a tombstone the Server refused the write against", async () => {
      const pushed = comment({ id: "a", text: "an edit the Server will refuse", seq: null });
      await store.upsert([pushed]);

      await store.applyAcknowledged([
        {
          asPushed: pushed,
          confirmed: comment({
            id: "a",
            text: "",
            seq: 9,
            syncedAt: "2026-01-02T00:00:00.000Z",
            deletedAt: "2026-01-02T00:00:00.000Z",
          }),
        },
      ]);

      expect(await store.list()).toEqual([]);
      expect(await store.get("a")).toBeUndefined();
    });

    // Search is maintained from whatever survived, never from the
    // confirmation — the one place a refused acknowledgement could
    // otherwise still appear to have landed. Unlike Tasks there is no
    // separate FTS5 index to re-derive here (search()'s own doc comment:
    // a live scan over list()), but the guarantee has to hold all the
    // same — this pins it via search() exactly as the Task contract does.
    it("indexes the text that survived, not the confirmation it refused", async () => {
      const pushed = comment({ id: "a", text: "a recurring chore", seq: null });
      await store.upsert([pushed]);
      await store.edit("a", "a finished errand");

      await store.applyAcknowledged([
        {
          asPushed: pushed,
          confirmed: comment({ id: "a", text: "a recurring chore", seq: 7 }),
        },
      ]);

      expect((await store.search("errand")).map((c) => c.id)).toEqual(["a"]);
      expect(await store.search("recurring")).toEqual([]);
    });

    it("is a no-op on an empty batch", async () => {
      await store.upsert([comment({ id: "a", seq: 1 })]);
      await store.applyAcknowledged([]);
      expect((await store.list()).map((c) => c.id)).toEqual(["a"]);
    });
  });
}
