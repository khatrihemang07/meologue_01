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

/**
 * ADR 0069/issue #234's normalization boundary. Two spellings the Composer
 * writes are Composer-internal, never meant to leak into a plain-text
 * surface outside the app: a soft break's own GFM backslash hard break
 * (`\` immediately followed by `\n`, `insertSoftBreak`/`walkEntryInline`'s
 * own encoding, composer-commands.ts / inline-markdown.ts) and a
 * Tab-inserted U+2003 EM SPACE (`insertEmSpace`, composer-commands.ts).
 * `renderDayFile` (below) keeps a body's own newlines rather than
 * reflowing it into one flattened line (this file's own module comment on
 * why) — the day file is meant to read like the journal, not like a
 * search-result snippet — so it cannot route through a block parser the
 * way `entrySnippet` (entry-row.tsx) does; this is what a lower-level seam
 * that only strips the two markers themselves, character by character,
 * gives it instead. A `\` + `\n` becomes a bare `\n` (the visual line
 * break survives, only the backslash goes); a ` ` becomes an ordinary
 * space. Every other character, including a body's own genuine `\n\n`
 * block break, passes through untouched.
 *
 * This is a best-effort, character-level guard, not a parse: it cannot
 * distinguish a genuine soft break from the rare case of a body whose own
 * typed text ends a line with an escaped literal backslash (serialized as
 * `\\`, ADR-unrelated) immediately followed by a real block break — that
 * one character sequence reads the same at this level as a soft break, and
 * this function strips it the same way. Accepted rather than solved here:
 * a correct disambiguation needs `parseEntryMarkdown`'s own parser
 * (inline-markdown.ts), which this package does not, and should not,
 * depend on (ADR 0043's own layering).
 */
export function normalizeBodyForPlainText(body: string): string {
  return body.replace(/\\\n/g, "\n").replace(/ /g, " ");
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
    lines.push(normalizeBodyForPlainText(entry.body));
    lines.push("");
  }
  return lines.join("\n");
}
