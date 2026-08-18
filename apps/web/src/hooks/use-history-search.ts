import type { Entry } from "@meologue/core";
import { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router";
import { useEntrySearch } from "@/hooks/use-entry-search";

// The URL param Search's query lives in (ticket 39) — in the URL, not
// component state, so it survives a reload and is what makes a search
// linkable. Shared by both destinations Search now works on (ticket 55:
// moving the field into the app bar is what finally makes the UI agree
// with CONTEXT.md's "narrows History in place rather than producing a
// separate collection" on the Composer, not only on `/history`).
const QUERY_PARAM = "q";

// Backs up the last active query for this tab (ticket 39, extended to the
// Composer by ticket 55). The URL alone isn't enough to survive a round
// trip through Settings, or a trip between Composer and History: the
// persistent Nav (nav.tsx) and the Settings action are bare, stateless
// `to="/..."` links with no query to carry, so the `q` param is gone by the
// time the reader lands back on either page. This is session-scoped, not a
// Device setting (settings.ts), because it's a transient "where you left
// off," not something the user configured. One key for both destinations,
// deliberately: they narrow the same thread, so a search started on one and
// continued on the other should read as the same search, not two.
const SEARCH_STORAGE_KEY = "meologue.history-search-query";

export interface UseHistorySearchResult {
  /** The active query, "" when Search isn't narrowing anything. */
  query: string;
  /** Ticket 55: passed straight through to Shell's `search.onQueryChange`. */
  setQuery: (next: string) => void;
  /**
   * Narrowed (or, with no query, unfiltered) Entries in the store's own
   * order — newest-first, ADR 0014. Exposed pre-reversal for callers that
   * need a stable identity to watch (Shell's `pinnedThread.watch`), same as
   * history-page.tsx's `shown` before this ticket.
   */
  shown: Entry[];
  /**
   * `shown` reversed to oldest-to-newest reading order (ticket 53) — what
   * both pages actually render. Reversing after search rather than before
   * is what keeps the ordering right for both the unfiltered and the
   * narrowed cases, since both flow through `shown`; `search()` is
   * contractually the same order as `list()` (ADR 0014), so a narrowed
   * thread reads exactly like the full one, on the Composer as much as on
   * History.
   */
  orderedEntries: Entry[];
}

/**
 * Search's page-level wiring (ticket 39, generalised by ticket 55 to back
 * both `/` and `/history` identically): the URL param, the sessionStorage
 * backup, the search query itself, and the display-order reversal. Both
 * pages call this the same way and hand the result to Shell's `search`
 * prop — this is what makes "search narrows the thread on both the
 * Composer and History" true by sharing one implementation rather than two
 * copies that could drift.
 */
export function useHistorySearch(
  entries: Entry[],
  search: (query: string) => Promise<Entry[]>,
): UseHistorySearchResult {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get(QUERY_PARAM);

  // Restores a query backed up before an earlier visit dropped it (see
  // SEARCH_STORAGE_KEY above) — only when this load's URL has no query of
  // its own, so a reload or a direct link (which already has the real
  // answer in the URL) is never second-guessed by a stale session value.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally mount-only — this restores what an *earlier* visit left behind, not what this visit's own edits do (the effect below handles those), so it must not re-run every time urlQuery changes as a result of typing.
  useEffect(() => {
    if (urlQuery !== null) {
      return;
    }
    const stored = sessionStorage.getItem(SEARCH_STORAGE_KEY);
    if (!stored) {
      return;
    }
    setSearchParams(
      (previous) => {
        const params = new URLSearchParams(previous);
        params.set(QUERY_PARAM, stored);
        return params;
      },
      { replace: true },
    );
  }, []);

  const query = urlQuery ?? "";

  useEffect(() => {
    if (query.trim() === "") {
      sessionStorage.removeItem(SEARCH_STORAGE_KEY);
    } else {
      sessionStorage.setItem(SEARCH_STORAGE_KEY, query);
    }
  }, [query]);

  // Search (ticket 39): narrows `entries` in place rather than being a
  // separate collection — `null` (no query) falls back to the unfiltered
  // `entries` this page already has.
  const searchResults = useEntrySearch(search, query, entries);
  const shown = searchResults ?? entries;

  const orderedEntries = useMemo(() => shown.slice().reverse(), [shown]);

  function setQuery(next: string) {
    setSearchParams(
      (previous) => {
        const params = new URLSearchParams(previous);
        if (next.trim() === "") {
          params.delete(QUERY_PARAM);
        } else {
          params.set(QUERY_PARAM, next);
        }
        return params;
      },
      // Every keystroke replaces the current history entry rather than
      // pushing a new one — otherwise the back button would have to step
      // through the search one character at a time to leave the page.
      { replace: true },
    );
  }

  return { query, setQuery, shown, orderedEntries };
}
