import { dayFraction } from "@/lib/time-lanes";

/**
 * Zooming the shared clock (issue #418).
 *
 * `time-page.tsx` used to render every day at one fixed 120px-per-hour scale.
 * That made the shortest real records — Toggl's Activity Recording database
 * stores stretches as short as ten seconds — impossible to see or land a
 * click on even with `time-lanes.ts`'s minimum-height floor: the floor keeps
 * a record clickable, but at a fixed scale it does so by drawing every short
 * record at the same few pixels forever, however far in a reader zooms
 * everything else. These are the pure seams zoom needs: how many px-per-hour
 * levels exist, how small a click target has to stay at each one, where the
 * clock's own labels fall at a given zoom, and how to keep the instant under
 * the reader's finger or cursor stationary while the scale's height changes
 * underneath it. Kept as pure functions over instants and fractions, for the
 * same reason `time-lanes.ts`'s own header comment gives: exact values are
 * testable, and `getBoundingClientRect` in jsdom is not.
 */

/**
 * The px-per-hour steps zoom can land on, ascending. 120 (`DEFAULT_ZOOM_INDEX`)
 * is the scale the page always rendered at before zoom existed, kept as the
 * default so opening a day looks the same as it always did until a reader
 * actually reaches for zoom. 3840 is 32x that — 64px per minute, generous
 * headroom for a ten-second record to become a real, separately clickable
 * block instead of vanishing into `minimumFraction`'s floor.
 */
export const ZOOM_LEVELS = [30, 60, 120, 240, 480, 960, 1920, 3840] as const;

export const DEFAULT_ZOOM_INDEX = ZOOM_LEVELS.indexOf(120);

/**
 * `ZOOM_LEVELS[index]`, clamped to a real entry.
 *
 * A plain index into `ZOOM_LEVELS` types as `number | undefined` under this
 * project's `noUncheckedIndexedAccess` — correctly, since nothing stops a
 * caller passing an out-of-range index. `use-timeline-zoom.ts` always
 * clamps its own index before storing it, so every real call site already
 * has an in-range value; this exists to say so once rather than repeat an
 * `?? 120` fallback (which would silently paper over a genuine out-of-range
 * bug) at each one.
 */
export function zoomLevelAt(index: number): number {
  const clamped = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, index));
  return ZOOM_LEVELS[clamped] ?? 120;
}

/** The smallest a record's own click target is ever drawn at, in pixels. */
export const MIN_TARGET_PX = 8;

/**
 * The smallest height a record is drawn at, as a fraction of a day, at a
 * given zoom level.
 *
 * `time-lanes.ts`'s `placeLane` takes this as its `minimumHeight` argument
 * instead of hard-coding one number the way it did before zoom existed: the
 * true "smallest target still worth having" is a fact about how many pixels
 * currently stand for a day, and that now changes as a reader zooms.
 */
export function minimumFraction(pxPerHour: number): number {
  return MIN_TARGET_PX / (pxPerHour * 24);
}

/** One label on the shared clock, at a given zoom level. */
export type ScaleMark = {
  /** The instant this mark sits on. */
  instant: number;
  /** Distance from the top of the day, as a fraction of the whole day. */
  top: number;
  /** `HH:mm`, read off the clock at `instant` — see this file's own comment
   * on why marks are placed and labelled this way rather than by assuming
   * the scale begins at local midnight. */
  label: string;
  /** True on the hour, for a heavier tick or label at low zoom. */
  major: boolean;
};

/**
 * Minute steps a mark spacing can fall back through, widest last. Every one
 * of `ZOOM_LEVELS`'s eight levels lands on one of these with room to spare —
 * 120 minutes even clears 30px/hour, the widest-out level there is.
 */
const STEP_MINUTES = [1, 2, 5, 10, 15, 30, 60, 120] as const;

/** How far apart two labels have to stay for both to stay readable. */
const MIN_LABEL_SPACING_PX = 40;

