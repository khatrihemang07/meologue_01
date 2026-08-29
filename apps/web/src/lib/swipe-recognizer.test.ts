import { beforeEach, describe, expect, it } from "vitest";
import {
  createSwipeRecognizer,
  FLICK_VELOCITY_PX_PER_MS,
  HORIZONTAL_THRESHOLD_PX,
  LATCH_FRACTION,
  LONG_PRESS_MS,
  PEEK_LIMIT_PX,
  rubberBand,
  type SwipeRecognizer,
  VELOCITY_WINDOW_MS,
  VERTICAL_BAIL_PX,
} from "./swipe-recognizer";

/**
 * The recogniser is a pure state machine precisely so its physics can be
 * exercised at exact coordinates and exact timestamps — a synthesised pointer
 * sequence in jsdom can do neither, because `timeStamp` comes from the clock
 * and two `fireEvent`s land in the same millisecond. `use-swipe-actions.test`
 * covers the DOM half; the numbers live here.
 */

let collapsed = true;
let recognizer: SwipeRecognizer;

beforeEach(() => {
  collapsed = true;
  recognizer = createSwipeRecognizer({ isSelectionCollapsed: () => collapsed });
});

/** A pointer landing at x, y at time t, on pointer 1 unless told otherwise. */
function at(x: number, y: number, t: number, pointerId = 1) {
  return { pointerId, x, y, t };
}

describe("rubberBand", () => {
  it("is asymptotic — it never gives back the limit however hard the finger pulls", () => {
    expect(rubberBand(48, 48)).toBeLessThan(48);
    expect(rubberBand(4_800, 48)).toBeLessThan(48);
    // Monotonic all the way up: resistance, not a wall.
    expect(rubberBand(4_800, 48)).toBeGreaterThan(rubberBand(48, 48));
  });

  it("resists more the further past the limit the finger goes", () => {
    // 1:1 would give 10 more px for 10 more px of travel; each successive
    // 10px buys less than the last.
    const first = rubberBand(10, 48);
    const second = rubberBand(20, 48) - first;
    expect(second).toBeLessThan(first);
  });

  it("is zero for a limit of zero rather than dividing by it", () => {
    expect(rubberBand(30, 0)).toBe(0);
  });
});

