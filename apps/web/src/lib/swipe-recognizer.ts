/**
 * The horizontal-swipe recogniser: pointers and arithmetic, nothing else.
 *
 * It decides three things and no more — whether the movement so far reads as
 * a horizontal swipe rather than a vertical scroll, a long press or the start
 * of text selection; the physics of the drag once it does (1:1 tracking, then
 * rubber-band resistance past the peek limit); and whether the release counts
 * as opening something. It never decides what a swipe MEANS: no sheet, no
 * Entry, no DOM. `use-swipe-actions.ts` owns that half.
 *
 * The numbers below are the retired prototype's, reused rather than
 * re-derived. They were tuned against real hardware — a finger on a phone,
 * with the platform's own long-press and text selection competing for the
 * same gesture — and a synthesised pointer sequence cannot re-derive them
 * because it never reproduces the competition. Changing one of these is a
 * device question, not a unit-test question.
 */

/** Horizontal travel that confirms a swipe rather than a scroll or a press. */
export const HORIZONTAL_THRESHOLD_PX = 12;

/**
 * Vertical travel that abandons a not-yet-confirmed candidate to the
 * platform's own scrolling. Axis lock rather than a fixed ratio, so a
 * diagonal-ish swipe still confirms as long as its horizontal component gets
 * there first.
 */
export const VERTICAL_BAIL_PX = 12;

/**
 * How long a candidate may go unconfirmed before the gesture is handed back
 * to the platform. Past this, a finger still down is Android's own
 * text-selection long-press starting (its threshold is ~500ms), and the one
 * gesture this must never steal is the one that raises the selection handles
 * and the system Copy toolbar.
 */
export const LONG_PRESS_MS = 400;

/**
 * Classic UIScrollView rubber band: as travel past the peek limit grows, the
 * movement it produces keeps shrinking rather than stopping dead. A hard wall
 * reads as a broken gesture; a lower coefficient reads as stiffer resistance.
 */
export const RUBBER_BAND_COEFFICIENT = 0.55;

/**
 * Only movement from the last of these milliseconds counts toward the release
 * velocity, so a drag that moved fast and then paused before lifting reads as
 * the pause it actually was rather than the average of the whole gesture.
 */
export const VELOCITY_WINDOW_MS = 80;

/** Leftward px/ms at release that opens regardless of distance travelled. */
export const FLICK_VELOCITY_PX_PER_MS = 0.5;

/** Fraction of the peek limit that opens on a release without a flick. */
export const LATCH_FRACTION = 0.5;

/**
 * How far the bubble may travel under a finger before resistance sets in.
 * The gesture only has to feel answered — nothing is revealed underneath, so
 * this is not a strip width the way the prototype's was, just the distance at
 * which "yes, I heard you" is legible.
 */
export const PEEK_LIMIT_PX = 48;

export interface PointerSample {
  pointerId: number;
  /** Client-space x, in CSS pixels. */
  x: number;
  /** Client-space y, in CSS pixels. */
  y: number;
  /** The event's own timestamp, in milliseconds. */
  t: number;
}

export type SwipeMoveResult =
  /** Not tracking this pointer, or not yet unambiguous. Nothing to draw. */
  | { kind: "ignored" }
  /** The gesture belongs to the platform now. Anything drawn must spring back. */
  | { kind: "abandoned" }
  | {
      kind: "confirmed";
      /** Where the bubble should sit, in px. Always <= 0 — leftward only. */
      offset: number;
      /** True on the single move that crossed the threshold. */
      justConfirmed: boolean;
    };

export type SwipeEndResult =
  | { kind: "ignored" }
  | {
      kind: "released";
      /** Whether the release opens what the swipe was reaching for. */
      opens: boolean;
    };

export interface SwipeRecognizerOptions {
  /** Peek limit in px; defaults to {@link PEEK_LIMIT_PX}. */
  limit?: number;
  /**
   * Whether no text is currently selected. Injected rather than read from
   * `window` so this module stays DOM-free and the selection guards — the
   * whole reason this recogniser can share a thread with native text
   * selection — are testable without a real Selection.
   */
  isSelectionCollapsed: () => boolean;
}

/**
 * Rubber-band displacement for `overshoot` px travelled past `limit`.
 * Asymptotic: it keeps growing, but never reaches `limit` again however hard
 * the finger pulls.
 */
export function rubberBand(overshoot: number, limit: number): number {
  if (limit <= 0) return 0;
  const k = RUBBER_BAND_COEFFICIENT;
  return (overshoot * k * limit) / (k * limit + overshoot);
}

interface TrackingState {
  pointerId: number;
  startX: number;
  startY: number;
  startTime: number;
  confirmed: boolean;
  /**
   * Where travel is measured from once confirmed — the pointer's position at
   * the instant of confirmation, never the original pointerdown. Measuring
   * from pointerdown and subtracting the threshold's numeric value is the
   * same distance but not the same first paint: the very first reported
   * offset already carried whatever the 12px recognition step accumulated, so
   * the bubble visibly popped by ~13px the moment a swipe was recognised.
   */
  originX: number;
  /** Raw leftward travel since `originX`, before rubber-banding. */
  travel: number;
  samples: { x: number; t: number }[];
}