function stepMinutesFor(pxPerHour: number): number {
  const pxPerMinute = pxPerHour / 60;
  for (const candidate of STEP_MINUTES) {
    if (candidate * pxPerMinute >= MIN_LABEL_SPACING_PX) {
      return candidate;
    }
  }
  // Unreachable for any level `ZOOM_LEVELS` actually offers — the widest
  // candidate (120 minutes) already clears the floor at the widest-out zoom
  // level (30px/hour: 120 * 0.5 = 60px). Kept as a fallback rather than an
  // assertion: a scale with marks a little closer than 40px is still a
  // usable scale, and throwing here is not something a render can recover
  // from.
  return 120;
}

/**
 * The clock marks a day's shared scale is drawn against, at a given zoom.
 *
 * Marks are placed at `dayStart + k * step`, walking forward in real elapsed
 * time — not at fixed fractions of the day the way the fixed-scale predecessor
 * `time-lanes.ts` used to compute (`hourMarks`, retired by this issue). Each
 * mark is then *labelled* by reading the clock at the instant it lands on,
 * which keeps the same DST-agnostic property `hourMarks`'s own comment
 * documented: placing or labelling by "local hour N" only works when the
 * window happens to begin at local midnight, and silently collapses onto the
 * top edge when it does not (which is exactly what the Server's UTC-resolved
 * day boundary used to do to a Device several hours off UTC — see ADR 0092).
 * On a daylight-saving day the elapsed-time steps stay even while the day
 * itself is 23 or 25 hours long, so a label may repeat or skip an hour; the
 * labels stay truthful about the instants they sit on, which is what matters
 * for reading a timeline.
 */
export function scaleMarks(dayStart: number, dayEnd: number, pxPerHour: number): ScaleMark[] {
  const stepMs = stepMinutesFor(pxPerHour) * 60_000;
  const marks: ScaleMark[] = [];
  for (let instant = dayStart; instant < dayEnd; instant += stepMs) {
    const at = new Date(instant);
    const hours = at.getHours();
    const minutes = at.getMinutes();
    marks.push({
      instant,
      top: dayFraction(instant, dayStart, dayEnd),
      label: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`,
      major: minutes === 0,
    });
  }
  return marks;
}

/** What `anchoredScrollTop` needs to keep one instant fixed on screen. */
export type AnchorInput = {
  /** The scroller's `scrollTop` before the zoom change. */
  scrollTop: number;
  /**
   * Where the focal point sits within the scroller's own *visible* viewport,
   * in pixels from that viewport's top — the cursor position for a
   * ctrl/⌘+wheel zoom, or the pinch midpoint for a touch one.
   */
  focalOffset: number;
  /**
   * The timeline scale's own offset within the scrollable content, in
   * pixels — nonzero when something (a heading, a day's own controls) sits
   * above it inside the same scroll region.
   */
  timelineTop: number;
  oldPxPerHour: number;
  newPxPerHour: number;
};

/**
 * The `scrollTop` that keeps the instant under the focal point stationary on
 * screen after the scale's height changes from `oldPxPerHour` to
 * `newPxPerHour`.
 *
 * The reasoning: `scrollTop + focalOffset - timelineTop` is how far into the
 * timeline's own content the focal instant currently sits, in the *old*
 * scale's pixels. Dividing by the old scale's total height turns that into a
 * fraction of the day, which is scale-independent — multiplying it back out
 * by the *new* scale's total height gives the same instant's offset in the
 * new scale. Solving for the `scrollTop` that puts that offset back under
 * the same `focalOffset` gives the formula below.
 */
export function anchoredScrollTop({
  scrollTop,
  focalOffset,
  timelineTop,
  oldPxPerHour,
  newPxPerHour,
}: AnchorInput): number {
  const oldHeight = oldPxPerHour * 24;
  const newHeight = newPxPerHour * 24;
  const offsetWithinTimeline = scrollTop + focalOffset - timelineTop;
  const fraction = offsetWithinTimeline / oldHeight;
  const newOffsetWithinTimeline = fraction * newHeight;
  return Math.max(0, newOffsetWithinTimeline - focalOffset + timelineTop);
}
