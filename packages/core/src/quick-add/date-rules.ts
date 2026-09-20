import { parseRecurrence } from "../recurrence";
import {
  addDays,
  addMinutes,
  addMonths,
  addYears,
  daysInMonth,
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
 * ordinary words with no marker the user typed on purpose.
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
  if (month < 1 || month > 12) {
    return; // Not a real month at all — never a genuine calendar date under any rollover, and the guard "13/25" (neither reading has a valid month) still needs (../quick-add.test.ts).
  }
  if (day < 1 || day > 31) {
    return; // Not a calendar day at all — see this file's header comment on why an invalid match is silently skipped rather than "corrected".
  }
  // Issue #382: `formatDate` normalises a day that doesn't exist in
  // `month` forward into the next one (Date.UTC's own rollover — `29 Feb`
  // in a non-leap year becomes `1 Mar`), and this is now *let through*
  // rather than refused, per the corpus's own measured `"29 feb"` row —
  // Todoist itself gracefully rolls it forward instead of refusing the
  // match. Only reachable once `month` is already confirmed 1-12 above:
  // an invalid month is refused outright, never "rolled" into a
  // different, unasked-for one.
  const date = formatDate({ year, month, day });
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

/** `27 Jan`, `Jan 27`, `27/1/2026` — every absolute-date form issue #170's Part A brief names — plus, from issue #382, the remaining numeric forms Todoist also accepts: `24.9.2026` (dot-separated, explicit year), `2026-09-24` (ISO 8601, year-first) and `24-09` (hyphen-separated, no year). */
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

  // Bare month name (`March`, `May`, `August`) — issue #410, and D1's own
  // "follows from D1, no further decision needed" list
  // (`.scratch/todoist-add-todo/DECISIONS.md`: "Bare month names stay in
  // the eager vocabulary"). Todoist treats a month name as ordinary
  // literal-token vocabulary, exactly like a weekday name — so a month
  // used as a common noun or verb still false-positives, resolving to
  // day 1 of that month rolled forward to its next occurrence (identical
  // `resolveYearRollForward` this function's day+month forms already
  // use). Measured (`.scratch/todoist-add-todo/web/11-detection-
  // recheck.md`, `data/11-false-positive-boundary.json`): a leading
  // `in ` immediately before the month is swallowed into the match ("I
  // saw him in August" -> "in August"), but a month with nothing before
  // it is not ("March forward" -> "March" alone). Both lookaround guards
  // below refuse a month word immediately adjacent to a number, on
  // either side, regardless of whether that number is a valid day — the
  // corpus's own `32 sept` (an out-of-range day) still expects *no*
  // match at all, not a fallback bare-month reading of `sept`, so an
  // adjacent number blocks this rule even when the compound it's part of
  // fails `pushIfValidCalendarDate` below. Pushed after `dayFirst`/
  // `monthFirst` above so a day-qualified date always wins the overlap
  // against this looser, unqualified match for the identical month
  // word — the same "more specific form pushed first" convention this
  // function's numeric forms already follow.
  const bareMonth = new RegExp(`(?<!\\d\\s*)\\b(in\\s+)?(${monthAlt})\\b(?!\\s*\\d)`, "gi");
  for (const match of input.matchAll(bareMonth)) {
    // biome-ignore lint/style/noNonNullAssertion: the alternation is built from this exact table's own keys
    const month = ctx.language.months[match[2]!.toLowerCase()]!;
    const date = resolveYearRollForward(ctx.now, month, 1, undefined);
    const start = match.index;
    const end = match.index + match[0].length;
    tokens.push({ kind: "date", start, end, raw: input.slice(start, end), date });
  }

  // Three-part numeric form always carries an explicit year (issue
  // #170's own example, `27/1/2026`, does) — see
  // QuickAddLanguage.dayMonthOrder's own doc comment for why only this
  // form, not the worded ones above, needs a language-specific word-order
  // setting at all.
  const numeric = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;
  for (const match of input.matchAll(numeric)) {
    const [first, second] = [Number(match[1]), Number(match[2])];
    const year = Number(match[3]);
    const [month, day] =
      ctx.language.dayMonthOrder === "day-month" ? [second, first] : [first, second];
    pushIfValidCalendarDate(tokens, match, year, month, day);
  }

  // Bare two-part numeric form, no year (`24/9`) — issue #366: this used
  // to hardcode month-first regardless of `dayMonthOrder`, disagreeing
  // with the three-part loop above over the identical grammar. Fixed to
  // read `dayMonthOrder`'s preferred order first, exactly as the
  // three-part loop does — but, unlike that loop, falling back to the
  // *other* reading when the preferred one has no valid month at all
  // (`resolveTwoPartMonthDay` below), rather than refusing the match.
  // The corpus is why this form needs a fallback the three-part one
  // doesn't: `9/24` and `24/9` both carry `data-match-id` "24 Sep" —
  // strictly reading `9/24` as day-first (day 9, month 24) has no valid
  // month, so a fallback-free version of this fix would regress an
  // already-passing corpus row, not just fail to fix the pending one.
  const monthDayNoYear = /\b(\d{1,2})\/(\d{1,2})\b(?!\/\d)/g;
  for (const match of input.matchAll(monthDayNoYear)) {
    const [first, second] = [Number(match[1]), Number(match[2])];
    const [month, day] = resolveTwoPartMonthDay(ctx.language.dayMonthOrder, first, second);
    const date = resolveYearRollForward(ctx.now, month, day, undefined);
    pushIfValidCalendarDate(tokens, match, parseDateOnly(date).year, month, day);
  }

  // Dot-separated three-part form, always carrying an explicit year
  // (`24.9.2026`, issue #382) — the identical day/month-order reading the
  // slash three-part form above already applies, just a different
  // separator; no dayMonthOrder-free fallback is needed here for the same
  // reason the slash form doesn't need one: a year always disambiguates
  // which reading was intended, so there is no "neither reading has a
  // valid month" case a fallback would ever rescue.
  const dotted = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g;
  for (const match of input.matchAll(dotted)) {
    const [first, second] = [Number(match[1]), Number(match[2])];
    const year = Number(match[3]);
    const [month, day] =
      ctx.language.dayMonthOrder === "day-month" ? [second, first] : [first, second];
    pushIfValidCalendarDate(tokens, match, year, month, day);
  }

  // ISO 8601 year-first form (`2026-09-24`, issue #382) — year-month-day
  // is unambiguous by construction (that's the entire point of the ISO
  // convention), so this needs no `dayMonthOrder` reading at all, unlike
  // every other numeric form above. Pushed *before* the hyphenated
  // two-part form below so this always wins the overlap on a string like
  // `2026-09-24`, where that form's own regex would otherwise also match
  // the trailing `09-24` as its own, shorter candidate — the identical
  // "more specific form pushed first, wins the greedy overlap resolution"
  // convention this parser already uses throughout (../parse-quick-add.ts's
  // own header comment).
  const isoYearFirst = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
  for (const match of input.matchAll(isoYearFirst)) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    pushIfValidCalendarDate(tokens, match, year, month, day);
  }

  // Hyphenated two-part form, no year (`24-09`, issue #382) — the
  // identical `dayMonthOrder`-with-fallback reading `monthDayNoYear`
  // above already applies to the slash form, just a different separator.
  const dayMonthHyphenNoYear = /\b(\d{1,2})-(\d{1,2})\b(?!-\d)/g;
  for (const match of input.matchAll(dayMonthHyphenNoYear)) {
    const [first, second] = [Number(match[1]), Number(match[2])];
    const [month, day] = resolveTwoPartMonthDay(ctx.language.dayMonthOrder, first, second);
    const date = resolveYearRollForward(ctx.now, month, day, undefined);
    pushIfValidCalendarDate(tokens, match, parseDateOnly(date).year, month, day);
  }

  return tokens;
}

