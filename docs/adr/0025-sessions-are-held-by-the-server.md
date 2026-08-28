# 0025: Sessions are held by the Server, and the Device holds nothing

## Status

Accepted. Supersedes [0020](0020-reflection-is-a-third-navigation-destination.md)'s "a Conversation
lives only in memory on the Device, in no new local table" clause — and supersedes it in the one
direction 0020 did not anticipate, since 0020 assumed the question it was deferring was *which local
table*. 0020's placement of Reflection as a third nav destination, its `/reflect` route inside
`EntryStoreLayout`, its Sync-off gate and its reasoning for keeping Settings an app-bar action all
stand unchanged and are still load-bearing. 0020 is amended in place to record this.

Amended by issue #108, which reverses this ADR's "nothing is written until an Answer succeeds"
clause for the `sessions` row itself — see the "Amendment (issue #108)" section at the end.

Partially reversed, in one narrow direction, by [0030](0030-the-shell-gets-a-root-screen.md): the
Device now remembers exactly one Session id, in `sessionStorage`, as a fallback for a bare
`/reflect` — leaving Reflect for the Composer and returning used to open a fresh Session and
silently discard whatever Conversation had been open, which stopped being a small loss once a
Session held real inference behind it. This is deliberately narrower than it may sound: this ADR's
"the Device stores nothing at all" clause is reversed only for *which* Session a bare `/reflect`
resolves to, never for *what* a Session contains — the Server still holds every Session's
Conversation, the URL is still authoritative and still the only thing a reload reads from, and the
remembered id is only ever consulted when the URL itself carries none. Every other decision this
ADR made — the Server as sole holder, no local mirror of Session content, no create endpoint, LWW
by server arrival — stands unchanged and is still load-bearing.

**Amended by [0033](0033-a-session-is-an-append-only-entry-tree.md): this ADR's assumption about
what a Session is *made of* — a sequence of Question/Answer pairs, one row per Turn — no longer
holds, once [0031](0031-reflection-is-a-loop-over-tools.md) made answering a Question take an
unpredictable number of model replies and tool calls rather than exactly one round trip. 0033's
append-only entry tree replaces the per-pair storage this ADR's Decision and Consequences sections
describe (`session_turns`, dropped by migration `0008`). Everything else this ADR decided —
*where* a Session lives, that it's addressed by an id in the URL, that the Device stores nothing —
is untouched by 0033 and stands exactly as written below.

## Context

0020 decided a Conversation lives only in memory, and was explicit that this was a deferral rather
than a conclusion:

> Building it when the asking-and-answering ticket actually needs persistence — if it ever does —
> means designing it against a real shape instead of one imagined now.

That was correct at the time: 0020 built Reflection as a *place*, with no way to type a Question, so
nothing existed to persist and any schema would have been a guess. ADRs 0021 through 0024 then built
the asking-and-answering loop. The real shape now exists, and it is not the shape 0020 imagined.

Three things changed the answer.

A Conversation stopped being disposable. When the only Conversation you could have was the one on
screen, losing it on reload cost you a few minutes. Now a Question costs roughly fifteen seconds of
inference and an Answer is worth returning to, so the same reload is a real loss — and 0020 itself
flagged that a reader "will see this as data loss unless the reason is visible somewhere."

Reflection is already gated on a configured Server. 0020's own Sync-off gate exists because
"Reflection's retrieval and inference both run on the Server, over the Entries Sync has put there."
A Device with no Server cannot ask a Question at all. So putting Conversations on the Server adds no
dependency that Reflection did not already have — which is the fact that makes this cheaper than it
looks.

And the interesting property is not durability. A local table would have survived reload. What a
local table cannot do is let a Conversation started on a laptop be continued on a phone, and that —
not surviving F5 — is what a Session is worth building for.

## Decision

**A Session is held by the Server, and the Device stores nothing at all.** No local table, no
`localStorage` key, no mirror of the Session list. `CONTEXT.md` now defines Session as the durable
container the Server holds for one Conversation. Every read is a fetch when a Session is opened;
there is no cache, and therefore no invalidation, no staleness rule, and nothing to reconcile when
another Device adds or removes a Session.

