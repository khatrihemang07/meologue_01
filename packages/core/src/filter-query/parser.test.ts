import { describe, expect, it } from "vitest";
import { parseFilterQuery } from "./parser";
import { type FilterNode, FilterParseError } from "./types";

// The single expression a one-list query parses to — every case below
// that isn't specifically testing the comma (several result lists) uses
// this to avoid repeating `.lists[0].expr` everywhere.
function expr(query: string): FilterNode {
  return parseFilterQuery(query).lists[0]?.expr as FilterNode;
}

describe("flags", () => {
  it.each<["today" | "tomorrow" | "overdue" | "undated" | "recurring" | "subtask"]>([
    ["today"],
    ["tomorrow"],
    ["overdue"],
    ["undated"],
    ["recurring"],
    ["subtask"],
  ])("recognises %s", (flag) => {
    expect(expr(flag)).toEqual({ kind: "flag", flag });
  });

  it("is case-insensitive", () => {
    expect(expr("TODAY")).toEqual({ kind: "flag", flag: "today" });
    expect(expr("OverDue")).toEqual({ kind: "flag", flag: "overdue" });
  });
});

describe("priority", () => {
  it.each<[string, 1 | 2 | 3 | 4]>([
    ["p1", 1],
    ["p2", 2],
    ["p3", 3],
    ["p4", 4],
  ])("recognises %s", (atom, level) => {
    expect(expr(atom)).toEqual({ kind: "priority", level });
  });
});

describe("Project (criterion 3: name a Project, or a Project with everything under it)", () => {
  it("#Name is a Project, not including descendants", () => {
    expect(expr("#Work")).toEqual({ kind: "project", name: "Work", includeDescendants: false });
  });

  it("##Name is a Project with everything under it", () => {
    expect(expr("##Work")).toEqual({ kind: "project", name: "Work", includeDescendants: true });
  });

  it("a name may contain internal spaces", () => {
    expect(expr("#Home Chores")).toEqual({
      kind: "project",
      name: "Home Chores",
      includeDescendants: false,
    });
  });

  it("refuses a bare # with nothing named after it", () => {
    expect(() => expr("#")).toThrow(FilterParseError);
    expect(() => expr("# ")).toThrow(/Name something after "#"/);
  });

  it("refuses a bare ## with nothing named after it", () => {
    expect(() => expr("##")).toThrow(/Name something after "##"/);
  });
});

describe("Section", () => {
  it("/Name is a Section", () => {
    expect(expr("/Chores")).toEqual({ kind: "section", name: "Chores" });
  });

  it("refuses a bare / with nothing named", () => {
    expect(() => expr("/")).toThrow(/Name something after "\/"/);
  });
});

describe("Label", () => {
  it("@Name is a Label", () => {
    expect(expr("@urgent")).toEqual({ kind: "label", name: "urgent" });
  });

  it("refuses a bare @ with nothing named", () => {
    expect(() => expr("@")).toThrow(/Name something after "@"/);
  });
});

describe("date/deadline (criterion 3: naming a date or deadline explicitly)", () => {
  it.each<[string, "date" | "deadline", "on" | "before" | "after"]>([
    ["date:2026-09-10", "date", "on"],
    ["date<2026-09-10", "date", "before"],
    ["date>2026-09-10", "date", "after"],
    ["deadline:2026-09-10", "deadline", "on"],
    ["deadline<2026-09-10", "deadline", "before"],
    ["deadline>2026-09-10", "deadline", "after"],
  ])("recognises %s", (atom, field, op) => {
    expect(expr(atom)).toEqual({ kind: "due", field, op, value: "2026-09-10" });
  });

  it("is case-insensitive on the field name", () => {
    expect(expr("DATE:2026-09-10")).toEqual({
      kind: "due",
      field: "date",
      op: "on",
      value: "2026-09-10",
    });
  });

  it("refuses a value that isn't YYYY-MM-DD", () => {
    expect(() => expr("date:tomorrow")).toThrow(/needs a date in YYYY-MM-DD form/);
    expect(() => expr("date:2026-9-1")).toThrow(FilterParseError);
    expect(() => expr("deadline:not-a-date")).toThrow(FilterParseError);
  });
});

