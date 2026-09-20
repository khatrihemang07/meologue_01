import type { ActivityInterval } from "@/lib/time-transport";

/**
 * Laying Activity intervals out against a shared clock (issue #420).
 *
 * Kept as pure functions over instants and fractions rather than pixels, for
 * two reasons. The comparison Time exists to support — what did Toggl see
 * while Clockify saw something else — is only meaningful if every lane is
 * measured against the *same* scale, and a shared scale is much easier to get
 * wrong once each lane is also deciding its own geometry. And fractions let
 * the lane maths be tested against exact expected values, which pixels
 * measured in jsdom cannot be: jsdom has no layout, so every `getBoundingClientRect`
 * there is zero.
 */

/** One interval, placed against the day's scale and within its lane. */
export type PlacedInterval = {
  interval: ActivityInterval;
  /** Distance from the top of the day, as a fraction of the whole day. */
  top: number;
  /** Height as a fraction of the whole day, never zero. */
  height: number;
  /** Which of `columns` side-by-side slots this interval occupies. */
  column: number;
  /** How many slots the overlapping cluster this belongs to was split into. */
  columns: number;
};

/**
 * The smallest height an interval is drawn at, as a fraction of a day.
 *
 * Three minutes. Real recorders emit records of a few seconds — the Toggl
 * database this was built against has a ten-second minimum, and over half of
 * one real day's 104 records are under a minute — and at a true fraction those
 * would be sub-pixel and so impossible to point at. A record nobody can land
 * on is not "individually accessible", which is the behaviour this protects.
 *
 * The number is tied to the scale `time-page.tsx` renders at: 120px per hour
 * makes this 6px, which is the smallest target still worth having. Changing
 * either without the other is what would make this meaningless, so
 * `MINIMUM_INTERVAL_FRACTION` is exported for the page to state the
 * relationship rather than re-derive it.
 */
export const MINIMUM_INTERVAL_FRACTION = 1 / (24 * 20);
const MINIMUM_HEIGHT = MINIMUM_INTERVAL_FRACTION;

/**
 * Where an instant sits within the day, as a fraction from 0 to 1.
 *
 * Clamped at both ends because a record is on a day when it *overlaps* it: a
 * stretch of work that began yesterday evening and ended this morning is part
 * of both days, and on this one it starts at the top edge rather than above it.
 */
export function dayFraction(instant: number, dayStart: number, dayEnd: number): number {
  const span = dayEnd - dayStart;
  if (span <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, (instant - dayStart) / span));
}

/**
 * Splits one lane's intervals into side-by-side columns so that overlapping
 * records stay individually reachable instead of hiding behind each other.
 *
 * The rule is the ordinary calendar one: intervals are walked in start order,
 * each takes the first column free at its start instant, and a run of records
 * that transitively overlap — a *cluster* — is then split into as many columns
 * as its busiest moment needed. Splitting per cluster rather than per lane is
 * what keeps a single overlapping pair from narrowing the entire day.
 *
 * Records that merely touch — one ending exactly where the next begins — do
 * not overlap and stay full width.
 */
