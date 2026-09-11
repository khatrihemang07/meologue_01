import type { QuickAddSpan } from "@meologue/core";
import { describe, expect, it } from "vitest";
import {
  computeQuickAddMatches,
  matchIdForToken,
  remapWithdrawnSpans,
} from "./todo-quick-add-recognition";

// "today" = 10 Sep 2026 (Thursday) — matching
// docs/reference/todoist/quick-add.md's own captured reference instant.
const NOW = "2026-09-10";

describe("remapWithdrawnSpans", () => {
  it("returns the same spans, unchanged, when the text hasn't changed", () => {
    const spans: QuickAddSpan[] = [{ start: 0, end: 3 }];
    expect(remapWithdrawnSpans("tod", "tod", spans)).toEqual(spans);
  });

  it("drops a span whose own text was edited — the second Backspace after withdrawal", () => {
    // tod-05-bksp2.json: "tod" -> "to".
    const spans: QuickAddSpan[] = [{ start: 0, end: 3 }];
    expect(remapWithdrawnSpans("tod", "to", spans)).toEqual([]);
  });

  it("drops a span when a character is typed immediately after it", () => {
    // retype-03-todx.json: "tod" -> "todx", typed right after the
    // withdrawn span's own end — this module's own header comment on why
    // a boundary-touching edit counts as touching, not merely an edit to
    // the span's own interior characters.
    const spans: QuickAddSpan[] = [{ start: 0, end: 3 }];
    expect(remapWithdrawnSpans("tod", "todx", spans)).toEqual([]);
  });

  it("stays dropped across the round trip back to the identical text", () => {
    // retype-04-back-to-tod-after-x.json: "todx" -> "tod" (Backspace on
    // the trailing x). Once dropped by the previous edit there is nothing
    // left to remap — the natural parse alone decides the render, and it
    // is fully re-recognised (see the computeQuickAddMatches test below).
    expect(remapWithdrawnSpans("todx", "tod", [])).toEqual([]);
  });

  it("shifts a span forward when new text is inserted well before it, with a real gap", () => {
    const spans: QuickAddSpan[] = [{ start: 6, end: 9 }];
    // "hello tod" -> "XXhello tod" — two characters inserted at the very
    // front; "tod" itself (indices 6-9) sits well clear of the edit.
    expect(remapWithdrawnSpans("hello tod", "XXhello tod", spans)).toEqual([{ start: 8, end: 11 }]);
  });

  it("shifts a span backward when text is removed well before it", () => {
    const spans: QuickAddSpan[] = [{ start: 8, end: 11 }];
    expect(remapWithdrawnSpans("XXhello tod", "hello tod", spans)).toEqual([{ start: 6, end: 9 }]);
  });

  it("drops one of several spans while leaving an untouched one shifted", () => {
    const spans: QuickAddSpan[] = [
      { start: 0, end: 3 }, // "tod" — about to be edited
      { start: 8, end: 11 }, // a second, untouched occurrence further on
    ];
    // Insert "!" right after the first "tod" (index 3) — touches the
    // first span; the second, twelve characters later, only shifts.
    expect(remapWithdrawnSpans("tod aaa tod", "tod! aaa tod", spans)).toEqual([
      { start: 9, end: 12 },
    ]);
  });

  it("leaves an empty span list empty", () => {
    expect(remapWithdrawnSpans("tod", "todx", [])).toEqual([]);
  });
});

describe("matchIdForToken", () => {
  it("carries the resolved date, not the typed text", () => {
    expect(
      matchIdForToken({ kind: "date", start: 0, end: 3, raw: "tod", date: "2026-09-10" }),
    ).toBe("2026-09-10");
  });

  it("renders a priority as P<n>, crossing the stored/ui inversion — typed p1 stores 4, renders P1", () => {
    expect(matchIdForToken({ kind: "priority", start: 0, end: 2, raw: "p1", priority: 4 })).toBe(
      "P1",
    );
  });

  it("renders the degenerate p4 the same way — typed p4 stores 1, renders P4", () => {
    expect(matchIdForToken({ kind: "priority", start: 0, end: 2, raw: "p4", priority: 1 })).toBe(
      "P4",
    );
  });

  it("carries a label's resolved name", () => {
    expect(
      matchIdForToken({ kind: "label", start: 0, end: 8, raw: "@Family", name: "Family" }),
    ).toBe("Family");
  });
});

describe("computeQuickAddMatches", () => {
  it("recognises 'tod' as a fresh, non-withdrawn match", () => {
    const matches = computeQuickAddMatches("tod", { now: NOW }, []);

    expect(matches).toEqual([
      { start: 0, end: 3, kind: "date", matchId: "2026-09-10", withdrawn: false },
    ]);
  });

  it("marks a match withdrawn once its exact span is in the withdrawn list", () => {
    const matches = computeQuickAddMatches("tod", { now: NOW }, [{ start: 0, end: 3 }]);

    expect(matches).toEqual([
      { start: 0, end: 3, kind: "date", matchId: "2026-09-10", withdrawn: true },
    ]);
  });

  it("shows no match at all for 'todx' — not a recognisable phrase", () => {
    expect(computeQuickAddMatches("todx", { now: NOW }, [{ start: 0, end: 3 }])).toEqual([]);
  });

  it("re-recognises fully, not withdrawn, once the withdrawn record has been dropped by an edit", () => {
    // The end-to-end shape of retype-03/retype-04: withdraw "tod", type
    // "x" (drops the withdrawal per remapWithdrawnSpans), backspace the
    // "x" away again — nothing left in the withdrawn list, so the natural
    // parse of "tod" renders fully highlighted.
    const afterTyping = remapWithdrawnSpans("tod", "todx", [{ start: 0, end: 3 }]);
    const afterBackspace = remapWithdrawnSpans("todx", "tod", afterTyping);

    expect(computeQuickAddMatches("tod", { now: NOW }, afterBackspace)).toEqual([
      { start: 0, end: 3, kind: "date", matchId: "2026-09-10", withdrawn: false },
    ]);
  });

  it("clearing the field and retyping the identical text re-recognises it (QA-07)", () => {
    const afterClear = remapWithdrawnSpans("tod", "", [{ start: 0, end: 3 }]);
    const afterRetype = remapWithdrawnSpans("", "tod", afterClear);

    expect(computeQuickAddMatches("tod", { now: NOW }, afterRetype)).toEqual([
      { start: 0, end: 3, kind: "date", matchId: "2026-09-10", withdrawn: false },
    ]);
  });
});
