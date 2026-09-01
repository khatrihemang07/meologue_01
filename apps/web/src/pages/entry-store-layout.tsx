import type { Entry, EntryStore } from "@meologue/core";
import { open } from "@meologue/core";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Outlet, useOutletContext } from "react-router";
import { type UseHistoryPagination, useHistory } from "@/hooks/use-history";
import { dayHasEntries } from "@/lib/day-has-entries";
import { dayReferrers } from "@/lib/day-referrers";
import { deviceUtcOffsetMinutes } from "@/lib/entry-day";
import {
  OpenTimeoutError,
  SecondTabError,
  StorageUnavailableError,
} from "@/lib/entry-store-errors";
import { ENTRY_STORE_QUERY_KEY } from "@/lib/query-keys";
import { createDriver } from "@/platform/sqlite-driver";

export interface EntryStoreOutletContext {
  entries: Entry[];
  /** Issue #79 — see UseHistoryPagination's own doc comment (use-history.ts). */
  pagination: UseHistoryPagination;
  sendEntry: (raw: string) => void;
  /** Search (ticket 39) — narrows History to Entries whose body matches `query`, per EntryStore.search. */
  search: (query: string) => Promise<Entry[]>;
  /**
   * A direct by-id lookup, per EntryStore.getMany — added to fix issue
   * #79's regression: `entries` above is only whatever pages of History
   * `useHistory`'s infinite query has loaded so far, so a page that needs
   * to resolve a specific, known set of ids (reflection-page.tsx's
   * Grounding ids) can't rely on scanning `entries` for them the way it
   * could before paging existed. Named to match `search`'s shape — a
   * function a page calls, not a second array to keep in sync with the
   * first.
   */
  getEntries: (ids: string[]) => Promise<Entry[]>;
  /**
   * Whether a local day (YYYY-MM-DD) holds at least one live Entry (issue
   * #142) — day-has-entries.ts's own `dayHasEntries`, exposed as a context
   * function the same way `search`/`getEntries` above are, rather than the
   * raw store: entry-row.tsx's date-Reference link (via
   * use-day-has-entries.ts) is this field's one caller, and it needs
   * exactly this answer, not `EntryStore.list` itself.
   *
   * Optional, unlike `search`/`getEntries`: every other page that builds
   * this context — reflection-page.tsx's and digest-reader-page.tsx's own
   * tests among them, none of which know a date Reference exists — has no
   * reason to supply it, and `use-day-has-entries.ts`'s own hook already
   * treats "no probe available" the same as "still resolving": the
   * Reference simply stays its literal text, the same "unresolved is plain
   * text" rule inline-prose.tsx already applies to a removed Entry or a
   * malformed mark.
   */
  dayHasEntries?: (dayKey: string) => Promise<boolean>;
  /**
   * The later Entries that Refer to a local day (YYYY-MM-DD) (issue #147,
   * ADR 0042's own "a day can also be asked what Refers to it") —
   * day-referrers.ts's own `dayReferrers`, exposed as a context function the
   * same way `dayHasEntries` above is, rather than the raw store:
   * history.tsx's own day-adjacent row (via use-day-referrers.ts) is this
   * field's one caller, and it needs exactly this answer, not
   * `EntryStore.search` itself (ADR 0042's "day shows what Refers to it" is
   * two steps — narrowing with search, then confirming by parsing — and
   * `dayReferrers` is where both live, not here).
   *
   * Optional, unlike `search`/`getEntries`, for the same reason
   * `dayHasEntries` is: every other page that builds this context has no
   * reason to supply it, and `use-day-referrers.ts`'s own hook already
   * treats "no probe available" the same as "still resolving" — a day
   * renders as having nothing Referring to it either way.
   */
  dayReferrers?: (dayKey: string) => Promise<Entry[]>;
  /**
   * Resolves one Entry Reference's target by id (issue #143) — the chip's
   * own probe, `entry-row.tsx`'s `EntryReferenceLink` (via
   * `use-entry-reference.ts`) is its one caller. Returns `undefined` for an
   * id `getMany` doesn't hand back — a tombstoned Entry, or one that hasn't
   * Synced to this Device yet — which is exactly the "unresolvable" case
   * the chip renders as plain text (ADR 0042's "one rule, four causes").
   *
   * Built on `EntryStore.getMany`, the same primitive `getEntries` above
   * already wraps, rather than widening `EntryStore` with a singular
   * lookup of its own. Kept as its own field instead of reusing `getEntries`
   * directly: `getEntries` is keyed by reflection-page.tsx's own
   * `groundingEntriesQueryKey` — the *set* of ids one Grounding disclosure
   * needs at once, refetched together whenever that set changes — while a
   * chip needs its own target cached per id alone
   * (`entryReferenceQueryKey`), so two chips pointing at the same Entry
   * anywhere in the app share one lookup regardless of what else either of
   * them also happens to reference. A second field is what keeps those two
   * cache shapes independent without teaching `getEntries`'s callers about
   * per-id caching they have no use for.
   *
   * Optional, unlike `getEntries`: the same reasoning as `dayHasEntries`
   * just above — every outlet-context builder that predates this ticket
   * (reflection-page.test.tsx and digest-reader-page.test.tsx among them)
   * has no reason to know an Entry Reference exists, and
   * `use-entry-reference.ts`'s own hook already treats "no probe supplied"
   * the same as "still resolving."
   */
  getEntry?: (entryId: string) => Promise<Entry | undefined>;
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
  if (error instanceof OpenTimeoutError) {
    // Issue #159: deliberately not the same sentence as the fallback below.
    // A timeout is not a known failure — the store may still be opening
    // (see SqliteWorkerDriver's own comment on why the timeout is generous)
    // or may be stuck forever, and there is no way to tell those apart from
    // here. Saying "couldn't open" would claim more than is actually known;
    // this is the one branch of this function whose whole job is to make a
    // *hung* open look different on screen from a *failed* one, so the
    // reader isn't shown an indefinitely disabled Composer with no
    // explanation at all.
    console.error("meologue: opening the entry store timed out", error);
    return "meologue is taking longer than expected to open its storage. If this doesn't resolve, try reloading.";
  }
  // Reached by WorkerLoadError (the worker script itself failed to load or
  // threw at top level — issue #159) as well as anything else this
  // function doesn't specifically recognize: `error` here is guaranteed to
  // carry more detail than the sentence below does, so it's logged in full
  // rather than only the generic fallback message reaching a developer.
  console.error("meologue: failed to open the entry store", error);
  return "meologue couldn't open its storage. Reloading may help.";
}

