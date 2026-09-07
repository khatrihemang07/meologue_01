import { beforeEach, describe, expect, it } from "vitest";
import { LABEL_COLOURS } from "../label-colors";
import type { LabelStore } from "../label-store";
import { label } from "./label-fixture";

/**
 * The behaviour every LabelStore implementation (issue #170) must
 * satisfy — the Label-shaped sibling of taskStoreContract
 * (./task-store-contract.ts), mirrored section for section so a reader
 * who knows one recognises the other. Call this from inside a `describe`
 * block, passing a factory for the implementation under test.
 */
export function labelStoreContract(createStore: () => LabelStore | Promise<LabelStore>): void {
  let store: LabelStore;

  beforeEach(async () => {
    store = await createStore();
  });

  it("returns a locally created Label immediately, before any sync", async () => {
    const local = label({ id: "local-1", seq: null });

    await store.upsert([local]);

    expect(await store.list()).toEqual([local]);
  });

  it("deduplicates Labels arriving twice by id, rather than appending twice", async () => {
    const first = label({ id: "dup-1", name: "first version" });
    const second = label({ id: "dup-1", name: "second version", seq: 1 });

    await store.upsert([first]);
    await store.upsert([second]);

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(second);
  });

  it("orders Labels alphabetically by name, case-insensitively, breaking ties by id", async () => {
    const banana = label({ id: "b", name: "Banana" });
    const apple = label({ id: "a", name: "apple" });
    const tieB = label({ id: "tie-b", name: "same" });
    const tieA = label({ id: "tie-a", name: "same" });

    await store.upsert([banana, apple, tieB, tieA]);

    expect((await store.list()).map((l) => l.id)).toEqual(["a", "b", "tie-a", "tie-b"]);
  });

  describe("rename()", () => {
    it("changes name and clears seq", async () => {
      const synced = label({ id: "a", name: "original", seq: 5 });
      await store.upsert([synced]);

      await store.rename("a", "changed");

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", name: "changed", seq: null });
    });

    it("refuses an empty or whitespace-only name", async () => {
      await store.upsert([label({ id: "a", seq: 1 })]);

      await expect(store.rename("a", "")).rejects.toThrow();
      await expect(store.rename("a", "   ")).rejects.toThrow();
    });

    // Issue #196: every setter that clears seq/syncedAt also stamps
    // updatedAt with a fresh value.
    it("stamps updatedAt with a fresh value", async () => {
      const original = label({ id: "a", name: "original", seq: 5 });
      await store.upsert([original]);

      await store.rename("a", "changed");

      const [found] = await store.list();
      expect((found?.updatedAt as string) > original.updatedAt).toBe(true);
    });
  });

  describe("setColour()", () => {
    it("changes colour and clears seq", async () => {
      await store.upsert([label({ id: "a", seq: 5 })]);
      const target = LABEL_COLOURS.find((c) => c.name === "blue");
      if (target === undefined) {
        throw new Error("LABEL_COLOURS is missing 'blue' — fixture assumption broken");
      }

      await store.setColour("a", target.hex);

      const [found] = await store.list();
      expect(found).toMatchObject({ id: "a", colour: target.hex, seq: null });
    });

    it("refuses a hex outside the current palette — including the retired pre-2024 red", async () => {
      await store.upsert([label({ id: "a", seq: 1 })]);

      await expect(store.setColour("a", "#DB4035")).rejects.toThrow();
      await expect(store.setColour("a", "#not-a-colour")).rejects.toThrow();
    });
  });

  describe("remove() — tombstone, not hard delete", () => {
    it("removes a Label from list() and get()", async () => {
      await store.upsert([label({ id: "a", name: "errand", seq: 1 })]);

      await store.remove("a");

      expect(await store.list()).toEqual([]);
      expect(await store.get("a")).toBeUndefined();
    });

    // Mirrors taskStoreContract's identical, most-important case: `seq IS
    // NULL` means "no acknowledgement from the server yet," which also
    // covers "pushed, but the response was lost" — a store that
    // hard-deletes here instead of leaving a tombstone would let the
    // next sync bring the Label back permanently.
    it("removing a Label whose seq is already null still leaves a tombstone pending(), not nothing", async () => {
      await store.upsert([label({ id: "a", name: "not yet synced", seq: null })]);

      await store.remove("a");

      const pending = await store.pending();
      expect(pending.map((l) => l.id)).toEqual(["a"]);
      expect(pending[0]?.deletedAt).not.toBeNull();
    });

    it("removing a Label blanks its name", async () => {
      await store.upsert([label({ id: "a", name: "something", seq: 1 })]);

      await store.remove("a");

      const [tombstone] = await store.pending();
      expect(tombstone).toMatchObject({ id: "a", name: "" });
    });

    it("rename() and setColour() are both no-ops against a tombstone", async () => {
      await store.upsert([label({ id: "a", name: "something", seq: 1 })]);
      await store.remove("a");

      await store.rename("a", "trying to bring it back");
      await store.setColour("a", "#4180FF");

      expect(await store.list()).toEqual([]);
      const [tombstone] = await store.pending();
      expect(tombstone).toMatchObject({ id: "a", name: "" });
      expect(tombstone?.deletedAt).not.toBeNull();
    });

    it("upserting a tombstone arriving from sync removes the Label from list()", async () => {
      await store.upsert([label({ id: "a", name: "errand", seq: 1 })]);
      expect((await store.list()).map((l) => l.id)).toEqual(["a"]);

      const tombstone = label({
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
    it("returns a live Label by id", async () => {
      await store.upsert([label({ id: "a" })]);

      expect(await store.get("a")).toEqual(label({ id: "a" }));
    });

    it("returns undefined for an unknown id", async () => {
      expect(await store.get("never-seen")).toBeUndefined();
    });
  });

  it("returns only Labels with a null sequence from pending() — exactly seq IS NULL", async () => {
    const unsynced = label({ id: "unsynced", seq: null });
    const synced = label({ id: "synced", seq: 42 });

    await store.upsert([unsynced, synced]);

    expect((await store.pending()).map((l) => l.id)).toEqual(["unsynced"]);
  });

  // Issue #218: Sync's pull write path — everything above exercises
  // upsert(), which stays deliberately wholesale; these are the cases
  // that separate applyPulled() from it. See LabelStore.applyPulled's
  // own doc comment (../label-store.ts) and EntryStore.applyPulled's
  // (../store.ts, mirrored section for section by entry-store-
  // contract.ts's own "applyPulled() (issue #215)" block) for the rule
  // and every reason behind it.
  describe("applyPulled() (issue #218)", () => {
    it("applies an incoming row over a local row with nothing pending", async () => {
      await store.upsert([label({ id: "a", name: "as this Device last saw it", seq: 1 })]);

      await store.applyPulled([
        label({
          id: "a",
          name: "edited on another Device",
          updatedAt: "2026-01-02T00:00:00.000Z",
          seq: 2,
        }),
      ]);

      expect(await store.get("a")).toMatchObject({
        id: "a",
        name: "edited on another Device",
        seq: 2,
      });
    });

    it("inserts a Label this Device has never seen", async () => {
      await store.applyPulled([label({ id: "fresh", name: "from another Device", seq: 7 })]);

      expect(await store.get("fresh")).toMatchObject({ id: "fresh" });
    });

    it("does not overwrite a local edit that has not been pushed yet", async () => {
      await store.upsert([label({ id: "a", name: "before the local edit", seq: 1 })]);
      await store.rename("a", "the local edit nobody has pushed");

      await store.applyPulled([label({ id: "a", name: "before the local edit", seq: 1 })]);

      expect(await store.get("a")).toMatchObject({ name: "the local edit nobody has pushed" });
    });

    it("leaves the surviving local edit pending, so the next Sync still pushes it", async () => {
      await store.upsert([label({ id: "a", name: "before", seq: 1 })]);
      await store.rename("a", "the local edit nobody has pushed");

      await store.applyPulled([label({ id: "a", name: "before", seq: 1 })]);

      const pending = await store.pending();
      expect(pending.map((l) => l.id)).toEqual(["a"]);
      expect(pending[0]).toMatchObject({ name: "the local edit nobody has pushed", seq: null });
    });

    it("applies an incoming row that is newer than the pending local edit", async () => {
      await store.upsert([label({ id: "a", name: "before", seq: 1 })]);
      await store.rename("a", "the local edit");

      await store.applyPulled([
        label({
          id: "a",
          name: "a later edit from another Device",
          updatedAt: "2099-01-01T00:00:00.000Z",
          seq: 9,
        }),
      ]);

      expect(await store.get("a")).toMatchObject({
        name: "a later edit from another Device",
        seq: 9,
      });
    });

    it("applies an incoming row whose updatedAt ties the pending local row", async () => {
      await store.upsert([label({ id: "a", name: "before", seq: 1 })]);
      await store.rename("a", "the local edit");
      const local = await store.get("a");

      await store.applyPulled([
        label({ id: "a", name: "the local edit", updatedAt: local?.updatedAt as string, seq: 9 }),
      ]);

      expect(await store.pending()).toEqual([]);
      expect(await store.get("a")).toMatchObject({ id: "a", seq: 9 });
    });

    it("applies an incoming tombstone even over a newer pending local edit", async () => {
      await store.upsert([label({ id: "a", name: "a live Label", seq: 1 })]);
      await store.rename("a", "the local edit nobody has pushed");

      await store.applyPulled([
        label({
          id: "a",
          name: "",
          updatedAt: "2026-01-02T00:00:00.000Z",
          seq: 9,
          deletedAt: "2026-01-02T00:00:00.000Z",
        }),
      ]);

      expect(await store.get("a")).toBeUndefined();
    });

    it("refuses only the rows it must, applying the rest of the batch", async () => {
      await store.upsert([
        label({ id: "a", name: "before", seq: 1 }),
        label({ id: "b", name: "b before", seq: 2 }),
      ]);
      await store.rename("a", "the local edit nobody has pushed");

      await store.applyPulled([
        label({ id: "a", name: "before", seq: 1 }),
        label({
          id: "b",
          name: "b, edited elsewhere",
          updatedAt: "2026-01-02T00:00:00.000Z",
          seq: 3,
        }),
      ]);

      const a = await store.get("a");
      const b = await store.get("b");
      expect(a).toMatchObject({ name: "the local edit nobody has pushed", seq: null });
      expect(b).toMatchObject({ name: "b, edited elsewhere", seq: 3 });
    });

    it("is a no-op on an empty batch", async () => {
      await store.upsert([label({ id: "a", seq: 1 })]);

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
}
