import type { LocalDayKey, QuickAddToken } from "@meologue/core";
import { firstOccurrence } from "@meologue/core";
import {
  appendWords,
  applyTokenEdits,
  literalDateText,
  literalTimeText,
} from "@/lib/draft-chip-text";
import { resolveRecurrencePhrase } from "@/lib/quick-add-task";

/** `useDraftDateState`'s own return shape — the draft-coupled sibling of `use-task-date-state.ts`'s `TaskDateState`. Every field/method here lines up 1:1 with that interface so `TaskSchedulePopover` can be handed either without caring which. */
export interface DraftDateState {
  /** The draft's own `"date"` token, split into its day component — `null` when none is recognised, or when only a Recurrence is (see `dateString` below). */
  dateDay: string | null;
  /** The draft's own `"time"` token's time-of-day, or `null` when none is recognised. Independent of `dateDay`/`dateString`: a bare `9pm` with no date word still reads back here. */
  dateTime: string | null;
  /** The draft's own `"recurrence"` token, resolved to `../../packages/core/src/quick-add`'s canonical phrase (`resolveRecurrencePhrase`) — `null` when none is recognised. `TaskSchedulePopover`'s own `dateString` prop. */
  dateString: string | null;
  /**
   * Commits a plain day, or `null` to clear the date entirely, by
   * rewriting the draft's own text — never a stored field, per issue
   * #372's D1: choosing a day inserts the literal words
   * (`literalDateText`) at whatever `"date"`/`"recurrence"` token already
   * occupies that role, or appends them if neither does. `null` removes
   * every date-family token's words outright (`"date"`, `"time"` and
   * `"recurrence"` alike — mirrors `TaskSchedulePopover`'s own `onPickDay`
   * contract: "clears the date entirely," the same three kinds
   * `quick-add-dialog.tsx`'s own "Remove date" already strips).
   */
  setScheduleDay: (day: string | null) => void;
  /**
   * Sets or clears the time-of-day, gated on `dateDay` exactly like
   * `useTaskDateState`'s own `setScheduleTime` (that hook's own doc
   * comment: "unreachable through `TaskSchedulePopover`... kept here as
   * the same defensive no-op"). Writes `literalTimeText` at the existing
   * `"time"` token's span, or appends it once a day is set but no time
   * word exists yet.
   */
  setScheduleTime: (time: string | null) => void;
  /**
   * `TaskSchedulePopover`'s own `onPickRecurrence` — commits a Recurrence
   * phrase (already canonical: every caller of this prop hands it one of
   * `resolveSchedulePreview`'s own resolved phrases, never raw typed
   * text). Replaces whatever `"date"`/`"recurrence"` token is already
   * there with the phrase, or appends it. The day argument is accepted
   * only to match `TaskSchedulePopover`'s prop signature — unlike a Task,
   * a draft has nowhere to store a separately-resolved day next to the
   * phrase itself, so it plays no part in what gets written.
   */
  setScheduleRecurrence: (dateString: string, day: string) => void;
}

/**
 * Issue #372's Step 4: `use-task-date-state.ts`'s sibling for the draft
 * surface a future Quick Add composer edits (issue #374 wires this up;
 * this hook only has to exist and be correct on its own). `TaskSchedulePopover`
 * and `TaskTimeDialog` (`task-schedule-popover.tsx`, `task-time-dialog.tsx`)
 * are already prop-driven and Task-free, so nothing about either changes
 * here — only what feeds their `dateDay`/`dateTime`/`dateString` props and
 * what their `onPickDay`/`onSetTime`/`onPickRecurrence` callbacks do.
 *
 * `text`/`tokens` are read, not owned: a caller (the composer) is
 * expected to already have parsed the draft once for its own preview —
 * `quick-add-dialog.tsx`'s own `parsed = parseQuickAdd(composer.value, ...)`
 * is the existing precedent — and hand the identical `tokens` array here
 * rather than this hook re-parsing a second time.
 *
 * `onTextChange` is deliberately a plain `(nextText: string) => void`,
 * not an `EditorView`/ProseMirror transaction: every write this hook
 * makes is a single derived full-text replacement (`applyTokenEdits`/
 * `appendWords`), the identical shape `quick-add-dialog.tsx`'s own
 * "Remove date" already commits through `composer.remount(stripped)`.
 * Whether a caller backs this with a remount or a real `EditorView.
 * dispatch` transaction is that caller's own call — this hook only ever
 * needs to hand back "here is the draft's next full text."
 */
