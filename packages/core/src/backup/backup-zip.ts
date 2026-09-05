import { strToU8, zipSync } from "fflate";
import { toLocalParts } from "../export/offset";
import type { SqliteDriver } from "../sqlite/driver";
import { dumpDatabase } from "./dump";
import { buildBackupMeta } from "./meta";

export interface BackupOptions {
  deviceId: string;
  /** See ../export/export-zip.ts's `ExportOptions.now` doc comment — the identical reasoning applies verbatim: injected rather than read via `new Date()` in here, so "two Backups a second apart get two distinct filenames" is testable without a real clock. */
  now: Date;
  /** See ../export/export-zip.ts's `ExportOptions.utcOffsetMinutes` doc comment — the identical reasoning applies verbatim: this package has no DOM and no host-timezone API, so the caller supplies the offset explicitly. */
  utcOffsetMinutes: number;
}

export interface BackupResult {
  fileName: string;
  bytes: Uint8Array;
}

/** meologue-backup-<YYYYMMDD>-<HHMMSS>.zip, in the Device's local time (see BackupOptions) — built with ../export/offset.ts's `toLocalParts`, reused rather than reimplemented, the same function ../export/export-zip.ts's `exportFileName` already calls. `meologue-backup-`, not `meologue-export-`: the two artifacts sit beside each other in a Downloads folder, and the prefix is the only thing that tells them apart at a glance. */
export function backupFileName(now: Date, offsetMinutes: number): string {
  const { date, time } = toLocalParts(now.toISOString(), offsetMinutes);
  return `meologue-backup-${date.replaceAll("-", "")}-${time.replaceAll(":", "")}.zip`;
}

/**
 * Turns this Device's whole database into a Backup's zip bytes (issue #195,
 * CONTEXT.md's Backup entry) — `database.sql` (`dump.ts`'s `dumpDatabase`,
 * a lossless SQL dump of every table but the search indexes),
 * `settings.json` (`settings`, verbatim — see this function's own
 * parameter doc comment) and `meta.json` (`meta.ts`'s `buildBackupMeta`).
 * Pure and platform-free — no DOM, no Node built-ins — the same posture
 * ../export/export-zip.ts's `exportEntriesToZip` documents for the
 * identical reason: only delivering the resulting bytes to disk is
 * platform-specific (`@/platform/save-file` in apps/web), so this function
 * itself is exercised directly by unit tests against a real
 * `NodeSqliteDriver` (../sqlite/node-driver.ts).
 *
 * `dumpDatabase` and `buildBackupMeta` are awaited one after the other,
 * deliberately not run concurrently via `Promise.all`: both only read, so
 * nothing here needs a transaction (ADR 0007's own no-transaction
 * reasoning), but a `SqliteDriver` is not guaranteed to tolerate two
 * `execute` calls in flight against the same connection at once —
 * `TauriSqliteDriver` (apps/web/src/platform/tauri-sqlite-driver.ts) runs
 * every statement through a connection pool with no transaction API, and
 * nothing in that seam's own contract (../sqlite/driver.ts) promises safe
 * interleaving. Sequential is simple, always correct, and the row counts
 * `buildBackupMeta` computes are cheap `SELECT COUNT(*)` queries next to
 * `dumpDatabase`'s own full read of every row, so there is no real
 * concurrency to give up.
 *
 * @param settings Every `meologue.*` device setting (apps/web/src/lib/
 * settings.ts), collected by the caller and passed in as a plain
 * `Record<string, string>` — `packages/core` has no `localStorage` to read
 * these from itself (ADR 0008 keeps device settings outside the Entry
 * store entirely), so Settings gathers them and hands them over the same
 * way it already hands over `deviceId` via `options` below. Carried
 * verbatim, with no validation and no schema: a Backup's job is to be a
 * faithful copy of what this Device already has, not to judge it.
 */
export async function createBackup(
  driver: SqliteDriver,
  settings: Record<string, string>,
  options: BackupOptions,
): Promise<BackupResult> {
  const databaseSql = await dumpDatabase(driver);
  const meta = await buildBackupMeta(driver, {
    deviceId: options.deviceId,
    takenAt: options.now,
    utcOffsetMinutes: options.utcOffsetMinutes,
  });

  const zipInput: Record<string, Uint8Array> = {
    "database.sql": strToU8(databaseSql),
    "settings.json": strToU8(JSON.stringify(settings, null, 2)),
    "meta.json": strToU8(JSON.stringify(meta, null, 2)),
  };

  return {
    fileName: backupFileName(options.now, options.utcOffsetMinutes),
    bytes: zipSync(zipInput),
  };
}