**Sessions are shared across every Device, not scoped to the one that created them.** This is the
whole point, and it follows the grain of ADR 0003 rather than cutting across it: there is no
authentication and no user table, so anything that can reach the Server is already trusted with
every Entry the user has ever written. Sessions being reachable from every Device is the same trust
boundary applied to the same data, not a wider one. Scoping Sessions by `device_id` was possible and
would have preserved `CONTEXT.md`'s previous "does not Sync" sentence — but it would have paid the
full cost of tables, endpoints and a round-trip on open to buy only durability, which a forty-line
`localStorage` blob would also have bought.

**The Session id lives in the URL, and the URL is the only state.** `/reflect` is a fresh Session;
`/reflect/<id>` is an open one. A reload restores the Conversation because the id was never anywhere
else to lose, so "survives a reload" is a consequence of where the id lives rather than a feature
with its own machinery. This is also what lets the local Device store stay empty: the one piece of
state a Device would otherwise have had to remember is already in the address bar. Session ids
contain no `.`, preserving the constraint recorded in `App.tsx` — Capacitor treats a dot in the last
path segment as a request for a real file rather than the app shell.

**Asking with no Session id is what creates a Session; there is no create endpoint.** A null
`session_id` on `/v1/reflect` mints a Session and the response carries its id and title. This is one
round-trip instead of two, one fewer endpoint, and — the part that actually matters — it makes a
Session holding an empty Conversation unrepresentable. A Session exists because a Question was
answered in it, so the list can never accumulate empty rows a user has to reason about.

**Nothing is written until an Answer succeeds.** The Session and its turn are recorded in one
transaction at the single response-construction point, so a failed ask leaves no Session and no
turn. The alternative — writing the Session on receipt and the turn on success — would put empty
Sessions back into the list by the back door, through exactly the failure paths ADRs 0023 and 0024
went to some trouble to make survivable.

**Fetching a Session is not Sync, and `PROTOCOL_VERSION` does not move.** Entry Sync is a background
loop with a Cursor that only ever advances, exchanging Entries a Device does not yet have (ADR
0002). Fetching a Session is a request made when a user opens one. They share nothing but a
transport. The version number belongs to Entry Sync, which this ADR does not touch — and since
`/v1/sync` reads the same constant, moving it would have made every un-updated Device fail to Sync
in order to describe a change to Reflection.

**The old whole-Conversation request field is deleted outright rather than deprecated.** Until now
the client replayed every prior Question and Answer on every request, because the Server held
nothing. Keeping that path alongside `session_id` would mean two sources of truth for one
Conversation, and the only thing it would buy is compatibility with builds that do not exist — every
target is rebuilt and verified together on each ticket.

## Alternatives considered

- **A local table, which is what 0020 was deferring to.** Rejected: it answers the question 0020
  asked (surviving reload) and not the one worth answering (reaching the Conversation from another
  Device). It would also have made a Conversation the first mutable, non-Entry record in a local
  store whose whole design leans on Entry immutability — 0020 was right that this is a big decision,
  and the right response was to not need it rather than to make it. - **One `localStorage` JSON
  blob, copying `settings.ts`'s hand-written pattern.** Genuinely the smallest thing that could work
  — roughly forty lines, no migration, no schema, shipping to all three targets today. Rejected
  because it buys only durability, caps out around 5MB on a record that grows with every Question,
  and cannot be reached from a second Device. It was the right answer to "make the Conversation
  survive"; it is not an answer to "make the Conversation portable". - **Mirroring the Session list
  on the Device for offline rendering.** Rejected: it is a cache, and it has a cache's problems — a
  Session deleted on another Device lingers, and pointing Settings at a different Server leaves
  every mirrored id dangling. What it buys is a list that renders offline, every row of which is
  unopenable, since opening a Session needs the Server. Fetching live is strictly less code and
  strictly more correct. - **Bumping `PROTOCOL_VERSION` to describe the new request shape.**
  Rejected on blast radius: the constant is shared with `/v1/sync`, so the bump would be paid by
  Entry Sync — the actual product — to describe a change in a feature built on top of it. - **A
  separate `POST /v1/sessions` to create a Session before the first Question.** Rejected: an extra
  round-trip, an extra endpoint, and it makes an empty Session representable, which then needs its
  own rules about when to clean one up.

## Consequences

