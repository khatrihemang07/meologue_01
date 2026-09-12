import { describe, expect, it } from "vitest";
import { priorityColour, priorityPickerColour } from "./task-priority-colors";

// Both functions here return `var(--td-*)` references, not literal `rgb()`
// strings — index.css's `[data-surface="todo"]` scope (issue #223) is what
// resolves them, and only inside that scope. Asserting the exact token name
// (not merely "is a string") is what catches a future edit renaming a token
// in one file without the other, the same failure mode the pre-#223 tests
// caught for a literal value drifting.
describe("priorityColour (the row/checkbox ring)", () => {
  it("p1 reads the measured row-ring token, --td-priority-row-1", () => {
    expect(priorityColour(1)).toBe("var(--td-priority-row-1)");
  });

  it("p2 and p3 read the row tokens (PRI-06: now measured directly, index.css no longer falls them back to the picker swatch)", () => {
    expect(priorityColour(2)).toBe("var(--td-priority-row-2)");
    expect(priorityColour(3)).toBe("var(--td-priority-row-3)");
  });

  it("p4 (and, by extension, 'no priority') reads the shared checkbox-ring default", () => {
    expect(priorityColour(4)).toBe("var(--td-checkbox-ring-default)");
  });

  it("falls back to p4's token for an out-of-range input", () => {
    expect(priorityColour(0)).toBe(priorityColour(4));
    expect(priorityColour(5)).toBe(priorityColour(4));
  });
});

describe("priorityPickerColour (the priority picker's own swatches)", () => {
  it("reads the four measured picker-swatch tokens (PRI-01)", () => {
    expect(priorityPickerColour(1)).toBe("var(--td-priority-picker-1)");
    expect(priorityPickerColour(2)).toBe("var(--td-priority-picker-2)");
    expect(priorityPickerColour(3)).toBe("var(--td-priority-picker-3)");
    expect(priorityPickerColour(4)).toBe("var(--td-priority-picker-4)");
  });

  it("falls back to p4's swatch for an out-of-range input", () => {
    expect(priorityPickerColour(0)).toBe(priorityPickerColour(4));
    expect(priorityPickerColour(5)).toBe(priorityPickerColour(4));
  });
});

// PRI-05's whole point, asserted directly rather than only implied by the
// two describe blocks above reading different token names: each of P1-P3's
// row ring and picker swatch are genuinely different values in a real
// Todoist, and this module must never collapse them into one shared token.
// PRI-06 is what extended that rule from "true at P1" to "true at every
// non-default level" — asserted here for P2 and P3 too, not only P1.
it("keeps each of P1-P3's row ring and picker swatch on two different tokens (PRI-05/PRI-06)", () => {
  expect(priorityColour(1)).not.toBe(priorityPickerColour(1));
  expect(priorityColour(2)).not.toBe(priorityPickerColour(2));
  expect(priorityColour(3)).not.toBe(priorityPickerColour(3));
});
