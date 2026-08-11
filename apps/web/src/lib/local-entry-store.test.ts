import type { Entry } from "@meologue/core";
import { beforeEach, describe, expect, it } from "vitest";
import { LocalEntryStore } from "./local-entry-store";

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "entry-1",
    deviceId: "device-1",
    body: "hello meologue",
    createdAt: "2026-01-01T00:00:00.000Z",
    seq: null,
    syncedAt: null,
    ...overrides,
  };
}

describe("LocalEntryStore", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns a locally created Entry immediately, before any sync", async () => {
    const store = new LocalEntryStore();
    const local = entry({ id: "local-1", seq: null });

    await store.upsert([local]);

    expect(await store.list()).toEqual([local]);
  });

  it("deduplicates Entries arriving twice by id, rather than appending twice", async () => {
    const store = new LocalEntryStore();
    const first = entry({ id: "dup-1", body: "first version" });
    const second = entry({ id: "dup-1", body: "second version", seq: 1 });

    await store.upsert([first]);
    await store.upsert([second]);

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(second);
  });

  it("orders Entries by createdAt", async () => {
    const store = new LocalEntryStore();
    const later = entry({ id: "c", createdAt: "2026-01-02T00:00:00.000Z" });
    const earlierFirst = entry({ id: "b", createdAt: "2026-01-01T00:00:00.000Z" });
    const earlierSecond = entry({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" });

    await store.upsert([later, earlierFirst, earlierSecond]);

    expect((await store.list()).map((e) => e.id)).toEqual(["c", "b", "a"]);
  });

  it("breaks createdAt ties by arrival order, not by id", async () => {
    const store = new LocalEntryStore();
    const sentFirst = entry({ id: "z-sent-first", createdAt: "2026-01-01T00:00:00.000Z" });
    const sentSecond = entry({ id: "a-sent-second", createdAt: "2026-01-01T00:00:00.000Z" });

    await store.upsert([sentFirst]);
    await store.upsert([sentSecond]);

    expect((await store.list()).map((e) => e.id)).toEqual(["z-sent-first", "a-sent-second"]);
  });

  it("returns only Entries with a null sequence from pending()", async () => {
    const store = new LocalEntryStore();
    const unsynced = entry({ id: "unsynced", seq: null });
    const synced = entry({ id: "synced", seq: 42 });

    await store.upsert([unsynced, synced]);

    expect((await store.pending()).map((e) => e.id)).toEqual(["unsynced"]);
  });

  it("starts the cursor at 0 and reflects whatever it's set to", async () => {
    const store = new LocalEntryStore();

    expect(await store.getCursor()).toBe(0);

    await store.setCursor(7);

    expect(await store.getCursor()).toBe(7);
  });

  it("persists Entries and the Cursor across separate store instances, like a hard reload", async () => {
    const first = new LocalEntryStore();
    await first.upsert([entry({ id: "persisted-1" })]);
    await first.setCursor(3);

    const reloaded = new LocalEntryStore();

    expect((await reloaded.list()).map((e) => e.id)).toEqual(["persisted-1"]);
    expect(await reloaded.getCursor()).toBe(3);
  });
});
