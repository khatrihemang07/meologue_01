import { describe, expect, it } from "vitest";
import { highlightSubstring } from "./task-search-match";

describe("highlightSubstring", () => {
  it("returns the whole text unmatched when the query is empty", () => {
    expect(highlightSubstring("a recurring task", "")).toEqual([
      { text: "a recurring task", matched: false },
    ]);
  });

  it("highlights a fragment from the middle of a word, not just a prefix", () => {
    expect(highlightSubstring("a recurring task", "urring")).toEqual([
      { text: "a rec", matched: false },
      { text: "urring", matched: true },
      { text: " task", matched: false },
    ]);
  });

  it("is case-insensitive", () => {
    expect(highlightSubstring("Buildzzzing", "UILDZ")).toEqual([
      { text: "B", matched: false },
      { text: "uildz", matched: true },
      { text: "zzing", matched: false },
    ]);
  });

  it("highlights every word of a multi-word query, in any order", () => {
    expect(highlightSubstring("BetaqqZ AlphaqqZ task", "AlphaqqZ BetaqqZ")).toEqual([
      { text: "BetaqqZ", matched: true },
      { text: " ", matched: false },
      { text: "AlphaqqZ", matched: true },
      { text: " task", matched: false },
    ]);
  });

  it("highlights every occurrence of a repeated word", () => {
    expect(highlightSubstring("recur, then recur again", "recur")).toEqual([
      { text: "recur", matched: true },
      { text: ", then ", matched: false },
      { text: "recur", matched: true },
      { text: " again", matched: false },
    ]);
  });

  it("returns the whole text unmatched when nothing matches", () => {
    expect(highlightSubstring("buy groceries", "dentist")).toEqual([
      { text: "buy groceries", matched: false },
    ]);
  });
});
