import { useQuery } from "@tanstack/react-query";
import { addDays, format, parseISO } from "date-fns";
import { useState } from "react";
import { Link } from "react-router";
import { BackToChats } from "@/components/back-to-chats";
import { ServerUnreachableBanner } from "@/components/server-unreachable-banner";
import { Shell } from "@/components/shell";
import { ComparativeTimeline } from "@/components/time/comparative-timeline";
import { DayNavigator } from "@/components/time/day-navigator";
import { IntervalDetail } from "@/components/time/interval-detail";
import { LanePicker } from "@/components/time/lane-picker";
import { RefreshRow } from "@/components/time/refresh-row";
import { SearchField } from "@/components/time/search-field";
import { ZoomControls } from "@/components/time/zoom-controls";
import { useTimelineZoom } from "@/hooks/use-timeline-zoom";
import { activityIntervalsQueryKey, TIME_SOURCES_QUERY_KEY } from "@/lib/query-keys";
import { refreshCapabilities, useCapabilities, useSyncEnabled } from "@/lib/settings";
import { lanesFor } from "@/lib/time-lanes";
import { listActivityIntervals, listTimeSources, type TimeSource } from "@/lib/time-transport";

/**
 * The Server-backed Time Destination.
 *
 * Since issue #420 this is a *comparison*, not a feed: every selected
 * recorder gets its own lane against one shared 24-hour clock, because the
 * question Time exists to answer is what one recorder saw while another saw
 * something else. Issue #424 makes a dense day explorable — move between
 * days, choose lanes, search the text recorders wrote down, and open one
 * record to see the provider's own row behind it. Issue #418 adds zoom — the
 * shortest real records are a few seconds long and were unreadable at the
 * one fixed scale this page used to render at.
 *
 * This file is composition and page-level state; the pieces themselves live
 * under `@/components/time/` (issue #432).
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

  const zoom = useTimelineZoom();
  // A percentage of the page's original 120px/hour scale reads more plainly
  // than a raw px-per-hour number, and does not require knowing what "120"
  // meant in the first place.
  const zoomPercent = Math.round((zoom.pxPerHour / 120) * 100);

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
          pxPerHour={zoom.pxPerHour}
          timelineRef={zoom.timelineRef}
          timelineProps={zoom.timelineProps}
        />
      )}

      {/* After the timeline and sticky to the bottom, so the controls float over
          the bottom of the screen for as long as any of the day is on it.
          Above the timeline they scrolled away: zooming keeps the instant
          under the reader's focus still, which means the page scrolls, and
          after two zoom-ins on a phone the buttons sat 38px above the top of
          the screen with no way to zoom back out short of scrolling up. */}
      {lanes.length > 0 && intervalsQuery.data?.ok !== false && (
        <ZoomControls
          levelLabel={`${zoomPercent}%`}
          canZoomOut={zoom.canZoomOut}
          canZoomIn={zoom.canZoomIn}
          onZoomOut={zoom.zoomOut}
          onZoomIn={zoom.zoomIn}
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
