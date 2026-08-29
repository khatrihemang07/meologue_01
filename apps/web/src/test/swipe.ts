import { fireEvent } from "@testing-library/react";

/**
 * Synthesised touch gestures for the thread's swipe-to-open recogniser
 * (#127), shared by every suite that needs to reach an Entry's actions the
 * way a finger does.
 *
 * Deliberately says nothing about velocity. jsdom takes an event's
 * `timeStamp` from the real clock, so two `fireEvent`s land in the same
 * millisecond as often as not and the release velocity a real drag would
 * produce is simply not expressible here. Every gesture below therefore
 * qualifies (or fails to qualify) on DISTANCE alone, which is deterministic;
 * the velocity half of the decision is pinned in
 * `lib/swipe-recognizer.test.ts`, where time is an argument rather than a
 * reading.
 */

const START_X = 300;
const START_Y = 100;

/** Just past `HORIZONTAL_THRESHOLD_PX`, so the next move is a confirmed drag. */
const CONFIRM_STEP_PX = 13;

interface Point {
  clientX: number;
  clientY: number;
}

function touch(target: Element, type: "pointerDown" | "pointerMove" | "pointerUp", point: Point) {
  fireEvent[type](target, { pointerId: 1, pointerType: "touch", ...point });
}

/**
 * A finger dragging `distance` px leftward off `target` and lifting there.
 * Past ~24px (half the peek limit) this opens the actions; below it, it does
 * not.
 */
export function swipeLeft(target: Element, distance = 60) {
  const end = { clientX: START_X - CONFIRM_STEP_PX - distance, clientY: START_Y };
  touch(target, "pointerDown", { clientX: START_X, clientY: START_Y });
  touch(target, "pointerMove", { clientX: START_X - CONFIRM_STEP_PX, clientY: START_Y });
  touch(target, "pointerMove", end);
  touch(target, "pointerUp", end);
}

/** A finger dragging straight down — the thread scrolls, nothing opens. */
export function swipeDown(target: Element, distance = 60) {
  const end = { clientX: START_X, clientY: START_Y + distance };
  touch(target, "pointerDown", { clientX: START_X, clientY: START_Y });
  touch(target, "pointerMove", { clientX: START_X, clientY: START_Y + distance / 2 });
  touch(target, "pointerMove", end);
  touch(target, "pointerUp", end);
}

/** A finger landing and lifting without moving. */
export function tap(target: Element) {
  const point = { clientX: START_X, clientY: START_Y };
  touch(target, "pointerDown", point);
  touch(target, "pointerUp", point);
}

/** The same leftward drag, but from a mouse rather than a finger. */
export function mouseDragLeft(target: Element, distance = 60) {
  const end = { clientX: START_X - CONFIRM_STEP_PX - distance, clientY: START_Y };
  const as = (type: "pointerDown" | "pointerMove" | "pointerUp", point: Point) =>
    fireEvent[type](target, { pointerId: 1, pointerType: "mouse", ...point });
  as("pointerDown", { clientX: START_X, clientY: START_Y });
  as("pointerMove", { clientX: START_X - CONFIRM_STEP_PX, clientY: START_Y });
  as("pointerMove", end);
  as("pointerUp", end);
}
