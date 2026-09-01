/**
 * Direct unit coverage for the inline `[[` picker's pure logic (issue #144),
 * now that composer.test.tsx can no longer drive it through a rendered
 * `<textarea>` (see composer-picker.ts's own module comment, and
 * composer.tsx's for why ProseMirror interaction moved to Playwright
 * entirely). Every case here mirrors one that used to be a
 * `fireEvent.change` sequence in composer.test.tsx, translated into a
 * direct call against `derivePicker`/`buildDateSuggestions` — same
 * behaviour, no DOM required.
 */
import type { Entry } from "@meologue/core";
import { describe, expect, it } from "vitest";
import {
  buildDateSuggestions,
  derivePicker,
  isDateModeQuery,
  pickerItemMark,
} from "./composer-picker";

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: "1",
    deviceId: "device-a",
    body: "original body",
    createdAt: "now",
    seq: 1,
    syncedAt: "now",
    deletedAt: null,
    ...overrides,
  };
}

describe("derivePicker", () => {
  it("opens after a freshly typed [[", () => {
    expect(derivePicker("[[", 2, null)).toEqual({ start: 2, query: "" });
  });

  it("does not open for a [[ that arrives as part of a larger pasted change", () => {
    // The caret sits at the end of a longer string whose last two
    // characters are not literally "[[" — a paste, not a keystroke.
    expect(derivePicker("some [[text pasted at once", 27, null)).toBeNull();
  });

  it("does not open when the caret is not immediately after the trigger", () => {
    // The caret sits at the end of "[[abc" — the two characters right
    // before it ("b", "c") are not the trigger, even though "[[" opened
    // this same string five characters earlier.
    expect(derivePicker("[[abc", 5, null)).toBeNull();
  });

  it("stays open as the query grows", () => {
    const opened = derivePicker("[[", 2, null);
    const grown = derivePicker("[[2026", 6, opened);
    expect(grown).toEqual({ start: 2, query: "2026" });
  });

  it("closes when the caret moves before the trigger's start", () => {
    const opened = derivePicker("[[2026", 6, null);
    expect(derivePicker("[[2026", 1, opened)).toBeNull();
  });

  it("closes when a ] is typed into the query", () => {
    const opened = derivePicker("[[", 2, null);
    expect(derivePicker("[[]", 3, opened)).toBeNull();
  });

  it("closes when a newline is typed into the query", () => {
    const opened = derivePicker("[[", 2, null);
    expect(derivePicker("[[\n", 3, opened)).toBeNull();
  });

  it("closes when backspacing consumes one of the trigger's brackets", () => {
    const opened = derivePicker("[[a", 3, null);
    // The reader backspaced through everything back to a single "[".
    expect(derivePicker("[", 1, opened)).toBeNull();
  });
});

describe("isDateModeQuery", () => {
  it("is true for digits and dashes, including empty", () => {
    expect(isDateModeQuery("")).toBe(true);
    expect(isDateModeQuery("2026-08-15")).toBe(true);
    expect(isDateModeQuery("2026")).toBe(true);
  });

  it("is false the moment a letter or space appears", () => {
    expect(isDateModeQuery("groceries")).toBe(false);
    expect(isDateModeQuery("2026 ")).toBe(false);
  });
});

describe("buildDateSuggestions", () => {
  it("offers every recent day when the query is empty", () => {
    const entries = [
      entry({ id: "a", createdAt: "2026-08-15T12:00:00.000Z" }),
      entry({ id: "b", createdAt: "2026-08-16T12:00:00.000Z" }),
    ];
    expect(buildDateSuggestions("", entries, 0)).toEqual(["2026-08-15", "2026-08-16"]);
  });

  it("accepts a fully typed valid calendar date even when it is not among recent days", () => {
    expect(buildDateSuggestions("2026-08-15", [], 0)).toEqual(["2026-08-15"]);
  });

  it("does not offer an invalid calendar date", () => {
    expect(buildDateSuggestions("2026-13-45", [], 0)).toEqual([]);
  });

  it("de-duplicates the typed date against a matching recent day", () => {
    const entries = [entry({ id: "a", createdAt: "2026-08-15T12:00:00.000Z" })];
    expect(buildDateSuggestions("2026-08-15", entries, 0)).toEqual(["2026-08-15"]);
  });

  it("narrows recent days to ones containing the typed digits", () => {
    const entries = [
      entry({ id: "a", createdAt: "2026-08-15T12:00:00.000Z" }),
      entry({ id: "b", createdAt: "2026-09-01T12:00:00.000Z" }),
    ];
    expect(buildDateSuggestions("08", entries, 0)).toEqual(["2026-08-15"]);
  });

  it("caps at MAX_DATE_SUGGESTIONS", () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry({ id: `e${i}`, createdAt: `2026-08-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` }),
    );
    expect(buildDateSuggestions("", entries, 0)).toHaveLength(5);
  });
});

describe("pickerItemMark", () => {
  it("builds a date mark", () => {
    expect(pickerItemMark({ kind: "date", date: "2026-08-15" })).toBe("[[2026-08-15]]");
  });

  it("builds an Entry mark, never showing the raw id as anything but the mark itself", () => {
    expect(pickerItemMark({ kind: "entry", entry: entry({ id: "target-entry-id" }) })).toBe(
      "[[e:target-entry-id]]",
    );
  });
});
