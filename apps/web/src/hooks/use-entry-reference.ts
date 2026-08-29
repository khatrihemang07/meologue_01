import type { Entry } from "@meologue/core";
import { useQuery } from "@tanstack/react-query";
import { entryReferenceQueryKey } from "@/lib/query-keys";

/**
 * Resolves an Entry Reference's target, live (issue #143) — the question a
 * `[[e:<id>]]` chip has to settle before it can render anything but its own
 * literal text (ADR 0042, `entry-row.tsx`'s `EntryReferenceLink`). Mirrors
 * `use-day-has-entries.ts` exactly, one level over on what it asks: that
 * hook wraps `EntryStoreOutletContext.dayHasEntries`, this one wraps
 * `EntryStoreOutletContext.getEntry` — the one real implementation lives in
 * entry-store-layout.tsx.
 *
 * Takes the probe as a plain async function rather than an `EntryStore`
 * itself, for the same reason `useDayHasEntries` does: this hook has no
 * business knowing the store's shape, only that something can answer "what
 * does this Entry look like right now?" — testable with a bare stub, no
 * store fake required.
 *
 * Keyed on the target's id alone (`entryReferenceQueryKey`), so every chip
 * anywhere in the app pointing at the same Entry shares one cache entry and
 * `probe` is called at most once per distinct target, not once per
 * occurrence — and so that editing that Entry (which invalidates this exact
 * key, see `refreshNewestEntriesPage` in entries-pagination.ts) updates
 * every chip pointing at it at once, which is ADR 0042's own "a chip
 * resolves its target live rather than storing a snapshot."
 *
 * `probe` undefined disables the query outright rather than throwing —
 * `EntryStoreOutletContext.getEntry` is itself optional (most of that
 * context's own callers have no reason to supply it), and "cannot resolve
 * this Reference" is exactly the same outcome as "resolution is still in
 * flight" from this hook's own return type: both leave the chip rendering
 * as its literal text.
 *
 * Returns `undefined` while the answer is still in flight or disabled, or
 * once the probe confirms there's nothing to find — a tombstoned Entry, or
 * one that hasn't Synced to this Device yet. This hook does not distinguish
 * those causes from one another, because the renderer doesn't either: ADR
 * 0042's "one rule, four causes" is that a removed Entry, an unsynced one,
 * and "still resolving" all render identically, as the mark's own literal
 * text.
 */
export function useEntryReference(
  probe: ((entryId: string) => Promise<Entry | undefined>) | undefined,
  entryId: string,
): Entry | undefined {
  const query = useQuery({
    queryKey: entryReferenceQueryKey(entryId),
    // `null`, not `undefined`, is the "nothing found" sentinel a queryFn
    // hands back here — TanStack Query v5 treats a queryFn that resolves to
    // `undefined` as a bug and throws ("Bad usage detected") rather than
    // caching it, precisely because `undefined` is its own signal for "no
    // data yet." `probe`'s own contract (EntryStoreOutletContext.getEntry)
    // is allowed to resolve to `undefined` for an unresolvable target, so
    // that value is folded into `null` here rather than passed straight
    // through, and folded back to `undefined` below — the shape this hook's
    // own callers, and useDayHasEntries's sibling contract, already expect.
    queryFn: async () => {
      if (probe === undefined) {
        // Unreachable while `enabled` below is false — TanStack Query
        // never invokes queryFn for a disabled query — but the type of
        // `probe` still needs narrowing here for queryFn's own return type.
        return null;
      }
      const found = await probe(entryId);
      return found ?? null;
    },
    enabled: probe !== undefined,
  });
  return query.data ?? undefined;
}
