import { describe, expect, it } from "vitest";
import { storedPriorityOf } from "../task-types";
import { dateTimeKey } from "../test-support/day-key-fixture";
import { demoteQuickAddToken, parseQuickAdd } from "./parse-quick-add";
import type { QuickAddOptions, QuickAddToken } from "./types";

/**
 * The specification for the quick-add parser (issue #170's Part A) —
 * every date form, every token, every fuzzy time, the demotion path and
 * the offsets, as table-driven cases. A form not listed here is a form
 * this parser doesn't claim to recognise.
 *
 * `NOW` is fixed and independently verified (`node -e` against the
 * platform `Date` object, not this module's own code) to be a
 * **Wednesday** — every weekday-arithmetic expectation below was worked
 * out against that fact, not against whatever this parser happens to
 * compute, so a regression in the weekday math has something external to
 * disagree with.
 *
 * Issue #383 gave `QuickAddOptions.now` a time-of-day, and every table
 * below was written against a *day*, not a moment — `00:00` is the one
 * time-of-day no fuzzy/explicit time in this file's own tables (`00:00`
 * itself, midnight, included — strict less-than, `mergeDateAndTime`'s own
 * comment) can ever already be "past," so every existing expectation
 * stays today exactly as before this issue. The dedicated "already past
 * rolls to tomorrow" cases below use their own, later `now` explicitly.
 */
const NOW = dateTimeKey("2026-09-02T00:00"); // Wednesday, midnight.

function parse(input: string, options: Partial<QuickAddOptions> = {}) {
  return parseQuickAdd(input, { now: NOW, ...options });
}

