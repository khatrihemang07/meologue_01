import type { EntryStore, TaskStore } from "@meologue/core";
import { sync } from "@meologue/core";
import { refreshNewestEntriesPage } from "@/lib/entries-pagination";
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
async function runSyncOnce(
  store: EntryStore,
  taskStore: TaskStore,
  deviceId: string,
): Promise<void> {
  const serverUrl = useSettingsStore.getState().serverUrl;
  if (serverUrl === "") {
    return;
  }
  try {
    await sync({ store, taskStore, transport: syncTransport, deviceId });
    // Issue #79: refreshes the newest loaded page only, not every page the
    // reader has scrolled back through — see refreshNewestEntriesPage's own
    // doc comment (entries-pagination.ts) for why a whole-key invalidation
    // (this call's shape before this ticket) would make every sync tick
    // progressively more expensive the further back the reader has
    // scrolled, and why "newest page only" is still correct for what a
    // sync pull can actually change.
    await refreshNewestEntriesPage(store);
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
export function requestSync(
  store: EntryStore,
  taskStore: TaskStore,
  deviceId: string,
): Promise<void> {
  if (syncInFlight) {
    rerunRequested = true;
    return syncInFlight;
  }
  syncInFlight = (async () => {
    do {
      rerunRequested = false;
      await runSyncOnce(store, taskStore, deviceId);
    } while (rerunRequested);
  })().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}
