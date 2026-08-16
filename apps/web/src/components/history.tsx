import type { Entry } from "@meologue/core";
import { formatAbsoluteTime, formatEntryTime } from "@/lib/entry-time";
import { highlightMatches } from "@/lib/highlight-match";

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
  /**
   * The active Search query (ticket 39), for highlighting matched terms in
   * each Entry's body. Absent (or blank) outside History's own search box —
   * the Composer footer renders this same component with no query, and
   * shows every Entry's body plain.
   */
  query?: string;
}

function EntryBody({ body, query }: { body: string; query: string }) {
  if (query.trim() === "") {
    return <p className="whitespace-pre-wrap">{body}</p>;
  }
  return (
    <p className="whitespace-pre-wrap">
      {highlightMatches(body, query).map((segment, index) =>
        segment.matched ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are a stable, ordered split of one Entry's body for one render.
          <mark key={index} className="rounded-sm bg-primary/30 text-inherit">
            {segment.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are a stable, ordered split of one Entry's body for one render.
          <span key={index}>{segment.text}</span>
        ),
      )}
    </p>
  );
}

export function History({ entries, syncEnabled, query = "" }: HistoryProps) {
  if (entries.length === 0) {
    return (
      <p className="text-center text-sm text-muted-foreground">
        {query.trim() === "" ? "History will appear here." : "No matching Entries."}
      </p>
    );
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
            <EntryBody body={entry.body} query={query} />
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
