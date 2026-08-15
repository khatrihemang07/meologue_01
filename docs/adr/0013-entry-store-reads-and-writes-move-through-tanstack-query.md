# 0013: The Entry store, History, and Send move through TanStack Query

## Status

Accepted. Supersedes [0009](0009-entry-store-and-sync-move-to-a-layout-route-above-history-and-composer.md).

## Context

Before this ticket, `EntryStoreLayout` opened the Entry store behind a hand-rolled module-scope
promise (`entryStorePromise`, memoized so React 19 StrictMode's double-mount and a round trip to
Settings and back couldn't reopen it), and `use-history.ts` held `entries` as a module-scope
array pushed through `useSyncExternalStore`, with its own listener set and its own
`syncInFlight` promise coalescing overlapping sync calls. It worked, but ADR 0009's own
Consequences section already flagged the shape as surprising, and it was the least-tested module
in the codebase — the promise memo, the listener set, and the in-flight coalescing were all
hand-built solutions to problems a request-caching library solves by default.

TanStack Query's cache gives the same single-open guarantee `entryStorePromise` existed for —
one `queryFn` call per query key, deduplicated across concurrent observers — without a component
having to memoize anything itself. Its `invalidateQueries` replaces the hand-rolled
listener/notify pair for History, and a single in-flight fetch or mutation per key replaces
`syncInFlight`'s manual coalescing. Adopting it here isn't just a style preference: routing
opening, History, and Send through one cache is what the next ticket (moving the sync scheduler
itself) builds on.

## Decision

**A `QueryClient` is provided in `main.tsx`, above `<App />` and therefore above
`<BrowserRouter>`** (`apps/web/src/lib/query-client.ts` exports the single instance). Every
route, Settings included, renders under it — unlike `EntryStoreLayout`, which still wraps only
`/` and `/history` (ADR 0009's structural guarantee for ADR 0008 is unchanged). Module-scope code
that runs outside any component's lifecycle — the continuous sync loop in `use-history.ts` — imports
this same singleton directly, rather than needing it threaded through React context; components
read it the ordinary way, via `useQuery`/`useMutation`/`useQueryClient()`, and land on the exact
same instance since there is only ever one `QueryClientProvider` in the tree.

**Opening the store is a `useQuery` in `EntryStoreLayout`**, keyed on `ENTRY_STORE_QUERY_KEY`,
with `staleTime` and `gcTime` set to `Infinity` and both `retry` and `retryOnMount` set to
`false` — a Device has exactly one store for the life of a page load (ADR 0001), so it must never
be treated as stale, never be garbage-collected out from under a Settings round trip, and never be
retried (a `SecondTabError` or `StorageUnavailableError` is not transient; retrying would mean a
second `openEntryStore()` call spinning up a second Worker competing with the first for the same
OPFS pool lock — the exact failure this whole scheme exists to prevent). `retry` and
`retryOnMount` are two different knobs: `retry` governs retries within one fetch attempt, but
`retryOnMount` defaults to `true` and governs whether a *new observer* of an already-errored query
refetches — exactly what a Settings round trip after a failed open creates. Without setting both,
the store reopens (and the failure above happens for real) on that round trip specifically, even
though the ordinary success path was already safe via `staleTime: Infinity`. `entryStorePromise`
is deleted; the query cache is the memoization.

**`ensureContinuousSync` is called from inside the `queryFn`, not from a `.then()` or a mount
effect.** ADR 0009 needed the call to be unconditional and independent of whether the component
that triggered it was still mounted, because a user navigating to Settings before the store
resolved would unmount `EntryStoreLayout` (and, with it, the `Ready` component whose `useHistory`
call used to be the only other caller) before anything else ran. A `queryFn`'s promise already has
exactly that property — TanStack Query runs it to completion regardless of whether any observer
is still subscribed — so placing the call there, right after `open()` succeeds, covers the
Settings-before-ready case for free. `useHistory` no longer calls `ensureContinuousSync` itself;
the old second call existed only to cover the ordinary case where `Ready` does mount, and the
`queryFn` now covers that case too, making the second call redundant rather than merely
idempotent.

**History reads and Sends are a query and a mutation in `useHistory`**, both keyed on
`ENTRIES_QUERY_KEY`. `sendEntry` mutates (`store.upsert`), and its `onSuccess` awaits
`invalidateQueries` before firing off `runSyncSilently` — an Entry shows in History from the
local write alone, before sync ever starts, same as before. The continuous sync loop and the
one-off sync `sendEntry` triggers both still coalesce through a single module-scope
`syncInFlight` promise (unchanged from before this ticket) and, on success, call
`queryClient.invalidateQueries({ queryKey: ENTRIES_QUERY_KEY })` in place of the old
`refresh`/`notify` pair. **Sync's schedule does not change**: `startContinuousSync` is still
started once per page load, still polls on the same interval, and still runs immediately on wake
signals — only what happens when a sync completes (cache invalidation instead of a hand-rolled
listener notify) is different.

## Alternatives considered

- **Keep `entryStorePromise` and `useSyncExternalStore`, and only move History reads to
  TanStack Query.** Rejected: opening the store is exactly the kind of async, cacheable,
  singleton-per-key resource TanStack Query already models, and leaving it hand-rolled while
  History moved would mean maintaining both patterns side by side for no benefit — the ticket's
  whole premise is that one cache should own all of this.
- **Give `ensureContinuousSync` back to `useHistory`'s mount effect, in addition to the `queryFn`
  call.** This is what ADR 0009 did (two callers, one for the ordinary path, one for the
  Settings-before-ready edge case). Rejected here: the `queryFn` call now covers every case the
  mount-effect call used to cover, since `Ready` only ever mounts after the query has already
  resolved. A second caller would be pure redundancy, not defense in depth — there's no path
  where the `queryFn` runs to completion but `Ready`'s effect is needed to catch a case it missed.
- **Provide the `QueryClient` inside `EntryStoreLayout` instead of `main.tsx`.** Rejected: it would
  mean Settings — a sibling route outside the layout (ADR 0008) — has no `QueryClient` in its
  tree at all, foreclosing the next ticket's move of the sync scheduler to somewhere that runs
  independent of which route is mounted. Providing it above the router costs nothing today (no
  other route reads it yet) and keeps that door open.

## Consequences

Readers of `use-history.ts` should no longer expect the `useSyncExternalStore`/module-scope-array
shape ADR 0009 called out — `entries` now lives in the TanStack Query cache under
`ENTRIES_QUERY_KEY`, and `useHistory` is an ordinary `useQuery` plus `useMutation` pair. What
*does* carry over unchanged, and remains true for the same reason ADR 0009 gave it: the
continuous sync loop (`continuousSyncStarted`, `syncInFlight`, `startContinuousSync`'s handle) is
still module-scope state, not React state, because it must keep running across a Settings round
trip that unmounts every component that could otherwise own it. A future reader tempted to lift
that into a `useState`/`useEffect` pair, or into the query cache itself, would reintroduce the
pause-on-Settings regression ADR 0009 already rejected once.

`ENTRY_STORE_QUERY_KEY` and `ENTRIES_QUERY_KEY` are two different keys in the same cache
deliberately — the store (an object with methods, opened once) and the Entries it holds (data,
refetched on every sync and every Send) have different lifetimes, and collapsing them into one
key would mean an Entries refetch racing a store-open retry that should never happen.
