import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { addDays, format, isToday, parseISO } from "date-fns";
import { useState } from "react";
import { Link } from "react-router";
import { BackToChats } from "@/components/back-to-chats";
import { ServerUnreachableBanner } from "@/components/server-unreachable-banner";
import { Shell } from "@/components/shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  activityIntervalQueryKey,
  activityIntervalsQueryKey,
  TIME_SOURCES_QUERY_KEY,
} from "@/lib/query-keys";
import { refreshCapabilities, useCapabilities, useSyncEnabled } from "@/lib/settings";
import {
  formatDuration,
  hourMarks,
  type Lane,
  lanesFor,
  MINIMUM_INTERVAL_FRACTION,
  type PlacedInterval,
  placeLane,
} from "@/lib/time-lanes";
import {
  type ActivityInterval,
  type ActivityIntervalDetail,
  fetchActivityInterval,
  listActivityIntervals,
  listTimeSources,
  refreshTimeSources,
  type TimeSource,
} from "@/lib/time-transport";

/**
 * The Server-backed Time Destination.
 *
 * Since issue #420 this is a *comparison*, not a feed: every selected
 * recorder gets its own lane against one shared 24-hour clock, because the
 * question Time exists to answer is what one recorder saw while another saw
 * something else. Issue #424 makes a dense day explorable — move between
 * days, choose lanes, search the text recorders wrote down, and open one
 * record to see the provider's own row behind it.
 */