function noop() {}

async function noopSearch(): Promise<Entry[]> {
  return [];
}

async function noopGetEntries(): Promise<Entry[]> {
  return [];
}

// Before the store opens there are no Entries to find on any day (`entries:
// []` above already says as much); this is the `dayHasEntries` field's own
// stand-in for that same not-ready state.
async function noopDayHasEntries(): Promise<boolean> {
  return false;
}

// `getEntry`'s own not-ready stand-in, mirroring `noopDayHasEntries` just
// above: nothing can be resolved before the store opens, and `undefined` is
// already this field's own "unresolvable" answer, not a special case for it.
async function noopGetEntry(): Promise<Entry | undefined> {
  return undefined;
}

// `dayReferrers`'s own not-ready stand-in, mirroring `noopDayHasEntries`:
// nothing has Referred to any day before the store opens, and an empty
// array is already this field's own "nothing found" answer.
async function noopDayReferrers(): Promise<Entry[]> {
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

// Issue #110's fix: forwards every `EntryStore` call to whatever
// `openEntryStore()` eventually resolves to, so `useHistory` (below) has a
// real `EntryStore` to call from this layout's very first render — not just
// once `data` exists. Built once per mount from `promise` (itself the same
// cached open, deduplicated by TanStack Query — see this file's own doc
// comment on `entryStoreQueryOptions`), so a call made before the store
// opens simply waits for that same open to finish rather than failing or
// silently doing nothing; a call made after just resolves the already-kept
// promise immediately. Nothing here ever opens a second store: this reaches
// the store exclusively through the query cache, the same single door
// `entryStoreQueryOptions`'s own comment already guarantees.
function deferUntilOpen(promise: Promise<{ store: EntryStore; deviceId: string }>): EntryStore {
  return {
    list: (page) => promise.then(({ store }) => store.list(page)),
    upsert: (entries) => promise.then(({ store }) => store.upsert(entries)),
    pending: () => promise.then(({ store }) => store.pending()),
    getCursor: () => promise.then(({ store }) => store.getCursor()),
    setCursor: (seq) => promise.then(({ store }) => store.setCursor(seq)),
    search: (query) => promise.then(({ store }) => store.search(query)),
    edit: (id, body) => promise.then(({ store }) => store.edit(id, body)),
    remove: (id) => promise.then(({ store }) => store.remove(id)),
    getMany: (ids) => promise.then(({ store }) => store.getMany(ids)),
  };
}

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
 *
 * Issue #110: this used to branch on `data` to decide *what to render* — a
 * bare `<Outlet>` while the store was opening, or an inner `<Ready>`
 * component (which called `useHistory` itself) once it was open. That put
 * two different element types in the exact same position in the tree across
 * those two renders, and React only preserves a subtree's state when the
 * type at a given position stays the same — a change unmounts the old one
 * and mounts a fresh one. So every route under here (`/`, `/reflect`,
 * `/digest`) was silently torn down and rebuilt the moment the store
 * finished opening, ~50-100ms after first paint: confirmed directly by a
 * test that renders a probe here, resolves the store open, and watches the
 * probe unmount and remount (entry-store-layout.test.tsx). For most routes
 * that remount is invisible — there's nothing in flight yet to lose. For
 * `/reflect`, landing inside that window aborts a `/v1/reflect` stream that
 * happened to start during it (`activeAbortRef`'s cleanup,
 * reflection-page.tsx runs on *any* unmount, not only a real navigation
 * away).
 *
 * The fix keeps this component's *own* type constant across every render —
 * `<Outlet>` is always the direct, only thing it returns — by calling
 * `useHistory` unconditionally instead of only once `data` exists.
 * `useHistory` needs a real `EntryStore` synchronously, so before `data`
 * resolves it's handed `deferUntilOpen`'s facade instead of the real one;
 * once `data` resolves, it's handed the real store directly. Either way,
 * `useHistory`'s own hook calls (an infinite query, three mutations) run in
 * the same order on every render, so nothing about *this* component's
 * position or type ever changes — its child routes never lose their state
 * to an internal remount again.
 */
export function EntryStoreLayout() {
  const { data, error } = useQuery(entryStoreQueryOptions);

  const message = useMemo(() => (error ? describeOpenError(error) : undefined), [error]);

  // A promise this component settles itself, from `data`/`error` above,
  // rather than one obtained by independently asking TanStack Query to
  // fetch (`fetchQuery`/`ensureQueryData`) — either of those triggers a
  // fresh fetch attempt of their own whenever the query is sitting in an
  // error state, bypassing `retryOnMount: false` (that option only governs
  // `useQuery`'s own observer) and reopening a second Worker against the
  // same OPFS pool lock on exactly the Settings-round-trip-after-a-failed-open
  // path `retryOnMount: false` exists to prevent (see
  // `entryStoreQueryOptions`'s own comment, and the regression test this
  // mistake first failed). Settling this from `data`/`error` instead means
  // it only ever reflects whatever `useQuery` itself already decided to do.
  // `useState`'s lazy initializer runs exactly once per mount, so `deferred`
  // is a stable object for this component's whole lifetime.
  const [deferred] = useState(() => {
    let resolve!: (value: { store: EntryStore; deviceId: string }) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<{ store: EntryStore; deviceId: string }>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A rejection here (the store failed to open) is already surfaced via
    // `message` above — this only stops it from also logging as an
    // unhandled rejection for the common case where nothing ever calls the
    // facade while `disabled: true` keeps every real caller away from it.
    promise.catch(() => {});
    return { promise, resolve, reject };
  });

  // Calling `resolve`/`reject` here, during render, rather than from a
  // `useEffect`: a Promise can only ever settle once, so calling either
  // more than once (a StrictMode double-render in dev, or a render React
  // ends up throwing away) is a harmless no-op — and settling eagerly, on
  // the very render that first sees `data`/`error`, is what lets
  // `useHistory`'s already-in-flight first fetch (started against
  // `pendingStore` below) resolve against the real store the moment it's
  // available, instead of waiting an extra effect tick.
  if (data) {
    deferred.resolve(data);
  } else if (error) {
    deferred.reject(error);
  }

  // `useHistory`'s own fetch, kicked off the moment this facade is first
  // used, captures `deferred.promise` in its closure — that's what lets an
  // attempt that starts before the store opens complete against the real
  // store once it does, with no manual retry.
  const pendingStore = useMemo(() => deferUntilOpen(deferred.promise), [deferred]);

  const store = data?.store ?? pendingStore;
  const deviceId = data?.deviceId ?? "";

  const { entries, pagination, sendEntry, editEntry, removeEntry } = useHistory(store, deviceId);

  return (
    <Outlet
      context={
        data
          ? ({
              entries,
              pagination,
              sendEntry,
              search: (query: string) => store.search(query),
              getEntries: (ids: string[]) => store.getMany(ids),
              dayHasEntries: (dayKey: string) =>
                dayHasEntries(store, dayKey, deviceUtcOffsetMinutes()),
              dayReferrers: (dayKey: string) =>
                dayReferrers(store, dayKey, deviceUtcOffsetMinutes()),
              getEntry: (entryId: string) => store.getMany([entryId]).then((found) => found.at(0)),
              editEntry,
              removeEntry,
              disabled: false,
            } satisfies EntryStoreOutletContext)
          : ({
              entries: [],
              pagination: notReadyPagination,
              sendEntry: noop,
              search: noopSearch,
              getEntries: noopGetEntries,
              dayHasEntries: noopDayHasEntries,
              dayReferrers: noopDayReferrers,
              getEntry: noopGetEntry,
              editEntry: noopEdit,
              removeEntry: noopRemove,
              disabled: true,
              message,
            } satisfies EntryStoreOutletContext)
      }
    />
  );
}

/** Read by `/` and `/reflect` (`/digest` reads nothing from the store — see this file's own comment above) — anything rendered outside EntryStoreLayout's Outlet must not call this. */
export function useEntryStore(): EntryStoreOutletContext {
  return useOutletContext<EntryStoreOutletContext>();
}
