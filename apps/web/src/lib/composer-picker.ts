/**
 * The inline `[[` picker's pure logic (issue #144), extracted out of
 * composer.tsx by issue #155 so it can be unit-tested directly rather than
 * only through a rendered `<textarea>`.
 *
 * Before issue #155 this all lived in composer.tsx and was driven by a
 * `<textarea>`'s own `value`/`selectionStart` — a plain string and a caret
 * index, both native DOM concepts `fireEvent.change` could simulate in
 * jsdom. The Composer now holds a ProseMirror document instead, and jsdom
 * has no `Range`/`Selection` to drive real caret behaviour against a
 * `contenteditable` (see composer.tsx's own module comment). Rather than
 * rewrite this logic to understand a `Node`/`Selection`, composer.tsx's own
 * ProseMirror plugin (composer-editor.ts) reconstructs the same
 * "flat text plus a caret index" shape `derivePicker` always expected —
 * the current textblock's own text, with each inline atom (a Reference)
 * standing in for one character so position arithmetic between the two
 * stays 1:1 — and hands it to the exact same function below, unchanged.
 * That is what keeps this module a pure, ProseMirror-agnostic port rather
 * than a rewrite: everything here still only knows about strings and
 * indices, never about a `Node` or a `Selection`.
 */
import type { Entry } from "@meologue/core";
import { entryDayKey } from "@/lib/entry-day";
import { parseReferenceDate } from "@/lib/inline-markdown";

/**
 * The two brackets that open a Reference (ADR 0042) — this file's own copy
 * of the literal `inline-markdown.ts`'s `referenceParser` looks for, kept
 * here rather than imported because that file exports no such constant
 * (its own scanner reads character codes, not a string) and this is the
 * only other place that needs it.
 */
export const REFERENCE_TRIGGER = "[[";

/** How many recent days, and how many searched Entries, the picker shows at once — enough to be useful, small enough to stay a glance rather than a second History. */
export const MAX_DATE_SUGGESTIONS = 5;
export const MAX_ENTRY_SUGGESTIONS = 5;

/**
 * Where the inline `[[` picker (issue #144) is anchored, and what it's
 * currently narrowed to.
 *
 * `start` is the index in `text` immediately AFTER the triggering `[[` —
 * everything from there to the caret is `query`. Recomputed from scratch on
 * every keystroke (`derivePicker` below) rather than patched incrementally:
 * the alternative is a state machine that has to separately handle typing,
 * backspacing past the brackets, and the caret moving away, and deriving it
 * fresh from `text` and the caret position is what makes all three the
 * same code path instead of three.
 */
export interface ReferencePickerState {
  start: number;
  query: string;
}

/**
 * `query` narrows to dates when it could still become a valid
 * `[[YYYY-MM-DD]]` — digits and dashes only, including the empty string
 * (freshly typed `[[`, before anything narrows it either way) — and to an
 * Entry search otherwise. There is no third "ambiguous" state: the moment a
 * letter or space appears, the query cannot be a date any more (`parseReferenceDate`
 * demands exactly four digits, a dash, two digits, a dash, two digits), so
 * a query that will only ever describe an Entry search is exactly the
 * complement of this.
 */
export function isDateModeQuery(query: string): boolean {
  return /^[0-9-]*$/.test(query);
}

/**
 * The picker's own state transition, given the current textblock's flat
 * text and caret position. Pure and stateless on purpose — keeping every
 * rule here (rather than split across change, keydown and a closing
 * effect/plugin) is what makes "when is the picker open" answerable by
 * reading one function.
 *
 * - No picker yet: opens one exactly when the two characters immediately
 *   before the caret are the trigger — "immediately after a freshly typed
 *   `[[`", per the ticket, not merely "a `[[` exists somewhere earlier in
 *   the line".
 * - A picker already open: stays open only while the caret is still at or
 *   after `start` AND the two characters immediately before `start` are
 *   still the trigger — either condition failing means the reader moved
 *   the caret away or backspaced through one of the brackets, and the
 *   picker has nothing left to be anchored to.
 * - A query that picks up a `]` or a newline closes the picker without
 *   opening a new one: a `]` means the reader is closing the mark by hand
 *   (typing `]]` themselves is always still possible; the picker simply
 *   stops shadowing it), and a newline means whatever was being typed
 *   inside the brackets was abandoned for a new line of prose.
 */
export function derivePicker(
  text: string,
  caret: number,
  previous: ReferencePickerState | null,
): ReferencePickerState | null {
  if (previous === null) {
    if (caret >= 2 && text.slice(caret - 2, caret) === REFERENCE_TRIGGER) {
      return { start: caret, query: "" };
    }
    return null;
  }
  if (
    caret < previous.start ||
    text.slice(previous.start - 2, previous.start) !== REFERENCE_TRIGGER
  ) {
    return null;
  }
  const query = text.slice(previous.start, caret);
  if (query.includes("]") || query.includes("\n")) {
    return null;
  }
  return { start: previous.start, query };
}

/**
 * Candidate days for the picker's date mode: the typed text itself, if it's
 * already a complete, real calendar date (`parseReferenceDate` — the exact
 * same validator the renderer uses, so nothing the picker offers could ever
 * render as a dead Reference later), followed by whichever of the loaded
 * recent Entries' own days contain the typed digits, newest first and
 * de-duplicated. With an empty query every recent day qualifies, which is
 * "offer recent days" for the picker's very first frame, right after `[[`.
 */
export function buildDateSuggestions(
  query: string,
  recentEntries: readonly Entry[],
  offsetMinutes: number,
): string[] {
  const suggestions: string[] = [];
  const seen = new Set<string>();

  const typed = parseReferenceDate(query);
  if (typed !== null) {
    suggestions.push(typed);
    seen.add(typed);
  }

  for (const candidate of recentEntries) {
    if (suggestions.length >= MAX_DATE_SUGGESTIONS) {
      break;
    }
    const day = entryDayKey(candidate.createdAt, offsetMinutes);
    if (day === null || seen.has(day)) {
      continue;
    }
    if (query !== "" && !day.includes(query)) {
      continue;
    }
    seen.add(day);
    suggestions.push(day);
  }

  return suggestions;
}

export type PickerItem = { kind: "date"; date: string } | { kind: "entry"; entry: Entry };

export function pickerItemKey(item: PickerItem): string {
  return item.kind === "date" ? `date:${item.date}` : `entry:${item.entry.id}`;
}

export function pickerItemMark(item: PickerItem): string {
  // `[[YYYY-MM-DD]]` and `[[e:<id>]]` (ADR 0042) — built here rather than
  // imported, since inline-markdown.ts has no reason to export a
  // constructor for the marks it only ever parses.
  return item.kind === "date" ? `[[${item.date}]]` : `[[e:${item.entry.id}]]`;
}
