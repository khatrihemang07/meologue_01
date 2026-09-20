import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { useState } from "react";
import { Link } from "react-router";
import { BackToChats } from "@/components/back-to-chats";
import { ServerUnreachableBanner } from "@/components/server-unreachable-banner";
import { Shell } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { activityIntervalsQueryKey, TIME_SOURCES_QUERY_KEY } from "@/lib/query-keys";
import { refreshCapabilities, useCapabilities, useSyncEnabled } from "@/lib/settings";
import {
  formatDuration,
  hourMarks,
  type Lane,
  lanesFor,
  MINIMUM_INTERVAL_FRACTION,
  placeLane,
} from "@/lib/time-lanes";
import {
  type ActivityInterval,
  listActivityIntervals,
  listTimeSources,
} from "@/lib/time-transport";

/**
 * The Server-backed Time Destination.
 *
 * Since issue #420 this is a *comparison*, not a feed: every selected
 * recorder gets its own lane against one shared 24-hour clock, because the
 * question Time exists to answer is what one recorder saw while another saw
 * something else. Collapsing the lanes back into a single chronological list
 * would answer a different, easier question.
 */
export function TimePage() {
  const syncEnabled = useSyncEnabled();
  const capabilities = useCapabilities();
  const timeSupported = capabilities?.time === true;

  return (
    <Shell title="Time" back={<BackToChats />}>
      {!syncEnabled ? (
        <p className="text-center text-sm text-muted-foreground">
          Sync is off —{" "}
          <Link to="/settings" className="underline underline-offset-2 hover:text-foreground">
            add a Server URL
          </Link>{" "}
          to see your Time.
        </p>
      ) : !timeSupported ? (
        <p className="text-center text-sm text-muted-foreground">
          This Server doesn't support Time yet.
        </p>
      ) : (
        <TimeContent />
      )}
    </Shell>
  );
}

/**
 * Kept below the capability gate so Time never probes an older Server just
 * because a Device visited `/time`.
 */
function TimeContent() {
  const sourcesQuery = useQuery({ queryKey: TIME_SOURCES_QUERY_KEY, queryFn: listTimeSources });

  if (sourcesQuery.data?.ok === false) {
    return (
      <ServerUnreachableBanner
        message="Time sources couldn't be loaded right now."
        onRetry={() => {
          void refreshCapabilities();
          void sourcesQuery.refetch();
        }}
      />
    );
  }

  if (sourcesQuery.isPending) {
    return <p className="text-center text-sm text-muted-foreground">Loading Time sources…</p>;
  }

  const enabled = sourcesQuery.data?.ok
    ? sourcesQuery.data.sources.filter((source) => source.enabled)
    : [];
  if (enabled.length === 0) {
    return (
      <p className="text-center text-sm text-muted-foreground">
        No Time sources are enabled yet. Configure one in{" "}
        <Link to="/settings" className="underline underline-offset-2 hover:text-foreground">
          Server Settings
        </Link>
        .
      </p>
    );
  }

  return <DailyComparison />;
}

function DailyComparison() {
  // This Device's own local date, sent as a floating YYYY-MM-DD. The Server
  // currently resolves it against UTC, not against its configured
  // `MEOLOGUE_TZ` — measured on a seeded Server in Asia/Kolkata, where the
  // same calendar date selects 104 Activity intervals as a UTC day and 70 as
  // a Server-timezone day. Issue #424 owns moving the boundary to the
  // Server's timezone along with date navigation; until then "Today" means
  // the UTC day, which is why nothing here claims otherwise on screen.
  const today = new Date();
  const day = format(today, "yyyy-MM-dd");
  const intervalsQuery = useQuery({
    queryKey: activityIntervalsQueryKey(day),
    queryFn: () => listActivityIntervals(day),
  });

  // Which lanes the reader has switched off, by source id. Hidden rather than
  // visible so a source that starts recording later shows up on its own
  // instead of having to be discovered and switched on.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());

  if (intervalsQuery.data?.ok === false) {
    return (
      <ServerUnreachableBanner
        message="Today's activity couldn't be loaded right now."
        onRetry={() => {
          void refreshCapabilities();
          void intervalsQuery.refetch();
        }}
      />
    );
  }

  if (intervalsQuery.isPending) {
    return (
      <p className="text-center text-sm text-muted-foreground">Loading today&apos;s activity…</p>
    );
  }

  const intervals = intervalsQuery.data?.ok ? intervalsQuery.data.intervals : [];
  const lanes = lanesFor(intervals);
  const visible = lanes.filter((lane) => !hidden.has(lane.sourceId));

  // The scale runs from this Device's local midnight to the next, which is
  // what "today" means to the person reading it. Records the Server included
  // that fall outside that window are clamped to the edges by `dayFraction`
  // rather than drawn off the scale.
  const dayStart = new Date(today);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  return (
    <section aria-labelledby="time-today-heading" className="flex min-h-0 flex-col gap-3">
      <div>
        <h2 id="time-today-heading" className="font-semibold text-sm">
          Today
        </h2>
        <p className="text-muted-foreground text-xs">
          {lanes.length === 0
            ? "No activity was recorded today."
            : `${intervals.length} record${intervals.length === 1 ? "" : "s"} across ${
                lanes.length
              } source${lanes.length === 1 ? "" : "s"}`}
        </p>
      </div>

      {lanes.length > 1 && <LanePicker lanes={lanes} hidden={hidden} onChange={setHidden} />}

      {lanes.length === 0 ? null : visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Every source lane is hidden. Switch one back on to compare them.
        </p>
      ) : (
        <ComparativeTimeline
          lanes={visible}
          dayStart={dayStart.getTime()}
          dayEnd={dayEnd.getTime()}
        />
      )}
    </section>
  );
}