export function TimePage() {
  const syncEnabled = useSyncEnabled();
  const capabilities = useCapabilities();
  const timeSupported = capabilities?.time === true;

  return (
    <Shell title="Time" back={<BackToChats />}>
      {!syncEnabled ? (
        <p className="text-center text-muted-foreground text-sm">
          Sync is off —{" "}
          <Link to="/settings" className="underline underline-offset-2 hover:text-foreground">
            add a Server URL
          </Link>{" "}
          to see your Time.
        </p>
      ) : !timeSupported ? (
        <p className="text-center text-muted-foreground text-sm">
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
  const sourcesQuery = useQuery({
    queryKey: TIME_SOURCES_QUERY_KEY,
    queryFn: listTimeSources,
    // Polled only while a run is actually in flight (issue #421). A fixed
    // interval would keep waking an idle Server forever; stopping at idle
    // means the poll ends by itself when the run does.
    refetchInterval: (query) => {
      const data = query.state.data;
      const running = data?.ok && data.sources.some((source) => source.state !== "idle");
      return running ? 1000 : false;
    },
  });

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
    return <p className="text-center text-muted-foreground text-sm">Loading Time sources…</p>;
  }

  const sources = sourcesQuery.data?.ok ? sourcesQuery.data.sources : [];
  if (sources.filter((source) => source.enabled).length === 0) {
    return (
      <p className="text-center text-muted-foreground text-sm">
        No Time sources are enabled yet. Configure one in{" "}
        <Link to="/settings" className="underline underline-offset-2 hover:text-foreground">
          Server Settings
        </Link>
        .
      </p>
    );
  }

  return <DailyComparison sources={sources} refetchSources={sourcesQuery.refetch} />;
}

function DailyComparison({
  sources,
  refetchSources,
}: {
  sources: TimeSource[];
  refetchSources: () => void;
}) {
  // A floating YYYY-MM-DD. Which instants it covers is the Server's answer,
  // resolved against its configured timezone, so two Devices in different
  // zones asking for the same date see the same day (issue #424).
  const [day, setDay] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [search, setSearch] = useState("");
  const [openIntervalId, setOpenIntervalId] = useState<string | null>(null);

  // Which lanes the reader has switched off, by source id. Hidden rather than
  // visible so a source that starts recording later shows up on its own
  // instead of having to be discovered and switched on.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const selectedIds =
    hidden.size === 0
      ? undefined
      : sources.filter((source) => !hidden.has(source.id)).map((source) => source.id);

  const intervalsQuery = useQuery({
    queryKey: activityIntervalsQueryKey(day, selectedIds, search),
    queryFn: () => listActivityIntervals(day, { sourceIds: selectedIds, search }),
    // A day already looked at comes back instantly when the reader steps back
    // onto it, rather than blanking while it refetches.
    placeholderData: (previous) => previous,
  });

  const intervals = intervalsQuery.data?.ok ? intervalsQuery.data.intervals : [];
  const lanes = lanesFor(intervals);

  // The scale runs from this Device's local midnight to the next. The Server
  // decides which records belong to the day; this only decides where on the
  // page an instant is drawn, and `dayFraction` clamps anything the Server
  // included that falls outside the window rather than drawing it off-scale.
  const dayStart = parseISO(`${day}T00:00:00`);
  const dayEnd = addDays(dayStart, 1);

  return (
    <section aria-labelledby="time-day-heading" className="flex min-h-0 flex-col gap-3">
      <DayNavigator
        day={day}
        onChange={(next) => {
          setDay(next);
          setOpenIntervalId(null);
        }}
      />

      <RefreshRow sources={sources} onRefreshed={refetchSources} day={day} />

      <SearchField value={search} onChange={setSearch} />

      {sources.length > 1 && <LanePicker sources={sources} hidden={hidden} onChange={setHidden} />}

      <p className="text-muted-foreground text-xs" aria-live="polite">
        <DayCount
          pending={intervalsQuery.isPending}
          failed={intervalsQuery.data?.ok === false}
          count={intervals.length}
          lanes={lanes.length}
          search={search}
        />
      </p>

      {intervalsQuery.data?.ok === false ? (
        <ServerUnreachableBanner
          message="This day's activity couldn't be loaded right now."
          onRetry={() => {
            void refreshCapabilities();
            void intervalsQuery.refetch();
          }}
        />
      ) : lanes.length === 0 ? null : (
        <ComparativeTimeline
          lanes={lanes}
          dayStart={dayStart.getTime()}
          dayEnd={dayEnd.getTime()}
          openIntervalId={openIntervalId}
          onOpen={setOpenIntervalId}
        />
      )}

      {openIntervalId && (
        <IntervalDetail id={openIntervalId} onClose={() => setOpenIntervalId(null)} />
      )}
    </section>
  );
}

function DayCount({
  pending,
  failed,
  count,
  lanes,
  search,
}: {
  pending: boolean;
  failed: boolean;
  count: number;
  lanes: number;
  search: string;
}) {
  if (pending) {
    return <>Loading…</>;
  }
  if (failed) {
    return <>Couldn't load this day.</>;
  }
  const term = search.trim();
  if (count === 0) {
    return term ? (
      <>Nothing on this day matches “{term}”.</>
    ) : (
      <>No activity was recorded on this day.</>
    );
  }
  return (
    <>
      {count} record{count === 1 ? "" : "s"} across {lanes} source{lanes === 1 ? "" : "s"}
      {term ? <> matching “{term}”</> : null}
    </>
  );
}

/**
 * "Refresh now", and what the last run made of each recorder.
 *
 * The result is per source, not one verdict for the run: a single failing
 * recorder must not be able to make every other recorder's result unreadable,
 * which is the whole reason the importer records outcomes against sources
 * rather than against runs (issue #421).
 */
function RefreshRow({
  sources,
  onRefreshed,
  day,
}: {
  sources: TimeSource[];
  onRefreshed: () => void;
  day: string;
}) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const running = sources.some(isRunning);

  const refresh = useMutation({
    mutationFn: refreshTimeSources,
    onSuccess: (result) => {
      if (!result.ok) {
        setMessage(refreshFailureCopy(result.reason));
        return;
      }
      setMessage(`Importing ${result.queued} source${result.queued === 1 ? "" : "s"}…`);
      onRefreshed();
    },
  });

  // A finished run may have imported records into the day being looked at, so
  // the timeline has to be re-read — but only once the run is actually over,
  // not on every poll while it is still inserting.
  const previouslyRunning = usePrevious(running);
  if (previouslyRunning && !running) {
    void queryClient.invalidateQueries({ queryKey: ["time", "intervals"] });
    setMessage("Import finished.");
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="touch"
          variant="outline"
          disabled={refresh.isPending || running}
          onClick={() => {
            setMessage(null);
            void refresh.mutateAsync();
          }}
        >
          {running ? "Importing…" : "Refresh now"}
        </Button>
        {message && (
          <span className="text-muted-foreground text-xs" aria-live="polite">
            {message}
          </span>
        )}
      </div>

      <details>
        <summary className="cursor-pointer text-muted-foreground text-xs">Source status</summary>
        <ul aria-label="Time source status" className="mt-1 flex flex-col gap-1 text-xs">
          {sources.map((source) => (
            <li key={source.id} className="flex flex-col">
              <span className="font-medium">
                {source.name}
                {!source.enabled && " (archived)"}
                {isRunning(source) && (
                  <span className="ml-1 font-normal text-muted-foreground">{source.state}</span>
                )}
              </span>
              <SourceStatusLine source={source} />
            </li>
          ))}
        </ul>
        {/* The day is named here so a reader who refreshed while looking at
            an older day knows which one the new records will land on. */}
        <p className="mt-1 text-muted-foreground text-xs">Showing {day}.</p>
      </details>
    </div>
  );
}

/** Missing run state means idle — see the sources query's own comment. */
function isRunning(source: TimeSource): boolean {
  return source.state !== undefined && source.state !== "idle";
}

function SourceStatusLine({ source }: { source: TimeSource }) {
  if (source.last_error) {
    // The error wins the line: a source that is failing right now is the one
    // fact worth reading, and burying it after the counts would hide it.
    return <span className="text-muted-foreground">Last run failed — {source.last_error}</span>;
  }
  if (!source.last_attempt_at) {
    return <span className="text-muted-foreground">Not imported yet.</span>;
  }
  const succeeded = source.last_success_at
    ? new Date(source.last_success_at).toLocaleString()
    : "never";
  return (
    <span className="text-muted-foreground">
      Last success {succeeded} · {source.last_inserted_count} new
      {source.last_warning_count > 0 && <> · {source.last_warning_count} record(s) skipped</>}
      {/* The nightly run is named separately from the last success because
          they answer different questions: any trigger moves the success, but
          only a completed daily run moves this (issue #422). */}
      {source.last_scheduled_run_on ? (
        <> · nightly run for {source.last_scheduled_run_on}</>
      ) : (
        <> · no nightly run yet</>
      )}
    </span>
  );
}

function refreshFailureCopy(
  reason: "not-supported" | "unreachable" | "already-running" | "locked",
): string {
  switch (reason) {
    case "not-supported":
      return "This Server doesn't support refreshing Time sources yet.";
    case "unreachable":
      return "Couldn't reach the Server. Check that it's running and try again.";
    case "already-running":
      return "An import is already running.";
    case "locked":
      return "This Server's configuration is locked, so imports can't be started here.";
  }
}

/** The previous render's value, for spotting the moment a run ends. */
function usePrevious<T>(value: T): T | undefined {
  const [pair, setPair] = useState<{ previous: T | undefined; current: T }>({
    previous: undefined,
    current: value,
  });
  if (pair.current !== value) {
    setPair({ previous: pair.current, current: value });
  }
  return pair.previous;
}

/**
 * Previous / Today / next, over calendar dates rather than instants.
 *
 * Stepping a date, not adding 24 hours: on a daylight-saving day those are
 * different, and the Server's own boundaries are calendar ones.
 */
function DayNavigator({ day, onChange }: { day: string; onChange: (day: string) => void }) {
  const parsed = parseISO(`${day}T00:00:00`);
  const today = format(new Date(), "yyyy-MM-dd");
  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        size="touch"
        variant="outline"
        aria-label="Previous day"
        onClick={() => onChange(format(addDays(parsed, -1), "yyyy-MM-dd"))}
      >
        ‹
      </Button>
      <h2 id="time-day-heading" className="min-w-0 flex-1 truncate font-semibold text-sm">
        {isToday(parsed) ? "Today" : format(parsed, "EEEE d MMMM yyyy")}
      </h2>
      <Button
        type="button"
        size="touch"
        variant="outline"
        disabled={day === today}
        onClick={() => onChange(today)}
      >
        Today
      </Button>
      <Button
        type="button"
        size="touch"
        variant="outline"
        aria-label="Next day"
        onClick={() => onChange(format(addDays(parsed, 1), "yyyy-MM-dd"))}
      >
        ›
      </Button>
    </div>
  );
}

