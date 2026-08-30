/**
 * Answers "does this local day hold any Entry?" — the question a date
 * Reference has to settle before it can be a link at all (ADR 0042).
 *
 * A Reference to a day with nothing in it renders as the characters the user
 * typed rather than as a link, which is the same rule a removed Entry and a
 * malformed mark follow. Deciding that needs a real answer, not a guess from
 * whatever History happens to have paged in: History loads backwards a page at
 * a time, so a day from last year is absent from `entries` for the ordinary
 * reason that nobody has scrolled that far, and treating absent as empty would
 * make almost every Reference to the past render dead.
 *
 * It asks through `EntryStore.list`'s existing keyset cursor rather than
 * widening the interface. ADR 0016 rejected a paginated read and issue #79
 * reopened exactly as much of it as was safe; nothing here reopens any more.
 * The query is "the newest Entry strictly older than the instant this local
 * day ends" — one walk of the `(createdAt, id)` composite index
 * (`entries_created_at_id_idx`), reading a single row. If that Entry falls on
 * the day we asked about, the day has Entries; if it falls earlier, the day is
 * empty. Reads are local SQLite (ADR 0001/0007), so this costs no round trip.
 */
import type { Entry, EntryStore } from "@meologue/core";
import { entryDayKey } from "@/lib/entry-day";

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A cursor id that no real Entry can be "older" than on the tie-break.
 *
 * The empty string, deliberately, and this is load-bearing rather than
 * arbitrary. `list`'s cursor means `createdAt < X OR (createdAt = X AND id <
 * Y)`. An Entry captured at exactly midnight belongs to the *next* day, and
 * with any ordinary `Y` the equality branch would hand it back — so a day
 * whose successor begins with an Entry at exactly 00:00:00.000 would look
 * empty. No id sorts below "", so the equality branch matches nothing and the
 * predicate collapses to the half-open range we actually want.
 */
const EXCLUSIVE_CURSOR_ID = "";

/**
 * The UTC instant at which the local day *after* `dayKey` begins — the
 * exclusive upper bound of `dayKey` itself.
 *
 * Derived from the same offset-shifting rule History's day separators and
 * Export's per-day files group by (ADR 0018, still load-bearing per ADRs 0020,
 * 0030 and 0036). It must not drift from them: a Reference that resolved
 * against a different idea of where a day starts would link to a day the
 * reader cannot see under that name.
 */
export function localDayEndUtc(dayKey: string, offsetMinutes: number): string | null {
  const match = DAY_KEY.exec(dayKey);
  if (match === null) {
    return null;
  }
  const [, year, month, day] = match;
  const startOfNextLocalDay =
    Date.UTC(Number(year), Number(month) - 1, Number(day) + 1) - offsetMinutes * 60_000;
  const instant = new Date(startOfNextLocalDay);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

/**
 * Whether `dayKey` holds at least one live Entry. Tombstones are already
 * excluded by `list` itself (ADR 0028), so a day whose only Entry was removed
 * correctly reads as empty.
 */
export async function dayHasEntries(
  store: Pick<EntryStore, "list">,
  dayKey: string,
  offsetMinutes: number,
): Promise<boolean> {
  const before = localDayEndUtc(dayKey, offsetMinutes);
  if (before === null) {
    return false;
  }
  const page: Entry[] = await store.list({
    before: { createdAt: before, id: EXCLUSIVE_CURSOR_ID },
    limit: 1,
  });
  const newest = page.at(0);
  if (newest === undefined) {
    return false;
  }
  return entryDayKey(newest.createdAt, offsetMinutes) === dayKey;
}
