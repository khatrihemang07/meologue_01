import { formatUtcOffset } from "../export/offset";
import type { SqliteDriver } from "../sqlite/driver";
import { LEDGER_TABLE } from "../sqlite/migrator";
import { backupTableNames } from "./dump";

/**
 * Bumped whenever this shape changes in a way a reader — or the Restore
 * ticket (#197) that doesn't exist yet — needs to know about, mirroring
 * ../export/manifest.ts's `EXPORT_SCHEMA_VERSION` exactly (same doc
 * comment, same reasoning): a schema number a reader can check beats a
 * reader guessing from which fields happen to be present.
 */
export const BACKUP_SCHEMA_VERSION = 1;

/**
 * `meta.json` — the small, human-legible manifest that travels beside
 * `database.sql` and `settings.json` in every Backup (issue #195,
 * CONTEXT.md's Backup entry). Answers, at a glance and with no need to
 * parse the SQL dump, "whose data is this, when was it taken, against what
 * schema, and roughly how much is in it" — the same job
 * ../export/manifest.ts's `ExportManifest` does for an Export, scaled down:
 * an Export's manifest carries every Entry and Task losslessly because it's
 * the thing a future import would read; a Backup's `database.sql` already
 * *is* the lossless copy, so this file only needs to describe it, not
 * duplicate it.
 */
export interface BackupMeta {
  schema: number;
  device_id: string;
  /** This Device's own clock, ISO-8601 UTC, the instant this Backup was taken — CONTEXT.md's own "taken-at" wording for a Backup, deliberately not `exported_at`: an Export and a Backup are two different artifacts (this ticket's own new vocabulary), and reusing Export's field name here would blur that distinction in the one file whose entire job is to say what this thing is. */
  taken_at: string;
  /** Minutes east of UTC `taken_at` was recorded at, formatted `±HH:MM` by ../export/offset.ts's `formatUtcOffset` — reused, not reimplemented, the same function ../export/manifest.ts already calls for the identical field on `ExportManifest`. */
  utc_offset: string;
  /**
   * The highest migration version this Device's own ledger
   * (../sqlite/migrator.ts's `LEDGER_TABLE`) had recorded as applied at the
   * moment this Backup was taken — read from the ledger itself, not from
   * ../sqlite/migrations/index.ts's own `MIGRATIONS` array, so this number
   * reflects what this specific database has actually been migrated to
   * rather than what the build of the app that took the Backup merely knew
   * how to apply.
   */
  migration_version: number;
  /**
   * Every table `database.sql` covers, mapped to how many rows it held —
   * search-index tables excluded, the identical set `dump.ts`'s
   * `dumpDatabase` itself dumps (`backupTableNames`, shared between the
   * two so they can't quietly disagree about what "every table" means).
   * Tombstoned rows count here exactly as they're counted in the dump —
   * this is a row count, not a "live rows" count — so a reader can sanity
   * check the dump's own `INSERT` count per table without parsing SQL to
   * get it.
   */
  row_counts: Record<string, number>;
}

export interface BuildBackupMetaOptions {
  deviceId: string;
  /** This Device's instant this Backup is taken at, injected rather than read via `new Date()` in here — the identical reasoning ../export/export-zip.ts's `ExportOptions.now` doc comment gives: it's what makes "two Backups a second apart get two distinct `taken_at` values" a testable claim rather than one only a real clock could exercise. */
  takenAt: Date;
  /** Minutes east of UTC this Device's clock currently reads — `-now.getTimezoneOffset()` on a real Device, injected for the identical reason ../export/export-zip.ts's `ExportOptions.utcOffsetMinutes` is: this package has no DOM and no host-timezone API to ask. */
  utcOffsetMinutes: number;
}

/** `SELECT MAX(version) FROM <ledger>` — `open()` (../sqlite/open.ts) always runs `migrate()` before handing a store back, so a real, already-open database always has at least one row here; this only reads `null` in a test that talks to a driver directly without ever calling `open()` or `migrate()`, which is why the fallback is `0`, migration version 0 meaning "nothing applied yet" rather than a value ../sqlite/migrations/index.ts's own `MIGRATIONS` could ever actually assign. */
async function highestAppliedMigration(driver: SqliteDriver): Promise<number> {
  const result = await driver.execute(`SELECT MAX(version) FROM ${LEDGER_TABLE}`, [], "all");
  const row = result.rows[0] as unknown[] | undefined;
  const value = row?.[0];
  return typeof value === "number" ? value : 0;
}

/**
 * One `SELECT COUNT(*)` per table `dump.ts` also dumps — cheap (SQLite
 * counts a rowid-ordered table without reading every column), and
 * deliberately not derived by counting the `INSERT` statements
 * `dumpDatabase` already produced: that would mean threading the dump's own
 * row-by-row output back into this file, coupling meta.json's shape to
 * dump.ts's internal statement format instead of to the database itself.
 */
async function countRows(driver: SqliteDriver): Promise<Record<string, number>> {
  const tableNames = await backupTableNames(driver);
  const counts: Record<string, number> = {};
  for (const name of tableNames) {
    const result = await driver.execute(`SELECT COUNT(*) FROM \`${name}\``, [], "all");
    const row = result.rows[0] as unknown[];
    counts[name] = row[0] as number;
  }
  return counts;
}

/**
 * Builds `meta.json`'s contents by reading this Device's own database
 * (migration ledger, per-table row counts) alongside the caller-supplied
 * identity and clock (`options`) — mirrors ../export/manifest.ts's
 * `buildManifest` in spirit (a small, lossy-by-design summary built
 * alongside the artifact's real payload) but not in shape: `buildManifest`
 * is pure, handed every Entry and Task it describes as plain arguments,
 * because `ExportManifest` duplicates their fields losslessly. This
 * function instead takes the driver directly, because `migration_version`
 * and `row_counts` describe facts about the database as a whole that
 * `database.sql`'s own text already carries — reading them straight from
 * SQL (`highestAppliedMigration`, `countRows`) is simpler and cannot drift
 * from the dump the way a value threaded through several layers of
 * argument-passing could.
 */
export async function buildBackupMeta(
  driver: SqliteDriver,
  options: BuildBackupMetaOptions,
): Promise<BackupMeta> {
  const [migrationVersion, rowCounts] = await Promise.all([
    highestAppliedMigration(driver),
    countRows(driver),
  ]);
  return {
    schema: BACKUP_SCHEMA_VERSION,
    device_id: options.deviceId,
    taken_at: options.takenAt.toISOString(),
    utc_offset: formatUtcOffset(options.utcOffsetMinutes),
    migration_version: migrationVersion,
    row_counts: rowCounts,
  };
}
