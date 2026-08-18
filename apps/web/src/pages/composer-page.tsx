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

  return (
    <Shell
      title="meologue"
      // History moved into the persistent Nav (ticket 54) — Settings stays
      // here because it's an app-bar action, not a nav destination (#49).
      action={<SettingsLink />}
      nav={<Nav />}
      message={message}
      footer={<History entries={entries} syncEnabled={syncEnabled} />}
      composerSlot={<Composer onSend={sendEntry} disabled={disabled} />}
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
