import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Link } from "react-router";
import { BackToChats } from "@/components/back-to-chats";
import { ServerUnreachableBanner } from "@/components/server-unreachable-banner";
import { Shell } from "@/components/shell";
import { activityIntervalsQueryKey, TIME_SOURCES_QUERY_KEY } from "@/lib/query-keys";
import { refreshCapabilities, useCapabilities, useSyncEnabled } from "@/lib/settings";
import {
  type ActivityInterval,
  listActivityIntervals,
  listTimeSources,
  type TimeSource,
} from "@/lib/time-transport";

/**
 * The Server-backed Time Destination. Source management and Activity
 * interval rendering arrive in later slices; a Server that supports Time
 * but has no enabled Time source deliberately opens this useful empty state.
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
 * because a Device visited /time. The first slice deliberately selects the
 * first enabled source: source selection and parallel lanes follow once a
 * second recorder is supported.
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

  const source = sourcesQuery.data?.ok
    ? sourcesQuery.data.sources.find((item) => item.enabled)
    : undefined;
  if (!source) {
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

  return <DailyTimeline source={source} />;
}

function DailyTimeline({ source }: { source: TimeSource }) {
  // The Server assigns the exact start/end instants to its configured
  // timezone. Until date navigation arrives, today's floating date is only
  // a request key; the response remains the Server's authoritative day.
  const day = format(new Date(), "yyyy-MM-dd");
  const intervalsQuery = useQuery({
    queryKey: activityIntervalsQueryKey(day, source.id),
    queryFn: () => listActivityIntervals(day, source.id),
  });

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
  return (
    <section aria-labelledby="time-today-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="time-today-heading" className="font-semibold text-sm">
          Today
        </h2>
        <p className="text-muted-foreground text-xs">{source.name}</p>
      </div>
      {intervals.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity was recorded today.</p>
      ) : (
        <ol
          aria-label="Activity timeline"
          className="flex flex-col gap-2 border-l border-border pl-3"
        >
          {intervals.map((interval) => (
            <ActivityIntervalRow key={interval.id} interval={interval} />
          ))}
        </ol>
      )}
    </section>
  );
}

function ActivityIntervalRow({ interval }: { interval: ActivityInterval }) {
  const started = new Date(interval.started_at);
  const ended = new Date(interval.ended_at);
  return (
    <li className="rounded-lg border border-border px-3 py-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 truncate font-medium text-sm">{interval.label}</p>
        <time className="shrink-0 text-muted-foreground text-xs" dateTime={interval.started_at}>
          {formatClockTime(started)}–{formatClockTime(ended)}
        </time>
      </div>
      {interval.detail && (
        <p className="mt-1 truncate text-muted-foreground text-xs">{interval.detail}</p>
      )}
      <p className="mt-1 text-muted-foreground text-xs">
        {formatDuration(ended.getTime() - started.getTime())}
      </p>
    </li>
  );
}

function formatClockTime(value: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(value);
}

function formatDuration(milliseconds: number): string {
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
