import type { Entry } from "@meologue/core";
import { useNavigate } from "react-router";
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
  const { entries, message, search, removeEntry } = useEntryStore();
  // See composer-page.tsx — same subscribed-read rationale.
  const syncEnabled = useSyncEnabled();

  // ADR 0028: this page has no Composer (nothing here Sends — see the
  // pinnedThread comment below), and editing happens in the Composer, not
  // inline (composer.tsx's own comment says why). So Edit here navigates to
  // `/` carrying only the chosen Entry's id in router state; composer-page.tsx
  // reads it once on mount and looks the current Entry up from its own
  // outlet context. The alternative — an inline editor on this page — was
  // rejected precisely because it would have to relearn everything the
  // docked Composer already handles (growth, the Android keyboard, safe
  // areas) for a second input surface. Delete needs no such redirect: it's
  // a single action with an Undo toast (use-history.ts), so it works here
  // exactly as it does on `/`.
  const navigate = useNavigate();
  function handleEditRequest(entry: Entry) {
    navigate("/", { state: { editEntryId: entry.id } });
  }

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
      <History
        entries={orderedEntries}
        syncEnabled={syncEnabled}
        query={query}
        onEdit={handleEditRequest}
        onDelete={removeEntry}
      />
    </Shell>
  );
}
