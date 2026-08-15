import type { EntryStore } from "@meologue/core";
import { sync } from "@meologue/core";
import { queryClient } from "@/lib/query-client";
import { ENTRIES_QUERY_KEY } from "@/lib/query-keys";
import { isSyncEnabled } from "@/lib/settings";
import { syncTransport } from "@/lib/sync-transport";

let syncInFlight: Promise<void> | null = null;
let rerunRequested = false;

// Sync is opt-in (ADR 0011): `isSyncEnabled()` is read fresh on every call,
// not hoisted, so saving or clearing the Server URL in Settings takes
// effect on the very next call with no reload. Errors are swallowed (after
// logging) rather than left to land in the caller's `error` state — a
// failed sync attempt isn't surfaced to the UI, it just retries on the next
// trigger.
async function runSyncOnce(store: EntryStore, deviceId: string): Promise<void> {
  if (!isSyncEnabled()) {
    return;
  }
  try {
    await sync({ store, transport: syncTransport, deviceId });
    await queryClient.invalidateQueries({ queryKey: ENTRIES_QUERY_KEY });
  } catch (error) {
    console.error("meologue: sync failed", error);
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
