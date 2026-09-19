import { describe, expect, it } from "vitest";
import { dayKey } from "../test-support/day-key-fixture";
import {
  firstOccurrence,
  nextOccurrenceAfterCompletion,
  parseRecurrence,
  tomorrowOf,
} from "./index";
import type { RecurrenceOutcome, RecurrenceReference } from "./rule";

/**
 * The recurrence engine's specification, not merely its test suite — see
 * CLAUDE.md's brief for #170: "if a grammar form is not in this table, it
 * is not built." The first big block below exercises
 * `nextOccurrenceAfterCompletion` end to end (parse + compute), because
 * that's the one function ../task-store.ts's advanceRecurring actually
 * calls; a handful of `parseRecurrence`-only cases further down check
 * grammar shape directly where a date-only assertion wouldn't show it
 * (interval, anchor, weekday-list order). The second big block, further
 * down still, exercises `firstOccurrence` — issue #191's fix: a Task
 * given a recurrence at creation, rather than completed on one, is due on
 * the first day the pattern actually matches, including today. The two
 * blocks deliberately share almost no fixtures: mixing a completion's
 * "strictly after now" floor into a creation-time table (or vice versa)
 * would hide exactly the divergence #191 is about.
 *
 * Dates below were checked against a real Gregorian calendar
 * independently of this package (python's `datetime`) before being
 * written down, precisely so a bug in ../calendar.ts couldn't validate
 * itself against its own arithmetic. In particular, 2026-09-04 (used
 * throughout the firstOccurrence block, matching issue #191's own
 * measured table) is a Friday, and September 2026's Fridays fall on the
 * 4th, 11th, 18th and 25th — confirmed against python's `datetime`
 * before being relied on below.
 */

interface Case {
  readonly description: string;
  readonly dateString: string;
  readonly reference: RecurrenceReference;
  readonly expect: RecurrenceOutcome;
}

const occurrence = (date: string): RecurrenceOutcome => ({ kind: "occurrence", date });
const ended: RecurrenceOutcome = { kind: "ended" };

