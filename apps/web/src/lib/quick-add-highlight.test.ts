import { describe, expect, it } from "vitest";
import {
  highlightSegments,
  isEagerTokenKind,
  parseWithDemotions,
  tokenAtOffset,
  tokenSignature,
} from "./quick-add-highlight";

const NOW = "2026-09-02"; // Wednesday.

describe("tokenSignature", () => {
  it("combines kind and lower-cased raw text", () => {
    expect(tokenSignature({ kind: "recurrence", raw: "Monthly" })).toBe("recurrence:monthly");
  });

  it("keeps two different kinds with the same text apart", () => {
    expect(tokenSignature({ kind: "date", raw: "for" })).not.toBe(
      tokenSignature({ kind: "duration", raw: "for" }),
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

describe("highlightSegments", () => {
  it("splits input into alternating plain/highlighted runs off the tokens' own offsets", () => {
    const result = parseWithDemotions("buy milk tomorrow", { now: NOW }, new Set());
    const segments = highlightSegments("buy milk tomorrow", result.tokens);

    expect(segments).toEqual([
      { text: "buy milk ", highlighted: false },
      { text: "tomorrow", highlighted: true },
      { text: "", highlighted: false },
    ]);
  });

  it("handles no tokens at all as one plain run", () => {
    expect(highlightSegments("just words", [])).toEqual([
      { text: "just words", highlighted: false },
    ]);
  });

  it("handles two adjacent tokens with nothing between them", () => {
    // Two independently-placed tokens with a zero-width gap — real input
    // never actually produces two adjacent priority tokens this way, but
    // `highlightSegments` has no reason to assume adjacency can't happen
    // (a `%label` immediately followed by a `#project`, say, would).
    const segments = highlightSegments("ab", [
      { kind: "priority", start: 0, end: 1, raw: "a", priority: 1 },
      { kind: "priority", start: 1, end: 2, raw: "b", priority: 1 },
    ]);

    expect(segments).toEqual([
      { text: "", highlighted: false },
      { text: "a", highlighted: true },
      { text: "", highlighted: false },
      { text: "b", highlighted: true },
      { text: "", highlighted: false },
    ]);
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
      "duration",
      "uncompletable",
      "description",
    ] as const) {
      expect(isEagerTokenKind(kind)).toBe(false);
    }
  });
});
