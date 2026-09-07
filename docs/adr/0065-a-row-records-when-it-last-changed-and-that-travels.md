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

## Amendment (issue #217): the value travels, the *shape* was never pinned

The Consequences above tell whoever next revisits Sync's conflict rule that this column is "already
there and already correct on both sides of the wire." That sentence is what invited issue #215 in,
and it is half right in a way that cost real time — so it is corrected here rather than left to be
trusted again.

**The value is correct on both sides. The format is not the same on both sides, and this ADR never
said it had to be.** The client stamps `new Date().toISOString()`, which always emits exactly three
fractional digits. The Server carries `DateTime<Utc>` and serialises RFC 3339 through chrono's
default, which emits as many digits as it needs — six in practice, and **none at all** when the
nanosecond component is zero. Nothing in this ADR, the wire type, or either schema constrains that.

So `updated_at` must never be compared as a raw string, and the "identical shape" this ADR's own
backfill reasoning relies on holds only *within* one writer, never across the wire. `'.'` is `0x2E`
and `'Z'` is `0x5A`, so byte order and chronological order disagree in both directions:

| Server value | Client value | Raw comparison says | Truth |
|---|---|---|---|
| `...T12:00:00Z` | `...T12:00:00.500Z` | Server greater | Client is 500ms **later** |
| `...T12:00:00.123456Z` | `...T12:00:00.123Z` | Client greater | Server is 456µs **later** |

The first row is the likelier one: a Server timestamp landing on a whole second is ordinary, and
every client timestamp inside that second then loses to it while being later.

**Nothing caught this because no test ever built a cross-shape pair.** Every fixture on both sides
constructs timestamps in a single shape — the client suites through `toISOString()` or a pinned
`now`, the Rust suites through `DateTime<Utc>` values. The mismatch exists only where the two meet.
A test that pins this has to construct a Server-shaped `...:00Z` against a client-shaped
`...:00.500Z` and assert the later one wins.

**What has been fixed, and what has not.** ADR 0068 normalises both sides through
`strftime('%Y-%m-%dT%H:%M:%f', …)` in `EntryStore.applyPulled`, which is the one call site that ADR
owns. `merge.ts`'s case 6 still compares raw strings — and its comment still asserts the assumption
this amendment disproves — so Merge can pick the older of two copies as the winner. That is issue
#217. Restore is genuinely unaffected: it never uses `updated_at` to choose between rows, so a
Merge-scoped fix is legitimate and does not need to touch it.

**The general rule this ADR should have carried from the start:** a timestamp that crosses the wire
is ordered by instant, never by byte order, unless something actually pins its shape at both ends.

### The shape-tolerance is permanent, because Backup is a time machine

The obvious future cleanup is to normalise `updated_at` once — on ingest, or as a one-time pass —
and then let every comparison go back to a plain `>=`. **That would be a real improvement for the
steady state, and it still would not make the comparison-site normalisation removable.**

A Backup is a lossless copy of the database exactly as it stands (ADR 0064; `dump.ts` writes the
values verbatim), and Restore puts them back unchanged rather than rewriting them — reason 3 in
`restore.ts`'s own header preserves `seq`/`synced_at` from the file precisely so a Restore does not
re-push the whole database. So a Backup taken *before* any normalising migration carries the old
shapes forever, and Restoring or Merging that file a year later reintroduces them into a database
where every live row has been normalised.

**There is no point at which "all data has been normalised" becomes true.** The set of restorable
Backups is unbounded and grows every time someone clicks Back up. And Restore is the operation
people reach for when something has already gone wrong, so old Backups meeting current Devices is
ordinary, not an edge case.

The practical consequence is about how the guard is *described*, not just whether it exists: if it
is written as a migration-era workaround, someone deletes it in a year with a commit message about
cleaning up after the migration, and the bug comes back silently — for exactly the users who were
already recovering from something. Anything that compares `updated_at` stays shape-tolerant
permanently.

**One fork is deliberately left open here.** If a normalising migration does happen, it has to
decide what Restore does with a Backup that predates it. Normalising on the way in would contradict
ADR 0064's "a Backup is a faithful copy of what this Device already has" and Restore's own promise
to preserve what the file holds; staying faithful means old shapes keep arriving indefinitely. The
instinct on both sides of this discussion was that **Restore should stay faithful and the
comparison should stay tolerant** — but that is a real fork and whoever takes issue #217 should
settle it explicitly rather than inherit it.

It also gives the regression suite a third case, beyond the two cross-shape pairs above: a row whose
`updated_at` arrived via Restore from an old-shape Backup, winning or losing a Merge correctly. It
is the same comparison, but it is the case that outlives any migration, and it is the one nobody
will think to keep.
