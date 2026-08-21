import type { Entry } from "@meologue/core";
import { EntryRow } from "@/components/entry-row";
import { deviceUtcOffsetMinutes, entryDayKey, formatDaySeparator } from "@/lib/entry-day";

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
  /**
   * Wires the Edit/Delete context menu (ADR 0028) onto every row this
   * renders. Both undefined and both present, never one or the other —
   * see EntryRow's own `actions` prop, which this simply assembles and
   * forwards. Every caller of History (composer-page.tsx's footer,
   * history-page.tsx) passes both; nothing here defaults them to a no-op,
   * because a silently-broken menu item is worse than a type error at the
   * call site that forgot one.
   */
  onEdit?: (entry: Entry) => void;
  onDelete?: (entry: Entry) => void;
}

interface DayGroup {
  /** null for an Entry whose createdAt didn't parse — see groupByDay below. */
  dayKey: string | null;
  entries: Entry[];
}

// Groups Entries into runs sharing a local day (ticket 52), via the same
// `entryDayKey` Export's own day-grouping primitive backs (ADR 0016) — this
// is what makes "day grouping matches Export's grouping" true by
// construction rather than by coincidence.
//
// `entries` arrives newest-first (`list()` is `ORDER BY created_at DESC`);
// reversing that to oldest-first reading order is ticket 53's job, not
// this one's, so this groups whatever order it's handed. That's safe
// either way: the input is always time-sorted, and a time-sorted list can
// only leave a calendar day once before entering the next one, so Entries
// sharing a day are always contiguous in the array regardless of
// direction — no need to bucket by key and re-flatten.
//
// An Entry whose createdAt doesn't parse (entryDayKey returns null) gets
// its own single-Entry group with no separator, rather than being folded
// into a neighbouring day it doesn't actually belong to.
function groupByDay(entries: Entry[], offsetMinutes: number): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const entry of entries) {
    const dayKey = entryDayKey(entry.createdAt, offsetMinutes);
    const previous = groups.at(-1);
    if (dayKey !== null && previous !== undefined && previous.dayKey === dayKey) {
      previous.entries.push(entry);
    } else {
      groups.push({ dayKey, entries: [entry] });
    }
  }
  return groups;
}

// The full weekday + date behind a day separator's short label (ticket 52)
// — available on hover, same idea as `formatAbsoluteTime` for a per-Entry
// clock time, just without a time-of-day component since a day key has
// none. `dayKey` is parsed as UTC midnight, matching `formatDaySeparator`'s
// own parse in entry-day.ts, so the two never disagree about which day a
// key names.
function formatDaySeparatorTitle(dayKey: string): string | undefined {
  const parsed = Date.parse(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return new Date(parsed).toLocaleDateString(undefined, { dateStyle: "full", timeZone: "UTC" });
}

export function History({ entries, syncEnabled, query = "", onEdit, onDelete }: HistoryProps) {
  // Both-or-neither (see the props' own comment): assembled once here
  // rather than re-checked per row, and `undefined` when either is missing
  // so EntryRow's own default ("no actions prop" -> "no menu") is what
  // actually governs the no-menu case, instead of this component
  // duplicating that decision.
  const actions = onEdit && onDelete ? { onEdit, onDelete } : undefined;

  if (entries.length === 0) {
    return (
      <p className="text-center text-sm text-muted-foreground">
        {query.trim() === "" ? "History will appear here." : "No matching Entries."}
      </p>
    );
  }

  const offsetMinutes = deviceUtcOffsetMinutes();
  const todayKey = entryDayKey(new Date().toISOString(), offsetMinutes) ?? "";
  const groups = groupByDay(entries, offsetMinutes);

  return (
    <div className="flex flex-col">
      {groups.map((group, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a day's own key isn't unique across the whole thread (a null-dayKey Entry gets a fresh group every time — see groupByDay), and groups never reorder, so position is the stable identity here.
        <div key={index}>
          {group.dayKey !== null && (
            // Sticky within History's scrolling ancestor (Shell's
            // overflow-y-auto content region) — no scroller component of
            // its own to build here, `position: sticky` on this pill is
            // enough to float it while its day's Entries scroll underneath,
            // and to hand off to the next separator once this day's last
            // Entry scrolls past (ticket 52; scroll pinning is #53's, not
            // this).
            <div className="sticky top-0 z-10 flex justify-center py-2">
              <span
                title={formatDaySeparatorTitle(group.dayKey)}
                className="rounded-full border border-border bg-muted/90 px-3 py-0.5 text-xs font-medium text-muted-foreground backdrop-blur-sm"
              >
                {formatDaySeparator(group.dayKey, todayKey)}
              </span>
            </div>
          )}
          <div className="divide-y divide-border">
            {group.entries.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                query={query}
                syncEnabled={syncEnabled}
                actions={actions}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
