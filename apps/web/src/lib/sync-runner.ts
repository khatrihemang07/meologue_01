import type { EntryStore } from "@meologue/core";
import { sync } from "@meologue/core";
import { queryClient } from "@/lib/query-client";
import { ENTRIES_QUERY_KEY } from "@/lib/query-keys";
import { useSettingsStore } from "@/lib/settings";
import { useSyncStatusStore } from "@/lib/sync-status";
import { syncTransport } from "@/lib/sync-transport";

let syncInFlight: Promise<void> | null = null;
let rerunRequested = false;

// Sync is opt-in (ADR 0011): the Server URL is read fresh on every call, not
// hoisted, so saving or clearing it in Settings takes effect on the very
// next call with no reload. A thrown error is still logged (ticket 40 adds
// to, not replaces, the console) but no longer swallowed silently — it's
// also recorded to `sync-status.ts` so the ambient indicator and Settings'
// detail can both show it, and it keeps retrying on the next trigger either
// way.
async function runSyncOnce(store: EntryStore, deviceId: string): Promise<void> {
  const serverUrl = useSettingsStore.getState().serverUrl;
  if (serverUrl === "") {
    return;
  }
  try {
    await sync({ store, transport: syncTransport, deviceId });
    await queryClient.invalidateQueries({ queryKey: ENTRIES_QUERY_KEY });
    useSyncStatusStore.getState().recordSuccess(serverUrl);
  } catch (error) {
    console.error("meologue: sync failed", error);
    const reason = error instanceof Error ? error.message : String(error);
    useSyncStatusStore.getState().recordFailure(serverUrl, reason);
  }
}

/**
 * Runs at most one sync at a time (ticket 38). A caller that arrives while
 * one is already running — the periodic tick, a wake signal, a Send — isn't
 * silently folded into the run that started before it: that run may have
 * already read `store.pending()` before this caller's Entry existed, so
 * simply reusing its promise would drop the push until the next scheduled
 * tick. Instead, an overlapping caller schedules exactly one more run right
 * after the current one finishes.
 */
export function requestSync(store: EntryStore, deviceId: string): Promise<void> {
  if (syncInFlight) {
    rerunRequested = true;
    return syncInFlight;
  }
  syncInFlight = (async () => {
    do {
      rerunRequested = false;
      await runSyncOnce(store, deviceId);
    } while (rerunRequested);
  })().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}
