import type { Entry } from "../types";
import { formatUtcOffset, toLocalParts } from "./offset";

export interface DayFile {
  /** entries/<YYYY-MM-DD>.txt, relative to the zip root. */
  path: string;
  contents: string;
}

export interface DayFileGrouping {
  /** One per local day that has at least one Entry, sorted oldest day first. */
  files: DayFile[];
  /** Entry id -> the `path` of the DayFile it landed in, for the manifest (manifest.ts) to cite. */
  fileForEntry: Map<string, string>;
}

/**
 * Groups Entries by the exporting Device's local day — not UTC, see the
 * export ADR — and renders each day's plain-text file, oldest Entry first
 * per day (journal reading order, deliberately the reverse of History).
 *
 * Entry bodies are only ever trimmed, never reflowed (entry-text.ts), so
 * they keep their own newlines — nothing may share a line with a body, which
 * is why each Entry gets a `[HH:MM:SS]` header on its own line rather than a
 * prefix on the body's first line. Bodies are placed verbatim: this file
 * never edits, escapes, or truncates one, which is exactly what makes a body
 * that happens to *contain* a line shaped like `[11:42:03]` ambiguous on
 * read-back — manifest.ts carries the lossless copy for that reason.
 */
export function groupEntriesIntoDayFiles(entries: Entry[], offsetMinutes: number): DayFileGrouping {
  const offsetLabel = formatUtcOffset(offsetMinutes);

  // entries arrives newest-first (EntryStore.list()); walking it in reverse
  // visits Entries oldest-first, and since each day's bucket only ever grows
  // by push(), that's also the order each bucket ends up in.
  const byDate = new Map<string, Entry[]>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) {
      continue;
    }
    const { date } = toLocalParts(entry.createdAt, offsetMinutes);
    const bucket = byDate.get(date);
    if (bucket) {
      bucket.push(entry);
    } else {
      byDate.set(date, [entry]);
    }
  }

  const files: DayFile[] = [];
  const fileForEntry = new Map<string, string>();
  for (const [date, dayEntries] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const path = `entries/${date}.txt`;
    files.push({ path, contents: renderDayFile(date, offsetLabel, offsetMinutes, dayEntries) });
    for (const entry of dayEntries) {
      fileForEntry.set(entry.id, path);
    }
  }

  return { files, fileForEntry };
}

function renderDayFile(
  date: string,
  offsetLabel: string,
  offsetMinutes: number,
  dayEntries: Entry[],
): string {
  const lines = [`# ${date}  (times in ${offsetLabel})`, ""];
  for (const entry of dayEntries) {
    const { time } = toLocalParts(entry.createdAt, offsetMinutes);
    lines.push(`[${time}]`);
    lines.push(entry.body);
    lines.push("");
  }
  return lines.join("\n");
}
