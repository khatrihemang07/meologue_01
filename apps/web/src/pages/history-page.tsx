import { History } from "@/components/history";
import { BackLink } from "@/components/nav-links";
import { Shell } from "@/components/shell";
import { readServerUrl } from "@/lib/settings";
import { useEntryStore } from "@/pages/entry-store-layout";

// `/history` — the full History on its own page, addressable and
// hard-reloadable, sharing store state with `/` via EntryStoreLayout
// (ticket 27).
export function HistoryPage() {
  const { entries, message } = useEntryStore();
  // See composer-page.tsx — same fresh-read-on-render rationale.
  const syncEnabled = readServerUrl() !== "";

  return (
    <Shell title="History" message={message}>
      <BackLink />
      <History entries={entries} syncEnabled={syncEnabled} />
    </Shell>
  );
}
