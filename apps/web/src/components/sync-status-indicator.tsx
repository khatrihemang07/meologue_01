import { useSyncStatus } from "@/lib/sync-status";
import { cn } from "@/lib/utils";

// Ambient, always-present (ticket 40) — a quiet dot, not text, so it never
// competes with the page's own content and never fires per retry (Sync
// retries every few seconds; anything louder than a static dot would be
// unusable). The failure's reason lives on Settings only (see
// settings-page.tsx), next to the Server URL that caused it — this just
// says which of the three states Sync is in.
const COPY = {
  off: "Sync is off",
  working: "Sync is working",
  failing: "Sync is failing",
} as const;

export function SyncStatusIndicator() {
  const status = useSyncStatus();

  return (
    <span
      data-testid="sync-status-indicator"
      role="img"
      aria-label={COPY[status.state]}
      title={COPY[status.state]}
      className={cn("inline-block size-2 shrink-0 rounded-full", {
        "bg-muted-foreground/50": status.state === "off",
        "bg-primary": status.state === "working",
        "bg-destructive": status.state === "failing",
      })}
    />
  );
}
