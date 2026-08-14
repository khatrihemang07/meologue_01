import { Composer } from "@/components/composer";
import { History } from "@/components/history";
import { HistoryLink, SettingsLink } from "@/components/nav-links";
import { Shell } from "@/components/shell";
import { useEntryStore } from "@/pages/entry-store-layout";

// `/` — the Composer plus the same, uncapped History rendered at `/history`
// (ticket 27): identical component, identical props, on the theory that a
// future ticket might cap what shows here without touching the shared
// History component itself.
export function ComposerPage() {
  const { entries, sendEntry, disabled, message } = useEntryStore();

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
      footer={<History entries={entries} />}
    >
      <Composer onSend={sendEntry} disabled={disabled} />
    </Shell>
  );
}