/**
 * Which of `first`/`second` is the month for the bare two-part numeric
 * date form — `dayMonthOrder`'s preferred reading, falling back to the
 * other reading when the preferred one has no valid month (1-12) at
 * all. Proven necessary, not just defensive, by the corpus: `9/24` and
 * `24/9` both resolve to 24 Sep — reading `9/24` strictly day-first
 * (day 9, month 24) has no valid month, so Todoist's own two-part
 * grammar must fall back to the other reading rather than refuse the
 * match, exactly what this function does. `pushIfValidCalendarDate`'s
 * own round-trip reparse still refuses a pair where *neither* reading
 * has a valid month (e.g. `13/25`) — this function only decides which
 * reading to try, not whether the result is a real calendar date.
 */
function resolveTwoPartMonthDay(
  dayMonthOrder: QuickAddLanguage["dayMonthOrder"],
  first: number,
  second: number,
): [month: number, day: number] {
  const preferred: [number, number] =
    dayMonthOrder === "day-month" ? [second, first] : [first, second];
  if (preferred[0] >= 1 && preferred[0] <= 12) {
    return preferred;
  }
  return dayMonthOrder === "day-month" ? [first, second] : [second, first];
}

/**
 * `today`, `tomorrow`, `tod`, `tom` — and, issue #384's own corpus rows:
 *
 * - **Punctuation swallowed into the match.** `Call mom today.` highlights
 *   `today.` in Todoist, trailing period included; `today,` and the
 *   quoted `"today"` (both surrounding quotes) do the same. The `\b`
 *   boundary this rule's regex already needs stops exactly at the bare
 *   word, so the match itself is extended afterward, once, rather than
 *   folding punctuation into the word alternation itself.
 * - **An apostrophe is not a word boundary.** `\b` treats `'` as a
 *   non-word character exactly like a space, which is *why* `Today's
 *   standup` used to wrongly match `Today` — JS regex `\b` cannot
 *   distinguish "the word ended" from "the word grew a suffix." The
 *   `(?!')` lookahead below closes that gap directly: `todays` (no
 *   apostrophe) already correctly fails for an unrelated reason (`day`
 *   and `s` share no boundary at all, so `\btoday\b` never matches
 *   inside it); `Today's` needs this explicit exclusion because `\b`
 *   alone cannot tell the two shapes apart.
 */
