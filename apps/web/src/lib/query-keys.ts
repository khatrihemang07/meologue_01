/**
 * Query keys shared across the Entry store, History, and the Sync loop
 * (ticket 38) — pulled out on their own so `use-sync-loop.ts`,
 * `entry-store-layout.tsx`, and `use-history.ts` can all reference the same
 * key without importing one another and creating a cycle.
 */
export const ENTRY_STORE_QUERY_KEY = ["entry-store"] as const;
export const ENTRIES_QUERY_KEY = ["entries"] as const;
export const SYNC_QUERY_KEY = ["sync"] as const;
// Issue #98: `GET /v1/models`, the Question composer's own model picker.
export const MODELS_QUERY_KEY = ["models"] as const;

/**
 * Digest's keys (issue #71), kept here rather than inline in
 * `digest-page.tsx`/`digest-reader-page.tsx` the way Reflection's own keys
 * ended up scattered across `reflection-page.tsx` and `sessions-page.tsx` —
 * that scatter is drift this file exists to avoid, not a precedent to
 * repeat. `digestQueryKey(period)` is what the cards page's three
 * `useQuery` calls key on; `digestAtQueryKey(period, date)` extends it
 * (prefix-invalidatable — TanStack Query's default array-prefix match) for
 * the reader page's single Digest, so invalidating `digestQueryKey("day")`
 * also invalidates every `digestAtQueryKey("day", ...)` already in the
 * cache without either page needing to know the other's key shape.
 */
export function digestQueryKey(period: string) {
  return ["digest", period] as const;
}

export function digestAtQueryKey(period: string, date: string) {
  return ["digest", period, date] as const;
}

/**
 * Issue #79's regression fix: reflection-page.tsx's Grounding-id lookup
 * (`EntryStoreOutletContext.getEntries`, ADR 0013) keyed on the exact,
 * sorted, deduplicated set of ids it's resolving — not on the Session id,
 * so two different asks that happen to ground in the same ids share a
 * cache entry, and a Conversation that grows a new turn with new ids gets
 * a new key (and so a fresh fetch) for free from TanStack Query's own key
 * equality, with no invalidation wiring needed on this end. A child of
 * ENTRIES_QUERY_KEY, mirroring `[...ENTRIES_QUERY_KEY, "search", query]`
 * above — same reasoning: this reads Entries the same local store `list()`
 * and `search()` do, just by id instead of by page or by word.
 */
export function groundingEntriesQueryKey(ids: string[]) {
  return [...ENTRIES_QUERY_KEY, "grounding", ids] as const;
}

/**
 * Issue #142: a date Reference's own "does this day have anything to link
 * to?" check (`dayHasEntries`, day-has-entries.ts). A child of
 * ENTRIES_QUERY_KEY, same reasoning as `groundingEntriesQueryKey` above —
 * this reads Entries the same local store does, just keyed by day rather
 * than by id set. Keyed on the day alone, not the Device's UTC offset too:
 * the offset is read once per Device per session (deviceUtcOffsetMinutes,
 * entry-day.ts) and does not vary per Reference, so folding it into the key
 * would only ever produce one value in practice while making every day's
 * cache entry harder to read in devtools.
 */
export function dayHasEntriesQueryKey(dayKey: string) {
  return [...ENTRIES_QUERY_KEY, "day-has-entries", dayKey] as const;
}

/**
 * Issue #143: an Entry Reference's own "what does the target look like right
 * now?" probe (`getEntry`, entry-store-layout.tsx), which the chip
 * (entry-row.tsx's `EntryReferenceLink`) resolves through. A child of
 * ENTRIES_QUERY_KEY, same shape as `dayHasEntriesQueryKey` above — this
 * reads Entries the same local store does, just keyed by the target's id
 * rather than by day. Keyed on that id alone, so every chip anywhere in the
 * app pointing at the same Entry shares one cache entry and the probe runs
 * at most once per distinct target, not once per occurrence.
 *
 * `refreshNewestEntriesPage` (entries-pagination.ts) invalidates this same
 * prefix on every local write, the same way it does for Search — that is
 * what makes a chip's snippet live rather than a snapshot: editing the
 * target invalidates its cache entry, so every mounted chip pointing at it
 * refetches and shows the new text.
 */
export function entryReferenceQueryKey(entryId: string) {
  return [...ENTRIES_QUERY_KEY, "entry-reference", entryId] as const;
}
