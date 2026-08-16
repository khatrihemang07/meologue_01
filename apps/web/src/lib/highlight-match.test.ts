import { describe, expect, it } from "vitest";
import { highlightMatches } from "./highlight-match";

describe("highlightMatches", () => {
  it("returns the whole body unmatched when the query is empty", () => {
    expect(highlightMatches("a recurring task", "")).toEqual([
      { text: "a recurring task", matched: false },
    ]);
  });

  it("returns the whole body unmatched when the query is whitespace-only", () => {
    expect(highlightMatches("a recurring task", "   ")).toEqual([
      { text: "a recurring task", matched: false },
    ]);
  });

  it("highlights a word matching the query as a prefix", () => {
    expect(highlightMatches("a recurring task", "recur")).toEqual([
      { text: "a ", matched: false },
      { text: "recurring", matched: true },
      { text: " task", matched: false },
    ]);
  });

  it("is case-insensitive", () => {
    expect(highlightMatches("a Recurring task", "RECUR")).toEqual([
      { text: "a ", matched: false },
      { text: "Recurring", matched: true },
      { text: " task", matched: false },
    ]);
  });

  it("does not highlight a word that merely contains the query, not as a prefix", () => {
    expect(highlightMatches("a recurring task", "urring")).toEqual([
      { text: "a recurring task", matched: false },
    ]);
  });

  it("highlights every occurrence", () => {
    expect(highlightMatches("recur, then recur again", "recur")).toEqual([
      { text: "recur", matched: true },
      { text: ", then ", matched: false },
      { text: "recur", matched: true },
      { text: " again", matched: false },
    ]);
  });

  it("highlights a multi-word query as an adjacent phrase, prefix on the last word", () => {
    expect(highlightMatches("a recurring theme in art", "recurring th")).toEqual([
      { text: "a ", matched: false },
      { text: "recurring theme", matched: true },
      { text: " in art", matched: false },
    ]);
  });

  it("does not match multi-word query words that are not adjacent in the body", () => {
    expect(highlightMatches("a recurring, odd theme", "recurring theme")).toEqual([
      { text: "a recurring, odd theme", matched: false },
    ]);
  });

  it("treats special characters as ordinary token boundaries, never as query syntax", () => {
    expect(() => highlightMatches("call me at a*b", "a*b")).not.toThrow();
    expect(highlightMatches("call me at a*b", "a*b")).toEqual([
      { text: "call me at ", matched: false },
      { text: "a*b", matched: true },
    ]);
  });
});