/**
 * Searches this day's Activity intervals and nothing else.
 *
 * Deliberately not the Shell's own History search: Time searches what
 * recorders observed, which is not History, Tasks or any other Destination's
 * material — and one box that sometimes meant one and sometimes the other
 * would be worse than two that each say what they search.
 */
function SearchField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor="time-search" className="sr-only">
        Search this day's activity
      </label>
      <Input
        id="time-search"
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search this day's activity"
        className="h-11"
      />
    </div>
  );
}

/**
 * One independent on/off fact per lane, rendered as a real `role="switch"`
 * with `aria-checked` for the same reason `switch-row.tsx` gives: a lane is
 * simply shown or not, with no sibling option it is being chosen over.
 *
 * Driven by the configured sources rather than by the day's response, so a
 * lane that has been switched off — and therefore has no records in the
 * response — still has a switch to turn back on.
 */
function LanePicker({
  sources,
  hidden,
  onChange,
}: {
  sources: TimeSource[];
  hidden: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
}) {
  return (
    <fieldset className="flex flex-wrap items-center gap-2 border-0 p-0">
      <legend className="sr-only">Source lanes</legend>
      <span aria-hidden="true" className="text-muted-foreground text-xs">
        Lanes
      </span>
      {sources.map((source) => {
        const shown = !hidden.has(source.id);
        return (
          <Button
            key={source.id}
            type="button"
            size="touch"
            variant={shown ? "default" : "outline"}
            role="switch"
            aria-checked={shown}
            aria-label={`${source.name} lane`}
            onClick={() => {
              const next = new Set(hidden);
              if (shown) {
                next.add(source.id);
              } else {
                next.delete(source.id);
              }
              onChange(next);
            }}
          >
            {source.name}
            {!source.enabled && " (archived)"}
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

/**
 * One record in full, including the provider's own row.
 *
 * Fetched only when a record is opened — that is the whole reason the daily
 * response omits `raw_row`. A dense day would otherwise carry every
 * provider's icons and BLOBs whether or not anyone looked at one, and
 * filtering a day would drag them along too.
 */
function IntervalDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const query = useQuery({
    queryKey: activityIntervalQueryKey(id),
    queryFn: () => fetchActivityInterval(id),
  });

  return (
    <section
      aria-label="Activity interval"
      className="rounded-lg border border-border bg-background p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 truncate font-semibold text-sm">
          {query.data?.ok ? query.data.interval.label : "Activity interval"}
        </h3>
        <Button type="button" size="sm" variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>

      {query.isPending ? (
        <p className="mt-2 text-muted-foreground text-sm">Loading this record…</p>
      ) : query.data?.ok ? (
        <IntervalFacts interval={query.data.interval} />
      ) : (
        <p className="mt-2 text-muted-foreground text-sm">
          {query.data?.reason === "not-found"
            ? "That record is no longer on this Server."
            : "Couldn't load that record right now."}
        </p>
      )}
    </section>
  );
}

function IntervalFacts({ interval }: { interval: ActivityIntervalDetail }) {
  const started = new Date(interval.started_at);
  const ended = new Date(interval.ended_at);

  return (
    <div className="mt-2 flex flex-col gap-2 text-sm">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <Fact label="Source">
          {interval.source_name}
          {!interval.source_enabled && " (archived)"}
        </Fact>
        <Fact label="Started">{started.toLocaleString()}</Fact>
        <Fact label="Ended">{ended.toLocaleString()}</Fact>
        <Fact label="Duration">{formatDuration(ended.getTime() - started.getTime())}</Fact>
        {interval.detail && <Fact label="Detail">{interval.detail}</Fact>}
        <Fact label="Idle">{interval.idle ? "Reported by the recorder" : "Not reported"}</Fact>
      </dl>

      <details>
        <summary className="cursor-pointer text-muted-foreground text-xs">
          Everything the recorder stored
        </summary>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {Object.entries(interval.raw_row)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([column, value]) => (
              <Fact key={column} label={column}>
                {/* A BLOB is described rather than printed: its bytes are kept
                    losslessly, but pasting a base64 icon into a list of facts
                    would be noise, not evidence. */}
                {value.type === "blob"
                  ? `binary (${value.base64?.length ?? 0} base64 characters)`
                  : value.type === "null"
                    ? "—"
                    : String(value.value)}
              </Fact>
            ))}
        </dl>
      </details>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function intervalClock(interval: ActivityInterval): string {
  const formatter = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  return `${formatter.format(new Date(interval.started_at))}–${formatter.format(
    new Date(interval.ended_at),
  )}`;
}
