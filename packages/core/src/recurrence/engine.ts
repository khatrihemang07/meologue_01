import {
  addDays,
  addMonths,
  addYears,
  daysInMonth,
  type Epoch,
  epochOf,
  formatFloating,
  nextWeekdayAfter,
  nthWeekdayOfMonth,
  parseFloating,
  ymdOf,
} from "./calendar";
import type { MonthDay, RecurrenceOutcome, RecurrenceReference, RecurrenceRule } from "./rule";
import { WEEKDAY_INDEX } from "./tokens";

// Every frequency this grammar accepts steps forward by at least a day
// per call to stepOnce, and `reference.now` is a real calendar date, not
// an astronomically distant one — so this can't be reached by any string
// parseRecurrence accepts today. A hard stop rather than an infinite loop
// if a future grammar change ever makes it reachable (a zero-interval
// rule, say, which nothing here currently produces).
const MAX_STEPS = 10_000;

/**
 * Computes the next occurrence a parsed RecurrenceRule produces, strictly
 * after `reference.now` — "only future dates are ever scheduled," which
 * is also what makes this the one place a late completion's missed
 * occurrences get skipped rather than replayed one at a time (see
 * ../recurrence.ts's module doc comment for the worked eighteen-months-
 * late example). Never reads a clock itself: every date this needs
 * arrives through `reference`, which is what keeps this — and therefore
 * the whole package, since parseRecurrence has no dates in it at all — a
 * pure function of its arguments.
 */
export function computeNextOccurrence(
  rule: RecurrenceRule,
  reference: RecurrenceReference,
): RecurrenceOutcome {
  const nowFloating = parseFloating(reference.now);
  const dueFloating = reference.dueDate === null ? null : parseFloating(reference.dueDate);

  // The anchor is already resolved onto the rule by the parser
  // (rule.anchor) — this function only ever reads it, never re-derives
  // the `!`/day-week exception itself. A due-anchored rule with no prior
  // due date (a Task being scheduled for the first time) has nothing to
  // anchor to but now.
  const originEpoch =
    rule.anchor === "due" && dueFloating !== null ? dueFloating.epoch : nowFloating.epoch;

  const startBoundEpoch =
    rule.startBound === null ? null : resolveBoundDate(rule.startBound, originEpoch);

  let candidate = originEpoch;
  let steps = 0;
  do {
    candidate = stepOnce(candidate, rule);
    steps += 1;
    if (steps > MAX_STEPS) {
      throw new Error("recurrence stepping did not converge within 10,000 steps");
    }
  } while (
    candidate <= nowFloating.epoch ||
    (startBoundEpoch !== null && candidate < startBoundEpoch)
  );

  const endBoundEpoch = resolveEndBound(rule, originEpoch, startBoundEpoch);
  if (endBoundEpoch !== null && candidate > endBoundEpoch) {
    return { kind: "ended" };
  }

  return { kind: "occurrence", date: formatFloating(candidate, rule.time) };
}

// One period forward from `epoch`, per the rule's own frequency kind —
// the primitive computeNextOccurrence's loop repeats until the result
// clears `reference.now` (and any start bound), which is what turns "one
// step" into "skip every missed occurrence" for a stale due date.
function stepOnce(epoch: Epoch, rule: RecurrenceRule): Epoch {
  switch (rule.frequency.kind) {
    case "daily":
      return addDays(epoch, rule.interval);
    case "weekly":
      return addDays(epoch, rule.interval * 7);
    case "workdays":
      return nextMatchingWeekday(epoch, [1, 2, 3, 4, 5]);
    case "weekdays":
      return nextMatchingWeekday(
        epoch,
        rule.frequency.days.map((day) => WEEKDAY_INDEX[day]),
      );
    case "monthly":
      return addMonths(epoch, rule.interval);
    case "yearly":
      return addYears(epoch, rule.interval);
    case "monthlyOrdinalWeekday":
      return nextOrdinalWeekday(epoch, rule.frequency.ordinal, WEEKDAY_INDEX[rule.frequency.day]);
  }
}

// The earliest of several target weekdays strictly after `epoch` —
// `targets` is never empty: the parser only ever produces a `weekdays`
// rule with at least one day (its own weekdayParts check), and
// `workdays` above always passes a fixed five-element array.
function nextMatchingWeekday(epoch: Epoch, targets: readonly number[]): Epoch {
  let earliest: Epoch | null = null;
  for (const target of targets) {
    const candidate = nextWeekdayAfter(epoch, target);
    if (earliest === null || candidate < earliest) {
      earliest = candidate;
    }
  }
  return earliest as Epoch;
}

// The ordinal weekday of the month *after* `epoch`'s own — origin is
// itself normally already this month's Nth weekday (the last due date),
// so "one step" for this frequency kind means next month's occurrence,
// never a second candidate inside the same month.
function nextOrdinalWeekday(epoch: Epoch, ordinal: number, targetWeekday: number): Epoch {
  const { year, month } = ymdOf(epoch);
  const totalMonths = year * 12 + (month - 1) + 1;
  const nextYear = Math.floor(totalMonths / 12);
  const nextMonth = totalMonths - nextYear * 12 + 1;
  return nthWeekdayOfMonth(nextYear, nextMonth, ordinal, targetWeekday);
}

// A MonthDay carries no year of its own unless the text spelled one out
// (./rule.ts's own doc comment) — resolved here against whichever year
// `originEpoch` (the anchor this specific computation is using) falls in,
// clamped the same way addMonths/addYears clamp a day that doesn't exist
// in the resolved year (29 Feb in a non-leap one).
function resolveBoundDate(bound: MonthDay, originEpoch: Epoch): Epoch {
  const year = bound.year ?? ymdOf(originEpoch).year;
  const clampedDay = Math.min(bound.day, daysInMonth(year, bound.month));
  return epochOf(year, bound.month, clampedDay);
}

// An explicit "ending" clause always wins. Failing that, "for N unit(s)"
// is measured from the explicit "starting" bound if the rule has one, or
// else from this computation's own anchor — a deliberate simplification,
// worth naming rather than leaving implicit: since dateString is
// re-parsed fresh on every completion (../recurrence.ts's module doc
// comment) rather than remembered, this function has no memory of when
// the very first occurrence happened, only of whichever anchor the
// *current* call is using. For a due-anchored rule that anchor is the
// Task's current due date each time, so "for 3 weeks" with no explicit
// start stays correct through repeated completions; a completion-
// anchored rule's anchor is always `now`, so the same clause there
// effectively re-measures its window from whichever completion is being
// processed, rather than from a fixed start.
function resolveEndBound(
  rule: RecurrenceRule,
  originEpoch: Epoch,
  startBoundEpoch: Epoch | null,
): Epoch | null {
  if (rule.endBound !== null) {
    return resolveBoundDate(rule.endBound, originEpoch);
  }
  if (rule.durationBound === null) {
    return null;
  }
  const durationOrigin = startBoundEpoch ?? originEpoch;
  return addUnit(durationOrigin, rule.durationBound.count, rule.durationBound.unit);
}

function addUnit(epoch: Epoch, count: number, unit: "day" | "week" | "month" | "year"): Epoch {
  switch (unit) {
    case "day":
      return addDays(epoch, count);
    case "week":
      return addDays(epoch, count * 7);
    case "month":
      return addMonths(epoch, count);
    case "year":
      return addYears(epoch, count);
  }
}