describe("dates", () => {
  describe.each<[string, string]>([
    // Relative.
    ["buy milk today", "2026-09-02"],
    ["buy milk tod", "2026-09-02"],
    ["buy milk tomorrow", "2026-09-03"],
    ["buy milk tom", "2026-09-03"],
    ["buy milk tmr", "2026-09-03"],
    // Weekdays — bare resolves to the nearest occurrence on or after
    // today, including today itself when today already is that weekday.
    ["buy milk monday", "2026-09-07"],
    ["buy milk friday", "2026-09-04"],
    ["buy milk wednesday", "2026-09-02"], // today is a Wednesday
    // "next" always skips to the following week, even said on the day itself.
    ["buy milk next monday", "2026-09-14"],
    ["buy milk next wednesday", "2026-09-09"],
    // "this" is identical to bare.
    ["buy milk this fri", "2026-09-04"],
    ["buy milk this monday", "2026-09-07"],
    // "last" reproduces Todoist's own known bug (issue #367, D2): it
    // resolves identically to "next", not to the Monday that already
    // passed. See LAST_WEEKDAY_REPRODUCES_TODOIST_BUG in date-rules.ts
    // and the dedicated test below this table for the full citation.
    ["buy milk last monday", "2026-09-14"], // == next monday, NOT 2026-08-31
    // Date arithmetic.
    ["buy milk in 3 days", "2026-09-05"],
    ["buy milk in 2 weeks", "2026-09-16"],
    ["buy milk next week", "2026-09-07"],
    // Weekday + arithmetic combined: advance the reference point first, then find that weekday.
    ["buy milk monday in 2 weeks", "2026-09-21"],
    // Absolute, worded, no year — rolls forward to next year once the date has already passed this year.
    ["buy milk 27 Jan", "2027-01-27"],
    ["buy milk Jan 27", "2027-01-27"],
    ["buy milk 1 Sep", "2027-09-01"], // 1 Sep already passed (today is 2 Sep)
    ["buy milk 2 Sep", "2026-09-02"], // exactly today — not rolled forward
    ["buy milk 25 Dec", "2026-12-25"], // still ahead this year
    // Absolute, numeric, day-first (issue #170's own example convention).
    // The two-part form (no year) now reads `dayMonthOrder`'s preferred
    // order first, exactly as the three-part form does, falling back to
    // the other reading only when the preferred one has no valid month
    // at all (`resolveTwoPartMonthDay` in ./date-rules.ts) — proven
    // necessary, not just defensive, by the corpus's `9/24` row below.
    // See the flipped/added tests below this table for the pairs whose
    // reading changes as a result of the fix.
    ["buy milk 5/9/2026", "2026-09-05"],
    ["buy milk 24/9", "2026-09-24"], // still ahead this year — issue #366's corpus row: data-match-id "24 Sep"
    ["buy milk 9/24", "2026-09-24"], // same corpus date, digits swapped — data-match-id "24 Sep" again; only a day-first reading of "24" is possible either way
    ["buy milk 1/6", "2027-06-01"], // 1 Jun already passed (today is 2 Sep) — rolls forward
    // Issue #382's remaining numeric absolute-date forms — hyphen,
    // ISO 8601 (year-first, unambiguous), and dot-separated, alongside
    // the existing slash forms above.
    ["buy milk 24-09", "2026-09-24"],
    ["buy milk 2026-09-24", "2026-09-24"],
    ["buy milk 24.9.2026", "2026-09-24"],
    // Issue #382: bare "yesterday" wasn't in relativeDays at all.
    ["buy milk yesterday", "2026-09-01"],
    // Issue #382: spelled-out and reversed-word-order arithmetic,
    // alongside the existing digit/forward forms above.
    ["buy milk in three days", "2026-09-05"],
    ["buy milk 3 days from now", "2026-09-05"],
    // Issue #382: "end of month" — the current month's own last day.
    ["buy milk end of month", "2026-09-30"],
  ])("%s", (input, expectedDate) => {
    it(`resolves to ${expectedDate}`, () => {
      expect(parse(input).date).toBe(expectedDate);
    });
  });

  it("does not recognise 'end of month's abbreviations — Todoist doesn't either (issue #382)", () => {
    // The corpus's own PENDING reason (before this fixed it) is explicit
    // that these stay unmatched on both sides — a regression guard
    // against loosening matchEndOfMonth's regex to catch them.
    for (const abbreviation of ["eom", "eow", "end of week"]) {
      expect(parse(`buy milk ${abbreviation}`).date).toBeNull();
    }
  });

  it('"29 feb" (no year, non-leap target years on both sides) gracefully rolls into March, matching Todoist\'s own measured behaviour, rather than refusing the match (issue #382)', () => {
    // NOW is 2026-09-02: this year's own "29 Feb" (2026, non-leap) has
    // already passed, so this rolls to 2027's — also non-leap — which
    // itself rolls one month further into March, the identical
    // double-rollover the corpus's own row measures against a 19 Sep
    // 2026 capture date (landing on "1 Mar 2027").
    expect(parse("buy milk 29 feb").date).toBe("2027-03-01");
  });

  it('a "13/25"-shaped invalid month is still refused outright, not "rolled" into a different one (issue #382 regression guard)', () => {
    // pushIfValidCalendarDate now explicitly validates the month (1-12)
    // before ever allowing a day-rollover — this proves that guard is
    // still there, not silently defeated by the day-rollover leniency
    // "29 feb" above now needs.
    expect(parse("do it 13/25").date).toBeNull();
  });

  it("'next week' resolves to the next Monday", () => {
    expect(parseQuickAdd("buy milk next week", { now: dateTimeKey("2026-09-12T00:00") }).date).toBe(
      "2026-09-14",
    );
  });

  it("'next week' typed on a Monday is the Monday after, never today", () => {
    expect(parseQuickAdd("buy milk next week", { now: dateTimeKey("2026-09-14T00:00") }).date).toBe(
      "2026-09-21",
    );
  });

  it("reproduces Todoist's known bug: last monday resolves to next monday, not the Monday that already passed", () => {
    // Issue #367 / D2 (.scratch/todoist-add-todo/DECISIONS.md): measured
    // independently on Todoist web AND Android — both resolve "last
    // monday" to the same future date as "next monday", never to the
    // Monday that already passed this week. It is a bug in Todoist's own
    // shared parser, not a nuance, and it is reproduced here on purpose
    // per D1's clone standard (full clone, defects included) — see
    // docs/adr/0088-todoists-add-task-parser-is-cloned-verbatim-defects-included.md.
    // "this monday" and bare "monday" are unaffected: both still resolve
    // to the coming Monday, correctly.
    const now = dateTimeKey("2026-09-19T00:00"); // Saturday — the corpus's own capture date.
    expect(parseQuickAdd("buy milk last monday", { now }).date).toBe("2026-09-28");
    expect(parseQuickAdd("buy milk next monday", { now }).date).toBe("2026-09-28");
    expect(parseQuickAdd("buy milk this monday", { now }).date).toBe("2026-09-21");
    expect(parseQuickAdd("buy milk monday", { now }).date).toBe("2026-09-21");
  });

  it("reads the two-part numeric form day-first when both readings are valid, same as the three-part form (issue #366)", () => {
    // Previously asserted the opposite — "25/12" resolved to nothing,
    // because the two-part form was hardcoded month-first regardless of
    // `dayMonthOrder`, and reading it that same hardcoded way makes "12"
    // the month and "25" an invalid day-as-month. Flipped, not deleted:
    // under English's day-month order this is day 25, month 12 (25
    // Dec), and both digits are valid months on their own, so there is
    // no invalid-month fallback to reach for — the day-first reading
    // wins outright, the same disambiguation the three-part form already
    // applied to "5/9/2026".
    expect(parseQuickAdd("do it 25/12", { now: dateTimeKey("2026-09-02T00:00") }).date).toBe(
      "2026-12-25",
    );
  });

  it("falls back to the other reading when the day-first one has no valid month, rather than refusing the match", () => {
    // "12/25": day-first reads day 12, month 25 — not a valid month, so
    // this falls back to the other reading (month 12, day 25 = 25 Dec)
    // instead of staying unrecognised. Without this fallback, this
    // fix would regress the corpus's already-passing "9/24" row (see
    // the table above and resolveTwoPartMonthDay's own doc comment).
    expect(parseQuickAdd("do it 12/25", { now: dateTimeKey("2026-09-02T00:00") }).date).toBe(
      "2026-12-25",
    );
  });

  it("still refuses a two-part pair where neither reading has a valid month", () => {
    // "13/25": day-first reads month 25 (invalid); the fallback reads
    // month 13 (also invalid). No reading of this pair is a real
    // calendar date, so it stays unrecognised.
    expect(parseQuickAdd("do it 13/25", { now: dateTimeKey("2026-09-02T00:00") }).date).toBeNull();
  });

  describe("fuzzy weekend range (issue #366)", () => {
    // D1 (.scratch/todoist-add-todo/DECISIONS.md): Todoist's eager
    // detection is cloned including the false positives it causes —
    // rejecting a wrong match costs one click/Backspace, while never
    // detecting a real one leaves nothing to recover with. Dates below
    // are worked against this file's own NOW, 2026-09-02 (Wednesday).
    it.each<[string, string]>([
      ["buy milk this weekend", "2026-09-05"], // nearest Saturday on/after Wed 2 Sep
      ["buy milk weekend", "2026-09-05"], // bare == "this" here, same as matchWeekday's bare reading
      ["buy milk next weekend", "2026-09-12"], // always a full week past the nearest Saturday
    ])("%s -> %s", (input, expectedDate) => {
      expect(parse(input).date).toBe(expectedDate);
    });

    it("swallows the determiner: 'Pay for the weekend trip' matches 'the weekend', not bare 'weekend' — this reverses a previous non-match on purpose (D1)", () => {
      // Previously this parser correctly (by its own older design)
      // refused to schedule "the weekend" out of running prose. Under
      // D1's clone standard that refusal is now the bug: Todoist's own
      // corpus row for this exact sentence carries data-match-id
      // "19 Sep" against a 19 Sep 2026 capture date — it matches, and
      // the matched span is "the weekend" (with the determiner), not
      // "weekend" alone.
      const result = parse("Pay for the weekend trip");
      expect(result.date).toBe("2026-09-05");
      const dateToken = result.tokens.find((t) => t.kind === "date");
      expect(dateToken?.raw).toBe("the weekend");
      expect(result.content).toBe("Pay for trip");
    });
  });

  describe("next month / next year (issue #366)", () => {
    it("'next month' resolves to the same date, one month on", () => {
      expect(parse("buy milk next month").date).toBe("2026-10-02");
    });

    it("'next year' resolves to the same date, one year on — not 1 January", () => {
      // Issue #366's own ticket text paraphrased Todoist's help centre as
      // "next year resolves to 1 January." The measured corpus
      // contradicts that paraphrase: detection-corpus.json's "next year"
      // row carries data-match-id "19 Sep 2027" against a 19 Sep 2026
      // capture date — same day and month, year rolled forward once. D1
      // settles this in favour of the measured value over the doc
      // paraphrase.
      expect(parse("buy milk next year").date).toBe("2027-09-02");
    });
  });

  describe("holidays (issue #366)", () => {
    // .scratch/todoist-add-todo/research.md's own holiday table (no
    // corpus row measures these directly — the 117-row capture pass
    // never typed one). Resolved with the same year-roll-forward rule a
    // yearless absolute date already gets.
    it.each<[string, string]>([
      ["book flowers for valentine", "2027-02-14"], // 14 Feb already passed this year (today is 2 Sep) — rolls forward
      ["get a costume for halloween", "2026-10-31"], // still ahead this year
      ["plan the new year day brunch", "2027-01-01"], // rolls forward
      ["book a table for new year eve", "2026-12-31"], // still ahead this year
    ])("%s -> %s", (input, expectedDate) => {
      expect(parse(input).date).toBe(expectedDate);
    });
  });
});