describe("not", () => {
  it("negates a flag", () => {
    expect(expr("!today")).toEqual({ kind: "not", operand: { kind: "flag", flag: "today" } });
  });

  it("negates a parenthesised group", () => {
    expect(expr("!(today | tomorrow)")).toEqual({
      kind: "not",
      operand: {
        kind: "or",
        left: { kind: "flag", flag: "today" },
        right: { kind: "flag", flag: "tomorrow" },
      },
    });
  });

  it("stacks", () => {
    expect(expr("!!today")).toEqual({
      kind: "not",
      operand: { kind: "not", operand: { kind: "flag", flag: "today" } },
    });
  });

  it("refuses a dangling ! with nothing to negate", () => {
    expect(() => expr("today & !")).toThrow(FilterParseError);
  });
});

describe("and / or", () => {
  it("a chain of & builds a left-associated and tree", () => {
    expect(expr("today & p1 & subtask")).toEqual({
      kind: "and",
      left: {
        kind: "and",
        left: { kind: "flag", flag: "today" },
        right: { kind: "priority", level: 1 },
      },
      right: { kind: "flag", flag: "subtask" },
    });
  });

  it("a chain of | builds a left-associated or tree", () => {
    expect(expr("today | tomorrow | overdue")).toEqual({
      kind: "or",
      left: {
        kind: "or",
        left: { kind: "flag", flag: "today" },
        right: { kind: "flag", flag: "tomorrow" },
      },
      right: { kind: "flag", flag: "overdue" },
    });
  });
});

describe("grouping", () => {
  it("parentheses change what a chain associates", () => {
    expect(expr("(today | tomorrow) & p1")).toEqual({
      kind: "and",
      left: {
        kind: "or",
        left: { kind: "flag", flag: "today" },
        right: { kind: "flag", flag: "tomorrow" },
      },
      right: { kind: "priority", level: 1 },
    });
  });

  it("nested parentheses parse", () => {
    expect(expr("((today))")).toEqual({ kind: "flag", flag: "today" });
  });

  it("refuses an unclosed (", () => {
    expect(() => expr("(today & p1")).toThrow(/missing its closing "\)"/);
  });

  it("refuses a stray, unmatched )", () => {
    expect(() => expr("today)")).toThrow(FilterParseError);
  });
});

describe("criterion 5: mixing & and | without explicit grouping is refused", () => {
  it("refuses a & b | c", () => {
    expect(() => expr("today & p1 | subtask")).toThrow(FilterParseError);
  });

  it("the error names both groupings a reader might have meant", () => {
    expect(() => expr("today & p1 | subtask")).toThrow(/\(a & b\) \| c.*a & \(b \| c\)/);
  });

  it("refuses a | b & c the other way round too", () => {
    expect(() => expr("today | p1 & subtask")).toThrow(FilterParseError);
  });

  it("parenthesising the & side resolves it", () => {
    expect(() => expr("(today & p1) | subtask")).not.toThrow();
  });

  it("parenthesising the | side resolves it", () => {
    expect(() => expr("today & (p1 | subtask)")).not.toThrow();
  });

  it("a mix is fine across two different comma-separated lists — each list is its own chain", () => {
    expect(() => parseFilterQuery("today & p1, tomorrow | overdue")).not.toThrow();
  });

  it("a mix inside one paren group but a different operator outside it is still refused", () => {
    // Outer level sees: (...) & subtask & (...) | today — mixing at the
    // outer level, which is exactly what's refused, regardless of what
    // the (already-resolved) inner groups contain.
    expect(() => expr("(today | tomorrow) & subtask | p1")).toThrow(FilterParseError);
  });
});

