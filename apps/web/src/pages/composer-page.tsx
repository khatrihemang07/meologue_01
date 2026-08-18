import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Composer } from "@/components/composer";
import { History } from "@/components/history";
import { Nav, SettingsLink } from "@/components/nav";
import { Shell } from "@/components/shell";
import { useSyncEnabled } from "@/lib/settings";
import { useEntryStore } from "@/pages/entry-store-layout";

// `/` — the Composer plus the same, uncapped History rendered at `/history`
// (ticket 27): identical component, identical props, on the theory that a
// future ticket might cap what shows here without touching the shared
// History component itself.
export function ComposerPage() {
  const { entries, sendEntry, disabled, message } = useEntryStore();
  // Subscribed, not a one-off read: a change saved on Settings now updates
  // this without a reload or a remount (ticket 36), on top of the render
  // this component already gets when it remounts navigating back from
  // Settings (ADR 0008 — Settings is a sibling route, not a child).
  const syncEnabled = useSyncEnabled();

  // `entries` arrives newest-first (`list()`'s own order — see
  // history.tsx's groupByDay comment); ticket 53 reverses that to
  // oldest-first reading order here, in the view, and only for this
  // Composer-adjacent thread. The store's own ordering is untouched, and
  // Search (history-page.tsx) still reads whatever order the store hands
  // it (ADR 0014) — this reversal is local to what renders next to the
  // Composer.
  const orderedEntries = useMemo(() => entries.slice().reverse(), [entries]);

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

  return (
    <Shell
      title="meologue"
      // History moved into the persistent Nav (ticket 54) — Settings stays
      // here because it's an app-bar action, not a nav destination (#49).
      action={<SettingsLink />}
      nav={<Nav />}
      message={message}
      footer={<History entries={orderedEntries} syncEnabled={syncEnabled} />}
      composerSlot={<Composer onSend={handleSend} disabled={disabled} />}
      pinnedThread={{ watch: entries, forceToNewest: sendSignal }}
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