describe("times", () => {
  describe.each<[string, string]>([
    ["call John at 5pm", "2026-09-02T17:00"],
    ["call John 5pm", "2026-09-02T17:00"],
    ["call John 17:00", "2026-09-02T17:00"],
    ["call John 9am", "2026-09-02T09:00"],
    ["call John 12am", "2026-09-02T00:00"], // midnight edge case
    ["call John 12pm", "2026-09-02T12:00"], // noon edge case
    ["call John tomorrow at 5pm", "2026-09-03T17:00"], // date + time merge
  ])("%s", (input, expectedDate) => {
    it(`resolves to ${expectedDate}`, () => {
      expect(parse(input).date).toBe(expectedDate);
    });
  });

  it("a lone time with no date word attaches to today, not to nothing", () => {
    expect(parse("call John 5pm").date).toBe("2026-09-02T17:00");
  });
});

describe("fuzzy times", () => {
  describe.each<[string, string]>([
    ["buy milk morning", "2026-09-02T09:00"],
    ["buy milk noon", "2026-09-02T12:00"],
    ["buy milk afternoon", "2026-09-02T15:00"],
    // Issue #382: flipped from 18:00 to 19:00 — the corpus's own measured
    // row (`data-match-id` "19 Sep 19:00" against the capture date) shows
    // the earlier 18:00 was an unverified guess, not something Todoist
    // itself does.
    ["buy milk evening", "2026-09-02T19:00"],
    ["buy milk night", "2026-09-02T21:00"],
    ["buy milk midnight", "2026-09-02T00:00"],
    // Issue #382's own corpus row — "tonight" wasn't in fuzzyTimes at all.
    ["buy milk tonight", "2026-09-02T22:00"],
  ])("%s", (input, expectedDate) => {
    it(`resolves to ${expectedDate}`, () => {
      expect(parse(input).date).toBe(expectedDate);
    });
  });
});

