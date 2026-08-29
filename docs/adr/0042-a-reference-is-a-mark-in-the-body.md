# 0042: A Reference is a mark in the body

## Status

Accepted. Builds on [0041](0041-prose-renders-as-inline-markdown-at-render-time.md), whose parser
this ADR adds two marks to. Relies on the keyset cursor issue #79 added to `EntryStore` under
[0016](0016-export-is-per-day-text-plus-a-lossless-manifest.md), and on
[0028](0028-entries-are-mutable-sync-carries-a-compacted-change-log.md) for what a removed Entry
is. It supersedes nothing.

## Context

The ask was specific, and worth quoting because the obvious reading of it is wrong:

> "I forgot to type something in yesterday… I can just type in today but it just know that it
> belongs to yesterday… that's almost unreachable by me or reflect anywhere in future."

That describes two different features wearing one sentence, and only one of them should exist.

**Belonging** would let an Entry captured today sit in History under yesterday. That is a second
timestamp in everything but name. It changes ordering, it changes which Period a Digest covers, it
changes what Export writes for a day, and it makes "when was this captured" ambiguous for every
consumer downstream. `CONTEXT.md` already says an Entry's capture time is the thing that never
changes — "editing an Entry does not move it in History, no matter how long ago it was captured."
Belonging contradicts that directly, and it was cut.

**Referring** is the part that answers the actual complaint. The complaint is about
*reachability*, not about placement: the thought is hard to get back to. Something written today
can point at yesterday without pretending to have been written then.

The word "reply" was used in discussion and is the wrong word here. `CONTEXT.md` refuses "message"
for an Entry because a message implies an addressee, and notes that the pull toward it is
strongest inside chat-shaped UI, "which is exactly why it is worth refusing here." A reply carries
the same implication. Pointing at your own earlier thought has no addressee at all.

## Decision

**A Reference is text inside the body, not a field on an Entry.** `[[YYYY-MM-DD]]` points at a
day; `[[e:<id>]]` points at an Entry. Nothing about `Entry` changes: no new column, no client
migration, no server migration, no `EntryInput`/`EntryOutput` change, and `PROTOCOL_VERSION` stays
at 4 — which matters, because bumping it 426s every Device that has not updated. Export writes the
marks as the characters they are. A structural `replyTo` field would have bought a link that
survives body edits, and cost all of the above; it was not worth it for a feature whose entire
purpose is reachability.

**Referring is not belonging, and the code says so by having nowhere to put it.** Because a
Reference lives in the body, there is no mechanism by which one could move an Entry, and so no
mechanism to get wrong later.

**The Entry form is prefixed: `[[e:<id>]]`, not a bare `[[<id>]]`.** A uuid and a date are
trivially distinguishable today, so the prefix buys nothing *now*. It buys the next thing: natural
language dates (`[[yesterday]]`, `[[last Tuesday]]`) were deferred but wanted, and they need the
unprefixed space. Resolution happens strictly inside the brackets, so bare prose "yesterday" is
never touched.

**An unresolvable Reference is its own literal text — one rule, four causes.** A day holding no
Entries, an Entry that was removed, an Entry that has not Synced to this Device yet, and a
malformed mark all render identically: the characters the user typed, not interactive. Two of
those come for free — the parser refuses a mark that is not a real calendar date or a well-formed
id, so a malformed Reference never reaches the renderer at all. The rule is self-healing: an
unsynced target becomes a live Reference the moment it arrives.

**Whether a day is empty is answered by the store, not by what History has loaded.** History pages
backwards, so a day from last year is absent from the loaded set for the ordinary reason that
nobody has scrolled that far. Treating absent as empty would have left almost every Reference to
the past dead. `dayHasEntries` instead asks the existing keyset cursor for the newest Entry
strictly older than the instant the day ends, and checks which day that Entry falls on — one walk
of the `(createdAt, id)` composite index, one row, cached per day, against local SQLite. **No
`EntryStore` widening**: issue #79 already reopened exactly as much of ADR 0016's rejected
alternative as was safe, and this needed none of the rest.

