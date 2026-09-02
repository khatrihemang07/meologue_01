import { describe, expect, it } from "vitest";
import {
  highlightSegments,
  isEagerTokenKind,
  parseWithDemotions,
  quickAddHighlightClass,
  tokenAtOffset,
  tokenHighlightState,
  tokenSignature,
} from "./quick-add-highlight";

const NOW = "2026-09-02"; // Wednesday.

describe("tokenSignature", () => {
  it("combines kind and lower-cased raw text", () => {
    expect(tokenSignature({ kind: "recurrence", raw: "Monthly" })).toBe("recurrence:monthly");
  });

  it("keeps two different kinds with the same text apart", () => {
    expect(tokenSignature({ kind: "date", raw: "monday" })).not.toBe(
      tokenSignature({ kind: "recurrence", raw: "monday" }),
    );
  });
});

describe("parseWithDemotions", () => {
  it("parses exactly like parseQuickAdd when nothing is demoted", () => {
    const result = parseWithDemotions("buy milk tomorrow", { now: NOW }, new Set());

    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0]?.raw).toBe("tomorrow");
  });

  it("suppresses a token whose signature is in the demoted set", () => {
    const result = parseWithDemotions(
      "Create monthly report",
      { now: NOW },
      new Set(["recurrence:monthly"]),
    );

    expect(result.tokens).toHaveLength(0);
    expect(result.content).toBe("Create monthly report");
  });

  it("a demotion by signature suppresses every matching occurrence, not just one", () => {
    const result = parseWithDemotions(
      "monthly review and another monthly review",
      { now: NOW },
      new Set(["recurrence:monthly"]),
    );

    expect(result.tokens).toHaveLength(0);
  });

  it("a demotion for one signature leaves an unrelated token recognised", () => {
    const result = parseWithDemotions(
      "buy milk tomorrow p1",
      { now: NOW },
      new Set(["recurrence:monthly"]),
    );

    expect(result.tokens.map((t) => t.kind)).toEqual(["date", "priority"]);
  });
});

describe("tokenHighlightState", () => {
  it("is 'unresolved' for a project token, regardless of the caret", () => {
    const token = { kind: "project" as const, start: 0, end: 5 };

    expect(tokenHighlightState(token, null)).toBe("unresolved");
    expect(tokenHighlightState(token, 2)).toBe("unresolved"); // caret inside
    expect(tokenHighlightState(token, 5)).toBe("unresolved"); // caret just past
    expect(tokenHighlightState(token, 99)).toBe("unresolved"); // caret elsewhere
  });

  it("is 'unresolved' for a section token, regardless of the caret", () => {
    const token = { kind: "section" as const, start: 0, end: 5 };

    expect(tokenHighlightState(token, null)).toBe("unresolved");
    expect(tokenHighlightState(token, 3)).toBe("unresolved");
  });

  it("is 'pending' for a supported kind while the caret sits inside it", () => {
    const token = { kind: "date" as const, start: 4, end: 12 };

    expect(tokenHighlightState(token, 6)).toBe("pending");
  });

  it("is 'pending' for a supported kind while the caret sits immediately after it", () => {
    const token = { kind: "date" as const, start: 4, end: 12 };

    expect(tokenHighlightState(token, 12)).toBe("pending");
  });

  it("is 'resolved' once the caret sits exactly at the token's own start — not yet inside it", () => {
    const token = { kind: "date" as const, start: 4, end: 12 };

    expect(tokenHighlightState(token, 4)).toBe("resolved");
  });

  it("is 'resolved' for a supported kind once the caret has moved elsewhere", () => {
    const token = { kind: "priority" as const, start: 0, end: 2 };

    expect(tokenHighlightState(token, 10)).toBe("resolved");
  });

  it("is 'resolved' for a supported kind when nothing is focused at all", () => {
    const token = { kind: "label" as const, start: 0, end: 6 };

    expect(tokenHighlightState(token, null)).toBe("resolved");
  });
});

describe("quickAddHighlightClass", () => {
  it("returns undefined for 'unresolved' — no highlight at all", () => {
    expect(quickAddHighlightClass("project", "unresolved")).toBeUndefined();
  });

  it("returns a class for 'pending', regardless of kind", () => {
    expect(quickAddHighlightClass("date", "pending")).toBeDefined();
    expect(quickAddHighlightClass("label", "pending")).toBeDefined();
  });

  it("gives Priority and every Date-family kind a colour-worthy 'resolved' class", () => {
    for (const kind of ["date", "time", "deadline", "recurrence", "priority"] as const) {
      expect(quickAddHighlightClass(kind, "resolved")).toContain("quick-add-resolved-accent");
    }
  });

  it("gives every other supported kind a grayscale 'resolved' class instead", () => {
    for (const kind of ["label", "reminder", "uncompletable", "description"] as const) {
      const className = quickAddHighlightClass(kind, "resolved");
      expect(className).toContain("quick-add-resolved");
      expect(className).not.toContain("quick-add-resolved-accent");
    }
  });

  it("distinguishes the two resolved treatments by shape, not just colour", () => {
    // Colour-worthy kinds read as a squarer chip (rounded-[3px]); every
    // other resolved kind reads as a pill (rounded-full) — issue #179's
    // own brief: "distinguish the other kinds by chip shape."
    expect(quickAddHighlightClass("date", "resolved")).toContain("rounded-[3px]");
    expect(quickAddHighlightClass("label", "resolved")).toContain("rounded-full");
  });
});