Reflection's dependence on the Server deepens in kind, not just in degree. Before this, a Server
outage cost you the Answer you were waiting for; now it also costs you every past Session until the
Server returns. Reflection was already unusable without a Server, so no Device loses a capability it
had — but the surface that goes dark during an outage is larger, and the Sessions screen has to say
so rather than render as empty.

**Questions are now durably stored on the Server, where before they only passed through it.** ADR
0021 recorded that Entry text leaves the process on every embedding and chat call, and that pointing
chat at a hosted provider is a visible operator choice. This is a different thing and worth naming
separately: the user's own Questions — which are often more revealing than the Entries they ask
about, because a Question says what someone is worried about — are written to a table and kept.
Under ADR 0003 anything that can reach the Server can read them, exactly as it can already read
every Entry.

A Conversation restored on a Device whose Entries have not caught up will render the "this Entry
hasn't reached this Device yet" placeholder in its Grounding disclosure. That path already exists
and was built for a rarer case; it stops being an edge case, because a Session opened on a second
Device is now an ordinary thing to do.

Deleting becomes possible in an application where nothing was deletable. Entries are immutable by
design and there has never been a remove affordance anywhere; a Session is the first thing a user
can destroy, and destroying it takes effect on every Device. That asymmetry needs to be visible in
the interface rather than left to be discovered.

The replay of a Conversation into each chat call is now unbounded in a way it was not before. It was
always unbounded in principle, but a Conversation died on reload, so no Conversation ever got long
enough to matter. A Session returned to over weeks makes it matter, against an endpoint that costs
roughly seven seconds a call and carries no timeout. That is a real consequence of this decision and
is addressed in its own ticket rather than here.

Two Devices asking in the same Session at the same time will interleave their turns. Turns are
append-only and ordered by a server-assigned sequence, so nothing is lost and nothing is corrupted;
the Conversation simply reads as though one person asked two things at once, which is what happened.
This is accepted rather than solved — the alternative is locking a Session to one Device, which
would undo the property this ADR exists to provide.

## Amendment (issue #108): the Session row is written on receipt after all

This ADR rejected one alternative by name:

> The alternative — writing the Session on receipt and the turn on success — would put empty
> Sessions back into the list by the back door, through exactly the failure paths ADRs 0023 and
> 0024 went to some trouble to make survivable.

Issue #108 takes that alternative. It is worth being plain that this is a reversal of a decision
this document argued, not a detail it left open.

**What forced it.** Issue #91 built `session_records`, the operation log, whose entire purpose is
that after an interrupted run it is answerable which tools started and which results landed. Issue
#108 found that nothing ever wrote to it — the table was always empty, so #91's own acceptance
criterion was unmet. Wiring it up runs straight into this ADR: `session_records` has a foreign key
to `sessions`, and under "nothing is written until an Answer succeeds" there is no `sessions` row to
key against while the run is still going. Buffering the records and writing them at the end with
everything else is not a smaller version of the feature; it is the absence of it, because a run that
crashes never reaches the end. A log that only survives runs that didn't need logging is not a log.

So `resolve_session` now mints the `sessions` row up front, before the first SSE frame, and a failed
Question leaves that row behind with no entries under it.

**Why the reason for the original decision still holds.** The property this ADR actually wanted was
never "the row cannot exist" — it was "the list can never accumulate empty rows a user has to reason
about." That property is intact, moved to where it is observed: `list_sessions` now requires a
Session to have at least one entry before it is listed. The search branch already joined
`session_entries` and needed no change, which is itself a small piece of evidence that the guarantee
was always really about the list.

An orphaned row is also unreachable rather than merely unlisted. A Device only ever learns a
`session_id` from a successful `agent_end`; the failure frame carries none, so there is no id to
navigate to. What remains is a row in a table that nothing displays, and — recorded honestly rather
than discovered later — those rows accumulate. Nothing reaps them today. That is a real cost of this
amendment, accepted because the alternative is an audit log that cannot audit the only case it
exists for.

**What did not change.** Turns are still written in one transaction at the end, once an Answer
exists, so a failed ask still leaves no Turn and no half-written Conversation — the half of "nothing
is written until an Answer succeeds" that was protecting against a corrupt Conversation, as opposed
to an untidy list, is untouched. See [0033](0033-a-session-is-an-append-only-entry-tree.md), which
this amendment also touches.
