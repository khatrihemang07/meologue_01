import type { Entry, EntryStore } from "@meologue/core";
import { open } from "@meologue/core";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Outlet, useOutletContext } from "react-router";
import { type UseHistoryPagination, useHistory } from "@/hooks/use-history";
import { SecondTabError, StorageUnavailableError } from "@/lib/entry-store-errors";
import { ENTRY_STORE_QUERY_KEY } from "@/lib/query-keys";
import { createDriver } from "@/platform/sqlite-driver";

export interface EntryStoreOutletContext {
  entries: Entry[];
  /** Issue #79 — see UseHistoryPagination's own doc comment (use-history.ts). */
  pagination: UseHistoryPagination;
  sendEntry: (raw: string) => void;
  /** Search (ticket 39) — narrows History to Entries whose body matches `query`, per EntryStore.search. */
  search: (query: string) => Promise<Entry[]>;
  /** ADR 0028 — see use-history.ts's own doc comment for what these do and why removeEntry takes the whole Entry. */
  editEntry: (id: string, body: string) => void;
  removeEntry: (entry: Entry) => void;
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
    // OPFS allows a single writer per origin (ticket 45). Before installing
    // the PWA was possible, hitting this meant two browser tabs — an edge
    // case a user could just close one of. An installed window plus a
    // browser tab is now the normal steady state, and the second one to
    // open lands here — "tab" would be actively wrong for the installed
    // window, and the old wording ("can't store Entries") read like data
    // loss rather than the ordinary, expected lockout this actually is.
    // Detection is unchanged; only the words.
    return "meologue is already open in another window. Only one window can hold the Entries at a time — close this one, or go back to the other.";
  }
  if (error instanceof StorageUnavailableError) {
    return "meologue can't store Entries here — try a non-private window over HTTPS or localhost.";
  }
  console.error("meologue: failed to open the entry store", error);
  return "meologue couldn't open its storage. Reloading may help.";
}

function noop() {}

async function noopSearch(): Promise<Entry[]> {
  return [];
}

// ADR 0028's edit/delete affordances need the store to exist just as much
// as sendEntry does — the not-ready outlet context below stands in with
// these too, for the identical reason: the History rendered while
// `disabled` is true has no Entries to act on anyway (`entries: []`), but
// the context's shape must still satisfy `EntryStoreOutletContext` so a
// page never has to null-check which branch of EntryStoreLayout it's
// under.
function noopEdit(_id: string, _body: string) {}

function noopRemove(_entry: Entry) {}

function noopFetchMore() {}

// Mirrors `entries: []` just above: nothing to page through before the
// store is open, and `hasMore: false` keeps Shell's scroll listener from
// ever calling `noopFetchMore` in the first place (see
// use-pinned-scroll.ts's own `hasMore` guard).
const notReadyPagination: UseHistoryPagination = {
  hasMore: false,
  fetching: false,
  fetchMore: noopFetchMore,
};

/**
 * The composition root for ADR 0001 and ADR 0013: opens the Entry store and
 * runs `useHistory` exactly once, above the routes that read from it — `/`,
 * `/reflect` and `/digest` (ticket 27, extended by ADR 0020 and issue #71;
 * issue #75 deleted `/history`, once a fourth), which all render whatever
 * this layout puts on the outlet context rather than each owning their own
 * store. Settings is a sibling route outside this layout, not a child of it
 * (ADR 0008): it must stay usable even when the store below never reaches
 * "ready", and the only way to guarantee that structurally is to keep it
 * off this component's subtree entirely — unchanged by issue #75 moving
 * Settings into the persistent Nav, since that only changed how a reader
 * reaches `/settings`, not where the route sits in this tree.
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
        {
          entries: [],
          pagination: notReadyPagination,
          sendEntry: noop,
          search: noopSearch,
          editEntry: noopEdit,
          removeEntry: noopRemove,
          disabled: true,
          message,
        } satisfies EntryStoreOutletContext
      }
    />
  );
}

function Ready({ store, deviceId }: { store: EntryStore; deviceId: string }) {
  const { entries, pagination, sendEntry, editEntry, removeEntry } = useHistory(store, deviceId);
  return (
    <Outlet
      context={
        {
          entries,
          pagination,
          sendEntry,
          search: (query: string) => store.search(query),
          editEntry,
          removeEntry,
          disabled: false,
        } satisfies EntryStoreOutletContext
      }
    />
  );
}

/** Read by `/` and `/reflect` (`/digest` reads nothing from the store — see this file's own comment above) — anything rendered outside EntryStoreLayout's Outlet must not call this. */
export function useEntryStore(): EntryStoreOutletContext {
  return useOutletContext<EntryStoreOutletContext>();
}
