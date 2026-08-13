import type { Entry, EntryStore } from "@meologue/core";
import { mintId, SYNC_INTERVAL_MS, startContinuousSync, sync } from "@meologue/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeEntryBody } from "@/lib/entry-text";
import { syncTransport } from "@/lib/sync-transport";
import { isTabVisible, subscribeToWakeEvents } from "@/platform/wake-signals";

export interface UseHistoryResult {
  entries: Entry[];
  sendEntry: (raw: string) => void;
}

/**
 * Owns this Device's History: sync orchestration against an injected store
 * (ADR 0001 — the store's concrete implementation is a composition-root
 * concern, not this hook's) and the continuous sync engine wired to the
 * server. An Entry renders from the local write immediately; sync runs
 * afterward and keeps running — on an interval while the tab is visible,
 * and on regaining focus/coming online — silently refreshing the view
 * whenever anything changes (ticket 11).
 */
export function useHistory(store: EntryStore, deviceId: string): UseHistoryResult {
  const [entries, setEntries] = useState<Entry[]>([]);
  const syncInFlight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    setEntries(await store.list());
  }, [store]);

  // Coalesces overlapping calls (e.g. a Send arriving mid-poll) into the
  // single in-flight sync rather than racing two against the same store.
  const runSync = useCallback((): Promise<void> => {
    syncInFlight.current ??= (async () => {
      await sync({ store, transport: syncTransport, deviceId });
      await refresh();
    })().finally(() => {
      syncInFlight.current = null;
    });
    return syncInFlight.current;
  }, [store, deviceId, refresh]);

  const runSyncSilently = useCallback(async () => {
    try {
      await runSync();
    } catch (error) {
      console.error("meologue: sync failed", error);
    }
  }, [runSync]);

  useEffect(() => {
    void refresh();

    const handle = startContinuousSync({
      run: runSyncSilently,
      intervalMs: SYNC_INTERVAL_MS,
      isVisible: isTabVisible,
      subscribe: subscribeToWakeEvents,
    });
    // Navigating away from the history page (e.g. to Settings, ticket 25)
    // unmounts this hook, and this cleanup stops continuous sync with it;
    // navigating back remounts the hook and sync resumes. Intended — there's
    // no History on screen to keep fresh while the page is somewhere else.
    return () => handle.stop();
  }, [refresh, runSyncSilently]);

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
        await refresh();
        await runSyncSilently();
      })();
    },
    [deviceId, store, refresh, runSyncSilently],
  );

  return { entries, sendEntry };
}
