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
  it("is the sigil, the canonical name, and one trailing space (quick-add.md's own recorded example)", () => {
    expect(insertionTextFor("#", "Inbox")).toBe("#Inbox ");
    expect(insertionTextFor("@", "urgent")).toBe("@urgent ");
  });
});
