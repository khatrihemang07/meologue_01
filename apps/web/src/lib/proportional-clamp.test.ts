import { describe, expect, it } from "vitest";
import { allocateLineBudgets } from "./proportional-clamp";

/**
 * The arithmetic behind "nothing is clamped while the three fit, and only
 * what has to be cut is cut" (#128). Pure, so the awkward cases — a card
 * shorter than the floor, one that fits while its neighbours do not, three
 * that overflow by a single line — are expressible exactly, where a real
 * browser measurement can only ever be approached.
 */
describe("allocateLineBudgets", () => {
  it("clamps nothing when the three fit", () => {
    expect(allocateLineBudgets({ demands: [4, 6, 8], available: 30, minimum: 3 })).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("clamps nothing when they fit exactly, to the line", () => {
    // The boundary is worth pinning: one line either way is the difference
    // between a page that scrolls and one that does not.
    expect(allocateLineBudgets({ demands: [4, 6, 8], available: 18, minimum: 3 })).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("clamps everything that overflows, proportionally to what each needs", () => {
    // 30 lines wanted, 15 available: each keeps half of what it asked for.
    expect(allocateLineBudgets({ demands: [6, 10, 14], available: 15, minimum: 3 })).toEqual([
      3, 5, 7,
    ]);
  });

  it("never spends more than the budget — every share is floored, not rounded", () => {
    const budgets = allocateLineBudgets({ demands: [7, 7, 7], available: 10, minimum: 1 });
    const spent = budgets.reduce<number>((sum, lines) => sum + (lines ?? 0), 0);
    expect(spent).toBeLessThanOrEqual(10);
    expect(budgets).toEqual([3, 3, 3]);
  });

  it("holds a clamped card at the floor rather than cutting it to a fragment", () => {
    // The month wants nearly everything; the day and week would get one line
    // each on a pure proportional split, which is not a teaser of anything.
    expect(allocateLineBudgets({ demands: [2, 2, 40], available: 12, minimum: 3 })).toEqual([
      null,
      null,
      8,
    ]);
  });

  it("shows a card in full rather than padding it out past its own prose", () => {
    // A two-line Digest with a floor of three must not sit in a three-line
    // box with "read the rest" under it and nothing left to read.
    const budgets = allocateLineBudgets({ demands: [2, 30], available: 10, minimum: 3 });
    expect(budgets[0]).toBeNull();
    expect(budgets[1]).toBe(8);
  });

  it("hands a short card's surplus to the ones that are still cut", () => {
    // Without redistribution the long card would get 20 * 30/32 = 18; with
    // the two-line card settled first it gets the whole 18 remaining.
    const withShort = allocateLineBudgets({ demands: [2, 30], available: 20, minimum: 3 });
    expect(withShort).toEqual([null, 18]);
  });

  it("does not depend on the order the cards arrive in", () => {
    const forwards = allocateLineBudgets({ demands: [2, 9, 30], available: 20, minimum: 3 });
    const backwards = allocateLineBudgets({ demands: [30, 9, 2], available: 20, minimum: 3 });
    expect([...backwards].reverse()).toEqual(forwards);
  });

  it("treats a card with nothing to show as needing nothing", () => {
    // A Period with no Digest yet renders its own short empty copy and has
    // no prose to clamp at all.
    const budgets = allocateLineBudgets({ demands: [0, 20, 20], available: 20, minimum: 3 });
    expect(budgets[0]).toBeNull();
    expect(budgets[1]).toBe(10);
    expect(budgets[2]).toBe(10);
  });

  it("still clamps when there is no room at all rather than returning nothing", () => {
    // A window too short for even the floors: every card is still cut to the
    // floor, and the page scrolls. Rendering them at full height instead
    // would be the defect this replaces, at its worst.
    expect(allocateLineBudgets({ demands: [20, 20, 20], available: 0, minimum: 3 })).toEqual([
      3, 3, 3,
    ]);
  });

  it("handles a single card, and no cards at all", () => {
    expect(allocateLineBudgets({ demands: [40], available: 10, minimum: 3 })).toEqual([10]);
    expect(allocateLineBudgets({ demands: [], available: 10, minimum: 3 })).toEqual([]);
  });
});
