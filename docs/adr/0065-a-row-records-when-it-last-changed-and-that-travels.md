# 0065: A row records when it last changed, and that travels

## Status

Accepted. **Revisits a named consequence of ADR 0028** — that no `updated_at` column is needed
anywhere — without changing ADR 0028's actual decision. Sync's conflict rule is untouched: still
row-level last-writer-wins by Server arrival order.

## Context

Merge (ADR 0064) has to answer "which of these two copies is newer" on a Device that may never have
synced. Nothing in meologue recorded that.

ADR 0028 did not merely omit an `updated_at` column; it rejected one by name, and wrote down the
consequence explicitly: "no `updated_at` column is needed anywhere, client or server, because
nothing ever compares one." Issue #3 once described `updated_at`, `rev` and `origin_device_id` as
"dormant since migration 0001" — they were never dormant, they were never there.

That left exactly two discriminators. `seq` is Server-assigned, and ADR 0011 makes Sync opt-in, so
for the server-less user — the default — every row is `NULL` on both sides. `created_at` is capture
time and never moves on edit, so it cannot order two edits at all. Neither answers the question.

## Decision

**Add `updated_at` to the seven mutable client types** — Entry, Task, Project, Section, Label,
Filter, Comment — and to the six that have Server tables. **Events do not get one**: append-only,
`on conflict do nothing`, no edit path could ever write it.

**Backfilled to `created_at`, deliberately.** It is stable, distinct per row, and *identical on
every Device holding the same row*, because `created_at` is excluded from every update set on the
Server. Two Devices merging a shared history therefore produce exact **ties** on pre-existing rows
rather than a spurious winner. Backfilling to migration-run-time would have been the trap:
whichever Device migrated later would win every old row it had never touched.

**It travels on the wire.** A Device sees when a row was actually changed rather than when it
happened to arrive. The cost is real and one-time: this is a field on an existing row shape, so
ADR 0057 applies and each of the six streams resets its Cursor once, re-walking its history.

**It goes in each upsert's `set` list and never the `is distinct from` guard.** This is the
important line. `seq = nextval(...)` sits in the `set` list, so any firing update re-sequences the
row — and because every Device pulls "rows where `seq` > my Cursor", re-sequencing is a *broadcast*.
Putting `updated_at` in the guard would make a fresh timestamp on an identical body re-deliver that
row to every Device that has ever synced, for a change nobody made. Worse, it would silently alter
who wins a future Merge.

**No clock-skew guard, and no tie-break beyond equality.** Accepted knowingly: a Device with a fast
clock will win collisions. That is the price of having any orderable discriminator at all where
`seq` is `NULL`, and it is bounded by ADR 0064's rule that deletion is terminal in both directions —
a skewed clock can win an edit, but cannot resurrect a deleted row.

## Alternatives considered

- **Keep `seq` as the only discriminator.** Rejected: it is `NULL` everywhere for a Device that has
  never synced, which is exactly the Device that needs Merge most.
- **`updated_at` as a client-only column.** Much cheaper — no Server migration, no wire change, no
  Cursor resets. Rejected because a pulled row would then be stamped at *receive* time, so a Device
  that synced late would carry a later timestamp than the Device that actually made the edit.
- **Make Sync itself use `updated_at`.** That would be the coherent version of this change — one
  rule everywhere. Rejected as out of scope: it means rewriting ADR 0028 and every `on conflict`
  guard, which is a far larger change than the feature that prompted it. The consequence is stated
  plainly below.
- **Conflict copies (issue #3's original proposal).** Already rejected by name in ADR 0028; nothing
  here reopens it.

## Consequences

**The column is written by every store and read by exactly one feature.** Sync does not consult it.
That is a real smell and it is deliberate: the alternative was re-litigating ADR 0028 inside a
backup ticket. Whoever next revisits Sync's conflict rule should know this column is already there
and already correct on both sides of the wire.

One divergence is tolerated: after an "edit" that lands on identical content, the Server keeps its
older `updated_at` while the Device has a newer one, because the guard did not fire. Harmless,
precisely because ADR 0059's acknowledgement clears the row's pending state regardless.

Every synced Device re-walks six streams once after this ships. Expected, not a defect.

Migration numbering bit twice here and is worth flagging for the next person: the client ledger
version (17) is not the migration's filename number (`0014_`), because two search-index migrations
are interleaved; and the Server migration collided at version 18 with a migration landing on `main`
in parallel. Two files claiming one version is a collision git cannot see — neither edits the other,
so the merge is clean and the failure surfaces later as a `_sqlx_migrations_pkey` violation, 81
tests at a time.
