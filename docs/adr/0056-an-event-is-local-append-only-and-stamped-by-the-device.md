# 0056: An Event is local, append-only, and stamped by the Device that recorded it

## Status

Accepted. Builds on [0011](0011-sync-is-opt-in-an-unset-server-url-means-sync-is-off.md) (Sync's
opt-in decision, one of this ADR's own two load-bearing reasons), on
[0028](0028-entries-are-mutable-sync-carries-a-compacted-change-log.md) (the compacted-change-log
machinery this ADR deliberately does *not* need, and the precedent — `entries.created_at` — this
ADR's own `occurredAt` is a third instance of), and on
[0055](0055-sync-carries-four-more-entity-streams-and-a-second-task-order.md), whose per-stream
Cursor, per-stream advisory-lock key and `#[serde(default)]` accommodation this ADR's own seventh
stream reuses without re-deriving. Reuses [0047](0047-a-task-is-a-second-root-noun.md)'s "a second
root noun, not a bigger existing one" move a sixth time. Settles the forward reference issue #180's
own `comment-store.ts` left open ("editing a Comment records an event, diverging from Todoist" — see
this ADR's own Decision for where that divergence is actually made and why).

## Context

Nothing in meologue records what happened to a Task. A reader can see a Task's current state — its
title, its date, whether it's done — but not that it was rescheduled twice last week, who moved it
into a different Project, or what got finished yesterday. Issue #184 asks for that record: Todoist
calls it Activity, and it's the log this ADR gives meologue's own name to — Event, added to
CONTEXT.md by this ticket.

**The reference implementation's own Activity log lives on its server, and each row is stamped the
moment it arrives there — not when the act it describes actually happened.** This was measured
directly, not assumed: an action performed while offline at 23:24:44 was logged with a timestamp of
23:25, the minute the Device carrying it reconnected and pushed. The Device that performed the act
holds the true time it happened — Todoist's own optimistic UI even encodes it, in the temporary id
it assigns before the write round-trips — and the server-stamped design discards that fact the
moment the row is written.

That design is wrong for meologue twice over, for reasons specific to decisions this app has already
made and the reference implementation hasn't:

1. **Sync here is opt-in (ADR 0011).** A Device with no Server URL configured has never contacted a
   server and, under Todoist's own design, would have no Activity log at all — not a locally-visible
   one that simply hasn't Synced yet, but nothing, because the log's only copy lives on a server that
   Device has never spoken to. Every other root noun in this codebase — the Entry first, a Task since
   ADR 0047, Projects/Sections/Labels/Comments since — works fully offline and Syncs opportunistically
   when a Server URL exists. An activity log that structurally requires a Server from the first
   write is not that; it would be the one piece of this app's data model an offline-only Device
   can never have.
2. **Work done offline would be recorded as having happened when the network came back, not when it
   was done.** This is the 23:24:44-becomes-23:25 measurement above, generalised: a Device that
   completes three Tasks on a train, then reconnects at the station, would show all three finishing
   at the moment of reconnection — a log whose entire point is "what happened when" getting the
   "when" wrong for exactly the case (offline work) a personal, local-first app is built to handle
   well.

**There is a direct precedent for trusting a Device's own clock over a server's arrival time: `Entry.
createdAt` already does this, and has since this project's first migration.** Nothing about Sync's
compacted change log (ADR 0028) or its `seq`-reassignment rule ever touches `created_at` — an
Entry's `seq` records arrival order for Cursor purposes, and `created_at` separately records when
the Entry was actually captured, on the capturing Device's own clock, full stop. `Task.createdAt`
and every other root noun added since carries the identical split. An Event asking for "the acting
Device's own clock" is not a new kind of trust this codebase has to invent; it is the one trust
every other timestamp here already extends, applied to a sixth root noun.

## Decision

**An Event is local, append-only, and Syncs like every other root noun in this app — never held
only on a Server.** It gets its own table (`events`, migration 0017 server-side, migration 15
client-side), its own `EventStore` (`packages/core/src/event-store.ts`), and its own Sync stream,
following ADR 0051/0055's shape exactly: its own Cursor, its own advisory-lock key
(`EVENT_SYNC_INSERT_LOCK_KEY`), its own `insert_*`/`fetch_*_since` pair in `server/src/sync.rs`. A
Device with no Server URL configured records Events into its own local `events` table from the
first write, exactly as it already records Entries and Tasks — Sync remaining off (ADR 0011) means
this Device's own log simply never reaches another Device, not that it has no log at all.

**Every Event is stamped with `occurredAt`, the acting Device's own clock at the moment the act
happened — never the time a Server received it.** This is this ADR's entire reason for existing,
restated as the field it becomes: `occurredAt` is set once, by the Device performing the act,
carried unchanged through Sync (`server/src/sync.rs`'s `insert_events` never touches it), and never
recomputed from a server's own `now()`. It is the third instance of the precedent this ADR's own
Context section names — `entries.created_at`, then `tasks.created_at`, now `events.occurred_at` —
not a new kind of trust invented for this ticket.

**Append-only means this stream needs no last-writer-wins rule, which makes it structurally simpler
than every mutable stream before it, not harder.** Every other root noun in this codebase is
*mutable*: ADR 0028's compacted change log exists because a Task, a Project, a Comment can go from
one state to another, and something has to decide which of two conflicting states wins when two
Devices each changed the same row offline. An Event cannot go from one state to another — it is
written once, by the act it records, and nothing in this app's design ever edits or removes it
afterward (not even deleting the Task it's about: `task:deleted` is itself an Event, and it does not
retract the `task:added` Event that came before it). Two Devices can therefore never *disagree*
about the same Event, only each hold Events the other doesn't have yet — there is no conflict for a
last-writer-wins rule to arbitrate, and importing ADR 0028's `is distinct from` machinery to guard
against a conflict that cannot occur would be complexity this stream has no use for.

**The replay guard this ADR actually needs reduces to "insert if absent."** Every mutable stream's
`insert_*` in `server/src/sync.rs` needs an `is distinct from` chain across its own mutable columns,
because a second push under an id already on the table might be a genuine edit or might be an
already-applied write replayed by a retry — only that comparison tells the two apart, and getting it
wrong either silently drops a real change or reassigns `seq` on a no-op. An Event has no mutable
column for that comparison to span: nothing in this app's design ever writes a second, different
version of an Event under an `id` already on the table, so a second push under an existing id can
only be a replay — a retried request, a redelivered response, two Devices that each still hold the
same already-synced row in their own `pending()`. `insert_events`'s own `on conflict (id) do
nothing` says exactly that: apply it once, the first time this table sees this `id`, and treat every
subsequent push under the same id as nothing to reconcile — no `seq` reassignment, no risk of a
replay jumping an already-synced row back to the head of the log and costing every other Device a
redundant re-pull. See `insert_events`'s own doc comment (`server/src/sync.rs`) for this reasoning
worked through in full, including why the advisory lock is still needed even though nothing is ever
reassigned: two concurrent first-inserts could still commit out of order relative to their own
`seq` values without one.

One layer down, the client's own `EventStore.upsert()` — Sync's pull-side write door — still
**overwrites** on conflict rather than mirroring the server's insert-if-absent, and this is
deliberate, not an inconsistency: the one case that write door has to handle correctly is the echo
of this Device's own pending push landing back with a confirmed `seq` where it left with `seq:
null`, and an insert-if-absent door would refuse that update, leave the row `pending()` forever, and
re-push the same Event on every future sync tick. Since an Event's *content* never legitimately
differs between two calls sharing an id, an unconditional overwrite is equivalent to "insert if
absent" in every case except this one, where it must not be a no-op. `EventStore.record()` — the
door a local act actually writes through — is the one that stays insert-if-absent, because that
door only ever originates a fresh id.

**`PROTOCOL_VERSION` stays 6 — Events land additively inside the existing v6 wire shape, the first
stream in this codebase's history to earn no bump of its own.** Every stream before this one bumped
the version because a Device that predated it had no way to represent what the bump introduced.
Events don't share that problem: `SyncRequest`/`SyncResponse` grow `events`/`since_event_seq` and
`event_cursor` as ordinary `#[serde(default)]` fields, the identical accommodation every earlier
bump's own new fields already needed for the release that introduced them — a pre-#184 v6 build's
request genuinely has no `events` key, defaults to an empty push, and its response carries a
populated `events` array it simply never reads (an extra JSON key ignored, the same tolerance every
wire response here already relies on). There is, deliberately, no `protocol_version` gate on the
Event stream's own push/pull in `run_sync`, unlike every stream ADR 0051/0055 added: a version gate
exists to tell a Device "the wire shape you already know has changed," and no version number
separates a pre-#184 v6 build from a post-#184 one — both report `protocol_version: 6` — so a gate
here could not distinguish anything the `#[serde(default)]` fields don't already handle on their
own. See `PROTOCOL_VERSION`'s and `SyncResponse::events`'s own doc comments (`server/src/sync.rs`)
for this argued in full.

**The event taxonomy is copied from the reference implementation, not invented.** `event_type`:
`added · deleted · updated · archived · unarchived · completed · uncompleted · moved`. `object_type`:
`task · comment · project · section` — deliberately **no `label` type**: a Label change is recorded
as a `task:updated` Event carrying the Label in its own `extra`, matching the reference exactly
rather than the more regular "every root noun gets its own object type" shape this codebase's other
five streams might otherwise suggest. Recorded: adding, completing, uncompleting, renaming,
rescheduling (date and deadline independently), re-prioritising, labelling, moving (Project,
Section or parent), commenting on, and deleting a Task; Project and Section add/rename/archive/
unarchive/delete. Not recorded, each verified directly against a real reference build rather than
assumed: reordering, collapsing a Section, and merely opening a Task.

**A changed value's own previous state travels in `extra`, and whether to render "you set X" or "you
changed X" is a render-time decision, never a second `event_type`.** `events.extra` is one `jsonb`
column (`packages/core/src/event-types.ts`'s own doc comment explains why one column rather than a
wide table of nullable `last_*` pairs, one per attribute a Task can carry) holding whatever the
specific event needs — `{ date, lastDate }` for a reschedule, `{ content, lastContent }` for a
rename. `format-event.ts`'s `describeEvent` (apps/web) is where "set" vs. "changed" actually gets
decided, purely from whether `extra`'s own `last_*` counterpart is present — the event_type is
`updated` either way, exactly as issue #184's own acceptance criterion asks for.

**One deliberate divergence from the reference: editing a Comment is recorded here, and isn't
there.** Todoist's own Activity log has no "updated comment" category at all — an edit simply leaves
no trace. That is schema debt inherited from however Todoist's own log was designed, not a
principle meologue has any reason to import: an audit trail that a Comment's own edit can silently
bypass defeats the one thing an audit trail is for. `comment:updated` is recorded, alongside
`comment:added` and `comment:deleted`, and this ADR's Decision states the divergence explicitly so a
future reader comparing against the reference finds an argued choice rather than an oversight to
"fix."

**Three surfaces read the same log, narrowed differently: a Task's own history, a Project's own, and
the view across everything — never a fourth, separate Completed destination.** `EventStore.
listByTask`/`listByProject`/`list()` are the three reads; `apps/web`'s `ActivityFeed` component is
the one renderer behind all three (`activity-feed.tsx`'s own header comment: "what differs between a
Task's own history and the view across everything is only which Events the caller hands in, never
how they're rendered"). Completed work is reached by narrowing the same log to `completed` Events —
a checkbox above the feed, not a second view — mirroring exactly how the reference's own "Go to
Completed" is its Activity view pre-filtered rather than a destination of its own. Grouped by
calendar day, newest first; a recent Event (within the last day) reads as a relative time, an older
one as an absolute one — `format-event.ts`'s own `groupEventsByDay`/`eventTimestamp`. Retention is
**unlimited**: the reference's seven-day cap on this same log is a paywall gate, not a design
worth matching — this project's own scope discipline (CLAUDE.md) draws the line at complexity a
personal task list's own scale doesn't ask for, and an artificial cap on a *local* log a Device
already holds in full is exactly the kind of complexity that would be, not a simplification.

**No `deleted_at`.** Every table ADR 0028 governs carries a tombstone column because a mutable row
can travel from something to nothing, and absence-of-row cannot itself cross Sync — so "removed" has
to be a surviving row with a flag. An Event has no "nothing" state: it is never edited or removed
once written, so there is nothing for a tombstone to represent. `events.created_at` doesn't exist
either, for a related reason — `occurredAt` already is the one timestamp that means anything here
(../../packages/core/src/event-types.ts's own header comment on why a second, "when this row was
locally written" timestamp would either duplicate `occurredAt` exactly, on the originating Device,
or mean nothing at all, on a Device that only received the row over Sync).

## Alternatives considered

- **Hold the log on the Server, matching the reference exactly.** Rejected for the two reasons this
  ADR's own Context section argues in full: Sync is opt-in here (ADR 0011), so a Device with no
  Server would have no log at all; and a Server-arrival timestamp is measurably wrong for work done
  offline, which is precisely the case a local-first app exists to serve well.
- **Keep the log local-only, with no Sync stream of its own.** Closer to correct than the
  Server-only design, but still wrong: a Device's own activity would never reach its other Devices,
  which fails the acceptance criterion directly ("Events reach other Devices... two Devices writing
  while offline both keep their events") and treats Events as a lesser root noun than the five
  before it for no argued reason.
  It would also have made the record's usefulness depend on which Device happened to perform an act
  — the opposite of what a cross-Device journal is for.
- **Reuse ADR 0028's compacted-change-log machinery wholesale — an `is distinct from` guard, `seq`
  reassignment on every write.** Rejected as unnecessary complexity, not merely avoidable complexity:
  nothing about an Event's own shape ever produces the conflict that machinery exists to arbitrate
  (this ADR's own Decision walks through why), so building it in anyway would be importing a rule
  this stream can never trigger, for no benefit and a real maintenance cost — a future column
  addition to `events` would otherwise need to remember to extend a guard chain that can never
  actually fire.
- **A server-computed `event_type` union enforced as a Postgres `enum`.** Rejected the same way
  `tasks.priority`'s 1-4 range already is (`task-fields.ts`): the vocabulary is validated at the
  edge that actually knows it — the client's own `EventType`/`ObjectType` union types — rather than
  by a database constraint that would need its own migration the day this vocabulary grows.
- **Bump `PROTOCOL_VERSION` to 7 for this stream, matching every stream before it.** Rejected once it
  became clear no version number could tell a pre-#184 v6 Device apart from a post-#184 one in the
  first place (both report 6) — a bump here would cost every `/v1/sync` caller, Events-curious or
  not, an unnecessary dual-version window for a change that introduces nothing incompatible with
  what a v6 Device already expects. See the Decision's own paragraph on this for the argument in
  full, and `PROTOCOL_VERSION`'s own doc comment (`server/src/sync.rs`) for where a future reader
  should look first if tempted to "clean up" this stream into looking like the others.

## Consequences

**A sixth root noun is a real, ongoing cost, paid the way ADR 0047 already named for the first one:
Sync, Export, and every cross-cutting concern this codebase has now has one more place to
remember.** This ADR does not pretend that cost away. It is smaller than each of the five before it,
though, precisely because append-only removes an entire axis (conflict resolution) every earlier
root noun had to pay for.

**A future column added to `events` needs no `is distinct from` chain to extend — there isn't one —
but it does need to ask honestly whether the new column stays immutable.** The day something wants
to *edit* an Event (not merely add a new one), this ADR's whole "no conflict is possible" argument
stops holding, and that day's own ticket has to reopen this decision rather than bolt a mutation
onto a stream built assuming none would ever exist.

**`EventStore.upsert()`'s overwrite-on-conflict behaviour is easy to misread as sloppy, and isn't.**
A future reader who notices every other *local-write* door in this codebase (`record()` included)
being insert-if-absent, and only `upsert()` overwriting, might "fix" the inconsistency. Doing so
would break the one case `upsert()` exists to handle — confirming this Device's own pending push —
and silently reintroduce infinite re-pushing of every already-recorded Event. `EventStore.upsert()`'s
own doc comment states this explicitly for exactly that reason.

**Retention staying unlimited is a decision this ADR makes now, not a gap left for later.** A future
ticket that wants to bound it — for storage, for rendering cost at real scale — is answering a
different, harder question (what to do with an Event once it's no longer wanted) than the one this
ADR answers (whether to cap it from the start), and should treat this ADR's own reasoning as the
starting position to argue against, not a default nobody chose on purpose.
