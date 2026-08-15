import type { Entry, EntryStore } from "@meologue/core";
import { open } from "@meologue/core";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Outlet, useOutletContext } from "react-router";
import { useHistory } from "@/hooks/use-history";
import { SecondTabError, StorageUnavailableError } from "@/lib/entry-store-errors";
import { ENTRY_STORE_QUERY_KEY } from "@/lib/query-keys";
import { createDriver } from "@/platform/sqlite-driver";

export interface EntryStoreOutletContext {
  entries: Entry[];
  sendEntry: (raw: string) => void;
  disabled: boolean;
  message?: string;
}

// This is the composition root for the sqlite-driver seam (ticket 24): each
// platform file supplies only a driver, and the store is opened here, once,
// rather than duplicated per platform.
async function openEntryStore() {
  const driver = await createDriver();
  return open(driver);
}

// Exported so `SyncLoop` (`use-sync-loop.ts`, ticket 38) can subscribe to
// the exact same query — same key, same queryFn, same options — so the
// cache still opens the store at most once per page load, whichever of the
// two mounts first. `retry` and `retryOnMount` both matter together (see
// the comment below); keeping them in one `queryOptions()` object rather
// than duplicated in two `useQuery` calls means a future change to either
// can't drift between the two call sites.
export const entryStoreQueryOptions = queryOptions({
  queryKey: ENTRY_STORE_QUERY_KEY,
  queryFn: openEntryStore,
  // A Device has exactly one store for the life of a page load (ADR 0001):
  // never stale, never garbage-collected, never retried — a SecondTabError
  // or StorageUnavailableError is not transient, and retrying would mean a
  // second openEntryStore() call spinning up a second Worker competing with
  // the first for the same OPFS pool lock.
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
  retry: false,
  // `retry: false` only governs retries within one fetch attempt — it does
  // nothing about `retryOnMount` (default `true`), which re-runs queryFn
  // for a *new* observer of an already-errored query. Without this, a
  // Settings round trip after a failed open remounts EntryStoreLayout,
  // which mounts a fresh observer, which re-fetches — reopening a second
  // Worker against the same OPFS pool lock, exactly what the settings
  // above exist to prevent. Only the error path is affected: a
  // successfully-resolved query is never stale (staleTime: Infinity), so
  // it's already skipped on remount regardless of this setting.
  retryOnMount: false,
});

function describeOpenError(error: unknown): string {
  if (error instanceof SecondTabError) {
    return "meologue is already open in another tab. Close it there, or continue in this one.";
  }
  if (error instanceof StorageUnavailableError) {
    return "meologue can't store Entries here — try a non-private window over HTTPS or localhost.";
  }
  console.error("meologue: failed to open the entry store", error);
  return "meologue couldn't open its storage. Reloading may help.";
}

function noop() {}

/**
 * The composition root for ADR 0001 and ADR 0013: opens the Entry store and
 * runs `useHistory` exactly once, above the routes that read from it — `/`
 * and `/history` (ticket 27), which both render whatever this layout puts
 * on the outlet context rather than each owning their own store. Settings is
 * a sibling route outside this layout, not a child of it (ADR 0008): it must
 * stay usable even when the store below never reaches "ready", and the only
 * way to guarantee that structurally is to keep it off this component's
 * subtree entirely.
 *
 * Opening happens through a TanStack Query query rather than a hand-rolled
 * module-scope promise: its cache gives the same single-open guarantee —
 * `openEntryStore` runs at most once per page load for `ENTRY_STORE_QUERY_KEY`,
 * including across React 19 StrictMode's double-mount and a round trip to
 * Settings and back — without this layout having to memoize anything itself.
 * `SyncLoop` (`use-sync-loop.ts`, ticket 38) subscribes to the exact same
 * `entryStoreQueryOptions` independently, mounted above the router rather
 * than inside this layout, which is what keeps the sync loop running while
 * this layout is unmounted (the user is on Settings).
 */
export function EntryStoreLayout() {
  const { data, error } = useQuery(entryStoreQueryOptions);

  const message = useMemo(() => (error ? describeOpenError(error) : undefined), [error]);

  if (data) {
    return <Ready store={data.store} deviceId={data.deviceId} />;
  }

  return (
    <Outlet
      context={
        { entries: [], sendEntry: noop, disabled: true, message } satisfies EntryStoreOutletContext
      }
    />
  );
}

function Ready({ store, deviceId }: { store: EntryStore; deviceId: string }) {
  const { entries, sendEntry } = useHistory(store, deviceId);
  return (
    <Outlet context={{ entries, sendEntry, disabled: false } satisfies EntryStoreOutletContext} />
  );
}

/** Read by `/` and `/history` — anything rendered outside EntryStoreLayout's Outlet must not call this. */
export function useEntryStore(): EntryStoreOutletContext {
  return useOutletContext<EntryStoreOutletContext>();
}
