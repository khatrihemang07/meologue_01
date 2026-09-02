import type { DateRuleContext } from "./date-rules";
import {
  matchAbsoluteDate,
  matchArithmeticDate,
  matchExplicitTime,
  matchFuzzyTime,
  matchRecurrenceWord,
  matchRelativeDate,
  matchWeekday,
  matchWeekdayArithmeticCombo,
} from "./date-rules";
import { englishQuickAddLanguage } from "./en";
import {
  matchDeadline,
  matchDescription,
  matchLabel,
  matchPriority,
  matchProject,
  matchReminder,
  matchSection,
  matchUncompletable,
} from "./rules";
import type { QuickAddOptions, QuickAddResult, QuickAddSpan, QuickAddToken } from "./types";

/**
 * The quick-add parser's entry point (issue #170's Part A). Turns raw
 * add-field text into a QuickAddResult: every recognised token with its
 * exact source offsets, and the structured fields a caller builds a Task
 * from.
 *
 * **Recognition priority, and why it's a plain push order rather than a
 * numeric priority field.** Candidates from every active rule are
 * collected into one list, then accepted greedily in list order: the
 * first candidate to claim a span wins it, and any later candidate that
 * overlaps an already-claimed span is dropped. The list below is built
 * sigil-family first (unconditionally — see ./types.ts's
 * `QuickAddTokenKind` doc comment for why those carry no false-positive
 * risk to arbitrate away), then, if `smartDates`, the eager family with
 * its own compound-before-simple ordering (`monday in 2 weeks` before
 * plain `monday` and plain `in 2 weeks`, so the longer, more specific
 * match wins the words it needs rather than being shadowed by two
 * shorter ones that fire first). A numeric `priority` field on each rule
 * would say the identical thing with one more layer of indirection; the
 * order candidates are pushed in *is* the priority, and reading this
 * function top to bottom is reading the priority order directly.
 */
export function parseQuickAdd(input: string, options: QuickAddOptions): QuickAddResult {
  const language = options.language ?? englishQuickAddLanguage;
  const smartDates = options.smartDates ?? true;
  const demoted = options.demoted ?? [];
  const { now } = options;
  const dateCtx: DateRuleContext = { language, now };

  const candidates = collectCandidates(input, dateCtx, smartDates);
  const tokens = resolveOverlaps(candidates, demoted);

  return buildResult(input, tokens, now);
}

/**
 * Re-parses `input` with one more span added to the demoted list — "this
 * recognised span is plain text after all" (issue #170's Part A brief).
 * A full re-derivation, not a patch: splicing a demoted token's `raw`
 * back into `content` by hand would also have to know whether any other
 * token's boundaries shifted as a result (they don't, here, since spans
 * never move — but a caller has no way to know that without re-running
 * the same reasoning this function already does), so re-running
 * parseQuickAdd is the one thing that's guaranteed to reflect a demotion
 * correctly rather than merely usually.
 */
export function demoteQuickAddToken(
  input: string,
  token: QuickAddToken,
  options: QuickAddOptions,
): QuickAddResult {
  const span: QuickAddSpan = { start: token.start, end: token.end };
  return parseQuickAdd(input, { ...options, demoted: [...(options.demoted ?? []), span] });
}

// `smartDates` gates only the eager/natural-language family below —
// `matchDeadline`/`matchReminder` above are sigil-marked (./rules.ts's
// own header comment) and always run, both here and inside this
// function's own call from parseQuickAdd.
function collectCandidates(
  input: string,
  dateCtx: DateRuleContext,
  smartDates: boolean,
): QuickAddToken[] {
  const candidates: QuickAddToken[] = [
    ...matchUncompletable(input),
    ...matchDescription(input),
    ...matchProject(input),
    ...matchSection(input),
    ...matchLabel(input),
    ...matchPriority(input),
    ...matchDeadline(input, dateCtx),
    ...matchReminder(input, dateCtx),
  ];
  if (smartDates) {
    candidates.push(
      ...matchWeekdayArithmeticCombo(input, dateCtx),
      ...matchAbsoluteDate(input, dateCtx),
      ...matchRelativeDate(input, dateCtx),
      ...matchWeekday(input, dateCtx),
      ...matchArithmeticDate(input, dateCtx),
      ...matchExplicitTime(input, dateCtx),
      ...matchFuzzyTime(input, dateCtx),
      ...matchRecurrenceWord(input, dateCtx),
    );
  }
  return candidates;
}

