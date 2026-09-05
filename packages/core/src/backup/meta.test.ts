import { describe, expect, it } from "vitest";
import { LEDGER_TABLE } from "../sqlite/migrator";
import { NodeSqliteDriver } from "../sqlite/node-driver";
import { open } from "../sqlite/open";
import { entry } from "../test-support/entry-fixture";
import { BACKUP_SCHEMA_VERSION, buildBackupMeta } from "./meta";

const OFFSET_IST = 330; // +05:30

describe("buildBackupMeta", () => {
  it("names the current schema version, this Device's id, when it was taken and at what offset", async () => {
    const driver = new NodeSqliteDriver();
    const { deviceId } = await open(driver);

    const meta = await buildBackupMeta(driver, {
      deviceId,
      takenAt: new Date("2026-08-16T06:15:00.000Z"),
      utcOffsetMinutes: OFFSET_IST,
    });

    expect(meta.schema).toBe(BACKUP_SCHEMA_VERSION);
    expect(meta.device_id).toBe(deviceId);
    expect(meta.taken_at).toBe("2026-08-16T06:15:00.000Z");
    expect(meta.utc_offset).toBe("+05:30");
  });

  // Read off the real ledger (../sqlite/migrator.ts) rather than asserting
  // a literal version number — issue #196 lands new migrations in
  // parallel with this ticket, and a hardcoded expectation here would
  // break the moment it does, for a reason that has nothing to do with
  // this function's own correctness.
  it("reports the highest migration version actually recorded in this database's own ledger", async () => {
    const driver = new NodeSqliteDriver();
    await open(driver);
    const ledgerRow = await driver.execute(`SELECT MAX(version) FROM ${LEDGER_TABLE}`, [], "all");
    const expectedVersion = (ledgerRow.rows[0] as unknown[])[0] as number;

    const meta = await buildBackupMeta(driver, {
      deviceId: "device-a",
      takenAt: new Date("2026-08-16T06:15:00.000Z"),
      utcOffsetMinutes: OFFSET_IST,
    });

    expect(meta.migration_version).toBe(expectedVersion);
    expect(meta.migration_version).toBeGreaterThan(0);
  });

  it("counts every row per table, including tombstones, for every table a Backup carries", async () => {
    const driver = new NodeSqliteDriver();
    const { store } = await open(driver);
    await store.upsert([
      entry({ id: "live" }),
      entry({ id: "gone", deletedAt: "2026-08-16T00:00:00.000Z" }),
    ]);

    const meta = await buildBackupMeta(driver, {
      deviceId: "device-a",
      takenAt: new Date("2026-08-16T06:15:00.000Z"),
      utcOffsetMinutes: OFFSET_IST,
    });

    expect(meta.row_counts.entries).toBe(2);
    expect(meta.row_counts.tasks).toBe(0);
    expect(meta.row_counts.kv).toBeGreaterThan(0); // ensureDeviceId() already wrote a row here.
    // Search-index tables carry no row count of their own — they're not a
    // Backup table at all (dump.ts's own `backupTableNames`).
    expect(meta.row_counts).not.toHaveProperty("entries_fts");
  });
});
