import { parseRecurrence } from "../recurrence";
import {
  addDays,
  addMonths,
  addYears,
  formatDate,
  formatTime,
  isoWeekday,
  parseDateOnly,
} from "./date-math";
import type { QuickAddLanguage } from "./language";
import type { QuickAddToken } from "./types";

/**
 * The eager/natural-language date-and-time rules (issue #170's Part A) —
 * every one of these is a candidate ../parse-quick-add.ts only runs when
 * `smartDates` is true, because every one of them infers meaning from
 * ordinary words with no marker the user typed on purpose. `{deadline}`
 * (./rules.ts) reuses `matchDateForms` below rather than a second copy of
 * this grammar, via `resolveWholePhrase` — see that function's own doc
 * comment.
 */

export interface DateRuleContext {
  language: QuickAddLanguage;
  /** Floating `YYYY-MM-DD`(`T`...) reference instant — see QuickAddOptions.now's own doc comment. */
  now: string;
}

/** Escapes a string for literal use inside a `RegExp` — every word table entry passes through this before joining into an alternation, since a language pack's own words aren't this module's to assume are regex-safe. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function alternation(words: readonly string[]): string {
  // Longest-first: with `\b` on both ends of the alternation this isn't
  // needed for correctness (a boundary after "jun" won't fire inside
  // "june"), but keeping the ordering explicit means a future word table
  // that reuses this helper without `\b` wrapping doesn't inherit a
  // silent shortest-match bug.
  return [...words]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
}

function pushIfValidCalendarDate(
  tokens: QuickAddToken[],
  match: RegExpExecArray,
  year: number,
  month: number,
  day: number,
): void {
  if (day < 1 || day > 31) {
    return; // Not a calendar day at all — see this file's header comment on why an invalid match is silently skipped rather than "corrected".
  }
  const date = formatDate({ year, month, day });
  // formatDate normalises an out-of-range day forward into the next
  // month (Date.UTC's own rollover, e.g. 30 Feb -> 2 Mar) — checked here
  // by re-parsing the result, so "30 Feb" is refused as unrecognised
  // rather than silently becoming a different month the user never typed.
  if (parseDateOnly(date).month !== month) {
    return;
  }
  tokens.push({
    kind: "date",
    start: match.index,
    end: match.index + match[0].length,
    raw: match[0],
    date,
  });
}

function resolveYearRollForward(
  now: string,
  month: number,
  day: number,
  yearText: string | undefined,
): string {
  if (yearText !== undefined) {
    return formatDate({ year: Number(yearText), month, day });
  }
  // No year typed — "27 Jan" plans for the *next* 27 January, which for
  // most of the year is this year and, once that date has already
  // passed, next year. Matches the everyday reading of a bare date typed
  // without a year ("I mean the one coming up," never "the one that
  // already happened").
  const nowYear = parseDateOnly(now).year;
  const thisYear = formatDate({ year: nowYear, month, day });
  return thisYear < now.slice(0, 10) ? formatDate({ year: nowYear + 1, month, day }) : thisYear;
}

/** `27 Jan`, `Jan 27`, `27/1/2026` — every absolute-date form issue #170's Part A brief names. */
export function matchAbsoluteDate(input: string, ctx: DateRuleContext): QuickAddToken[] {
  const monthAlt = alternation(Object.keys(ctx.language.months));
  const tokens: QuickAddToken[] = [];

  const dayFirst = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthAlt})\\b(?:,?\\s*(\\d{4}))?`,
    "gi",
  );
  for (const match of input.matchAll(dayFirst)) {
    const day = Number(match[1]);
    // biome-ignore lint/style/noNonNullAssertion: the alternation is built from this exact table's own keys
    const month = ctx.language.months[match[2]!.toLowerCase()]!;
    const date = resolveYearRollForward(ctx.now, month, day, match[3]);
    pushIfValidCalendarDate(tokens, match, parseDateOnly(date).year, month, day);
  }

  const monthFirst = new RegExp(
    `\\b(${monthAlt})\\b\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?`,
    "gi",
  );
  for (const match of input.matchAll(monthFirst)) {
    // biome-ignore lint/style/noNonNullAssertion: the alternation is built from this exact table's own keys
    const month = ctx.language.months[match[1]!.toLowerCase()]!;
    const day = Number(match[2]);
    const date = resolveYearRollForward(ctx.now, month, day, match[3]);
    pushIfValidCalendarDate(tokens, match, parseDateOnly(date).year, month, day);
  }

  // Numeric form always carries an explicit year (issue #170's own
  // example, `27/1/2026`, does) — see QuickAddLanguage.dayMonthOrder's
  // own doc comment for why only this form, not the worded ones above,
  // needs a language-specific word-order setting at all.
  const numeric = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
  for (const match of input.matchAll(numeric)) {
    const [first, second] = [Number(match[1]), Number(match[2])];
    const year = Number(match[3]);
    const [month, day] =
      ctx.language.dayMonthOrder === "day-month" ? [second, first] : [first, second];
    pushIfValidCalendarDate(tokens, match, year, month, day);
  }

  return tokens;
}

/** `today`, `tomorrow`, `tod`, `tom`. */
export function matchRelativeDate(input: string, ctx: DateRuleContext): QuickAddToken[] {
  const alt = alternation(Object.keys(ctx.language.relativeDays));
  const regex = new RegExp(`\\b(${alt})\\b`, "gi");
  const tokens: QuickAddToken[] = [];
  for (const match of input.matchAll(regex)) {
    // biome-ignore lint/style/noNonNullAssertion: the alternation is built from this exact table's own keys
    const offset = ctx.language.relativeDays[match[1]!.toLowerCase()]!;
    tokens.push({
      kind: "date",
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      date: addDays(ctx.now, offset),
    });
  }
  return tokens;
}

/**
 * `monday`, `next monday`, `this fri` — a bare weekday resolves to its
 * nearest occurrence on or after today (today itself, if today already
 * is that weekday); `this` is identical to bare; `next` always skips to
 * the following week's occurrence, even said on the day itself (`next
 * monday` on a Monday means 7 days out, never today) — see
 * ../quick-add.test.ts's table for the worked dates this resolves to.
 */
export function matchWeekday(input: string, ctx: DateRuleContext): QuickAddToken[] {
  const weekdayAlt = alternation(Object.keys(ctx.language.weekdays));
  const modifierAlt = alternation([ctx.language.thisWord, ctx.language.nextWord]);
  const regex = new RegExp(`\\b(?:(${modifierAlt})\\s+)?(${weekdayAlt})\\b`, "gi");
  const tokens: QuickAddToken[] = [];
  const todayIso = isoWeekday(ctx.now);
  for (const match of input.matchAll(regex)) {
    const modifier = match[1]?.toLowerCase();
    // biome-ignore lint/style/noNonNullAssertion: the alternation is built from this exact table's own keys
    const targetIso = ctx.language.weekdays[match[2]!.toLowerCase()]!;
    const bareDaysAhead = (targetIso - todayIso + 7) % 7;
    const daysAhead = modifier === ctx.language.nextWord ? bareDaysAhead + 7 : bareDaysAhead;
    tokens.push({
      kind: "date",
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      date: addDays(ctx.now, daysAhead),
    });
  }
  return tokens;
}

function addByUnit(
  date: string,
  amount: number,
  unit: "days" | "weeks" | "months" | "years",
): string {
  switch (unit) {
    case "days":
      return addDays(date, amount);
    case "weeks":
      return addDays(date, amount * 7);
    case "months":
      return addMonths(date, amount);
    case "years":
      return addYears(date, amount);
  }
}

/** `in 3 days`, `in 2 weeks`. */
export function matchArithmeticDate(input: string, ctx: DateRuleContext): QuickAddToken[] {
  const unitAlt = alternation(Object.keys(ctx.language.arithmeticUnits));
  const regex = new RegExp(
    `\\b${escapeRegExp(ctx.language.inWord)}\\s+(\\d+)\\s+(${unitAlt})\\b`,
    "gi",
  );
  const tokens: QuickAddToken[] = [];
  for (const match of input.matchAll(regex)) {
    const amount = Number(match[1]);
    // biome-ignore lint/style/noNonNullAssertion: the alternation is built from this exact table's own keys
    const unit = ctx.language.arithmeticUnits[match[2]!.toLowerCase()]!;
    tokens.push({
      kind: "date",
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      date: addByUnit(ctx.now, amount, unit),
    });
  }
  return tokens;
}

/**
 * `monday in 2 weeks` — date arithmetic applied to a weekday. Reads as
 * "advance the reference point by the offset, then find that weekday on
 * or after it" (not "find the weekday first, then shift it") — matched
 * before (and so, in ../parse-quick-add.ts's greedy overlap resolution,
 * preferred over) the plain weekday and plain arithmetic rules for the
 * same words, since this compound match is strictly more specific.
 */
export function matchWeekdayArithmeticCombo(input: string, ctx: DateRuleContext): QuickAddToken[] {
  const weekdayAlt = alternation(Object.keys(ctx.language.weekdays));
  const unitAlt = alternation(Object.keys(ctx.language.arithmeticUnits));
  const regex = new RegExp(
    `\\b(${weekdayAlt})\\s+${escapeRegExp(ctx.language.inWord)}\\s+(\\d+)\\s+(${unitAlt})\\b`,
    "gi",
  );
  const tokens: QuickAddToken[] = [];
  for (const match of input.matchAll(regex)) {
    // biome-ignore lint/style/noNonNullAssertion: the alternation is built from this exact table's own keys
    const targetIso = ctx.language.weekdays[match[1]!.toLowerCase()]!;
    const amount = Number(match[2]);
    // biome-ignore lint/style/noNonNullAssertion: the alternation is built from this exact table's own keys
    const unit = ctx.language.arithmeticUnits[match[3]!.toLowerCase()]!;
    const anchor = addByUnit(ctx.now, amount, unit);
    const daysAhead = (targetIso - isoWeekday(anchor) + 7) % 7;
    tokens.push({
      kind: "date",
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      date: addDays(anchor, daysAhead),
    });
  }
  return tokens;
}

function to24Hour(hour12: number, meridiem: "am" | "pm"): number {
  if (meridiem === "am") {
    return hour12 === 12 ? 0 : hour12;
  }
  return hour12 === 12 ? 12 : hour12 + 12;
}

/** `at 5pm`, `5pm`, `17:00`. */
export function matchExplicitTime(input: string, ctx: DateRuleContext): QuickAddToken[] {
  const tokens: QuickAddToken[] = [];
  const meridiemAlt = alternation(Object.keys(ctx.language.meridiem));
  const twelveHour = new RegExp(
    `\\b(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(${meridiemAlt})\\b`,
    "gi",
  );
  for (const match of input.matchAll(twelveHour)) {
    const hour12 = Number(match[1]);
    if (hour12 < 1 || hour12 > 12) {
      continue;
    }
    const minute = match[2] === undefined ? 0 : Number(match[2]);
    // biome-ignore lint/style/noNonNullAssertion: the alternation is built from this exact table's own keys
    const meridiem = ctx.language.meridiem[match[3]!.toLowerCase()]!;
    tokens.push({
      kind: "time",
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      time: formatTime(to24Hour(hour12, meridiem), minute),
    });
  }

  const twentyFourHour = /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;
  for (const match of input.matchAll(twentyFourHour)) {
    tokens.push({
      kind: "time",
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      time: formatTime(Number(match[1]), Number(match[2])),
    });
  }

  return tokens;
}

/** `morning`, `noon`, `evening`, `midnight`. */
export function matchFuzzyTime(input: string, ctx: DateRuleContext): QuickAddToken[] {
  const alt = alternation(Object.keys(ctx.language.fuzzyTimes));
  const regex = new RegExp(`\\b(${alt})\\b`, "gi");
  const tokens: QuickAddToken[] = [];
  for (const match of input.matchAll(regex)) {
    // biome-ignore lint/style/noNonNullAssertion: the alternation is built from this exact table's own keys
    const fuzzy = ctx.language.fuzzyTimes[match[1]!.toLowerCase()]!;
    tokens.push({
      kind: "time",
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      time: formatTime(fuzzy.hour, fuzzy.minute),
    });
  }
  return tokens;
}

/**
 * Bare recurrence keywords (`monthly`, `weekly`, ...) — flagged, not
 * resolved, against a small, closed, language-specific vocabulary that
 * needs no knowledge of ../recurrence/'s grammar at all: this rule has no
 * dependency on that module — see QuickAddLanguage.recurrenceWords' own
 * doc comment. `matchRecurrencePhrase` below is the *other* half of this
 * parser's recurrence awareness, added for issue #188, and it does
 * import ../recurrence/ (for validation only — see its own doc comment
 * for why that's a narrower dependency than it might look like). What
 * this rule exists for is issue #170's own required test case: "Create
 * **monthly** report" has to be *recognised* (this rule) before demotion
 * (click the highlighted word back to plain text) can mean anything.
 */
export function matchRecurrenceWord(input: string, ctx: DateRuleContext): QuickAddToken[] {
  const alt = alternation(Object.keys(ctx.language.recurrenceWords));
  const regex = new RegExp(`\\b(${alt})\\b`, "gi");
  const tokens: QuickAddToken[] = [];
  for (const match of input.matchAll(regex)) {
    tokens.push({
      kind: "recurrence",
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
    });
  }
  return tokens;
}

// "every"/"every!" followed by whitespace — the one fixed anchor
// ../recurrence/parser.ts's own EVERY_PREFIX requires, mirrored here
// (not read off that module, which exports no such pattern) only far
// enough to find where a *candidate* phrase might start; nothing here
// decides whether what follows is actually a legal recurrence, which is
// exactly why `\b` alone (not the full grammar) is enough for this
// regex's own job.
const EVERY_ANCHOR = /\bevery!?(?=\s)/gi;

/**
 * True when `input[bangIndex]` is the `!` glued onto the end of the word
 * "every" — `../recurrence/parser.ts`'s own completion-anchor bang
 * (`EVERY_PREFIX`'s `(!)?`), not an unrelated `!reminder` sigil that
 * happens to land on the same character. `./rules.ts`'s `matchReminder`
 * is a sigil rule and runs unconditionally, ahead of this file's own
 * eager family, so without this check "every! 2 weeks" would lose its
 * bang to a reminder token before `matchRecurrencePhrase` below ever got
 * a chance to claim it — the one span in this whole parser where two
 * *different* markers (an eager keyword's own bang, and an explicit `!`
 * sigil) can legally collide on the identical character. Deliberately a
 * textual check, not "does the rest of the phrase actually parse as a
 * recurrence": the ambiguity is about which grammar this exact `!`
 * belongs to, which is settled by what precedes it, not by whether
 * whatever follows happens to be well-formed — "every! zorp" still
 * isn't a reminder either, it's just a `!` with nothing recognisable on
 * either side of it, exactly as "zorp" alone would be.
 */
export function isEveryBangAt(input: string, bangIndex: number): boolean {
  return input[bangIndex] === "!" && /\bevery$/i.test(input.slice(0, bangIndex));
}

/**
 * The longest prefix of `phrase` (which always starts with "every"/
 * "every!") that ../recurrence/'s own `parseRecurrence` accepts, tried
 * word-by-word from the whole remainder down to nothing, or `null` if no
 * prefix at all parses. Longest-first, not first-match, so an optional
 * trailing clause this grammar supports (`every day at 5pm`, `every 2
 * weeks starting 1 oct`) is captured whole rather than the matcher
 * stopping at the shortest thing that happens to parse and leaving
 * "at 5pm" behind as ordinary words.
 */
function longestParsableEnd(phrase: string): number | null {
  const words = [...phrase.matchAll(/\S+/g)];
  for (let count = words.length; count >= 1; count--) {
    const lastWord = words[count - 1];
    // biome-ignore lint/style/noNonNullAssertion: `count` only ever indexes an element `words` actually has, 1..words.length
    const end = lastWord!.index + lastWord![0].length;
    if (parseRecurrence(phrase.slice(0, end)).kind === "parsed") {
      return end;
    }
  }
  return null;
}

/**
 * `every day`, `every monday`, `every 2 weeks`, `every 3rd friday`,
 * `every! 2 weeks` — the full recurrence grammar `../recurrence/parser.ts`
 * already accepts, typed inline rather than as a bare keyword (issue
 * #188). This is the one place in this parser that reaches into
 * ../recurrence/ at all, and it does so narrowly: `parseRecurrence` is
 * called only to ask "would the engine accept this exact text," and its
 * result — a `RecurrenceRule`, on success — is thrown away immediately.
 * Nothing here resolves a rule, computes a date, or stores anything;
 * this function still only ever flags a span, exactly as
 * `matchRecurrenceWord` does, which is what keeps this module's own
 * header comment ("recognition, not persistence") true of this rule too.
 *
 * **Why the dependency is safe to add, and narrower than it looks.** The
 * previous shape of this file's recurrence awareness — a closed,
 * seven-word vocabulary needing no grammar at all — no longer describes
 * the *whole* of it once phrases are reachable too, but the one-way
 * dependency this creates (quick-add -> recurrence, never the reverse)
 * doesn't invert anything ../recurrence/ itself relies on: that package
 * has never imported anything from this one, has no reason to start, and
 * still knows nothing about the add field, `QuickAddToken`, or any of
 * this module's own concerns. What changes is only that this parser is
 * no longer *ignorant* of the grammar — it still resolves nothing,
 * exactly as before.
 *
 * **Why a candidate has to be validated at all, rather than just
 * matching "every" plus some words.** A second, hand-rolled "what looks
 * like a recurrence phrase" grammar living here would be exactly the
 * "second, smaller grammar invented alongside" the real one that issue
 * #188 rules out, and it would drift from ../recurrence/parser.ts's own
 * grammar the moment either one changes without the other. Delegating
 * the actual accept/refuse decision to `parseRecurrence` itself is also
 * this rule's own false-positive guard (issue #188's acceptance
 * criterion 5): `every zorp` or `every 2` never becomes a token at all,
 * left as ordinary words for the reader to see exactly as typed, rather
 * than a `dateString` ../recurrence/'s own engine would refuse the first
 * time the Task is completed.
 */
export function matchRecurrencePhrase(input: string): QuickAddToken[] {
  const tokens: QuickAddToken[] = [];
  let searchFrom = 0;
  for (const anchor of input.matchAll(EVERY_ANCHOR)) {
    const start = anchor.index;
    if (start < searchFrom) {
      continue; // Inside a span this loop already accepted — see below.
    }
    const end = longestParsableEnd(input.slice(start));
    if (end === null) {
      continue;
    }
    const absoluteEnd = start + end;
    tokens.push({
      kind: "recurrence",
      start,
      end: absoluteEnd,
      raw: input.slice(start, absoluteEnd),
    });
    // A later "every" that this accepted span already swallowed (an
    // "every" inside a "starting"/"ending" clause's own text, however
    // unlikely) is not a second, independent candidate — advancing past
    // the accepted span keeps this loop's own candidates non-overlapping
    // by construction, the same guarantee every other free-text rule in
    // this file gets for free from `matchAll` never re-scanning consumed
    // text.
    searchFrom = absoluteEnd;
  }
  return tokens;
}

/** Every date-shaped rule (not time, not recurrence) — the pool ./rules.ts's `{deadline}` handling resolves a whole phrase against, and free-text scanning's own date candidates. Combo listed first, matching ../parse-quick-add.ts's own priority-by-push-order convention. */
export function matchDateForms(input: string, ctx: DateRuleContext): QuickAddToken[] {
  return [
    ...matchWeekdayArithmeticCombo(input, ctx),
    ...matchAbsoluteDate(input, ctx),
    ...matchRelativeDate(input, ctx),
    ...matchWeekday(input, ctx),
    ...matchArithmeticDate(input, ctx),
  ];
}

/** Every time-shaped rule — the pool ./rules.ts's `!reminder` handling resolves a whole phrase against, and free-text scanning's own time candidates. */
export function matchTimeForms(input: string, ctx: DateRuleContext): QuickAddToken[] {
  return [...matchExplicitTime(input, ctx), ...matchFuzzyTime(input, ctx)];
}

/**
 * Runs `matchers` against `phrase` and returns the first candidate that
 * consumes the *entire* trimmed phrase — the mechanism `{deadline}` and
 * `!reminder` (./rules.ts) both use to ask "is this bracketed/prefixed
 * text a recognisable whole date or time," reusing the identical
 * matcher functions free-text scanning uses rather than a second,
 * hand-written "parse one phrase" grammar that could drift from the
 * first. A partial match (the phrase has a date-shaped prefix and
 * trailing junk) is deliberately not good enough here — free-text
 * scanning already finds a date wherever one appears; the whole point of
 * requiring `{}` around a deadline is that the user drew the boundary
 * themselves, so this only honours a phrase that fits it exactly.
 */
export function resolveWholePhrase(
  phrase: string,
  ctx: DateRuleContext,
  matchers: ReadonlyArray<(input: string, ctx: DateRuleContext) => QuickAddToken[]>,
): QuickAddToken | null {
  const trimmed = phrase.trim();
  for (const matcher of matchers) {
    for (const token of matcher(trimmed, ctx)) {
      if (token.start === 0 && token.end === trimmed.length) {
        return token;
      }
    }
  }
  return null;
}