export function useDraftDateState(
  text: string,
  tokens: readonly QuickAddToken[],
  now: LocalDayKey,
  onTextChange: (nextText: string) => void,
): DraftDateState {
  // The identical explicit-per-kind `find` shape `task-schedule-popover.tsx`'s
  // own `resolveSchedulePreview` already uses (a generic `findToken<K>`
  // helper doesn't typecheck here: a type predicate keyed off a generic
  // `K` isn't provably assignable back to the callback's own parameter
  // type, a real TypeScript limitation, not a style choice).
  const dateToken = tokens.find(
    (token): token is Extract<QuickAddToken, { kind: "date" }> => token.kind === "date",
  );
  const timeToken = tokens.find(
    (token): token is Extract<QuickAddToken, { kind: "time" }> => token.kind === "time",
  );
  const recurrenceToken = tokens.find(
    (token): token is Extract<QuickAddToken, { kind: "recurrence" }> => token.kind === "recurrence",
  );

  let dateDay: string | null;
  let dateString: string | null;
  if (recurrenceToken !== undefined) {
    const phrase = resolveRecurrencePhrase(recurrenceToken.raw);
    const outcome = firstOccurrence(phrase, { dueDate: dateToken?.date ?? null, now });
    dateDay = outcome.kind === "occurrence" ? outcome.date : null;
    dateString = phrase;
  } else {
    dateDay = dateToken?.date ?? null;
    dateString = null;
  }
  const dateTime = timeToken?.time ?? null;

  function setScheduleDay(day: string | null) {
    if (day === null) {
      // `token !== undefined` narrows each element to its own already-
      // extracted kind ("date" | "time" | "recurrence"), never to the
      // full `QuickAddToken` union — a predicate declared as the wider
      // union doesn't typecheck against this narrower array's inferred
      // element type.
      const spans: { start: number; end: number; replacement: null }[] = [];
      for (const token of [dateToken, timeToken, recurrenceToken]) {
        if (token !== undefined) {
          spans.push({ start: token.start, end: token.end, replacement: null });
        }
      }
      onTextChange(applyTokenEdits(text, spans));
      return;
    }

    const words = literalDateText(day);
    const edits: { start: number; end: number; replacement: string | null }[] = [];
    // A plain day supersedes any Recurrence already there — mirrors
    // `TaskSchedulePopover`'s own `onPickDay` contract ("a caller is
    // expected to also clear any existing `dateString`"). If a `"date"`
    // token is ALSO present, the new words land on it below and the
    // Recurrence's own span is simply removed; if not, the words replace
    // the Recurrence's span directly, in place.
    if (recurrenceToken !== undefined) {
      edits.push({
        start: recurrenceToken.start,
        end: recurrenceToken.end,
        replacement: dateToken === undefined ? words : null,
      });
    }
    if (dateToken !== undefined) {
      edits.push({ start: dateToken.start, end: dateToken.end, replacement: words });
    }
    if (edits.length === 0) {
      onTextChange(appendWords(text, words));
      return;
    }
    onTextChange(applyTokenEdits(text, edits));
  }

  function setScheduleTime(time: string | null) {
    if (dateDay === null) {
      return;
    }
    if (time === null) {
      if (timeToken === undefined) {
        return;
      }
      onTextChange(
        applyTokenEdits(text, [{ start: timeToken.start, end: timeToken.end, replacement: null }]),
      );
      return;
    }
    const words = literalTimeText(time);
    if (timeToken !== undefined) {
      onTextChange(
        applyTokenEdits(text, [{ start: timeToken.start, end: timeToken.end, replacement: words }]),
      );
      return;
    }
    onTextChange(appendWords(text, words));
  }

  function setScheduleRecurrence(nextDateString: string, _day: string) {
    const edits: { start: number; end: number; replacement: string | null }[] = [];
    // Same "one of the two, in place" shape as `setScheduleDay` above,
    // mirrored: a Recurrence supersedes a plain day, so the new phrase
    // lands wherever the Recurrence token already is if there is one,
    // otherwise wherever the plain date token is.
    if (dateToken !== undefined) {
      edits.push({
        start: dateToken.start,
        end: dateToken.end,
        replacement: recurrenceToken === undefined ? nextDateString : null,
      });
    }
    if (recurrenceToken !== undefined) {
      edits.push({
        start: recurrenceToken.start,
        end: recurrenceToken.end,
        replacement: nextDateString,
      });
    }
    if (edits.length === 0) {
      onTextChange(appendWords(text, nextDateString));
      return;
    }
    onTextChange(applyTokenEdits(text, edits));
  }

  return { dateDay, dateTime, dateString, setScheduleDay, setScheduleTime, setScheduleRecurrence };
}
