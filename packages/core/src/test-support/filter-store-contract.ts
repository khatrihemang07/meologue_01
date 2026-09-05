import { beforeEach, describe, expect, it } from "vitest";
import type { FilterStore } from "../filter-store";
import { LABEL_COLOURS } from "../label-colors";
import { filter } from "./filter-fixture";

/**
 * The behaviour every FilterStore implementation (issue #185) must
 * satisfy — the Filter-shaped sibling of labelStoreContract
 * (./label-store-contract.ts), mirrored section for section so a reader
 * who knows one recognises the other. Call this from inside a `describe`
 * block, passing a factory for the implementation under test.
 */
export function filterStoreContract(createStore: () => FilterStore | Promise<FilterStore>): void {
  let store: FilterStore;

  beforeEach(async () => {
    store = await createStore();
  });

  it("returns a locally created Filter immediately, before any sync", async () => {
    const local = filter({ id: "local-1", seq: null });

    await store.upsert([local]);

    expect(await store.list()).toEqual([local]);
  });

  it("deduplicates Filters arriving twice by id, rather than appending twice", async () => {
    const first = filter({ id: "dup-1", name: "first version" });
    const second = filter({ id: "dup-1", name: "second version", seq: 1 });

    await store.upsert([first]);
    await store.upsert([second]);

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(second);
  });

  it("orders Filters alphabetically by name, case-insensitively, breaking ties by id", async () => {
    const banana = filter({ id: "b", name: "Banana" });
    const apple = filter({ id: "a", name: "apple" });
    const tieB = filter({ id: "tie-b", name: "same" });
    const tieA = filter({ id: "tie-a", name: "same" });

    await store.upsert([banana, apple, tieB, tieA]);

    expect((await store.list()).map((f) => f.id)).toEqual(["a", "b", "tie-a", "tie-b"]);
  });

  describe("rename()", () => {
    it("changes name and clears seq", async () => {
      const synced = filter({ id: "a", name: "original", seq: 5 });
      await store.upsert([synced]);

      await store.rename("a", "changed");

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", name: "changed", seq: null });
    });

    it("refuses an empty or whitespace-only name", async () => {
      await store.upsert([filter({ id: "a", seq: 1 })]);

      await expect(store.rename("a", "")).rejects.toThrow();
      await expect(store.rename("a", "   ")).rejects.toThrow();
    });

    // Issue #196: every setter that clears seq/syncedAt also stamps
    // updatedAt with a fresh value — client-only for Filter (this type's
    // own header comment: no server table, no Sync stream), but the local
    // guarantee is identical.
    it("stamps updatedAt with a fresh value", async () => {
      const original = filter({ id: "a", name: "original", seq: 5 });
      await store.upsert([original]);

      await store.rename("a", "changed");

      const [found] = await store.list();
      expect((found?.updatedAt as string) > original.updatedAt).toBe(true);
    });
  });

  describe("setColour()", () => {
    it("changes colour and clears seq", async () => {
      await store.upsert([filter({ id: "a", seq: 5 })]);
      const target = LABEL_COLOURS.find((c) => c.name === "blue");
      if (target === undefined) {
        throw new Error("LABEL_COLOURS is missing 'blue' — fixture assumption broken");
      }

      await store.setColour("a", target.hex);

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", colour: target.hex, seq: null });
    });

    it("refuses a hex outside the current palette — including the retired pre-2024 red", async () => {
      await store.upsert([filter({ id: "a", seq: 1 })]);

      await expect(store.setColour("a", "#DB4035")).rejects.toThrow();
      await expect(store.setColour("a", "#not-a-colour")).rejects.toThrow();
    });
  });

  describe("setQuery()", () => {
    it("changes query and clears seq", async () => {
      await store.upsert([filter({ id: "a", query: "today", seq: 5 })]);

      await store.setQuery("a", "overdue");

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", query: "overdue", seq: null });
    });

    it("refuses a query that does not parse — criterion 6, a Filter's own query is always parseable through this door", async () => {
      await store.upsert([filter({ id: "a", seq: 1 })]);

      await expect(store.setQuery("a", "today & overdue |")).rejects.toThrow();
      await expect(store.setQuery("a", "")).rejects.toThrow();
      await expect(store.setQuery("a", "today & overdue | subtask")).rejects.toThrow();
    });
  });

  describe("remove() — tombstone, not hard delete", () => {
    it("removes a Filter from list() and get()", async () => {
      await store.upsert([filter({ id: "a", name: "errand", seq: 1 })]);

      await store.remove("a");

      expect(await store.list()).toEqual([]);
      expect(await store.get("a")).toBeUndefined();
    });

    // Mirrors labelStoreContract's identical, most-important case: `seq
    // IS NULL` means "no acknowledgement from the server yet," which
    // also covers "pushed, but the response was lost" — a store that
    // hard-deletes here instead of leaving a tombstone would let the
    // next sync bring the Filter back permanently.
    it("removing a Filter whose seq is already null still leaves a tombstone pending(), not nothing", async () => {
      await store.upsert([filter({ id: "a", name: "not yet synced", seq: null })]);

      await store.remove("a");

      const pending = await store.pending();
      expect(pending.map((f) => f.id)).toEqual(["a"]);
      expect(pending[0]?.deletedAt).not.toBeNull();
    });

    it("removing a Filter blanks its name", async () => {
      await store.upsert([filter({ id: "a", name: "something", seq: 1 })]);

      await store.remove("a");

      const [tombstone] = await store.pending();
      expect(tombstone).toMatchObject({ id: "a", name: "" });
    });

    it("rename(), setColour() and setQuery() are all no-ops against a tombstone", async () => {
      await store.upsert([filter({ id: "a", name: "something", seq: 1 })]);
      await store.remove("a");

      await store.rename("a", "trying to bring it back");
      await store.setColour("a", "#4180FF");
      await store.setQuery("a", "overdue");

      expect(await store.list()).toEqual([]);
      const [tombstone] = await store.pending();
      expect(tombstone).toMatchObject({ id: "a", name: "" });
      expect(tombstone?.deletedAt).not.toBeNull();
    });

    it("upserting a tombstone arriving from sync removes the Filter from list()", async () => {
      await store.upsert([filter({ id: "a", name: "errand", seq: 1 })]);
      expect((await store.list()).map((f) => f.id)).toEqual(["a"]);

      const tombstone = filter({
        id: "a",
        name: "",
        seq: 2,
        deletedAt: "2026-01-03T00:00:00.000Z",
      });
      await store.upsert([tombstone]);

      expect(await store.list()).toEqual([]);
    });
  });

  describe("get()", () => {
    it("returns a live Filter by id", async () => {
      await store.upsert([filter({ id: "a" })]);

      expect(await store.get("a")).toEqual(filter({ id: "a" }));
    });

    it("returns undefined for an unknown id", async () => {
      expect(await store.get("never-seen")).toBeUndefined();
    });
  });

  it("returns only Filters with a null sequence from pending() — exactly seq IS NULL", async () => {
    const unsynced = filter({ id: "unsynced", seq: null });
    const synced = filter({ id: "synced", seq: 42 });

    await store.upsert([unsynced, synced]);

    expect((await store.pending()).map((f) => f.id)).toEqual(["unsynced"]);
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
}
