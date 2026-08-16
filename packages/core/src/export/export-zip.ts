import { strToU8, zipSync } from "fflate";
import type { Entry } from "../types";
import { groupEntriesIntoDayFiles } from "./day-file";
import { buildManifest } from "./manifest";
import { toLocalParts } from "./offset";

export interface ExportOptions {
  deviceId: string;
  /**
   * The exporting Device's instant this export is taken at — becomes both
   * the manifest's `exported_at` and (rendered through `utcOffsetMinutes`)
   * the filename's timestamp. Injected rather than read via `new Date()` in
   * here, same reasoning as sync-engine.ts's `now` option: it's what makes
   * "exporting twice produces two distinct filenames" a testable claim
   * rather than one that only a real clock can exercise.
   */
  now: Date;
  /**
   * Minutes east of UTC the exporting Device's clock currently reads —
   * `-now.getTimezoneOffset()` on a real Device. Injected, not computed in
   * here, so day grouping stays pure and testable independent of whatever
   * TZ the process happens to run under (this package has no DOM and no
   * Node built-ins; `Date` is the one platform-free clock primitive it
   * already depends on, via `Entry.createdAt`).
   */
  utcOffsetMinutes: number;
}

export interface ExportResult {
  fileName: string;
  bytes: Uint8Array;
}

/** meologue-export-<YYYYMMDD>-<HHMMSS>.zip, in the exporting Device's local time (see ExportOptions). */
export function exportFileName(now: Date, offsetMinutes: number): string {
  const { date, time } = toLocalParts(now.toISOString(), offsetMinutes);
  return `meologue-export-${date.replaceAll("-", "")}-${time.replaceAll(":", "")}.zip`;
}

/**
 * Turns every Entry passed in into zip bytes: one `entries/<YYYY-MM-DD>.txt`
 * per local day plus a lossless `manifest.json` (day-file.ts, manifest.ts).
 * Pure and platform-free — no DOM, no Node built-ins — so it's exercised
 * directly by unit tests; only delivering the resulting bytes to disk is
 * platform-specific (`@/platform/save-file` in apps/web).
 *
 * `entries` is expected to be every Entry the store holds
 * (`EntryStore.list()`), never a search-narrowed subset — a backup that
 * silently omits things is worse than none, so this function has no
 * filtering parameter for a caller to accidentally pass one through.
 */
export function exportEntriesToZip(entries: Entry[], options: ExportOptions): ExportResult {
  const { deviceId, now, utcOffsetMinutes } = options;
  const { files, fileForEntry } = groupEntriesIntoDayFiles(entries, utcOffsetMinutes);
  const manifest = buildManifest(entries, fileForEntry, {
    deviceId,
    exportedAt: now.toISOString(),
    offsetMinutes: utcOffsetMinutes,
  });

  const zipInput: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
  };
  for (const file of files) {
    zipInput[file.path] = strToU8(file.contents);
  }

  return {
    fileName: exportFileName(now, utcOffsetMinutes),
    bytes: zipSync(zipInput),
  };
}
