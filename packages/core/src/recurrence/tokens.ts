import type { Weekday } from "./rule";

/**
 * Every English spelling this parser recognises, one table per concept —
 * the other half of the language seam ./rule.ts's own doc comment
 * describes: ./parser.ts never spells a weekday, month or ordinal word
 * literally inside a regular expression, it only ever reads one of these
 * tables. A second language's parser would replace this file's contents
 * (and nothing in ./rule.ts or ./engine.ts) to add itself.
 */

export const WEEKDAY_TOKENS: ReadonlyMap<string, Weekday> = new Map([
  ["sunday", "sunday"],
  ["sun", "sunday"],
  ["monday", "monday"],
  ["mon", "monday"],
  ["tuesday", "tuesday"],
  ["tue", "tuesday"],
  ["tues", "tuesday"],
  ["wednesday", "wednesday"],
  ["wed", "wednesday"],
  ["thursday", "thursday"],
  ["thu", "thursday"],
  ["thur", "thursday"],
  ["thurs", "thursday"],
  ["friday", "friday"],
  ["fri", "friday"],
  ["saturday", "saturday"],
  ["sat", "saturday"],
]);

/**
 * Canonical Sunday-first index — `Date.getUTCDay`'s own convention
 * (../recurrence/calendar.ts's weekdayOf), one named place the mapping
 * lives rather than every caller re-deriving it from scratch.
 */
export const WEEKDAY_INDEX: Readonly<Record<Weekday, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

/** Full names and three-letter abbreviations only — enough for "starting 1 Oct"/"ending 31 Dec", the grammar's own examples. */
export const MONTH_TOKENS: ReadonlyMap<string, number> = new Map([
  ["january", 1],
  ["jan", 1],
  ["february", 2],
  ["feb", 2],
  ["march", 3],
  ["mar", 3],
  ["april", 4],
  ["apr", 4],
  ["may", 5],
  ["june", 6],
  ["jun", 6],
  ["july", 7],
  ["jul", 7],
  ["august", 8],
  ["aug", 8],
  ["september", 9],
  ["sep", 9],
  ["sept", 9],
  ["october", 10],
  ["oct", 10],
  ["november", 11],
  ["nov", 11],
  ["december", 12],
  ["dec", 12],
]);

/**
 * Word or digit-suffix ordinals up to 5th, plus "last" — mapped to `-1`,
 * ./calendar.ts's nthWeekdayOfMonth sentinel for "count from the end of
 * the month instead of the start." Only as far as "5th" because a month
 * never has a 6th occurrence of any weekday to name.
 */
export const ORDINAL_TOKENS: ReadonlyMap<string, number> = new Map([
  ["1st", 1],
  ["first", 1],
  ["2nd", 2],
  ["second", 2],
  ["3rd", 3],
  ["third", 3],
  ["4th", 4],
  ["fourth", 4],
  ["5th", 5],
  ["fifth", 5],
  ["last", -1],
]);

export const UNIT_TOKENS: ReadonlyMap<string, RecurrenceUnitWord> = new Map([
  ["day", "day"],
  ["days", "day"],
  ["week", "week"],
  ["weeks", "week"],
  ["month", "month"],
  ["months", "month"],
  ["year", "year"],
  ["years", "year"],
]);

type RecurrenceUnitWord = "day" | "week" | "month" | "year";
