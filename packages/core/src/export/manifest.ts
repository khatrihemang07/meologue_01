import type { Task } from "../task-types";
import type { Entry } from "../types";
import { formatUtcOffset } from "./offset";

/**
 * Bumped whenever the manifest's shape changes in a way a reader (or a
 * future importer) needs to know about — issue #175 bumps it from 1 to 2
 * because `tasks`/`task_count` below are new top-level keys, exactly the
 * kind of shape change this comment already asks a bump for.
 */
export const EXPORT_SCHEMA_VERSION = 2;

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

/**
 * A Task (ADR 0047's second root noun), copied field for field — issue
 * #175's own framing: omitting Tasks from a backup is exactly the
 * "quietly omits things" failure ADR 0016 was written to rule out for
 * Entries, and a Task is no less something the user is tracking than an
 * Entry is something they wrote. Unlike `ExportManifestEntry` above,
 * there is no `file` to cite here — a Task has no natural day to land a
 * day file under (this is also why tasks-file.ts groups by Project
 * instead) — so every field here is either a direct, unmodified copy of
 * `Task` (snake_case, matching every other manifest row and the wire/DB
 * column names it already mirrors) or intentionally absent.
 *
 * `deleted_at` is left out on purpose, the same way `ExportManifestEntry`
 * above carries no `deleted_at` of its own: whatever this array is built
 * from is expected to already exclude tombstones (mirroring
 * `EntryStore.list()`'s own "tombstones excluded" contract), so the field
 * would only ever read `null` here — carrying it would imply a state this
 * array structurally cannot represent.
 */
export interface ExportManifestTask {
  id: string;
  device_id: string;
  content: string;
  completed_at: string | null;
  order_key: string;
  created_at: string;
  seq: number | null;
  synced_at: string | null;
  date: string | null;
  deadline: string | null;
  duration: number | null;
  priority: number;
  label_ids: string[];
  date_string: string | null;
  project_id: string | null;
  section_id: string | null;
  parent_id: string | null;
}

export interface ExportManifest {
  schema: number;
  exported_at: string;
  utc_offset: string;
  device_id: string;
  entry_count: number;
  entries: ExportManifestEntry[];
  /** See `ExportManifestTask`'s own doc comment for what's carried and what's deliberately not. */
  task_count: number;
  tasks: ExportManifestTask[];
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
 *
 * `tasks` (issue #175) has no day-file equivalent to disagree with — a
 * Task has no natural day (`ExportManifestTask`'s own doc comment) — so
 * unlike `entries` above there is no lookup that can fail here; every
 * Task passed in is copied through unconditionally, in whatever order the
 * caller supplied.
 */
export function buildManifest(
  entries: Entry[],
  fileForEntry: Map<string, string>,
  tasks: Task[],
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
    task_count: tasks.length,
    tasks: tasks.map((task) => ({
      id: task.id,
      device_id: task.deviceId,
      content: task.content,
      completed_at: task.completedAt,
      order_key: task.orderKey,
      created_at: task.createdAt,
      seq: task.seq,
      synced_at: task.syncedAt,
      date: task.date,
      deadline: task.deadline,
      duration: task.duration,
      priority: task.priority,
      label_ids: task.labelIds,
      date_string: task.dateString,
      project_id: task.projectId,
      section_id: task.sectionId,
      parent_id: task.parentId,
    })),
  };
}