const CASES: readonly Case[] = [
  {
    description:
      '"every day" (no bang) is due-anchored, like every other frequency — a future dueDate (a postponement) wins over `now` (issue #291)',
    dateString: "every day",
    reference: { dueDate: "2026-01-10", now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-11"),
  },
  {
    description:
      '"every! day" is completion-anchored — the bang now genuinely diverges from bare "every day" (it no longer merely repeats it, since #291)',
    dateString: "every! day",
    reference: { dueDate: "2026-01-10", now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-06"),
  },
  {
    description:
      '"every week" (no bang) is due-anchored, like every other frequency — a future dueDate (a postponement) wins over `now` (issue #291)',
    dateString: "every week",
    reference: { dueDate: "2026-01-10", now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-17"),
  },
  {
    description:
      '"every! week" is completion-anchored — the bang now genuinely diverges from bare "every week" (it no longer merely repeats it, since #291)',
    dateString: "every! week",
    reference: { dueDate: "2026-01-10", now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-12"),
  },

  {
    description: '"every day" completed exactly on its due date (on time) lands on tomorrow',
    dateString: "every day",
    reference: { dueDate: "2026-01-05", now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-06"),
  },
  {
    description:
      '"every day" completed while overdue by one day still floors at tomorrow, never back into the past',
    dateString: "every day",
    reference: { dueDate: "2026-01-04", now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-06"),
  },
  {
    description:
      '"every day" postponed six days out and completed early lands six days later than completion-anchoring would give — the Android-corroborated case from issue #291\'s own comment thread (postponed Mon 21 Sep, completed 15 Sep, landed 22 Sep, not 16 Sep)',
    dateString: "every day",
    reference: { dueDate: "2026-09-21", now: dayKey("2026-09-15") },
    expect: occurrence("2026-09-22"),
  },
  {
    description:
      '"everyday" (one word, issue #369) computes the identical next occurrence "every day" does',
    dateString: "everyday",
    reference: { dueDate: "2026-01-05", now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-06"),
  },
  {
    description: '"every week" completed exactly on its due date (on time) lands one week out',
    dateString: "every week",
    reference: { dueDate: "2026-01-05", now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-12"),
  },
  {
    description:
      '"every week" completed while overdue by one day still steps from its due date, never back into the past — unlike daily, one weekly interval alone already clears `now` here, so this is the trivial half of the floor; the eighteen-months-late yearly case above is the half that needs more than one step',
    dateString: "every week",
    reference: { dueDate: "2026-01-04", now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-11"),
  },
  {
    description:
      '"every week" postponed into the future and completed early lands on the postponed date plus one week, not one week after `now`',
    dateString: "every week",
    reference: { dueDate: "2026-01-19", now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-26"),
  },

  {
    description:
      '"every week" overdue by more than one interval steps whole weeks from its due date, keeping the weekday — Todoist web, driven: due Mon 31 Aug, completed Tue 15 Sep, lands Mon 21 Sep (issue #301). `max(due, today) + interval` would give Tue 22 Sep and lose the Monday',
    dateString: "every week",
    reference: { dueDate: "2026-08-31", now: dayKey("2026-09-15") },
    expect: occurrence("2026-09-21"),
  },
  {
    description:
      '"every 2 weeks" overdue by more than one interval keeps its interval PARITY as well as its weekday — Todoist web, driven: due Mon 17 Aug, completed Tue 15 Sep, lands Mon 28 Sep (issue #301). This is the case the weekly probe above cannot discriminate: "next matching Monday" gives 21 Sep, `max(due, today) + interval` gives Tue 29 Sep, and only stepping 17 Aug -> 31 Aug -> 14 Sep -> 28 Sep gives what Todoist actually did',
    dateString: "every 2 weeks",
    reference: { dueDate: "2026-08-17", now: dayKey("2026-09-15") },
    expect: occurrence("2026-09-28"),
  },

  // --- Monthly: `every` vs `every!` genuinely diverge (day-of-month
  // phase), unlike the bare daily/weekly cases above — this was already
  // due-anchored before #291, so these three (on time / overdue /
  // postponed-and-completed-early) are a regression check that the
  // already-correct rule stayed correct, not a behaviour change.
  {
    description: '"every month" (no bang) completed exactly on its due date (on time)',
    dateString: "every month",
    reference: { dueDate: "2026-01-15", now: dayKey("2026-01-15") },
    expect: occurrence("2026-02-15"),
  },
  {
    description:
      '"every month" (no bang) completed while overdue keeps the due date\'s own day-of-month, not the completion day',
    dateString: "every month",
    reference: { dueDate: "2026-01-15", now: dayKey("2026-01-20") },
    expect: occurrence("2026-02-15"),
  },
  {
    description: '"every! month" anchors to the completion day instead',
    dateString: "every! month",
    reference: { dueDate: "2026-01-15", now: dayKey("2026-01-20") },
    expect: occurrence("2026-02-20"),
  },
  {
    description:
      "\"every month\" (no bang) postponed to next month and completed early lands one further month out, on the postponed date's own day, not `now`'s",
    dateString: "every month",
    reference: { dueDate: "2026-02-01", now: dayKey("2026-01-20") },
    expect: occurrence("2026-03-01"),
  },
  {
    description:
      '"every month" clamps a day-of-month that the next month is too short for (31 Jan -> 28 Feb, 2026 not a leap year)',
    dateString: "every month",
    reference: { dueDate: "2026-01-31", now: dayKey("2026-01-31") },
    expect: occurrence("2026-02-28"),
  },

  // --- Yearly: `every` vs `every!`, and the required skip-missed case.
  {
    description:
      "a yearly task completed eighteen months late lands two years out, not one (the due-anchored skip)",
    dateString: "every year",
    reference: { dueDate: "2025-01-01", now: dayKey("2026-07-01") },
    expect: occurrence("2027-01-01"),
  },
  {
    description:
      "the same eighteen-months-late completion, but completion-anchored, needs no skip at all — it's always exactly one interval past `now`",
    dateString: "every! year",
    reference: { dueDate: "2025-01-01", now: dayKey("2026-07-01") },
    expect: occurrence("2027-07-01"),
  },
  {
    description:
      '"every year" with no prior dueDate (first-time scheduling) anchors to `now` instead',
    dateString: "every year",
    reference: { dueDate: null, now: dayKey("2026-01-15") },
    expect: occurrence("2027-01-15"),
  },

  // --- Intervals: "every N unit" and "every other unit", plus the
  // interval form's own due/completion divergence (the modulo phase
  // matters once the step is more than one unit).
  {
    description: '"every 3 days" (no bang) keeps the due date\'s own 3-day phase',
    dateString: "every 3 days",
    reference: { dueDate: "2026-01-01", now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-07"),
  },
  {
    description: '"every! 3 days" anchors to the completion day instead',
    dateString: "every! 3 days",
    reference: { dueDate: "2026-01-01", now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-08"),
  },
  {
    description:
      '"every 3 months" skips a missed occurrence — only a strictly future date is ever returned',
    dateString: "every 3 months",
    reference: { dueDate: "2026-01-15", now: dayKey("2026-07-15") },
    expect: occurrence("2026-10-15"),
  },
  {
    description: '"every other week" means interval 2, not a named weekday',
    dateString: "every other week",
    reference: { dueDate: "2026-01-05", now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-19"),
  },

  // --- Named weekdays, single and listed.
  {
    description: '"every monday" — a single named weekday',
    dateString: "every monday",
    reference: { dueDate: "2026-01-05", now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-12"),
  },
  {
    description:
      '"every monday, wednesday and friday" — a comma/"and"-separated list picks the earliest match',
    dateString: "every monday, wednesday and friday",
    reference: { dueDate: "2026-01-05", now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-07"),
  },

  // --- Workdays.
  {
    description: '"every workday" skips the weekend',
    dateString: "every workday",
    reference: { dueDate: "2026-01-09", now: dayKey("2026-01-09") },
    expect: occurrence("2026-01-12"),
  },
  {
    description:
      '"every 3 workday" (issue #368) counts three business days forward from a Monday — Tue, Wed, Thu, crossing no weekend — not the single next weekday "every workday" alone would give',
    dateString: "every 3 workday",
    reference: { dueDate: "2026-01-05", now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-08"),
  },
  {
    description:
      '"every 3 workday" from a Thursday crosses a weekend without counting either of its two days — Fri (1), Mon (2), Tue (3)',
    dateString: "every 3 workday",
    reference: { dueDate: "2026-01-08", now: dayKey("2026-01-08") },
    expect: occurrence("2026-01-13"),
  },

  // --- Ordinal weekday.
  {
    description: '"every 3rd friday" — the issue\'s own named example',
    dateString: "every 3rd friday",
    reference: { dueDate: "2026-01-16", now: dayKey("2026-01-16") },
    expect: occurrence("2026-02-20"),
  },
  {
    description:
      '"every 3rd monday" — same shape as the issue\'s own "3rd friday" example, a different weekday',
    dateString: "every 3rd monday",
    reference: { dueDate: "2026-01-05", now: dayKey("2026-01-05") },
    expect: occurrence("2026-02-16"),
  },

  // --- Month-scoped ordinal weekday (issue #368): the same shape as
  // above, but "jan" pins the pattern to one calendar month, so stepping
  // forward means next *year's* January, not next month.
  {
    description:
      '"every 3rd wed jan" steps a year forward, not a month — only January ever satisfies the pattern',
    dateString: "every 3rd wed jan",
    reference: { dueDate: "2026-01-21", now: dayKey("2026-01-21") },
    expect: occurrence("2027-01-20"),
  },

  // --- Month-scoped ordinal weekday list (issue #368): independent
  // (ordinal, weekday, month) entries, resolved to whichever comes
  // earliest — never "the first entry typed."
  {
    description:
      '"every 1st wed jan, 3rd thu jul" picks the January entry when it\'s the nearer of the two',
    dateString: "every 1st wed jan, 3rd thu jul",
    reference: { dueDate: "2026-01-01", now: dayKey("2026-01-01") },
    expect: occurrence("2026-01-07"),
  },
  {
    description:
      "\"every 1st wed jan, 3rd thu jul\" picks the July entry once January's own 2026 date has already passed — this year's July still beats next year's January, proving it's a genuine earliest-of-both comparison, not \"always the first-listed entry\"",
    dateString: "every 1st wed jan, 3rd thu jul",
    reference: { dueDate: "2026-02-01", now: dayKey("2026-02-01") },
    expect: occurrence("2026-07-16"),
  },

  // --- Quarter (issue #368): "free" once workdays and month-scoped
  // ordinal weekdays are in — monthly with the interval tripled.
  {
    description: '"every quarter" is monthly with interval 3',
    dateString: "every quarter",
    reference: { dueDate: "2026-01-05", now: dayKey("2026-01-05") },
    expect: occurrence("2026-04-05"),
  },

  // --- Times.
  {
    description: '"every day at 9am" attaches a time-of-day to every occurrence',
    dateString: "every day at 9am",
    reference: { dueDate: null, now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-06T09:00"),
  },
  {
    description: '"every monday at 17:00" — 24-hour form, no am/pm needed',
    dateString: "every monday at 17:00",
    reference: { dueDate: "2026-01-05", now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-12T17:00"),
  },
  {
    description: '"at 12am" is midnight, not noon',
    dateString: "every day at 12am",
    reference: { dueDate: null, now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-06T00:00"),
  },
  {
    description: '"at 12pm" is noon, not midnight',
    dateString: "every day at 12pm",
    reference: { dueDate: null, now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-06T12:00"),
  },

  // --- Bounds: starting / ending / for.
  {
    description:
      '"starting" snaps the first occurrence forward to the bound, even though the rule alone would fire sooner',
    dateString: "every day starting 10 Jan",
    reference: { dueDate: null, now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-10"),
  },
  {
    description: '"ending" allows an occurrence on or before the bound',
    dateString: "every day ending 8 Jan",
    reference: { dueDate: null, now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-06"),
  },
  {
    description: '"ending" refuses an occurrence after the bound — the rule has run its course',
    dateString: "every day ending 8 Jan",
    reference: { dueDate: null, now: dayKey("2026-01-08") },
    expect: ended,
  },
  {
    description:
      '"for 3 weeks" derives an end bound from the rule\'s own anchor when there\'s no explicit "starting"',
    dateString: "every week for 3 weeks",
    reference: { dueDate: null, now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-12"),
  },
  {
    description: '"for 3 weeks" ends the rule once that window has passed',
    dateString: "every! month for 3 weeks",
    reference: { dueDate: null, now: dayKey("2026-01-05") },
    expect: ended,
  },
  {
    description: '"starting" and "ending" together bound both ends of the window',
    dateString: "every day starting 1 Mar ending 5 Mar",
    reference: { dueDate: null, now: dayKey("2026-01-01") },
    expect: occurrence("2026-03-01"),
  },
];

describe("nextOccurrenceAfterCompletion — the recurrence grammar's specification", () => {
  for (const testCase of CASES) {
    it(testCase.description, () => {
      expect(nextOccurrenceAfterCompletion(testCase.dateString, testCase.reference)).toEqual(
        testCase.expect,
      );
    });
  }
});

interface RefusalCase {
  readonly description: string;
  readonly dateString: string;
  /** A substring the refusal reason must contain — proves *why* it refused, not just that it did. */
  readonly reasonContains: string;
}

const REFUSAL_CASES: readonly RefusalCase[] = [
  {
    description: "two different times in one rule",
    dateString: "every day at 9am at 5pm",
    reasonContains: "one time of day",
  },
  {
    description: "an exclusion clause",
    dateString: "every day except sunday",
    reasonContains: "exclusion",
  },
  {
    description: 'a "but not" exclusion clause, a second spelling of the same refusal',
    dateString: "every workday but not friday",
    reasonContains: "exclusion",
  },
  {
    description: "a monthly interval crossed with an ordinal weekday",
    dateString: "every 3 months on the 3rd friday",
    reasonContains: "ordinal weekday",
  },
  {
    description:
      '"every other month" is also a monthly interval — the crossed refusal catches it too',
    dateString: "every other month on the 3rd friday",
    reasonContains: "ordinal weekday",
  },
  {
    description: 'text that doesn\'t start with "every" at all',
    dateString: "tomorrow",
    reasonContains: "every",
  },
  {
    description: "empty text",
    dateString: "",
    reasonContains: "empty",
  },
  {
    description: "whitespace-only text",
    dateString: "   ",
    reasonContains: "empty",
  },
  {
    description: "a frequency word this grammar doesn't recognise",
    dateString: "every fortnight",
    reasonContains: "unrecognised",
  },
];

describe("nextOccurrenceAfterCompletion — refusals (a legible reason, never a throw)", () => {
  for (const testCase of REFUSAL_CASES) {
    it(`refuses ${testCase.description}`, () => {
      const result = nextOccurrenceAfterCompletion(testCase.dateString, {
        dueDate: null,
        now: dayKey("2026-01-01"),
      });
      expect(result.kind).toBe("refused");
      if (result.kind === "refused") {
        expect(result.reason.toLowerCase()).toContain(testCase.reasonContains.toLowerCase());
      }
    });
  }

  // A refusal is a value a caller inspects — never an exception a caller
  // has to catch, which is the whole point of returning `{ kind:
  // "refused" }` instead: every string in REFUSAL_CASES above (and every
  // grammar form in CASES) can call nextOccurrenceAfterCompletion without
  // a try/catch anywhere near it.
  it("never throws for any string in this file's own test tables", () => {
    for (const testCase of [...CASES, ...REFUSAL_CASES]) {
      expect(() =>
        nextOccurrenceAfterCompletion(testCase.dateString, {
          dueDate: null,
          now: dayKey("2026-01-01"),
        }),
      ).not.toThrow();
    }
  });
});

// --- firstOccurrence (issue #191): "when is this due for the first
// time," not "when is it next due after a completion." Friday
// 2026-09-04 throughout, matching the issue's own measured table exactly
// (this file's own header comment records the calendar check for that
// week's Fridays).
const FRIDAY = dayKey("2026-09-04");

const FIRST_OCCURRENCE_CASES: readonly Case[] = [
  // --- The issue's own measured table, verbatim: four grammar forms
  // typed on the same day, two of which used to skip an entire period.
  {
    description: '"every day" typed today is due today, not tomorrow (issue #191\'s own example)',
    dateString: "every day",
    reference: { dueDate: null, now: FRIDAY },
    expect: occurrence("2026-09-04"),
  },
  {
    description:
      "\"every 3rd friday\" typed on the month's *first* Friday finds that same month's still-ahead third Friday, not next month's — the case that proves this isn't just \"return today\" (issue #191's measured table: got 2026-10-16 before the fix)",
    dateString: "every 3rd friday",
    reference: { dueDate: null, now: FRIDAY },
    expect: occurrence("2026-09-18"),
  },
  {
    description:
      '"every 2 weeks" with no prior due date anchors to `now`, which always matches a phase-locked kind trivially — "arguably 2026-09-04" per the issue\'s own table',
    dateString: "every 2 weeks",
    reference: { dueDate: null, now: FRIDAY },
    expect: occurrence("2026-09-04"),
  },
  {
    description:
      '"every monday" typed on a Friday correctly finds the next Monday — this one was already right before the fix, since no Monday was actually skipped',
    dateString: "every monday",
    reference: { dueDate: null, now: FRIDAY },
    expect: occurrence("2026-09-07"),
  },

  // --- Every remaining phase-locked frequency (criterion 5: "covers
  // every recurrence form, not just daily") — each always matches its
  // own origin trivially, so each is due today when created today.
  {
    description: '"every week" created today is due today',
    dateString: "every week",
    reference: { dueDate: null, now: FRIDAY },
    expect: occurrence("2026-09-04"),
  },
  {
    description:
      '"every month" created today is due today, not next month — the shape #191 named explicitly ("a monthly-shaped one created this month is due next month")',
    dateString: "every month",
    reference: { dueDate: null, now: FRIDAY },
    expect: occurrence("2026-09-04"),
  },
  {
    description: '"every year" created today is due today',
    dateString: "every year",
    reference: { dueDate: null, now: FRIDAY },
    expect: occurrence("2026-09-04"),
  },
  {
    description:
      '"every 3 months" (an interval greater than 1) created today is still due today — zero intervals from the origin is zero intervals regardless of the interval\'s size',
    dateString: "every 3 months",
    reference: { dueDate: null, now: FRIDAY },
    expect: occurrence("2026-09-04"),
  },

  // --- The absolute-calendar frequencies, where the origin only
  // sometimes matches.
  {
    description:
      '"every workday" created on a Friday (itself a workday) is due today, not the following Monday',
    dateString: "every workday",
    reference: { dueDate: null, now: FRIDAY },
    expect: occurrence("2026-09-04"),
  },
  {
    description: '"every wednesday" created on a Friday finds next Wednesday, three days out',
    dateString: "every wednesday",
    reference: { dueDate: null, now: FRIDAY },
    expect: occurrence("2026-09-09"),
  },
  {
    description:
      '"every 1st friday" created on 2026-09-04, which genuinely *is* this month\'s first Friday, is due today',
    dateString: "every 1st friday",
    reference: { dueDate: null, now: FRIDAY },
    expect: occurrence("2026-09-04"),
  },
  {
    description:
      "\"every 1st friday\" created after this month's first Friday has already passed rolls to next month's, the same one-month step nextOrdinalWeekday always took — proving the fix doesn't break the already-passed case while fixing the still-ahead one",
    dateString: "every 1st friday",
    reference: { dueDate: null, now: dayKey("2026-09-20") },
    expect: occurrence("2026-10-02"),
  },

  // --- The dueDate anchor: a rule anchored to a due date the caller also
  // supplied lands on that due date itself, not one interval past it.
  {
    description:
      '"buy milk friday every 2 weeks" (a due-anchored interval rule, typed on a Monday with the parsed "friday" token resolving to the coming Friday) lands on that Friday itself, not two weeks later',
    dateString: "every 2 weeks",
    reference: { dueDate: "2026-09-04", now: dayKey("2026-08-31") },
    expect: occurrence("2026-09-04"),
  },

  // --- Bounds: the inclusive floor interacts with "starting" and
  // "ending" the same way it interacts with `now` itself.
  {
    description:
      '"starting" still snaps the first occurrence forward to the bound when the rule alone would fire on `now`',
    dateString: "every day starting 10 Jan",
    reference: { dueDate: null, now: dayKey("2026-01-05") },
    expect: occurrence("2026-01-10"),
  },
  {
    description:
      '"ending" allows an occurrence exactly on the end-bound day itself, the inclusive twin of nextOccurrenceAfterCompletion\'s own "on or before the bound" case',
    dateString: "every day ending 8 Jan",
    reference: { dueDate: null, now: dayKey("2026-01-08") },
    expect: occurrence("2026-01-08"),
  },
  {
    description:
      '"ending" refuses an occurrence after the bound, exactly as it does after a completion',
    dateString: "every day ending 8 Jan",
    reference: { dueDate: null, now: dayKey("2026-01-09") },
    expect: ended,
  },
];

describe("firstOccurrence — the first day the pattern actually matches, including today (issue #191)", () => {
  for (const testCase of FIRST_OCCURRENCE_CASES) {
    it(testCase.description, () => {
      expect(firstOccurrence(testCase.dateString, testCase.reference)).toEqual(testCase.expect);
    });
  }

  it("refuses malformed input identically to nextOccurrenceAfterCompletion — both share the same parse step", () => {
    const result = firstOccurrence("every fortnight", { dueDate: null, now: FRIDAY });
    expect(result.kind).toBe("refused");
  });

  it("never throws for any string in this file's own test tables", () => {
    for (const testCase of [...FIRST_OCCURRENCE_CASES, ...REFUSAL_CASES]) {
      expect(() =>
        firstOccurrence(testCase.dateString, { dueDate: null, now: dayKey("2026-01-01") }),
      ).not.toThrow();
    }
  });
});

describe("parseRecurrence — grammar shape a date-only assertion can't show", () => {
  it('interval defaults to 1 when no number or "other" is present', () => {
    const result = parseRecurrence("every month");
    expect(result).toMatchObject({ kind: "parsed", rule: { interval: 1 } });
  });

  it('"every other X" means interval 2, not a literal count', () => {
    const result = parseRecurrence("every other month");
    expect(result).toMatchObject({ kind: "parsed", rule: { interval: 2 } });
  });

  it("a named-weekday list preserves the order the days were typed in", () => {
    const result = parseRecurrence("every friday, monday and wednesday");
    expect(result).toMatchObject({
      kind: "parsed",
      rule: { frequency: { kind: "weekdays", days: ["friday", "monday", "wednesday"] } },
    });
  });

  it('the bang resolves to "completion" on the parsed rule itself, not just in the computed date', () => {
    const withoutBang = parseRecurrence("every 3 months");
    const withBang = parseRecurrence("every! 3 months");
    expect(withoutBang).toMatchObject({ kind: "parsed", rule: { anchor: "due" } });
    expect(withBang).toMatchObject({ kind: "parsed", rule: { anchor: "completion" } });
  });

  it(
    'a bare "every week" resolves to "due", the same as every other frequency — issue #291 ' +
      'retired the exception that used to force it (and bare "every day") to "completion" ' +
      'regardless of the bang; only "every! week" still resolves to "completion"',
    () => {
      const withoutBang = parseRecurrence("every week");
      const withBang = parseRecurrence("every! week");
      expect(withoutBang).toMatchObject({ kind: "parsed", rule: { anchor: "due" } });
      expect(withBang).toMatchObject({ kind: "parsed", rule: { anchor: "completion" } });
    },
  );

  it('"every 3rd friday" parses its ordinal and weekday separately, not as a weekday-list', () => {
    const result = parseRecurrence("every 3rd friday");
    expect(result).toMatchObject({
      kind: "parsed",
      rule: { frequency: { kind: "monthlyOrdinalWeekday", ordinal: 3, day: "friday" } },
    });
  });

  // --- Issue #368: workdays honour interval, ordinal weekdays can be
  // scoped to one month (singly or as an independent-entries list), and
  // "every quarter" is monthly with the interval tripled. Each case here
  // asserts the full parsed shape (`toEqual`, not `toMatchObject`) so a
  // future change to any of these fields is caught here rather than only
  // downstream in a computed date.

  it('"every workday" (no number) still defaults interval to 1 — the pre-#368 shape, byte for byte', () => {
    const result = parseRecurrence("every workday");
    expect(result).toEqual({
      kind: "parsed",
      rule: {
        frequency: { kind: "workdays" },
        interval: 1,
        anchor: "due",
        time: null,
        startBound: null,
        endBound: null,
        durationBound: null,
      },
    });
  });

  it('"every 3 workday" carries the interval on the rule, not folded into the frequency', () => {
    const result = parseRecurrence("every 3 workday");
    expect(result).toMatchObject({
      kind: "parsed",
      rule: { frequency: { kind: "workdays" }, interval: 3 },
    });
  });

  it('"every other workday" means interval 2, the same "other" convention every other unit uses', () => {
    const result = parseRecurrence("every other workday");
    expect(result).toMatchObject({
      kind: "parsed",
      rule: { frequency: { kind: "workdays" }, interval: 2 },
    });
  });

  it('the unscoped ordinal-weekday shape ("every 3rd monday") carries month: null, not merely an absent field', () => {
    const result = parseRecurrence("every 3rd monday");
    expect(result).toMatchObject({
      kind: "parsed",
      rule: {
        frequency: { kind: "monthlyOrdinalWeekday", ordinal: 3, day: "monday", month: null },
      },
    });
  });

  it('a bare weekday comma-list ("every friday, monday and wednesday") still parses as "weekdays", not the new month-scoped list shape', () => {
    const result = parseRecurrence("every friday, monday and wednesday");
    expect(result).toMatchObject({
      kind: "parsed",
      rule: { frequency: { kind: "weekdays", days: ["friday", "monday", "wednesday"] } },
    });
  });

  it('"every 3rd wed jan" — a single ordinal-weekday-month entry — parses as monthlyOrdinalWeekday with month set, not a one-element list', () => {
    const result = parseRecurrence("every 3rd wed jan");
    expect(result).toMatchObject({
      kind: "parsed",
      rule: {
        frequency: { kind: "monthlyOrdinalWeekday", ordinal: 3, day: "wednesday", month: 1 },
      },
    });
  });

  it('"every 1st wed jan, 3rd thu jul" parses as monthlyOrdinalWeekdayList, preserving each entry\'s own month', () => {
    const result = parseRecurrence("every 1st wed jan, 3rd thu jul");
    expect(result).toMatchObject({
      kind: "parsed",
      rule: {
        frequency: {
          kind: "monthlyOrdinalWeekdayList",
          entries: [
            { ordinal: 1, day: "wednesday", month: 1 },
            { ordinal: 3, day: "thursday", month: 7 },
          ],
        },
      },
    });
  });

  it('"every quarter" parses as monthly with interval 3, never its own frequency kind', () => {
    const result = parseRecurrence("every quarter");
    expect(result).toMatchObject({
      kind: "parsed",
      rule: { frequency: { kind: "monthly" }, interval: 3 },
    });
  });

  it('"every 2 quarters" carries the same multiplier the other units\' number prefix does, tripled for the quarter-to-month conversion', () => {
    const result = parseRecurrence("every 2 quarters");
    expect(result).toMatchObject({
      kind: "parsed",
      rule: { frequency: { kind: "monthly" }, interval: 6 },
    });
  });

  // --- Issue #369: one-word "everyday" — one of Todoist's own published
  // recurrence-table rows — parses byte-identically to the spaced form.
  it('"everyday" (one word, issue #369) parses byte-identically to "every day"', () => {
    expect(parseRecurrence("everyday")).toEqual(parseRecurrence("every day"));
  });

  it('"everyday" carries a bound clause exactly like the spaced form does', () => {
    expect(parseRecurrence("everyday starting 1 nov")).toEqual(
      parseRecurrence("every day starting 1 nov"),
    );
  });

  it('"everyday" is due-anchored by default, the same as "every day"', () => {
    const result = parseRecurrence("everyday");
    expect(result).toMatchObject({
      kind: "parsed",
      rule: { frequency: { kind: "daily" }, interval: 1, anchor: "due" },
    });
  });

  it('"everybody" is not mistaken for "every" + "day" glued together — it still refuses', () => {
    const result = parseRecurrence("everybody");
    expect(result.kind).toBe("refused");
  });
});

describe("tomorrowOf", () => {
  it("adds exactly one calendar day", () => {
    expect(tomorrowOf("2026-01-05")).toBe("2026-01-06");
  });

  it("drops any time-of-day the input carried — always returns a bare YYYY-MM-DD", () => {
    expect(tomorrowOf("2026-01-05T14:30")).toBe("2026-01-06");
  });

  it("rolls over a year boundary correctly", () => {
    expect(tomorrowOf("2026-12-31")).toBe("2027-01-01");
  });
});
