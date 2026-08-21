import type { Entry } from "@meologue/core";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Composer } from "@/components/composer";
import { History } from "@/components/history";
import { Nav, SettingsLink } from "@/components/nav";
import { Shell } from "@/components/shell";
import { useHistorySearch } from "@/hooks/use-history-search";
import { useSyncEnabled } from "@/lib/settings";
import { useEntryStore } from "@/pages/entry-store-layout";

// `/` — the Composer plus the same, uncapped History rendered at `/history`
// (ticket 27): identical component, identical props, on the theory that a
// future ticket might cap what shows here without touching the shared
// History component itself.
export function ComposerPage() {
  const { entries, sendEntry, search, editEntry, removeEntry, disabled, message } = useEntryStore();
  // Subscribed, not a one-off read: a change saved on Settings now updates
  // this without a reload or a remount (ticket 36), on top of the render
  // this component already gets when it remounts navigating back from
  // Settings (ADR 0008 — Settings is a sibling route, not a child).
  const syncEnabled = useSyncEnabled();

  // Ticket 55: the magnifier now expands this page's app bar into a search
  // field too, narrowing the same thread History does — see
  // use-history-search.ts for the URL param, sessionStorage backup, and the
  // oldest-to-newest reversal (identical rule to history-page.tsx: `shown`
  // is `entries`, narrowed or not, in the store's own newest-first order;
  // ADR 0014 guarantees a search result arrives in that same order, so
  // reversing after narrowing never flips reading order either way).
  const { query, setQuery, shown, orderedEntries } = useHistorySearch(entries, search);

  // Bumped on every Send, independent of `entries` itself changing (that
  // update lands async, once the store's write settles): the pinned
  // thread (Shell's `pinnedThread`) treats a bump here as "jump to the
  // newest end unconditionally," ticket 53's rule for Send specifically,
  // as opposed to an Entry merely appearing (which only follows if the
  // reader was already pinned — see use-pinned-scroll.ts).
  const [sendSignal, setSendSignal] = useState(0);

  function handleSend(body: string) {
    sendEntry(body);
    setSendSignal((count) => count + 1);
  }

  // ADR 0028: which Entry (if any) the Composer is editing, rather than
  // composing a new one. Owned here, not by Composer itself — see
  // composer.tsx's own `editingEntry` doc comment for why.
  const [editingEntry, setEditingEntry] = useState<Entry | null>(null);

  function handleCommitEdit(id: string, body: string) {
    editEntry(id, body);
    setEditingEntry(null);
  }

  function handleCancelEdit() {
    setEditingEntry(null);
  }

  // history-page.tsx's Edit action has no Composer of its own to edit in
  // (see that page's own comment), so it navigates here instead, carrying
  // only the Entry's id in router state — this page already has the live
  // Entries (the same outlet context history-page.tsx read them from), so
  // it looks the current body up itself rather than trusting a copy that
  // could be stale by the time this effect runs. Read once, on mount, and
  // immediately replaced out of history state so a later Back/Forward
  // through this exact location doesn't silently re-enter edit mode.
  const location = useLocation();
  const navigate = useNavigate();
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately mount-only — see the comment above. Re-running on `entries` or `navigate` identity churn would fight the "consumed once" guarantee this effect exists for.
  useEffect(() => {
    const editEntryId = (location.state as { editEntryId?: string } | null)?.editEntryId;
    if (editEntryId === undefined) {
      return;
    }
    const target = entries.find((entry) => entry.id === editEntryId);
    if (target) {
      setEditingEntry(target);
    }
    navigate(".", { replace: true, state: null });
  }, []);

  return (
    <Shell
      title="meologue"
      // History moved into the persistent Nav (ticket 54) — Settings stays
      // here because it's an app-bar action, not a nav destination (#49).
      action={<SettingsLink />}
      nav={<Nav />}
      message={message}
      search={{ query, onQueryChange: setQuery, onDismiss: () => setQuery("") }}
      footer={
        <History
          entries={orderedEntries}
          syncEnabled={syncEnabled}
          query={query}
          onEdit={setEditingEntry}
          onDelete={removeEntry}
        />
      }
      composerSlot={
        <Composer
          onSend={handleSend}
          disabled={disabled}
          editingEntry={editingEntry}
          onCommitEdit={handleCommitEdit}
          onCancelEdit={handleCancelEdit}
        />
      }
      // `shown`, not `entries`: while a search is narrowing this thread the
      // pin should follow what's actually on screen, same reasoning as
      // history-page.tsx's own pinnedThread.
      pinnedThread={{ watch: shown, forceToNewest: sendSignal }}
    >
      {!syncEnabled && (
        <p className="text-center text-sm text-muted-foreground">
          Sync is off —{" "}
          <Link to="/settings" className="underline underline-offset-2 hover:text-foreground">
            add a Server URL
          </Link>{" "}
          to reach your other Devices.
        </p>
      )}
    </Shell>
  );
}