describe("highlightSegments", () => {
  it("splits input into alternating plain/token runs off the tokens' own offsets", () => {
    const result = parseWithDemotions("buy milk tomorrow", { now: NOW }, new Set());
    // Caret elsewhere (not touching "tomorrow"), so it reads "resolved".
    const segments = highlightSegments("buy milk tomorrow", result.tokens, 0);

    expect(segments).toEqual([
      { text: "buy milk ", kind: null, state: null },
      { text: "tomorrow", kind: "date", state: "resolved" },
      { text: "", kind: null, state: null },
    ]);
  });

  it("reads a token as 'pending' when the caret is passed as sitting inside it", () => {
    const result = parseWithDemotions("buy milk tomorrow", { now: NOW }, new Set());
    const token = result.tokens[0];
    expect(token).toBeDefined();

    const segments = highlightSegments(
      "buy milk tomorrow",
      result.tokens,
      (token as NonNullable<typeof token>).start + 1,
    );

    expect(segments[1]).toEqual({ text: "tomorrow", kind: "date", state: "pending" });
  });

  it("handles no tokens at all as one plain run", () => {
    expect(highlightSegments("just words", [], null)).toEqual([
      { text: "just words", kind: null, state: null },
    ]);
  });

  it("handles two adjacent tokens with nothing between them", () => {
    // Two independently-placed tokens with a zero-width gap — real input
    // never actually produces two adjacent priority tokens this way, but
    // `highlightSegments` has no reason to assume adjacency can't happen
    // (a `%label` immediately followed by a `#project`, say, would).
    const segments = highlightSegments(
      "ab",
      [
        { kind: "priority", start: 0, end: 1, raw: "a", priority: 1 },
        { kind: "priority", start: 1, end: 2, raw: "b", priority: 1 },
      ],
      null,
    );

    expect(segments).toEqual([
      { text: "", kind: null, state: null },
      { text: "a", kind: "priority", state: "resolved" },
      { text: "", kind: null, state: null },
      { text: "b", kind: "priority", state: "resolved" },
      { text: "", kind: null, state: null },
    ]);
  });

  it("an unresolved token's text still appears in a segment — never stripped", () => {
    // `#Work` is recognised (project token) but has nowhere to land yet
    // (quick-add-task.ts's own UNSUPPORTED_TOKEN_KINDS) — issue #179's own
    // acceptance criterion: "left as plain words, neither highlighted nor
    // removed from what the reader typed."
    const result = parseWithDemotions("buy milk #Work", { now: NOW }, new Set());
    const projectToken = result.tokens.find((t) => t.kind === "project");
    expect(projectToken).toBeDefined();

    const segments = highlightSegments("buy milk #Work", result.tokens, null);
    const tokenSegment = segments.find((s) => s.text === "#Work");

    expect(tokenSegment).toEqual({ text: "#Work", kind: "project", state: "unresolved" });
  });
});

describe("tokenAtOffset", () => {
  it("finds the token whose span contains the offset", () => {
    const result = parseWithDemotions("buy milk tomorrow", { now: NOW }, new Set());
    const token = tokenAtOffset(result.tokens, 12); // inside "tomorrow"

    expect(token?.raw).toBe("tomorrow");
  });

  it("returns undefined for an offset in plain text", () => {
    const result = parseWithDemotions("buy milk tomorrow", { now: NOW }, new Set());

    expect(tokenAtOffset(result.tokens, 2)).toBeUndefined();
  });

  it("treats the offset just past a token's last character as outside it", () => {
    const result = parseWithDemotions("buy milk tomorrow", { now: NOW }, new Set());
    const token = result.tokens[0];
    expect(token).toBeDefined();

    expect(tokenAtOffset(result.tokens, (token as NonNullable<typeof token>).end)).toBeUndefined();
  });
});

describe("isEagerTokenKind", () => {
  it("names date, time and recurrence as the eager family", () => {
    expect(isEagerTokenKind("date")).toBe(true);
    expect(isEagerTokenKind("time")).toBe(true);
    expect(isEagerTokenKind("recurrence")).toBe(true);
  });

  it("names every sigil-marked kind as not eager", () => {
    for (const kind of [
      "project",
      "section",
      "label",
      "priority",
      "reminder",
      "deadline",
      "uncompletable",
      "description",
    ] as const) {
      expect(isEagerTokenKind(kind)).toBe(false);
    }
  });
});
