import { describe, expect, it } from "vitest";
import { entry } from "./entry-fixture";
import { InMemoryEntryStore } from "./in-memory-entry-store";

describe("InMemoryEntryStore", () => {
  it("returns a locally created Entry immediately, before any sync", async () => {
    const store = new InMemoryEntryStore();
    const local = entry({ id: "local-1", seq: null });

    await store.upsert([local]);

    expect(await store.list()).toEqual([local]);
  });

  it("deduplicates Entries arriving twice by id, rather than appending twice", async () => {
    const store = new InMemoryEntryStore();
    const first = entry({ id: "dup-1", body: "first version" });
    const second = entry({ id: "dup-1", body: "second version", seq: 1 });

    await store.upsert([first]);
    await store.upsert([second]);

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(second);
  });

  it("orders Entries by createdAt, breaking ties by id", async () => {
    const store = new InMemoryEntryStore();
    const later = entry({ id: "c", createdAt: "2026-01-02T00:00:00.000Z" });
    const earlierTieB = entry({ id: "b", createdAt: "2026-01-01T00:00:00.000Z" });
    const earlierTieA = entry({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" });

    await store.upsert([later, earlierTieB, earlierTieA]);

    expect((await store.list()).map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("returns only Entries with a null sequence from pending()", async () => {
    const store = new InMemoryEntryStore();
    const unsynced = entry({ id: "unsynced", seq: null });
    const synced = entry({ id: "synced", seq: 42 });

    await store.upsert([unsynced, synced]);

    expect((await store.pending()).map((e) => e.id)).toEqual(["unsynced"]);
  });

  it("starts the cursor at 0 and reflects whatever it's set to", async () => {
    const store = new InMemoryEntryStore();

    expect(await store.getCursor()).toBe(0);

    await store.setCursor(7);

    expect(await store.getCursor()).toBe(7);
  });
});
