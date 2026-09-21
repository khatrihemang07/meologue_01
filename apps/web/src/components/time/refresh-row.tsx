import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatNewestRecord, importSummary } from "@/lib/time-status";
import { refreshTimeSources, type TimeSource } from "@/lib/time-transport";

/**
 * "Refresh now", and what the last run made of each recorder.
 *
 * The result is per source, not one verdict for the run: a single failing
 * recorder must not be able to make every other recorder's result unreadable,
 * which is the whole reason the importer records outcomes against sources
 * rather than against runs (issue #421).
 *
 * Issue #418's own complaint: a refresh that correctly found 0 new records
 * (every source pointed at a stale snapshot file) looked identical to a
 * healthy no-op refresh, because nothing here said which file a source reads
 * or how recent its data already is. The finish message now names each
 * source's newest stored record when nothing came in (`importSummary`), and
 * the status list below always shows a source's newest record and the file
 * path it reads — truncated, with the full path in `title` — so a frozen
 * recorder is diagnosable without opening a day at all.
 */
export function RefreshRow({
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
  //
  // In an effect, keyed on a ref, and NOT during render. Doing this during
  // render calls `setMessage` on every render once the run has ended, which
  // is an infinite loop: React tore the page down with "Too many re-renders"
  // the first time a real import finished. No unit test caught it because
  // none of them moved a source from running back to idle.
  const wasRunning = useRef(running);
  // `sources` deliberately excluded from the dependency list below: this
  // must fire exactly once per running -> idle transition, using whichever
  // `sources` snapshot is current AT that instant, not re-run every time a
  // later poll updates `sources` while nothing about `running` changed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see the comment above.
  useEffect(() => {
    if (wasRunning.current && !running) {
      void queryClient.invalidateQueries({ queryKey: ["time", "intervals"] });
      setMessage(importSummary(sources, new Date()));
    }
    wasRunning.current = running;
  }, [running, queryClient]);

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
              <SourceFileLine source={source} />
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

/**
 * The file a source reads, and how recent its newest stored record is.
 *
 * Both facts together are what make a frozen source diagnosable: a path
 * pointed at a stale snapshot copy and a genuinely idle-but-healthy source
 * report the identical `last_inserted_count: 0` on every run — the newest
 * record's own age is the only thing that tells them apart (issue #418).
 * `title` carries the full path: Settings-configured paths are often long
 * absolute ones, and truncating them here without a way to read the whole
 * thing would trade one kind of illegibility for another.
 */
function SourceFileLine({ source }: { source: TimeSource }) {
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      {/* `shrink-0 whitespace-nowrap`: beside a long path on a phone this
          otherwise gave up its width to the truncating path and wrapped into
          three stacked words. The time is the part a reader needs; the path
          is the part that can afford to be cut. */}
      <span className="shrink-0 whitespace-nowrap">
        Newest record {formatNewestRecord(source.newest_record_at, new Date())}
      </span>
      <span aria-hidden="true" className="shrink-0">
        ·
      </span>
      <span className="min-w-0 truncate" title={source.path}>
        {source.path}
      </span>
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
