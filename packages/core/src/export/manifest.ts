import type { Entry } from "../types";
import { formatUtcOffset } from "./offset";

/** Bumped whenever the manifest's shape changes in a way a reader (or a future importer) needs to know about. */
export const EXPORT_SCHEMA_VERSION = 1;

export interface ExportManifestEntry {
  id: string;
  device_id: string;
  created_at: string;
  seq: number | null;
  synced_at: string | null;
  /** The DayFile path (day-file.ts) this Entry's human-readable copy landed in. */
  file: string;
  body: string;
}

export interface ExportManifest {
  schema: number;
  exported_at: string;
  utc_offset: string;
  device_id: string;
  entry_count: number;
  entries: ExportManifestEntry[];
}

export interface BuildManifestOptions {
  deviceId: string;
  exportedAt: string;
  offsetMinutes: number;
}

/**
 * The lossless copy the day files (day-file.ts) can't be: a day file's
 * `[HH:MM:SS]` header line is ambiguous with a body that happens to contain
 * a line shaped like one, so every Entry's full metadata and its body —
 * verbatim, the same bytes the day file got — round-trip through here
 * regardless of what its day file looks like. Duplicating bodies costs
 * almost nothing under deflate and is what makes a future import exact with
 * no format change (see the export ADR).
 */
export function buildManifest(
  entries: Entry[],
  fileForEntry: Map<string, string>,
  options: BuildManifestOptions,
): ExportManifest {
  return {
    schema: EXPORT_SCHEMA_VERSION,
    exported_at: options.exportedAt,
    utc_offset: formatUtcOffset(options.offsetMinutes),
    device_id: options.deviceId,
    entry_count: entries.length,
    entries: entries.map((entry) => {
      const file = fileForEntry.get(entry.id);
      if (!file) {
        // Every Entry passed to exportEntriesToZip is grouped into exactly
        // one day file first (export-zip.ts) — this only fires if that
        // invariant is ever broken by a future edit.
        throw new Error(`export: no day file recorded for Entry ${entry.id}`);
      }
      return {
        id: entry.id,
        device_id: entry.deviceId,
        created_at: entry.createdAt,
        seq: entry.seq,
        synced_at: entry.syncedAt,
        file,
        body: entry.body,
      };
    }),
  };
}
