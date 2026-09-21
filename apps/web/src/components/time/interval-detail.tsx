import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { activityIntervalQueryKey } from "@/lib/query-keys";
import { formatDuration } from "@/lib/time-lanes";
import { type ActivityIntervalDetail, fetchActivityInterval } from "@/lib/time-transport";

/**
 * One record in full, including the provider's own row.
 *
 * Fetched only when a record is opened — that is the whole reason the daily
 * response omits `raw_row`. A dense day would otherwise carry every
 * provider's icons and BLOBs whether or not anyone looked at one, and
 * filtering a day would drag them along too.
 */
export function IntervalDetail({ id, onClose }: { id: string; onClose: () => void }) {
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
