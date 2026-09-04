import {
  addDays,
  addMonths,
  addYears,
  daysInMonth,
  type Epoch,
  epochOf,
  formatFloating,
  nextWeekdayAfter,
  nextWeekdayOnOrAfter,
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
 * Which of the two questions computeOccurrence below is answering (issue
 * #191). Kept as a string union rather than a boolean on purpose: a
 * boolean's two states read as "on" and "off" of the same behaviour,
 * which is exactly the framing the issue rejects — these are two
 * different questions with two different answers, not one behaviour with
 * a toggle. Nothing outside this module ever sees this type: the public
 * surface is the two differently-named functions below, each hard-coding
 * which mode it means, so a caller of *either* can't get this wrong by
 * omission the way a shared boolean parameter would let them.
 */
type SearchMode = "afterCompletion" | "firstOccurrence";

/**
 * Computes the next occurrence a parsed RecurrenceRule produces once a
 * Task recurring on it has just been completed — strictly after
 * `reference.now`, "you just did it, the next one is tomorrow" (or
 * whatever the rule's own interval further out), which is also what makes
 * this the one place a late completion's missed occurrences get skipped
 * rather than replayed one at a time (see ../recurrence.ts's module doc
 * comment for the worked eighteen-months-late example). Never reads a
 * clock itself: every date this needs arrives through `reference`, which
 * is what keeps this — and therefore the whole package, since
 * parseRecurrence has no dates in it at all — a pure function of its
 * arguments.
 *
 * This is deliberately not the function to reach for when a recurrence is
 * first *given* to a Task rather than completed — see computeFirstOccurrence
 * below. Issue #191 is the record of what went wrong when a single
 * function tried to answer both questions: a Task recurring daily,
 * created today, came out due tomorrow, because this function's own
 * floor — no occurrence on or before `reference.now` — is correct for a
 * completion and wrong for a creation, and nothing distinguished which
 * one a given call meant.
 */
export function computeNextOccurrence(
  rule: RecurrenceRule,
  reference: RecurrenceReference,
): RecurrenceOutcome {
  return computeOccurrence(rule, reference, "afterCompletion");
}

/**
 * Computes the first occurrence a parsed RecurrenceRule produces when a
 * Task is *given* the recurrence, rather than completed on it — inclusive
 * of `reference.now` itself, if today already satisfies the pattern
 * (issue #191: "a recurring Task created today is never due today"). A
 * daily rule created today is due today; a due-anchored rule anchored to
 * a due date the caller also supplied (e.g. "buy milk friday every 2
 * weeks", where `reference.dueDate` is that Friday) lands on the due date
 * itself rather than one interval past it.
 *
 * This genuinely is a different computation from computeNextOccurrence's,
 * not the same one with a floor relaxed by a day: a phase-locked
 * frequency (daily/weekly/monthly/yearly) always matches its own origin —
 * zero intervals from itself, by definition — but an absolute-calendar
 * one (weekdays/workdays/monthlyOrdinalWeekday) matches only if the
 * origin genuinely falls on the pattern. "Every 3rd friday" typed on a
 * month's *first* Friday has to find that same month's still-ahead third
 * Friday, not jump straight to next month's the way naively testing the
 * origin and then falling back to computeNextOccurrence's own stepping
 * would (stepOnce's own nextOrdinalWeekday assumes its input already sits
 * on the pattern — true for every candidate computeNextOccurrence ever
 * hands it, false for an arbitrary origin here). firstOnOrAfterOrigin
 * below is where that distinction actually lives.
 */
export function computeFirstOccurrence(
  rule: RecurrenceRule,
  reference: RecurrenceReference,
): RecurrenceOutcome {
  return computeOccurrence(rule, reference, "firstOccurrence");
}

// The shared engine both public functions above delegate to — the
// anchor resolution, the start/end bound handling and the MAX_STEPS
// guard are identical for both questions; only the floor a candidate has
// to clear against `reference.now`, and where the search's very first
// candidate comes from, differ, and both of those differences are
// confined to the few lines below that read `mode`.
function computeOccurrence(
  rule: RecurrenceRule,
  reference: RecurrenceReference,
  mode: SearchMode,
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

  // The one place the two questions actually diverge: a completion's
  // floor is strictly after `now` (today was just done, it can't be due
  // again today); a first occurrence's floor includes `now` itself (today
  // counts, if today matches).
  const clearsNowFloor = (candidate: Epoch): boolean =>
    mode === "firstOccurrence" ? candidate >= nowFloating.epoch : candidate > nowFloating.epoch;
  const clearsStartBound = (candidate: Epoch): boolean =>
    startBoundEpoch === null || candidate >= startBoundEpoch;

  let candidate: Epoch;
  let steps: number;
  if (mode === "firstOccurrence") {
    // The origin is itself a candidate here, not merely a starting point
    // to step away from — firstOnOrAfterOrigin returns it unchanged for a
    // phase-locked frequency, or the nearest later instance of the
    // pattern for an absolute-calendar one that the origin doesn't
    // actually satisfy.
    candidate = firstOnOrAfterOrigin(originEpoch, rule);
    steps = 0;
  } else {
    candidate = stepOnce(originEpoch, rule);
    steps = 1;
  }
  while (!clearsNowFloor(candidate) || !clearsStartBound(candidate)) {
    candidate = stepOnce(candidate, rule);
    steps += 1;
    if (steps > MAX_STEPS) {
      throw new Error("recurrence stepping did not converge within 10,000 steps");
    }
  }

  const endBoundEpoch = resolveEndBound(rule, originEpoch, startBoundEpoch);
  if (endBoundEpoch !== null && candidate > endBoundEpoch) {
    return { kind: "ended" };
  }

  return { kind: "occurrence", date: formatFloating(candidate, rule.time) };
}

// One period forward from `epoch`, per the rule's own frequency kind —
// the primitive computeOccurrence's loop repeats until the result clears
// `reference.now` (and any start bound), which is what turns "one step"
// into "skip every missed occurrence" for a stale due date in the
// afterCompletion search, and into "the next later instance" once the
// firstOccurrence search's own initial candidate has failed the floor.
// Every candidate this is ever called with — the afterCompletion origin,
// or firstOnOrAfterOrigin's own result — already sits on the pattern, so
// stepOnce never has to ask "does epoch itself match," only "what's one
// period later."
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

/**
 * The earliest instance of `rule`'s own pattern on or after `epoch` —
 * used only by computeOccurrence's firstOccurrence search, for its very
 * first candidate, since the afterCompletion search never needs to ask
 * whether an origin that hasn't been stepped away from yet already
 * counts: stepOnce always starts one full period past wherever it's
 * given. For a phase-locked frequency (daily/weekly/monthly/yearly)
 * `epoch` always qualifies — it's zero intervals from itself, by
 * definition — so this returns it unchanged, and the caller's floor
 * check is what decides whether that's actually usable. For an
 * absolute-calendar frequency (weekdays/workdays/monthlyOrdinalWeekday)
 * it genuinely depends on whether `epoch` falls on the pattern; when it
 * doesn't, this finds the nearest later instance without skipping past
 * one still inside `epoch`'s own period — the case issue #191 measured
 * going wrong ("every 3rd friday" typed on the month's first Friday
 * landing on next month's third Friday instead of this month's own,
 * still-ahead one).
 */
function firstOnOrAfterOrigin(epoch: Epoch, rule: RecurrenceRule): Epoch {
  switch (rule.frequency.kind) {
    case "daily":
    case "weekly":
    case "monthly":
    case "yearly":
      return epoch;
    case "workdays":
      return firstMatchingWeekdayOnOrAfter(epoch, [1, 2, 3, 4, 5]);
    case "weekdays":
      return firstMatchingWeekdayOnOrAfter(
        epoch,
        rule.frequency.days.map((day) => WEEKDAY_INDEX[day]),
      );
    case "monthlyOrdinalWeekday":
      return firstOrdinalWeekdayOnOrAfter(
        epoch,
        rule.frequency.ordinal,
        WEEKDAY_INDEX[rule.frequency.day],
      );
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

// firstMatchingWeekdayOnOrAfter's own on-or-after twin of
// nextMatchingWeekday above — same "earliest of several target weekdays"
// reasoning, but inclusive of `epoch` itself, for firstOnOrAfterOrigin's
// sake.
function firstMatchingWeekdayOnOrAfter(epoch: Epoch, targets: readonly number[]): Epoch {
  let earliest: Epoch | null = null;
  for (const target of targets) {
    const candidate = nextWeekdayOnOrAfter(epoch, target);
    if (earliest === null || candidate < earliest) {
      earliest = candidate;
    }
  }
  return earliest as Epoch;
}

// The ordinal weekday of the month *after* `epoch`'s own — origin is
// itself normally already this month's Nth weekday (the last due date),
// so "one step" for this frequency kind means next month's occurrence,
// never a second candidate inside the same month. Only ever called (via
// stepOnce) with an `epoch` that already sits on the pattern —
// firstOrdinalWeekdayOnOrAfter below is the one that handles an
// arbitrary, possibly-off-pattern epoch.
function nextOrdinalWeekday(epoch: Epoch, ordinal: number, targetWeekday: number): Epoch {
  const { year, month } = ymdOf(epoch);
  const totalMonths = year * 12 + (month - 1) + 1;
  const nextYear = Math.floor(totalMonths / 12);
  const nextMonth = totalMonths - nextYear * 12 + 1;
  return nthWeekdayOfMonth(nextYear, nextMonth, ordinal, targetWeekday);
}

// This month's `ordinal`th `targetWeekday` if that's still on or after
// `epoch`, else the identical later-month walk nextOrdinalWeekday already
// does. Unlike nextOrdinalWeekday, this doesn't assume `epoch` already
// sits on the pattern — it's the one place that asks "does this month's
// own Nth weekday still lie ahead of (or land on) today" rather than
// jumping straight past it into next month, which is exactly what
// firstOnOrAfterOrigin needs for monthlyOrdinalWeekday and
// nextOrdinalWeekday, by its own contract above, cannot be used for
// directly.
function firstOrdinalWeekdayOnOrAfter(epoch: Epoch, ordinal: number, targetWeekday: number): Epoch {
  const { year, month } = ymdOf(epoch);
  const thisMonth = nthWeekdayOfMonth(year, month, ordinal, targetWeekday);
  return thisMonth >= epoch ? thisMonth : nextOrdinalWeekday(epoch, ordinal, targetWeekday);
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
