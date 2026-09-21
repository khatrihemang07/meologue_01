import {
  formatDuration,
  hourMarks,
  type Lane,
  MINIMUM_INTERVAL_FRACTION,
  type PlacedInterval,
  placeLane,
} from "@/lib/time-lanes";
import type { ActivityInterval } from "@/lib/time-transport";

/** 120px an hour. See `MINIMUM_INTERVAL_FRACTION` for why this number. */
const HOUR_HEIGHT = 120;
const SCALE_HEIGHT = HOUR_HEIGHT * 24;

/** The shared 24-hour clock every source lane is drawn against (issue #420). */
export function ComparativeTimeline({
  lanes,
  dayStart,
  dayEnd,
  openIntervalId,
  onOpen,
}: {
  lanes: Lane[];
  dayStart: number;
  dayEnd: number;
  openIntervalId: string | null;
  onOpen: (id: string) => void;
}) {
  const marks = hourMarks(dayStart, dayEnd);

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
    <div className="-mx-4 flex gap-2 px-4">
      <HourGutter marks={marks} />
      <div className="min-w-0 flex-1 overflow-x-auto" data-testid="time-lane-scroller">
        <div className="flex min-w-max gap-2">
          {lanes.map((lane) => (
            <LaneColumn
              key={lane.sourceId}
              lane={lane}
              dayStart={dayStart}
              dayEnd={dayEnd}
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
function HourGutter({ marks }: { marks: { hour: number; top: number }[] }) {
  return (
    <div aria-hidden="true" className="w-10 shrink-0">
      <LaneHeading hidden>0</LaneHeading>
      <div className="relative" style={{ height: SCALE_HEIGHT }}>
        {marks.map((mark) => (
          <span
            key={mark.top}
            className="-translate-y-1/2 absolute right-1 text-[10px] text-muted-foreground tabular-nums"
            style={{ top: `${mark.top * 100}%` }}
          >
            {String(mark.hour).padStart(2, "0")}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * One heading above a scale. Rendered by every lane and, hidden, by the hour
 * gutter — see `HourGutter` for why that has to be the same component rather
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
  openIntervalId,
  onOpen,
}: {
  lane: Lane;
  dayStart: number;
  dayEnd: number;
  openIntervalId: string | null;
  onOpen: (id: string) => void;
}) {
  const placed = placeLane(lane.intervals, dayStart, dayEnd);

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
        style={{ height: SCALE_HEIGHT }}
      >
        {placed.map((entry) => (
          <IntervalBlock
            key={entry.interval.id}
            placed={entry}
            open={entry.interval.id === openIntervalId}
            onOpen={onOpen}
          />
        ))}
      </ol>
    </section>
  );
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