describe("criterion 2: separating a query into several result lists with a comma", () => {
  it("one list for a query with no comma", () => {
    const parsed = parseFilterQuery("today");
    expect(parsed.lists).toHaveLength(1);
    expect(parsed.lists[0]).toEqual({ label: "today", expr: { kind: "flag", flag: "today" } });
  });

  it("splits on comma into independent lists, each with its own label", () => {
    const parsed = parseFilterQuery("today, overdue, #Work");
    expect(parsed.lists.map((l) => l.label)).toEqual(["today", "overdue", "#Work"]);
    expect(parsed.lists.map((l) => l.expr)).toEqual([
      { kind: "flag", flag: "today" },
      { kind: "flag", flag: "overdue" },
      { kind: "project", name: "Work", includeDescendants: false },
    ]);
  });

  it("a list's own label is its trimmed source text, not an invented name", () => {
    const parsed = parseFilterQuery("  today & p1  ,  #Work  ");
    expect(parsed.lists.map((l) => l.label)).toEqual(["today & p1", "#Work"]);
  });

  it("refuses a trailing comma with nothing after it", () => {
    expect(() => parseFilterQuery("today,")).toThrow(FilterParseError);
  });

  it("refuses two commas in a row", () => {
    expect(() => parseFilterQuery("today,,tomorrow")).toThrow(FilterParseError);
  });
});

describe("criterion 6: an unparseable query says so plainly, pointing at the offending text", () => {
  it("refuses an empty query", () => {
    expect(() => parseFilterQuery("")).toThrow(/has no query yet/);
    expect(() => parseFilterQuery("   ")).toThrow(/has no query yet/);
  });

  it("refuses text this grammar doesn't recognise, naming the exact text", () => {
    expect(() => expr("someday")).toThrow(/"someday" isn't something this grammar recognises/);
  });

  it("every FilterParseError carries a span into the original text", () => {
    try {
      parseFilterQuery("today & bogus");
      expect.unreachable("expected parseFilterQuery to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(FilterParseError);
      const parseError = error as FilterParseError;
      expect(parseError.span).toEqual({ start: 8, end: 13 });
      expect("today & bogus".slice(parseError.span.start, parseError.span.end)).toBe("bogus");
    }
  });

  it("points at the & itself when & and | are mixed", () => {
    try {
      parseFilterQuery("today & p1 | subtask");
      expect.unreachable("expected parseFilterQuery to throw");
    } catch (error) {
      const parseError = error as FilterParseError;
      expect("today & p1 | subtask".slice(parseError.span.start, parseError.span.end)).toBe("|");
    }
  });

  it("two adjacent predicates with no operator between them is refused, not silently ANDed", () => {
    expect(() => parseFilterQuery("today p1")).toThrow(/need an operator between them/);
  });
});

describe("bare words stop at whitespace; only a sigil-led name may span one", () => {
  it("today p1 tokenizes as two atoms, not one nonsense atom", () => {
    expect(() => parseFilterQuery("today p1")).toThrow(FilterParseError);
    // If the tokenizer had swallowed the space, the error would instead
    // complain that `"today p1"` isn't recognised as a single atom —
    // asserting the "need an operator" message (above) already pins the
    // two-atoms reading; this asserts the *other* reading is impossible.
    expect(() => parseFilterQuery("today p1")).not.toThrow(/"today p1" isn't something/);
  });

  it("date:2026-09-10 has no internal spaces to spare — date: 2026-09-10 does not parse", () => {
    expect(() => parseFilterQuery("date: 2026-09-10")).toThrow(FilterParseError);
  });
});

describe("whitespace and punctuation tolerance", () => {
  it("ignores extra whitespace around operators and parentheses", () => {
    expect(expr("  today   &   p1  ")).toEqual({
      kind: "and",
      left: { kind: "flag", flag: "today" },
      right: { kind: "priority", level: 1 },
    });
  });

  it("tolerates no whitespace around operators at all", () => {
    expect(expr("today&p1")).toEqual({
      kind: "and",
      left: { kind: "flag", flag: "today" },
      right: { kind: "priority", level: 1 },
    });
  });
});