describe("a time already past rolls to tomorrow, one still ahead stays today (issue #383)", () => {
  // A later `now` than this file's own default (`00:00`, chosen so every
  // pre-#383 table above stays valid unchanged) — 14:00, deliberately
  // between "morning"'s 09:00 and "evening"'s 19:00, so this one `now`
  // exercises both sides of the roll-forward decision across a single
  // table: fuzzy and explicit times below it roll to tomorrow, ones above
  // it stay today.
  const laterNow = dateTimeKey("2026-09-02T14:00");

  describe.each<[string, string]>([
    ["buy milk noon", "2026-09-03T12:00"], // 12:00 < 14:00 -> tomorrow
    ["buy milk midnight", "2026-09-03T00:00"], // 00:00 < 14:00 -> tomorrow
    ["buy milk morning", "2026-09-03T09:00"], // 09:00 < 14:00 -> tomorrow
    ["buy milk evening", "2026-09-02T19:00"], // 19:00 still ahead -> today
    ["buy milk 1pm", "2026-09-03T13:00"], // an explicit time rolls too, not just fuzzy ones
    ["buy milk 5pm", "2026-09-02T17:00"], // 17:00 still ahead -> today
    // Issue #383's own new form: a bare hour with no meridiem ("at 5").
    ["buy milk at 5", "2026-09-03T05:00"],
  ])("%s", (input, expectedDate) => {
    it(`resolves to ${expectedDate}`, () => {
      expect(parseQuickAdd(input, { now: laterNow }).date).toBe(expectedDate);
    });
  });

  it("a time exactly equal to now's own stays today — strict less-than, not less-than-or-equal", () => {
    // Unmeasured by the corpus either way (this file's own header comment
    // on `mergeDateAndTime`'s choice) — this is the boundary the choice
    // actually governs, pinned down explicitly rather than left implicit.
    expect(parseQuickAdd("buy milk 2pm", { now: laterNow }).date).toBe("2026-09-02T14:00");
  });

  it("an explicit date token pins the day outright — no roll-forward question even arises", () => {
    // "5pm" alone (17:00) is still ahead of 14:00 and wouldn't roll
    // anyway at this `now`, so this specifically needs a time that
    // *would* roll if it were bare, to prove the explicit date is what's
    // actually suppressing the roll-forward check, not a coincidence of
    // this particular hour.
    expect(parseQuickAdd("buy milk 1pm 25 dec", { now: laterNow }).date).toBe("2026-12-25T13:00");
  });

  // Issue #383's own new arithmetic forms — full-instant results, not
  // merged from a separate date+time pair, so they're unaffected by
  // (and don't need) the roll-forward question above: they're already
  // computed straight off `now`'s own instant.
  it('"in an hour" adds 60 minutes to the full instant', () => {
    expect(parseQuickAdd("buy milk in an hour", { now: laterNow }).date).toBe("2026-09-02T15:00");
  });

  it('"in 30 min" adds 30 minutes to the full instant', () => {
    expect(parseQuickAdd("buy milk in 30 min", { now: laterNow }).date).toBe("2026-09-02T14:30");
  });

  it('"in an hour" rolls the calendar day too, when the addition crosses midnight', () => {
    const lateNow = dateTimeKey("2026-09-02T23:30");
    expect(parseQuickAdd("buy milk in an hour", { now: lateNow }).date).toBe("2026-09-03T00:30");
  });
});

