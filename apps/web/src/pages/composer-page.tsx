import type { Entry } from "@meologue/core";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Composer } from "@/components/composer";
import { History } from "@/components/history";
import { Nav } from "@/components/nav";
import { Shell } from "@/components/shell";
import { useHistorySearch } from "@/hooks/use-history-search";
import { useSyncEnabled } from "@/lib/settings";
import { useEntryStore } from "@/pages/entry-store-layout";

// `/` — the Composer plus the same, uncapped History that had its own
// route at `/history` before issue #75 deleted it (a second door onto the
// identical component with the identical props, once judged redundant).
// Uncapped on the theory that a future ticket might cap what shows here
// without touching the shared History component itself.
export function ComposerPage() {
  const { entries, pagination, sendEntry, search, editEntry, removeEntry, disabled, message } =
    useEntryStore();
  // Subscribed, not a one-off read: a change saved on Settings now updates
  // this without a reload or a remount (ticket 36), on top of the render
  // this component already gets when it remounts navigating back from
  // Settings (ADR 0008 — Settings is a sibling route, not a child).
  const syncEnabled = useSyncEnabled();

  // Ticket 55: the magnifier now expands this page's app bar into a search
  // field too, narrowing the same thread History does — see
  // use-history-search.ts for the URL param, sessionStorage backup, and the
  // oldest-to-newest reversal: `shown` is `entries`, narrowed or not, in
  // the store's own newest-first order; ADR 0014 guarantees a search
  // result arrives in that same order, so reversing after narrowing never
  // flips reading order either way.
  const { query, setQuery, shown, orderedEntries } = useHistorySearch(entries, search);

  // Bumped on every Send, independent of `entries` itself changing (that
  // update lands async, once the store's write settles): the pinned
  // thread (Shell's `pinnedThread`) treats a bump here as "jump to the
  // newest end unconditionally," ticket 53's rule for Send specifically,
  // as opposed to an Entry merely appearing (which only follows if the
  // reader was already pinned — see use-pinned-scroll.ts).
  //
  // Seeded `undefined`, not `0` (issue #81): `usePinnedScroll`'s own
  // `forceToNewest` guard is `if (forceToNewest === undefined) return`,
  // specifically so a mount — where nothing has been Sent yet — does
  // nothing. Seeding this at `0` defeated that guard (`0 !== undefined`),
  // so every mount of this page ran a *second* unconditional
  // `scrollToNewest` back to back with the `watch` effect's own one,
  // forcing the full-list layout read `scrollToNewest` does
  // (`el.scrollHeight`) twice for no reason. The type stays `number |
  // undefined` rather than switching to a boolean or a Date, because all
  // that ever mattered here is "has this changed since last render" —
  // `usePinnedScroll` only compares identity, never reads the value.
  const [sendSignal, setSendSignal] = useState<number | undefined>(undefined);

  function handleSend(body: string) {
    sendEntry(body);
    // `?? 0` covers the first Send specifically: `undefined + 1` is `NaN`,
    // and — because `Object.is(NaN, NaN)` is `true` — a *second* Send would
    // then leave `forceToNewest` looking unchanged to the effect's
    // dependency check (`NaN` to `NaN`) and silently stop forcing the jump
    // from then on.
    setSendSignal((count) => (count ?? 0) + 1);
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

  // Reads an `editEntryId` a caller with no Composer of its own to edit in
  // navigates here with, in router state, rather than trusting a copy of
  // the Entry that could be stale by the time this effect runs — this page
  // already has the live Entries, so it looks the current body up itself
  // from `entries` instead. Read once, on mount, and immediately replaced
  // out of history state so a later Back/Forward through this exact
  // location doesn't silently re-enter edit mode.
  //
  // Vestigial since issue #75: `/history`'s own page was this mechanism's
  // only caller (its Edit action navigated to `/` this way, since it had
  // no Composer of its own), and issue #75 deleted that page outright
  // rather than redirecting it — nothing in the app sets `editEntryId`
  // today. Left in place rather than removed: it's inert, not broken (no
  // caller means this effect's `editEntryId === undefined` branch always
  // returns early), and it's exactly the kind of pre-existing behaviour a
  // route-deletion ticket shouldn't also be second-guessing. Worth a
  // dedicated follow-up if `/history` truly has no successor arriving.
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
      // No `action` slot here any more (issue #75): History and Settings
      // both moved into the persistent Nav — History by being deleted
      // outright (this page already renders the same Entries through the
      // same History component; see history.tsx's own comment), Settings
      // by becoming Nav's fourth destination instead of an app-bar gear.
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
      // pin should follow what's actually on screen.
      //
      // `pagination` is issue #79's own "load older" glue — passed through
      // unconditionally rather than only while `query` is empty, because
      // Search is unbounded (ADR 0014's search() reads unpaged) and
      // whatever page History has already loaded stays available to widen
      // further once the reader dismisses Search and returns to it.
      // ownsBottomAlignment (issue #83): History is virtualized and handles
      // its own bottom alignment via a leading spacer sized off its own
      // virtualizer — see PinnedThreadConfig's own comment for why Shell's
      // plain `min-h-full justify-end` treatment has to stand down for it.
      pinnedThread={{
        watch: shown,
        forceToNewest: sendSignal,
        pagination,
        ownsBottomAlignment: true,
      }}
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
