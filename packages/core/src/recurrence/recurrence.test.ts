import { describe, expect, it } from "vitest";
import { nextOccurrence, parseRecurrence, tomorrowOf } from "./index";
import type { RecurrenceOutcome, RecurrenceReference } from "./rule";

/**
 * The recurrence engine's specification, not merely its test suite — see
 * CLAUDE.md's brief for #170: "if a grammar form is not in this table, it
 * is not built." Every row exercises `nextOccurrence` end to end (parse +
 * compute), because that's the one function ../task-store.ts's
 * advanceRecurring actually calls; a handful of `parseRecurrence`-only
 * cases at the bottom check grammar shape directly where a date-only
 * assertion wouldn't show it (interval, anchor, weekday-list order).
 *
 * Dates below were checked against a real Gregorian calendar
 * independently of this package (python's `datetime`) before being
 * written down, precisely so a bug in ../calendar.ts couldn't validate
 * itself against its own arithmetic.
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
  // --- Daily / weekly, and the exception that makes them completion-
  // anchored even without a bang. A dueDate *after* now (an early
  // completion) is the one scenario where a due-anchored computation
  // would actually diverge from a completion-anchored one for an
  // interval-1 daily/weekly rule — see ./engine.ts's own comment on why
  // that's otherwise unobservable for these two frequencies.
  {
    description: '"every day" is completion-anchored even with a future dueDate — no bang needed',
    dateString: "every day",
    reference: { dueDate: "2026-01-10", now: "2026-01-05" },
    expect: occurrence("2026-01-06"),
  },
  {
    description: '"every! day" is identical to "every day" — the bang is redundant here',
    dateString: "every! day",
    reference: { dueDate: "2026-01-10", now: "2026-01-05" },
    expect: occurrence("2026-01-06"),
  },
  {
    description: '"every week" is completion-anchored even with a future dueDate — no bang needed',
    dateString: "every week",
    reference: { dueDate: "2026-01-10", now: "2026-01-05" },
    expect: occurrence("2026-01-12"),
  },
  {
    description: '"every! week" is identical to "every week" — the bang is redundant here',
    dateString: "every! week",
    reference: { dueDate: "2026-01-10", now: "2026-01-05" },
    expect: occurrence("2026-01-12"),
  },

  // --- Monthly: `every` vs `every!` genuinely diverge (day-of-month
  // phase), unlike the bare daily/weekly cases above.
  {
    description:
      '"every month" (no bang) keeps the due date\'s own day-of-month, not the completion day',
    dateString: "every month",
    reference: { dueDate: "2026-01-15", now: "2026-01-20" },
    expect: occurrence("2026-02-15"),
  },
  {
    description: '"every! month" anchors to the completion day instead',
    dateString: "every! month",
    reference: { dueDate: "2026-01-15", now: "2026-01-20" },
    expect: occurrence("2026-02-20"),
  },
  {
    description:
      '"every month" clamps a day-of-month that the next month is too short for (31 Jan -> 28 Feb, 2026 not a leap year)',
    dateString: "every month",
    reference: { dueDate: "2026-01-31", now: "2026-01-31" },
    expect: occurrence("2026-02-28"),
  },

  // --- Yearly: `every` vs `every!`, and the required skip-missed case.
  {
    description:
      "a yearly task completed eighteen months late lands two years out, not one (the due-anchored skip)",
    dateString: "every year",
    reference: { dueDate: "2025-01-01", now: "2026-07-01" },
    expect: occurrence("2027-01-01"),
  },
  {
    description:
      "the same eighteen-months-late completion, but completion-anchored, needs no skip at all — it's always exactly one interval past `now`",
    dateString: "every! year",
    reference: { dueDate: "2025-01-01", now: "2026-07-01" },
    expect: occurrence("2027-07-01"),
  },
  {
    description:
      '"every year" with no prior dueDate (first-time scheduling) anchors to `now` instead',
    dateString: "every year",
    reference: { dueDate: null, now: "2026-01-15" },
    expect: occurrence("2027-01-15"),
  },

  // --- Intervals: "every N unit" and "every other unit", plus the
  // interval form's own due/completion divergence (the modulo phase
  // matters once the step is more than one unit).
  {
    description: '"every 3 days" (no bang) keeps the due date\'s own 3-day phase',
    dateString: "every 3 days",
    reference: { dueDate: "2026-01-01", now: "2026-01-05" },
    expect: occurrence("2026-01-07"),
  },
  {
    description: '"every! 3 days" anchors to the completion day instead',
    dateString: "every! 3 days",
    reference: { dueDate: "2026-01-01", now: "2026-01-05" },
    expect: occurrence("2026-01-08"),
  },
  {
    description:
      '"every 3 months" skips a missed occurrence — only a strictly future date is ever returned',
    dateString: "every 3 months",
    reference: { dueDate: "2026-01-15", now: "2026-07-15" },
    expect: occurrence("2026-10-15"),
  },
  {
    description: '"every other week" means interval 2, not a named weekday',
    dateString: "every other week",
    reference: { dueDate: "2026-01-05", now: "2026-01-05" },
    expect: occurrence("2026-01-19"),
  },

  // --- Named weekdays, single and listed.
  {
    description: '"every monday" — a single named weekday',
    dateString: "every monday",
    reference: { dueDate: "2026-01-05", now: "2026-01-05" },
    expect: occurrence("2026-01-12"),
  },
  {
    description:
      '"every monday, wednesday and friday" — a comma/"and"-separated list picks the earliest match',
    dateString: "every monday, wednesday and friday",
    reference: { dueDate: "2026-01-05", now: "2026-01-05" },
    expect: occurrence("2026-01-07"),
  },

  // --- Workdays.
  {
    description: '"every workday" skips the weekend',
    dateString: "every workday",
    reference: { dueDate: "2026-01-09", now: "2026-01-09" },
    expect: occurrence("2026-01-12"),
  },

  // --- Ordinal weekday.
  {
    description: '"every 3rd friday" — the issue\'s own named example',
    dateString: "every 3rd friday",
    reference: { dueDate: "2026-01-16", now: "2026-01-16" },
    expect: occurrence("2026-02-20"),
  },

  // --- Times.
  {
    description: '"every day at 9am" attaches a time-of-day to every occurrence',
    dateString: "every day at 9am",
    reference: { dueDate: null, now: "2026-01-05" },
    expect: occurrence("2026-01-06T09:00"),
  },
  {
    description: '"every monday at 17:00" — 24-hour form, no am/pm needed',
    dateString: "every monday at 17:00",
    reference: { dueDate: "2026-01-05", now: "2026-01-05" },
    expect: occurrence("2026-01-12T17:00"),
  },
  {
    description: '"at 12am" is midnight, not noon',
    dateString: "every day at 12am",
    reference: { dueDate: null, now: "2026-01-05" },
    expect: occurrence("2026-01-06T00:00"),
  },
  {
    description: '"at 12pm" is noon, not midnight',
    dateString: "every day at 12pm",
    reference: { dueDate: null, now: "2026-01-05" },
    expect: occurrence("2026-01-06T12:00"),
  },

  // --- Bounds: starting / ending / for.
  {
    description:
      '"starting" snaps the first occurrence forward to the bound, even though the rule alone would fire sooner',
    dateString: "every day starting 10 Jan",
    reference: { dueDate: null, now: "2026-01-05" },
    expect: occurrence("2026-01-10"),
  },
  {
    description: '"ending" allows an occurrence on or before the bound',
    dateString: "every day ending 8 Jan",
    reference: { dueDate: null, now: "2026-01-05" },
    expect: occurrence("2026-01-06"),
  },
  {
    description: '"ending" refuses an occurrence after the bound — the rule has run its course',
    dateString: "every day ending 8 Jan",
    reference: { dueDate: null, now: "2026-01-08" },
    expect: ended,
  },
  {
    description:
      '"for 3 weeks" derives an end bound from the rule\'s own anchor when there\'s no explicit "starting"',
    dateString: "every week for 3 weeks",
    reference: { dueDate: null, now: "2026-01-05" },
    expect: occurrence("2026-01-12"),
  },
  {
    description: '"for 3 weeks" ends the rule once that window has passed',
    dateString: "every! month for 3 weeks",
    reference: { dueDate: null, now: "2026-01-05" },
    expect: ended,
  },
  {
    description: '"starting" and "ending" together bound both ends of the window',
    dateString: "every day starting 1 Mar ending 5 Mar",
    reference: { dueDate: null, now: "2026-01-01" },
    expect: occurrence("2026-03-01"),
  },
];

describe("nextOccurrence — the recurrence grammar's specification", () => {
  for (const testCase of CASES) {
    it(testCase.description, () => {
      expect(nextOccurrence(testCase.dateString, testCase.reference)).toEqual(testCase.expect);
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

describe("nextOccurrence — refusals (a legible reason, never a throw)", () => {
  for (const testCase of REFUSAL_CASES) {
    it(`refuses ${testCase.description}`, () => {
      const result = nextOccurrence(testCase.dateString, { dueDate: null, now: "2026-01-01" });
      expect(result.kind).toBe("refused");
      if (result.kind === "refused") {
        expect(result.reason.toLowerCase()).toContain(testCase.reasonContains.toLowerCase());
      }
    });
  }

  // A refusal is a value a caller inspects — never an exception a caller
  // has to catch, which is the whole point of returning `{ kind:
  // "refused" }` instead: every string in REFUSAL_CASES above (and every
  // grammar form in CASES) can call nextOccurrence without a try/catch
  // anywhere near it.
  it("never throws for any string in this file's own test tables", () => {
    for (const testCase of [...CASES, ...REFUSAL_CASES]) {
      expect(() =>
        nextOccurrence(testCase.dateString, { dueDate: null, now: "2026-01-01" }),
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

  it('a bare "every week" resolves to "completion" even without a bang — the exception applied once, at parse time', () => {
    const result = parseRecurrence("every week");
    expect(result).toMatchObject({ kind: "parsed", rule: { anchor: "completion" } });
  });

  it('"every 3rd friday" parses its ordinal and weekday separately, not as a weekday-list', () => {
    const result = parseRecurrence("every 3rd friday");
    expect(result).toMatchObject({
      kind: "parsed",
      rule: { frequency: { kind: "monthlyOrdinalWeekday", ordinal: 3, day: "friday" } },
    });
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
