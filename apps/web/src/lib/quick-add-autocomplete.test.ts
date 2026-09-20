import { describe, expect, it } from "vitest";
import {
  type AutocompleteEntry,
  computeOptionRows,
  filterEntries,
  findTrigger,
  insertionTextFor,
} from "./quick-add-autocomplete";

const PROJECTS: AutocompleteEntry[] = [
  { id: "1", name: "Inbox" },
  { id: "2", name: "Work" },
  { id: "3", name: "q1-goals" },
];

describe("findTrigger", () => {
  it("finds a bare '#' right at the caret, with an empty query", () => {
    expect(findTrigger("#", 1)).toEqual({ sigil: "#", from: 0, query: "" });
  });

  it("finds a bare '@' right at the caret, with an empty query", () => {
    expect(findTrigger("@", 1)).toEqual({ sigil: "@", from: 0, query: "" });
  });

  it("carries the typed query after the sigil", () => {
    expect(findTrigger("#wo", 3)).toEqual({ sigil: "#", from: 0, query: "wo" });
  });

  it("requires the sigil to start a word — preceded by whitespace", () => {
    expect(findTrigger("buy milk #wo", 12)).toEqual({ sigil: "#", from: 9, query: "wo" });
  });

  it("does not trigger on a '#' embedded mid-word, with no preceding whitespace", () => {
    expect(findTrigger("foo#bar", 7)).toBeNull();
  });

  it("returns null once the caret has moved past the trigger run (a space was typed)", () => {
    expect(findTrigger("#work ", 6)).toBeNull();
  });

  it("returns null with no sigil in the run at all", () => {
    expect(findTrigger("hello", 5)).toBeNull();
  });

  it("returns null for a sigil with nothing typed before it and no query — caret sitting before the sigil", () => {
    expect(findTrigger("#work", 0)).toBeNull();
  });

  it("allows letters, digits, underscore and hyphen in the query — matchProject's own name pattern", () => {
    expect(findTrigger("#q1-goals", 9)).toEqual({ sigil: "#", from: 0, query: "q1-goals" });
  });

  // Issue #388: crossing exactly one interior space keeps the trigger
  // alive across a real two-word name, so the popup can keep
  // incrementally filtering past the first word instead of closing the
  // instant the space is typed.
  describe("multi-word query (issue #388)", () => {
    it("keeps the trigger alive across one interior space, carrying both words as the query", () => {
      expect(findTrigger("#Aurora migration", 17)).toEqual({
        sigil: "#",
        from: 0,
        query: "Aurora migration",
      });
    });

    it("still closes once a completed multi-word entry is followed by its own trailing space", () => {
      expect(findTrigger("#Aurora migration ", 18)).toBeNull();
    });

    it("does not cross a double space — that ends a word normally, not the middle of a name", () => {
      expect(findTrigger("#Aurora  migration", 18)).toBeNull();
    });

    it("caps at one crossed space, not an unbounded scan back to the previous sigil", () => {
      // A known, accepted imprecision (this function's own doc comment):
      // capping at one crossing still swallows an unrelated NEXT word
      // once a name is already complete, rather than knowing the name
      // was already exactly two words long — but it never reaches all
      // the way back past a second space to an earlier, unrelated run.
      expect(findTrigger("Buy milk #Home tomorrow", 23)).toEqual({
        sigil: "#",
        from: 9,
        query: "Home tomorrow",
      });
    });

    it("does not cross a space with nothing consumed yet — the plain trailing-space case stays null", () => {
      expect(findTrigger("#work ", 6)).toBeNull();
    });
  });

  // Issue #388's remaining half — `/` (Section) joins `#`/`@` as a
  // recognised trigger sigil.
  describe("'/' (Section, issue #388)", () => {
    it("finds a bare '/' right at the caret, with an empty query", () => {
      expect(findTrigger("/", 1)).toEqual({ sigil: "/", from: 0, query: "" });
    });

    it("carries the typed query after the sigil, requires whitespace/start before it, and allows a multi-word query exactly like '#'/'@'", () => {
      expect(findTrigger("Due /Cut", 8)).toEqual({ sigil: "/", from: 4, query: "Cut" });
      expect(findTrigger("foo/bar", 7)).toBeNull();
      expect(findTrigger("/Before cutover", 15)).toEqual({
        sigil: "/",
        from: 0,
        query: "Before cutover",
      });
    });

    // `matchSection`/`matchAgainstKnownNames`'s own digit-lookahead guard
    // (`packages/core/src/quick-add/rules.ts`) — keeps the `/` inside a
    // numeric date like `27/1/2026` from ever opening this popup. `#`/`@`
    // have no equivalent: `#2026` is a real, recognisable Project name.
    it("does not trigger once the character right after '/' is a digit", () => {
      expect(findTrigger("Due /27", 7)).toBeNull();
    });

    it("still triggers on a '/' followed by a non-digit, even right after the digit guard's own boundary", () => {
      expect(findTrigger("Due /C27", 8)).toEqual({ sigil: "/", from: 4, query: "C27" });
    });
  });
});

describe("filterEntries", () => {
  it("returns every entry, unfiltered, for an empty query", () => {
    expect(filterEntries(PROJECTS, "")).toEqual(PROJECTS);
  });

  it("filters case-insensitively by substring", () => {
    expect(filterEntries(PROJECTS, "WO")).toEqual([{ id: "2", name: "Work" }]);
  });

  it("returns nothing for a query matching no entry", () => {
    expect(filterEntries(PROJECTS, "zzznope")).toEqual([]);
  });
});

describe("computeOptionRows", () => {
  it("lists everything, unfiltered, for an empty query — even an empty list (Todoist's own empty-listbox case)", () => {
    expect(computeOptionRows(PROJECTS, "")).toEqual(
      PROJECTS.map((entry) => ({ kind: "entry", entry })),
    );
    expect(computeOptionRows([], "")).toEqual([]);
  });

  it("falls back to one 'create' row once a real query matches nothing", () => {
    expect(computeOptionRows(PROJECTS, "zzznope")).toEqual([{ kind: "create", query: "zzznope" }]);
  });

  it("lists only the filtered matches when the query matches something — no 'create' row alongside real matches", () => {
    expect(computeOptionRows(PROJECTS, "wo")).toEqual([
      { kind: "entry", entry: { id: "2", name: "Work" } },
    ]);
  });
});

describe("insertionTextFor", () => {
  it("is the sigil, the canonical name, and one trailing space", () => {
    expect(insertionTextFor("#", "Inbox")).toBe("#Inbox ");
    expect(insertionTextFor("@", "urgent")).toBe("@urgent ");
  });
});
