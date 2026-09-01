# 0050: Tasks are ordered by fractional index

## Status

Accepted. Depends on
[0028](0028-entries-are-mutable-sync-carries-a-compacted-change-log.md), whose row-level
last-writer-wins rule this ADR's convergence argument leans on directly, and on
[0047](0047-a-task-is-a-second-root-noun.md), which gives a Task its own table, its own store and
its own Sync stream to carry ordering on. Assumes the no-transactions constraint on
`packages/core/src/sqlite/migrator.ts` that ADR 0028's own amendment to ADR 0007 already
established: a migration statement has to be individually re-runnable, because Tauri's connection
pool means `BEGIN` and the statement after it may not land on the same connection. Forward-
references 0051 (not yet written), where `order_key` crosses the wire as opaque data the Server
never interprets.

## Context

Three constraints, none of them optional, decide this ADR before any alternative gets weighed.

**Todo works fully offline.** Like the Composer and unlike Reflect and Digest, Todo has no
Sync-off gate (ADR 0011) — a Task is created, dated, dragged and completed on a Device with no
Server configured at all, exactly as Todoist itself is offline-first. Any ordering scheme that
needs to ask something for a position — a sequence, a counter, an arbiter — has nothing to ask
when Sync is off, which for Todo is not a degraded mode but the default one.

**The SQLite migrator has no transactions.** `packages/core/src/sqlite/migrator.ts` re-runs a
migration statement-by-statement rather than inside `BEGIN`/`COMMIT`, because
`TauriSqliteDriver`'s connection pool cannot guarantee two statements land on the same connection.
The same absence of atomicity is not confined to migrations: nothing in this stack gives a Task
store a transaction to wrap an ordinary write in either, so any ordering scheme whose *use* — not
just whose migration — needs several rows to change together as one unit has no safety net if the
process dies partway through.

**Sync is row-level last-writer-wins.** ADR 0028 settled this for Entries and ADR 0047 carries the
same rule onto Tasks without reinventing it: two Devices editing the same row converge to whichever
write reached the Server last, arbitrated by server arrival under ADR 0002's advisory lock. There
is no merge, no per-field reconciliation. Crucially, the rule resolves *per row* — it has nothing
to say about the relationship between two different rows' writes. An ordering scheme has to survive
being decided by a rule that only ever looks at one row at a time.

Sibling order is the one place these three constraints meet at once: it needs to work with no
Server to ask, it needs to survive a crash mid-write with no transaction to roll back, and it needs
to converge correctly under a sync rule that arbitrates rows, not orderings.

## Decision

**Sibling order is a fractional index with jitter, tie-broken on `(order_key, id)` identically on
every Device, with the Server never consulted about order.**

Each Task carries an `order_key`: a string that sorts correctly against its siblings using
ordinary lexicographic comparison. Placing a Task between two existing siblings means computing a
new key that sorts between their two keys — a midpoint in the string space, not in an integer
space — and writing it to that one Task's row.

**One drag writes exactly one row.** Reordering a Task changes only the `order_key` of the Task
that moved. No sibling's row is touched, because no sibling's position is expressed relative to
any other row's — each Task's place in the list is a property of its own `order_key` alone, read
back by sorting the set.

**The tie-break is applied client-side, identically everywhere.** `order_key` is not guaranteed
unique on its own — two Tasks can theoretically land on the same key, jitter notwithstanding — so
every Device that renders a list sorts by `(order_key, id)`, with `id` breaking ties the same way
on every Device because a Task's `id` never changes. Two Devices holding the same set of rows
therefore always render the same order: they cannot disagree about ordering without disagreeing
about a row's `order_key` or its presence, either of which is a normal Sync question with a normal
Sync answer, not a new failure mode this scheme introduces.

**Jitter, and why it exists.** A pure midpoint scheme is deterministic: given the same two
neighbouring keys, two Devices inserting a Task at the same slot while both offline compute the
identical new key. That is not a harmless coincidence — it is a guaranteed collision waiting for
Sync to arbitrate a fact neither Device thinks it is contesting. Under row-level last-writer-wins,
the Task whose write reaches the Server second silently overwrites nothing about the *first* Task's
row (they are different Tasks, different rows), but the two now share one `order_key`, and the
`(order_key, id)` tie-break resolves their relative order by `id` — an outcome neither Device
chose, decided by a value neither reader ever looked at. A small random offset added to the
computed key at generation time makes an exact collision between two independently-computed
midpoints vanishingly unlikely instead of certain, without changing anything about how the key is
read or compared afterward.

