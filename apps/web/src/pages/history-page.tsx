import { useEffect } from "react";
import { useSearchParams } from "react-router";
import { History } from "@/components/history";
import { BackLink } from "@/components/nav-links";
import { Shell } from "@/components/shell";
import { Input } from "@/components/ui/input";
import { useEntrySearch } from "@/hooks/use-entry-search";
import { useSyncEnabled } from "@/lib/settings";
import { useEntryStore } from "@/pages/entry-store-layout";

// The URL param Search's query lives in (ticket 39) — in the URL, not
// component state, so it survives a reload and is what makes a search
// linkable.
const QUERY_PARAM = "q";

// Backs up the last active query for this tab (ticket 39). The URL alone
// isn't enough to survive a round trip through Settings: History's only
// route back there is Back -> Composer -> Settings -> Back -> Composer ->
// History, and every link on that path (nav-links.tsx) is a bare, stateless
// `to="/..."` with no query to carry — so the `q` param is gone by the time
// the user lands back on History. This is session-scoped, not a Device
// setting (settings.ts), because it's a transient "where you left off," not
// something the user configured.
const SEARCH_STORAGE_KEY = "meologue.history-search-query";

// `/history` — the full History on its own page, addressable and
// hard-reloadable, sharing store state with `/` via EntryStoreLayout
// (ticket 27).
export function HistoryPage() {
  const { entries, message, search } = useEntryStore();
  // See composer-page.tsx — same subscribed-read rationale.
  const syncEnabled = useSyncEnabled();

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

  return (
    <Shell title="History" message={message}>
      <BackLink />
      <Input
        type="search"
        aria-label="Search History"
        placeholder="Search History"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <History entries={shown} syncEnabled={syncEnabled} query={query} />
    </Shell>
  );
}
