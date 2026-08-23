# 0020: Reflection is a third navigation destination

## Status

Accepted. Partially supersedes [0018](0018-two-nav-destinations-across-three-routes-with-settings-as-an-app-bar-action.md)
— that ADR's exactly-two-destination count is replaced by three; its reasoning for keeping
Settings out of the nav, its bottom-docked Composer, its reading order, its shared day-separator
grouping, and its one-`<nav>`-element-repositioned-by-CSS technique all stand unchanged and are
still load-bearing. 0018 is amended in place to record this.

Partially superseded by [0025](0025-sessions-are-held-by-the-server.md) — that ADR replaces this
one's "a Conversation lives only in memory on the Device, in no new local table" clause, and
replaces it in the direction this ADR did not anticipate: the question deferred below was
*which local table*, and the answer turned out to be none, with the Server holding a Session
instead. Everything else here — the third nav destination, the `/reflect` route inside
`EntryStoreLayout`, the Sync-off gate, and the reasoning for keeping Settings an app-bar
action — stands unchanged and is still load-bearing.

Partially superseded/extended by issue #71's Digest page, built on
[0027](0027-digests-are-written-ahead-of-time-by-a-background-worker.md) — **the destination
count this ADR fixed at three moves to four: Composer, History, Reflect, Digest.** Digest still
sits inside the same Material 3 three-to-five bound this ADR itself cited below — four is no
closer to that ceiling than three was to its floor — so nothing in the reasoning that justified
raising two to three needed to change to justify raising three to four; the count was never
independent of what it was counting (see this ADR's own words below), and the count of peer views
onto a user's History simply grew again. Digest reads CONTEXT.md's own definition — prose the
Server writes about a stretch of time, read rather than asked for — which is what makes it a peer
of Reflect and History rather than a utility like Settings: it is a way of reading a user's
History, not configuring the Device. Everything else this ADR decided — the `/reflect` route, the
Sync-off gate's reasoning, Settings staying an app-bar action, the one-`<nav>`-repositioned-by-CSS
technique — stands unchanged; see `apps/web/src/components/nav.tsx`'s `DESTINATIONS` for where the
fourth entry actually lives.

Further superseded by [0030](0030-the-shell-gets-a-root-screen.md) — the count stays four, but the
membership changes: History is deleted (its route and page both, no redirect — the Composer view
already rendered the identical component), and Settings takes its place, making the four
Composer, Reflect, Digest, Settings. This ADR's own placement of Reflection — the `/reflect` route
inside `EntryStoreLayout`, the Sync-off gate and its reasoning, keeping Settings a sibling route
outside that layout — stands unchanged and is still load-bearing; only which four things the
persistent Nav shows changed, not how Reflection itself sits among them.

## Context

CONTEXT.md just gained five terms — Reflection, Question, Answer, Conversation, Grounding —
ahead of the tickets that build Reflection's actual asking-and-answering. This ticket only makes
Reflection a *place*: a route the reader can navigate to, with no server call, no LLM, and no way
yet to type a Question. But "a place" still has to decide where it sits in the navigation 0018
and 0019 already built, and that decision belongs here rather than being made silently as a side
effect of wiring a route.

0018 fixed the destination count at exactly two — Composer and History — on the grounds that
Settings is a utility, not a peer of the two views onto a user's Entries, and that Material 3
reserves a navigation bar for destinations "at the same hierarchy level." That count was never
independent of what it was counting: it was "how many peer views of History are there," and until
now the answer was two.

## Decision

**Reflection joins the persistent Nav as a third destination — Composer, History, Reflect — and
Settings stays an app-bar action.** This does not reopen 0018's Settings decision: Settings is
still a utility one level down, unchanged. What changes is the count of peers above it. Reflection
reads CONTEXT.md's own definition: "Reflection only ever reads Entries; it never creates one" —
the same relationship to History that the existing History page has. It is a third way of looking
at the same History, not a new kind of thing bolted onto the side of it, which is what makes it a
peer of Composer and History rather than a second Settings.

Three stays inside the boundary 0018 itself cited, not outside it: Material 3 reserves a
navigation bar for **three to five** destinations at the same hierarchy level. 0018 picked two
because two was the true count at the time, not because three was rejected — nothing in 0018
argues against a third peer, only against Settings being one.

**The route is `/reflect`, a third child of `<Route element={<EntryStoreLayout />}>`**, alongside
`/` and `/history`, for the same reason History is inside that layout and Settings is not (ADR
0008/0009): Reflection reads Entries, so it needs the store EntryStoreLayout opens, and it does
not need to stay usable when that store never reaches "ready" the way Settings does. The route
segment contains no `.` character, preserving the constraint recorded in `App.tsx` — Capacitor's
fallback check treats a dot in the last path segment as a request for a real file, not the app
shell.

**A Conversation lives only in memory on the Device, in no new local table.** *(Superseded by
[0025](0025-sessions-are-held-by-the-server.md) — see this ADR's Status.)* CONTEXT.md is
explicit that a Conversation "belongs to the Device it happened on and does not Sync," and that
neither a Question nor an Answer is an Entry. Every persisted record this codebase has today is an
Entry, and ADR 0001's whole local-first design leans on Entry immutability — a Cursor advancing
past what it's already seen, a Sync loop that only ever appends. A Conversation is not immutable:
it grows with every Question, and a later ticket may let a Device forget it. Giving it a table
would make it the first mutable, non-Entry record this codebase has ever stored, which is a much
bigger decision than "Reflection has a route" and does not need to be made to satisfy this ticket.
Losing the Conversation on reload is therefore not a gap this ticket left open by accident — it is
what "lives only in memory" means, and it is the cheapest thing that could be true until a ticket
that actually builds the asking-and-answering loop needs otherwise.

**This ticket adds no text input, no server call, and no LLM.** `ReflectionPage` renders through
`Shell` exactly like `HistoryPage` does — `title="Reflect"`, `nav={<Nav />}`, `action={<SettingsLink
/>}` — with exactly two states, both read-only:

- **Sync off** (`useSyncEnabled()` false): a hint that Reflection needs a Server URL, matching the
  tone and structure of the Composer page's existing Sync-off hint rather than inventing new copy
  style. The gate is real, not cosmetic, and the reason is not the one Sync has: Reflection's
  retrieval and inference both run on the Server, over the Entries Sync has put there. A Device
  with no Server URL has sent it nothing, so there is nothing to ground an Answer in — CONTEXT.md
  requires Grounding to come from the user's own History, and the Server's copy of that History is
  what Reflection reads. Today the gate only ever shows the hint; it exists now because a later
  ticket's Question needs somewhere to go.
- **Sync on**: an empty-Conversation invitation to ask a Question about History. No Conversation
  has started, so there is nothing else to render.

## Alternatives considered

- **Reflection as an app-bar action, next to Settings.** Rejected on CONTEXT.md's own terms:
  Settings configures the Device; Reflection is a way of reading History, exactly the relationship
  Composer and History already have to each other. Filing it as a utility would misrepresent what
  it does.
- **A fourth route replacing one of the existing two**, e.g. folding History into Reflection.
  Rejected: they answer different questions — History is the ordered record, Reflection is asking
  something about it — and 0018 already rejected merging Composer and History for the same
  redundancy-vs-directness trade. That trade is not this ticket's to reopen.
- **A `conversations` table now, ahead of need.** Rejected as premature: nothing in this ticket
  asks a Question, so nothing needs to survive a reload yet, and a schema decision made without a
  real read/write pattern in front of it is a guess. Building it when the asking-and-answering
  ticket actually needs persistence — if it ever does — means designing it against a real shape
  instead of one imagined now. *(That ticket arrived; the answer was no local table at all —
  see [0025](0025-sessions-are-held-by-the-server.md).)*

## Consequences

Reflect showing in the nav on every page, including on Sync-off Devices, advertises a destination
that today only ever shows a hint — there is no way yet to act on it. This is the same shape 0018
already accepted for History before Search existed: a real, addressable route that does less than
its final version will, rather than hiding the destination until it is finished.

A reader who starts a Conversation, reloads, and finds it gone will see this as data loss unless
the reason is visible somewhere. This ticket does not add that messaging — Reflection has nothing
to lose yet, since no Question can be asked — but the ticket that adds the asking-and-answering
loop should surface CONTEXT.md's own framing (a Conversation "belongs to the Device it happened on
and does not Sync") rather than let a reader discover the boundary by losing something.

`CONTEXT.md` already gained Reflection, Question, Answer, Conversation and Grounding ahead of this
ADR — this decision consumes that vocabulary rather than introducing it, and adds nothing new to
the glossary itself.
