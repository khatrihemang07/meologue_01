# 0009: The Entry store and sync loop move to a layout route above History and Composer

## Status

Accepted

## Context

Ticket 27 gives History its own route: `/history` shows the full History, and `/` keeps the
Composer with the same, uncapped History beneath it. Both render the identical History component
(`apps/web/src/components/history.tsx`) with identical props.

Before this ticket, the page at `/` was the composition root ADR 0001 describes: it opened the
SQLite store and called `useHistory` itself. Two pages both showing History can't each be their
own composition root — that would mean two owners of one Entry store and, worse, two independent
sync loops racing each other against the same server. Something above both pages has to open the
store and run `useHistory` exactly once, and both pages read Entries from it.

Settings cannot be that something's child. ADR 0008 requires Settings to stay usable when the
Entry store fails to open — a bad Server URL is what gets fixed there — and the only way to
guarantee that structurally is to keep Settings off the store-opening component's subtree
entirely, so nothing it does (loading, ready, or erroring) can gate whether Settings renders.

## Decision

**A layout route, `EntryStoreLayout` (`apps/web/src/pages/entry-store-layout.tsx`), wraps only
`/` and `/history`.** It replaces the store-opening logic that used to live directly in the page
at `/`, unchanged in substance (the same `entryStorePromise` memoized at module scope, the same
`describeOpenError` mapping) but relocated above a React Router layout route instead of inside a
single page component. It renders `<Outlet context={...} />`, putting `entries`, `sendEntry`,
`disabled`, and an optional `message` on the outlet context for whichever page is currently
matched. `ComposerPage` and `HistoryPage` both read that context via `useEntryStore()`
(`useOutletContext` under the hood) rather than opening anything themselves — the loading and
error states reach both pages this way, and each keeps its own title and navigation while showing
them, since only the content area comes from the layout.

**Settings stays a sibling route, outside `EntryStoreLayout`.** `App.tsx`'s route tree nests `/`
and `/history` under the layout route and lists `/settings` beside it, not under it — the
structural guarantee ADR 0008 needs.

**The continuous sync loop moves out of `useHistory`'s component lifecycle into a module-scope
singleton, and is never explicitly stopped.** `EntryStoreLayout` itself never unmounts while
moving between `/` and `/history` — they're both nested under the same layout route, and React
Router keeps a shared layout mounted across its own child routes, swapping only the matched
child in its `Outlet`. That part needed no new mechanism; it falls out of ordinary nested routing.
Settings is the case that does: it's a sibling route outside `EntryStoreLayout` (the decision
above), so navigating to it unmounts the layout, same as navigating to Settings unmounted the page
at `/` before this ticket. Previously, `useHistory` started `startContinuousSync` in a mount effect
and called `.stop()` in its cleanup — sync ran exactly as long as its calling component was
mounted. Leaving that coupling in place here would have made sync pause on Settings, same as
before — not a regression exactly, but a missed opportunity given the rest of this change, and
worth deciding deliberately rather than inheriting by default. Instead, `apps/web/src/hooks/use-history.ts`
keeps `entries` and the `startContinuousSync` handle at module scope, guarded by a
`continuousSyncStarted` flag so it starts once per page load and is never restarted. `entries` is
exposed to React through `useSyncExternalStore`, so whichever component instance is currently
mounted — including a fresh one after a Settings round trip remounts `EntryStoreLayout` — reads the
same live snapshot rather than one tied to whichever mount originally started the loop.

That guard only helps once something has actually called the function it guards. `useHistory` calls
it from a mount effect, same as before — but `useHistory` is only ever called by `Ready`, which
`EntryStoreLayout` only renders once its store-opening promise has *both* resolved *and* the layout
is still mounted to see that happen. A user who navigates to Settings before the store finishes
opening unmounts `EntryStoreLayout` first — `Ready` (and with it, `useHistory`) never mounts in that
page load at all, so relying on it alone would leave sync never started until the user happened back
onto `/` or `/history`. `EntryStoreLayout`'s own `entryStorePromise.then(...)` calls
`ensureContinuousSync` directly and unconditionally, ahead of (and regardless of) the `cancelled`
check that guards its own `setState` — a promise callback runs whether or not the component that
attached it is still mounted, which is exactly the property needed here. **The consequence:** sync
no longer pauses while the user is on Settings, and starts even if Settings is where the user
already was when the store finished opening. It keeps polling, keeps writing to the local store, and
`/` or `/history` shows whatever arrived while the user was away as soon as either mounts.

## Alternatives considered

- **Nest all three routes — `/`, `/history`, and `/settings` — under `EntryStoreLayout`, and have
  Settings simply not consume the outlet context.** Rejected: this satisfies "Settings doesn't
  depend on the store" in a runtime sense but not a structural one — ADR 0008's whole point was
  that the guarantee shouldn't rest on every future change to Settings remembering not to read a
  context it happens to have access to. A sibling route can't accidentally regress that way.
- **Keep `useHistory`'s sync loop tied to component lifecycle (start on mount, stop on unmount)
  and accept that sync pauses on Settings, same as before ticket 25.** This is the simpler change
  and was seriously considered — nothing in the acceptance criteria strictly requires otherwise.
  Rejected because it would have been a silent behaviour change in the wrong direction: Settings
  moving from "inside the page that owns sync" to "a plain sibling route" reads like an
  architectural improvement, and quietly making sync flakier around it (pausing on a page that
  used to at least be reachable without triggering a pause, before `/history` existed) is the kind
  of regression this ADR exists to make legible rather than let happen by accident.
- **Give `EntryStoreLayout` a `React.Context` provider instead of React Router's outlet context.**
  Rejected: `useOutletContext` already does exactly this for the one relationship that needs it
  (a layout route and the pages nested under it), with no extra provider component to add or
  forget to wrap.

## Consequences

Two Devices reading this codebase's history should not be surprised to find `useHistory` shaped
like an external store (`useSyncExternalStore`, module-scope `entries`/`listeners`) rather than a
plain `useState` hook — that shape is what makes sync survive a remount rather than a coincidence
of how the file happens to be written. Anything that wants to stop sync deliberately (there is no
such feature today) will need to add that back explicitly; there is currently no code path that
calls `.stop()` on the handle `startContinuousSync` returns.

`ComposerPage` and `HistoryPage` can only call `useEntryStore()` when rendered under
`EntryStoreLayout`'s outlet — `useOutletContext` returns `undefined` otherwise, which would throw
on the destructuring in both pages. Nothing currently renders either page outside that layout in
`App.tsx`; a future page reusing either component would need to either sit under the same layout
or be given an equivalent context another way.
