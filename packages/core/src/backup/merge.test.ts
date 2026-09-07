import { describe, expect, it } from "vitest";
import type { SqliteDriver } from "../sqlite/driver";
import { NodeSqliteDriver } from "../sqlite/node-driver";
import { open } from "../sqlite/open";
import { entry } from "../test-support/entry-fixture";
import { event } from "../test-support/event-fixture";
import { InterruptingDriver, NoTransactionDriver } from "../test-support/interrupting-driver";
import { task } from "../test-support/task-fixture";
import { dumpDatabase } from "./dump";
import { mergeBackupIntoDevice } from "./merge";
import { restoreFromBackup, type SafetyBackupOutcome, type TakeSafetyBackup } from "./restore";

/** A `takeSafetyBackup` that always succeeds, reporting a fixed file name — every test below except the "safety Backup itself failed"/interruption ones just needs Merge to get past this step, not to exercise it (mirrors ./restore.test.ts's identical `okSafetyBackup`). */
const okSafetyBackup: TakeSafetyBackup = async () => ({
  ok: true,
  fileName: "meologue-safety-backup-20260101-000000.zip",
});

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

    const outcome = await mergeBackupIntoDevice({
      driver: targetDriver,
      databaseSql: sql,
      takeSafetyBackup: okSafetyBackup,
    });
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

    const outcome = await mergeBackupIntoDevice({
      driver: targetDriver,
      databaseSql: sql,
      takeSafetyBackup: okSafetyBackup,
    });
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

  // Issue #217 / ADR 0065's amendment: the Server and this client do not
  // write `updated_at` in the same shape, so byte order is not
  // chronological order. The test above uses one shape on both sides,
  // which is exactly why nothing caught this — the mismatch only exists
  // where the two writers meet, and no fixture built a cross-shape pair.
  describe("across the Server's timestamp shape and this client's", () => {
    // The damaging direction, and the likely one: `'Z'` (0x5A) sorts above
    // `'.'` (0x2E), so a Server value landing on a whole second compares
    // GREATER than every client value inside that same second while being
    // up to a second EARLIER. Raw comparison lets the Backup's older row
    // overwrite this Device's later one.
    it("does not let a whole-second Backup row overwrite a later row inside that same second", async () => {
      const sourceDriver = new NodeSqliteDriver();
      const { store: sourceStore } = await open(sourceDriver);
      await sourceStore.upsert([
        entry({
          id: "whole-second",
          body: "the Backup's older body",
          // Server-shaped: chrono emits no fraction at all when the
          // nanosecond component is zero.
          updatedAt: "2026-02-01T12:00:00Z",
        }),
      ]);
      const sql = await dumpDatabase(sourceDriver);

      const targetDriver = new NodeSqliteDriver();
      const { store: targetStore } = await open(targetDriver);
      await targetStore.upsert([
        entry({
          id: "whole-second",
          body: "this Device's later body",
          // Client-shaped, and genuinely 500ms AFTER the Backup's row.
          updatedAt: "2026-02-01T12:00:00.500Z",
        }),
      ]);

      const outcome = await mergeBackupIntoDevice({
        driver: targetDriver,
        databaseSql: sql,
        takeSafetyBackup: okSafetyBackup,
      });
      expect(outcome.ok).toBe(true);

      const [merged] = await targetStore.list();
      expect(merged?.body).toBe("this Device's later body");
    });

    // The mirror: a Server-shaped Backup row that really is later must
    // still win over a client-shaped local row, so the fix cannot simply
    // refuse everything it cannot compare byte-wise.
    it("still lets a genuinely later Backup row win across the two shapes", async () => {
      const sourceDriver = new NodeSqliteDriver();
      const { store: sourceStore } = await open(sourceDriver);
      await sourceStore.upsert([
        entry({
          id: "server-later",
          body: "the Backup's later body",
          updatedAt: "2026-02-01T12:00:01.250000Z",
        }),
      ]);
      const sql = await dumpDatabase(sourceDriver);

      const targetDriver = new NodeSqliteDriver();
      const { store: targetStore } = await open(targetDriver);
      await targetStore.upsert([
        entry({
          id: "server-later",
          body: "this Device's earlier body",
          updatedAt: "2026-02-01T12:00:00.500Z",
        }),
      ]);

      const outcome = await mergeBackupIntoDevice({
        driver: targetDriver,
        databaseSql: sql,
        takeSafetyBackup: okSafetyBackup,
      });
      expect(outcome.ok).toBe(true);

      const [merged] = await targetStore.list();
      expect(merged?.body).toBe("the Backup's later body");
    });

    // The case that outlives any future normalising migration, and the one
    // nobody would think to keep once the two above start looking
    // redundant. A Backup is a lossless copy of the database as it stood
    // (dump.ts) and Restore puts those values back verbatim (restore.ts's
    // own reason 3), so old shapes re-enter a Device through Restore no
    // matter how thoroughly the live corpus has been normalised. Here the
    // old shape arrives by a real Restore rather than being hand-written,
    // and then has to lose a Merge correctly.
    it("orders a row correctly after its old-shape updated_at arrived through a real Restore", async () => {
      // An old Backup, carrying the Server's whole-second shape.
      const oldBackupDriver = new NodeSqliteDriver();
      const { store: oldBackupStore } = await open(oldBackupDriver);
      await oldBackupStore.upsert([
        entry({
          id: "revived",
          body: "the old Backup's body",
          updatedAt: "2026-02-01T12:00:00Z",
        }),
      ]);
      const oldBackupSql = await dumpDatabase(oldBackupDriver);

      // This Device restores it, which writes that shape back verbatim.
      const deviceDriver = new NodeSqliteDriver();
      const { store: deviceStore } = await open(deviceDriver);
      const restored = await restoreFromBackup({
        driver: deviceDriver,
        databaseSql: oldBackupSql,
        takeSafetyBackup: okSafetyBackup,
      });
      expect(restored.ok).toBe(true);
      // The old shape really is what is now stored — if Restore ever starts
      // normalising on the way in, this assertion is the one that should
      // fail and force the decision to be made deliberately.
      const revivedRow = await deviceDriver.execute(
        "SELECT updated_at FROM entries WHERE id = 'revived'",
        [],
        "get",
      );
      expect(revivedRow.rows).toEqual(["2026-02-01T12:00:00Z"]);

      // A second Backup, client-shaped and 500ms later, merged in.
      const laterDriver = new NodeSqliteDriver();
      const { store: laterStore } = await open(laterDriver);
      await laterStore.upsert([
        entry({
          id: "revived",
          body: "the later body",
          updatedAt: "2026-02-01T12:00:00.500Z",
        }),
      ]);
      const laterSql = await dumpDatabase(laterDriver);

      const outcome = await mergeBackupIntoDevice({
        driver: deviceDriver,
        databaseSql: laterSql,
        takeSafetyBackup: okSafetyBackup,
      });
      expect(outcome.ok).toBe(true);

      const [merged] = await deviceStore.list();
      expect(merged?.body).toBe("the later body");
    });
  });

  it("skips a row whose content is identical even when updated_at differs, and never marks it pending", async () => {
    // ADR 0059's own documented consequence: an "edit" that lands on
    // identical content leaves the Server's `updated_at` older than the
    // Device's, because the `is distinct from` guard never fired. Two
    // Devices can therefore hold byte-identical content under different
    // `updated_at` values through no edit either user made. Merge must
    // treat that as unchanged — "content-identical rows are skipped
    // outright regardless of what either side's `updated_at` says"
    // (./merge.ts's own header comment, and CONTEXT.md's Merge entry).
    //
    // Getting this wrong is not cosmetic: the row falls through to the
    // greater-`updated_at` branch, gets rewritten, and is marked pending
    // — re-queuing a row nobody changed, which is the exact re-push
    // failure #194 and this ticket exist to close.
    const sourceDriver = new NodeSqliteDriver();
    const { store: sourceStore } = await open(sourceDriver);
    await sourceStore.upsert([
      entry({
        id: "e1",
        body: "same everywhere",
        updatedAt: "2026-03-01T00:00:00.000Z",
        seq: 42,
        syncedAt: "2026-01-01T00:00:01.000Z",
      }),
    ]);
    const sql = await dumpDatabase(sourceDriver);

    const targetDriver = new NodeSqliteDriver();
    const { store: targetStore } = await open(targetDriver);
    await targetStore.upsert([
      entry({
        id: "e1",
        body: "same everywhere",
        // Older than the Backup's, so the greater-updated_at branch would
        // overwrite this row if content equality did not short-circuit first.
        updatedAt: "2026-01-01T00:00:00.000Z",
        seq: 7,
        syncedAt: "2026-01-01T00:00:02.000Z",
      }),
    ]);

    const outcome = await mergeBackupIntoDevice({
      driver: targetDriver,
      databaseSql: sql,
      takeSafetyBackup: okSafetyBackup,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.result.updated).toBe(0);
    expect(outcome.result.unchanged).toBe(1);
    // The decisive assertion: nothing re-entered the Sync queue.
    expect(await targetStore.pending()).toHaveLength(0);
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

    const outcome = await mergeBackupIntoDevice({
      driver: targetDriver,
      databaseSql: sql,
      takeSafetyBackup: okSafetyBackup,
    });
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

    const outcome = await mergeBackupIntoDevice({
      driver: targetDriver,
      databaseSql: sql,
      takeSafetyBackup: okSafetyBackup,
    });
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

    const outcome = await mergeBackupIntoDevice({
      driver: targetDriver,
      databaseSql: sql,
      takeSafetyBackup: okSafetyBackup,
    });
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

    const outcome = await mergeBackupIntoDevice({
      driver: targetDriver,
      databaseSql: sql,
      takeSafetyBackup: okSafetyBackup,
    });
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

    const outcome = await mergeBackupIntoDevice({
      driver: targetDriver,
      databaseSql: sql,
      takeSafetyBackup: okSafetyBackup,
    });
    expect(outcome.ok).toBe(true);

    const after = await targetDriver.execute("SELECT key, value FROM kv ORDER BY key", [], "all");
    expect(after.rows).toEqual(before.rows);
    const kv = Object.fromEntries(after.rows.map((row) => row as [string, string]));
    expect(kv.device_id).toBe(targetDeviceId);
    expect(kv.cursor).toBe("7");
  });

  // Issue #214 / ADR 0067: `kv` is entirely excluded from Merge (this
  // file's own `MERGE_EXCLUDED_TABLES`), so without an explicit re-arm
  // step a Device that had already run the soft-break migration would
  // keep that marker forever after folding in another Device's rows —
  // including rows that Device never migrated. This is the one, narrow
  // exception to the "does not apply settings" test just above: this
  // single `kv` row is deliberately touched, unconditionally, on every
  // Merge, regardless of what the Backup itself carried.
  it("re-arms the soft-break migration on Merge, even though kv is otherwise untouched", async () => {
    const sourceDriver = new NodeSqliteDriver();
    const { store: sourceStore } = await open(sourceDriver);
    await sourceStore.upsert([entry({ id: "e1", body: "from source" })]);
    const sql = await dumpDatabase(sourceDriver);

    const targetDriver = new NodeSqliteDriver();
    const { store: targetStore } = await open(targetDriver);
    await targetStore.markSoftBreakMigrationComplete();
    expect(await targetStore.hasCompletedSoftBreakMigration()).toBe(true);

    const outcome = await mergeBackupIntoDevice({
      driver: targetDriver,
      databaseSql: sql,
      takeSafetyBackup: okSafetyBackup,
    });
    expect(outcome.ok).toBe(true);

    expect(await targetStore.hasCompletedSoftBreakMigration()).toBe(false);
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
    const outcome = await mergeBackupIntoDevice({
      driver: targetDriver,
      databaseSql: sql,
      takeSafetyBackup: okSafetyBackup,
    });

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

  it("names the safety Backup it took in a successful outcome's own result", async () => {
    const driver = new NodeSqliteDriver();
    await open(driver);
    const sql = await dumpDatabase(driver);

    const outcome = await mergeBackupIntoDevice({
      driver,
      databaseSql: sql,
      takeSafetyBackup: async () => ({ ok: true, fileName: "meologue-safety-backup-x.zip" }),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.result.safetyBackupFileName).toBe("meologue-safety-backup-x.zip");
  });
});

describe("mergeBackupIntoDevice — the safety Backup itself (issue #208)", () => {
  it("never calls BEGIN, and writes nothing, when takeSafetyBackup reports failure", async () => {
    const driver = new NodeSqliteDriver();
    const { store } = await open(driver);
    await store.upsert([entry({ id: "e1", body: "still here" })]);
    const sql = await dumpDatabase(driver);

    let sawBegin = false;
    const observingDriver: SqliteDriver = {
      execute: (statementSql, params, method) => {
        if (statementSql === "BEGIN") {
          sawBegin = true;
        }
        return driver.execute(statementSql, params, method);
      },
    };

    const outcome = await mergeBackupIntoDevice({
      driver: observingDriver,
      databaseSql: sql,
      takeSafetyBackup: async () => ({ ok: false, reason: "disk full" }),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toContain("disk full");
    expect(sawBegin).toBe(false);
    expect((await store.list()).map((e) => e.id)).toEqual(["e1"]);
  });

  it("treats a thrown takeSafetyBackup the same as a reported failure — ok:false, nothing written", async () => {
    const driver = new NodeSqliteDriver();
    const { store } = await open(driver);
    await store.upsert([entry({ id: "e1", body: "still here" })]);
    const sql = await dumpDatabase(driver);

    const outcome = await mergeBackupIntoDevice({
      driver,
      databaseSql: sql,
      takeSafetyBackup: async () => {
        throw new Error("save panel crashed");
      },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toContain("save panel crashed");
    expect((await store.list()).map((e) => e.id)).toEqual(["e1"]);
  });

  it("never even calls takeSafetyBackup for a malformed file — refusing the file needs no safety net", async () => {
    const driver = new NodeSqliteDriver();
    await open(driver);
    let called = false;
    const takeSafetyBackup: TakeSafetyBackup = async () => {
      called = true;
      return { ok: true, fileName: "unused.zip" };
    };

    const outcome = await mergeBackupIntoDevice({
      driver,
      databaseSql: "garbage not sql at all;",
      takeSafetyBackup,
    });

    expect(outcome.ok).toBe(false);
    expect(called).toBe(false);
  });
});

/**
 * Builds a fresh "this Device, before a Merge" — one Entry the incoming
 * Backup below will overwrite (a newer `updated_at`, case 6 in ./merge.ts's
 * own header comment), and nothing else. Mirrors ./restore.test.ts's own
 * `buildPreRestoreTarget`: Merge never deletes a row (this file's own
 * header comment, second bullet), so there is no equivalent "keep every
 * row the incoming Backup also mentions" constraint here — an `UPDATE`
 * never repositions a row's rowid the way a `DELETE` + reinsert would, so
 * `dumpDatabase`'s order-free `SELECT` stays stable across the whole test
 * regardless of what the incoming Backup adds.
 */
async function buildPreMergeTarget(): Promise<{ driver: NodeSqliteDriver; deviceId: string }> {
  const driver = new NodeSqliteDriver();
  const { store, deviceId } = await open(driver);
  await store.upsert([
    entry({ id: "e1", body: "original e1", updatedAt: "2026-01-01T00:00:00.000Z" }),
  ]);
  return { driver, deviceId };
}

/**
 * The Backup being merged into `buildPreMergeTarget`'s Device — carries a
 * genuinely newer `e1` (so Merge actually overwrites this Device's own
 * row, not just adds rows it lacked) plus `e2`/`t1`, which this Device
 * never had. Proving Merge can overwrite, not merely insert, is the whole
 * point: issue #208's own framing is that an interrupted Merge can leave
 * "some rows overwritten by the Backup's version, some not" — a fixture
 * that only ever inserted new rows would never exercise that half of the
 * risk.
 */
async function buildIncomingMergeBackupSql(): Promise<string> {
  const sourceDriver = new NodeSqliteDriver();
  const { store: sourceStore, taskStore: sourceTaskStore } = await open(sourceDriver);
  await sourceStore.upsert([
    entry({ id: "e1", body: "from the Backup, newer", updatedAt: "2026-02-01T00:00:00.000Z" }),
    entry({ id: "e2", body: "only ever in the Backup", updatedAt: "2026-01-01T00:00:00.000Z" }),
  ]);
  await sourceTaskStore.upsert([task({ id: "t1", content: "buy milk" })]);
  return dumpDatabase(sourceDriver);
}

describe("mergeBackupIntoDevice — an interrupted apply is recoverable from its own safety Backup (issue #208)", () => {
  /**
   * Runs the interrupted Merge itself, against a driver stack that (a)
   * behaves like `TauriSqliteDriver` — no real transaction, `ROLLBACK`
   * does nothing — and (b) throws partway through, at
   * `failAtMutationNumber`. Mirrors ./restore.test.ts's own
   * `runInterruptedRestore` — same two driver classes
   * (../test-support/interrupting-driver.ts), same event log, same
   * "safety Backup dumped through the very driver about to be written
   * into" seam.
   */
  async function runInterruptedMerge(failAtMutationNumber: number) {
    const { driver: rawDriver } = await buildPreMergeTarget();
    const preMergeSql = await dumpDatabase(rawDriver);
    const incomingSql = await buildIncomingMergeBackupSql();

    const events: string[] = [];
    const pooledDriver = new NoTransactionDriver(rawDriver);
    const interruptingDriver = new InterruptingDriver(pooledDriver, failAtMutationNumber, () =>
      events.push("mutation"),
    );

    let safetyBackupSql: string | null = null;
    const takeSafetyBackup: TakeSafetyBackup = async (): Promise<SafetyBackupOutcome> => {
      events.push("safety-backup-start");
      safetyBackupSql = await dumpDatabase(interruptingDriver);
      events.push("safety-backup-done");
      return { ok: true, fileName: "meologue-safety-backup-20260101-000000.zip" };
    };

    let thrown: unknown;
    try {
      await mergeBackupIntoDevice({
        driver: interruptingDriver,
        databaseSql: incomingSql,
        takeSafetyBackup,
      });
    } catch (error) {
      thrown = error;
    }

    return {
      rawDriver,
      preMergeSql,
      safetyBackupSql: safetyBackupSql as string | null,
      events,
      thrown,
    };
  }

  it("interrupted early — after just one mutating statement already committed", async () => {
    const { rawDriver, preMergeSql, safetyBackupSql, events, thrown } =
      await runInterruptedMerge(2);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("meologue-safety-backup-20260101-000000.zip");

    expect(events[0]).toBe("safety-backup-start");
    expect(events[1]).toBe("safety-backup-done");
    expect(events.filter((event) => event === "mutation").length).toBe(2);
    expect(safetyBackupSql).toBe(preMergeSql);

    // The Device is genuinely half-merged — not a vacuous pass: at least
    // one mutating statement committed (NoTransactionDriver's autocommit,
    // exactly like the pooled Tauri driver it stands in for) before the
    // interruption, and that statement really changed the database.
    expect(await dumpDatabase(rawDriver)).not.toBe(preMergeSql);

    // Reapplying the safety Backup — via Restore, not a second Merge:
    // re-merging it would compare its own (older) updated_at against the
    // now-overwritten row's newer one and lose, leaving the corruption in
    // place, which is exactly why the recovery instructions (this file's
    // own mergeBackupIntoDevice doc comment, and the thrown error above)
    // say "restore", not "merge". Byte-identical dumpDatabase output
    // proves this Device is genuinely back to its pre-Merge state, not
    // merely "close enough".
    const recovery = await restoreFromBackup({
      driver: rawDriver,
      databaseSql: safetyBackupSql as string,
      takeSafetyBackup: okSafetyBackup,
    });
    expect(recovery.ok).toBe(true);
    expect(await dumpDatabase(rawDriver)).toBe(preMergeSql);
  });

  it("interrupted partway through, after several rows were already mutated", async () => {
    // A dry run (real transaction, so fully recoverable on its own)
    // against an identical setup, just to learn how many mutating
    // statements the apply produces in total — so the number chosen below
    // is a genuinely different point in the sequence, not a guess.
    const { driver: dryRunDriver } = await buildPreMergeTarget();
    const dryRunSql = await buildIncomingMergeBackupSql();
    let totalMutations = 0;
    const countingDriver = new InterruptingDriver(dryRunDriver, Number.POSITIVE_INFINITY, () => {
      totalMutations += 1;
    });
    const dryRunOutcome = await mergeBackupIntoDevice({
      driver: countingDriver,
      databaseSql: dryRunSql,
      takeSafetyBackup: okSafetyBackup,
    });
    expect(dryRunOutcome.ok).toBe(true);
    expect(totalMutations).toBeGreaterThan(1);

    const midpoint = Math.ceil(totalMutations / 2);
    const { rawDriver, preMergeSql, safetyBackupSql, events, thrown } =
      await runInterruptedMerge(midpoint);

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("meologue-safety-backup-20260101-000000.zip");
    expect(events[0]).toBe("safety-backup-start");
    expect(events[1]).toBe("safety-backup-done");
    expect(events.filter((event) => event === "mutation").length).toBe(midpoint);
    expect(safetyBackupSql).toBe(preMergeSql);
    expect(await dumpDatabase(rawDriver)).not.toBe(preMergeSql);

    const recovery = await restoreFromBackup({
      driver: rawDriver,
      databaseSql: safetyBackupSql as string,
      takeSafetyBackup: okSafetyBackup,
    });
    expect(recovery.ok).toBe(true);
    expect(await dumpDatabase(rawDriver)).toBe(preMergeSql);
  });
});