**The honest cost: keys grow, and that is accepted rather than solved.** Inserting repeatedly
between the same two neighbours — dragging Tasks into the same slot over and over, which is
exactly what reordering a list by hand produces — lengthens the key computed at each midpoint,
without bound in principle. This is named rather than hidden because it is the real price of never
touching a sibling row: the alternative to a growing key is rewriting neighbours to keep keys
short, which is the multi-row write this ADR exists to avoid. It is acceptable here because Todo is
a personal task list, not a system processing millions of reorders — keys are cheap text in a
`TEXT` column, and a rebalancing pass that reassigns a clean, short spread of keys across a list is
available as a later, purely internal migration if key length ever becomes a problem worth solving,
which nothing about this decision forecloses.

## Alternatives considered

- **Integer positions.** The obvious design, and the one Todoist itself moved away from —
  `item_reorder`, its original integer-reindex endpoint, is deprecated in the Todoist API in favour
  of a fractional `order_key`-equivalent for exactly the reasons below. Rejected twice over, on two
  independent grounds. First: one drag rewrites every sibling below the insertion point, which is a
  multi-statement, all-or-nothing write with no transaction to wrap it in — a process that dies
  after row 3 of 12 has been renumbered leaves a list with two Tasks sharing one position and no
  single statement that can be re-run to finish the job, unlike every migration statement this
  stack already requires to be individually re-runnable. Second, and worse because it is silent:
  two Devices reordering the same list offline each renumber their own copy of every sibling below
  their own insertion point, and under row-level last-writer-wins those renumbered rows converge
  row-by-row rather than as one coherent reorder — the resulting order is not what either Device
  produced, and nothing about the failure looks like a conflict. It looks like corruption.
- **A Server-assigned order.** Rejected outright rather than weighed against the others: Todo is
  fully usable with Sync off, so there is frequently no Server to ask for a position at all. An
  ordering primitive that needs a round trip to a Server that may not be configured is not an
  ordering primitive this app can have — it would mean either blocking a drag on connectivity Todo
  is specifically built not to need, or maintaining a second, local-only ordering scheme for the
  offline case anyway, which is this ADR with extra steps.
- **A linked list of `prev`/`next` pointers.** Reads naturally and needs no jitter, but one drag
  writes three rows — the moved Task and both of its new neighbours — which reopens the
  no-transactions problem the fractional scheme exists to avoid, at a worse ratio: three unguarded
  writes instead of one. A single lost write among the three splits the list into two chains with
  no stored fact anywhere that says which half is the real one, which is a harder failure to
  recover from than a duplicated or overlong key.
- **No manual order at all — sort by created date only.** The cheapest option, and the one that
  costs nothing to build. Rejected: manual order is the affordance a task list is for — it is how a
  reader says "this matters more right now" independent of when a Task happened to be captured —
  and issue #171's drag-to-reorder is one of the acceptance criteria this programme is building
  toward, not an enhancement to consider later.

## Consequences

**The client is the only authority on order.** A Task's `order_key` is meaningful only to the
Device that reads it and sorts by it; the Server stores and forwards it without ever comparing,
generating, or repairing one. ADR 0051, which widens Sync to carry a Task's fields at all, treats
`order_key` as opaque text alongside everything else on the row — the Server's job is unchanged by
what the column happens to mean.

**A contract test asserts one drag writes one row.** The same contract suite ADR 0047 requires for
`TaskStore`, run against both the SQLite and the in-memory implementation, includes a case that
reorders a Task and asserts exactly one row's `order_key` differs afterward — the property this
whole design exists to hold, made checkable rather than merely argued.

**A convergence test proves the guarantee this primitive exists to provide.** Two stores reorder
*different* Tasks while both are offline, then both Sync; the test asserts the two stores agree on
one final order afterward. This is the specific claim integer positions and linked-list pointers
both fail — two Devices touching different Tasks must never produce an order neither of them
chose — and it is the test that would fail first if a future change reintroduced a multi-row write
anywhere in the ordering path.