The cursor id for that probe is the empty string, deliberately. The cursor means `createdAt < X OR
(createdAt = X AND id < Y)`; with any ordinary id, an Entry captured at exactly midnight would
satisfy the equality branch and answer for the day *before* it. Nothing sorts below `""`, so that
branch matches nothing and the predicate collapses to the half-open range a day actually is.

**Following a Reference pages until it arrives, rather than seeking by index.** Reads are local
SQLite (ADR 0001/0007), so at a few Entries a day, reaching back a year is tens of local queries.
Paging keeps two-way scroll continuity for free and needs no new store capability.

**The scroll pin is disengaged for the duration of a seek.** This is the part that is not
optional. `usePinnedScroll` re-pins to the newest end on every `watch` change, and every loaded
page changes `watch` — so without a `seeking` flag each page dragged the reader back to the bottom
and the seek never converged. The ResizeObserver's re-pin reads that flag through a ref rather
than a closure, because it is a persistent callback outside the render cycle and would otherwise
go stale. Issue #79's prepend anchor is deliberately left running: preserving position across a
page landing above the reader is exactly what a seek wants.

**The target is carried in a query param, not a path segment.** `/composer` has no child routes,
so `/composer/2026-08-28` would not route at all; and the chat list matches `/composer` with
`end: true`, so a segment would also cost `aria-current` at the wide breakpoint. A query param
leaves both intact. It has to be in the URL at all because a Reference can be followed from a
different Destination — Grounding, or the Digest reader.

**Reflection gains no tool.** It was going to: an `entries_on_date` sitting beside a `[[date]]` is
one inferential step for the model rather than two. But `entries_in_range` already returns exactly
one whole local day when `from == to`, so a fifth tool would be a second path to a call that
exists — and ADR 0037 ties the advertised tool list to Server capability, which is not a thing to
grow for a redundant path. The syntax is taught in that tool's `guidelines()` instead, including
the part a model most needs to be told: an Entry id **cannot** be resolved, because no tool looks
an Entry up by id. It is a signal that two Entries are connected, not a handle.

**The Server is never told it may emit a Reference.** The prompts are unchanged on this point.
Marks reach the model verbatim, because an Entry is rendered to it as `[YYYY-MM-DD] body` and
nothing rewrites the body — so Reflection can read one. It is simply not asked to write one.

## Alternatives considered

- **A `replyTo` field on `Entry`.** A real link, indexable, surviving body edits. Costs a change in
  five places, a client and a server migration, and a `PROTOCOL_VERSION` bump that hard-fails older
  Devices with a 426 — for a feature that works as text.
- **Backdating an Entry ("belonging").** What the ask literally described. Rejected: see Context.
- **Autolinking bare dates instead of an explicit mark.** No syntax to learn. Rejected because it
  would linkify dates nobody meant as links, and because it leaves no room for the deferred
  natural-language dates.
- **Deciding emptiness from loaded History.** Free, and wrong for exactly the Entries this feature
  is for.
- **Adding an `after` cursor to `EntryStore` and seeking directly.** The interface change ADR 0016
  rejected. Paging is fast enough on local SQLite that it buys nothing.
- **A path segment, `/composer/:day`.** Reads better. Does not route, and costs `aria-current`.
- **A fifth Reflection tool, `entries_on_date`.** Recommended at one point and reversed once the
  syntax explanation moved into `guidelines()`, which can hang off the tool that already does the
  work.

## Consequences

**1. A Reference can break in a way a foreign key could not.** Editing an Entry's body can damage a
mark inside it, and nothing prevents that or warns about it. This is the accepted cost of keeping
the body one plain string; the failure is benign — a damaged mark is text.

**2. Rendering a Reference costs a lookup.** A chip resolves its target live rather than storing a
snapshot, so editing a referred-to Entry updates every chip pointing at it — but each distinct
target and each distinct day is a query. They are cached per id and per day, and they are local, so
this is cheap; it is not free.

**3. The answer changes as Entries arrive.** A Reference to a day that is empty today becomes a
link when something lands on that day. That is correct and self-healing, but it means the same
Entry can render differently at two moments without being edited.

**4. `usePinnedScroll` now has a mode.** Anything added to it later has to decide what it does
during a seek. The flag is small, but it is a second state the hook can be in.
