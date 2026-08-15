import type { Entry, EntryStore } from "@meologue/core";
import { mintId, SYNC_INTERVAL_MS, startContinuousSync, sync } from "@meologue/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { normalizeEntryBody } from "@/lib/entry-text";
import { queryClient } from "@/lib/query-client";
import { isSyncEnabled } from "@/lib/settings";
import { syncTransport } from "@/lib/sync-transport";
import { isTabVisible, subscribeToWakeEvents } from "@/platform/wake-signals";

export interface UseHistoryResult {
  entries: Entry[];
  sendEntry: (raw: string) => void;
}

export const ENTRIES_QUERY_KEY = ["entries"] as const;

// Module scope, not per-hook-instance (ADR 0013): a Device has exactly one
// sync loop for the life of a page load, and it must keep running while
// EntryStoreLayout — the only thing that calls this hook — is unmounted
// (the user is on Settings, a sibling route per ADR 0008).
let continuousSyncStarted = false;
let syncInFlight: Promise<void> | null = null;

// Coalesces overlapping calls (e.g. a Send arriving mid-poll) into the
// single in-flight sync rather than racing two against the same store.
//
// Sync is opt-in (ADR 0011): with no Server URL configured, this is a no-op
// — no store read, no request. `isSyncEnabled()` is read fresh on every
// call rather than once at startup, so saving or clearing the address in
// Settings takes effect on the very next tick with no reload.
function runSync(store: EntryStore, deviceId: string): Promise<void> {
  if (!isSyncEnabled()) {
    return Promise.resolve();
  }
  syncInFlight ??= (async () => {
    await sync({ store, transport: syncTransport, deviceId });
    await queryClient.invalidateQueries({ queryKey: ENTRIES_QUERY_KEY });
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
// user is on Settings is the point (ADR 0013) — there is no longer a
// component whose unmount could plausibly pause it. The first call's
// `store` and `deviceId` are what the loop runs with for the rest of the
// page's life — later calls are no-ops. That's fine only because a Device
// has exactly one store and one deviceId per page load (ADR 0001); this
// function would need rethinking if that ever stopped being true.
//
// Called from entry-store-layout.tsx's queryFn, not from a component effect
// — the moment the store finishes opening, regardless of whether the
// component that triggered that fetch is still mounted to see it (a user
// who navigates to Settings before the store resolves unmounts
// EntryStoreLayout, but TanStack Query keeps the underlying fetch — and
// this call inside it — running to completion anyway).
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

/**
 * Owns this Device's History: a TanStack Query query for `store.list()` and
 * a mutation for Sending an Entry (ADR 0013). An Entry renders from the
 * local write immediately — the mutation's `onSuccess` awaits the entries
 * query's invalidation before kicking off sync — and sync runs afterward,
 * silently refreshing the same query for the life of the page.
 */
export function useHistory(store: EntryStore, deviceId: string): UseHistoryResult {
  const entriesQuery = useQuery({
    queryKey: ENTRIES_QUERY_KEY,
    queryFn: () => store.list(),
  });

  const sendEntryMutation = useMutation({
    mutationFn: (entry: Entry) => store.upsert([entry]),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ENTRIES_QUERY_KEY });
      void runSyncSilently(store, deviceId);
    },
  });

  function sendEntry(raw: string) {
    const body = normalizeEntryBody(raw);
    if (body === null) {
      return;
    }
    sendEntryMutation.mutate({
      id: mintId(),
      deviceId,
      body,
      createdAt: new Date().toISOString(),
      seq: null,
      syncedAt: null,
    });
  }

  return { entries: entriesQuery.data ?? [], sendEntry };
}
