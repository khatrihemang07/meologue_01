# 0059: Sync acknowledges every pushed row, and pushes in bounded batches

## Status

Accepted. Does **not** change ADR 0028's conflict rule — Sync stays row-level last-writer-wins by
Server arrival order. This ADR is about how a Device learns what happened to a row it pushed, which
ADR 0028 never specified because the mechanism it left in place happened to work for every case
that ticket exercised.

## Context

Found while designing Backup, Restore and Merge (#195, #197, #199): a Device can push a row and
never learn what became of it, and when that happens it re-pushes the row every five seconds
forever.

The chain is short and every link is load-bearing:

1. A row is pending exactly when `seq IS NULL` (`pending()`, `sqlite-entry-store.ts`), and **the
   only code path in the repo that sets a non-null `seq` is an upsert fed from a sync response**
   (`sync-engine.ts`). Nothing is stamped locally at push time.
2. The response is **not** built from what was pushed. It is built from a fresh
   `fetch_*_since(cursor)` read (`run_sync`, `server/src/sync.rs`). `insert_entries`' `returning id`
   feeds only the embedding worker; the other six streams had no `returning` clause at all.
3. Every upsert is guarded by `where <t>.deleted_at is null and (<col> is distinct from
   excluded.<col> or …)`. When that guard does not fire, `seq` is not reassigned.
4. So a pushed row whose content the Server already had, on a Device whose Cursor is already at or
   past that row's `seq`, is absent from the response entirely. Its local `seq` stays `NULL`,
   `pending()` returns it again, and the next tick pushes it again.

This is reachable today: edit an Entry back to a byte-identical body. One stuck row is cheap, which
is why it went unnoticed — and why no test caught it.
`server/tests/sync.rs`'s `replaying_an_unchanged_entry_across_two_pushes_does_not_move_the_cursor`
looks like coverage but sends `since_seq: 0` on **both** pushes, so the response contains the row
incidentally rather than because anything acknowledged it. `task-convergence.test.ts`'s
`FakeTaskServer.push` re-sequenced every pushed Task unconditionally, so it could not model the
guard at all.

Merge is what turns this from a curiosity into a defect. Folding one Device's Backup into another
whose history mostly overlaps marks thousands of rows pending at once; the ones the Server already
holds identically all no-op, never come back, and re-push forever.

A second, compounding problem sat next to it. Pushes were never bounded: `pending()` has no `LIMIT`,
and all seven streams went into one request body. `server/src/lib.rs` layers no `DefaultBodyLimit`,
so the effective cap is axum's 2 MiB default on the `Json` extractor — and exceeding it fails the
**entire** round trip, both directions, with no partial progress. A growing set of stuck rows walks
straight into it.

## Decision

**The response tells a Device the Server's current row for every id that request pushed.**
`SyncResponse` gains `acknowledged_entries`, `acknowledged_tasks`, `acknowledged_projects`,
`acknowledged_sections`, `acknowledged_labels`, `acknowledged_comments` and `acknowledged_events`.
Each `insert_*` selects `where id = any($1)` over exactly the pushed ids, inside its own existing
transaction before commit, and returns those rows. The client upserts them through the same
`fromWire*Output` path it already uses, and clears pending from that rather than from whatever the
Cursor read happened to include.

**Full rows, not `{id, seq}` pairs.** The cheaper shape would clear pending just as well, and it
would leave a real hole: when the guard refuses a write because the row is tombstoned — delete is
terminal (ADR 0028) — the Device would keep a version the Server rejected and never find out,
unless its Cursor happened to be behind that tombstone. Returning the row means a refused write
teaches the Device the tombstone instead.

**Acknowledged rows never advance a Cursor.** A Cursor marks how far a Device has read the
compacted log; an acknowledgement is about a specific row, not about position in that log.

**Pushes are chunked at `SYNC_BATCH_SIZE`.** Each stream's pending set is sliced before the request
is built, and a stream whose backlog did not fit sets the loop's existing continuation flag — the
same "repeat while a batch was full" mechanism reads have always used, now symmetric.

**No `PROTOCOL_VERSION` bump.** These are additive response fields; an older Device never reads a
JSON key its own build predates, exactly as the `events` field's own doc comment already reasons.
The existing per-version gates apply to `acknowledged_*` identically to the streams they mirror.

## Alternatives considered

- **Return only ids, or `{id, seq}` pairs.** Rejected: clears pending but cannot express "the
  Server refused your write", which is a real outcome of the tombstone guard.
- **Put `updated_at` (#196) into the `is distinct from` guard.** This fixes the loop as a side
  effect — a fresh timestamp makes the guard fire. Rejected because the cure is a broadcast: any
  firing update reassigns `seq`, which re-delivers the row to *every* Device that has ever synced,
  for a body nobody changed. It would also silently change who wins a future Merge.
- **Raise the Server's body limit.** Rejected: moves the cliff rather than removing it, and does
  nothing about rows that re-push forever.
- **Refuse to mark a row pending when an edit produces identical content.** Rejected: it covers
  only Entry bodies; a Task has thirteen mutable columns, and the check would have to be duplicated
  per store rather than living once at the seam that actually knows the answer — the Server.
- **Have the client stamp `seq` optimistically at push time.** Rejected outright: `seq` is
  Server-assigned and its ordering is the one arbiter this system has (ADR 0002). A client that
  invents one is inventing a conflict resolution it has no standing to decide.

## Consequences

A response is now larger by roughly what the request pushed. That is bounded, because the same
change caps a push at `SYNC_BATCH_SIZE` — before this, an unbounded push had an unbounded echo,
which would have been the wrong trade.

`sync()` gained a no-progress backstop: if an iteration pushed rows, every response batch came back
short, and the total pending count did not fall, the loop breaks rather than spinning. This is
insurance against a future Server that stops populating `acknowledged_*`, **not** the mechanism
correctness rests on — that is the acknowledgement itself.

One divergence is now possible and is deliberately tolerated: after an "edit" that lands on
identical content, the Server keeps its older `updated_at` (#196) while the Device has a newer one,
because the guard did not fire. Harmless, precisely because acknowledgement clears the row's pending
state regardless of whether anything changed — which is the whole point of this ADR.

The tests that now cover this are the ones that did not exist: a no-op replay against a Cursor
already past the row, on both Entries and Tasks, and a refused edit against a tombstone.
`FakeTaskServer` models the `is distinct from` guard and delete-is-terminal, so the convergence
suite can express this class of bug at all in future.
