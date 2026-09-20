import { format } from "date-fns";
import { parseDayKey } from "@/lib/local-day-key";

/**
 * The literal words a date chip writes into the draft for a picked day
 * (issue #372, D1: "the title text is the single source of truth" — a
 * date chip's picker inserts words, it never sets hidden metadata). `d
 * MMM yyyy` (e.g. "25 Dec 2026") rather than an ISO day, because it has
 * to read back as an ordinary match: `../../packages/core/src/quick-add/
 * date-rules.ts`'s `matchAbsoluteDate` only recognises a day-first form
 * with a digit day, a month NAME, and an optional four-digit year — never
 * a hyphenated `YYYY-MM-DD`. The year is always included, even though
 * that same rule accepts a yearless "25 Dec" too, because a yearless date
 * rolls forward to whichever of this year/next year is soonest
 * (`resolveYearRollForward`) — leaving it out here would silently change
 * meaning the moment the picked day crosses that roll-forward boundary.
 */
export function literalDateText(day: string): string {
  // biome-ignore lint/style/noNonNullAssertion: `day` always reaches here as a well-formed `YYYY-MM-DD` — every caller gets it from a picker's own selection (`localDayKey`'s construction) or from `firstOccurrence`'s own resolved date, never typed free-hand.
  return format(parseDayKey(day)!, "d MMM yyyy");
}

/**
 * The literal words a time chip writes for a picked time-of-day. `time`
 * is already `HH:MM` (`../../packages/core/src/task-types.ts`'s own
 * floating encoding), which is also, unchanged, one of `date-rules.ts`'s
 * `matchExplicitTime` forms (`twentyFourHour`) — so this is the identity
 * function, named and exported anyway so every draft chip's "what do I
 * write" lives in this one file rather than one of them reading its
 * value straight through and the others not.
 */
export function literalTimeText(time: string): string {
  return time;
}

/**
 * The literal words a priority chip writes — `p1`-`p4`, matching
 * `../../packages/core/src/quick-add/rules.ts`'s own `matchPriority`
 * regex (`\bp([1-4])\b`) exactly. `uiPriority` here is already the UI
 * number (1 most urgent), never the inverted stored value — the same
 * convention `priority-sheet-content.tsx`'s own `onSelect` prop uses.
 */
export function literalPriorityText(uiPriority: number): string {
  return `p${uiPriority}`;
}

/** One span of `text` to rewrite — `replacement: null` deletes the span outright, matching `quick-add-dialog.tsx`'s own `stripDateTokens` for "Remove date" (issue #372's sibling operation, one direction back). */
export interface TokenEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string | null;
}

/**
 * Applies every edit to `text` in one pass, sorted by descending `start`
 * so an earlier (later-in-string) edit's own removal/replacement never
 * shifts a still-unapplied edit's offsets — the identical reason
 * `quick-add-dialog.tsx`'s own `stripDateTokens` sorts its spans
 * backwards before splicing. Collapses whitespace once, at the end,
 * matching every other span-to-text rewrite in this codebase
 * (`stripDateTokens`, `quick-add-task.ts`'s `contentKeepingUnsupported`).
 */
export function applyTokenEdits(text: string, edits: readonly TokenEdit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let result = text;
  for (const edit of sorted) {
    result = result.slice(0, edit.start) + (edit.replacement ?? "") + result.slice(edit.end);
  }
  return result.replace(/\s+/g, " ").trim();
}

/** Appends `words` to `text` — a single trailing space when `text` already carries content, none when it's empty (or whitespace-only), so a chip's first pick on a blank draft doesn't leave a leading space behind. */
export function appendWords(text: string, words: string): string {
  const trimmed = text.trim();
  return trimmed === "" ? words : `${trimmed} ${words}`;
}
