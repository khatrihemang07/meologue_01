# 0022: Entry embeddings are filled by a background worker, off the request path

## Status

Accepted

## Context

Reflection needs every Entry to have a semantic embedding to search against, but nothing about
Sync or Capture should ever wait on an embedding call to finish, or fail because one did. ADR
0002 already established that `/v1/sync` has one job — get Entries committed with a correct
Cursor — and its advisory lock is a serialisation point that must not be given anything else to
wait on. Adding a synchronous embedding call to the sync path would make Capture (immutable,
already durable in Postgres per ADR 0002) depend on the availability of an LLM endpoint that,
per ADR 0021, may not even be configured. That dependency runs backwards: Capture is the
product, Reflection is a feature on top of it, and a feature must never be able to break the
product it's layered on.

Every Entry also needs to end up embedded eventually, including the ones already sitting in
Postgres with no embedding when this ticket lands, and including Entries synced in while the
worker is down, mid-restart, or between deploys.

## Decision

**A background worker, spawned once from `main.rs`, does all embedding work — `/v1/sync` never
calls an LLM.** `server/src/embedding.rs::run` owns a loop that responds to two independent
signals: a channel of Entry ids from the sync handler, and a periodic scan. Both funnel into the
same `embed_one`, so there is exactly one code path that writes an embedding.

**The channel is a hint, not the queue.** After `insert_entries` commits (see `sync.rs`), the
sync handler does `let _ = tx.try_send(entry_id);` for each newly-inserted Entry —
`try_send`, never `send().await`. A full channel must never block inside `/v1/sync`; dropping a
hint when the channel is full is safe *because* the scan below is the actual source of truth for
what needs embedding, and a dropped hint just means that Entry waits for the next scan tick
instead of being embedded immediately.

**The durable queue is a nullable column, not a table.** `entries.embedding is null` *is* "needs
embedding" — there is no separate queue table, no status enum, no row to insert and later
delete. `server/src/embedding.rs`'s scan runs `select id from entries where embedding is null
order by seq asc limit $1`, once at startup (via `tokio::time::interval`'s immediate first tick)
and every `SCAN_INTERVAL` (30s) after. This single mechanism recovers from every failure mode
that matters here: a crash mid-embed, a restart partway through a large first sync, a dropped
channel hint, a worker that panicked and got respawned, and — with no seeding step required —
the Entries already in Postgres before this ticket's migration ever ran. `entries_unembedded`
(the partial index from migration `0002_add_entry_embeddings.sql`) is what keeps that scan cheap
as the table grows.

**A dedicated queue table was considered and rejected, on the same grounds ADR 0014 already
argued for search.** ADR 0014 chose a hand-maintained FTS5 index over a trigger-driven
external-content table because the extra machinery bought nothing a personal-scale History
needs. The same call applies here: a queue table would need its own writes (enqueue on insert),
its own cleanup (dequeue on success), and its own crash-recovery story (a row claimed but never
finished) — all to express something a `WHERE embedding IS NULL` scan already expresses for
free, at the row counts this application deals in.

**Attempt counts are process-local and capped, not persisted.** `run` owns a
`HashMap<Uuid, u8>`, incremented on every failed `embed_one` call and checked before the next
attempt; past `MAX_ATTEMPTS` (5), the scan keeps re-selecting the id but `embed_one` returns
immediately without calling the LLM again. This is deliberately in-memory: losing the map on
restart is fine, because a genuinely poison Entry (one whose body or length trips something in
the embedding model, or that reliably 4xxs) fails again within a handful of ticks and re-earns
its cap — persisting the count would be real machinery spent guarding against a restart making
one Entry marginally slower to give up on, which isn't a cost worth building for.

**`embed_one` writes `embedding` and `embedding_model` in the same `UPDATE`.** A future change
of embedding model is then a visible fact per row — `select embedding_model, count(*) from
entries group by 1` shows exactly which Entries were embedded under which model — rather than an
assumption that every non-null `embedding` came from whatever model happens to be configured
today.

**Vectors are bound as `$1::vector` text literals (`'[0.1,0.2,...]'`), not via the `pgvector`
crate.** `server/src/embedding.rs::vector_literal` formats a `Vec<f32>` directly; no new crate,
no new sqlx type mapping, and sqlx 0.9 compatibility stays exactly as simple as every other query
in this codebase. This is the same shape a future `<=>` distance query (ticket 4's retrieval)
will bind on the read side, so nothing here is a one-off that retrieval has to work around.

**No ANN/HNSW index.** Migration `0002_add_entry_embeddings.sql` adds `vector(640)` and nothing
else vector-specific beyond the partial `entries_unembedded` index. At the row counts a personal
journal produces, an exact `<=>` scan is fast enough on its own, and building an approximate
index now would be — again — ADR 0014's precedent: not building for scale nobody has yet.

**`FOR UPDATE SKIP LOCKED` is the documented upgrade path if a second server process ever
exists.** Today there is exactly one server process per deployment (ADR 0003's whole model
assumes one trusted process, not a fleet), so two workers racing to claim the same unembedded
Entry isn't a scenario that exists yet. If it ever does, changing the scan's query to `... for
update skip locked` inside a short transaction is the fix — no migration, no schema change,
because the nullable column already is the queue.

## Alternatives considered

- **Embed synchronously inside `/v1/sync`, before responding.** Rejected outright — see Context.
  This would make Capture's latency and success depend on an LLM endpoint's latency and
  availability, which inverts the product/feature relationship between Capture and Reflection.
- **A dedicated queue/job table (`embedding_jobs` or similar), with its own lifecycle.**
  Rejected — see Decision above; ADR 0014 already made this call for search indexing, on the
  same reasoning.
- **Persist the attempt count on the Entry row (a new `embedding_attempts` column).** Rejected:
  the failure this is guarding against — one process restart making a poison Entry take a few
  extra ticks to re-hit its cap — isn't worth a schema change and a write on every failed
  attempt. An in-memory cap already stops any one Entry from spinning the loop within a single
  process's lifetime, which is the actual goal.
- **Use the `pgvector` Rust crate for a typed `Vector` binding.** Rejected for this ticket: the
  text-literal-plus-cast approach is one function (`vector_literal`) and works identically for
  writes here and the `<=>` reads ticket 4 needs, at zero new-dependency cost. Worth revisiting
  only if a typed API starts saving real complexity elsewhere.
- **Build the HNSW/ANN index now, since pgvector supports it.** Rejected — see Decision; this is
  exactly the "scale nobody has yet" ADR 0014 warns against building for.

## Consequences

`select count(*) from entries where embedding is null` is the operational health check for this
system: it should trend to zero shortly after startup and after every sync, and stay there. A
sustained non-zero count either means the embedding config is off (ADR 0021 — expected, and
`embed_worker_config` returning `None` is exactly this state) or means some Entries have hit
`MAX_ATTEMPTS` and are being silently skipped — this ticket adds no alerting for the latter,
which is a gap ticket 4 or a later observability pass should close, not one this ticket claims to
have solved.

`server/src/lib.rs::router` keeps its existing two-argument signature, unchanged, so every
existing test file that calls it keeps compiling; `router_with_embedding` is the three-argument
version `main.rs` actually uses. A Device or test that never wires an embedding channel simply
never gets the `try_send` hint — the scan still finds and embeds those Entries on its own
schedule, just without the latency win the channel exists to provide.
