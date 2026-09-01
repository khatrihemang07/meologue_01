# 0051: Sync carries two entity streams, and the Server speaks protocol 4 and 5 for one release

## Status

Accepted. Builds on [0002](0002-sync-cursor-server-assigned-sequence-advisory-lock.md) (the
advisory lock this ADR gives Tasks their own copy of), [0028](0028-entries-are-mutable-sync-carries-a-compacted-change-log.md)
(the compacted change log and `seq`-reassignment rule this ADR reuses rather than reinvents for
Tasks), [0042](0042-a-reference-is-a-mark-in-the-body.md) (the "an unresolvable reference degrades
to something honest and inert" precedent this ADR's own decision on a dangling `projectId` follows),
and [0047](0047-a-task-is-a-second-root-noun.md), which forward-referenced this ADR for exactly the
wire and protocol-version change it names but declines to make. Also settles the forward reference
[0050](0050-tasks-are-ordered-by-fractional-index.md) left open: `order_key` crosses the wire as
plain, opaque text the Server never interprets, alongside every other Task column. Supersedes
nothing.

## Context

`SyncRequest`/`SyncResponse` (`server/src/sync.rs`) have carried exactly one array and one Cursor
since ADR 0001 — Entries, `since_seq`/`cursor`. A Task (ADR 0047) is a second root noun with its
own table, its own store and its own lifecycle, and it needs to reach a user's other Devices the
same way an Entry already does. That is the first time this Server has ever Synced anything but an
Entry, and there is no second-entity precedent in this repo to copy: Sessions and Digests are both
held by the Server alone (ADR 0025, ADR 0027) and never Sync at all.

**Widening the wire contract is a protocol-version change, and that check is unforgiving.**
`sync_handler` has rejected any `protocol_version` that isn't the one exact value `PROTOCOL_VERSION`
names since ADR 0004, with a 426 — every bump so far (ADR 0028's tombstones, issue #96's SSE
Reflection shape, issue #104's event rename) accepted that a stale Device simply stops syncing until
it updates. That was fine when the alternative — a Device silently misrendering data it can't
represent — was worse. It stops being fine here for a reason specific to this change: Android, macOS
and web are three separate builds that ship on three separate schedules, so there is *always* a
window in which some Devices have updated past a bump and some haven't. Every previous bump's
"stop syncing until you update" cost that Device a Reflection feature, or an SSE shape it never
tries to parse until it opens Reflect. This bump's naive version would cost that Device its
*journal* — Entries, ADR 0001's own subject, would stop syncing over a Tasks feature that Device
may never even open. That is not a cost this ADR is willing to let a version bump impose as a side
effect.

**A Task can name a Project, Section or Label this ticket does not sync.** Issue #172 is scoped to
Tasks only — Projects, Sections and Labels already carry sync scaffolding (`seq`, a Cursor,
`pending()`) in their client-side stores, per ADR 0047's own Consequences, but none of it is wired
to a Server table yet (that is issue #173's scope). A Task's `projectId`, `sectionId` and
`labelIds` are plain, unvalidated ids (`packages/core/src/task-types.ts`'s own doc comments already
call a dangling one an "accepted, transient state" *client-side*), so a Task arriving on Device B
can name a Project Device B has never heard of at all. Something has to be decided about what that
Task looks like there, and it has to be decided here, not discovered later as a bug.

## Decision

**One endpoint, one round trip, a second array and a second Cursor.** `SyncRequest` gains
`tasks: Vec<TaskInput>` and `since_task_seq: i64`; `SyncResponse` gains `tasks: Vec<TaskOutput>` and
`task_cursor: i64` — sitting beside `entries`/`since_seq`/`cursor` rather than replacing them.
`TaskInput`/`TaskOutput` (`server/src/sync.rs`) mirror `EntryInput`/`EntryOutput` field for field,
including the tombstone convention (`deleted_at`, ADR 0028's rule applied unchanged) and the
excluded-from-update pair (`device_id`, `created_at` — a Task is identified by who created it and
never re-attributed on edit, exactly as an Entry isn't). A separate `/v1/tasks/sync` was the
obvious alternative and is rejected below. `packages/core/src/sync-engine.ts`'s `sync()` now takes
a required `taskStore` alongside `store`, and every loop iteration pushes and pulls both streams in
the same `transport()` call — a pending Task and a pending Entry that references it (ADR 0048)
always travel together, never in two round trips that could interleave with a third Device's writes
in between.

**Tasks get their own advisory-lock key, `TASK_SYNC_INSERT_LOCK_KEY`, not a second use of
`SYNC_INSERT_LOCK_KEY`.** ADR 0002's lock exists to make one table's commit order equal its own
`seq`-assignment order; Entries and Tasks each have their own `seq` sequence and their own Cursor,
and neither is ever compared against the other's. Sharing the key would serialise a Task push behind
an unrelated, concurrent Entry push (and vice versa) for a correctness guarantee neither stream
needs from the other — it would only forbid the two streams from committing concurrently, for
nothing. `insert_tasks` (`server/src/sync.rs`) reuses ADR 0028's guard shape wholesale: delete is
terminal (`where tasks.deleted_at is null`), replay is a true no-op (an `is distinct from` check
across every one of a Task's mutable columns, not only one — a Task has thirteen independent
setters where an Entry has one `body`, and the guard has to watch all of them or a replay of one
setter's already-applied write would still reassign `seq` on every redundant retry), and `seq` is
reassigned from `tasks`'s own `bigserial` on every write that changes something, exactly as
`entries.seq` already is.

**`PROTOCOL_VERSION` moves from 4 to 5, and for the first time the Server accepts a range, not a
single value.** `MIN_PROTOCOL_VERSION = 4` alongside it; `sync_handler` rejects only
`< MIN_PROTOCOL_VERSION` or `> PROTOCOL_VERSION`. A Device at exactly 4 is accepted, its request
body deserializes fine (`tasks`/`since_task_seq` are `#[serde(default)]` on `SyncRequest`, since a
real v4 build's JSON has neither key at all), and `run_sync` gates the entire Task half of the
response on `protocol_version >= 5` — a v4 Device's own push can never carry a Task by construction,
but without this gate its *pull* would still receive every Task any v5 Device had pushed, data it
has no wire representation for and never asked to see. The gate is what makes "a v4 Device keeps
syncing Entries and simply sees no Tasks" true of the response, not merely of what happens to have
been sent. This carve-out is deliberately narrow: `reflect_handler` (`server/src/reflect.rs`) keeps
its strict equality check unchanged, and a v4 Device now gets a 426 from `/v1/reflect` it didn't
get before — Reflection's own wire shape is untouched by this bump, but there is still exactly one
version number for "this Device's whole build is current," and a Device three protocol bumps behind
was never going to be told otherwise for a feature it also doesn't have on this build. Only
`/v1/sync` earns a carve-out, because only `/v1/sync` carries something — the journal — that has
nothing to do with the reason for this particular bump. `packages/core/src/protocol.ts`'s own
`PROTOCOL_VERSION` moves to 5 too, hand-mirrored as it always has been; there is no client-side
`MIN_PROTOCOL_VERSION`, because a Device only ever *sends* its own build's version — the acceptance
range is a Server-only concept.

**Health reports a `todo` capability, unconditionally `true`, and it locks nothing.**
`HealthCapabilities` (`server/src/health.rs`) gains `todo: bool`, set to a bare `true` rather than
read off `LlmConfig` the way `reflect`/`digest`/`embeddings` are: Task Sync has no model behind it
and nothing that can disable it short of the whole Server being down, so any Server that answers
`/v1/health` at all already accepts Tasks. It exists on the wire for a different reader than
`chat-list.tsx`'s lock check — issue #175's Digest and Reflection coverage of Tasks needs to tell
"this Server predates Tasks" (protocol 4) apart from "this Server has Tasks but nothing configured
to say about them," which no other field can distinguish. Todo's own row in `chat-list.tsx` keeps
`capability: undefined` and stays unlocked regardless: Todo works fully offline exactly like
Composer (ADR 0037's own reasoning, unchanged), and a capability that is definitionally always true
would be a strange thing to gate a lock on even if the temptation existed.

**An unresolved Project, Section or Label reference degrades to itself, honestly, and never makes
the Task disappear.** A `projectId`/`sectionId`/`labelIds` naming a row Device B has never seen
travels through Sync exactly like every other field on the Task — the Server does not validate it
(there is nothing to validate against; `server/migrations/0010_create_tasks.sql` adds no foreign
key), and the client does not null it out, drop the Task, or refuse the push. On Device B, the Task
simply carries an id that resolves to nothing yet: it is not filed under any Project the reader can
see (there is no row for it to render), but it is not silently reassigned to Inbox either, because
that would assert a fact — "this Task has no Project" — that isn't true; the Task *does* name one,
this Device just hasn't heard of it. It keeps surfacing everywhere a Task that genuinely has no
Project wouldn't be excluded from — `list()`'s global feed, Today, search — because none of those
queries filter on `projectId` resolving to a live row. The moment issue #173 lands Project Sync and
that id's row arrives on Device B, `listByProject(projectId)` starts matching it immediately —
nothing about the Task itself needs to change, since its `projectId` was correct the whole time; it
is only the *reader* that gains something to match it against. No migration, no repair step, no
edit required — the identical self-healing property ADR 0042 gives an unresolved `[[e:<id>]]`
Reference once its target Syncs in. This is the
one rule stated once and applied to all three fields, rather than three separate policies, because
the underlying shape — an id this Device hasn't resolved yet — is identical for a Project, a
Section and a Label.

## Alternatives considered

- **A separate `/v1/tasks/sync` endpoint.** The obvious factoring, and rejected specifically because
  it reopens the problem ADR 0048's cached-label design exists to close: a Task and the Entry
  referencing it (`[[task:id|label]]`) could then arrive in two independent round trips, and a
  Device that happened to poll between them would render a reference to a Task it doesn't have yet.
  One endpoint makes that window structurally impossible rather than merely rare.
- **A hard cutover to protocol 5, no dual-version window.** The simplest version-bump policy, and
  the one every earlier bump on this constant actually used. Rejected here because, uniquely among
  every bump so far, the cost would land on Entries — the one thing every single Device syncs,
  whether or not it has ever opened Todo — for a change to a feature some of those Devices may never
  use. Bricking a Device's journal sync over an unrelated feature bump is a cost this ADR is not
  willing to accept as a side effect of shipping Tasks.
- **Two independent version numbers, one per stream.** Lets a Device that only cares about Entries
  ignore a Task-only bump and vice versa. Rejected: a Device is one build, not two — it speaks
  whatever wire shape its own binary was compiled against, in full, for every endpoint it calls. Two
  version numbers would mean reasoning about four combinations (each number old or current) instead
  of one, for a distinction ("this Device is current" vs. "this Device is stale") that is genuinely
  binary in practice, since both streams ship in the same app build.
- **Rejecting a Task with an unresolved `projectId`/`sectionId`/`labelIds`.** Refuses the push
  outright (a 4xx, or a client-side no-op) until the referenced row arrives. Rejected: nothing
  guarantees the referenced row *ever* arrives on this ticket's own scope — Projects don't sync at
  all yet — so a Task created on Device A, naming a Project only Device A has, would simply never
  reach Device B. "A Task must never vanish because its Project has not arrived" is this ADR's own
  bar, and an outright rejection fails it directly.
- **Nulling out an unresolved reference on arrival.** Silently rewrites `projectId` to `null` (or
  drops the offending `labelId` from the array) the moment a receiving Device can't resolve it.
  Rejected: this asserts something false — "you never chose a Project for this Task" — about a Task
  that in fact has one, the reader on the *originating* Device just can't see that fact reflected
  back yet. It also isn't reversible without a second migration once Project Sync lands, whereas
  carrying the id through honestly needs no repair step at all once #173 ships.

## Consequences

**The dual-version code path is deliberately temporary, and nothing marks when it should go.**
`MIN_PROTOCOL_VERSION` and the `protocol_version >= 5` gate in `run_sync` exist to cover a rollout
window across three independently-shipping platforms, not forever — dropping protocol 4 support is
named here as a later, deliberate release rather than a date fixed in advance, because nobody
building this ADR can see how long real Devices take to update. Whoever makes that later call has
to delete `MIN_PROTOCOL_VERSION`, tighten the check back to equality, and remove the Task-response
gate together, or the three drift out of sync with each other.

**A Task can sit with a permanently-dangling reference if issue #173 is delayed or reordered.**
This ADR's decision makes that state honest and harmless rather than eliminating it — the Task
stays fully usable, just unfiled from the reader's point of view, for as long as its Project,
Section or Label has not itself synced. Issue #173 is what actually resolves it; this ADR only
guarantees the wait is safe to sit through.

**`packages/core/src/mapping.ts` gains `toWireTaskInput`/`fromWireTaskOutput`, doing no reshaping at
all** — every field is a direct camelCase-to-snake_case rename, including the three reference
fields this ADR's decision covers. That is itself evidence the decision was the right one: a
mapping function that had to special-case an unresolved reference would be carrying policy that
belongs in a store or a reader, not in a wire translator.

**Health's `todo` capability is reported and, for now, read by nobody but issue #175.** It exists on
the wire before anything consumes it, the same position `embeddings` was left in by ADR 0037 until
issue #134 needed it — health has to report the whole of what this Server structurally supports, not
only the subset the current codebase happens to read.