function overlaps(a: QuickAddSpan, b: QuickAddSpan): boolean {
  return a.start < b.end && b.start < a.end;
}

function isDemoted(token: QuickAddToken, demoted: readonly QuickAddSpan[]): boolean {
  return demoted.some((span) => span.start === token.start && span.end === token.end);
}

// Greedy interval scheduling over `candidates`, in the priority order
// they were pushed in (parseQuickAdd's own header comment explains why
// that order, not a numeric field, carries the priority). A demoted
// candidate is skipped before the overlap check, not after: a demoted
// span must never block a *different* token from being recognised over
// the same text on a later parse (say, the user demoted a date, and now
// wants to add a project tag over part of that same span) — the demoted
// span simply stops competing, it doesn't reserve the text as untouchable.
function resolveOverlaps(
  candidates: QuickAddToken[],
  demoted: readonly QuickAddSpan[],
): QuickAddToken[] {
  const accepted: QuickAddToken[] = [];
  for (const candidate of candidates) {
    if (isDemoted(candidate, demoted)) {
      continue;
    }
    if (accepted.some((a) => overlaps(a, candidate))) {
      continue;
    }
    accepted.push(candidate);
  }
  accepted.sort((a, b) => a.start - b.start);
  return accepted;
}

function buildResult(input: string, tokens: QuickAddToken[], now: string): QuickAddResult {
  let date: string | null = null;
  let time: string | null = null;
  let deadline: string | null = null;
  let priority = 1;
  let projectName: string | null = null;
  let sectionName: string | null = null;
  const labelNames: string[] = [];
  let reminderTime: string | null = null;
  let uncompletable = false;
  let description: string | null = null;

  // "Last one wins" for every single-valued field — a second `#project`
  // or a second explicit time later in the same input overrides the
  // first, matching how re-typing a value normally works, rather than
  // "first wins" silently locking in whatever was typed earliest.
  for (const token of tokens) {
    switch (token.kind) {
      case "date":
        date = token.date;
        break;
      case "time":
        time = token.time;
        break;
      case "deadline":
        deadline = token.deadline;
        break;
      case "priority":
        priority = token.priority;
        break;
      case "project":
        projectName = token.name;
        break;
      case "section":
        sectionName = token.name;
        break;
      case "label":
        labelNames.push(token.name);
        break;
      case "reminder":
        reminderTime = token.time;
        break;
      case "uncompletable":
        uncompletable = true;
        break;
      case "description":
        description = token.text;
        break;
      case "recurrence":
        // Flagged only — see ./date-rules.ts's matchRecurrenceWord doc
        // comment for why this parser stops at recognition.
        break;
    }
  }

  return {
    input,
    tokens,
    content: buildContent(input, tokens),
    date: mergeDateAndTime(date, time, now),
    deadline,
    priority,
    projectName,
    sectionName,
    labelNames,
    reminderTime,
    uncompletable,
    description,
  };
}

// A lone `time` token with no `date` token attaches to *today* — "5pm"
// typed alone means "today at 5pm" (this module's own required test
// table has the worked case). Merging happens here, once, rather than
// each date-family rule having to know whether a time rule also fired
// elsewhere in the same input.
function mergeDateAndTime(date: string | null, time: string | null, now: string): string | null {
  if (time === null) {
    return date;
  }
  const day = date === null ? now.slice(0, 10) : date.slice(0, 10);
  return `${day}T${time}`;
}

// Removes every accepted token's `[start, end)` span from `input`,
// collapsing the surrounding whitespace to single spaces and trimming —
// what's left is `Task.content`. Built once, here, from the same span
// list `tokens` already carries (this module's own header comment on
// QuickAddResult.content explains why the UI must never re-derive this
// by searching `input` on its own).
function buildContent(input: string, tokens: readonly QuickAddSpan[]): string {
  let result = "";
  let cursor = 0;
  for (const token of tokens) {
    result += input.slice(cursor, token.start);
    cursor = token.end;
  }
  result += input.slice(cursor);
  return result.replace(/\s+/g, " ").trim();
}
