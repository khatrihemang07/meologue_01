import { mustParseLocalDateTimeKey, parseQuickAdd } from "@meologue/core";
import { describe, expect, it } from "vitest";
import {
  appendWords,
  applyTokenEdits,
  literalDateText,
  literalPriorityText,
  literalTimeText,
} from "./draft-chip-text";

const now = mustParseLocalDateTimeKey("2026-01-01T00:00");

describe("literalDateText", () => {
  it("formats a day as 'd MMM yyyy', with the year included", () => {
    expect(literalDateText("2026-12-25")).toBe("25 Dec 2026");
  });

  it("reads back through the real parser as the identical day", () => {
    const words = literalDateText("2026-01-05");
    const { tokens } = parseQuickAdd(words, { now });

    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ kind: "date", date: "2026-01-05" });
  });
});

describe("literalTimeText", () => {
  it("is the identity — HH:MM already round-trips through the 24-hour time form", () => {
    expect(literalTimeText("09:00")).toBe("09:00");

    const { tokens } = parseQuickAdd("09:00", { now });
    expect(tokens[0]).toMatchObject({ kind: "time", time: "09:00" });
  });
});

describe("literalPriorityText", () => {
  it("writes p1-p4, the exact sigil matchPriority recognises", () => {
    expect(literalPriorityText(1)).toBe("p1");
    expect(literalPriorityText(4)).toBe("p4");

    const { tokens } = parseQuickAdd("p2", { now });
    expect(tokens[0]?.kind).toBe("priority");
  });
});

describe("applyTokenEdits", () => {
  it("replaces a span in place, keeping the surrounding text", () => {
    expect(
      applyTokenEdits("Buy milk 5 Jan and eggs", [
        { start: 9, end: 14, replacement: "25 Dec 2026" },
      ]),
    ).toBe("Buy milk 25 Dec 2026 and eggs");
  });

  it("removes a span outright when replacement is null", () => {
    expect(applyTokenEdits("Buy milk 5 Jan", [{ start: 8, end: 14, replacement: null }])).toBe(
      "Buy milk",
    );
  });

  it("applies multiple edits without one shifting another's offsets", () => {
    const text = "a 1111 b 2222 c";
    const result = applyTokenEdits(text, [
      { start: 2, end: 6, replacement: "X" },
      { start: 9, end: 13, replacement: "Y" },
    ]);
    expect(result).toBe("a X b Y c");
  });

  it("collapses the double space a removal leaves behind", () => {
    // "a XXXX b" with "XXXX" (indices 2-5) removed leaves "a" + "" + " b",
    // i.e. "a  b" (two spaces) before collapsing.
    expect(applyTokenEdits("a XXXX b", [{ start: 2, end: 6, replacement: null }])).toBe("a b");
  });
});

describe("appendWords", () => {
  it("adds a single leading space onto existing text", () => {
    expect(appendWords("Buy milk", "25 Dec 2026")).toBe("Buy milk 25 Dec 2026");
  });

  it("adds no leading space onto empty (or whitespace-only) text", () => {
    expect(appendWords("", "25 Dec 2026")).toBe("25 Dec 2026");
    expect(appendWords("   ", "25 Dec 2026")).toBe("25 Dec 2026");
  });
});
