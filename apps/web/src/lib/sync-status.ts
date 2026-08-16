/**
 * Sync status (ticket 40): whether this Device's Sync is off, working, or
 * failing, kept in a Zustand store so the ambient indicator (Shell) and the
 * detailed reason (Settings) both stay live off the same state, with no
 * reload needed on either side.
 *
 * "Off" isn't recorded here — it's derived in `useSyncStatus` straight from
 * `useSettingsStore`'s Server URL (ADR 0011: empty means off), since off
 * always wins regardless of what an earlier attempt against a *previous*
 * URL last recorded.
 *
 * `url` keys the last recorded attempt to the Server URL it was made
 * against, mirroring `settings-page.tsx`'s existing `check.url === serverUrl`
 * pattern: editing the Server URL without a successful attempt against the
 * new value yet must not keep showing a stale failure from the old one.
 */
import { create } from "zustand";
import { useSettingsStore } from "@/lib/settings";

type Attempt =
  | { url: string; outcome: "working" }
  | { url: string; outcome: "failing"; reason: string };

interface SyncStatusState {
  lastAttempt: Attempt | null;
  recordSuccess: (url: string) => void;
  recordFailure: (url: string, reason: string) => void;
}

export const useSyncStatusStore = create<SyncStatusState>()((set) => ({
  lastAttempt: null,
  recordSuccess: (url) => set({ lastAttempt: { url, outcome: "working" } }),
  recordFailure: (url, reason) => set({ lastAttempt: { url, outcome: "failing", reason } }),
}));

export type SyncStatus =
  | { state: "off" }
  | { state: "working" }
  | { state: "failing"; reason: string };

/**
 * A Server URL with no recorded attempt against it yet (freshly configured,
 * or just edited) reads as "working" rather than a fourth "unknown" state —
 * optimistic until the next tick says otherwise, same as before this ticket
 * when nothing was shown at all.
 */
export function useSyncStatus(): SyncStatus {
  const serverUrl = useSettingsStore((state) => state.serverUrl);
  const lastAttempt = useSyncStatusStore((state) => state.lastAttempt);

  if (serverUrl === "") {
    return { state: "off" };
  }
  if (lastAttempt?.url === serverUrl && lastAttempt.outcome === "failing") {
    return { state: "failing", reason: lastAttempt.reason };
  }
  return { state: "working" };
}
