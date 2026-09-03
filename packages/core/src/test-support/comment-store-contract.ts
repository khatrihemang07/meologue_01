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

  it("starts the cursor at 0 and reflects whatever it's set to", async () => {
    expect(await store.getCursor()).toBe(0);

    await store.setCursor(7);

    expect(await store.getCursor()).toBe(7);
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
}
