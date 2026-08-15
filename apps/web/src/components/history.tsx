import type { Entry } from "@meologue/core";
import { formatAbsoluteTime, formatEntryTime } from "@/lib/entry-time";

interface HistoryProps {
  entries: Entry[];
  /**
   * Whether a Server URL is configured (ticket 32). An Entry with `seq ===
   * null` hasn't been assigned a server sequence — the Server has never
   * seen it — but with Sync off that's true of every Entry, so the marker
   * would say nothing except what the capture page's hint already says
   * once.
   */
  syncEnabled: boolean;
}

export function History({ entries, syncEnabled }: HistoryProps) {
  if (entries.length === 0) {
    return <p className="text-center text-sm text-muted-foreground">History will appear here.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {entries.map((entry) => {
        const time = formatEntryTime(entry.createdAt);
        return (
          <div
            key={entry.id}
            className="flex items-start justify-between gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-foreground"
          >
            <p className="whitespace-pre-wrap">{entry.body}</p>
            <div className="flex shrink-0 items-start gap-2">
              {time !== null && (
                <time
                  dateTime={entry.createdAt}
                  title={formatAbsoluteTime(entry.createdAt) ?? undefined}
                  className="shrink-0 text-xs text-muted-foreground"
                >
                  {time}
                </time>
              )}
              {syncEnabled && entry.seq === null && (
                <span
                  role="img"
                  aria-label="Not yet synced"
                  title="Not yet synced"
                  className="text-muted-foreground"
                >
                  ●
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