describe("tokens", () => {
  describe("#project", () => {
    it("recognises a project name", () => {
      expect(parse("buy milk #Home").projectName).toBe("Home");
    });

    it("removes the token from content", () => {
      expect(parse("buy milk #Home").content).toBe("buy milk");
    });
  });

  describe("/section", () => {
    it("recognises a section name", () => {
      expect(parse("buy milk /Chores").sectionName).toBe("Chores");
    });

    it("does not confuse the `/` in a numeric date for a section", () => {
      const result = parse("buy milk 5/9/2026");
      expect(result.sectionName).toBeNull();
      expect(result.date).toBe("2026-09-05");
    });
  });

  describe("@label / %label — issue #226 restored @, issue #369 re-added %", () => {
    it("recognises a single @ label", () => {
      expect(parse("buy milk @urgent").labelNames).toEqual(["urgent"]);
    });

    it("recognises multiple @ labels, in the order typed", () => {
      expect(parse("buy milk @urgent @home").labelNames).toEqual(["urgent", "home"]);
    });

    // Todoist's help centre now documents `%label` as the sigil, with "@
    // also works for now, but is planned to be retired by the end of
    // 2026." Measured in the live app: both are fully equivalent today —
    // same dropdown, same resolved label id, same saved result, no
    // deprecation hint anywhere in the UI — so meologue recognises both,
    // not just the one Todoist's docs currently lead with. `%` was
    // deliberately retired here by issue #226 in favour of `@` alone;
    // this is Todoist itself reversing that call, not a return to a bug.
    it("recognises a single % label — the sigil Todoist itself un-retired", () => {
      expect(parse("buy milk %urgent").labelNames).toEqual(["urgent"]);
    });

    it("recognises a hyphenated % label name", () => {
      expect(parse("buy milk %book-club").labelNames).toEqual(["book-club"]);
    });

    it("recognises @ and % labels mixed in the same line, in the order typed", () => {
      expect(parse("buy milk @urgent %home").labelNames).toEqual(["urgent", "home"]);
    });

    it("removes a % label from content, exactly like an @ label", () => {
      expect(parse("buy milk %urgent").content).toBe("buy milk");
    });
  });

  describe("p1-p4 — through storedPriorityOf, p1 is most urgent", () => {
    it.each<[string, number]>([
      ["buy milk p1", storedPriorityOf(1)],
      ["buy milk p2", storedPriorityOf(2)],
      ["buy milk p3", storedPriorityOf(3)],
      ["buy milk p4", storedPriorityOf(4)],
    ])("%s -> stored priority %i", (input, expected) => {
      expect(parse(input).priority).toBe(expected);
    });

    it("p1 stores as 4, the most urgent stored level", () => {
      expect(parse("buy milk p1").priority).toBe(4);
    });

    it("defaults to 1 (no priority) when no p-token is present", () => {
      expect(parse("buy milk").priority).toBe(1);
    });

    it("does not fire inside an ordinary word", () => {
      expect(parse("prepare the report").priority).toBe(1);
    });

    // Issue #382's own corpus row — "!!N" as an alternate spelling of
    // "pN", resolving to the identical stored priority.
    describe("!!1-!!4 — the alternate spelling issue #382 added", () => {
      it.each<[string, number]>([
        ["buy milk !!1", storedPriorityOf(1)],
        ["buy milk !!2", storedPriorityOf(2)],
        ["buy milk !!3", storedPriorityOf(3)],
        ["buy milk !!4", storedPriorityOf(4)],
      ])("%s -> stored priority %i", (input, expected) => {
        expect(parse(input).priority).toBe(expected);
      });

      it("wins the whole span over matchReminder's own greedy per-`!` scan", () => {
        // Before this rule recognised "!!N" as one compound token, each
        // "!" was read independently by matchReminder as a bare reminder
        // marker, and "1" was left as stray content — this is the
        // regression that push-order priority (matchPriority is pushed
        // ahead of matchReminder) now prevents.
        const result = parse("buy milk !!1");
        expect(result.priority).toBe(storedPriorityOf(1));
        expect(result.reminderTime).toBeNull();
        expect(result.content).toBe("buy milk");
      });

      it("removes the token from content, exactly like p1-p4", () => {
        expect(parse("buy milk !!1").content).toBe("buy milk");
      });
    });
  });

  describe("!reminder", () => {
    it("recognises a reminder with an explicit time, no `at`", () => {
      expect(parse("buy milk !5pm").reminderTime).toBe("17:00");
    });

    it("recognises a reminder with `at`", () => {
      expect(parse("buy milk !at 5pm").reminderTime).toBe("17:00");
    });

    it("still produces a token when no time follows — the marker alone is meaningful", () => {
      const result = parse("buy milk !");
      expect(result.reminderTime).toBeNull();
      expect(result.tokens.some((t) => t.kind === "reminder")).toBe(true);
    });
  });

  describe("{deadline} — no longer a token (issue #377 removed Deadline)", () => {
    it.each<string>([
      "finish report {27 Jan}",
      "finish report {tomorrow}",
      "finish report {banana}",
    ])("%s produces no token, and stays exactly as typed", (input) => {
      const result = parse(input);
      expect(result.tokens).toEqual([]);
      expect(result.content).toBe(input);
    });
  });

  describe("'for 45min' — no longer a token (issue #179 removed Duration)", () => {
    it.each<string>([
      "meeting for 45min",
      "meeting for 45 min",
      "meeting for 2 hours",
      "meeting for 1 hr",
    ])("%s produces no token, and stays exactly as typed", (input) => {
      const result = parse(input);
      expect(result.tokens).toEqual([]);
      expect(result.content).toBe(input);
    });
  });

  describe("leading '* ' — uncompletable", () => {
    it("marks the Task uncompletable and strips the marker from content", () => {
      const result = parse("* buy milk");
      expect(result.uncompletable).toBe(true);
      expect(result.content).toBe("buy milk");
    });

    it("does not fire mid-sentence — only a leading marker counts", () => {
      const result = parse("call * mom");
      expect(result.uncompletable).toBe(false);
      expect(result.content).toBe("call * mom");
    });
  });

  describe("//description", () => {
    it("captures everything after the first // as description text, trimmed", () => {
      const result = parse("buy milk //don't forget the eggs");
      expect(result.description).toBe("don't forget the eggs");
      expect(result.content).toBe("buy milk");
    });

    // Issue #386, found while building the #364 corpus fixture: the URL's
    // own `//` was read as this sigil, so everything after it — the rest
    // of the URL — moved out of the title and into `description`.
    it("leaves a URL's own // alone — the whole URL stays in the title, no description", () => {
      const result = parse("Read https://example.com/post");
      expect(result.description).toBeNull();
      expect(result.content).toBe("Read https://example.com/post");
      expect(result.tokens).toEqual([]);
    });

    it("still recognises an ordinary // description next to a URL-free sentence", () => {
      const result = parse("Buy milk // from the corner shop");
      expect(result.description).toBe("from the corner shop");
      expect(result.content).toBe("Buy milk");
    });

    // Deliberately NOT guarded — see urlSpans's own doc comment in
    // rules.ts for why a schemeless URL is out of scope for this fix.
    // Documented here so a future reader finds a test, not a silent gap.
    it("does NOT protect a schemeless URL's // — a known, deliberate gap", () => {
      const result = parse("example.com//x");
      expect(result.description).toBe("x");
      expect(result.content).toBe("example.com");
    });
  });

  // Issue #386's own regression: `matchDescription`'s old bug (claiming the
  // whole remainder of the input) was incidentally masking this one too —
  // `matchSection`'s `/` re-fired on a URL's own path segment once that bug
  // was fixed, which would have put the URL right back to being mangled by
  // a different rule.
  describe("URLs survive sigil rules other than // too (issue #386)", () => {
    it("a URL's own /path is not read as /section", () => {
      const result = parse("Read https://example.com/post");
      expect(result.sectionName).toBeNull();
      expect(result.content).toBe("Read https://example.com/post");
    });

    it("a URL fragment is not read as #project", () => {
      const result = parse("Read https://example.com/post#intro");
      expect(result.projectName).toBeNull();
      expect(result.content).toBe("Read https://example.com/post#intro");
    });

    it("an ordinary /section right after a URL-free word still works", () => {
      const result = parse("file it /Work");
      expect(result.sectionName).toBe("Work");
      expect(result.content).toBe("file it");
    });
  });
});