export function matchRelativeDate(input: string, ctx: DateRuleContext): QuickAddToken[] {
  const alt = alternation(Object.keys(ctx.language.relativeDays));
  const regex = new RegExp(`\\b(${alt})\\b(?!')`, "gi");
  const tokens: QuickAddToken[] = [];
  for (const match of input.matchAll(regex)) {
    // biome-ignore lint/style/noNonNullAssertion: the alternation is built from this exact table's own keys
    const offset = ctx.language.relativeDays[match[1]!.toLowerCase()]!;
    const { start, end } = extendForSurroundingPunctuation(
      input,
      match.index,
      match.index + match[0].length,
    );
    tokens.push({
      kind: "date",
      start,
      end,
      raw: input.slice(start, end),
      date: addDays(ctx.now, offset),
    });
  }
  return tokens;
}

/**
 * Extends `[start, end)` to include one trailing `.`/`,`, or a matching
 * pair of straight double-quotes immediately surrounding the whole span
 * — Todoist's own eager match absorbs trailing sentence punctuation and
 * enclosing quotes rather than stopping at the bare word (issue #384).
 * Quotes take priority over trailing punctuation when both could apply
 * (`"today."` is not a measured shape; nothing here needs to guess at
 * it). Narrowly applied only where measured (`matchRelativeDate`) rather
 * than every eager rule in this file — the corpus's own PENDING rows for
 * this issue are all bare relative-day words (`today.`/`today,`/
 * `"today"`); widening this to every rule in the file would be scope
 * this ticket's own corpus doesn't ask for or falsify.
 */
function extendForSurroundingPunctuation(
  input: string,
  start: number,
  end: number,
): { start: number; end: number } {
  if (input[start - 1] === '"' && input[end] === '"') {
    return { start: start - 1, end: end + 1 };
  }
  if (input[end] === "." || input[end] === ",") {
    return { start, end: end + 1 };
  }
  return { start, end };
}

/**
 * **`last` reproduces Todoist's own known bug, on purpose.** Measured on
 * both Todoist web and Android (issue #367,
 * `.scratch/todoist-add-todo/DECISIONS.md`'s D2): `last monday` resolves
 * to the exact same *future* date as `next monday`, not the Monday that
 * already passed — the correct reading a user would expect, and the
 * reading this constant deliberately does *not* implement. It is wrong,
 * it is measured as wrong on two independent clients of Todoist's shared
 * parser, and it is reproduced anyway per D1's clone standard: divergence
 * from a bug still counts as divergence. See
 * `docs/adr/0088-todoists-add-task-parser-is-cloned-verbatim-defects-included.md`
 * for the standard this serves and why it's not "fixed" into a parity
 * break. Left `true` unconditionally — this is not a runtime feature
 * flag, it's a named landmark so a future reader hits this comment
 * before quietly deleting the `last` branch below.
 */
const LAST_WEEKDAY_REPRODUCES_TODOIST_BUG = true;

/**
 * `monday`, `next monday`, `this fri`, `last monday` — a bare weekday
 * resolves to its nearest occurrence on or after today (today itself, if
 * today already is that weekday); `this` is identical to bare; `next`
 * always skips to the following week's occurrence, even said on the day
 * itself (`next monday` on a Monday means 7 days out, never today);
 * `last` resolves identically to `next` — see
 * `LAST_WEEKDAY_REPRODUCES_TODOIST_BUG`'s own doc comment immediately
 * above for why that's a reproduced bug, not a typo. See
 * ../quick-add.test.ts's table for the worked dates this resolves to.
 */
