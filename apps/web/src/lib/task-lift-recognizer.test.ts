import { describe, expect, it } from "vitest";
import { HORIZONTAL_THRESHOLD_PX, VERTICAL_BAIL_PX } from "./swipe-recognizer";
import { liftCandidateBailed } from "./task-lift-recognizer";

/**
 * `liftCandidateBailed` is pure arithmetic precisely so it can be pinned at
 * exact coordinates, mirroring `swipe-recognizer.test.ts`'s own reasoning
 * for why its physics live in a table of `at(x, y, t)` calls rather than a
 * `fireEvent` sequence: jsdom has no compositor and no real finger, so the
 * geometry has to be exercised directly.
 */
describe("liftCandidateBailed", () => {
  it("does not bail for a barely-jittered still hold", () => {
    expect(liftCandidateBailed(1, 1)).toBe(false);
  });

  it("does not bail exactly AT either threshold — only once travel goes past it", () => {
    expect(liftCandidateBailed(0, VERTICAL_BAIL_PX)).toBe(false);
    expect(liftCandidateBailed(HORIZONTAL_THRESHOLD_PX, 0)).toBe(false);
  });

  it("bails once vertical travel passes the bail threshold and dominates — the scroll case", () => {
    expect(liftCandidateBailed(0, VERTICAL_BAIL_PX + 1)).toBe(true);
    // Still bails leftward/upward, rightward/downward — direction never
    // matters here the way it does for swipe-recognizer.ts's own
    // leftward-only confirm rule.
    expect(liftCandidateBailed(0, -(VERTICAL_BAIL_PX + 1))).toBe(true);
  });

  it("bails once horizontal travel passes the threshold and dominates, in EITHER direction", () => {
    // Rightward — swipe-to-schedule itself would never confirm this (it's
    // leftward-only), but a still hold this is not, so the lift declines
    // to arm under a reader's hand mid-shrug regardless of which way it
    // went.
    expect(liftCandidateBailed(HORIZONTAL_THRESHOLD_PX + 1, 0)).toBe(true);
    expect(liftCandidateBailed(-(HORIZONTAL_THRESHOLD_PX + 1), 0)).toBe(true);
  });

  it("does not bail on a diagonal where neither axis actually dominates the other", () => {
    // Equal travel on both axes: neither `ady > adx` nor `adx > ady` holds,
    // so this is deliberately still "pending" rather than guessing which
    // gesture it is.
    expect(liftCandidateBailed(VERTICAL_BAIL_PX + 5, VERTICAL_BAIL_PX + 5)).toBe(false);
  });

  it("a mostly-horizontal diagonal past the horizontal threshold still bails, even with some vertical travel", () => {
    expect(liftCandidateBailed(HORIZONTAL_THRESHOLD_PX + 5, 3)).toBe(true);
  });

  it("a mostly-vertical diagonal past the vertical threshold still bails, even with some horizontal travel", () => {
    expect(liftCandidateBailed(3, VERTICAL_BAIL_PX + 5)).toBe(true);
  });
});
