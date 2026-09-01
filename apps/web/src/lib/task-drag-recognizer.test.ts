import { describe, expect, it } from "vitest";
import { dropIndexForPointer, type RowRect } from "./task-drag-recognizer";

/**
 * Three evenly-spaced rows, 40px tall each, exactly the shape
 * `todo-page.tsx` reads off `getBoundingClientRect()` — pinned here at
 * exact coordinates the way `swipe-recognizer.test.ts` pins the horizontal
 * swipe's physics, for the same reason: a synthesised pointer sequence in
 * jsdom can assert "the call happened" but not "at this exact geometry."
 */
const THREE_ROWS: RowRect[] = [
  { top: 0, bottom: 40 },
  { top: 40, bottom: 80 },
  { top: 80, bottom: 120 },
];

describe("dropIndexForPointer", () => {
  it("names index 0 for a pointer above the first row", () => {
    const verdict = dropIndexForPointer(THREE_ROWS, -50, 2);
    expect(verdict).toEqual({ kind: "moved", dropIndex: 0 });
  });

  it("names the row it's over once it's confirmed past that row's own midpoint", () => {
    // y=45 sits in the second row's top half (midpoint 60) — before it,
    // which reads as "between the first and second rows."
    const verdict = dropIndexForPointer(THREE_ROWS, 45, 0);
    expect(verdict).toEqual({ kind: "moved", dropIndex: 1 });
  });

  it("names the last row's own index while the pointer is in its top half", () => {
    // y=85 sits in the third row's top half (midpoint 100) — before it,
    // not past it.
    const verdict = dropIndexForPointer(THREE_ROWS, 85, 0);
    expect(verdict).toEqual({ kind: "moved", dropIndex: 2 });
  });

  it("names the trailing append zone once the pointer clears every row's midpoint", () => {
    const verdict = dropIndexForPointer(THREE_ROWS, 500, 0);
    expect(verdict).toEqual({ kind: "moved", dropIndex: THREE_ROWS.length });
  });

  it("is unchanged when the pointer resolves back to the dragged Task's own original index", () => {
    // The dragged Task was at index 1 in the full list; releasing over the
    // second row here (y=45, dropIndex 1) reconstructs exactly that spot.
    const verdict = dropIndexForPointer(THREE_ROWS, 45, 1);
    expect(verdict).toEqual({ kind: "unchanged" });
  });

  it("is unchanged for a Task with no siblings, wherever the pointer lands", () => {
    // Nothing to measure against and nowhere else to go — dropIndex is
    // always 0 (rows.length), which is also its only possible original
    // index.
    expect(dropIndexForPointer([], 9999, 0)).toEqual({ kind: "unchanged" });
  });
});
