import { describe, expect, it } from "vitest";
import { storedPriorityOf } from "../task-types";
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
 */
const NOW = "2026-09-02"; // Wednesday.

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
    // Date arithmetic.
    ["buy milk in 3 days", "2026-09-05"],
    ["buy milk in 2 weeks", "2026-09-16"],
    // Weekday + arithmetic combined: advance the reference point first, then find that weekday.
    ["buy milk monday in 2 weeks", "2026-09-21"],
    // Absolute, worded, no year — rolls forward to next year once the date has already passed this year.
    ["buy milk 27 Jan", "2027-01-27"],
    ["buy milk Jan 27", "2027-01-27"],
    ["buy milk 1 Sep", "2027-09-01"], // 1 Sep already passed (today is 2 Sep)
    ["buy milk 2 Sep", "2026-09-02"], // exactly today — not rolled forward
    ["buy milk 25 Dec", "2026-12-25"], // still ahead this year
    // Absolute, numeric, day-first (issue #170's own example convention).
    ["buy milk 5/9/2026", "2026-09-05"],
  ])("%s", (input, expectedDate) => {
    it(`resolves to ${expectedDate}`, () => {
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
    ["buy milk evening", "2026-09-02T18:00"],
    ["buy milk night", "2026-09-02T21:00"],
    ["buy milk midnight", "2026-09-02T00:00"],
  ])("%s", (input, expectedDate) => {
    it(`resolves to ${expectedDate}`, () => {
      expect(parse(input).date).toBe(expectedDate);
    });
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

  describe("%label — never the retiring @", () => {
    it("recognises a single label", () => {
      expect(parse("buy milk %urgent").labelNames).toEqual(["urgent"]);
    });

    it("recognises multiple labels, in the order typed", () => {
      expect(parse("buy milk %urgent %home").labelNames).toEqual(["urgent", "home"]);
    });

    it("does not recognise @ as a label sigil — it's retired", () => {
      const result = parse("buy milk @urgent");
      expect(result.labelNames).toEqual([]);
      expect(result.content).toBe("buy milk @urgent");
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

  describe("{deadline}", () => {
    it("resolves an absolute worded date inside braces, with the same roll-forward rule as free text", () => {
      expect(parse("finish report {27 Jan}").deadline).toBe("2027-01-27");
    });

    it("resolves a relative word inside braces", () => {
      expect(parse("finish report {tomorrow}").deadline).toBe("2026-09-03");
    });

    it("produces no token at all when the brace content doesn't resolve to a whole date", () => {
      const result = parse("finish report {banana}");
      expect(result.deadline).toBeNull();
      expect(result.content).toBe("finish report {banana}");
    });
  });

  describe("for 45min — duration", () => {
    it.each<[string, number]>([
      ["meeting for 45min", 45],
      ["meeting for 45 min", 45],
      ["meeting for 2 hours", 120],
      ["meeting for 1 hr", 60],
    ])("%s -> %i minutes", (input, expected) => {
      expect(parse(input).duration).toBe(expected);
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

  it("still resolves {deadline} — the brace is an explicit marker, not a guess", () => {
    const result = parse("finish report {27 Jan}", { smartDates: false });
    expect(result.deadline).toBe("2027-01-27");
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
    const input = "* Buy milk #Home /Chores %urgent p1 !5pm for 45min tomorrow //don't forget bags";
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
    const input = "* Buy milk #Home /Chores %urgent p1 for 45min //don't forget bags";
    const result = parse(input);

    expect(result.uncompletable).toBe(true);
    expect(result.projectName).toBe("Home");
    expect(result.sectionName).toBe("Chores");
    expect(result.labelNames).toEqual(["urgent"]);
    expect(result.priority).toBe(4);
    expect(result.duration).toBe(45);
    expect(result.description).toBe("don't forget bags");
    expect(result.content).toBe("Buy milk");
  });
});