describe("the 'Create monthly report' false positive and demotion", () => {
  // Todoist's own documented false positive (issue #170's brief): a bare
  // recurrence word is recognised even with no `every` in sight. This
  // parser recognises it and stops there — see ./date-rules.ts's
  // matchRecurrenceWord for why resolving it into an actual recurrence
  // rule is ../recurrence/'s job, not this one's.
  it("recognises 'monthly' as a recurrence-shaped span", () => {
    const result = parse("Create monthly report");
    const recurrenceToken = result.tokens.find((t) => t.kind === "recurrence");
    expect(recurrenceToken).toBeDefined();
    expect(recurrenceToken?.raw).toBe("monthly");
    expect(result.content).toBe("Create report");
  });

  it("demotion restores the word to plain content and removes the token", () => {
    const input = "Create monthly report";
    const first = parse(input);
    // biome-ignore lint/style/noNonNullAssertion: asserted present by the previous test
    const recurrenceToken = first.tokens.find((t) => t.kind === "recurrence")!;

    const demoted = demoteQuickAddToken(input, recurrenceToken, { now: NOW });

    expect(demoted.tokens.some((t) => t.kind === "recurrence")).toBe(false);
    expect(demoted.content).toBe("Create monthly report");
  });
});

describe("recurrence phrases (issue #188)", () => {
  describe.each<[string, string, string]>([
    ["water the plants every day", "every day", "water the plants"],
    ["call mum every monday", "every monday", "call mum"],
    ["water the plants every 2 weeks", "every 2 weeks", "water the plants"],
    ["submit report every 3rd friday", "every 3rd friday", "submit report"],
    ["water plants every! 2 weeks", "every! 2 weeks", "water plants"],
    // An optional trailing clause the grammar supports is captured whole
    // rather than the matcher stopping at the shortest thing that
    // happens to parse ("every day" alone also parses, but would leave
    // "at 5pm" behind as stray words).
    ["take pills every day at 5pm", "every day at 5pm", "take pills"],
    ["pay rent every month starting 1 oct", "every month starting 1 oct", "pay rent"],
    // One-word "everyday" (issue #369) — one of Todoist's own published
    // recurrence-table rows, glued with no space at all. Parses
    // identically to the spaced form, including with a trailing clause.
    ["water the plants everyday", "everyday", "water the plants"],
    ["pay rent everyday starting 1 nov", "everyday starting 1 nov", "pay rent"],
    // Five phrasings the #364 corpus fixture measured as pending (issue
    // #385) — each input below is the corpus's own exact string.
    ["water plants ev day", "ev day", "water plants"],
    ["take out the trash every weekday", "every weekday", "take out the trash"],
    ["pay rent every 1st", "every 1st", "pay rent"],
    ["pay rent every month on the 1st", "every month on the 1st", "pay rent"],
    ["renew passport every jan 1", "every jan 1", "renew passport"],
  ])("%s", (input, expectedRaw, expectedContent) => {
    it(`recognises "${expectedRaw}" as one recurrence span and strips it from content`, () => {
      const result = parse(input);
      const recurrenceTokens = result.tokens.filter((t) => t.kind === "recurrence");
      expect(recurrenceTokens).toHaveLength(1);
      const [token] = recurrenceTokens as [QuickAddToken];
      expect(token.raw).toBe(expectedRaw);
      // Span boundaries: `raw` is exactly `input.slice(start, end)`, the
      // same guarantee every other token in this parser carries.
      expect(input.slice(token.start, token.end)).toBe(expectedRaw);
      expect(result.content).toBe(expectedContent);
      // Never resolved here — this parser only ever flags the span
      // (this describe block's own header comment); `result.date` stays
      // untouched by a recurrence token, exactly as it does for a bare
      // recurrence word.
      expect(result.date).toBeNull();
    });
  });

  it("a compound phrase wins the words a shorter, plain rule would otherwise also match", () => {
    // Without push-order priority, "monday" alone would be claimed by
    // matchWeekday first and the surrounding "every "/"" would be left as
    // stray text — the identical reasoning matchWeekdayArithmeticCombo's
    // own doc comment gives for "monday in 2 weeks" over plain "monday".
    const result = parse("call mum every monday");
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0]).toMatchObject({ kind: "recurrence", raw: "every monday" });
  });

  it("does not swallow the rest of the sentence — only the longest prefix the engine accepts", () => {
    const result = parse("every day I will water the plants and read");
    const recurrenceToken = result.tokens.find((t) => t.kind === "recurrence");
    expect(recurrenceToken?.raw).toBe("every day");
    expect(result.content).toBe("I will water the plants and read");
  });

  it("coexists with a separate, explicit date token elsewhere in the input", () => {
    const result = parse("review contract 27 Jan every month");
    const kinds = result.tokens.map((t) => t.kind);
    expect(kinds).toEqual(["date", "recurrence"]);
    const dateToken = result.tokens.find((t) => t.kind === "date");
    expect(dateToken?.raw).toBe("27 Jan");
    const recurrenceToken = result.tokens.find((t) => t.kind === "recurrence");
    expect(recurrenceToken?.raw).toBe("every month");
    expect(result.content).toBe("review contract");
    // A bare recurrence word overrides result.date in quick-add-task.ts's
    // own bridge (apps/web), never here — this parser's own `date` field
    // is still whatever plain date token was recognised, unmodified by
    // the separate recurrence token.
    expect(result.date).toBe("2027-01-27");
  });

  describe("smart date recognition can be turned off entirely", () => {
    it("stops recognising a recurrence phrase, exactly as it does a bare recurrence word", () => {
      const result = parse("water the plants every day", { smartDates: false });
      expect(result.tokens.some((t) => t.kind === "recurrence")).toBe(false);
      expect(result.content).toBe("water the plants every day");
    });

    it("does not let the suppressed phrase's own bang fall back to an unrelated !reminder", () => {
      // `isEveryBangAt` (./date-rules.ts) excludes "every!"'s own `!` from
      // matchReminder unconditionally — settled by what precedes the
      // `!`, not by whether smartDates would actually surface a
      // recurrence token this parse. With smartDates off there is no
      // recurrence token to claim it either, so the `!` is left as
      // plain, unrecognised text rather than becoming a reminder marker
      // it was never meant to be.
      const result = parse("water plants every! 2 weeks", { smartDates: false });
      expect(result.tokens).toHaveLength(0);
      expect(result.content).toBe("water plants every! 2 weeks");
    });
  });

  describe("demotion", () => {
    it("restores the phrase to plain content and removes the token", () => {
      const input = "water the plants every day";
      const first = parse(input);
      const recurrenceToken = first.tokens.find((t) => t.kind === "recurrence");
      expect(recurrenceToken).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: asserted present above
      const demoted = demoteQuickAddToken(input, recurrenceToken!, { now: NOW });

      expect(demoted.tokens.some((t) => t.kind === "recurrence")).toBe(false);
      expect(demoted.content).toBe(input);
    });
  });

  describe("a phrase the recurrence engine refuses is left as ordinary words", () => {
    it.each<string>([
      // "fortnight" isn't a unit ../recurrence/'s grammar accepts (only
      // "fortnightly", the *bare word* this parser's own separate table
      // maps to "every 2 weeks" — this ticket's whole point is that a
      // phrase reuses the real grammar rather than a second one, so
      // this is expected to fail, not a gap to special-case).
      "water plants every fortnight",
      // A dangling interval with no unit at all.
      "water plants every 2",
      // Not even the fixed "every" anchor.
      "water plants regularly",
      // Nonsense after the anchor.
      "water plants every zorp thing",
      // "everyday" (issue #369) is deliberately narrow: it's "every" glued
      // onto exactly the word "day", not "every" glued onto any word —
      // "everybody" must stay ordinary text, not a false-positive
      // recurrence span.
      "everybody loves cake",
    ])("%s", (input) => {
      const result = parse(input);
      expect(result.tokens.some((t) => t.kind === "recurrence")).toBe(false);
      expect(result.content).toBe(input);
    });
  });
});