describe("createSwipeRecognizer", () => {
  it("reports no offset until the horizontal threshold is crossed", () => {
    recognizer.down(at(200, 100, 0));
    const short = recognizer.move(at(200 - (HORIZONTAL_THRESHOLD_PX - 1), 100, 20));
    expect(short.kind).toBe("ignored");
  });

  it("measures travel from the point of confirmation, so the first offset is exactly zero", () => {
    // The retired prototype measured from pointerdown and subtracted the
    // threshold's numeric value — the same distance, but its very first
    // reported offset already carried the recognition step, so the bubble
    // visibly popped ~13px the instant a swipe was recognised.
    recognizer.down(at(200, 100, 0));
    const confirming = recognizer.move(at(200 - HORIZONTAL_THRESHOLD_PX - 1, 100, 20));
    expect(confirming).toEqual({ kind: "confirmed", offset: 0, justConfirmed: true });
  });

  it("tracks 1:1 up to the peek limit and resists past it", () => {
    recognizer.down(at(200, 100, 0));
    const origin = 200 - HORIZONTAL_THRESHOLD_PX - 1;
    recognizer.move(at(origin, 100, 20));

    const halfway = recognizer.move(at(origin - 24, 100, 40));
    expect(halfway).toEqual({ kind: "confirmed", offset: -24, justConfirmed: false });

    const past = recognizer.move(at(origin - 200, 100, 60));
    expect(past.kind).toBe("confirmed");
    if (past.kind !== "confirmed") return;
    // Answered, but nowhere near the 200px the finger actually travelled.
    expect(past.offset).toBeLessThan(-PEEK_LIMIT_PX);
    expect(past.offset).toBeGreaterThan(-2 * PEEK_LIMIT_PX);
  });

  it("never reports a rightward offset — a swipe right is not this gesture", () => {
    recognizer.down(at(200, 100, 0));
    expect(recognizer.move(at(260, 100, 20)).kind).toBe("ignored");
    // And it is still tracking: the finger may yet come back leftward.
    expect(recognizer.activePointerId()).toBe(1);
  });

  it("bails out to the platform's scrolling once vertical movement dominates", () => {
    recognizer.down(at(200, 100, 0));
    const bailed = recognizer.move(at(198, 100 + VERTICAL_BAIL_PX + 1, 20));
    expect(bailed).toEqual({ kind: "abandoned" });
    expect(recognizer.activePointerId()).toBeNull();
  });

  it("still confirms a diagonal swipe whose horizontal component wins first", () => {
    recognizer.down(at(200, 100, 0));
    // Vertical travel is past the bail distance, but horizontal is larger —
    // axis lock, not a fixed ratio.
    const confirmed = recognizer.move(at(200 - 30, 100 + VERTICAL_BAIL_PX + 5, 20));
    expect(confirmed.kind).toBe("confirmed");
  });

  it("hands the gesture back once the long-press window has passed unconfirmed", () => {
    recognizer.down(at(200, 100, 0));
    // A finger still down this long is Android's own selection long-press
    // starting; stealing it is what would take the platform's selection
    // handles and system Copy toolbar away.
    const late = recognizer.move(at(200 - 40, 100, LONG_PRESS_MS + 1));
    expect(late).toEqual({ kind: "abandoned" });
  });

  it("refuses to start at all while text is already selected", () => {
    collapsed = false;
    expect(recognizer.down(at(200, 100, 0))).toBe(false);
    expect(recognizer.activePointerId()).toBeNull();
  });

  it("abandons a selection that appears before confirmation", () => {
    recognizer.down(at(200, 100, 0));
    collapsed = false;
    expect(recognizer.move(at(198, 101, 20))).toEqual({ kind: "abandoned" });
  });

  it("abandons a selection that appears after confirmation, not just before it", () => {
    // Checked on every confirmed move rather than once: a long drag gives a
    // selection every chance to appear, and the platform wins each time.
    recognizer.down(at(200, 100, 0));
    const origin = 200 - HORIZONTAL_THRESHOLD_PX - 1;
    expect(recognizer.move(at(origin, 100, 20)).kind).toBe("confirmed");
    collapsed = false;
    expect(recognizer.move(at(origin - 30, 100, 40))).toEqual({ kind: "abandoned" });
  });

  it("ignores a second pointer while one is already tracked", () => {
    expect(recognizer.down(at(200, 100, 0, 1))).toBe(true);
    expect(recognizer.down(at(100, 300, 5, 2))).toBe(false);
    expect(recognizer.move(at(40, 300, 20, 2))).toEqual({ kind: "ignored" });
    expect(recognizer.activePointerId()).toBe(1);
  });

  it("opens on a slow drag past half the peek limit", () => {
    recognizer.down(at(200, 100, 0));
    const origin = 200 - HORIZONTAL_THRESHOLD_PX - 1;
    recognizer.move(at(origin, 100, 20));
    const travel = PEEK_LIMIT_PX * LATCH_FRACTION + 1;
    // Slow: 300ms for the whole drag, and the last sample is 200ms after the
    // one before it, so the velocity window sees near-zero movement.
    recognizer.move(at(origin - travel, 100, 120));
    expect(recognizer.end(at(origin - travel, 100, 320))).toEqual({
      kind: "released",
      opens: true,
    });
  });

  it("does not open on a slow drag that stops short of half the peek limit", () => {
    recognizer.down(at(200, 100, 0));
    const origin = 200 - HORIZONTAL_THRESHOLD_PX - 1;
    recognizer.move(at(origin, 100, 20));
    const travel = PEEK_LIMIT_PX * LATCH_FRACTION - 1;
    recognizer.move(at(origin - travel, 100, 120));
    expect(recognizer.end(at(origin - travel, 100, 320))).toEqual({
      kind: "released",
      opens: false,
    });
  });

  it("opens on a fast flick that never travelled far enough to qualify on distance", () => {
    // The case the distance-only rule fails, and the reason velocity is in
    // the decision at all: a quick flick is as deliberate as a slow drag.
    recognizer.down(at(200, 100, 0));
    const origin = 200 - HORIZONTAL_THRESHOLD_PX - 1;
    recognizer.move(at(origin, 100, 20));
    const travel = PEEK_LIMIT_PX * LATCH_FRACTION - 4;
    recognizer.move(at(origin - travel, 100, 25));
    const released = recognizer.end(at(origin - travel, 100, 30));
    expect(released).toEqual({ kind: "released", opens: true });
  });

  it("reads a drag that moved fast and then paused as the pause it actually was", () => {
    // Only the last VELOCITY_WINDOW_MS of samples count, so the fast opening
    // of this drag is out of the window by the time the finger lifts.
    recognizer.down(at(200, 100, 0));
    const origin = 200 - HORIZONTAL_THRESHOLD_PX - 1;
    recognizer.move(at(origin, 100, 20));
    const travel = PEEK_LIMIT_PX * LATCH_FRACTION - 4;
    recognizer.move(at(origin - travel, 100, 25));
    for (let t = 125; t <= 425; t += 100) {
      recognizer.move(at(origin - travel, 100, t));
    }
    expect(recognizer.end(at(origin - travel, 100, 525))).toEqual({
      kind: "released",
      opens: false,
    });
  });

  it("treats a release without any confirmed movement as no gesture at all", () => {
    // This is what makes a tap do nothing: down, up, and never a move that
    // crossed the threshold.
    recognizer.down(at(200, 100, 0));
    expect(recognizer.end(at(200, 100, 40))).toEqual({ kind: "ignored" });
  });

  it("ignores a release from a pointer it is not tracking", () => {
    recognizer.down(at(200, 100, 0, 1));
    expect(recognizer.end(at(100, 100, 40, 2))).toEqual({ kind: "ignored" });
    expect(recognizer.activePointerId()).toBe(1);
  });

  it("drops the gesture on cancel without ever reporting a release", () => {
    recognizer.down(at(200, 100, 0));
    recognizer.move(at(200 - HORIZONTAL_THRESHOLD_PX - 1, 100, 20));
    recognizer.cancel();
    expect(recognizer.activePointerId()).toBeNull();
    expect(recognizer.end(at(100, 100, 40))).toEqual({ kind: "ignored" });
  });

  it("honours a caller's own peek limit rather than the default", () => {
    const wide = createSwipeRecognizer({ limit: 200, isSelectionCollapsed: () => true });
    wide.down(at(400, 100, 0));
    const origin = 400 - HORIZONTAL_THRESHOLD_PX - 1;
    wide.move(at(origin, 100, 20));
    wide.move(at(origin - 60, 100, 120));
    // 60px is past the default limit's halfway mark but well short of this
    // one's, and slow enough that velocity cannot rescue it.
    expect(wide.end(at(origin - 60, 100, 320))).toEqual({ kind: "released", opens: false });
  });

  it("uses the documented flick velocity, not a rounder number nearby", () => {
    // Pins the constant itself: a final movement at exactly the threshold
    // speed opens, and the same movement 10% slower does not. The pause
    // before it is what makes this measure only the final movement — it
    // pushes the recognition step's own samples out of the velocity window,
    // which is the whole reason that window exists.
    const travel = PEEK_LIMIT_PX * LATCH_FRACTION - 4;
    for (const [speed, expected] of [
      [FLICK_VELOCITY_PX_PER_MS, true],
      [FLICK_VELOCITY_PX_PER_MS * 0.9, false],
    ] as const) {
      const r = createSwipeRecognizer({ isSelectionCollapsed: () => true });
      r.down(at(200, 100, 0));
      const origin = 200 - HORIZONTAL_THRESHOLD_PX - 1;
      r.move(at(origin, 100, 20));
      const paused = 20 + VELOCITY_WINDOW_MS * 2;
      r.move(at(origin, 100, paused));
      const elapsed = travel / speed;
      r.move(at(origin - travel, 100, paused + elapsed));
      expect(r.end(at(origin - travel, 100, paused + elapsed))).toEqual({
        kind: "released",
        opens: expected,
      });
    }
  });
});
