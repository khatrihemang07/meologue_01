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

  // Newest first by createdAt. Ties break by id descending — Entry ids
  // become time-ordered (uuidv7) shortly, and an ascending tiebreak would
  // order same-millisecond Entries oldest-first inside a newest-first list.
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
}
