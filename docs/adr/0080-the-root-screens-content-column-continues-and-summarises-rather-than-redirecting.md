# 0080: The root screen's content column continues and summarises, rather than redirecting

## Status

Accepted. Amends [0030](0030-the-shell-gets-a-root-screen.md) and its own strongest supersession,
[0036](0036-the-shell-is-a-chat-list-and-a-thread-is-a-chat-thread.md), and amends
[0076](0076-todos-navigation-is-what-the-shells-existing-pane-renders.md).

0036 decided what `/` renders at the wide breakpoint: nothing of its own, a centred sentence,
because the pane beside it already shows the same five rows `/` would otherwise repeat. That
decision — the pane never gets a second copy of the list — is untouched here. What changes is
what fills the space the pane's own `<Outlet />` leaves beside it: a placeholder before this ADR,
real content after it.

0076 conceded that "every Destination is a full-bleed push" (0030's own shape) stops holding for
Todo at the wide breakpoint, because Todo's own sidebar takes over the pane there. That concession
stands unchanged; this ADR does not touch the pane, only the content column beside it, and only
for `/` itself.

## Context

`back-to-chats.tsx` gives every Destination exactly one way back to the root screen: a hard
`<Link to="/">`. At the wide breakpoint, four of the five Destinations (Composer, Reflect, Digest,
Settings) render nothing for that link at all, because 0036's own reasoning says the pane beside
them already shows where it would go. Todo is the sole exception (0076, issue #248) — its own pane
shows `TodoSidebar` instead, so Back has to keep working there.

For the other four, Back is real and lands on `/`. And at the wide breakpoint, `/` was a centred
grey sentence: "Choose a conversation from the list." A reader who left the Composer to check
something in Todo, tapped Back, and landed there was handed a sentence restating a list they could
already see, with nothing to do next but read the list again — the exact list beside the sentence
that already named where they'd just come from. That is a dead end dressed as a screen: reachable,
rendered, and useless.

The placeholder was not wrong when 0036 wrote it. 0036's own argument was that `/` needed to
represent "nothing chosen yet" honestly rather than silently defaulting to the Composer, and the
sentence did that. What changed is that the sentence was asked to do a second job it was never
built for — being the page a reader actually lands on after a real action (Back) rather than only
after a cold, unchosen load — and it failed that job while still succeeding at the first one.

## Decision

### `/` gets content of its own at the wide breakpoint, for the first time

Below 900px, nothing in this ADR applies: `chat-list-page.tsx` still returns `<ChatListPane />`
unchanged, and that is the whole of the narrow-width behaviour, exactly as before. `ChatListPane`
itself — the five rows in `chat-list.tsx` — is unchanged everywhere; this ADR touches neither
`chat-list.tsx`'s rendering nor `chat-shell-layout.tsx`'s pane.

At 900px and up, the content column (the space beside the pane, previously the placeholder
sentence) now renders two things: a Continue card, and a Today summary. Both are read-only,
reuse-only additions — no new transport, no new Server endpoint, no new Sync stream.

### What `/` is not

`/` is **not** a sixth Destination. It carries no row on the root screen (`chat-list.tsx`'s
`DESTINATIONS` is unchanged, still five entries), it is not offered by `useDestinations()`, and
nothing links to it as a place with content of its own the way a reader links to `/composer` or
`/todo`. It is still, precisely, "nothing chosen yet" — the Continue card and the Today summary
are both *about* the five real Destinations, never a sixth one standing beside them. This still
does not exist below 900px, and the pane is still exactly what 0036 and 0076 already built.

### A Continue card, backed by an in-memory-only Device memory

`apps/web/src/lib/last-destination.ts` holds one module-level variable — not `localStorage`, not
`sessionStorage` — with `readLastDestination`/`writeLastDestination`/`clearLastDestination`.
`chat-shell-layout.tsx`, which persists across every route change including `/` itself, writes to
it from a small effect keyed on `location.pathname`, using `chat-list.tsx`'s newly-exported
`destinationForPath` to decide which of the five `DESTINATIONS` routes (if any) the current path
belongs to — `null` for `/` itself, so a bare visit to the root screen is never recorded as
something to continue into.

In-memory rather than persisted is deliberate, and reverses `last-session.ts`'s own choice on the
identical-looking question. That file remembers a Reflection Session id in `sessionStorage`
because ADR 0030 decided losing a live Conversation on a stray reload was a real cost. There is no
equivalent cost here: a cold load has nothing to continue into, and a Continue card is not owed to
a reader who has not done anything yet this session. Persisting the memory would show a stale card
pointing at wherever the reader happened to be before the tab last closed — a *weaker*, more
surprising claim than "here's what you were just doing."

`chat-list-page.tsx` looks the remembered `to` back up against the *live* result of
`useDestinations()` (now exported from `chat-list.tsx`) before ever rendering the card. This is
what keeps a since-hidden Destination from being offered back: `useDestinations()` already removes
a hidden row outright (issue #134), so `Array.prototype.find` simply returns `undefined` for a
`to` no longer present, and the card renders nothing. A *locked* last Destination (Sync off, or a
missing capability) is still offered — the same restraint `chat-list.tsx`'s own row shows a locked
Destination: it stays a real link, and opening it is what explains the gap, not this card.

The card is a real `Link`, never a redirect — see *Alternatives considered* below for why a
redirect was rejected outright rather than merely not chosen.

### A Today summary, over primitives the app already has

Three lines, each a `Link` to its own Destination, each shown only when that Destination is not
hidden (checked the same way the Continue card is, against `useDestinations()`):

- **Entries written today** — `use-history.ts`'s own `useHistory`, compared per-Entry with
  `entry-day.ts`'s `entryDayKey` against `local-day-key.ts`'s `localDayKey(new Date())`.
- **Tasks due today** — `@meologue/core`'s `today()`, called exactly as `today-view.tsx` already
  calls it, over `use-tasks.ts`'s own `useTasks`.
- **Most recent Digest** — `digest-transport.ts`'s `digestTransport("day")`, cached under
  `query-keys.ts`'s `digestQueryKey("day")` — the identical key `digest-page.tsx` fetches under,
  so the two share one cache entry rather than this summary running a second, independent request
  against the Server.

**`/` cannot reach `useEntryStore()`.** `App.tsx`'s own routing puts `/` as a sibling of
`EntryStoreLayout`, not a child of it (ADR 0036's own comment: "It sits outside EntryStoreLayout
deliberately... so it renders whether or not the store ever opens"), so the outlet context
`useHistory`/`useTasks`'s data ordinarily rides on simply isn't there for this page. Rather than
nest `/` under `EntryStoreLayout` — which would cost the root screen the "renders even if the
store never opens" guarantee 0008/0009 and 0036 both rely on — `chat-list-page.tsx` reaches the
store the same way `main.tsx`'s `SyncLoop` already does: `useQuery(entryStoreQueryOptions)`,
the exact query `EntryStoreLayout` itself opens the store through, `staleTime: Infinity` so this is
a second reader of one cache entry, never a second store open. `SyncLoop` proves this pattern
safe today — it already opens the identical query outside `EntryStoreLayout`'s own subtree,
mounted above the router — so this is a second, precedented consumer, not a new risk. Only once
that query resolves does `chat-list-page.tsx` call `useHistory`/`useTasks` for real, by mounting a
distinct child component rather than branching inside one that already called them — Hooks must
run unconditionally per component, and a store that has not opened yet has no real `EntryStore`/
`TaskStore` instance to hand them.

### Every state is calm by construction, not by a special case

- **Nothing written today, nothing due today** — each line renders "Nothing yet" / "Nothing due"
  as its value, in the identical row shape a real count would render in, never a blank space or a
  skeleton.
- **Digest unreachable** — `digestTransport` never throws; a `"unreachable"` result renders
  "Server unreachable" in the same row.
- **Digest locked** (Sync off, or the Server lacks the capability) — the fetch is not even made
  (`enabled: !locked`); the row reads "Locked", the same one-word restraint `chat-list.tsx`'s own
  locked row already shows, on the reasoning that this summary is not the place to re-explain why
  — opening Digest already does.
- **No Continue card** — a cold load, or every hideable Destination hidden with nothing yet
  recorded — renders nothing where the card would be, which is the correct reading of "there is
  nothing to continue," not an error state.
- **The whole column empty** — reachable only if every one of Composer/Todo/Digest is hidden and
  there is no Continue card, which needs a reader to have deliberately hidden three of four
  hideable Destinations. `chat-list-page.tsx` renders one calm sentence for exactly this case
  rather than an empty `<div>`.

## Alternatives considered

- **Render the five Destination rows in the content column.** Rejected outright, and this is the
  same rejection `chat-list-page.tsx`'s own pre-existing comment already made for the placeholder
  it's replacing: the pane beside this column already renders those five rows (`chat-list.tsx`'s
  `ChatList`, inside `chat-shell-layout.tsx`'s pane), so a second copy in the content column would
  be exactly the duplicate list 0036 built the pane to avoid having twice. It is also the
  duplicate-`<nav>`-landmark defect this app has fought before and named explicitly — 0076's own
  *Decision* section describes `TodoNav` hiding itself at the wide breakpoint specifically because
  a second `aria-label="Todo"` landmark on screen at once is "the duplicate-landmark defect
  `chat-list-pane.tsx` already argues a `<div>` instead of a `<header>` into existence to avoid,
  rebuilt on the other axis" — the identical shape a second `<nav aria-label="Chats">` here would
  reintroduce.
- **Redirect `/` to the last Destination.** Rejected, not merely passed over. It makes Back a
  loop: Back from Composer goes to `/`, which would immediately redirect back to Composer, so the
  one control this app guarantees always lands on the root screen (`back-to-chats.tsx`'s own "a
  real `<Link>`... works on a cold load with no history entry") would stop reaching it at all. It
  also makes the root screen itself unreachable by definition — there would be no way to see "`/`
  as ADR 0036 built it" once anything had ever been visited, which contradicts 0036's own
  Alternatives section rejecting exactly this shape for the same reason ("the root screen is the
  thing the reader should land on cold, and a redirect off `/` means the app's own front door is a
  page nobody sees").
- **Persist the last Destination in `localStorage`/`sessionStorage`, matching `last-session.ts`.**
  Rejected — see *A Continue card* above for the full reasoning: there is no reload-survival cost
  to pay for here, and persisting would make the card show a stale claim on a cold load instead of
  correctly showing nothing.
- **Nest `/` under `EntryStoreLayout` so the Today summary could use `useEntryStore()` directly.**
  Rejected: it would cost the root screen the guarantee ADR 0008/0009 and 0036 both rely on — that
  `/` renders whether or not the Entry store ever opens — for the sake of a summary that is
  already able to reach the same store safely through the `entryStoreQueryOptions` query
  `SyncLoop` already opens outside that layout.
- **Show the Digest line's specific lock reason (Sync off vs. missing capability).** Rejected in
  favour of one neutral word, "Locked" — `chat-list.tsx`'s own locked row already establishes that
  a summary or a list is not the place to explain a lock; the Destination itself does that in its
  own words once opened, and duplicating that explanation here would be a second place the wording
  could drift from the first.

## Consequences

Back from any Destination other than Todo now lands on a screen with something to do, not a dead
end — the defect this ADR exists to fix.

`chat-list.tsx` gained two new exports (`useDestinations`, previously private, and
`destinationForPath`, new) purely for reuse — `ChatList` itself is unchanged, and remains this
hook's only *rendering* caller. A future change to the lock/hidden rules in `useDestinations()`
now has two call sites to keep correct instead of one, though both read the same derivation rather
than each recomputing their own.

`chat-list-page.tsx` is now the second place in the app (after `main.tsx`'s `SyncLoop`) that reads
`entryStoreQueryOptions` from outside `EntryStoreLayout`'s own subtree. That was already a
supported shape before this ADR, not a new one invented for it, but there are now two precedents
instead of one, and a future reader auditing "what touches the Entry store outside its own layout"
has one more file to check.

The Today summary's Entry count is read off `use-history.ts`'s own paged infinite query (the
newest 50 Entries), not a full scan — a reader who has written more than 50 Entries today would
see an undercount. Accepted rather than widened: every other reader of `useHistory`'s `entries`
already lives with this same page, and asking for more here would mean this summary alone paying
for a wider read the rest of the app deliberately avoids (ADR 0030's own paging rationale).
