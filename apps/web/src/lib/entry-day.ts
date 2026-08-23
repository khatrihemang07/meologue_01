import { toLocalParts } from "@meologue/core";

/**
 * The local day an Entry belongs to, as YYYY-MM-DD (ticket 52).
 *
 * This delegates to the very same helper Export groups its per-day files with
 * (`toLocalParts`, ADR 0016) rather than slicing the ISO string or reading the
 * host's timezone. That is the whole point: the day separators a user reads in
 * History and the day files they get in an Export have to agree, and the only
 * way to guarantee that near midnight is to share the rule rather than restate
 * it. `offsetMinutes` is minutes *east* of UTC, matching that helper's sign
 * convention — see `deviceUtcOffsetMinutes` below, which is the only place the
 * host's own timezone is ever consulted.
 */
export function entryDayKey(createdAt: string, offsetMinutes: number): string | null {
  if (Number.isNaN(Date.parse(createdAt))) {
    return null;
  }
  return toLocalParts(createdAt, offsetMinutes).date;
}

/**
 * Minutes east of UTC for this Device, right now. `getTimezoneOffset` reports
 * minutes *west*, so the sign is flipped here rather than at each call site —
 * settings-page.tsx already flips it the same way when exporting.
 */
export function deviceUtcOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

const DAY_MS = 86_400_000;

function shiftDayKey(dayKey: string, days: number): string | null {
  const parsed = Date.parse(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * `toLocaleDateString`/`toLocaleTimeString` *with* an options bag skip V8's
 * cached-formatter fast path (the one that applies to the zero-argument
 * form) and build a brand-new `Intl.DateTimeFormat` internally on every
 * call — for `formatClockTime` below, that was roughly one fresh formatter
 * per Entry row per History render (issue #81). Each formatter this module
 * needs is built once, lazily (only if this module's caller ever actually
 * formats something — a pure-data test importing `entryDayKey` alone
 * shouldn't pay for a clock formatter it never uses), and reused from then
 * on via these tiny memoising getters.
 *
 * `formatDaySeparator`'s options bag isn't fixed the way `formatClockTime`'s
 * is — it conditionally adds `year` — so a single cached instance can't
 * serve both shapes; a two-entry cache keyed on that boolean does. Neither
 * formatter's options depend on a per-call *timeZone*, so unlike
 * `formatDaySeparatorTitle` in history.tsx (whose own comment covers that
 * check), no larger keyed cache is needed here.
 */
let clockFormatter: Intl.DateTimeFormat | undefined;
function getClockFormatter(): Intl.DateTimeFormat {
  if (clockFormatter === undefined) {
    clockFormatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return clockFormatter;
}

const daySeparatorFormatters = new Map<boolean, Intl.DateTimeFormat>();
function getDaySeparatorFormatter(includeYear: boolean): Intl.DateTimeFormat {
  let formatter = daySeparatorFormatters.get(includeYear);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(undefined, {
      timeZone: "UTC",
      month: "long",
      day: "numeric",
      ...(includeYear ? { year: "numeric" } : {}),
    });
    daySeparatorFormatters.set(includeYear, formatter);
  }
  return formatter;
}

/**
 * The label a day separator carries (ticket 52) — "Today", "Yesterday", or a
 * date. The separator is what carries the date in this design, which is what
 * lets each Entry below it show a clock time alone.
 *
 * Both keys are plain YYYY-MM-DD in the Device's local day, so the comparison
 * is string equality and the arithmetic runs in UTC on values that are already
 * local — no second timezone conversion, and no chance of a DST-length day
 * shifting the answer. The year appears only when it isn't the current one,
 * for the same reason the time is clock-only: don't repeat what the reader
 * already knows.
 */
export function formatDaySeparator(dayKey: string, todayKey: string): string {
  if (dayKey === todayKey) {
    return "Today";
  }
  if (dayKey === shiftDayKey(todayKey, -1)) {
    return "Yesterday";
  }
  const parsed = Date.parse(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) {
    return dayKey;
  }
  const includeYear = dayKey.slice(0, 4) !== todayKey.slice(0, 4);
  return getDaySeparatorFormatter(includeYear).format(parsed);
}

/**
 * An Entry's capture time, clock only (ticket 52) — the day separator above it
 * already says which day it was, so repeating the date on every row is noise.
 * The full date and weekday stay available on hover through
 * `formatAbsoluteTime` (entry-time.ts), which is why nothing is lost here.
 */
export function formatClockTime(createdAt: string): string | null {
  const parsed = Date.parse(createdAt);
  return Number.isNaN(parsed) ? null : getClockFormatter().format(parsed);
}
