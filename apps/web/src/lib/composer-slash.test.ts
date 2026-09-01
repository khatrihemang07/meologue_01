/**
 * Direct unit coverage for the `/` menu's pure logic (issue #165) — same
 * role as composer-picker.test.ts for the `[[` picker: everything here
 * calls `deriveSlashMenu`/`filterSlashItems`/`buildSlashMenuItems` directly
 * against plain strings and indices, no ProseMirror `EditorView` involved
 * (ADR 0044 — jsdom cannot mount one at all).
 */
import { describe, expect, it } from "vitest";
import {
  buildSlashMenuItems,
  deriveSlashMenu,
  filterSlashItems,
  SLASH_MENU_COMMAND_IDS,
} from "./composer-slash";

describe("deriveSlashMenu", () => {
  it("opens for a / typed at the very start of a block", () => {
    expect(deriveSlashMenu("/", 1, null)).toEqual({ start: 1, query: "" });
  });

  it("opens for a / typed immediately after whitespace", () => {
    expect(deriveSlashMenu("buy milk /", 10, null)).toEqual({ start: 10, query: "" });
  });

  it("does not open mid-word — and/or types cleanly", () => {
    // "and/or" — the character before "/" is "d", not whitespace and not
    // the start of the block, so this never opens at any point while
    // typing through it.
    expect(deriveSlashMenu("and/", 4, null)).toBeNull();
    expect(deriveSlashMenu("and/or", 6, null)).toBeNull();
  });

  it("does not open mid-word for w/ or a bare date like 9/1", () => {
    expect(deriveSlashMenu("w/", 2, null)).toBeNull();
    expect(deriveSlashMenu("9/1", 2, null)).toBeNull();
  });

  it("does not open for a / that arrives as part of a larger pasted change", () => {
    expect(deriveSlashMenu("some /text pasted at once", 26, null)).toBeNull();
  });

  it("stays open as the query grows", () => {
    const opened = deriveSlashMenu("/", 1, null);
    const grown = deriveSlashMenu("/che", 4, opened);
    expect(grown).toEqual({ start: 1, query: "che" });
  });

  it("closes when the caret moves before the trigger's start", () => {
    const firstOpen = deriveSlashMenu("/", 1, null);
    const opened = deriveSlashMenu("/che", 4, firstOpen);
    expect(deriveSlashMenu("/che", 0, opened)).toBeNull();
  });

  it("closes when a space is typed into the query", () => {
    const opened = deriveSlashMenu("/", 1, null);
    expect(deriveSlashMenu("/a ", 3, opened)).toBeNull();
  });

  it("closes when a newline is typed into the query", () => {
    const opened = deriveSlashMenu("/", 1, null);
    expect(deriveSlashMenu("/a\n", 3, opened)).toBeNull();
  });

  it("closes when the trigger character itself is deleted", () => {
    const firstOpen = deriveSlashMenu("/", 1, null);
    const opened = deriveSlashMenu("/a", 2, firstOpen);
    // The "/" itself was deleted (e.g. selecting and deleting just that
    // character), leaving "a" with the caret still after it — the same
    // position class as `previous.start`, but the trigger itself is gone.
    expect(deriveSlashMenu("a", 1, opened)).toBeNull();
  });

  it("does not reopen from a stale previous state once the trigger is gone", () => {
    const firstOpen = deriveSlashMenu("/", 1, null);
    const opened = deriveSlashMenu("/che", 4, firstOpen);
    // The whole "/che" span was replaced by something else entirely — the
    // character immediately before the old start is no longer "/".
    expect(deriveSlashMenu("xche", 4, opened)).toBeNull();
  });
});

describe("filterSlashItems", () => {
  const items = [
    { id: "checklist", label: "Checklist" },
    { id: "bulletList", label: "Bullet list" },
    { id: "orderedList", label: "Numbered list" },
    { id: "bold", label: "Bold" },
    { id: "italic", label: "Italic" },
    { id: "code", label: "Code" },
    { id: "reference", label: "Reference" },
  ];

  it("returns every item, unchanged, for an empty query", () => {
    expect(filterSlashItems(items, "")).toEqual(items);
  });

  it("matches an unanchored substring, not just a prefix", () => {
    // "list" is in the MIDDLE of "Checklist" and "Numbered list" — neither
    // starts with it, so this proves the match is not anchored to the
    // start of the label.
    expect(filterSlashItems(items, "list").map((item) => item.id)).toEqual([
      "checklist",
      "bulletList",
      "orderedList",
    ]);
  });

  it("is case-insensitive", () => {
    expect(filterSlashItems(items, "CHE").map((item) => item.id)).toEqual(["checklist"]);
  });

  it("is accent-insensitive", () => {
    // "é" typed by habit or autocorrect still finds "Reference" — no "e"
    // in "Reference" carries an accent, but the reader's own typo does.
    expect(filterSlashItems(items, "réf").map((item) => item.id)).toEqual(["reference"]);
  });

  it("is a substring match, not a fuzzy one — /che finds Checklist and /chk does not", () => {
    expect(filterSlashItems(items, "che").map((item) => item.id)).toEqual(["checklist"]);
    expect(filterSlashItems(items, "chk")).toEqual([]);
  });

  it("returns no matches for a query nothing contains", () => {
    expect(filterSlashItems(items, "zzz")).toEqual([]);
  });
});

describe("buildSlashMenuItems", () => {
  const registry = [
    { id: "bold", label: "Bold" },
    { id: "italic", label: "Italic" },
    { id: "code", label: "Code" },
    { id: "bulletList", label: "Bullet list" },
    { id: "orderedList", label: "Numbered list" },
    { id: "checklist", label: "Checklist" },
    { id: "indent", label: "Indent" },
    { id: "outdent", label: "Outdent" },
    { id: "reference", label: "Reference" },
    { id: "undo", label: "Undo" },
    { id: "redo", label: "Redo" },
  ];

  it("reorders the registry into the ticket's own seven-item order, dropping the rest", () => {
    expect(buildSlashMenuItems(registry).map((item) => item.id)).toEqual(SLASH_MENU_COMMAND_IDS);
  });

  it("throws rather than silently drop an item when the registry is missing one", () => {
    const incomplete = registry.filter((item) => item.id !== "checklist");
    expect(() => buildSlashMenuItems(incomplete)).toThrow(/checklist/);
  });
});
