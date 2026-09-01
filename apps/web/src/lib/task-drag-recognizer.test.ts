import { describe, expect, it } from "vitest";
import { dropIndexForPointer, type RowRect } from "./task-drag-recognizer";

/**
 * Three evenly-spaced rows, 40px tall each, exactly the shape
 * `task-tree.tsx` reads off `getBoundingClientRect()` — pinned here at
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
  // Every test in this block passes `canNest: false` deliberately, not by
  // omission — `canNest` has no default (this function's own doc comment
  // on why) — to pin down that a sibling group with nesting unavailable
  // (a group already at MAX_TASK_NESTING_DEPTH) keeps *exactly* the
  // pre-#171 50/50 reorder behaviour, not a diminished version of it.
  describe("with nesting unavailable (canNest: false)", () => {
    it("names index 0 for a pointer above the first row", () => {
      const verdict = dropIndexForPointer(THREE_ROWS, -50, 2, false);
      expect(verdict).toEqual({ kind: "moved", dropIndex: 0 });
    });

    it("names the row it's over once it's confirmed past that row's own midpoint", () => {
      // y=45 sits in the second row's top half (midpoint 60) — before it,
      // which reads as "between the first and second rows."
      const verdict = dropIndexForPointer(THREE_ROWS, 45, 0, false);
      expect(verdict).toEqual({ kind: "moved", dropIndex: 1 });
    });

    it("names the last row's own index while the pointer is in its top half", () => {
      // y=85 sits in the third row's top half (midpoint 100) — before it,
      // not past it.
      const verdict = dropIndexForPointer(THREE_ROWS, 85, 0, false);
      expect(verdict).toEqual({ kind: "moved", dropIndex: 2 });
    });

    it("names the trailing append zone once the pointer clears every row's midpoint", () => {
      const verdict = dropIndexForPointer(THREE_ROWS, 500, 0, false);
      expect(verdict).toEqual({ kind: "moved", dropIndex: THREE_ROWS.length });
    });

    it("is unchanged when the pointer resolves back to the dragged Task's own original index", () => {
      // The dragged Task was at index 1 in the full list; releasing over
      // the second row here (y=45, dropIndex 1) reconstructs exactly that
      // spot.
      const verdict = dropIndexForPointer(THREE_ROWS, 45, 1, false);
      expect(verdict).toEqual({ kind: "unchanged" });
    });

    it("is unchanged for a Task with no siblings, wherever the pointer lands", () => {
      // Nothing to measure against and nowhere else to go — dropIndex is
      // always 0 (rows.length), which is also its only possible original
      // index.
      expect(dropIndexForPointer([], 9999, 0, false)).toEqual({ kind: "unchanged" });
    });

    // The would-be nest band (rows[1]'s middle half, y=50..70) must still
    // resolve to an ordinary reorder position when nesting is off — this
    // is the one case that actually distinguishes `canNest: false` from
    // `canNest: true` rather than merely repeating the tests above at a
    // different y, so it earns its own case.
    it("resolves a pointer in the would-be nest band to an ordinary reorder position", () => {
      const verdict = dropIndexForPointer(THREE_ROWS, 55, 0, false);
      expect(verdict).toEqual({ kind: "moved", dropIndex: 1 });
    });
  });

  // Issue #171's own drag-to-reparent gap, closed: a pointer in a row's own
  // middle band nests under that row instead of reordering around it.
  // `THREE_ROWS`' 40px-tall rows quarter/half/quarter (this module's own
  // `REORDER_EDGE_FRACTION`) into a 10px top edge, a 20px middle band, and
  // a 10px bottom edge per row.
  describe("with nesting available (canNest: true)", () => {
    it("still reorders for a pointer in a row's own top edge band", () => {
      // y=5 is within row 0's top 10px (0..10) — "insert before row 0,"
      // identical to the pre-#171 behaviour at this same coordinate.
      const verdict = dropIndexForPointer(THREE_ROWS, 5, 2, true);
      expect(verdict).toEqual({ kind: "moved", dropIndex: 0 });
    });

    it("is nest, not moved, at the exact boundary where the top edge band ends", () => {
      // y=10 is row 0's own top-edge/nest boundary (top 0 + 40*0.25) —
      // the band is a half-open interval on the edge side ([top, top+edge)
      // is "before"), so the boundary itself already reads as the middle.
      const verdict = dropIndexForPointer(THREE_ROWS, 10, 2, true);
      expect(verdict).toEqual({ kind: "nest", index: 0 });
    });

    it("nests under the row whose middle band the pointer is over", () => {
      // y=20 is row 0's exact midpoint, deep inside its 10..30 middle band.
      const verdict = dropIndexForPointer(THREE_ROWS, 20, 2, true);
      expect(verdict).toEqual({ kind: "nest", index: 0 });
    });

    it("is nest, not moved, at the exact boundary where the middle band ends", () => {
      // y=29.999 is the last instant still inside row 0's middle band
      // (which runs [10, 30)) before the bottom edge band takes over.
      const verdict = dropIndexForPointer(THREE_ROWS, 29.999, 2, true);
      expect(verdict).toEqual({ kind: "nest", index: 0 });
    });

    it("falls through a row's own bottom edge band to resolve as 'before the next row'", () => {
      // y=35 is inside row 0's own bottom edge band ([30, 40), physically
      // still over row 0) — no longer "nest under row 0," but not resolved
      // to "after row 0" *here* either, for the same reason the `!canNest`
      // branch never resolves a bottom half on the spot (this file's own
      // header comment): "after row 0" and "before row 1" are the same
      // boundary. Falling through to row 1's own check is what resolves
      // it — row 1's top edge band is [40, 50), and 35 is below that
      // threshold too, so row 1's *first* condition (`pointerY <
      // row.top + edge`) already claims it as "insert before row 1,"
      // without row 1 needing to be the row physically under the pointer.
      const verdict = dropIndexForPointer(THREE_ROWS, 35, 2, true);
      expect(verdict).toEqual({ kind: "moved", dropIndex: 1 });
    });

    it("clears every row's bands to reach the trailing append zone", () => {
      // y=115 is inside row 2's own bottom edge band ([110, 120)) — the
      // last row there is, so nothing is left to fall through to but the
      // trailing zone `dropIndex` defaults to.
      const verdict = dropIndexForPointer(THREE_ROWS, 115, 2, true);
      expect(verdict).toEqual({ kind: "moved", dropIndex: THREE_ROWS.length });
    });

    it("resolves the boundary between two rows' edge bands to inserting between them", () => {
      // y=40 is simultaneously row 0's bottom edge and row 1's top edge —
      // row 1's own top-edge band [40, 50) claims it, reading as "insert
      // before row 1," exactly the boundary-sharing this file's own header
      // comment names.
      const verdict = dropIndexForPointer(THREE_ROWS, 40, 2, true);
      expect(verdict).toEqual({ kind: "moved", dropIndex: 1 });
    });

    it("nests under the last row for a pointer in its own middle band", () => {
      // y=100 is row 2's exact midpoint (90..110 is its middle band).
      const verdict = dropIndexForPointer(THREE_ROWS, 100, 0, true);
      expect(verdict).toEqual({ kind: "nest", index: 2 });
    });

    it("is never unchanged for a nest verdict, even over the dragged Task's own original row", () => {
      // originalIndex=0 names "row 0's own slot" in the pre-#171 sense,
      // but `rows` never contains the dragged Task itself (this file's own
      // `rows` doc comment) — nesting under row 0 here is always a real
      // reparent onto a *different* Task, so `originalIndex` never turns a
      // `"nest"` verdict into `"unchanged"` the way it can a `"moved"` one.
      const verdict = dropIndexForPointer(THREE_ROWS, 20, 0, true);
      expect(verdict).toEqual({ kind: "nest", index: 0 });
    });

    it("is unchanged when a reorder-band pointer resolves back to the dragged Task's own index", () => {
      const verdict = dropIndexForPointer(THREE_ROWS, 5, 0, true);
      expect(verdict).toEqual({ kind: "unchanged" });
    });
  });
});
