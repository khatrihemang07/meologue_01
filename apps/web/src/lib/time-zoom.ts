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

/**
 * How far apart two grid LINES (major or minor, unlabelled included) have to
 * stay for both to still read as separate lines rather than merging into a
 * solid band — issue #431. Much smaller than `MIN_LABEL_SPACING_PX`: a line
 * has no text to clip or overlap, only itself, so it can pack far denser
 * than a label ever could.
 */
const MIN_GRIDLINE_SPACING_PX = 8;

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
 * Minor-gridline step candidates, in seconds, finest first — issue #431. 15
 * divides every one of `STEP_MINUTES`'s label steps once converted to
 * seconds (60 through 7200), so any candidate this list can return divides
 * evenly into whichever label step `stepMinutesFor` picked at the same zoom
 * — the exact-division property `gridMarks` relies on to make a labelled
 * mark's `top` and an unlabelled minor mark's `top` fall out of literally
 * the same walk, rather than two separately-rounded computations that could
 * drift apart by a pixel.
 */
const MINOR_STEP_SECONDS = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200] as const;

function minorStepSecondsFor(pxPerHour: number, labelStepSeconds: number): number {
  const pxPerSecond = pxPerHour / 3600;
  for (const candidate of MINOR_STEP_SECONDS) {
    if (candidate > labelStepSeconds || labelStepSeconds % candidate !== 0) {
      continue;
    }
    if (candidate * pxPerSecond >= MIN_GRIDLINE_SPACING_PX) {
      return candidate;
    }
  }
  // Unreachable: `labelStepSeconds` itself is always in `MINOR_STEP_SECONDS`
  // (every `STEP_MINUTES` entry converted to seconds is one of this list's
  // values) and always clears `MIN_GRIDLINE_SPACING_PX` — `stepMinutesFor`
  // only ever picks a label step that already clears the much taller
  // `MIN_LABEL_SPACING_PX` floor. Kept as a fallback for the same reason
  // `stepMinutesFor`'s own fallback is: a render that hits it draws grid
  // lines exactly where the labels are, one line, not a crash.
  return labelStepSeconds;
}

/** `HH:mm`, read off the clock at `instant` — the one place both the scale's
 * labels (`scaleMarks`) and the now marker's own time (`comparative-
 * timeline.tsx`'s `ScaleGutter`) format a clock reading, so neither can ever
 * show a different string for the same instant. */
export function formatClock(instant: number): string {
  const at = new Date(instant);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * One line on the day's shared grid, at a given zoom level — issue #431.
 * `scaleMarks` (below) is a `labelled`-only filter over this, not a second
 * computation of the same positions, so a label and its line can never
 * drift apart: see `gridMarks`' own header comment for why the minor step it
 * walks at is always an exact divisor of the label step, which is what
 * makes that filter produce byte-identical `instant`/`top` values to what
 * `scaleMarks` used to compute directly.
 */
export type GridMark = {
  /** The instant this mark sits on. */
  instant: number;
  /** Distance from the top of the day, as a fraction of the whole day. */
  top: number;
  /** True on the hour, for a heavier line at low zoom. */
  major: boolean;
  /** True for the marks `scaleMarks` also returns, with a label attached. */
  labelled: boolean;
};

/**
 * The grid lines a day's timeline is drawn against, at a given zoom —
 * labelled marks (identical to `scaleMarks`' own output) plus, at zoom
 * levels with room, unlabelled minor lines between them. Toggl Track's
 * Calendar is the visual reference (issue #431): a line at every label,
 * strong on the hour, fainter minor lines between that get denser the
 * further in a reader zooms.
 *
 * Walks forward in real elapsed time from `dayStart`, exactly like
 * `scaleMarks`' own header comment documents for the same DST-agnostic
 * reason — labelling (and here, "major") by reading the clock at the
 * instant a mark actually lands on, never by assuming the window began at
 * local midnight.
 */
export function gridMarks(dayStart: number, dayEnd: number, pxPerHour: number): GridMark[] {
  const labelStepSeconds = stepMinutesFor(pxPerHour) * 60;
  const labelStepMs = labelStepSeconds * 1000;
  const stepMs = minorStepSecondsFor(pxPerHour, labelStepSeconds) * 1000;
  const marks: GridMark[] = [];
  for (let instant = dayStart; instant < dayEnd; instant += stepMs) {
    const at = new Date(instant);
    marks.push({
      instant,
      top: dayFraction(instant, dayStart, dayEnd),
      major: at.getMinutes() === 0 && at.getSeconds() === 0,
      labelled: (instant - dayStart) % labelStepMs === 0,
    });
  }
  return marks;
}

/**
 * The clock marks a day's shared scale is drawn against, at a given zoom —
 * the `labelled` subset of `gridMarks`' own output (see that function's
 * header comment for why lines and labels are one seam, not two), each
 * given the `label` text a plain grid line has no use for.
 *
 * Kept as its own exported function, not inlined at every call site, both
 * because it predates `gridMarks` (issue #418) and because most callers
 * only ever want the labels — `ScaleGutter` is the one place that needs the
 * full grid.
 */
export function scaleMarks(dayStart: number, dayEnd: number, pxPerHour: number): ScaleMark[] {
  return gridMarks(dayStart, dayEnd, pxPerHour)
    .filter((mark) => mark.labelled)
    .map((mark) => ({
      instant: mark.instant,
      top: mark.top,
      major: mark.major,
      label: formatClock(mark.instant),
    }));
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
