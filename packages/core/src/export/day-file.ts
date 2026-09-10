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
 * U+2003 EM SPACE, spelled as an escape rather than as the literal character.
 * The Rust mirror of this function (`normalize_body_for_plain_text`,
 * server/src/harness/tools/mod.rs) already spells it `\u{2003}`; writing the
 * raw glyph here instead made the two halves of one rule look unrelated, and
 * left a byte that is indistinguishable from an ordinary space in a diff — so
 * an innocent "collapse the double space" edit could delete the rule without
 * anyone seeing it go.
 */
const EM_SPACE = "\u2003";

/**
 * U+00A0 NO-BREAK SPACE, spelled as an escape for the identical
 * diff-visibility reason `EM_SPACE` above is. This is the blank-line
 * marker `entryDocumentToMarkdown` (apps/web/src/lib/entry-document.ts,
 * issue #239/ADR 0069) writes for a deliberately blank line: a paragraph
 * sitting between two others whose entire text content is this one
 * character and nothing else — the Composer's own shape for `alpha` Enter
 * Enter `bravo`. This package does not, and should not, depend on the web
 * client's own module (ADR 0043's own layering, restated in
 * `normalizeBodyForPlainText`'s own comment below), so the character is
 * duplicated here rather than imported, the same way this file already
 * duplicates the soft-break/em-space encoding instead of reaching into
 * `apps/web`.
 */
const BLANK_LINE_MARKER = "\u00A0";

/**
 * ADR 0069/issue #234/#239's normalization boundary. Three spellings the Composer
 * writes are Composer-internal, never meant to leak into a plain-text
 * surface outside the app: a soft break's own GFM backslash hard break
 * (`\` immediately followed by `\n`, `insertSoftBreak`/`walkEntryInline`'s
 * own encoding, composer-commands.ts / inline-markdown.ts) and a
 * Tab-inserted U+2003 EM SPACE (`insertEmSpace`, composer-commands.ts), and
 * — issue #239 — a deliberately blank line's own U+00A0 marker
 * (`BLANK_LINE_MARKER` above). `renderDayFile` (below) keeps a body's own newlines rather than
 * reflowing it into one flattened line (this file's own module comment on
 * why) — the day file is meant to read like the journal, not like a
 * search-result snippet — so it cannot route through a block parser the
 * way `entrySnippet` (entry-row.tsx) does; this is what a lower-level seam
 * that only strips the markers themselves, character by character,
 * gives it instead. A `\` + `\n` becomes a bare `\n` (the visual line
 * break survives, only the backslash goes); a ` ` becomes an ordinary
 * space. Every other character, including a body's own genuine `\n\n`
 * block break, passes through untouched.
 *
 * The blank-line marker becomes an actual empty line, not a single
 * space, and never a blanket substitution of every U+00A0 the body might
 * contain: a person can legitimately type a no-break space in the middle
 * of a sentence (a unit like `10 km`, say), and replacing every
 * occurrence the way `EM_SPACE`'s own substitution does would silently
 * delete that character everywhere it appears, real content lost with no
 * way to tell it apart from the marker afterward. This rule is scoped to
 * a whole line: the body is split into lines at each newline character,
 * and only a line whose ENTIRE content is the marker and nothing else —
 * no other character beside it, not even surrounding spaces — becomes
 * empty. A blank paragraph in storage is exactly that shape
 * (`entryDocumentToMarkdown` never writes the marker beside other text
 * on its own line, only alone, the same way `isBlankLineMarker`,
 * entry-document.ts, only ever reads it back that way), so this cannot
 * mistake a sentence containing the marker for a blank line — the
 * marker would need to be the line's ONLY character, which a sentence
 * around it never is. A blank line becoming an empty line reads, once
 * printed (surrounded by the body's own block-break separators either
 * side of it), exactly like the visible gap it was in the Composer —
 * whereas turning it into a literal single space sitting alone on its
 * own line would leave a line of trailing whitespace, indistinguishable
 * on the page from nothing at all but a strange thing for a plain-text
 * export to contain on purpose.
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
  const withoutSoftBreaksAndEmSpaces = body.replace(/\\\n/g, "\n").split(EM_SPACE).join(" ");
  return withoutSoftBreaksAndEmSpaces
    .split("\n")
    .map((line) => (line === BLANK_LINE_MARKER ? "" : line))
    .join("\n");
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
