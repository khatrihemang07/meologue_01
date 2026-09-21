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
  /**
   * 0 for a record long enough to draw at its true height, 1 for one
   * inflated up to the minimum. Layer 1 is meant to be drawn ON TOP of layer
   * 0 (`comparative-timeline.tsx` does this with `z-index`) — see
   * `placeLane`'s own comment on why long and short records are clustered
   * separately, which is what makes a short record something that can
   * safely sit "on top of" a long one instead of narrowing it.
   */
  layer: 0 | 1;
  /**
   * How much of this record's top, as a fraction of the day, is covered by
   * short records drawn over it — always 0 for a short record. The block
   * starts its label below this, or the label is struck through by the
   * short record just before it (seen on macOS at 10:23).
   */
  topInset: number;
};

/**
 * The default smallest height an interval is drawn at, as a fraction of a
 * day, when a caller does not pass one of its own.
 *
 * Three minutes at the scale `time-page.tsx` used to render at unconditionally
 * (120px per hour, 6px). Issue #418 made the scale zoomable, which means the
 * true "smallest target still worth having" now depends on the current zoom
 * level rather than being fixed — `lib/time-zoom.ts`'s `minimumFraction`
 * computes it from `MIN_TARGET_PX` and the live px-per-hour, and the page
 * passes that in. This constant only has to cover the callers (and this
 * file's own default-argument tests) that have no zoom level to ask.
 */
export const MINIMUM_INTERVAL_FRACTION = 1 / (24 * 20);

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
 *
 * **Long and short records are clustered separately** (issue #429's "lane
 * columns chain across the whole day" fix — the worst of that issue's device
 * pass: every record in a real Toggl lane, four-hour blocks included, was
 * drawn at 1/6 width). A record below `minimumHeight` is drawn taller than
 * its true span (see `minimumSpan` below), which means two records that do
 * NOT overlap on the clock can still overlap *on screen*. Clustering
 * everything together in one pass used that DRAWN extent for every record's
 * own clustering too, so a single short record's inflated box reaching into
 * the next long record's start falsely overlapped it, and because
 * clustering is transitive, that one false overlap chained the entire day
 * into one narrow cluster. Long records now cluster by their TRUE extent
 * only, short records cluster among themselves by their DRAWN extent, and a
 * short record is drawn on `layer: 1` — above any long record it visually
 * sits on — so it stays individually clickable without ever narrowing the
 * long block underneath it.
 */
