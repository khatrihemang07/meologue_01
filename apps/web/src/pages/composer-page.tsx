import { Link } from "react-router";
import { Composer } from "@/components/composer";
import { History } from "@/components/history";
import { HistoryLink, SettingsLink } from "@/components/nav-links";
import { Shell } from "@/components/shell";
import { isSyncEnabled } from "@/lib/settings";
import { useEntryStore } from "@/pages/entry-store-layout";

// `/` — the Composer plus the same, uncapped History rendered at `/history`
// (ticket 27): identical component, identical props, on the theory that a
// future ticket might cap what shows here without touching the shared
// History component itself.
export function ComposerPage() {
  const { entries, sendEntry, disabled, message } = useEntryStore();
  // Read fresh on every render rather than cached in state: this component
  // remounts on navigating back from Settings (ADR 0008 — Settings is a
  // sibling route, not a child), so the plain read already picks up a
  // change without a reload (ticket 32) with no extra state to keep in
  // sync.
  const syncEnabled = isSyncEnabled();

  return (
    <Shell
      title="Meologue"
      action={
        <div className="flex items-center gap-3">
          <HistoryLink />
          <SettingsLink />
        </div>
      }
      message={message}
      footer={<History entries={entries} syncEnabled={syncEnabled} />}
    >
      <Composer onSend={sendEntry} disabled={disabled} />
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
