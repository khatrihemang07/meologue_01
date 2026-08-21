# 0028: Entries are mutable; Sync carries a compacted change log, not a list of Entries

## Status

Accepted

## Context

An Entry has been append-only since ADR 0001: captured once, never edited, never removed. Every
piece of sync machinery built since — the server-assigned `seq` (ADR 0002), the Cursor, the
`entries_fts` index (ADR 0014) — was designed against that premise, some of them explicitly. This
ticket removes the premise: a user can now edit an Entry's body or remove it from History, and
that change has to reach every other Device the same way a new Entry already does.

The mechanism that already exists cannot carry this. `entries.seq` is a Postgres `bigserial`
assigned once, at insert. A Device's Cursor is a high-water mark over `seq` — "give me everything
with `seq` greater than mine" — and every Device polling after this one's insert has already
advanced its Cursor past that row. If the row is mutated in place, its `seq` doesn't move, so no
Device asking "what's new since my Cursor" will ever see the change. It sits below every Cursor
in the system, permanently unreachable by the query that's supposed to find it. Re-pushing an
edited Entry from the Device that changed it doesn't help either: `insert_entries`
(`server/src/sync.rs:147`) does `on conflict (id) do nothing`, so the second push is silently
discarded and the first version wins forever.

The underlying problem is that a Cursor is a claim about *rows*, not about *the state of a row*.
It can express "I have seen every row up to this point," and nothing else — there is no value of
the Cursor that means "and by the way, row 5 changed since you last looked." Any fix has to give
a mutation a way to re-enter the part of the log a Cursor can still see.

## Decision

**Sync stops carrying Entries and starts carrying changes.** Append-only Sync was always a
special case of a more general shape, one this ticket makes explicit:

- `nothing -> A` — an Entry is captured (today's only case)
- `A -> B` — an Entry's body is edited
- `A -> nothing` — an Entry is removed

**The server holds a compacted change log: one row per Entry, and `seq` is reassigned on every
write.** `entries` keeps its existing shape — one row per `id` — but an `UPDATE` to that row now
also reassigns its `seq` from the same sequence inserts already use. Reassignment is what solves
the unreachability problem: a changed row doesn't try to be found at its old position, it moves to
the head of the log, past every Cursor that has already advanced beyond it, so the very next poll
picks it up the same way it would a brand-new Entry. The log stays exactly one row per Entry —
nothing before this ticket kept a second copy of an old state around, and nothing added here does
either.

**Every change is sent as the resulting state, never as a delta.** `A -> B` goes out over the wire
as `B`, in full — not as "append this," "change body to this," or a diff against `A`. This is what
keeps the log compactable and replay idempotent: two Devices that each pushed a change to the same
Entry, in either order, converge to whichever `B` arrived last, and a Device that pulls the same
row twice (a retried request, a redelivery) applies the same `B` twice and ends up in the same
place either time. A delta-based wire format would need the receiving side to know what it was a
delta *from*, which reopens exactly the ordering problem `seq` reassignment exists to close.

**Ordering is last-writer-wins by server arrival, exactly as ADR 0002 already established for
inserts.** `A -> B -> C` pushed from two Devices resolves to whichever write committed last under
the advisory lock — there is no merge, no per-field reconciliation, no three-way diff. This needed
no new design; it's the same rule ADR 0002 built for inserts, now also governing updates, because
reassigning `seq` on write routes an edit through the identical serialization point an insert
already goes through.

**A delete is a tombstone, not a hard delete, and its body is blanked.** `A -> nothing` still has
to be a row with a `seq`, because absence of a row cannot carry a `seq` and therefore cannot
travel to another Device. The row survives with `deleted_at` set and `body = ''`. Blanking the
body is deliberate: if the transition really is "resulting state is nothing," a tombstone that
still held `body = 'A'` would be asserting two contradictory things about the same Entry at once
— deleted, and also still saying `A` — and that contradiction would sit in three databases instead
of one.

**Delete is terminal, enforced as a `where entries.deleted_at is null` guard on the write, not as
policy code checked before it.** An offline Device holding a stale copy of an Entry that gets
deleted elsewhere, and then pushes an edit to it, finds its own `UPDATE` matches no row (the guard
excludes it) and no-ops. That Device's next pull then returns the tombstone under the ordinary
sync path and it converges to deleted, the same as everyone else. No code anywhere asks "was this
deleted after my edit was made" — the guard makes the question unaskable rather than answering it.

**`PROTOCOL_VERSION` moves from 1 to 2.** An old client — one built before tombstones existed —
pulling from a new server has no concept of `deleted_at` and would render a tombstone as an
ordinary Entry with an empty body: a permanent, blank row in History that nothing in that build
knows how to remove. Bumping the version makes that Device's sync fail loudly with a 426, the same
mechanism ADR 0004 already uses for any wire-incompatible change, instead of it silently
misrendering deleted Entries as blank ones forever.

**Two invariants worth stating plainly, because both are easy to get backwards:**

- *Every delete writes a tombstone locally, immediately — never a hard delete, even while
  `seq IS NULL`.* `seq IS NULL` means "no acknowledgement received from the server yet," and that
  covers two situations a Device cannot tell apart: the delete hasn't been pushed yet, or it has
  been pushed and the response was lost. Hard-deleting the local row in that window and then
  syncing again means the next pull returns the Entry — because the server still thinks it's
  live, or the tombstone push never landed — with a fresh `seq`, and the Entry comes back
  permanently. `seq IS NULL` is evidence of what *this Device* doesn't know yet; it is never
  evidence that the server doesn't know either.
- *Delete is structural, not a policy decision made at write time.* Covered above under Decision
  — repeated here because it's the second invariant this ticket depends on holding.

## Alternatives considered

- **A full change log: an `entry_revisions` table, with clients folding revisions into current
  state.** Rejected. It costs a second table, a fold step every client has to implement and keep
  correct, and unbounded growth — a frequently-edited Entry accumulates a revision row forever.
  What it buys over a compacted log is edit history, and nobody asked for that: the product is a
  personal log of what things say now, not a version-controlled document. A compacted log and a
  full log converge to the identical current state under last-writer-wins; the full log only wins
  if something wants to read the states in between, which nothing here does.
- **A separate `rev` column as the sync ordinal, leaving `seq` as pure arrival order.** Rejected,
  and this is the one worth explaining in full, because on paper it looks like the cleaner design
  — a `seq` that always means "when this row was first written" and a `rev` that means "how far
  Sync has gotten" sounds like better separation of concerns than reusing one column for both.
  It's actually the dangerous option. Every Device already has Cursors stored as `seq` values from
  before this ticket existed. Introducing `rev` as a second, independently-numbered sequence and
  pointing Sync at it means those stored Cursors get reinterpreted as `rev` values on the next
  poll — a number that was never assigned against the same counter, comparable only by
  coincidence. A Device would silently skip every Entry whose `rev` fell below its stale `seq`-as-
  `rev` Cursor, with no error and no way to detect the gap short of noticing missing History days
  later. Reusing the same `bigserial` and reassigning it on every write avoids this entirely: a
  reassigned `seq` is always strictly greater than every value that sequence has ever handed out,
  so it's always above every Cursor already stored, and no existing Cursor needs migrating at all.
  The "obviously correct" two-column design is the one with the silent data-loss hazard; the
  "reuse the same column" design is the one that needs no migration.
- **Last-writer-wins by a client-supplied `updated_at` timestamp.** Rejected. ADR 0002 already
  refused to trust device clocks for insert ordering — they aren't synchronized or monotonic
  across restarts — and nothing about that reasoning is specific to inserts. The same refusal
  applies unchanged to edits. LWW here is arbitrated by server arrival order (the reassigned
  `seq`, serialized by ADR 0002's advisory lock), which is exactly the mechanism ADR 0002 built to
  avoid depending on device clocks in the first place. A consequence worth naming: no `updated_at`
  column is needed anywhere, client or server, because nothing ever compares one.
- **Conflict copies: a divergent edit becomes a second Entry instead of overwriting the first.**
  Rejected. This is one user with up to three Devices, and a genuine conflict needs two of them to
  edit the same Entry while both are offline relative to each other — a narrow window. Duplicating
  an Entry every time that machinery even suspects a conflict costs a confusing, duplicated row in
  History far more often than it protects against real divergence, for a single-user product where
  last-writer-wins is a perfectly legible outcome: whichever edit reached the server last is what
  the Entry says now, same as any other field in this system already resolves.

## Consequences

**`seq` now means last-touch order, not arrival order — and that reassignment happens inside the
same advisory lock ADR 0002 already holds around inserts, so commit order still equals sequence
order.** See the amendment appended to ADR 0002. Anyone reaching for `seq` to answer "when did this
Entry first show up" will get the wrong answer for any Entry that has since been edited or
deleted; nothing in this codebase asks that question (see the amendment for where this was
verified), but a future feature that wants arrival order specifically will find that ADR 0002 no
longer provides it and needs its own way to ask.

**The FTS5 search index and the client SQLite store both gain code paths they never needed
before.** `indexForSearch` needs an `UPDATE` when an Entry's body changes and a delete when it's
removed (amendment to ADR 0014); the client schema gains a `deleted_at` column via an `ALTER
TABLE` migration — the first migration this project has whose statements are not simply safe to
re-run. See the amendment to ADR 0007 for why the answer there is not the transaction that ADR
predicted it would be.

**Digests already written are not retracted or edited when a source Entry is later deleted.** See
the amendment to ADR 0027. A Digest is immutable by that ADR's own decision; unwinding a month's
prose because one Entry it drew on was later removed is a cost nobody asked to pay, so the Digest
stands as written and the deletion simply isn't reflected in it.