export function matchWeekday(input: string, ctx: DateRuleContext): QuickAddToken[] {
  const weekdayAlt = alternation(Object.keys(ctx.language.weekdays));
  const modifierAlt = alternation([
    ctx.language.thisWord,
    ctx.language.nextWord,
    ctx.language.lastWord,
  ]);
  const regex = new RegExp(`\\b(?:(${modifierAlt})\\s+)?(${weekdayAlt})\\b`, "gi");
  const tokens: QuickAddToken[] = [];
  const todayIso = isoWeekday(ctx.now);
  for (const match of input.matchAll(regex)) {
    const modifier = match[1]?.toLowerCase();
    // biome-ignore lint/style/noNonNullAssertion: the alternation is built from this exact table's own keys
    const targetIso = ctx.language.weekdays[match[2]!.toLowerCase()]!;
    const bareDaysAhead = (targetIso - todayIso + 7) % 7;
    const pushesForward =
      modifier === ctx.language.nextWord ||
      (modifier === ctx.language.lastWord && LAST_WEEKDAY_REPRODUCES_TODOIST_BUG);
    const daysAhead = pushesForward ? bareDaysAhead + 7 : bareDaysAhead;
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

// Reads `text` as either a bare `\d+` or a `QuickAddLanguage.numberWords`
// entry, or `undefined` if it's neither — the one place matchArithmeticDate/
// matchDaysFromNow decide "which spelling of the amount is this," so
// matchWeekdayArithmeticCombo (unmeasured for a spelled-out amount,
// issue #382) doesn't have to make the identical decision a second time.
function resolveAmount(
  text: string,
  numberWords: QuickAddLanguage["numberWords"],
): number | undefined {
  if (/^\d+$/.test(text)) {
    return Number(text);
  }
  return numberWords[text.toLowerCase()];
}

/**
 * `in 3 days`, `in 2 weeks`, `in three days` (issue #382's own corpus
 * row, a spelled-out amount via `QuickAddLanguage.numberWords` in place
 * of a bare `\d+`), and — issue #383 — `in an hour`/`in 30 min`: a
 * second loop against `timeArithmeticUnits` rather than widening
 * `arithmeticUnits` itself, since an hour/minute amount needs the full
 * `now` instant (`date-math.ts`'s `addMinutes`) where a day/week/month/
 * year amount only ever needed the day (`addByUnit`'s own day-only
 * family) — see `QuickAddLanguage.timeArithmeticUnits`' own doc comment.
 */
export function matchArithmeticDate(input: string, ctx: DateRuleContext): QuickAddToken[] {
  const unitAlt = alternation(Object.keys(ctx.language.arithmeticUnits));
  const amountAlt = alternation(Object.keys(ctx.language.numberWords));
  const regex = new RegExp(
    `\\b${escapeRegExp(ctx.language.inWord)}\\s+(\\d+|${amountAlt})\\s+(${unitAlt})\\b`,
    "gi",
  );
  const tokens: QuickAddToken[] = [];
  for (const match of input.matchAll(regex)) {
    // biome-ignore lint/style/noNonNullAssertion: the alternation is built from this exact table's own keys, or the regex's own `\d+` branch
    const amount = resolveAmount(match[1]!, ctx.language.numberWords);
    // biome-ignore lint/style/noNonNullAssertion: the alternation is built from this exact table's own keys
    const unit = ctx.language.arithmeticUnits[match[2]!.toLowerCase()]!;
    if (amount === undefined) {
      continue;
    }
    tokens.push({
      kind: "date",
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      date: addByUnit(ctx.now, amount, unit),
    });
  }

  const timeUnitAlt = alternation(Object.keys(ctx.language.timeArithmeticUnits));
  const timeRegex = new RegExp(
    `\\b${escapeRegExp(ctx.language.inWord)}\\s+(\\d+|${amountAlt})\\s+(${timeUnitAlt})\\b`,
    "gi",
  );
  for (const match of input.matchAll(timeRegex)) {
    // biome-ignore lint/style/noNonNullAssertion: the alternation is built from this exact table's own keys, or the regex's own `\d+` branch
    const amount = resolveAmount(match[1]!, ctx.language.numberWords);
    // biome-ignore lint/style/noNonNullAssertion: the alternation is built from this exact table's own keys
    const unit = ctx.language.timeArithmeticUnits[match[2]!.toLowerCase()]!;
    if (amount === undefined) {
      continue;
    }
    const minutes = unit === "hours" ? amount * 60 : amount;
    tokens.push({
      kind: "date",
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      date: addMinutes(ctx.now, minutes),
    });
  }

  return tokens;
}

/**
 * `3 days from now` (issue #382) — the reversed word order of `in 3
 * days` above, digit amounts only (no spelled-out form is corpus-
 * measured for this order, unlike the forward one). Reuses the same
 * `arithmeticUnits` table `matchArithmeticDate` does, generalising to
 * `weeks`/`months`/`years` for the identical symmetry reason that table
 * already covers all four units for the forward phrasing, not just
 * `days`.
 */
export function matchDaysFromNow(input: string, ctx: DateRuleContext): QuickAddToken[] {
  const unitAlt = alternation(Object.keys(ctx.language.arithmeticUnits));
  const regex = new RegExp(`\\b(\\d+)\\s+(${unitAlt})\\s+from\\s+now\\b`, "gi");
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
 * `end of month` (issue #382) — the last calendar day of `ctx.now`'s own
 * month. Deliberately the literal three-word phrase only: the corpus's
 * own PENDING reason for this row is explicit that `eom`/`eow`/`end of
 * week` are correctly unmatched on both sides (Todoist doesn't recognise
 * those either), so this regex must not be loosened to catch them.
 */
export function matchEndOfMonth(input: string, ctx: DateRuleContext): QuickAddToken[] {
  const regex = /\bend of month\b/gi;
  const tokens: QuickAddToken[] = [];
  for (const match of input.matchAll(regex)) {
    const { year, month } = parseDateOnly(ctx.now);
    tokens.push({
      kind: "date",
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      date: formatDate({ year, month, day: daysInMonth(year, month) }),
    });
  }
  return tokens;
}

export function matchNextWeek(input: string, ctx: DateRuleContext): QuickAddToken[] {
  const MONDAY_ISO_WEEKDAY = 1;
  const weekWords = Object.keys(ctx.language.arithmeticUnits).filter(
    (word) => ctx.language.arithmeticUnits[word] === "weeks",
  );
  const regex = new RegExp(
    `\\b${escapeRegExp(ctx.language.nextWord)}\\s+(${alternation(weekWords)})\\b`,
    "gi",
  );
  const daysToNextMonday = (MONDAY_ISO_WEEKDAY - isoWeekday(ctx.now) + 7) % 7 || 7;
  const tokens: QuickAddToken[] = [];
  for (const match of input.matchAll(regex)) {
    tokens.push({
      kind: "date",
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      date: addDays(ctx.now, daysToNextMonday),
    });
  }
  return tokens;
}

/**
 * `this weekend`, `weekend`, `next weekend` — and, embedded in running
 * prose, `the weekend` (issue #366's corpus row for `Pay for the weekend
 * trip`: the matched span is `"the weekend"`, not bare `"weekend"`, and
 * it resolves identically to the bare word — Todoist's own determiner
 * swallow, not this parser inventing one).
 *
 * **This reverses meologue's previous, deliberate refusal to match
 * `weekend`-shaped words at all** (`quick-add.test.ts` used to assert
 * `Pay for the weekend trip` produced no date). D1
 * (`.scratch/todoist-add-todo/DECISIONS.md`) is explicit that this is
 * not an oversight being corrected but Todoist's own design being
 * cloned on purpose: eager detection costs the user one click or
 * Backspace to reject a false positive, while non-detection leaves
 * nothing to recover a missed date with — "the unrecoverable state."
 * The reversed test lives in `quick-add.test.ts`, flipped rather than
 * deleted, with this same citation.
 *
 * Same bare/`this`/`next` shape as `matchWeekday` (`this` and bare both
 * mean "the nearest one, today included"; `next` always skips a full
 * week), targeting the fixed weekday Saturday rather than a table entry,
 * since "the weekend" always means the same day of the week regardless
 * of which weekday is typed.
 */
export function matchFuzzyRange(input: string, ctx: DateRuleContext): QuickAddToken[] {
  const SATURDAY_ISO_WEEKDAY = 6;
  const modifierAlt = alternation([
    ctx.language.thisWord,
    ctx.language.nextWord,
    ctx.language.theWeekendWord,
  ]);
  const regex = new RegExp(
    `\\b(?:(${modifierAlt})\\s+)?(${escapeRegExp(ctx.language.weekendWord)})\\b`,
    "gi",
  );
  const tokens: QuickAddToken[] = [];
  const todayIso = isoWeekday(ctx.now);
  const bareDaysAhead = (SATURDAY_ISO_WEEKDAY - todayIso + 7) % 7;
  for (const match of input.matchAll(regex)) {
    const modifier = match[1]?.toLowerCase();
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

// Shared by matchNextMonth/matchNextYear below — "next month"/"next
// year" both mean the identical calendar date one unit further on (the
// corpus's own `data-match-id`s: "next month" -> same day, next month;
// "next year" -> same day, next year — see matchNextYear's own doc
// comment for why that second one is worth calling out explicitly), so
// both are one `addByUnit` call keyed off the same `arithmeticUnits`
// table `matchArithmeticDate`/`matchNextWeek` already read from, not a
// second word list.
function matchNextUnit(
  input: string,
  ctx: DateRuleContext,
  unit: "months" | "years",
): QuickAddToken[] {
  const words = Object.keys(ctx.language.arithmeticUnits).filter(
    (word) => ctx.language.arithmeticUnits[word] === unit,
  );
  const regex = new RegExp(
    `\\b${escapeRegExp(ctx.language.nextWord)}\\s+(${alternation(words)})\\b`,
    "gi",
  );
  const tokens: QuickAddToken[] = [];
  for (const match of input.matchAll(regex)) {
    tokens.push({
      kind: "date",
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      date: addByUnit(ctx.now, 1, unit),
    });
  }
  return tokens;
}

/** `next month` — the same calendar date one month on (`addMonths(now, 1)`), clamped exactly as every other `addMonths` caller in this file is. */
export function matchNextMonth(input: string, ctx: DateRuleContext): QuickAddToken[] {
  return matchNextUnit(input, ctx, "months");
}

/**
 * `next year` — the same calendar date one year on (`addYears(now, 1)`),
 * **not** January 1st. Issue #366's own ticket text paraphrased Todoist's
 * help-centre doc as "next year resolves to 1 January," but the measured
 * corpus (`detection-corpus.json`'s `"next year"` row, captured against
 * the live app) records `data-match-id` `"19 Sep 2027"` against a 19 Sep
 * 2026 capture date — the same day and month, the year rolled forward
 * once, exactly like every other same-day-next-year case in this file.
 * D1 (`.scratch/todoist-add-todo/DECISIONS.md`) settles this in favour
 * of what the live app actually does over what its own docs say it
 * does, so this function clones the corpus, not the paraphrase.
 */
export function matchNextYear(input: string, ctx: DateRuleContext): QuickAddToken[] {
  return matchNextUnit(input, ctx, "years");
}

/**
 * Fixed calendar holidays — `valentine`, `halloween`, `new year day`,
 * `new year eve` (issue #366) — resolved off `ctx.language.holidays`
 * with the identical year-roll-forward rule a yearless absolute date
 * already gets (`resolveYearRollForward`, used unchanged rather than
 * reimplemented): a holiday already passed this year rolls to next year,
 * one still ahead stays this year.
 */
export function matchHolidayWord(input: string, ctx: DateRuleContext): QuickAddToken[] {
  const alt = alternation(Object.keys(ctx.language.holidays));
  const regex = new RegExp(`\\b(${alt})\\b`, "gi");
  const tokens: QuickAddToken[] = [];
  for (const match of input.matchAll(regex)) {
    // biome-ignore lint/style/noNonNullAssertion: the alternation is built from this exact table's own keys
    const holiday = ctx.language.holidays[match[1]!.toLowerCase()]!;
    tokens.push({
      kind: "date",
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      date: resolveYearRollForward(ctx.now, holiday.month, holiday.day, undefined),
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

  // `at 5` (issue #383) — a bare hour with no meridiem and no minute at
  // all, 1-12 only (the "bare hour" reading is inherently a 12-hour one;
  // a caller meaning the 24-hour clock already has `matchExplicitTime`'s
  // other two forms). Minute defaults to `:00`, the identical default
  // `at 9` (with a meridiem) already takes above. Whether this resolves
  // to today or tomorrow is never decided here — this rule only ever
  // flags the span and a literal hour, exactly as `matchFuzzyTime` does;
  // ../parse-quick-add.ts's `mergeDateAndTime` is the one place that
  // already-past-today question is answered, uniformly for every `time`
  // token regardless of which rule produced it.
  const bareHour = /\bat\s+(\d{1,2})\b(?!\s*:)/gi;
  for (const match of input.matchAll(bareHour)) {
    const hour = Number(match[1]);
    if (hour < 1 || hour > 12) {
      continue;
    }
    tokens.push({
      kind: "time",
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
      time: formatTime(hour, 0),
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

// "every"/"every!" (or issue #385's abbreviated "ev"/"ev!") followed by
// whitespace, or glued straight onto "day" with none at all ("everyday",
// issue #369) — the one fixed anchor ../recurrence/parser.ts's own
// EVERY_PREFIX requires, mirrored here (not read off that module, which
// exports no such pattern) only far enough to find where a *candidate*
// phrase might start; nothing here decides whether what follows is
// actually a legal recurrence, which is exactly why `\b` alone (not the
// full grammar) is enough for this regex's own job. Kept in lockstep with
// EVERY_PREFIX's own `(?:every|ev)` and `(?=day\b)` — see that regex's
// own comment for why "ev" and "day\b" are exactly this and nothing
// looser.
const EVERY_ANCHOR = /\b(?:every|ev)!?(?=\s|day\b)/gi;

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

/**
 * `after N days` (issue #369) — Todoist's own completion-anchored
 * shorthand, textually equivalent to `every! N days` (../recurrence/'s
 * own bang syntax). Never legal ../recurrence/ input as typed — "after"
 * isn't a word `parseRecurrence` knows at all — so, unlike
 * matchRecurrencePhrase above, this validates the *rewritten* phrase
 * rather than the literal match; the token's own `raw` still carries the
 * literal text the reader typed ("recognition, not persistence," this
 * module's own header comment), and the rewrite itself happens exactly
 * once, at the point Task.dateString is actually written
 * (apps/web/src/lib/quick-add-task.ts's `resolveRecurrencePhrase` — the
 * same seam `RECURRENCE_WORD_TO_PHRASE` already bridges a bare recurrence
 * word through, mirrored here for a phrase with a number in it rather
 * than a fixed table entry). Not a new frequency kind: ../recurrence/
 * knows nothing about "after" before or after this change.
 */
const AFTER_DAYS_CLAUSE = /\bafter\s+(\d+)\s+days?\b/gi;

export function matchAfterDays(input: string): QuickAddToken[] {
  const tokens: QuickAddToken[] = [];
  for (const match of input.matchAll(AFTER_DAYS_CLAUSE)) {
    const count = match[1];
    if (count === undefined) {
      continue;
    }
    if (parseRecurrence(`every! ${count} days`).kind !== "parsed") {
      continue; // Same false-positive guard matchRecurrencePhrase above uses — see its own doc comment.
    }
    tokens.push({
      kind: "recurrence",
      start: match.index,
      end: match.index + match[0].length,
      raw: match[0],
    });
  }
  return tokens;
}

/** Every time-shaped rule — the pool ./rules.ts's `!reminder` handling resolves a whole phrase against, and free-text scanning's own time candidates. */
export function matchTimeForms(input: string, ctx: DateRuleContext): QuickAddToken[] {
  return [...matchExplicitTime(input, ctx), ...matchFuzzyTime(input, ctx)];
}

/**
 * Adjacent means "only whitespace between the two spans," for every merge
 * `matchDateTimeCombo` below attempts — never a connector word, except the
 * one named exception (`matchDateTimeCombo`'s own "starting" clause) that
 * checks its own, different text between the spans instead of calling
 * this.
 */
function isAdjacent(input: string, a: QuickAddToken, b: QuickAddToken): boolean {
  return a.end <= b.start && input.slice(a.end, b.start).trim() === "";
}

/**
 * Merges an adjacent date+time, weekday+time, or recurrence+time pair
 * into one match — issue #384's own corpus rows: `today at 5pm`,
 * `tomorrow morning`, `mon 9am` (a plain date word immediately followed
 * by a time word becomes one `"date"` token carrying the merged
 * instant), and `every day starting next monday` (a recurrence phrase
 * followed by `starting` and a date-shaped phrase its own grammar
 * doesn't parse — `parseRecurrence` wants an absolute `D Mon` date after
 * `starting`, not "next monday" — still becomes one `"recurrence"`
 * token spanning the whole thing, since a `"recurrence"` token's own
 * `raw` is all this parser — and ../detection-corpus.test.ts's own
 * `resolvedValueOf` — ever checks against a recurrence row; no merged
 * *value* to compute for that shape, only a merged *span*).
 *
 * **Why this subsumes the individual calls rather than running
 * alongside them.** `Buy milk tomorrow at 5pm every week p2`'s own
 * corpus row is the reason: Todoist merges `at 5pm` with the
 * *recurrence* (`every week`) here, not with the earlier `tomorrow` —
 * and once that merge wins, `tomorrow` is not left behind as its own,
 * separate match either. A date/time/recurrence candidate that
 * *attempted* a merge is consumed whether or not that specific merge
 * ultimately wins the greedy overlap race in ../parse-quick-add.ts's
 * `resolveOverlaps` — if the individual `matchRelativeDate`/
 * `matchWeekday`/`matchTimeForms`/`matchRecurrencePhrase` calls also ran
 * independently in ../parse-quick-add.ts's own candidate list, their own
 * unmerged `tomorrow` candidate would still be there, overlap nothing,
 * and get accepted anyway — exactly the stray match the corpus says
 * shouldn't exist. Returning both the merged tokens *and* whichever
 * originals never attempted a merge, as one list, is what lets
 * ../parse-quick-add.ts call this once, in place of those four
 * functions, rather than four separate calls it would then have to
 * reconcile.
 *
 * Merge priority (recurrence+time tried before date+time) is what
 * settles that exact ambiguity: `at 5pm` is adjacent to both `tomorrow`
 * (before it) and `every week` (after it) in that row, and the
 * recurrence+time merge is attempted first, claiming `at 5pm every
 * week` — the date+time merge for `tomorrow at 5pm` is attempted too,
 * consuming `tomorrow` in the process, but the `time` half was already
 * claimed by the higher-priority recurrence merge, so no second,
 * conflicting merge token is produced for the same `at 5pm` span —
 * `tomorrow`'s own consumed status means nothing falls back to it
 * either.
 */
export function matchDateTimeCombo(input: string, ctx: DateRuleContext): QuickAddToken[] {
  const dateCandidates = [...matchRelativeDate(input, ctx), ...matchWeekday(input, ctx)];
  const timeCandidates = matchTimeForms(input, ctx);
  const recurrenceCandidates = matchRecurrencePhrase(input);

  const consumed = new Set<QuickAddToken>();
  const merged: QuickAddToken[] = [];

  // Recurrence + time, either order — tried before date + time below, so
  // it wins the one measured ambiguity (`at 5pm` adjacent to both a date
  // and a recurrence) this function's own doc comment names.
  for (const rec of recurrenceCandidates) {
    for (const time of timeCandidates) {
      if (isAdjacent(input, time, rec)) {
        merged.push({
          kind: "recurrence",
          start: time.start,
          end: rec.end,
          raw: input.slice(time.start, rec.end),
        });
        consumed.add(rec);
        consumed.add(time);
      } else if (isAdjacent(input, rec, time)) {
        // Never actually reached today: an "at HH:MM" clause immediately
        // after "every ..." is already inside ../recurrence/parser.ts's
        // own grammar, so matchRecurrencePhrase's own span already
        // swallows it before this function ever sees two separate
        // candidates for it (`take pills every day at 5pm`, this
        // module's own comment on `matchRecurrencePhrase`'s trailing
        // clause). Kept for the reverse direction's own symmetry and as
        // a guard against that no longer being true.
        merged.push({
          kind: "recurrence",
          start: rec.start,
          end: time.end,
          raw: input.slice(rec.start, time.end),
        });
        consumed.add(rec);
        consumed.add(time);
      }
    }
  }

  // Recurrence + "starting" + a date-shaped phrase the recurrence
  // grammar itself doesn't parse (`every day starting next monday`) —
  // the one named exception to "adjacent means only whitespace": exactly
  // one "starting" between the two, nothing else.
  for (const rec of recurrenceCandidates) {
    if (consumed.has(rec)) {
      continue;
    }
    for (const date of dateCandidates) {
      if (rec.end >= date.start) {
        continue;
      }
      const between = input.slice(rec.end, date.start);
      if (/^\s*starting\s+$/i.test(between)) {
        merged.push({
          kind: "recurrence",
          start: rec.start,
          end: date.end,
          raw: input.slice(rec.start, date.end),
        });
        consumed.add(rec);
        consumed.add(date);
      }
    }
  }

  // Date + time (`today at 5pm`, `tomorrow morning`, `mon 9am`) — the
  // merged token's own `date` is the two source tokens' values joined
  // directly (`YYYY-MM-DD` + `T` + `HH:MM`): a plain date word already
  // pins the day explicitly, so no roll-forward question even arises,
  // exactly as ../parse-quick-add.ts's own `mergeDateAndTime` reasons
  // for an explicit date token. A date candidate is consumed the moment
  // it's adjacent to a time candidate at all — even when that time was
  // already claimed by a *different*, higher-priority merge above (`Buy
  // milk tomorrow at 5pm every week p2`'s own corpus row: `tomorrow` is
  // adjacent to `at 5pm`, which the recurrence+time merge above already
  // claimed for `at 5pm every week`) — so `tomorrow` is consumed, and
  // therefore absent from `survivors` below, without a second,
  // conflicting merge token ever being produced for the same `at 5pm`
  // span.
  for (const date of dateCandidates) {
    if (consumed.has(date) || date.kind !== "date") {
      continue;
    }
    for (const time of timeCandidates) {
      if (time.kind !== "time" || !isAdjacent(input, date, time)) {
        continue;
      }
      consumed.add(date);
      if (consumed.has(time)) {
        continue; // Already claimed by a different merge above — attempted, not completed.
      }
      merged.push({
        kind: "date",
        start: date.start,
        end: time.end,
        raw: input.slice(date.start, time.end),
        date: `${date.date.slice(0, 10)}T${time.time}`,
      });
      consumed.add(time);
    }
  }

  // Recurrence candidates first, then date, then time — the identical
  // "compound wins over the bare word it's built from" priority this
  // parser already had (`every monday` over plain `monday`, pushed in
  // that order by the pre-#384 candidate list this function replaces),
  // preserved here as this function's own internal ordering rather than
  // inverted by folding everything into one list.
  const survivors = [...recurrenceCandidates, ...dateCandidates, ...timeCandidates].filter(
    (token) => !consumed.has(token),
  );
  return [...merged, ...survivors];
}

/**
 * Runs `matchers` against `phrase` and returns the first candidate that
 * consumes the *entire* trimmed phrase — the mechanism `!reminder`
 * (./rules.ts) uses to ask "is this prefixed text a recognisable whole
 * time," reusing the identical matcher functions free-text scanning uses
 * rather than a second, hand-written "parse one phrase" grammar that
 * could drift from the first. A partial match (the phrase has a
 * time-shaped prefix and trailing junk) is deliberately not good enough
 * here — free-text scanning already finds a time wherever one appears;
 * the whole point of requiring a whole-phrase match is that the user
 * drew the boundary themselves (the `!` they typed), so this only
 * honours a phrase that fits it exactly. (Deadline's `{}` used to be
 * this function's other caller, matched against `matchDateForms` — issue
 * #377 removed both along with the token kind they built.)
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
