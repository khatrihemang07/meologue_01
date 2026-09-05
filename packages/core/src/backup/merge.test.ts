import { describe, expect, it } from "vitest";
import { NodeSqliteDriver } from "../sqlite/node-driver";
import { open } from "../sqlite/open";
import { entry } from "../test-support/entry-fixture";
import { event } from "../test-support/event-fixture";
import { dumpDatabase } from "./dump";
import { mergeBackupIntoDevice } from "./merge";

describe("mergeBackupIntoDevice", () => {
  it("inserts a row only the Backup has, and leaves a row only this Device has untouched", async () => {
    const sourceDriver = new NodeSqliteDriver();
    const { store: sourceStore } = await open(sourceDriver);
    await sourceStore.upsert([
      entry({
        id: "only-in-backup",
        body: "from the backup",
        seq: 99,
        syncedAt: "2026-01-01T00:00:01.000Z",
      }),
    ]);
    const sql = await dumpDatabase(sourceDriver);

    const targetDriver = new NodeSqliteDriver();
    const { store: targetStore } = await open(targetDriver);
    await targetStore.upsert([
      entry({ id: "only-locally", body: "never left this Device", seq: 5 }),
    ]);

    const outcome = await mergeBackupIntoDevice(targetDriver, sql);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.result.inserted).toBe(1);
    expect(outcome.result.updated).toBe(0);

    const ids = (await targetStore.list()).map((e) => e.id).sort();
    expect(ids).toEqual(["only-in-backup", "only-locally"]);

    const inserted = (await targetStore.list()).find((e) => e.id === "only-in-backup");
    // Merge marks whatever it writes unsynced — unlike Restore, which
    // preserves seq/synced_at verbatim (this file's own header comment).
    expect(inserted?.seq).toBeNull();
    expect(inserted?.syncedAt).toBeNull();

    const local = (await targetStore.list()).find((e) => e.id === "only-locally");
    expect(local?.seq).toBe(5);
  });

  it("the greater updated_at wins, and an equal one does nothing", async () => {
    const sourceDriver = new NodeSqliteDriver();
    const { store: sourceStore } = await open(sourceDriver);
    await sourceStore.upsert([
      entry({
        id: "newer-wins",
        body: "edited elsewhere, later",
        updatedAt: "2026-02-01T00:00:00.000Z",
      }),
      entry({
        id: "tie-goes-nowhere",
        body: "backup's own body",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    const sql = await dumpDatabase(sourceDriver);

    const targetDriver = new NodeSqliteDriver();
    const { store: targetStore } = await open(targetDriver);
    await targetStore.upsert([
      entry({
        id: "newer-wins",
        body: "this Device's older body",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      entry({
        id: "tie-goes-nowhere",
        body: "this Device's own body",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);

    const outcome = await mergeBackupIntoDevice(targetDriver, sql);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.result.updated).toBe(1);
    expect(outcome.result.unchanged).toBe(1);

    const byId = Object.fromEntries((await targetStore.list()).map((e) => [e.id, e]));
    expect(byId["newer-wins"]?.body).toBe("edited elsewhere, later");
    // Equal updated_at: this Device's own row is untouched, even though
    // the Backup's content differs.
    expect(byId["tie-goes-nowhere"]?.body).toBe("this Device's own body");
  });

  it("skips a row whose content is identical, even when seq/synced_at differ, and counts it unchanged", async () => {
    const sourceDriver = new NodeSqliteDriver();
    const { store: sourceStore } = await open(sourceDriver);
    await sourceStore.upsert([
      entry({
        id: "e1",
        body: "same everywhere",
        seq: 42,
        syncedAt: "2026-01-01T00:00:01.000Z",
      }),
    ]);
    const sql = await dumpDatabase(sourceDriver);

    const targetDriver = new NodeSqliteDriver();
    const { store: targetStore } = await open(targetDriver);
    await targetStore.upsert([
      entry({ id: "e1", body: "same everywhere", seq: 7, syncedAt: null }),
    ]);

    const outcome = await mergeBackupIntoDevice(targetDriver, sql);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.result.inserted).toBe(0);
    expect(outcome.result.updated).toBe(0);
    expect(outcome.result.unchanged).toBe(1);

    // Not written at all — this Device's own seq/synced_at survive,
    // proving the row was genuinely skipped rather than written with the
    // Backup's own (different) bookkeeping values.
    const merged = (await targetStore.list()).find((e) => e.id === "e1");
    expect(merged?.seq).toBe(7);
    expect(merged?.syncedAt).toBeNull();
  });

  it("a tombstone this Device already holds cannot be undone by the Backup, even with a numerically greater updated_at", async () => {
    const sourceDriver = new NodeSqliteDriver();
    const { store: sourceStore } = await open(sourceDriver);
    // Simulates clock skew: the Backup's own clock is far ahead, so its
    // (never-deleted) row's updated_at reads as later than this Device's
    // own delete — exactly the scenario the "no clock-skew guard" decision
    // accepts everywhere except here.
    await sourceStore.upsert([
      entry({ id: "e1", body: "resurrected?!", updatedAt: "2099-01-01T00:00:00.000Z" }),
    ]);
    const sql = await dumpDatabase(sourceDriver);

    const targetDriver = new NodeSqliteDriver();
    const { store: targetStore } = await open(targetDriver);
    await targetStore.upsert([
      entry({
        id: "e1",
        body: "",
        updatedAt: "2026-01-02T00:00:00.000Z",
        deletedAt: "2026-01-02T00:00:00.000Z",
      }),
    ]);

    const outcome = await mergeBackupIntoDevice(targetDriver, sql);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.result.updated).toBe(0);
    expect(outcome.result.unchanged).toBe(1);

    const row = await targetDriver.execute(
      "SELECT deleted_at, body FROM entries WHERE id = 'e1'",
      [],
      "get",
    );
    expect(row.rows).toEqual(["2026-01-02T00:00:00.000Z", ""]);
  });

  it("a tombstone the Backup carries always applies, even over a local edit with a greater updated_at", async () => {
    const sourceDriver = new NodeSqliteDriver();
    const { store: sourceStore } = await open(sourceDriver);
    await sourceStore.upsert([
      entry({
        id: "e1",
        body: "",
        updatedAt: "2026-01-01T00:00:00.000Z",
        deletedAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    const sql = await dumpDatabase(sourceDriver);

    const targetDriver = new NodeSqliteDriver();
    const { store: targetStore } = await open(targetDriver);
    // This Device edited the row after the Backup's own delete, unaware
    // the row had been removed elsewhere — its updated_at is numerically
    // greater, but the delete is still terminal.
    await targetStore.upsert([
      entry({
        id: "e1",
        body: "edited without knowing it was deleted",
        updatedAt: "2026-06-01T00:00:00.000Z",
      }),
    ]);

    const outcome = await mergeBackupIntoDevice(targetDriver, sql);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.result.updated).toBe(1);

    const row = await targetDriver.execute(
      "SELECT deleted_at, body FROM entries WHERE id = 'e1'",
      [],
      "get",
    );
    expect(row.rows).toEqual(["2026-01-01T00:00:00.000Z", ""]);
  });

  it("merges Events insert-if-absent only, never overwriting one this Device already has", async () => {
    const sourceDriver = new NodeSqliteDriver();
    const { eventStore: sourceEvents } = await open(sourceDriver);
    // upsert(), not record(): only used here to set up two divergent
    // "Devices" for the test — ../event-store.ts's own upsert() doc
    // comment explains why only Sync's pull path legitimately overwrites
    // an Event, which is not what this test is exercising.
    await sourceEvents.upsert([
      event({ id: "shared", extra: { from: "backup" } }),
      event({ id: "only-in-backup" }),
    ]);
    const sql = await dumpDatabase(sourceDriver);

    const targetDriver = new NodeSqliteDriver();
    const { eventStore: targetEvents } = await open(targetDriver);
    await targetEvents.upsert([
      event({ id: "shared", extra: { from: "this device" } }),
      event({ id: "only-locally" }),
    ]);

    const outcome = await mergeBackupIntoDevice(targetDriver, sql);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.result.inserted).toBe(1);
    expect(outcome.result.updated).toBe(0);

    const byId = Object.fromEntries((await targetEvents.list()).map((e) => [e.id, e]));
    expect(Object.keys(byId).sort()).toEqual(["only-in-backup", "only-locally", "shared"]);
    // Never overwritten, even though the Backup's own content differed.
    expect(byId.shared?.extra).toEqual({ from: "this device" });
  });

  it("does not apply settings — kv (device_id, cursors) is left exactly as it was", async () => {
    const sourceDriver = new NodeSqliteDriver();
    const { store: sourceStore, deviceId: sourceDeviceId } = await open(sourceDriver);
    await sourceStore.upsert([entry({ id: "e1", body: "from source" })]);
    const sql = await dumpDatabase(sourceDriver);

    const targetDriver = new NodeSqliteDriver();
    const { store: targetStore, deviceId: targetDeviceId } = await open(targetDriver);
    await targetStore.setCursor(7);
    expect(targetDeviceId).not.toBe(sourceDeviceId);

    const before = await targetDriver.execute("SELECT key, value FROM kv ORDER BY key", [], "all");

    const outcome = await mergeBackupIntoDevice(targetDriver, sql);
    expect(outcome.ok).toBe(true);

    const after = await targetDriver.execute("SELECT key, value FROM kv ORDER BY key", [], "all");
    expect(after.rows).toEqual(before.rows);
    const kv = Object.fromEntries(after.rows.map((row) => row as [string, string]));
    expect(kv.device_id).toBe(targetDeviceId);
    expect(kv.cursor).toBe("7");
  });

  it("merging a Backup of a Device with mostly-shared history marks almost nothing pending", async () => {
    const sourceDriver = new NodeSqliteDriver();
    const { store: sourceStore } = await open(sourceDriver);
    const targetDriver = new NodeSqliteDriver();
    const { store: targetStore } = await open(targetDriver);

    // 20 Entries both Devices already share, already synced (a nonzero
    // seq/synced_at) — the realistic shape of "mostly-shared history".
    const shared = Array.from({ length: 20 }, (_, index) =>
      entry({
        id: `shared-${index}`,
        body: `entry number ${index}`,
        seq: index + 1,
        syncedAt: "2026-01-01T00:00:01.000Z",
      }),
    );
    await sourceStore.upsert(shared);
    await targetStore.upsert(shared);
    // One real divergence: a row only this Device's Backup source has.
    await sourceStore.upsert([entry({ id: "new-from-source", body: "only from the backup" })]);

    const sql = await dumpDatabase(sourceDriver);
    const outcome = await mergeBackupIntoDevice(targetDriver, sql);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.result.inserted).toBe(1);
    expect(outcome.result.updated).toBe(0);
    expect(outcome.result.unchanged).toBe(20);

    // The whole point (ADR 0059): none of the 20 shared, already-synced
    // rows were rewritten, so none of them re-entered pending().
    const pending = await targetStore.pending();
    expect(pending.map((e) => e.id)).toEqual(["new-from-source"]);
  });
});