describe("after N days (issue #369)", () => {
  describe.each<[string, string, string]>([
    ["restock after 10 days", "after 10 days", "restock"],
    ["water plants after 1 day", "after 1 day", "water plants"],
  ])("%s", (input, expectedRaw, expectedContent) => {
    it(`recognises "${expectedRaw}" as one recurrence span and strips it from content`, () => {
      const result = parse(input);
      const recurrenceTokens = result.tokens.filter((t) => t.kind === "recurrence");
      expect(recurrenceTokens).toHaveLength(1);
      const [token] = recurrenceTokens as [QuickAddToken];
      expect(token.raw).toBe(expectedRaw);
      expect(input.slice(token.start, token.end)).toBe(expectedRaw);
      expect(result.content).toBe(expectedContent);
      // Never resolved here — the same "this parser only ever flags the
      // span" discipline the phrase-recognition block above documents;
      // apps/web/src/lib/quick-add-task.ts's `resolveRecurrencePhrase` is
      // where "after 10 days" actually becomes "every! 10 days".
      expect(result.date).toBeNull();
    });
  });

  it("stops recognising the phrase when smartDates is off, exactly like every other eager rule", () => {
    const result = parse("restock after 10 days", { smartDates: false });
    expect(result.tokens.some((t) => t.kind === "recurrence")).toBe(false);
    expect(result.content).toBe("restock after 10 days");
  });

  describe("demotion", () => {
    it("restores the phrase to plain content and removes the token", () => {
      const input = "restock after 10 days";
      const first = parse(input);
      const recurrenceToken = first.tokens.find((t) => t.kind === "recurrence");
      expect(recurrenceToken).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: asserted present above
      const demoted = demoteQuickAddToken(input, recurrenceToken!, { now: NOW });
      expect(demoted.tokens.some((t) => t.kind === "recurrence")).toBe(false);
      expect(demoted.content).toBe(input);
    });
  });
});