/**
 * One independent on/off fact per lane, rendered as a real `role="switch"`
 * with `aria-checked` for the same reason `switch-row.tsx` gives: a lane is
 * simply shown or not, with no sibling option it is being chosen over. These
 * are compact chips rather than that component's full-width rows because a
 * comparison wants its lanes named side by side, above the thing they label.
 */
function LanePicker({
  lanes,
  hidden,
  onChange,
}: {
  lanes: Lane[];
  hidden: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
}) {
  return (
    // A real `<fieldset>`/`<legend>` rather than a div carrying `role="group"`:
    // the switches inside it are independent on/off facts that only make sense
    // under a shared label, which is exactly what a fieldset is for.
    <fieldset className="flex flex-wrap items-center gap-2 border-0 p-0">
      <legend className="sr-only">Source lanes</legend>
      <span aria-hidden="true" className="text-muted-foreground text-xs">
        Lanes
      </span>
      {lanes.map((lane) => {
        const shown = !hidden.has(lane.sourceId);
        return (
          <Button
            key={lane.sourceId}
            type="button"
            size="touch"
            variant={shown ? "default" : "outline"}
            role="switch"
            aria-checked={shown}
            aria-label={`${lane.sourceName} lane`}
            onClick={() => {
              const next = new Set(hidden);
              if (shown) {
                next.add(lane.sourceId);
              } else {
                next.delete(lane.sourceId);
              }
              onChange(next);
            }}
          >
            {lane.sourceName}
            {!lane.enabled && " (archived)"}
          </Button>
        );
      })}
    </fieldset>
  );
}

/** 120px an hour. See `MINIMUM_INTERVAL_FRACTION` for why this number. */
const HOUR_HEIGHT = 120;
const SCALE_HEIGHT = HOUR_HEIGHT * 24;

function ComparativeTimeline({
  lanes,
  dayStart,
  dayEnd,
}: {
  lanes: Lane[];
  dayStart: number;
  dayEnd: number;
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
            <LaneColumn key={lane.sourceId} lane={lane} dayStart={dayStart} dayEnd={dayEnd} />
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

function LaneColumn({ lane, dayStart, dayEnd }: { lane: Lane; dayStart: number; dayEnd: number }) {
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
          <IntervalBlock key={entry.interval.id} placed={entry} />
        ))}
      </ol>
    </section>
  );
}

function IntervalBlock({
  placed,
}: {
  placed: {
    interval: ActivityInterval;
    top: number;
    height: number;
    column: number;
    columns: number;
  };
}) {
  const { interval, top, height, column, columns } = placed;
  const started = new Date(interval.started_at);
  const ended = new Date(interval.ended_at);
  const clock = `${formatClockTime(started)}–${formatClockTime(ended)}`;
  const duration = formatDuration(ended.getTime() - started.getTime());

  // Overlapping records share the lane's width side by side rather than
  // stacking, so neither disappears behind the other.
  const width = 100 / columns;

  return (
    <li
      className={`absolute overflow-hidden rounded border px-1 py-0.5 text-[10px] leading-tight ${
        interval.idle
          ? "border-dashed border-border bg-background text-muted-foreground"
          : "border-border bg-background"
      }`}
      style={{
        top: `${top * 100}%`,
        height: `${height * 100}%`,
        left: `${column * width}%`,
        width: `${width}%`,
      }}
      // The exact instants, duration and detail, available without a detail
      // view: issue #424 owns opening one record, but a block a reader cannot
      // identify at all would make the lanes decorative in the meantime.
      title={`${interval.label}\n${clock} · ${duration}${interval.idle ? " · idle" : ""}${
        interval.detail ? `\n${interval.detail}` : ""
      }`}
    >
      <span className="block truncate font-medium">{interval.label}</span>
      {/* Only tall enough blocks get a second line; a short record would
          otherwise clip its own label away to show a time nobody can read. */}
      {height > MINIMUM_INTERVAL_FRACTION * 4 && (
        <span className="block truncate text-muted-foreground tabular-nums">{clock}</span>
      )}
    </li>
  );
}

function formatClockTime(value: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(value);
}
