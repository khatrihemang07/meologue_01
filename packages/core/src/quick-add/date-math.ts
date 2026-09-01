/**
 * Pure calendar arithmetic over `YYYY-MM-DD` strings — the one place this
 * module's date rules (./rules.ts) do day/month/year math, rather than
 * each rule reaching for `Date` arithmetic on its own and risking a
 * timezone-dependent off-by-one.
 *
 * Every function here builds its intermediate `Date` at UTC midnight and
 * reads it back with the UTC getters, never the local ones — not because
 * a Task's `date` is a UTC instant (../task-types.ts's own doc comment on
 * `Task.date` is explicit that it's the opposite: floating, "9am
 * wherever the Device reading it happens to be"), but because pinning
 * the *arithmetic* to one fixed zone is what keeps "add 3 days" from
 * landing on the wrong calendar date around a DST transition in whatever
 * zone the process happens to be running in. The input and output are
 * both plain calendar strings with no zone attached; UTC is only ever an
 * implementation detail of how the middle of this file counts.
 */

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}/;

interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number;
}

/** Parses the leading `YYYY-MM-DD` off a date-only or floating-timed string (../task-types.ts's `Task.date` encoding) — only the calendar-day prefix is read, exactly as ../task-views.ts's `today()` does. */
export function parseDateOnly(date: string): CalendarDate {
  const match = DATE_ONLY_PATTERN.exec(date);
  if (match === null) {
    throw new Error(`expected a "YYYY-MM-DD"-prefixed date, got ${JSON.stringify(date)}`);
  }
  const [year, month, day] = match[0].split("-").map(Number);
  // biome-ignore lint/style/noNonNullAssertion: the regex above guarantees three numeric groups
  return { year: year!, month: month!, day: day! };
}

function toUtcTimestamp({ year, month, day }: CalendarDate): number {
  return Date.UTC(year, month - 1, day);
}

function formatCalendarDate(timestamp: number): string {
  const d = new Date(timestamp);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** `YYYY-MM-DD` for `{ year, month, day }`, with no validation beyond what `Date.UTC` itself normalises (a caller passing an out-of-range day gets JS's own rollover, not a thrown error — see ./rules.ts's callers for why an out-of-range absolute date is instead refused before it reaches here). */
export function formatDate(date: CalendarDate): string {
  return formatCalendarDate(toUtcTimestamp(date));
}

/** Adds `days` (negative allowed) to a `YYYY-MM-DD`-prefixed string, returning `YYYY-MM-DD`. */
export function addDays(date: string, days: number): string {
  const parsed = parseDateOnly(date);
  return formatCalendarDate(toUtcTimestamp(parsed) + days * MILLISECONDS_PER_DAY);
}

/**
 * Adds calendar months, clamping the day into the resulting month rather
 * than overflowing into the month after — `31 Jan` plus 1 month is
 * `28 Feb` (or `29 Feb` in a leap year), not `3 Mar`, matching the
 * everyday reading of "a month from now" over the literal "add this many
 * days" a naive `Date.UTC` overflow would give.
 */
export function addMonths(date: string, months: number): string {
  const parsed = parseDateOnly(date);
  const totalMonths = parsed.month - 1 + months;
  const year = parsed.year + Math.floor(totalMonths / 12);
  const month = ((totalMonths % 12) + 12) % 12; // 0-11, always non-negative
  const lastDayOfMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(parsed.day, lastDayOfMonth);
  return formatDate({ year, month: month + 1, day });
}

/** Adds calendar years — `addMonths(date, years * 12)`, so `29 Feb` in a leap year lands on `28 Feb` in a non-leap target year rather than overflowing into March, for the identical reason addMonths clamps. */
export function addYears(date: string, years: number): string {
  return addMonths(date, years * 12);
}

/** ISO weekday of a `YYYY-MM-DD`-prefixed string: 1 (Monday) through 7 (Sunday), matching QuickAddLanguage.weekdays' own convention. */
export function isoWeekday(date: string): number {
  const parsed = parseDateOnly(date);
  // JS's own getUTCDay() is 0 (Sunday) - 6 (Saturday); remap to ISO's
  // 1 (Monday) - 7 (Sunday) so this agrees with QuickAddLanguage.weekdays
  // without every caller re-doing the same `=== 0 ? 7 : x` each time.
  const jsWeekday = new Date(toUtcTimestamp(parsed)).getUTCDay();
  return jsWeekday === 0 ? 7 : jsWeekday;
}

/** `HH:MM`, zero-padded — the floating time-of-day suffix ../task-types.ts's `Task.date` carries after the `T`. */
export function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