export function placeLane(
  intervals: ActivityInterval[],
  dayStart: number,
  dayEnd: number,
): PlacedInterval[] {
  const sorted = [...intervals].sort((a, b) => {
    const byStart = Date.parse(a.started_at) - Date.parse(b.started_at);
    return byStart !== 0 ? byStart : Date.parse(a.ended_at) - Date.parse(b.ended_at);
  });

  // How long a record has to run before it is drawn at its true height. Below
  // this it is drawn at `MINIMUM_HEIGHT` instead, which means two records that
  // do NOT overlap in time can still overlap *on screen* — and the columns
  // have to be decided against what is drawn, not against the clock. Measured
  // on a real day this is not an edge case: a run of twenty-second records
  // around 21:15 sat 1.2px apart at 6px tall, so every one of them covered the
  // one before it while the clock said none of them overlapped at all.
  const minimumSpan = MINIMUM_HEIGHT * (dayEnd - dayStart);
  const drawnEnd = (start: number, end: number) => Math.max(end, start + minimumSpan);

  const placed: PlacedInterval[] = [];
  // Intervals in the cluster being built, and when each column frees up.
  let cluster: PlacedInterval[] = [];
  let columnEnds: number[] = [];

  const closeCluster = () => {
    const columns = columnEnds.length;
    for (const entry of cluster) {
      entry.columns = columns;
    }
    cluster = [];
    columnEnds = [];
  };

  for (const interval of sorted) {
    const start = Date.parse(interval.started_at);
    const end = drawnEnd(start, Date.parse(interval.ended_at));

    // A cluster ends when nothing in it is still drawn at this start.
    if (columnEnds.length > 0 && columnEnds.every((columnEnd) => columnEnd <= start)) {
      closeCluster();
    }

    let column = columnEnds.findIndex((columnEnd) => columnEnd <= start);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(end);
    } else {
      columnEnds[column] = end;
    }

    const top = dayFraction(start, dayStart, dayEnd);
    const entry: PlacedInterval = {
      interval,
      // Derived from the same `drawnEnd` the columns were decided against, so
      // the box and the slot it was given can never disagree.
      height: Math.max(MINIMUM_HEIGHT, dayFraction(end, dayStart, dayEnd) - top),
      top,
      column,
      columns: 1,
    };
    cluster.push(entry);
    placed.push(entry);
  }
  closeCluster();

  return placed;
}

/** One recorder's column on the shared clock. */
export type Lane = {
  sourceId: string;
  sourceName: string;
  sourceKind: string;
  /**
   * False once a source has been archived. Its intervals stay on the days they
   * cover, so the lane is still drawn — it is labelled as historical rather
   * than removed (issue #423).
   */
  enabled: boolean;
  intervals: ActivityInterval[];
};

/**
 * Groups a day's intervals into one lane per source that actually recorded
 * something, in a stable order.
 *
 * Source attribution is read off the intervals rather than joined against the
 * source list on the client: an archived source that still has rows on this
 * day has to keep its name here, and the Server already carries it on every
 * interval for exactly that reason.
 */
export function lanesFor(intervals: ActivityInterval[]): Lane[] {
  const lanes = new Map<string, Lane>();
  for (const interval of intervals) {
    const lane = lanes.get(interval.source_id);
    if (lane) {
      lane.intervals.push(interval);
      continue;
    }
    lanes.set(interval.source_id, {
      sourceId: interval.source_id,
      sourceName: interval.source_name,
      sourceKind: interval.source_kind,
      enabled: interval.source_enabled,
      intervals: [interval],
    });
  }
  // Enabled lanes first, then by name, so adding an archived source never
  // pushes the lane someone is actually reading off the side of the screen.
  return [...lanes.values()].sort((a, b) => {
    if (a.enabled !== b.enabled) {
      return a.enabled ? -1 : 1;
    }
    return a.sourceName.localeCompare(b.sourceName);
  });
}

/**
 * The hour marks a day's shared scale is drawn against.
 *
 * Deliberately frame-agnostic: the scale is cut into twenty-four even steps
 * and each one is *labelled* by reading the clock at the instant it falls on,
 * rather than being placed by asking for local hour N. Placing by local hour
 * only works when the window happens to begin at local midnight, and silently
 * collapses every early mark onto the top edge when it does not — which is
 * exactly what the Server's current UTC day boundary would do to a Device
 * several hours off UTC (see `time-page.tsx` and issue #424).
 *
 * On a daylight-saving transition the steps are even while the day is 23 or 25
 * hours long, so a label may repeat or skip an hour. The labels stay truthful
 * about the instants they sit on, which is the property that matters for
 * reading a timeline.
 */
export function hourMarks(dayStart: number, dayEnd: number): { hour: number; top: number }[] {
  const span = dayEnd - dayStart;
  return Array.from({ length: 24 }, (_, step) => ({
    hour: new Date(dayStart + (span * step) / 24).getHours(),
    top: step / 24,
  }));
}

/** `1h 5m`, `5m 30s`, `30s` — the same rendering the single-lane list used. */
export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}