export interface SwipeRecognizer {
  /** Begins tracking this pointer. False when it is not a candidate at all. */
  down(sample: PointerSample): boolean;
  move(sample: PointerSample): SwipeMoveResult;
  end(sample: PointerSample): SwipeEndResult;
  /** Drops any in-flight gesture without producing a release. */
  cancel(): void;
  /** The pointer being tracked, or null. */
  activePointerId(): number | null;
}

/**
 * One in-flight gesture per recogniser. It is meant to be created once per
 * scrolling region rather than once per row: a second pointer landing while
 * one is already tracked is ignored below rather than modelled, which is also
 * what keeps a two-finger pinch from reading as two competing swipes.
 */
export function createSwipeRecognizer({
  limit = PEEK_LIMIT_PX,
  isSelectionCollapsed,
}: SwipeRecognizerOptions): SwipeRecognizer {
  let state: TrackingState | null = null;

  function down(sample: PointerSample): boolean {
    // A selection that already exists when the finger lands disqualifies the
    // gesture outright: the reader is working with selected text, and the
    // tap that dismisses a selection must not also be a swipe candidate.
    if (state !== null || !isSelectionCollapsed()) return false;
    state = {
      pointerId: sample.pointerId,
      startX: sample.x,
      startY: sample.y,
      startTime: sample.t,
      confirmed: false,
      originX: sample.x,
      travel: 0,
      samples: [{ x: sample.x, t: sample.t }],
    };
    return true;
  }

  function move(sample: PointerSample): SwipeMoveResult {
    if (state === null || sample.pointerId !== state.pointerId) {
      return { kind: "ignored" };
    }

    let justConfirmed = false;
    if (!state.confirmed) {
      const dx = sample.x - state.startX;
      const dy = sample.y - state.startY;
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);

      // Reads as a vertical scroll. The bubble's own `touch-action: pan-y`
      // already lets the browser carry it; this steps out of the way rather
      // than fighting it.
      if (ady > VERTICAL_BAIL_PX && ady > adx) {
        state = null;
        return { kind: "abandoned" };
      }
      // The long-press window passed with no confirmed swipe.
      if (sample.t - state.startTime > LONG_PRESS_MS) {
        state = null;
        return { kind: "abandoned" };
      }
      // A selection appeared mid-drag. Checked here and again below, on
      // every confirmed move, rather than only at the start: a long drag
      // gives one every chance to appear, and the platform wins each time.
      if (!isSelectionCollapsed()) {
        state = null;
        return { kind: "abandoned" };
      }
      // Leftward only, and unambiguously horizontal.
      if (dx > 0 || adx < HORIZONTAL_THRESHOLD_PX || adx <= ady) {
        return { kind: "ignored" };
      }

      state.confirmed = true;
      state.originX = sample.x;
      justConfirmed = true;
    }

    if (!isSelectionCollapsed()) {
      state = null;
      return { kind: "abandoned" };
    }

    const travel = Math.max(0, state.originX - sample.x);
    state.travel = travel;
    const revealed = travel > limit ? limit + rubberBand(travel - limit, limit) : travel;

    state.samples.push({ x: sample.x, t: sample.t });
    while (
      state.samples.length > 1 &&
      sample.t - (state.samples[0]?.t ?? sample.t) > VELOCITY_WINDOW_MS
    ) {
      state.samples.shift();
    }

    // `revealed > 0` rather than a bare negation: `-0` is a real value that
    // compares unequal to `0` under `Object.is`, and the first offset after
    // confirmation is always exactly zero.
    return { kind: "confirmed", offset: revealed > 0 ? -revealed : 0, justConfirmed };
  }

  function end(sample: PointerSample): SwipeEndResult {
    if (state === null || sample.pointerId !== state.pointerId) {
      return { kind: "ignored" };
    }
    const tracked = state;
    state = null;
    if (!tracked.confirmed) return { kind: "ignored" };

    const first = tracked.samples[0];
    const dt = first ? sample.t - first.t : 0;
    // px/ms, negative leftward.
    const velocity = first && dt > 0 ? (sample.x - first.x) / dt : 0;

    // Distance OR velocity: a short, fast flick is as deliberate as a slow
    // drag past the halfway mark, and a recogniser that ignores velocity
    // makes the quick gesture feel broken while the slow one works.
    const opens = tracked.travel >= limit * LATCH_FRACTION || velocity <= -FLICK_VELOCITY_PX_PER_MS;
    return { kind: "released", opens };
  }

  return {
    down,
    move,
    end,
    cancel() {
      state = null;
    },
    activePointerId() {
      return state?.pointerId ?? null;
    },
  };
}
