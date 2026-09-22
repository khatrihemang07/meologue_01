/**
 * Pure week/month arithmetic for issue #439's endless month list
 * (`month-list-calendar.tsx`) — no React, no virtualizer, so the shape of
 * "which week is at a given index" and "which month does a week belong to"
 * can be tested directly, without the jsdom/`@tanstack/react-virtual`
 * measuring dance `test/virtualized-scroll.ts`'s own header comment
 * describes. `month-list-calendar.tsx` is the only caller; it owns
 * everything about *rendering* a week (day cells, the busy dot, the
 * selected circle) and reads this module only for "which day is this",
 * never the other way around.
 *
 * ## The list's own indexing
 *
 * One list item = one week, Monday-first, index 0 = `minMonday` (the
 * earliest week the list ever shows — issue #439's own measured floor,
 * "current week's Monday," or an earlier bound `resolveMinMonday` accepts
 * for History's later #442 jump-to-day). `weekStartForIndex`/
 * `indexForWeekStart` are the inverse pair every other lookup in this
 * module (and the component) is built from — a Monday `Date` on one side,
 * a week-index `number` on the other, always relative to the same
 * `minMonday`.
 *
 * ## "Which month is this week"
 *
 * Todoist's own screenshot shows a LATER month's own in-list label ("Oct")
 * sitting on the week that first contains that month's 1st, not on the
 * following Monday-aligned week — so `effectiveMonthOfWeek` reads a week's
 * month as "whichever month's 1st falls inside this week, if any; that
 * week's own Monday's month otherwise." The pinned header's own month
 * label (`month-list-calendar.tsx`) reuses this exact function for the
 * topmost visible week, which is what makes the header flip to a later
 * month on the identical row the in-list label itself appears on, rather
 * than lagging a week behind it — a deliberate, documented choice (the
 * ticket's own measurement never pinned the exact frame), not a
 * coincidence of two independently-guessed rules agreeing.
 */
import { addDays, addMonths, addWeeks, differenceInCalendarWeeks, startOfWeek } from "date-fns";
import { localDayKey, parseDayKey } from "@/lib/local-day-key";

/** A calendar month, `month` 0-indexed (`Date.getMonth()`'s own convention) — never a `Date`, so two months compare by value (`sameMonthKey`) instead of by the arbitrary day-of-month a `Date` would otherwise carry. */
export interface MonthKey {
  readonly year: number;
  readonly month: number;
}

/** The Monday that starts `date`'s own week — the one week-alignment rule every function below shares, so a caller can never accidentally mix a Sunday-start and a Monday-start week index. */
export function mondayOfWeek(date: Date): Date {
  return startOfWeek(date, { weekStartsOn: 1 });
}

/** The Monday of the week `index` weeks after `minMonday` — index 0 is `minMonday` itself. */
export function weekStartForIndex(minMonday: Date, index: number): Date {
  return addWeeks(minMonday, index);
}

/** The inverse of `weekStartForIndex`: which index `weekStart` (itself already a Monday) sits at, relative to `minMonday`. */
export function indexForWeekStart(minMonday: Date, weekStart: Date): number {
  return differenceInCalendarWeeks(weekStart, minMonday, { weekStartsOn: 1 });
}

/** The 7 days of the week starting at `weekStart` (a Monday), Monday first. */
export function weekDays(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, offset) => addDays(weekStart, offset));
}

export function monthKeyOf(date: Date): MonthKey {
  return { year: date.getFullYear(), month: date.getMonth() };
}

export function sameMonthKey(a: MonthKey, b: MonthKey): boolean {
  return a.year === b.year && a.month === b.month;
}

/** This module's own header comment ("Which month is this week") has the full rule. */
export function effectiveMonthOfWeek(weekStart: Date): MonthKey {
  const days = weekDays(weekStart);
  const firstOfLaterMonth = days.find((day) => day.getDate() === 1);
  return monthKeyOf(firstOfLaterMonth ?? weekStart);
}

/** `delta` calendar months from `key` — always the 1st of the resulting month, so a caller only ever needs the `MonthKey` itself, never a day-of-month that could carry over oddly across a shorter month. */
export function neighborMonthKey(key: MonthKey, delta: number): MonthKey {
  return monthKeyOf(addMonths(new Date(key.year, key.month, 1), delta));
}

/** The week index that carries `key`'s own 1st — the row `effectiveMonthOfWeek` would label with it, and so the row `month-list-calendar.tsx`'s ‹/› buttons scroll to. */
export function indexOfMonthStart(minMonday: Date, key: MonthKey): number {
  return indexForWeekStart(minMonday, mondayOfWeek(new Date(key.year, key.month, 1)));
}

/**
 * `minDay`'s own resolution rule (issue #439's own acceptance criteria: "An
 * earlier start bound... can be supplied"; #442's own History caller is the
 * one that will actually pass one) — `undefined` means "no bound was
 * given," which defaults to `now`'s own current-week Monday, the ticket's
 * own measured floor. A caller-supplied `minDay` that fails to parse (never
 * expected from a typed caller, only reachable from a malformed prop) falls
 * back the same way, via `parseDayKey`'s own `undefined`-on-failure
 * contract, rather than throwing.
 */
export function resolveMinMonday(minDay: string | undefined, now: Date): Date {
  return mondayOfWeek(parseDayKey(minDay) ?? now);
}

/**
 * `initialDay`'s own resolution rule — `undefined` (or a day at/after
 * `minMonday`'s own week... see the clamp below) opens the list scrolled to
 * its own start, index 0. A day BEFORE `minMonday` is clamped up to 0
 * rather than producing a negative index `weekStartForIndex` would resolve
 * to a week that does not exist in the list at all — the same "a day
 * before the list's first day is simply not reachable" rule
 * `month-list-calendar.tsx`'s own `selectedDay` prop leans on for a
 * past-dated Task (this module's own header comment).
 */
export function resolveInitialIndex(minMonday: Date, initialDay: string | undefined): number {
  const day = parseDayKey(initialDay);
  if (day === undefined) {
    return 0;
  }
  return Math.max(indexForWeekStart(minMonday, mondayOfWeek(day)), 0);
}

/** `LocalDayKey`s the day-cell renderer below can compare against `datesWithTasks`/`selectedDay` directly, without re-deriving `localDayKey` per cell itself. */
export function weekDayKeys(weekStart: Date): string[] {
  return weekDays(weekStart).map((day) => localDayKey(day));
}
