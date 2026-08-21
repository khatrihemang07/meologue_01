import { beforeEach, expect, it } from "vitest";
import type { EntryStore } from "../store";
import { entry } from "./entry-fixture";

/**
 * The behaviour every EntryStore implementation (ADR 0001) must satisfy.
 * Call this from inside a `describe` block, passing a factory for the
 * implementation under test.
 */
export function entryStoreContract(createStore: () => EntryStore | Promise<EntryStore>): void {
  let store: EntryStore;

  beforeEach(async () => {
    store = await createStore();
  });

  it("returns a locally created Entry immediately, before any sync", async () => {
    const local = entry({ id: "local-1", seq: null });

    await store.upsert([local]);

    expect(await store.list()).toEqual([local]);
  });

  it("deduplicates Entries arriving twice by id, rather than appending twice", async () => {
    const first = entry({ id: "dup-1", body: "first version" });
    const second = entry({ id: "dup-1", body: "second version", seq: 1 });

    await store.upsert([first]);
    await store.upsert([second]);

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(second);
  });

  // Newest first by createdAt. Ties break by id descending — Entry ids are
  // time-ordered (uuidv7), and an ascending tiebreak would order
  // same-millisecond Entries oldest-first inside a newest-first list.
  it("orders Entries by createdAt descending, breaking ties by id descending", async () => {
    const later = entry({ id: "c", createdAt: "2026-01-02T00:00:00.000Z" });
    const earlierTieB = entry({ id: "b", createdAt: "2026-01-01T00:00:00.000Z" });
    const earlierTieA = entry({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" });

    await store.upsert([later, earlierTieB, earlierTieA]);

    expect((await store.list()).map((e) => e.id)).toEqual(["c", "b", "a"]);
  });

  it("returns only Entries with a null sequence from pending()", async () => {
    const unsynced = entry({ id: "unsynced", seq: null });
    const synced = entry({ id: "synced", seq: 42 });

    await store.upsert([unsynced, synced]);

    expect((await store.pending()).map((e) => e.id)).toEqual(["unsynced"]);
  });

  it("starts the cursor at 0 and reflects whatever it's set to", async () => {
    expect(await store.getCursor()).toBe(0);

    await store.setCursor(7);

    expect(await store.getCursor()).toBe(7);
  });

  it("search finds Entries by a word prefix, in History's order", async () => {
    const task = entry({
      id: "a",
      body: "a recurring task",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const theme = entry({
      id: "b",
      body: "recurring theme in art",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    const unrelated = entry({ id: "c", body: "buy milk", createdAt: "2026-01-03T00:00:00.000Z" });

    await store.upsert([task, theme, unrelated]);

    expect((await store.search("recur")).map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("search does not match a word that merely contains the query, not as a prefix", async () => {
    await store.upsert([entry({ id: "a", body: "a recurring task" })]);

    expect(await store.search("urring")).toEqual([]);
  });

  it("search treats quotes, wildcards and boolean-looking words as literal text, never throwing", async () => {
    await store.upsert([entry({ id: "a", body: 'AND OR NOT "quoted" * text' })]);

    // A literal match on the body's own text — if this were parsed as
    // query syntax instead of searched for, it either wouldn't match, or
    // would throw.
    expect((await store.search('AND OR NOT "quoted" *')).map((e) => e.id)).toEqual(["a"]);
    await expect(store.search('he said "hello')).resolves.toEqual([]);
    await expect(store.search("!!!")).resolves.toEqual([]);
  });

  it("search treats an empty or whitespace-only query as matching nothing", async () => {
    await store.upsert([entry({ id: "a", body: "anything at all" })]);

    expect(await store.search("")).toEqual([]);
    expect(await store.search("   ")).toEqual([]);
  });

  it("search redelivering the same Entry via upsert does not duplicate results", async () => {
    const original = entry({ id: "a", body: "recurring task", seq: null });
    const synced = entry({ id: "a", body: "recurring task", seq: 1 });

    await store.upsert([original]);
    await store.upsert([synced]);

    expect((await store.search("recur")).map((e) => e.id)).toEqual(["a"]);
  });

  // ADR 0028: editing goes through edit(), not "build a mutated Entry and
  // upsert() it" — see EntryStore.edit's doc comment for why. These cases
  // are the contract that method owes every implementation.

  it("edit() changes an Entry's body and clears seq, making it pending again", async () => {
    const synced = entry({
      id: "a",
      body: "original",
      seq: 5,
      syncedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.upsert([synced]);

    await store.edit("a", "changed");

    const [found] = await store.list();
    expect(found).toMatchObject({ id: "a", body: "changed", seq: null });
    expect((await store.pending()).map((e) => e.id)).toEqual(["a"]);
  });

  // CONTEXT.md's domain guarantee: editing an Entry does not move it in
  // History. createdAt is what list() orders by, so this is really two
  // assertions in one — the field itself is untouched, and so is the
  // Entry's position relative to its neighbours.
  it("editing an Entry does not change its createdAt or its position in list() order", async () => {
    const older = entry({ id: "older", createdAt: "2026-01-01T00:00:00.000Z", body: "old" });
    const newer = entry({ id: "newer", createdAt: "2026-01-02T00:00:00.000Z", body: "new" });
    await store.upsert([older, newer]);

    await store.edit("older", "old, but edited");

    const list = await store.list();
    expect(list.map((e) => e.id)).toEqual(["newer", "older"]);
    expect(list.find((e) => e.id === "older")?.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("remove() makes an Entry disappear from list() and from search()", async () => {
    await store.upsert([entry({ id: "a", body: "a recurring task", seq: 1 })]);

    await store.remove("a");

    expect(await store.list()).toEqual([]);
    expect(await store.search("recur")).toEqual([]);
  });

  // The resurrection trap ADR 0028 names explicitly: `seq IS NULL` means
  // "no acknowledgement yet," which also covers "pushed, but the response
  // was lost" — a store that hard-deletes here instead of leaving a
  // tombstone would let the next sync bring the Entry back permanently.
  // This is the most important new case in this ticket.
  it("removing an Entry whose seq is already null still leaves a tombstone pending(), not nothing", async () => {
    await store.upsert([entry({ id: "a", body: "not yet synced", seq: null })]);

    await store.remove("a");

    const pending = await store.pending();
    expect(pending.map((e) => e.id)).toEqual(["a"]);
    expect(pending[0]?.deletedAt).not.toBeNull();
  });

  it("removing an Entry blanks its body", async () => {
    await store.upsert([entry({ id: "a", body: "something", seq: 1 })]);

    await store.remove("a");

    const [tombstone] = await store.pending();
    expect(tombstone).toMatchObject({ id: "a", body: "" });
  });

  it("editing an already-removed Entry does nothing — no resurrection", async () => {
    await store.upsert([entry({ id: "a", body: "something", seq: 1 })]);
    await store.remove("a");

    await store.edit("a", "trying to bring it back");

    expect(await store.list()).toEqual([]);
    const [tombstone] = await store.pending();
    expect(tombstone).toMatchObject({ id: "a", body: "" });
    expect(tombstone?.deletedAt).not.toBeNull();
  });

  it("search finds an Entry by its new body after an edit, and not by its old body", async () => {
    await store.upsert([entry({ id: "a", body: "a recurring task", seq: 1 })]);

    await store.edit("a", "a completed chore");

    expect((await store.search("chore")).map((e) => e.id)).toEqual(["a"]);
    expect(await store.search("recur")).toEqual([]);
  });

  it("upserting a tombstone arriving from sync removes the Entry from list() and search()", async () => {
    await store.upsert([entry({ id: "a", body: "a recurring task", seq: 1 })]);
    expect((await store.list()).map((e) => e.id)).toEqual(["a"]);

    const tombstone = entry({
      id: "a",
      body: "",
      seq: 2,
      deletedAt: "2026-01-03T00:00:00.000Z",
    });
    await store.upsert([tombstone]);

    expect(await store.list()).toEqual([]);
    expect(await store.search("recur")).toEqual([]);
  });
}
