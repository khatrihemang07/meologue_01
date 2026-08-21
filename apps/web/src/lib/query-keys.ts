/**
 * Query keys shared across the Entry store, History, and the Sync loop
 * (ticket 38) — pulled out on their own so `use-sync-loop.ts`,
 * `entry-store-layout.tsx`, and `use-history.ts` can all reference the same
 * key without importing one another and creating a cycle.
 */
export const ENTRY_STORE_QUERY_KEY = ["entry-store"] as const;
export const ENTRIES_QUERY_KEY = ["entries"] as const;
export const SYNC_QUERY_KEY = ["sync"] as const;

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
