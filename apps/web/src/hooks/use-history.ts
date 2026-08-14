import type { Entry, EntryStore } from "@meologue/core";
import { mintId, SYNC_INTERVAL_MS, startContinuousSync, sync } from "@meologue/core";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { normalizeEntryBody } from "@/lib/entry-text";
import { syncTransport } from "@/lib/sync-transport";
import { isTabVisible, subscribeToWakeEvents } from "@/platform/wake-signals";

export interface UseHistoryResult {
  entries: Entry[];
  sendEntry: (raw: string) => void;
}

type Listener = () => void;

// Module scope, not per-hook-instance (ADR 0009): a Device has exactly one
// History and one sync loop for the life of a page load, and EntryStoreLayout
// — the only thing that calls this hook — unmounts whenever the user
// navigates to Settings (a sibling route, per ADR 0008) and remounts when
// they navigate back. Keeping entries and the sync loop here rather than in
// component state means that round trip doesn't stop and restart sync, and
// whichever component instance is mounted afterward still sees live
// updates, because it's reading this shared snapshot rather than one tied
// to whichever mount started the loop.
let entries: Entry[] = [];
const listeners = new Set<Listener>();
let continuousSyncStarted = false;
let syncInFlight: Promise<void> | null = null;

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

async function refresh(store: EntryStore) {
  entries = await store.list();
  notify();
}

// Coalesces overlapping calls (e.g. a Send arriving mid-poll) into the
// single in-flight sync rather than racing two against the same store.
function runSync(store: EntryStore, deviceId: string): Promise<void> {
  syncInFlight ??= (async () => {
    await sync({ store, transport: syncTransport, deviceId });
    await refresh(store);
  })().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

async function runSyncSilently(store: EntryStore, deviceId: string) {
  try {
    await runSync(store, deviceId);
  } catch (error) {
    console.error("meologue: sync failed", error);
  }
}

// Started once per page load and never stopped: continuing to run while the
// user is on Settings is the point (ADR 0009) — there is no longer a
// component whose unmount could plausibly pause it. The first call's `store`
// and `deviceId` are what the loop runs with for the rest of the page's
// life — later calls are no-ops. That's fine only because a Device has
// exactly one store and one deviceId per page load (ADR 0001); this
// function would need rethinking if that ever stopped being true.
//
// Exported so EntryStoreLayout can call it the moment the store finishes
// opening, not only once useHistory itself mounts — a user who navigates to
// Settings before the store resolves would otherwise never mount
// useHistory in this page load at all, and sync would never start.
export function ensureContinuousSync(store: EntryStore, deviceId: string) {
  if (continuousSyncStarted) {
    return;
  }
  continuousSyncStarted = true;
  startContinuousSync({
    run: () => runSyncSilently(store, deviceId),
    intervalMs: SYNC_INTERVAL_MS,
    isVisible: isTabVisible,
    subscribe: subscribeToWakeEvents,
  });
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Entry[] {
  return entries;
}

/**
 * Owns this Device's History: sync orchestration against an injected store
 * (ADR 0001 — the store's concrete implementation is a composition-root
 * concern, not this hook's) and the continuous sync engine wired to the
 * server. An Entry renders from the local write immediately; sync runs
 * afterward and keeps running for the life of the page (ADR 0009) — on an
 * interval while the tab is visible, and on regaining focus/coming online —
 * silently refreshing whichever component is currently reading History.
 */
export function useHistory(store: EntryStore, deviceId: string): UseHistoryResult {
  const currentEntries = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    void refresh(store);
    ensureContinuousSync(store, deviceId);
  }, [store, deviceId]);

  const sendEntry = useCallback(
    (raw: string) => {
      const body = normalizeEntryBody(raw);
      if (body === null) {
        return;
      }

      const entry: Entry = {
        id: mintId(),
        deviceId,
        body,
        createdAt: new Date().toISOString(),
        seq: null,
        syncedAt: null,
      };

      void (async () => {
        await store.upsert([entry]);
        await refresh(store);
        await runSyncSilently(store, deviceId);
      })();
    },
    [deviceId, store],
  );

  return { entries: currentEntries, sendEntry };
}
