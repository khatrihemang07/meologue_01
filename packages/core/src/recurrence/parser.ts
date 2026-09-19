import type {
  MonthDay,
  RecurrenceFrequency,
  RecurrenceParseResult,
  RecurrenceUnit,
  Weekday,
} from "./rule";
import { MONTH_TOKENS, ORDINAL_TOKENS, UNIT_TOKENS, WEEKDAY_TOKENS } from "./tokens";

const EVERY_PREFIX = /^every(!)?\s+/;
const EXCLUSION_WORDS = /\b(except|excluding|but not)\b/;
const TIME_CLAUSE = /\bat\s+([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)?\b/gi;
const DURATION_CLAUSE = /\bfor\s+(\d+)\s+(day|days|week|weeks|month|months|year|years)\b/i;
const STARTING_CLAUSE = /\bstarting\s+(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?\b/i;
const ENDING_CLAUSE = /\bending\s+(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?\b/i;
const ORDINAL_WEEKDAY_CLAUSE = new RegExp(
  `\\b(${[...ORDINAL_TOKENS.keys()].join("|")})\\s+(${[...WEEKDAY_TOKENS.keys()].join("|")})\\b`,
  "i",
);
const MONTH_INTERVAL_CLAUSE = /\b(\d+|other)\s+months?\b/i;
const UNIT_FORM = /^(\d+\s+|other\s+)?(day|days|week|weeks|month|months|year|years)$/;
// "every quarter" / "every 2 quarters" / "every other quarter" — a
// quarter is exactly three months, so this never reaches ./engine.ts as
// its own frequency kind; parseFrequency below folds it straight into
// `monthly` with the interval tripled (issue #368's own framing: "free
// once workdays and ordinal months are in").
const QUARTER_FORM = /^(\d+\s+|other\s+)?quarters?$/;
const ORDINAL_WEEKDAY_FORM = /^(\S+)\s+(\S+)$/;
// The month-scoped sibling of ORDINAL_WEEKDAY_FORM above — "3rd wed jan"
// rather than "3rd friday" — used both for a single entry and, split on
// commas first, for every entry of a monthlyOrdinalWeekdayList.
const ORDINAL_WEEKDAY_MONTH_FORM = /^(\S+)\s+(\S+)\s+(\S+)$/;
// Same interval-prefix shape UNIT_FORM and QUARTER_FORM use, applied to
// "workday(s)" — issue #368: the interval was previously silently
// dropped because this shape didn't parse it at all.
const WORKDAY_FORM = /^(\d+\s+|other\s+)?workdays?$/;

/**
 * Parses one recurrence rule from its literal, user-typed text
 * (CONTEXT.md's Recurrence entry — the string, never a computed date, is
 * the thing this whole package treats as the truth). English only: every
 * literal word this function matches against comes from ./tokens.ts,
 * never hard-coded here — see that file's own doc comment and ./rule.ts's
 * for the language seam this split exists to keep open.
 *
 * A refusal is a value, not a throw (../recurrence.ts's module doc
 * comment explains why): every string a user can actually type into the
 * add field reaches here, and "unrecognised text" is exactly as expected
 * an outcome as "recognised text" — a caller distinguishes the two by
 * `result.kind`.
 *
 * Processing order matters and is deliberate: `every`/`every!` is
 * stripped first (it's the one fixed anchor every other clause sits
 * after), exclusion words are refused before anything else is even
 * attempted (there's no repair for a clause this grammar doesn't
 * support), then the optional clauses — time, duration, start, end — are
 * each extracted independently and removed from the working text, so
 * whatever remains is exactly the frequency core with nothing left to
 * confuse it.
 */
export function parseRecurrence(input: string): RecurrenceParseResult {
  const trimmed = input.trim();
  if (trimmed === "") {
    return refused("empty recurrence text");
  }
  const lowered = trimmed.toLowerCase();

  const everyMatch = EVERY_PREFIX.exec(lowered);
  if (everyMatch === null) {
    return refused('a recurrence rule must start with "every"');
  }
  const bang = everyMatch[1] === "!";
  let text = lowered.slice(everyMatch[0].length).trim();

  if (EXCLUSION_WORDS.test(text)) {
    return refused('exclusion clauses ("except", "excluding", "but not") aren\'t supported');
  }

  // Time: at most one "at HH[:MM][am|pm]" clause — the issue's own first
  // named refusal ("no two different times in one rule"). Matched
  // globally *before* either is removed, or removing the first would
  // leave the second looking like the only one.
  const timeMatches = [...text.matchAll(TIME_CLAUSE)];
  if (timeMatches.length > 1) {
    return refused("a recurrence rule can carry only one time of day");
  }
  let time: string | null = null;
  if (timeMatches.length === 1) {
    const match = timeMatches[0];
    if (match === undefined) {
      return refused("unrecognised time clause");
    }
    time = to24Hour(match);
    text = removeMatch(text, match);
  }

  // Bounds: "for N unit(s)", "starting D Mon [YYYY]", "ending D Mon
  // [YYYY]" — each keyword-anchored and independent, so all three can be
  // extracted in any order without one clause's own regex eating another
  // clause's words.
  let durationBound: { count: number; unit: RecurrenceUnit } | null = null;
  const durationMatch = DURATION_CLAUSE.exec(text);
  if (durationMatch !== null) {
    const unitWord = durationMatch[2];
    const unit = unitWord === undefined ? undefined : UNIT_TOKENS.get(unitWord);
    if (unit === undefined) {
      return refused(`unrecognised duration unit "${unitWord}"`);
    }
    const count = durationMatch[1];
    durationBound = { count: Number(count), unit };
    text = removeMatch(text, durationMatch);
  }

  let startBound: MonthDay | null = null;
  const startingMatch = STARTING_CLAUSE.exec(text);
  if (startingMatch !== null) {
    const resolved = toMonthDay(startingMatch);
    if (resolved === null) {
      return refused(`unrecognised start date "${startingMatch[0]}"`);
    }
    startBound = resolved;
    text = removeMatch(text, startingMatch);
  }

  let endBound: MonthDay | null = null;
  const endingMatch = ENDING_CLAUSE.exec(text);
  if (endingMatch !== null) {
    const resolved = toMonthDay(endingMatch);
    if (resolved === null) {
      return refused(`unrecognised end date "${endingMatch[0]}"`);
    }
    endBound = resolved;
    text = removeMatch(text, endingMatch);
  }

  const core = collapseWhitespace(text);
  if (core === "") {
    return refused('missing recurrence frequency after "every"');
  }

  // The one crossed-grammar refusal the issue names explicitly: an
  // ordinal weekday ("3rd friday") is itself an implicit *monthly*
  // cadence, so an explicit monthly interval alongside it ("every 3
  // months on the 3rd friday") asks for two different months-per-
  // occurrence at once. Checked here, against the whole core, because by
  // the time either half is parsed on its own below there's no trace of
  // the other half left to compare against.
  if (MONTH_INTERVAL_CLAUSE.test(core) && ORDINAL_WEEKDAY_CLAUSE.test(core)) {
    return refused("an ordinal weekday can't be combined with an explicit monthly interval");
  }

  const frequencyResult = parseFrequency(core);
  if (frequencyResult === null) {
    return refused(`unrecognised recurrence pattern "${trimmed}"`);
  }
  const { frequency, interval } = frequencyResult;

  return {
    kind: "parsed",
    rule: {
      frequency,
      interval,
      anchor: resolveAnchor(bang),
      time,
      startBound,
      endBound,
      durationBound,
    },
  };
}

function refused(reason: string): RecurrenceParseResult {
  return { kind: "refused", reason };
}

function removeMatch(text: string, match: RegExpMatchArray): string {
  const start = match.index ?? 0;
  const end = start + match[0].length;
  return collapseWhitespace(`${text.slice(0, start)} ${text.slice(end)}`);
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// match: [full, hour, minute?, meridiem?] — "at 9" with neither a colon
// nor am/pm defaults to a 24-hour hour with :00 minutes, the same
// leniency "17:00" already implies without needing am/pm at all.
function to24Hour(match: RegExpMatchArray): string {
  let hour = Number(match[1]);
  const minute = match[2] !== undefined ? Number(match[2]) : 0;
  const meridiem = match[3];
  if (meridiem === "pm" && hour !== 12) {
    hour += 12;
  }
  if (meridiem === "am" && hour === 12) {
    hour = 0;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// match: [full, day, monthWord, year?] from STARTING_CLAUSE/ENDING_CLAUSE.
// The year is left unresolved when the text doesn't carry one — see
// MonthDay's own doc comment (./rule.ts) for why the anchor a
// computation eventually runs against is what resolves it, not this
// function.
function toMonthDay(match: RegExpMatchArray): MonthDay | null {
  const dayText = match[1];
  const monthWord = match[2];
  const yearText = match[3];
  if (dayText === undefined || monthWord === undefined) {
    return null;
  }
  const month = MONTH_TOKENS.get(monthWord);
  if (month === undefined) {
    return null;
  }
  const day = Number(dayText);
  if (day < 1 || day > 31) {
    return null;
  }
  return { month, day, year: yearText === undefined ? null : Number(yearText) };
}

/**
 * Reads whatever's left after every clause above has been stripped out —
 * "the frequency core" — and decides which RecurrenceFrequency it names,
 * trying each recognised shape in turn: a bare weekday list first (a
 * closed vocabulary, so it can never be mistaken for anything else), then
 * workdays (with its own optional interval prefix, issue #368), then
 * ordinal-weekday-with-month — one entry or several, comma-separated
 * (issue #368's `monthlyOrdinalWeekday`/`monthlyOrdinalWeekdayList`) —
 * then the plain (unscoped) ordinal weekday, then "every quarter" folded
 * into a tripled monthly interval, then a plain interval-of-a-unit.
 * `null` means none of them matched — parseRecurrence turns that into its
 * own "unrecognised recurrence pattern" refusal, quoting the original
 * text rather than this stripped-down core.
 */
function parseFrequency(core: string): { frequency: RecurrenceFrequency; interval: number } | null {
  const stripped = stripFiller(core);

  // Named weekday(s): every part of a comma/"and"-separated list has to
  // be a weekday token, or this isn't a weekday-list rule at all — a
  // partial match falls through to the next form rather than silently
  // discarding whatever didn't match.
  const weekdayParts = stripped.split(/\s*(?:,|&|\band\b)\s*/).filter((part) => part !== "");
  if (weekdayParts.length > 0 && weekdayParts.every((part) => WEEKDAY_TOKENS.has(part))) {
    const days = weekdayParts.map((part) => WEEKDAY_TOKENS.get(part) as Weekday);
    return { frequency: { kind: "weekdays", days }, interval: 1 };
  }

  const workdayMatch = WORKDAY_FORM.exec(stripped);
  if (workdayMatch !== null) {
    const prefix = workdayMatch[1]?.trim();
    const interval = prefix === undefined ? 1 : prefix === "other" ? 2 : Number(prefix);
    return { frequency: { kind: "workdays" }, interval };
  }

  // Ordinal-weekday-with-month, one entry or a comma/"and"-separated
  // several: every part has to be a full (ordinal, weekday, month) triple
  // or this isn't this shape at all — same "every part or none" rule the
  // bare weekday list above uses. A single matching part folds into the
  // ordinary `monthlyOrdinalWeekday` (with `month` set, rather than a
  // one-element list); two or more become `monthlyOrdinalWeekdayList`,
  // since only then is there a real "earliest across several" question
  // for ./engine.ts to answer.
  const ordinalMonthParts = stripped.split(/\s*(?:,|&|\band\b)\s*/).filter((part) => part !== "");
  if (ordinalMonthParts.length > 0) {
    const entries: { ordinal: number; day: Weekday; month: number }[] = [];
    let everyPartMatched = true;
    for (const part of ordinalMonthParts) {
      const match = ORDINAL_WEEKDAY_MONTH_FORM.exec(part);
      const ordinalWord = match?.[1];
      const weekdayWord = match?.[2];
      const monthWord = match?.[3];
      const ordinal = ordinalWord === undefined ? undefined : ORDINAL_TOKENS.get(ordinalWord);
      const weekday = weekdayWord === undefined ? undefined : WEEKDAY_TOKENS.get(weekdayWord);
      const month = monthWord === undefined ? undefined : MONTH_TOKENS.get(monthWord);
      if (ordinal === undefined || weekday === undefined || month === undefined) {
        everyPartMatched = false;
        break;
      }
      entries.push({ ordinal, day: weekday, month });
    }
    if (everyPartMatched && entries.length === 1) {
      const entry = entries[0];
      if (entry !== undefined) {
        return {
          frequency: {
            kind: "monthlyOrdinalWeekday",
            ordinal: entry.ordinal,
            day: entry.day,
            month: entry.month,
          },
          interval: 1,
        };
      }
    }
    if (everyPartMatched && entries.length > 1) {
      return { frequency: { kind: "monthlyOrdinalWeekdayList", entries }, interval: 1 };
    }
  }

  const ordinalWeekdayMatch = ORDINAL_WEEKDAY_FORM.exec(stripped);
  if (ordinalWeekdayMatch !== null) {
    const ordinalWord = ordinalWeekdayMatch[1];
    const weekdayWord = ordinalWeekdayMatch[2];
    const ordinal = ordinalWord === undefined ? undefined : ORDINAL_TOKENS.get(ordinalWord);
    const weekday = weekdayWord === undefined ? undefined : WEEKDAY_TOKENS.get(weekdayWord);
    if (ordinal !== undefined && weekday !== undefined) {
      return {
        frequency: { kind: "monthlyOrdinalWeekday", ordinal, day: weekday, month: null },
        interval: 1,
      };
    }
  }

  const quarterMatch = QUARTER_FORM.exec(stripped);
  if (quarterMatch !== null) {
    const prefix = quarterMatch[1]?.trim();
    const quarterCount = prefix === undefined ? 1 : prefix === "other" ? 2 : Number(prefix);
    return { frequency: { kind: "monthly" }, interval: quarterCount * 3 };
  }

  const unitMatch = UNIT_FORM.exec(stripped);
  if (unitMatch !== null) {
    const prefix = unitMatch[1]?.trim();
    const unitWord = unitMatch[2];
    const unit = unitWord === undefined ? undefined : UNIT_TOKENS.get(unitWord);
    if (unit === undefined) {
      return null;
    }
    const interval = prefix === undefined ? 1 : prefix === "other" ? 2 : Number(prefix);
    const kind =
      unit === "day"
        ? "daily"
        : unit === "week"
          ? "weekly"
          : unit === "month"
            ? "monthly"
            : "yearly";
    return { frequency: { kind }, interval };
  }

  return null;
}

// "the 3rd friday" and "on the 3rd friday" both name the same rule as
// "3rd friday" — these two words carry no meaning to the grammar itself,
// so they're removed before any of parseFrequency's own shape-matching
// runs, rather than every one of its regexes having to tolerate them
// appearing or not.
function stripFiller(core: string): string {
  return collapseWhitespace(core.replace(/\bthe\b/g, " ").replace(/\bon\b/g, " "));
}

function resolveAnchor(bang: boolean): "due" | "completion" {
  return bang ? "completion" : "due";
}
