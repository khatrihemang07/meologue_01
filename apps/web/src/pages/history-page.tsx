import { History } from "@/components/history";
import { Nav, SettingsLink } from "@/components/nav";
import { Shell } from "@/components/shell";
import { useHistorySearch } from "@/hooks/use-history-search";
import { useSyncEnabled } from "@/lib/settings";
import { useEntryStore } from "@/pages/entry-store-layout";

// `/history` — the full History on its own page, addressable and
// hard-reloadable, sharing store state with `/` via EntryStoreLayout
// (ticket 27).
export function HistoryPage() {
  const { entries, message, search } = useEntryStore();
  // See composer-page.tsx — same subscribed-read rationale.
  const syncEnabled = useSyncEnabled();

  // Ticket 55: the URL param, sessionStorage backup, and display-order
  // reversal all now live in one hook shared with composer-page.tsx — see
  // use-history-search.ts for the reasoning that used to live here.
  const { query, setQuery, shown, orderedEntries } = useHistorySearch(entries, search);

  return (
    <Shell
      title="History"
      action={<SettingsLink />}
      nav={<Nav />}
      message={message}
      // Ticket 55: the magnifier turns this app bar into the search field
      // in place — no more separate Input rendered in the page body (see
      // git history pre-#55 for the old inline box). `onDismiss` clears the
      // query the same way an empty keystroke would; Shell has no notion of
      // "query" beyond that.
      search={{ query, onQueryChange: setQuery, onDismiss: () => setQuery("") }}
      // Ticket 53: /history gets the same conditional pin as the
      // Composer-adjacent thread — it has no Composer to force a jump from
      // (nothing here Sends), so only `watch` is wired, following newly
      // appeared or newly narrowed content but only while already at the
      // newest end. `shown` (not `entries`) is what's watched: it's what's
      // actually on screen, so an Entry arriving from Sync while a search
      // is narrowing the view is followed by the same rule.
      pinnedThread={{ watch: shown }}
    >
      <History entries={orderedEntries} syncEnabled={syncEnabled} query={query} />
    </Shell>
  );
}
