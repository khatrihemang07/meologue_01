import type { Entry } from "@meologue/core";
import { useQuery } from "@tanstack/react-query";
import { ENTRIES_QUERY_KEY } from "@/lib/query-keys";

/**
 * Search (ticket 39): `null` while `query` is empty or whitespace-only —
 * the caller falls back to the unfiltered `entries` it already has, rather
 * than this hook duplicating that fallback. Once a query is active, this
 * always resolves to an array: `fallback` covers both the very first
 * keystroke (no previous search result exists yet) and every keystroke
 * after (`placeholderData` keeps showing the previous search's results
 * while the next one is in flight), so the list never flashes empty
 * between keystrokes.
 *
 * The query key extends `ENTRIES_QUERY_KEY`, so sync's
 * `invalidateQueries({ queryKey: ENTRIES_QUERY_KEY })` (sync-runner.ts)
 * also invalidates whichever search is active, and a matching Entry that
 * arrives by Sync shows up without any extra plumbing here.
 */
export function useEntrySearch(
  search: (query: string) => Promise<Entry[]>,
  query: string,
  fallback: Entry[],
): Entry[] | null {
  const trimmed = query.trim();

  const searchQuery = useQuery({
    queryKey: [...ENTRIES_QUERY_KEY, "search", trimmed],
    queryFn: () => search(trimmed),
    enabled: trimmed !== "",
    placeholderData: (previousData: Entry[] | undefined) => previousData ?? fallback,
  });

  if (trimmed === "") {
    return null;
  }
  return searchQuery.data ?? fallback;
}
