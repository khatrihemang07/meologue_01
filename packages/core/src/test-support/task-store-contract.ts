import { beforeEach, describe, expect, it } from "vitest";
import { orderKeyBetween } from "../order-key";
import type { TaskStore } from "../task-store";
import { task } from "./task-fixture";

/**
 * The behaviour every TaskStore implementation (ADR 0047) must satisfy —
 * the Task-shaped sibling of entryStoreContract (./entry-store-contract.ts),
 * mirrored section for section so a reader who knows one recognises the
 * other. Call this from inside a `describe` block, passing a factory for
 * the implementation under test.
 */
export function taskStoreContract(createStore: () => TaskStore | Promise<TaskStore>): void {
  let store: TaskStore;

  beforeEach(async () => {
    store = await createStore();
  });

  it("returns a locally created Task immediately, before any sync", async () => {
    const local = task({ id: "local-1", seq: null });

    await store.upsert([local]);

    expect(await store.list()).toEqual([local]);
  });

  it("deduplicates Tasks arriving twice by id, rather than appending twice", async () => {
    const first = task({ id: "dup-1", content: "first version" });
    const second = task({ id: "dup-1", content: "second version", seq: 1 });

    await store.upsert([first]);
    await store.upsert([second]);

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(second);
  });

  it("orders Tasks by orderKey ascending, breaking ties by id ascending", async () => {
    const b = task({ id: "b", orderKey: "b" });
    const a = task({ id: "a", orderKey: "a" });
    const tieB = task({ id: "tie-b", orderKey: "m" });
    const tieA = task({ id: "tie-a", orderKey: "m" });

    await store.upsert([b, a, tieB, tieA]);

    expect((await store.list()).map((t) => t.id)).toEqual(["a", "b", "tie-a", "tie-b"]);
  });

  it("a completed Task leaves list()", async () => {
    await store.upsert([task({ id: "a", seq: 1 })]);

    await store.complete("a", "2026-01-05T00:00:00.000Z");

    expect(await store.list()).toEqual([]);
  });

  it("listCompleted() returns a completed Task, newest completion first", async () => {
    await store.upsert([task({ id: "a", seq: 1 }), task({ id: "b", seq: 1, orderKey: "z" })]);

    await store.complete("a", "2026-01-01T00:00:00.000Z");
    await store.complete("b", "2026-01-02T00:00:00.000Z");

    expect((await store.listCompleted()).map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("listCompleted() excludes a tombstoned Task", async () => {
    await store.upsert([task({ id: "a", seq: 1 })]);
    await store.complete("a", "2026-01-01T00:00:00.000Z");

    await store.remove("a");

    expect(await store.listCompleted()).toEqual([]);
  });

  describe("complete() / uncomplete()", () => {
    it("complete() sets completedAt and clears seq, making the Task pending again", async () => {
      const synced = task({ id: "a", seq: 5, syncedAt: "2026-01-01T00:00:00.000Z" });
      await store.upsert([synced]);

      await store.complete("a", "2026-01-05T00:00:00.000Z");

      const [found] = await store.listCompleted();
      expect(found).toMatchObject({
        id: "a",
        completedAt: "2026-01-05T00:00:00.000Z",
        seq: null,
      });
      expect((await store.pending()).map((t) => t.id)).toEqual(["a"]);
    });

    it("uncomplete() clears completedAt and clears seq, returning the Task to list()", async () => {
      await store.upsert([task({ id: "a", seq: 1 })]);
      await store.complete("a", "2026-01-05T00:00:00.000Z");

      await store.uncomplete("a");

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", completedAt: null, seq: null });
      expect(await store.listCompleted()).toEqual([]);
    });

    it("complete() then uncomplete() round-trips a Task back to its original content and order", async () => {
      const original = task({ id: "a", seq: 1, content: "buy milk", orderKey: "m" });
      await store.upsert([original]);

      await store.complete("a", "2026-01-05T00:00:00.000Z");
      await store.uncomplete("a");

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", content: "buy milk", orderKey: "m" });
    });
  });

  it("rename() changes content and clears seq", async () => {
    const synced = task({ id: "a", content: "original", seq: 5 });
    await store.upsert([synced]);

    await store.rename("a", "changed");

    const [found] = await store.list();
    expect(found).toMatchObject({ id: "a", content: "changed", seq: null });
  });

  it("rename() updates the search index — found by the new word, not the old", async () => {
    await store.upsert([task({ id: "a", content: "a recurring task", seq: 1 })]);

    await store.rename("a", "a completed chore");

    expect((await store.search("chore")).map((t) => t.id)).toEqual(["a"]);
    expect(await store.search("recur")).toEqual([]);
  });

  describe("reorder()", () => {
    it("changes orderKey and clears seq", async () => {
      const synced = task({ id: "a", orderKey: "m", seq: 5 });
      await store.upsert([synced]);

      const newKey = orderKeyBetween(null, "m");
      await store.reorder("a", newKey);

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", orderKey: newKey, seq: null });
    });

    // The property fractional indexing exists to give (ADR 0050): a drag
    // touches the dragged Task's own row and nothing else. Asserted here
    // by checking every sibling's orderKey and seq are byte-identical to
    // what was upserted — not merely that the dragged Task ended up in
    // the right place, which a naive "recompute every sibling's order"
    // implementation could also achieve while still rewriting rows it
    // had no business touching.
    it("touches only the reordered Task — every sibling's orderKey and seq are untouched", async () => {
      const a = task({ id: "a", orderKey: "a", seq: 1 });
      const b = task({ id: "b", orderKey: "b", seq: 2 });
      const c = task({ id: "c", orderKey: "c", seq: 3 });
      await store.upsert([a, b, c]);

      await store.reorder("c", orderKeyBetween(null, "a"));

      const [first, second, third] = await store.list();
      expect(first).toMatchObject({ id: "c" });
      expect(second).toEqual(a);
      expect(third).toEqual(b);
    });
  });

  describe("remove() — tombstone, not hard delete", () => {
    it("removes a Task from list(), listCompleted(), get() and search()", async () => {
      await store.upsert([task({ id: "a", content: "a recurring task", seq: 1 })]);

      await store.remove("a");

      expect(await store.list()).toEqual([]);
      expect(await store.get("a")).toBeUndefined();
      expect(await store.search("recur")).toEqual([]);
    });

    // The resurrection trap ADR 0028 names, applied to Tasks: `seq IS
    // NULL` means "no acknowledgement from the server yet," which also
    // covers "pushed, but the response was lost" — a store that
    // hard-deletes here instead of leaving a tombstone would let the next
    // sync bring the Task back permanently. This is the most important
    // new case in this ticket, mirroring entryStoreContract's own most
    // important case exactly.
    it("removing a Task whose seq is already null still leaves a tombstone pending(), not nothing", async () => {
      await store.upsert([task({ id: "a", content: "not yet synced", seq: null })]);

      await store.remove("a");

      const pending = await store.pending();
      expect(pending.map((t) => t.id)).toEqual(["a"]);
      expect(pending[0]?.deletedAt).not.toBeNull();
    });

    it("removing a Task blanks its content", async () => {
      await store.upsert([task({ id: "a", content: "something", seq: 1 })]);

      await store.remove("a");

      const [tombstone] = await store.pending();
      expect(tombstone).toMatchObject({ id: "a", content: "" });
    });

    // Every local mutation against a tombstone is a no-op — no
    // resurrection, no matter which door a caller tries.
    it("complete(), uncomplete(), rename() and reorder() are all no-ops against a tombstone", async () => {
      await store.upsert([task({ id: "a", content: "something", seq: 1, orderKey: "m" })]);
      await store.remove("a");

      await store.complete("a", "2026-01-05T00:00:00.000Z");
      await store.uncomplete("a");
      await store.rename("a", "trying to bring it back");
      await store.reorder("a", orderKeyBetween(null, "m"));

      expect(await store.list()).toEqual([]);
      expect(await store.listCompleted()).toEqual([]);
      const [tombstone] = await store.pending();
      expect(tombstone).toMatchObject({ id: "a", content: "" });
      expect(tombstone?.deletedAt).not.toBeNull();
    });

    it("upserting a tombstone arriving from sync removes the Task from list() and search()", async () => {
      await store.upsert([task({ id: "a", content: "a recurring task", seq: 1 })]);
      expect((await store.list()).map((t) => t.id)).toEqual(["a"]);

      const tombstone = task({
        id: "a",
        content: "",
        seq: 2,
        deletedAt: "2026-01-03T00:00:00.000Z",
      });
      await store.upsert([tombstone]);

      expect(await store.list()).toEqual([]);
      expect(await store.search("recur")).toEqual([]);
    });
  });

  describe("get()", () => {
    it("returns a live Task by id", async () => {
      await store.upsert([task({ id: "a" })]);

      expect(await store.get("a")).toEqual(task({ id: "a" }));
    });

    it("returns undefined for an unknown id", async () => {
      expect(await store.get("never-seen")).toBeUndefined();
    });
  });

  it("returns only Tasks with a null sequence from pending() — exactly seq IS NULL", async () => {
    const unsynced = task({ id: "unsynced", seq: null });
    const synced = task({ id: "synced", seq: 42 });

    await store.upsert([unsynced, synced]);

    expect((await store.pending()).map((t) => t.id)).toEqual(["unsynced"]);
  });

  it("starts the cursor at 0 and reflects whatever it's set to", async () => {
    expect(await store.getCursor()).toBe(0);

    await store.setCursor(7);

    expect(await store.getCursor()).toBe(7);
  });

  describe("search()", () => {
    it("matches by a word prefix", async () => {
      const shopping = task({ id: "a", content: "buy groceries", orderKey: "a" });
      const other = task({ id: "b", content: "call the dentist", orderKey: "b" });
      await store.upsert([shopping, other]);

      expect((await store.search("groc")).map((t) => t.id)).toEqual(["a"]);
    });

    it("does not match a word that merely contains the query, not as a prefix", async () => {
      await store.upsert([task({ id: "a", content: "a recurring task" })]);

      expect(await store.search("urring")).toEqual([]);
    });

    it("treats quotes, wildcards and boolean-looking words as literal text, never throwing", async () => {
      await store.upsert([task({ id: "a", content: 'AND OR NOT "quoted" * text' })]);

      expect((await store.search('AND OR NOT "quoted" *')).map((t) => t.id)).toEqual(["a"]);
      await expect(store.search('he said "hello')).resolves.toEqual([]);
      await expect(store.search("!!!")).resolves.toEqual([]);
    });

    it("treats an empty or whitespace-only query as matching nothing", async () => {
      await store.upsert([task({ id: "a", content: "anything at all" })]);

      expect(await store.search("")).toEqual([]);
      expect(await store.search("   ")).toEqual([]);
    });

    it("excludes a completed Task", async () => {
      await store.upsert([task({ id: "a", content: "a recurring task", seq: 1 })]);

      await store.complete("a", "2026-01-05T00:00:00.000Z");

      expect(await store.search("recur")).toEqual([]);
    });

    it("excludes a tombstoned Task", async () => {
      await store.upsert([task({ id: "a", content: "a recurring task", seq: 1 })]);

      await store.remove("a");

      expect(await store.search("recur")).toEqual([]);
    });
  });
}