describe("demotion — general", () => {
  it("re-derives the result with the demoted span excluded from recognition", () => {
    const input = "buy milk tomorrow";
    const first = parse(input);
    expect(first.date).toBe("2026-09-03");
    // biome-ignore lint/style/noNonNullAssertion: "tomorrow" is asserted recognised above
    const dateToken = first.tokens.find((t) => t.kind === "date")!;

    const demoted = demoteQuickAddToken(input, dateToken, { now: NOW });

    expect(demoted.date).toBeNull();
    expect(demoted.content).toBe("buy milk tomorrow");
  });

  it("a demoted span doesn't block a different token from claiming the same text on a later parse", () => {
    const input = "buy milk tomorrow";
    const first = parse(input);
    // biome-ignore lint/style/noNonNullAssertion: "tomorrow" is asserted recognised above
    const dateToken = first.tokens.find((t) => t.kind === "date")!;

    // Demote the date, then separately ask for smartDates off entirely —
    // "tomorrow" should read as ordinary content either way, and the
    // demoted span shouldn't itself become some kind of exclusion zone
    // other rules also have to avoid.
    const demoted = parseQuickAdd(input, {
      now: NOW,
      demoted: [{ start: dateToken.start, end: dateToken.end }],
    });
    expect(demoted.content).toBe("buy milk tomorrow");
    expect(demoted.tokens).toHaveLength(0);
  });
});

describe("smart date recognition can be turned off entirely", () => {
  it("stops recognising free-text dates, weekdays and times", () => {
    const result = parse("buy milk tomorrow at 5pm", { smartDates: false });
    expect(result.date).toBeNull();
    expect(result.content).toBe("buy milk tomorrow at 5pm");
  });

  it("still recognises sigil-marked tokens — #project", () => {
    const result = parse("buy milk tomorrow #errand", { smartDates: false });
    expect(result.projectName).toBe("errand");
    expect(result.date).toBeNull();
  });

  it("{27 Jan} produces no token either way — issue #377 removed the brace grammar entirely, not just its smartDates gating", () => {
    const result = parse("finish report {27 Jan}", { smartDates: false });
    expect(result.tokens).toEqual([]);
    expect(result.content).toBe("finish report {27 Jan}");
  });

  it("still resolves !reminder", () => {
    const result = parse("remind me !5pm", { smartDates: false });
    expect(result.reminderTime).toBe("17:00");
  });

  it("does not flag a bare recurrence word either — smartDates governs the whole eager family", () => {
    const result = parse("Create monthly report", { smartDates: false });
    expect(result.tokens.some((t) => t.kind === "recurrence")).toBe(false);
    expect(result.content).toBe("Create monthly report");
  });
});

describe("offsets", () => {
  it("every token's raw text is exactly input.slice(start, end)", () => {
    const input = "* Buy milk #Home /Chores @urgent p1 !5pm tomorrow //don't forget bags";
    const result = parse(input);
    expect(result.tokens.length).toBeGreaterThan(0);
    for (const token of result.tokens) {
      expect(input.slice(token.start, token.end)).toBe(token.raw);
    }
  });

  // The exact case issue #170's brief warns about: the same word
  // appearing twice must not be re-found by searching `input` for its
  // first occurrence — each token carries its own, distinct offsets.
  it("distinguishes two occurrences of the same word by offset, not by re-searching the input", () => {
    const input = "Monday call, then Monday morning";
    const result = parse(input);
    const dateTokens = result.tokens.filter((t) => t.kind === "date");
    expect(dateTokens).toHaveLength(2);
    const [first, second] = dateTokens as [QuickAddToken, QuickAddToken];

    expect(first.start).not.toBe(second.start);
    expect(input.slice(first.start, first.end)).toBe("Monday");
    expect(input.slice(second.start, second.end)).toBe("Monday");
    // Both occurrences of the bare weekday resolve to the identical
    // date (the point being made is about *offsets*, not resolution) —
    // the offsets are what would break if this were implemented as
    // "find the first 'Monday' in the string" instead.
    expect(first).toMatchObject({ date: "2026-09-07" });
    expect(second).toMatchObject({ date: "2026-09-07" });
  });

  it("collapses removed tokens' whitespace in content rather than leaving gaps", () => {
    expect(parse("  buy   milk  #Home  ").content).toBe("buy milk");
  });
});

describe("a fully-loaded input — every non-colliding token family at once", () => {
  it("recognises every piece and strips it all from content", () => {
    const input = "* Buy milk #Home /Chores @urgent p1 //don't forget bags";
    const result = parse(input);

    expect(result.uncompletable).toBe(true);
    expect(result.projectName).toBe("Home");
    expect(result.sectionName).toBe("Chores");
    expect(result.labelNames).toEqual(["urgent"]);
    expect(result.priority).toBe(4);
    expect(result.description).toBe("don't forget bags");
    expect(result.content).toBe("Buy milk");
  });
});
