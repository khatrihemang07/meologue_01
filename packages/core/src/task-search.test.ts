import { describe, expect, it } from "vitest";
import {
  isTrigramSafe,
  MIN_TRIGRAM_WORD_LENGTH,
  matchesSubstring,
  matchesWholeWord,
  normalize,
  toTrigramMatchQuery,
} from "./task-search";

describe("normalize", () => {
  it("case-folds and strips diacritics", () => {
    expect(normalize("Café")).toBe("cafe");
    expect(normalize("RÉSUMÉ")).toBe("resume");
  });
});

describe("matchesSubstring", () => {
  it("matches a fragment from the middle of a word", () => {
    expect(matchesSubstring("Buildzzzing", "uildz")).toBe(true);
  });

  it("ignores case and diacritics", () => {
    expect(matchesSubstring("café", "CAFE")).toBe(true);
  });

  it("requires every word, in any order", () => {
    expect(matchesSubstring("BetaqqZ AlphaqqZ task", "AlphaqqZ BetaqqZ")).toBe(true);
    expect(matchesSubstring("AlphaqqZ only", "AlphaqqZ BetaqqZ")).toBe(false);
  });

  it("never strips punctuation", () => {
    expect(matchesSubstring("Test-Punct!", "TestPunct")).toBe(false);
    expect(matchesSubstring("Test-Punct! 🎉 Task", "punct task")).toBe(true);
  });

  it("treats a literal quote as an ordinary character, not a phrase operator", () => {
    expect(matchesSubstring("a b", '"a b"')).toBe(false);
    expect(matchesSubstring('a "b" c', '"b"')).toBe(true);
  });

  it("returns false for an empty query or a missing field", () => {
    expect(matchesSubstring("anything", "")).toBe(false);
    expect(matchesSubstring("anything", "   ")).toBe(false);
    expect(matchesSubstring(null, "anything")).toBe(false);
    expect(matchesSubstring(undefined, "anything")).toBe(false);
  });

  it("matches emoji as ordinary searchable characters", () => {
    expect(matchesSubstring("done 🎉 party", "🎉")).toBe(true);
  });
});

describe("matchesWholeWord", () => {
  it("matches only a whole word, not a fragment", () => {
    expect(matchesWholeWord("uniqzetaword", "zetaword")).toBe(false);
    expect(matchesWholeWord("uniqzetaword", "uniqzetaword")).toBe(true);
  });

  it("ignores case and diacritics, still whole-word", () => {
    expect(matchesWholeWord("Café", "cafe")).toBe(true);
    expect(matchesWholeWord("Café", "af")).toBe(false);
  });
});

describe("isTrigramSafe / MIN_TRIGRAM_WORD_LENGTH", () => {
  it("is false for a query with any word shorter than the trigram floor", () => {
    expect(isTrigramSafe("a")).toBe(false);
    expect(isTrigramSafe("ab")).toBe(false);
    expect(isTrigramSafe("abc")).toBe(true);
    expect(isTrigramSafe("abc a")).toBe(false);
    expect(MIN_TRIGRAM_WORD_LENGTH).toBe(3);
  });

  it("counts emoji as one character, not two UTF-16 units", () => {
    // A single-codepoint-outside-the-BMP emoji is two UTF-16 code units
    // but one `Array.from` element — this must still count as "too short".
    expect(isTrigramSafe("🎉")).toBe(false);
  });

  it("is false for an empty or whitespace-only query", () => {
    expect(isTrigramSafe("")).toBe(false);
    expect(isTrigramSafe("   ")).toBe(false);
  });
});

describe("toTrigramMatchQuery", () => {
  it("ANDs every word as its own literal, quoted phrase", () => {
    expect(toTrigramMatchQuery("alpha beta")).toBe('"alpha" AND "beta"');
  });

  it("doubles a literal quote inside a word, mirroring FTS5's own escape", () => {
    expect(toTrigramMatchQuery('he"llo')).toBe('"he""llo"');
  });
});
