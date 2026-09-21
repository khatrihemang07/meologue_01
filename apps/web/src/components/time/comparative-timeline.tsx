import type React from "react";
import { lazy, Suspense, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { HistoryScrollContext } from "@/components/shell";
import {
  dayFraction,
  formatDuration,
  type Lane,
  type PlacedInterval,
  placeLane,
} from "@/lib/time-lanes";
import type { ActivityInterval } from "@/lib/time-transport";
import {
  formatClock,
  type GridMark,
  gridMarks,
  MIN_TARGET_PX,
  minimumFraction,
  type ScaleMark,
  scaleMarks,
} from "@/lib/time-zoom";

/**
 * The shared 24-hour clock every source lane is drawn against (issue #420),
 * now zoomable (issue #418) instead of fixed at 120px/hour — see
 * `use-timeline-zoom.ts` for the gestures and `time-zoom.ts` for the pure
 * scale math this component only turns into styles. Issue #430 lands the
 * reader on the day's activity instead of its empty hours: today opens near
 * "now" (with a line across every lane that moves with the clock), and
 * another day opens at its first record — never at a position computed from
 * whatever day's data was still on screen a moment before. Issue #429 makes
 * every record individually clickable: `time-lanes.ts`'s `placeLane` keeps
 * long records at full lane width while short ones layer on top of them
 * instead of narrowing the lane, every block is drawn at least
 * `MIN_TARGET_PX` tall with a hover tooltip, and opening one shows its
 * detail as a popover anchored to the exact point it was clicked
 * (`IntervalBlock` below, `interval-popover.tsx`) rather than at the bottom
 * of the page.
 */

/**
 * Where, within a block, its detail popover should anchor — issue #429.
 * Factored out as a pure function (rather than left inline in
 * `IntervalBlock`'s click handler) for the same reason `time-lanes.ts`'s own
 * header comment gives for keeping lane geometry pure: an exact number is
 * testable, and a click's exact screen position is not, in jsdom.
 *
 * `clientY` truthy means a real pointer position (a mouse or touch click) —
 * anchor to exactly that point. `clientY` falsy (0, the value a
 * keyboard-triggered `click` event carries — Enter/Space on a focused
 * button) means there was no real pointer position to anchor to; the
 * vertical middle of whatever part of the block is actually VISIBLE within
 * Shell's own scroll region is what keeps the popover on screen for a block
 * taller than the viewport (an 8-hour record, easily) instead of anchoring
 * to a point that may be scrolled out of view entirely.
 */
export function clickOffsetWithinBlock({
  clientY,
  blockRect,
  scrollerRect,
}: {
  clientY: number;
  blockRect: { top: number; bottom: number };
  scrollerRect: { top: number; bottom: number } | null;
}): number {
  if (clientY) {
    return clientY - blockRect.top;
  }
  const visibleTop = scrollerRect ? Math.max(blockRect.top, scrollerRect.top) : blockRect.top;
  const visibleBottom = scrollerRect
    ? Math.min(blockRect.bottom, scrollerRect.bottom)
    : blockRect.bottom;
  return (visibleTop + visibleBottom) / 2 - blockRect.top;
}

// Lazy for the bundle budget — see `interval-popover.tsx`'s own header
// comment on why Radix's popover has to stay out of this route's eager
// chunk.
const AnchoredIntervalDetail = lazy(() =>
  import("@/components/time/interval-popover").then((m) => ({
    default: m.AnchoredIntervalDetail,
  })),
);

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
  onOpen: (id: string | null) => void;
  pxPerHour: number;
  timelineRef: React.RefCallback<HTMLDivElement>;
  timelineProps: React.HTMLAttributes<HTMLDivElement> & { tabIndex: number };
}) {
  const scaleHeight = pxPerHour * 24;
  const marks = scaleMarks(dayStart, dayEnd, pxPerHour);
  const grid = gridMarks(dayStart, dayEnd, pxPerHour);
  const minFraction = minimumFraction(pxPerHour);

  // Read ONCE here rather than once per lane (the plain now-line's previous
  // `useNowTick` call inside `LaneColumn`) — issue #431's dot and time label
  // in the gutter (`ScaleGutter`) must sit at the exact same height as every
  // lane's own now-line, and a single shared `nowTop` computed from a single
  // `now` is what makes that true by construction rather than by three
  // separately-ticking hooks landing on the same millisecond by luck.
  const now = useNowTick(isToday);
  const nowTop = now === null ? null : dayFraction(now, dayStart, dayEnd);
  const nowLabel = now === null ? null : formatClock(now);

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
      <ScaleGutter
        marks={marks}
        scaleHeight={scaleHeight}
        scaleRef={scaleRef}
        nowTop={nowTop}
        nowLabel={nowLabel}
      />
      <div className="min-w-0 flex-1 overflow-x-auto" data-testid="time-lane-scroller">
        {/* `relative`: `TimelineGridlines` positions itself with `inset-0`
            against THIS box, not the scroller outside it — sizing against
            the scroller would clip the overlay to whatever is currently
            visible instead of covering the full scrollable width every lane
            actually occupies (issue #431: gridlines must still be there once
            a reader scrolls past the first lane, not just painted into the
            slice on screen at mount). `isolate`: the overlay's `zIndex: -1`
            is only "behind the records" inside a stacking context of its
            own; without one it fell behind the page's own background and
            every line was measured in place yet never painted (seen on the
            device). */}
        <div className="relative isolate flex min-w-max gap-2">
          <TimelineGridlines marks={grid} scaleHeight={scaleHeight} />
          {lanes.map((lane) => (
            <LaneColumn
              key={lane.sourceId}
              lane={lane}
              dayStart={dayStart}
              dayEnd={dayEnd}
              scaleHeight={scaleHeight}
              minFraction={minFraction}
              nowTop={nowTop}
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
/**
 * How close a scale label can sit to the now marker's own time label before
 * the two visually pile on each other — issue #431, an explicit complaint
 * about labels piling up. Roughly a label's own line box (`text-[10px]`
 * with a little breathing room): closer than this and the two strings start
 * to overlap rather than merely sit near one another.
 */
const NOW_LABEL_COLLISION_PX = 14;

function ScaleGutter({
  marks,
  scaleHeight,
  scaleRef,
  nowTop,
  nowLabel,
}: {
  marks: ScaleMark[];
  scaleHeight: number;
  scaleRef: React.RefObject<HTMLDivElement | null>;
  /** Today's current position as a fraction of the day, or `null` off
   * today — the SAME fraction every lane's own now-line reads too
   * (`ComparativeTimeline`'s single `useNowTick` call), so the dot below,
   * the line across every lane, and this gutter's own time label can never
   * draw at a different height from one another. */
  nowTop: number | null;
  /** `formatClock` of that SAME `now` instant, passed rather than
   * re-derived from a fresh `Date.now()` here — a second read could land a
   * tick after the one `nowTop` was computed from, and a marker whose own
   * dot and label disagree on the time is worse than one that ticks a
   * minute slower than the wall clock. `null` exactly when `nowTop` is. */
  nowLabel: string | null;
}) {
  // The now label wins any collision: an ordinary scale label this close to
  // it is dropped rather than the two piling on top of each other. The LINE
  // for that hidden label still exists — see `TimelineGridlines`, which does
  // not read `nowTop` at all — only the text in the gutter is what piles up.
  const visibleMarks =
    nowTop === null
      ? marks
      : marks.filter((mark) => Math.abs(mark.top - nowTop) * scaleHeight >= NOW_LABEL_COLLISION_PX);

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
        {visibleMarks.map((mark) => (
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
        {nowTop !== null && (
          <>
            {/* The dot sits AT the gutter's own right edge — the boundary
                with the lanes — rather than fully inside it, matching
                Toggl Track's Calendar reference: the marker belongs to the
                whole row, not just the time column. */}
            <span
              aria-hidden="true"
              data-time-now-dot=""
              className="pointer-events-none absolute right-0 size-2 -translate-y-1/2 translate-x-1/2 rounded-full bg-destructive"
              style={{ top: `${nowTop * 100}%` }}
            />
            <span
              data-time-now-label=""
              className="-translate-y-1/2 absolute right-1 font-medium text-[10px] text-destructive tabular-nums"
              style={{ top: `${nowTop * 100}%` }}
            >
              {nowLabel}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Horizontal lines across the FULL WIDTH of the lanes area — issue #431,
 * Toggl Track's Calendar reference. One overlay rather than a border on
 * each lane's own `<ol>` (the way the now-line already worked): a per-lane
 * border only ever spans that one lane's own width, and the whole point of
 * a shared clock (this file's own header comment) is that its lines read
 * across every lane at once, including one a reader has scrolled past
 * horizontally — this sits inside the SAME horizontally-scrolling content
 * the lanes do, so it scrolls with them rather than being clipped to
 * whatever is on screen at mount.
 *
 * `pointer-events-none`: decorative only, and MUST NOT ever intercept a
 * click a record underneath needs — the same rule `LaneHeading`'s own
 * comment gives for the identical reason.
 *
 * `zIndex: -1`: painted behind every record. `IntervalBlock`'s own `<li>`
 * sets `zIndex: layer` (0 or 1) to keep a short record on top of a long one
 * it visually sits on; a gridline at the default `z-index: auto` (0 for a
 * flex item) would paint ON TOP of a layer-0 block's own opaque background
 * — a stray line crossing a record — instead of only ever showing in the
 * empty space around one.
 */
function TimelineGridlines({ marks, scaleHeight }: { marks: GridMark[]; scaleHeight: number }) {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ zIndex: -1 }}>
      <LaneHeading hidden>0</LaneHeading>
      <div className="relative" style={{ height: scaleHeight }}>
        {marks.map((mark) => (
          <div
            key={mark.instant}
            data-time-gridline={mark.major ? "major" : "minor"}
            className={`pointer-events-none absolute inset-x-0 border-t ${
              mark.major ? "border-border" : "border-border/40"
            }`}
            style={{ top: `${mark.top * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One heading above a scale. Rendered by every lane and, hidden, by the hour
 * gutter — see `ScaleGutter` for why that has to be the same component rather
 * than a matching height copied into two places.
 *
 * `pointer-events-none`: `sticky` keeps this pinned to the top of Shell's
 * scroll region once a reader scrolls past its natural position, which means
 * it then sits *on top of* whatever scale content is currently there — at
 * high zoom (issue #429) an 8px block can land entirely underneath it. A
 * heading is a passive label with nothing interactive inside, so letting
 * clicks pass straight through to the block underneath costs nothing and is
 * what keeps "every record with data is easily clickable" true at the one
 * scroll position where the heading would otherwise cover one.
 */
function LaneHeading({ children, hidden }: { children: React.ReactNode; hidden?: boolean }) {
  return (
    <h3
      className={`pointer-events-none sticky top-0 z-10 truncate bg-background pb-1 font-medium text-xs ${
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
  nowTop,
  openIntervalId,
  onOpen,
}: {
  lane: Lane;
  dayStart: number;
  dayEnd: number;
  scaleHeight: number;
  minFraction: number;
  /** `null` off today — see `ComparativeTimeline`'s own `useNowTick` call,
   * the single shared fraction every lane's own now-line draws from so it
   * can never disagree with the gutter's now dot and time label. */
  nowTop: number | null;
  openIntervalId: string | null;
  onOpen: (id: string | null) => void;
}) {
  const placed = placeLane(lane.intervals, dayStart, dayEnd, minFraction);

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
            scaleHeight={scaleHeight}
            open={entry.interval.id === openIntervalId}
            onOpen={onOpen}
          />
        ))}
        {nowTop !== null && (
          // The line across every lane — issue #418. The dot and time label
          // in the gutter are issue #431's own addition (`ScaleGutter`);
          // both draw from the identical `nowTop` this component passes
          // down, so neither can ever land at a different height.
          <li
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 border-destructive border-t-2"
            style={{ top: `${nowTop * 100}%` }}
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

/**
 * Below this a block cannot fit even its own label without visibly clipping
 * it — nothing renders instead of a half-cut line; the `title` tooltip and
 * the accessible name below already carry the same facts for anything this
 * small. Room for the clock line underneath only once a block clears twice
 * that.
 */
const LABEL_MIN_PX = 10;
const SECOND_LINE_MIN_PX = 22;

function IntervalBlock({
  placed,
  scaleHeight,
  open,
  onOpen,
}: {
  placed: PlacedInterval;
  scaleHeight: number;
  open: boolean;
  onOpen: (id: string | null) => void;
}) {
  const { interval, top, height, column, columns, layer, topInset } = placed;
  const clock = intervalClock(interval);
  const duration = formatDuration(Date.parse(interval.ended_at) - Date.parse(interval.started_at));
  const blockRef = useRef<HTMLButtonElement | null>(null);
  const { scrollElement } = useContext(HistoryScrollContext);

  // Focus restoration on close, owned HERE rather than by `IntervalPopover`'s
  // `onCloseAutoFocus` — Radix's own default (`context.triggerRef.current?.
  // focus()`) has nothing to restore to: `PopoverAnchor` below is virtual
  // (see the comment on `virtualAnchorRef`), not a real `Popover.Trigger`.
  // This button is rendered unconditionally regardless of `open` — no
  // element-type swap on open/close — so `blockRef.current` is always the
  // right node to hand focus back to the instant `open` flips false.
  const wasOpenRef = useRef(open);
  useLayoutEffect(() => {
    if (wasOpenRef.current && !open) {
      blockRef.current?.focus({ preventScroll: true });
    }
    wasOpenRef.current = open;
  }, [open]);

  // Overlapping records share the lane's width side by side rather than
  // stacking, so neither disappears behind the other.
  const width = 100 / columns;

  // px, not a CSS `%`, and an explicit floor at `MIN_TARGET_PX` — not
  // because the fraction math (`time-lanes.ts`'s `placeLane`) is wrong, but
  // because a percentage-of-container height is not exact once a real
  // browser lays it out: measured 7.992px rendered for an 8px floor. A
  // record whose click target can round UNDER the floor defeats the whole
  // reason the floor exists. `topPx` is expressed in the same unit for the
  // same reason `time-lanes.ts`'s own comment on `drawnEnd` gives elsewhere
  // — one unit throughout is what keeps a box and the slot it was given
  // from ever being able to disagree.
  const topPx = top * scaleHeight;
  const heightPx = Math.max(MIN_TARGET_PX, height * scaleHeight);
  // The label starts below any short records drawn over this block's top
  // (`PlacedInterval.topInset`), and only the room left under them counts
  // towards whether a line fits.
  const insetPx = Math.min(heightPx, topInset * scaleHeight);
  const textRoomPx = heightPx - insetPx;

  // Issue #429: the popover anchors to the CLICK POINT within the block, not
  // the whole block — a block taller than the viewport (an 8-hour record,
  // easily) otherwise anchors Radix's own positioning at the block's own top
  // or centre, which can render the popover off-screen entirely (measured:
  // dialog top 828 in a 696px viewport). `clickOffsetRef` is the click's
  // distance from the block's own top, captured once per open;
  // `virtualAnchorRef` re-reads the block's LIVE rect every time Radix asks
  // for it (a `Measurable`, not a DOM node — see `PopoverAnchor`'s own
  // `virtualRef` prop in `interval-popover.tsx`), which is what keeps the
  // popover attached to the same point in the record while the page scrolls.
  const clickOffsetRef = useRef(0);
  const virtualAnchorRef = useRef<{ getBoundingClientRect: () => DOMRect }>({
    getBoundingClientRect: () => {
      const rect = blockRef.current?.getBoundingClientRect();
      if (!rect) {
        return new DOMRect();
      }
      return new DOMRect(rect.left, rect.top + clickOffsetRef.current, rect.width, 0);
    },
  });

  const handleActivate = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (open) {
      onOpen(null);
      return;
    }
    const rect = blockRef.current?.getBoundingClientRect();
    clickOffsetRef.current = rect
      ? clickOffsetWithinBlock({
          clientY: event.clientY,
          blockRect: rect,
          scrollerRect: scrollElement?.getBoundingClientRect() ?? null,
        })
      : 0;
    onOpen(interval.id);
  };

  return (
    <li
      className="absolute"
      style={{
        top: `${topPx}px`,
        height: `${heightPx}px`,
        left: `${column * width}%`,
        width: `${width}%`,
        // A short record (layer 1) is drawn on top of any long record
        // (layer 0) it visually sits on rather than the two being
        // clustered together and narrowing the long block — see
        // `time-lanes.ts`'s own comment on `PlacedInterval.layer`.
        zIndex: layer,
      }}
    >
      <button
        ref={blockRef}
        type="button"
        onClick={handleActivate}
        aria-expanded={open}
        // The accessible name — and the `title` tooltip below — carry what a
        // block this small (as little as `MIN_TARGET_PX` at high zoom)
        // cannot show in its own text.
        aria-label={`${interval.label}, ${clock}, ${duration}${interval.idle ? ", idle" : ""}`}
        title={`${interval.label}\n${clock} · ${duration}`}
        // No vertical padding, and `leading-none` rather than
        // `leading-tight`: with `py-0.5` and a 10px line's default line
        // height this button measured ~18px tall inside an 8px `<li>`, so a
        // "short" block's real click target reached into its neighbours no
        // matter how tightly `time-lanes.ts` had packed them. `min-h-0` is
        // what actually lets `h-full` win — a flex column's items default to
        // a content-driven minimum height, which `size-full` alone did not
        // override.
        className={`flex h-full min-h-0 w-full cursor-pointer flex-col overflow-hidden rounded border px-1 text-left text-[10px] leading-none transition-colors hover:border-foreground/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring ${
          open ? "border-foreground bg-muted" : "border-border bg-background"
        } ${interval.idle ? "border-dashed text-muted-foreground" : ""}`}
        style={insetPx > 0 ? { paddingTop: insetPx } : undefined}
      >
        {/* Only a block with room for it gets a label, and only one with room
            for both lines gets the clock underneath — a clipped half line is
            worse than none, and the tooltip/accessible name above already
            carry the same facts for anything smaller. */}
        {textRoomPx >= LABEL_MIN_PX && (
          <span className="block truncate font-medium">{interval.label}</span>
        )}
        {textRoomPx >= SECOND_LINE_MIN_PX && (
          <span className="block truncate text-muted-foreground tabular-nums">{clock}</span>
        )}
      </button>
      {open && (
        // Only the open block ever mounts a Popover — one per block would
        // mean hundreds on a dense day, almost all of them permanently
        // closed. `fallback={null}`, not the button again: the button above
        // is rendered unconditionally, not swapped out while the popover's
        // chunk loads, so there is nothing left for a fallback to stand in
        // for.
        <Suspense fallback={null}>
          <AnchoredIntervalDetail
            id={interval.id}
            virtualRef={virtualAnchorRef}
            onClose={() => onOpen(null)}
          />
        </Suspense>
      )}
    </li>
  );
}

function intervalClock(interval: ActivityInterval): string {
  const formatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  return `${formatter.format(new Date(interval.started_at))}–${formatter.format(
    new Date(interval.ended_at),
  )}`;
}
