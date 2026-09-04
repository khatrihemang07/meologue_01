# 0057: A field added to an existing stream's row shape triggers one Cursor reset for it

## Status

Accepted. Builds on [0002](0002-sync-cursor-server-assigned-sequence-advisory-lock.md) (the
server-assigned `seq` and per-stream Cursor this ADR's own reset acts on), on
[0007](0007-sqlite-entrystore-driver-seam-and-cursor-placement.md) (the argument for where a
Cursor must live, reused verbatim below for where its new companion value must live), and on
[0051](0051-sync-carries-two-entity-streams.md)/[0055](0055-sync-carries-four-more-entity-streams-and-a-second-task-order.md)/
[0056](0056-an-event-is-local-append-only-and-stamped-by-the-device.md) (the seven streams this
ADR's own mechanism applies to uniformly). Amends [CONTEXT.md](../../CONTEXT.md)'s Cursor entry,
which is discussed in full below rather than treated as a footnote. Does not supersede any earlier
ADR — nothing here changes what a Cursor means or how `fetch_*_since` works; it changes what a
Device does with its own, locally-held Cursor value once, per stream, per field added.

## Context

Issue #186: a Device's Cursor for a stream only ever advances through what it has already asked
for — that is what makes an ordinary Sync a cheap `where seq > $since_seq` query instead of a full
table scan, and every ADR above it is right to treat that as settled. Nobody had to think about
the flip side of that guarantee until issue #182, because #182 is the first change in this
codebase's history to add a **field to an existing kind of row's wire shape**, rather than either
a new kind of row entirely (a fresh stream, its own Cursor starting at 0) or a value carried
unchanged inside a shape that already existed. `TaskInput`/`TaskOutput` gained `description`
(`server/src/sync.rs`) on the Task stream ADR 0051 had already shipped two tickets earlier — and a
Device that had already pulled a Task row before that field existed has a Cursor already past that
row's `seq`. It never asks for that row again, because nothing about the Cursor's own value changed
— only what the row *behind* it now contains, which is exactly the information a Cursor was never
built to carry.

**Observed directly, not merely reasoned about.** While verifying #182, a Task's `description` was
written on one Device and reached the Server. A second Device, already upgraded to the client
build that could read `description`, never displayed it — its Task Cursor already covered that
row's `seq` from an earlier Sync. Renaming the Task on either Device reassigned the row's `seq`
(ADR 0028's compacted-change-log rule, applied to Tasks by ADR 0047) and pushed it back above every
Cursor; the description arrived immediately afterward, together with the new name. Nothing was
wrong with the rename, the reassignment, or the Cursor's own arithmetic — the row genuinely never
needed to move for the Device's own sake, only to smuggle a field a completely unrelated edit
happened to also carry.

**This will recur.** `description` was new in #180 and wired onto the wire in #182, so today's
exposure is small — few Task rows predate it, and most have since been touched by something else
regardless. But the mechanism that produced this bug is not specific to `description`, or to
Tasks, or to this one release: it fires the next time *any* field is added to *any* existing
stream's row shape, silently, unless something is done about it on purpose every time.

**`PROTOCOL_VERSION` cannot be that something.** It was tempting to reach for the version bump
that already exists — reset every stream a Device is behind on whenever that Device's own last-
known `PROTOCOL_VERSION` is lower than the Server's. Issue #184 rules this out directly: it added
an entire seventh stream, Events, with **no bump to `PROTOCOL_VERSION` at all** — ADR 0056's own
Decision and that constant's own doc comment (`server/src/sync.rs`) argue why none was needed, on
grounds this ADR does not revisit. If a reset were keyed off that constant, a future release that
adds an eighth stream the same way — no bump, because nothing about existing streams' shapes
changed — would leave this ADR's own mechanism blind to it. The reverse failure is just as real: a
future bump *for* a brand-new stream (the ordinary case ADR 0051/0055 both are) has nothing to do
with any existing stream's row shape, and keying a reset off it would force every Device to
pointlessly re-walk Entries, Tasks, Projects, Sections, Labels, Comments and Events in full, the
moment any one of them earns an eighth stream of its own. One version number cannot answer two
independent questions — "does this Device's whole build understand the wire it's about to speak"
and "did this particular stream's rows just gain a field" — and `PROTOCOL_VERSION` already commits
to answering only the first, correctly, for reasons ADR 0004 and every bump since have argued.

## Decision

**A new, small, hand-maintained map, `ROW_SHAPE_EPOCH` (`packages/core/src/protocol.ts`), one
entry per stream, bumped by exactly one only when that stream's own row shape gains a field on a
kind of row it already had.** `tasks: 1` today, because `description` is the one field this has
ever happened to; every other stream starts at `0`, because none of them has yet had a field added
to a shape that predated it. This is deliberately decoupled from `PROTOCOL_VERSION`, for the reason
argued in Context above: the two move independently in both directions, and conflating them would
either miss a real case (a stream added without a bump) or over-fire on an unrelated one (a bump
for a stream that gained nothing new on its existing rows).

**Each Device records, per stream, the highest epoch it has ever caught up to — alongside that
stream's own Cursor, in the same `kv` table (SQLite) or in-memory field.** ADR 0007's argument for
where a Cursor must live applies here without modification: an epoch claiming a Device re-walked a
stream, backed by a database that never actually held that walk, is the identical failure mode as a
Cursor claiming progress the rows behind it never made. `EntryStore.catchUpRowShapeEpoch` (and its
mirror on every other store — `TaskStore`, `ProjectStore`'s two, `LabelStore`, `CommentStore`,
`EventStore`) is the one door this value is read or written through: given `currentEpoch`
(`ROW_SHAPE_EPOCH`'s own value for that stream), it compares against what's recorded, does nothing
if the recorded value is already at least as high, and otherwise **resets that stream's own Cursor
to 0 and then records `currentEpoch`, in that order** — a process killed between the two leaves a
Cursor of 0 and a stale recorded epoch, which simply repeats the same reset harmlessly on the next
call rather than skipping it. `sync-engine.ts`'s `sync()` calls every store's own version of this
once, before its `while` loop, before any stream's Cursor is read to build a request — from that
point on, the loop below does not know or care that a catch-up happened at all; a Cursor of 0 with
a full backlog is the identical shape it already handles for a Device that has never synced a
stream in its life.

**The reset costs one full re-walk of that stream, once, and nothing on any other Sync.** Once
`getCursor()` genuinely returns 0, the existing, already-paginated loop (`SYNC_BATCH_SIZE`,
repeating while a batch comes back full) re-delivers every row of that stream this Device already
holds, in the same `seq` order it always would have, this time carrying whatever field it was
missing. Rows that already have the field are re-fetched too — there is no cheaper way to tell, from
a Cursor alone, which specific rows predate a field that was never recorded per-row — but re-fetching
them is not a second copy: every `insert_*`/`upsert` in this codebase, client and server, is already
keyed by `id` (ADR 0028), so a re-delivered row overwrites itself in place. Comparing a stored
epoch against `ROW_SHAPE_EPOCH`'s current value is one local integer comparison per stream, once
per `sync()` call — no network round trip, no query — which is what keeps an ordinary Sync, on an
unchanged epoch, exactly as cheap as it already was.

**A Device that has never synced a stream is unaffected, by construction rather than by a special
case.** Its Cursor is already 0 and it has never recorded any epoch; the reset sets an already-0
Cursor to 0, and the epoch is recorded as caught up regardless. There is nothing left to
distinguish "a Device that just caught up" from "a Device that was always current" — both end the
call with a Cursor of 0 or wherever their own Sync left it, and a recorded epoch matching
`ROW_SHAPE_EPOCH`'s current value.

**CONTEXT.md's Cursor entry is amended, not preserved as written.** It said, without qualification,
"a Cursor only ever advances." That was true of every mechanism this codebase had built prior to
this ADR, and this ADR's own reset genuinely breaks it: `catchUpRowShapeEpoch` can and does set a
Cursor backward, to 0, on a Device that already held a higher value. The alternative to amending
the glossary would be building a mechanism that is not, technically, a Cursor rewind — a second,
separate "replay watermark" per stream that the reset loop pages through independently, leaving the
real Cursor untouched until the replay catches back up to it. That shape was considered and
rejected (see Alternatives below); once it was rejected, the honest choice was to say plainly that
the glossary's absolute claim needed an exception, not to leave code and prose disagreeing. The
entry now names the exception directly: a Cursor still only advances as an ordinary consequence of
Syncing, and only ADR 0057's own reset — which happens at most once per stream per field ever added
to it, never as a side effect of an ordinary Sync — is permitted to set it back, deliberately, to 0.

## Alternatives considered

- **A single "replay watermark" per stream, decoupled from the real Cursor, that pages from 0 up to
  where the Cursor already was without ever moving the Cursor itself backward.** This would have
  kept CONTEXT.md's "only ever advances" claim true to the letter. It was rejected once it became
  clear it bought nothing a plain reset doesn't already give: `fetch_*_since` is a pure `where seq >
  $since_seq` read, so requesting from 0 and requesting from a separate, lower watermark are the
  identical query either way, and the existing pagination loop (`SYNC_BATCH_SIZE`, "repeat while a
  batch is full") already walks a stream from any starting point up to its current tip regardless of
  how many `sync()` calls that takes — there is no correctness or performance the second value would
  add, only a second persisted number, on every stream, that has to be kept from drifting out of
  step with the Cursor it shadows. The literal reset is simpler and does the identical work; amending
  the glossary was the honest cost to pay for that simplicity rather than a cost worth building
  around.
- **Reset on `PROTOCOL_VERSION` moving.** Rejected in Context above: issue #184 already proves a
  bump is neither necessary (Events shipped without one) nor sufficient (a future bump for a new
  stream would say nothing about any existing stream's row shape) as a signal for this.
- **Diff each row against what an older wire shape could have produced, and refetch only the ones
  that are plausibly stale.** Rejected for cost with no compensating benefit: nothing about a Cursor,
  or a row once it's landed locally, records which wire shape produced it, so telling "already has
  this field" apart from "predates it and the field happens to be its natural default" would need a
  second piece of bookkeeping per row, forever, to save a redundant fetch of rows this app's own
  scale (CLAUDE.md's scope discipline) makes cheap to redo in full instead.
- **Do nothing, and rely on an unrelated edit eventually reassigning every row's `seq` and
  surfacing the field as a side effect** — which is, in fact, what already happens today, is how the
  bug was first noticed, and is precisely the silent, indefinite gap issue #186 was filed to close.

## Consequences

**A future field added to an existing stream's row shape has exactly one required step this ADR
did not have to invent from scratch: bump that stream's number in `ROW_SHAPE_EPOCH`.**
`PROTOCOL_VERSION`'s own doc comment (`server/src/sync.rs`) and `ROW_SHAPE_EPOCH`'s own
(`packages/core/src/protocol.ts`) both say so, in the place the next person adding such a field is
already reading — `TaskInput`/`TaskOutput` or whichever struct they're editing — not merely in this
ADR. Skipping the bump does not fail loudly: it reproduces issue #186 exactly, silently, for
whichever field was just added, and only this ADR's own text and those two doc comments stand
between a future reader and the same six months this codebase went before anyone thought about the
first case.

**Every mutable stream now carries one more persisted value it did not before, mirroring its
Cursor.** Seven new `kv` keys (`row_shape_epoch`, `task_row_shape_epoch`, and so on), each read and
written through the identical single door its own Cursor already goes through, so this cannot drift
out of ADR 0007's placement discipline the way a value living somewhere else could. It is a real,
permanent addition to every store's surface — `catchUpRowShapeEpoch` (or its Project/Section-shaped
pair) — not a temporary migration step to remove later, because the same mechanism has to be ready
the next time a field is added, not rebuilt for it.

**A field-adding release costs one full re-walk of whichever stream it touches, for every Device
that already held any row of that stream.** For Tasks specifically, at this app's own scale
(CLAUDE.md), that cost is small and one-time; there is no guarantee a future stream stays that
small forever, and this ADR accepts that trade rather than building the more complex, unnecessary
machinery (the rejected replay-watermark alternative above) that would only shave an already-cheap
re-fetch down further.

**CONTEXT.md's Cursor entry is no longer a clean absolute, and a future reader has to hold both
halves of it.** "Only ever advances" was easy to state and easy to rely on; "only ever advances,
except for one deliberate, at-most-once-per-field reset this ADR names" is a real complication to
the domain model, not merely a wording fix, and any future change to how Cursors behave has to
reconcile with this exception explicitly rather than assume the glossary's original, simpler
sentence still holds everywhere.
