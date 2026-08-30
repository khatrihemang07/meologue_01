import type { Entry } from "@meologue/core";
import { useProbeQuery } from "@/hooks/use-probe-query";
import { dayReferrersQueryKey } from "@/lib/query-keys";

/**
 * Which later Entries Refer to `dayKey` (issue #147) — day-referrers.ts's
 * own `dayReferrers`, which `probe` wraps
 * (`EntryStoreOutletContext.dayReferrers`, entry-store-layout.tsx is the
 * one real implementation). Mirrors `useDayHasEntries`
 * (use-day-has-entries.ts) exactly, one level over on what it asks: that
 * hook answers "does this day have anything"; this one answers "what
 * points back at it".
 *
 * Takes the probe as a plain async function rather than an `EntryStore`
 * itself, for the same reason `useDayHasEntries` does: this hook has no
 * business knowing the store's shape, only that something can answer
 * "who Refers to this day?" — testable with a bare stub, no store fake
 * required.
 *
 * Keyed on the day alone (`dayReferrersQueryKey`), matching every sibling
 * probe hook's own reasoning — a day has exactly one of these rows in
 * History (history.tsx's `flattenGroups`), but keying on the day alone
 * rather than, say, the row's own key keeps this consistent with
 * `useDayHasEntries`/`useEntryReference` regardless of how many places in
 * the app end up asking about the same day.
 *
 * `probe` undefined disables the query outright — the same "no probe is
 * the same as still resolving" rule every sibling hook already follows —
 * so a page that builds `EntryStoreOutletContext` with no reason to know
 * this feature exists simply omits it and this renders nothing, same as a
 * page confirmed to have no referrers.
 *
 * Returns `undefined` while the answer is still in flight or disabled, and
 * an empty array once resolved for a day nothing Refers to. The caller
 * (history.tsx's `DayReferrersRow`) treats both the same way — "show
 * nothing" — but only `undefined` actually means "not decided yet."
 */
export function useDayReferrers(
  probe: ((dayKey: string) => Promise<Entry[]>) | undefined,
  dayKey: string,
): Entry[] | undefined {
  return useProbeQuery(probe, dayReferrersQueryKey(dayKey), dayKey, EMPTY);
}

/** A stable empty array, so a disabled query cannot churn referential identity. */
const EMPTY: Entry[] = [];