export function placeLane(
  intervals: ActivityInterval[],
  dayStart: number,
  dayEnd: number,
  // Issue #418: the caller's current zoom level decides this now, via
  // `lib/time-zoom.ts`'s `minimumFraction`. Defaulted rather than required so
  // every test above that predates zoom keeps asserting the same fixed
  // number it always did.
  minimumHeight: number = MINIMUM_INTERVAL_FRACTION,
): PlacedInterval[] {
  // How long a record has to run before it is drawn at its true height. Below
  // this it is drawn at `minimumHeight` instead, which means two records that
  // do NOT overlap in time can still overlap *on screen* — and the columns
  // have to be decided against what is drawn, not against the clock. Measured
  // on a real day this is not an edge case: a run of twenty-second records
  // around 21:15 sat 1.2px apart at 6px tall, so every one of them covered the
  // one before it while the clock said none of them overlapped at all.
  const minimumSpan = minimumHeight * (dayEnd - dayStart);
  const SHORT_SPAN_FACTOR = 3;
  const inflatedEnd = (start: number, end: number) => Math.max(end, start + minimumSpan);

  type Span = {
    interval: ActivityInterval;
    start: number;
    /** Always the record's true, un-inflated end — what long-record clustering and this record's own `short` classification are both decided against. */
    trueEnd: number;
    /** What the record is actually DRAWN to — identical to `trueEnd` once a record is long enough not to need inflating. Used for height/top and for short-record clustering. */
    drawnEnd: number;
    short: boolean;
  };

  const spans: Span[] = intervals.map((interval) => {
    const start = Date.parse(interval.started_at);
    const trueEnd = Date.parse(interval.ended_at);
    return {
      interval,
      start,
      trueEnd,
      drawnEnd: inflatedEnd(start, trueEnd),
      // Three minimum heights, not one: a record only just past the minimum
      // is still drawn barely taller than a short neighbour inflated over
      // its top, and on the lower layer it was all but covered — measured on
      // a real day, a 4m42s record kept ~1px clickable under a 53s one. Laid
      // out with the short records it gets a column of its own instead.
      short: trueEnd - start < SHORT_SPAN_FACTOR * minimumSpan,
    };
  });

  const longColumns = assignColumns(
    spans.filter((span) => !span.short),
    (span) => span.trueEnd,
  );
  const shortSpans = spans.filter((span) => span.short);
  const shortColumns = assignColumns(shortSpans, (span) => span.drawnEnd);

  const placed: PlacedInterval[] = spans.map((span) => {
    const slot = (span.short ? shortColumns : longColumns).get(span);
    const rawTop = dayFraction(span.start, dayStart, dayEnd);
    // Derived from the same `drawnEnd` every record's slot was decided
    // against (within its own long/short group), so the box and the slot it
    // was given can never disagree.
    const height = Math.max(minimumHeight, dayFraction(span.drawnEnd, dayStart, dayEnd) - rawTop);
    // A block drawn at the minimum height can still spill past the bottom
    // of the scale when its true start sits near the very end of the day —
    // measured: a 23:57, 15-second record was drawn at the 8px minimum
    // starting at 99.84%, past 100%, which is what gave the lane scroller
    // 20px of vertical overflow and a stray scrollbar. Moved up rather than
    // shrunk, so it keeps its minimum size while staying inside [0, 1].
    const top = Math.max(0, Math.min(rawTop, 1 - height));
    return {
      interval: span.interval,
      top,
      height,
      column: slot?.column ?? 0,
      columns: slot?.columns ?? 1,
      layer: span.short ? 1 : 0,
      topInset: span.short ? 0 : coveredTop(span, shortSpans, dayStart, dayEnd, height),
    };
  });

  // The two passes above each walk their own long/short subset in start
  // order; interleaving them back together needs its own sort, restoring the
  // single "start instant, then end instant" order the whole lane used to be
  // walked in.
  return placed.sort((a, b) => {
    const byStart = Date.parse(a.interval.started_at) - Date.parse(b.interval.started_at);
    return byStart !== 0
      ? byStart
      : Date.parse(a.interval.ended_at) - Date.parse(b.interval.ended_at);
  });
}

/**
 * How far down a long record's top the short records drawn over it reach:
 * only those drawn across its start count, since one sitting further down
 * does not touch the label. Capped at the record's own height.
 */
function coveredTop(
  long: { start: number },
  shorts: { start: number; drawnEnd: number }[],
  dayStart: number,
  dayEnd: number,
  height: number,
): number {
  let reach = long.start;
  for (const short of shorts) {
    if (short.start <= long.start && short.drawnEnd > reach) {
      reach = short.drawnEnd;
    }
  }
  return Math.min(height, (reach - long.start) / (dayEnd - dayStart));
}

/**
 * The column-assignment half of `placeLane`, factored out so it can run
 * independently over the long and short subsets — see `placeLane`'s own
 * comment for why running it once over everything is the bug this split
 * fixes. `clusterEndOf` is what decides overlap: the caller's true end for
 * long records, the caller's drawn (inflated) end for short ones.
 */
function assignColumns<T extends { start: number }>(
  items: T[],
  clusterEndOf: (item: T) => number,
): Map<T, { column: number; columns: number }> {
  const sorted = [...items].sort((a, b) => {
    const byStart = a.start - b.start;
    return byStart !== 0 ? byStart : clusterEndOf(a) - clusterEndOf(b);
  });

  const result = new Map<T, { column: number; columns: number }>();
  // Items in the cluster being built, and when each column frees up.
  let cluster: T[] = [];
  let columnEnds: number[] = [];

  const closeCluster = () => {
    const columns = columnEnds.length;
    for (const item of cluster) {
      const slot = result.get(item);
      if (slot) {
        slot.columns = columns;
      }
    }
    cluster = [];
    columnEnds = [];
  };

  for (const item of sorted) {
    const start = item.start;
    const end = clusterEndOf(item);

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

    result.set(item, { column, columns: 1 });
    cluster.push(item);
  }
  closeCluster();

  return result;
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
