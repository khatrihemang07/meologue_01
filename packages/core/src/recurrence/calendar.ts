/**
 * Pure Gregorian calendar arithmetic, used only for whole calendar days —
 * never a wall-clock instant. Built on `Date.UTC` and the `getUTC*`
 * family exclusively, on purpose: those are pure calendar math (no
 * runtime timezone, no DST) despite living on the same `Date` object a
 * careless `new Date(dateString)` or a local-time getter would turn into
 * exactly the kind of platform dependency this package's floating-date
 * discipline refuses (see ../task-fields.ts's DATE_PATTERN and
 * ../task-types.ts's own doc comment on `Task.date`). The alternative —
 * hand-rolling a civil-calendar/epoch-day conversion (the well-known
 * Howard Hinnant algorithm) — was rejected: it is no more "platform-free"
 * than the UTC methods below (both are pure functions, no I/O, no
 * ambient state), and re-deriving a subtle, easy-to-get-wrong algorithm
 * by hand is a worse bet than reusing ECMA-262's own, for a module whose
 * entire job is date arithmetic that ../engine.ts trusts without
 * re-checking it.
 *
 * Every function here is agnostic to what the day it operates on
 * *means* — recurrence.ts and engine.ts own that. This file only ever
 * answers "what calendar day is N days/months/years from this one" and
 * "what weekday does this calendar day fall on."
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A single calendar day, represented as the UTC-midnight instant of that
 * day — never read as a wall-clock time itself, only ever passed between
 * the functions in this file. Kept as a plain `number` (not a branded
 * type) because every caller of this module is inside `../recurrence/`
 * itself; nothing outside this package's recurrence engine ever sees an
 * `Epoch` value.
 */
export type Epoch = number;

export function epochOf(year: number, month: number, day: number): Epoch {
  return Date.UTC(year, month - 1, day);
}

export interface Ymd {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
}

export function ymdOf(epoch: Epoch): Ymd {
  const d = new Date(epoch);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * 0 = Sunday .. 6 = Saturday — `Date.getUTCDay`'s own convention, mirrored
 * by ./tokens.ts's WEEKDAY_INDEX so the two never drift apart.
 */
export function weekdayOf(epoch: Epoch): number {
  return new Date(epoch).getUTCDay();
}

export function daysInMonth(year: number, month: number): number {
  // Day 0 of the *next* month is the last day of this one — a Date.UTC
  // quirk this file leans on rather than hand-computing 30/31/28/29 with
  // a lookup table and a separate leap-year branch.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDays(epoch: Epoch, count: number): Epoch {
  return epoch + count * MS_PER_DAY;
}

/**
 * Clamped, never rolled into the following month: 31 Jan + 1 month is 28
 * (or 29) Feb, not 3 Mar — the same convention every calendar app takes,
 * and the only one that keeps "same day next month" a meaningful phrase
 * at all for a month whose length doesn't match the origin's.
 */
export function addMonths(epoch: Epoch, count: number): Epoch {
  const { year, month, day } = ymdOf(epoch);
  const totalMonths = year * 12 + (month - 1) + count;
  const nextYear = Math.floor(totalMonths / 12);
  const nextMonth = totalMonths - nextYear * 12 + 1;
  const clampedDay = Math.min(day, daysInMonth(nextYear, nextMonth));
  return epochOf(nextYear, nextMonth, clampedDay);
}

/** Same clamping as addMonths, for the one day a year — 29 Feb — it can ever matter for. */
export function addYears(epoch: Epoch, count: number): Epoch {
  const { year, month, day } = ymdOf(epoch);
  const nextYear = year + count;
  const clampedDay = Math.min(day, daysInMonth(nextYear, month));
  return epochOf(nextYear, month, clampedDay);
}

/** The next date strictly after `epoch` whose weekday is `targetWeekday` (weekdayOf's own 0-6 convention). */
export function nextWeekdayAfter(epoch: Epoch, targetWeekday: number): Epoch {
  let candidate = addDays(epoch, 1);
  while (weekdayOf(candidate) !== targetWeekday) {
    candidate = addDays(candidate, 1);
  }
  return candidate;
}

/**
 * The `ordinal`th `targetWeekday` of `year`/`month` — `ordinal` 1-5 counts
 * from the 1st, `-1` ("last", ./tokens.ts's ORDINAL_TOKENS) counts back
 * from the month's final day. Doesn't validate that a 5th occurrence
 * actually exists in every month (most months have only four of a given
 * weekday): "every 5th friday" is accepted by the parser and simply
 * produces whatever this function computes by walking past the month's
 * end into the next one, which ../engine.ts's own floor/bound checks
 * still apply to correctly. A known, narrow limitation — untested beyond
 * the one ordinal the issue itself names ("every 3rd friday") — rather
 * than a silent one.
 */
export function nthWeekdayOfMonth(
  year: number,
  month: number,
  ordinal: number,
  targetWeekday: number,
): Epoch {
  if (ordinal === -1) {
    let candidate = epochOf(year, month, daysInMonth(year, month));
    while (weekdayOf(candidate) !== targetWeekday) {
      candidate = addDays(candidate, -1);
    }
    return candidate;
  }
  let candidate = epochOf(year, month, 1);
  while (weekdayOf(candidate) !== targetWeekday) {
    candidate = addDays(candidate, 1);
  }
  return addDays(candidate, (ordinal - 1) * 7);
}

/**
 * Parses Task.date's own encoding (../task-fields.ts's DATE_PATTERN) —
 * `YYYY-MM-DD` or floating `YYYY-MM-DDTHH:MM` — into a calendar-day
 * `Epoch` plus whatever time-of-day the string carried. `time` is
 * returned for a caller that wants it, but never folded into `epoch`:
 * every comparison and every step this package makes is calendar-day-
 * granular, the same "only the first ten characters matter" convention
 * ../task-views.ts's today() already uses for the identical reason (a
 * Task due earlier *today* is still today, not overdue) — time-of-day is
 * a formatting concern for the final output (formatFloating below), never
 * an input to the stepping or floor logic in ../engine.ts.
 */
export function parseFloating(dateString: string): { epoch: Epoch; time: string | null } {
  const day = dateString.slice(0, 10);
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  const time = dateString.length > 10 ? dateString.slice(11, 16) : null;
  return { epoch: epochOf(year, month, date), time };
}

/** The inverse of parseFloating's `epoch` half — produces Task.date's own encoding, all-day if `time` is null. */
export function formatFloating(epoch: Epoch, time: string | null): string {
  const { year, month, day } = ymdOf(epoch);
  const datePart = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return time === null ? datePart : `${datePart}T${time}`;
}
