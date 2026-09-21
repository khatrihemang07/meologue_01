import type React from "react";
import { useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { HistoryScrollContext } from "@/components/shell";
import {
  dayFraction,
  formatDuration,
  type Lane,
  MINIMUM_INTERVAL_FRACTION,
  type PlacedInterval,
  placeLane,
} from "@/lib/time-lanes";
import type { ActivityInterval } from "@/lib/time-transport";
import { minimumFraction, type ScaleMark, scaleMarks } from "@/lib/time-zoom";

/**
 * The shared 24-hour clock every source lane is drawn against (issue #420),
 * now zoomable (issue #418) instead of fixed at 120px/hour — see
 * `use-timeline-zoom.ts` for the gestures and `time-zoom.ts` for the pure
 * scale math this component only turns into styles. Issue #430 lands the
 * reader on the day's activity instead of its empty hours: today opens near
 * "now" (with a line across every lane that moves with the clock), and
 * another day opens at its first record — never at a position computed from
 * whatever day's data was still on screen a moment before.
 */

/** How far below the anchored instant the scroll lands, so it isn't pinned to the very top edge of the scroll region. */
const TOP_SCROLL_MARGIN_PX = 60;

/**
 * Where "now" sits in the view when today opens, as a fraction of its height.
 * Pinned near the top, the screen below it was nothing but empty future and
 * the hours that had just happened — what a reader opens today to see — were
 * scrolled away above it (seen on the device). Low in the view puts them on
 * screen, the way Toggl Track's own Calendar opens.
 */
const NOW_VIEW_FRACTION = 0.7;

export function ComparativeTimeline({
  lanes,
  dayStart,
  dayEnd,
  isToday,
  dataReady,
  openIntervalId,
  onOpen,
  pxPerHour,
  timelineRef,
  timelineProps,
}: {
  lanes: Lane[];
  dayStart: number;
  dayEnd: number;
  isToday: boolean;
  /**
   * False while the intervals query is showing a PLACEHOLDER — the previous
   * day's real data, stood in (`time-page.tsx`'s `placeholderData: (previous)
   * => previous`) while the new day's own request is still in flight. The
   * scroll-anchoring effect below must not fire against it: `lanes` is never
   * empty the instant `dayStart` changes — it is still the OLD day's real
   * records — so nothing about `lanes` on its own can tell the two apart;
   * only the query itself knows the records on screen right now belong to
   * yesterday's request, not today's. Without this gate, "Previous day" sent
   * the reader to ~23:00 — today's still-displayed 10:00 record mapped onto
   * the new day's scale — instead of the new day's own first record.
   */
  dataReady: boolean;
  openIntervalId: string | null;
  onOpen: (id: string) => void;
  pxPerHour: number;
  timelineRef: React.RefCallback<HTMLDivElement>;
  timelineProps: React.HTMLAttributes<HTMLDivElement> & { tabIndex: number };
}) {
  const scaleHeight = pxPerHour * 24;
  const marks = scaleMarks(dayStart, dayEnd, pxPerHour);
  const minFraction = minimumFraction(pxPerHour);

  const { scrollElement } = useContext(HistoryScrollContext);
  const scaleRef = useRef<HTMLDivElement | null>(null);

  // Runs once a day's REAL data (`dataReady`) is on screen, and again
  // whenever `dayStart` changes — never more than once per day, tracked by
  // `anchoredDayRef`. That ref, not just `dataReady` in the dependency list,
  // is what keeps a later REFETCH of the same day (Refresh now invalidating
  // this query, a background revalidation) from re-triggering this:
  // `dataReady` does not flip back to `false` for a refetch of an
  // already-fresh day (no placeholder phase happens for that), but `lanes`
  // still gets a new array identity every time, and this effect must not
  // fight a reader who has already scrolled to look at something on the day
  // they are already on.
  const anchoredDayRef = useRef<number | null>(null);
  // Deliberately NOT keyed on `lanes`/`isToday`/`scaleHeight`: `lanes` gets a
  // new identity on every refetch even when nothing about the DAY changed
  // (see `dataReady`'s own comment above), and a zoom gesture has its own
  // anchoring (`use-timeline-zoom.ts`) that this must not fight either.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see the comment above.
  useLayoutEffect(() => {
    if (!scrollElement || !scaleRef.current || !dataReady || anchoredDayRef.current === dayStart) {
      return;
    }
    anchoredDayRef.current = dayStart;
    const earliestStart = Math.min(
      ...lanes.flatMap((lane) => lane.intervals.map((interval) => Date.parse(interval.started_at))),
    );
    const now = Date.now();
    // For today, "now" wins once activity has actually been happening —
    // showing the first record from hours ago would bury the reason anyone
    // opens today's Time in the first place: what is happening right now. A
    // past day has no "now" of its own, so it always anchors on its first
    // record.
    const target = isToday && now > earliestStart ? now : earliestStart;
    const fraction = dayFraction(target, dayStart, dayEnd);
    // Measures the SCALE itself (`data-time-scale`, rendered by `ScaleGutter`
    // below), not this component's own wrapper — the wrapper sits above
    // whatever the page put ahead of the timeline (`DayNavigator`, search,
    // the lane picker), which is real height a target computed from
    // `fraction * scaleHeight` alone would ignore. Same technique
    // `use-timeline-zoom.ts` uses for its own anchor, and the same reason: a
    // fixed offset above the thing being measured throws off any position
    // computed as though it started at the scroll region's own top.
    const scrollerRect = scrollElement.getBoundingClientRect();
    const scaleRect = scaleRef.current.getBoundingClientRect();
    const scaleTop = scaleRect.top - scrollerRect.top + scrollElement.scrollTop;
    const offset =
      target === now
        ? Math.max(TOP_SCROLL_MARGIN_PX, scrollElement.clientHeight * NOW_VIEW_FRACTION)
        : TOP_SCROLL_MARGIN_PX;
    scrollElement.scrollTop = Math.max(0, scaleTop + fraction * scaleHeight - offset);
  }, [dayStart, scrollElement, dataReady]);

  return (
    // Horizontal scrolling rather than a narrower lane or a collapse into a
    // feed: alignment against the shared clock is the whole comparison, and a
    // phone that cannot fit three lanes should scroll past them with the hour
    // gutter still on screen, not lose the alignment that makes them readable.
    //
    // The gutter sits OUTSIDE the scroller rather than sticking to its left
    // edge from within it. Both keep the clock on screen, but a sticky gutter
    // inside the scroller is painted over the lanes that scroll under it —
    // measured on the device, the leftmost lane lost about 50px of its 192 to
    // the gutter at full scroll. Beside the scroller it costs the same width
    // and hides nothing.
    //
    // `ref`/`{...timelineProps}`: `use-timeline-zoom.ts` needs this element
    // both to attach its ctrl/⌘+wheel listener to and to measure for its
    // scroll-anchoring math — see that hook's own header comment.
    <div ref={timelineRef} {...timelineProps} className="-mx-4 flex gap-2 px-4 outline-none">
      <ScaleGutter marks={marks} scaleHeight={scaleHeight} scaleRef={scaleRef} />
      <div className="min-w-0 flex-1 overflow-x-auto" data-testid="time-lane-scroller">
        <div className="flex min-w-max gap-2">
          {lanes.map((lane) => (
            <LaneColumn
              key={lane.sourceId}
              lane={lane}
              dayStart={dayStart}
              dayEnd={dayEnd}
              scaleHeight={scaleHeight}
              minFraction={minFraction}
              isToday={isToday}
              openIntervalId={openIntervalId}
              onOpen={onOpen}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * The shared clock, and the heading-shaped spacer that keeps it aligned.
 *
 * The spacer is not decoration. Each lane draws a heading above its scale, so
 * a gutter that simply started at the top of the row sat exactly one heading
 * higher than the scale it labels — measured on the device, every hour mark
 * was 20px out, with hour 01 drawn at y=328 where the scale put it at 348.
 * That is a silent lie in the one thing this view exists to do.
 *
 * Both sides therefore render the *same* `LaneHeading` component, so the two
 * boxes cannot drift apart: one shows a lane's name, the other is hidden with
 * `invisible`, which reserves the identical box.
 */
function ScaleGutter({
  marks,
  scaleHeight,
  scaleRef,
}: {
  marks: ScaleMark[];
  scaleHeight: number;
  scaleRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div aria-hidden="true" className="w-12 shrink-0">
      <LaneHeading hidden>0</LaneHeading>
      {/* `data-time-scale`: both `use-timeline-zoom.ts`'s anchor-drift fix and
          this component's own day-anchor effect (issue #430) read THIS
          element's position, not the timeline wrapper's — the wrapper also
          contains the `LaneHeading` above, which sits one heading's height
          higher than where the scale (and so every record) actually starts.
          `style={{ height: scaleHeight }}`: without an explicit height this
          div has none at all (it holds only absolutely-positioned `<span>`
          marks, which do not contribute to their parent's own height), so
          every mark's `top: N%` resolved against a ZERO-height container —
          measured: all 48 default-zoom labels landed within 1px of each
          other, at the top of the gutter. */}
      <div ref={scaleRef} className="relative" data-time-scale="" style={{ height: scaleHeight }}>
        {marks.map((mark) => (
          <span
            key={mark.instant}
            className={`-translate-y-1/2 absolute right-1 tabular-nums ${
              mark.major
                ? "text-[10px] text-muted-foreground"
                : "text-[9px] text-muted-foreground/70"
            }`}
            style={{ top: `${mark.top * 100}%` }}
          >
            {mark.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * One heading above a scale. Rendered by every lane and, hidden, by the hour
 * gutter — see `ScaleGutter` for why that has to be the same component rather
 * than a matching height copied into two places.
 */
function LaneHeading({ children, hidden }: { children: React.ReactNode; hidden?: boolean }) {
  return (
    <h3
      className={`sticky top-0 z-10 truncate bg-background pb-1 font-medium text-xs ${
        hidden ? "invisible" : ""
      }`}
    >
      {children}
    </h3>
  );
}

function LaneColumn({
  lane,
  dayStart,
  dayEnd,
  scaleHeight,
  minFraction,
  isToday,
  openIntervalId,
  onOpen,
}: {
  lane: Lane;
  dayStart: number;
  dayEnd: number;
  scaleHeight: number;
  minFraction: number;
  isToday: boolean;
  openIntervalId: string | null;
  onOpen: (id: string) => void;
}) {
  const placed = placeLane(lane.intervals, dayStart, dayEnd, minFraction);
  const now = useNowTick(isToday);

  return (
    <section
      aria-label={`${lane.sourceName} lane`}
      className="w-48 shrink-0 sm:w-56"
      data-source-kind={lane.sourceKind}
      data-source-enabled={lane.enabled}
    >
      <LaneHeading>
        {lane.sourceName}
        {!lane.enabled && (
          <span className="ml-1 font-normal text-muted-foreground">(archived)</span>
        )}
      </LaneHeading>
      <ol
        aria-label={`${lane.sourceName} activity`}
        className="relative rounded-md border border-border bg-muted/30"
        style={{ height: scaleHeight }}
      >
        {placed.map((entry) => (
          <IntervalBlock
            key={entry.interval.id}
            placed={entry}
            open={entry.interval.id === openIntervalId}
            onOpen={onOpen}
          />
        ))}
        {isToday && now !== null && (
          // A plain line for now, every lane crossed the same way — the dot
          // plus time label is #431.
          <li
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 border-destructive border-t-2"
            style={{ top: `${dayFraction(now, dayStart, dayEnd) * 100}%` }}
          />
        )}
      </ol>
    </section>
  );
}

/**
 * Ticks once a minute so the "now" line actually moves while a day stays
 * open. `null` off today, so callers never have to special-case rendering
 * it.
 */
function useNowTick(enabled: boolean): number | null {
  const [now, setNow] = useState<number | null>(enabled ? Date.now() : null);
  useEffect(() => {
    if (!enabled) {
      setNow(null);
      return;
    }
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [enabled]);
  return now;
}

function IntervalBlock({
  placed,
  open,
  onOpen,
}: {
  placed: PlacedInterval;
  open: boolean;
  onOpen: (id: string) => void;
}) {
  const { interval, top, height, column, columns } = placed;
  const clock = intervalClock(interval);
  const duration = formatDuration(Date.parse(interval.ended_at) - Date.parse(interval.started_at));

  // Overlapping records share the lane's width side by side rather than
  // stacking, so neither disappears behind the other.
  const width = 100 / columns;

  return (
    <li
      className="absolute"
      style={{
        top: `${top * 100}%`,
        height: `${height * 100}%`,
        left: `${column * width}%`,
        width: `${width}%`,
      }}
    >
      <button
        type="button"
        onClick={() => onOpen(interval.id)}
        aria-expanded={open}
        // The accessible name carries what the block is too small to show.
        aria-label={`${interval.label}, ${clock}, ${duration}${interval.idle ? ", idle" : ""}`}
        className={`size-full overflow-hidden rounded border px-1 py-0.5 text-left text-[10px] leading-tight ${
          open ? "border-foreground bg-muted" : "border-border bg-background"
        } ${interval.idle ? "border-dashed text-muted-foreground" : ""}`}
      >
        <span className="block truncate font-medium">{interval.label}</span>
        {/* Only tall enough blocks get a second line; a short record would
            otherwise clip its own label away to show a time nobody can read. */}
        {height > MINIMUM_INTERVAL_FRACTION * 4 && (
          <span className="block truncate text-muted-foreground tabular-nums">{clock}</span>
        )}
      </button>
    </li>
  );
}

function intervalClock(interval: ActivityInterval): string {
  const formatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  return `${formatter.format(new Date(interval.started_at))}–${formatter.format(
    new Date(interval.ended_at),
  )}`;
}
