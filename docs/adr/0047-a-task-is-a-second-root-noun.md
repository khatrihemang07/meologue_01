# 0047: A Task is a second root noun, not an Entry with fields

## Status

Accepted. Builds on [0001](0001-local-first-persistence-behind-injected-store.md), whose injected
store interface this ADR does not widen but sits a second one beside, and on
[0028](0028-entries-are-mutable-sync-carries-a-compacted-change-log.md), whose `seq`-reassignment
and last-writer-wins rules a Task's own Sync stream reuses rather than reinvents. Assumes
[0043](0043-an-entry-may-carry-structure.md)'s checkbox list items, which is what a Task is
promoted from. Forward-references [0048](0048-a-task-reference-is-a-node-with-a-cached-label.md)
for how a Task is pointed at from an Entry's body, 0049 for Todo as a Destination, 0050 for how a
Task is ordered, 0051 for the second Sync stream this ADR's Consequences only name, and 0052 for
Reflection's own reach into Tasks. Export's coverage of Tasks is decided in issue #175 rather than
an ADR of its own — ADR 0016 already settled what an Export owes, and covering a second root noun
applies that rule rather than reopening it.

## Context

Meologue has held exactly one root noun since ADR 0001: the Entry. Every piece of machinery built
in the twenty-eight ADRs since is Entry-shaped, and not just in spirit — down to identifiers.
`packages/core/src/store.ts` declares `EntryStore`, whose methods are `list`, `upsert`, `pending`,
`getCursor`, `setCursor`, `search`, `edit` — verbs chosen for one kind of row. The sync engine's
compacted change log (ADR 0028) is keyed on `entries.id` and reassigns `seq` on one table. Export's
manifest (ADR 0016) lists `id`, `device_id`, `created_at`, `seq`, `synced_at` for Entries and
nothing else, because there was never anything else to list.

ADR 0043 gave an Entry's body checkboxes, on the argument that untitled and unorganized are
different properties and refusing lists only protected the second, which was never worth
protecting. Todo asks for more than a checkbox can hold: a due date, a priority, a project, a
label — none of which describes a *line of text*, all of which describe a *thing the user is
tracking*. That is the shape of a second kind of row, not a bigger Entry, and the question this ADR
answers is where that row lives.

## Decision

**A Task is a second root noun, not an Entry with fields.** It gets its own table, its own store
interface, its own Sync stream, and its own lifecycle — created, dated, completed, deleted —
independent of any Entry's. A Task that began life as a checkbox in an Entry (ADR 0053) and a Task
created directly in Todo are the same kind of thing afterward; neither is more authoritative than
the other, and nothing about a Task's own row records which way it arrived.

**The Entry stays exactly what ADR 0043 and ADR 0028 already made it.** No column is added to
`entries`, no change to `EntryInput`/`EntryOutput`, no bump to `PROTOCOL_VERSION` on the Entry side.
A Task is invisible to everything that already works with Entries unless that thing is deliberately
taught to look at both.

**The second store sits over the same shared `SqliteDriver`, not a second database.** `packages/
core/src/store.ts` is Entry-specific down to its method names and cannot host this, so a `TaskStore`
interface exists beside `EntryStore` rather than growing inside it — but both are backed by the one
embedded database a Device already opens (ADR 0007). One `SqliteDriver`, one connection pool, one
OPFS lock on web. A Task's tables are new rows in the same file a Device's Entries already live in,
not a second store a Device has to open, migrate, and keep alive in parallel.

**Sync gets a second entity stream, not a second protocol.** A Task Syncs the same way an Entry
does — last-writer-wins by server arrival, under the advisory lock ADR 0002 established and ADR
0028 reused for edits — because nothing about *why* that rule works for an Entry stops working for
a Task. What changes is that a `SyncRequest`/`SyncResponse` now carries two arrays and two cursors
instead of one, which is a wire and protocol-version change addressed in its own ADR rather than
smuggled into this one.

## Alternatives considered

- **A Task as a projection over an Entry's checkboxes.** Compute "the tasks" by scanning bodies for
  checkbox lines, the way `dayHasEntries` computes emptiness by scanning Entries (ADR 0042) rather
  than storing a flag. Rejected: a due date, a priority, a project membership are properties of the
  *thing*, not of the *line that mentions it*, and a projection has no identity of its own to hang
  them on. There is nowhere to put a due date on a computed view.
- **A Task as an Entry with extra fields.** Add `dueDate`, `priority`, `projectId` and the rest to
  `entries`, and let a Task be an Entry whose body happens to be a single checkbox line. Rejected:
  editing an Entry is a user act with consequences — it Syncs a new body, and it stales the Period's
  Digest (ADR 0039) the Entry falls in. Dragging a task from today to tomorrow is not that act, and
  routing it through the same mechanism would make it masquerade as one: every reschedule would
  rewrite a body, Sync a body edit, and stale a Digest that has nothing to do with a due date moving.
- **Keeping tasks out of meologue entirely.** The honest option, and the one that costs nothing.
  Rejected because it loses the one thing that makes holding a journal and a task list in the same
  app worth building at all: the ability to ask what you said you would do against the place you
  already write down what you did. A separate task app answers neither question about the other.

## Consequences

**1. Two root nouns is a real cost, accepted deliberately.** Every cross-cutting feature meologue
has — Sync, Export, Search, capability-gating, the bundle-size budget — now has two places to
remember rather than one. This ADR does not pretend that cost away; it is paid because the
alternative (folding a Task into an Entry) was worse for the reasons above, not because the cost is
small.

**2. `packages/core` gains a second store interface, mirrored the way `EntryStore` already is.** A
`TaskStore` gets its own contract suite, run against both a SQLite and an in-memory implementation,
the same shape ADR 0001 chose for `EntryStore` and has held to since.

**3. Sync's wire contract widens.** A `SyncRequest`/`SyncResponse` carrying a second array and a
second cursor is a `PROTOCOL_VERSION` change, which is what makes it its own ADR (0051) rather than
a paragraph here — a version bump has to say how a Device that hasn't updated is treated, and that
argument belongs where it can be made in full.

**4. Export must cover Tasks or it quietly stops meaning what ADR 0016 said it means.** "A backup
that quietly omits things is worse than none" was written about Entries when Entries were the only
thing there was to omit. A Task a user is tracking is now exactly the kind of thing a backup that
skips it would be dishonest about. Addressed in issue #175, not here, because what an exported
Task looks like on the page is a decision worth making on its own.

**5. `entry-store-layout.tsx`'s composition root needs a second thing to hold.** It has only ever
opened one store, because there has been only one kind of store to open. Widening its outlet
context and its deferred-open forwarding facade to carry a `TaskStore` alongside the `EntryStore`
is mechanical, and is prefactored ahead of this ADR's behavioural consequences landing (issue
#167's own scope) precisely so that the composition root's shape is not itself part of the risk
when Task behaviour ships.
