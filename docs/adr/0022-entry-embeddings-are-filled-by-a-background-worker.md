# 0022: Entry embeddings are filled by a background worker, off the request path

## Status

Accepted. **Amended by issue #100 (`8c653ed`): the verdict on whether embeddings earn their
dependency they cost is keep, at moderate confidence — see the "Amendment (issue #100)" section
below.** Everything this ADR decided about *how* embeddings are produced — the background worker,
the nullable-column queue, the process-local attempt cap, no ANN index — stands unchanged; #100
answers a different question this ADR always left open, which is whether the thing being produced
is worth what it costs to keep producing.

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

## Amendment (issue #100): the verdict, and why it's the reasoning that matters

This ADR built the embedding pipeline without ever asking whether embeddings were worth their
dependency — a background worker, a `vector(640)` column on every Entry, and a Server that refuses
to start Reflection at all without an embedding model configured
([0021](0021-the-server-calls-an-openai-compatible-llm.md)). Issue #94 gave Reflection a second
retriever, `search_entries` ([0035](0035-entry-full-text-search-on-the-server.md)), that needs none
of this. Issue #100 is the comparison that decides which one earns its keep — full results and
per-Question detail are in `server/tests/eval-retrieval-baseline.md`; this amendment records the
decision and, more importantly, the reasoning behind it, because the conclusion by itself
understates how close this call actually was.

**The verdict: keep embeddings, at moderate confidence — and not for the reason the earlier
numbers suggested.** Issue #94's own recorded number, semantic search's 0.859 mean recall against
word search's 0.748 at `k = 40`, looked like a clear win for embeddings. It wasn't a fair
comparison: `semantic` (`similar_entries`) returns its unconditional top-40 of 119 Entries for
every Question since issue #92 removed the similarity floor, while `word_search`
(`search_entries`) naturally returns a mean of about 21 rows — it stops when its own ranking runs
out of real matches rather than padding out to 40. Picking 40 of 119 Entries at random already
scores ≈0.336 recall by chance, so the 0.859 number was inflated partly by a row budget nobody had
equalised.

**At the row count word search actually uses, the two arms are not meaningfully different.** A
recall@k curve computed at `k = 5, 10, 20, 21, 30, 40` (`k = 21` being word search's own measured
mean row count) shows the lead crossing over: word search leads outright at `k = 5` and `k = 10`
on every measure — recall, pooled recall, and precision — and semantic only overtakes at `k ≈ 20`,
pulling further ahead only as `k` grows toward 40. At `k = 21` specifically, the shared,
comparable-cost budget, mean recall is 0.747 (semantic) against 0.748 (word search) — the same
number inside rounding — and word search is **ahead** on pooled recall (0.742 vs 0.725) and
precision (0.190 vs 0.188). Most of the original 0.859-vs-0.748 gap, in other words, was "we
stopped forcing word search to compete on a row budget it doesn't naturally use," not "embeddings
rank better."

**Embeddings are kept for two things the head-to-head race does not show, both required by
issue #100's own bar: "if embeddings are kept, the record says which Questions justify them."**

1. **A short, specific list of Questions word search cannot reach**, ranked by the size of the gap
   at the comparable `k = 21`: `aurora-devika` (1.00 vs 0.12, a gap of 0.88 — the clearest case in
   the whole corpus, because the Question names a person, "Devika," that the relevant Entries
   mostly refer to obliquely, with no word in common to match), `wedding-day` (+0.67), and
   `knee-onset`, `caffeine-slip`, `flat-move-reason` (+0.50 each — Questions that paraphrase what
   the Entries actually say, sharing no lexical stem with them). Past this list of five, every
   further semantic win is smaller and more marginal.
2. **A combined arm shows genuine complementary lift that neither tool alone provides, and this is
   the stronger of the two results.** A union of both arms at a 20+20 budget uses 27 rows after
   overlap and scores 0.878 mean recall / 0.875 pooled — beating semantic's own top-40 numbers
   (0.859 / 0.833, using 40 rows) while returning a third fewer rows. At an ~11+11 budget the union
   matches either single arm's own recall (0.747) using only 15.7 rows on average, with better
   precision than either arm alone at that cost (0.249 vs 0.188/0.190). This is not the two arms
   agreeing with each other — if it were, the union would look like either arm alone. It looks
   better than both, which is only possible because the two are wrong on different Questions: the
   same complementarity issue #94 asserted when it kept `search_entries` and `similar_entries` as
   two separate tools rather than merging them into one hybrid retriever
   ([0035](0035-entry-full-text-search-on-the-server.md)), now measured rather than argued.

**Confidence is moderate, not high, and the amendment says so plainly rather than rounding up, for
three reasons stated openly:**

- The comparable-`k` race is genuinely close — close enough that word search wins outright at low
  `k` and edges semantic on two of three measures at `k = 21`. The original 0.859-vs-0.748 framing
  overstated what semantic alone is worth; correcting that cuts against embeddings, not for them.
- **The corpus flatters semantic.** [0023](0023-reflection-is-a-fixed-three-source-fan-out.md)
  measured `MIN_SIMILARITY` separating topics cleanly at roughly 80 Entries and failing to separate
  them at 572 — nearest-neighbour ranking gets more confusable neighbours to rank among as a
  History grows, a pressure lexical matching does not obviously share. The eval corpus holds ~119
  live Entries, at the optimistic end of that range. A real History accumulated over years could
  plausibly narrow this gap further, or erase it outright, rather than hold it.
- **Word search's own number is a floor, not an estimate**, because the eval feeds it raw Question
  text while the live harness lets the model choose its own search terms and search again when the
  first attempt comes back thin (its own observed example: `search_entries(query: "Priya
  wedding")`, chosen by the model, retrieved all 5 correct wedding Entries on a Question that
  scored 0 recall under the old fixed pipeline's floor). Semantic search has no equivalent
  headroom — a longer, more natural-language query is not a handicap for an embedding the way it
  can be for a lexical match.

**This measurement does not, by itself, justify the current shape of the dependency it was
weighing.** A background worker, a vector column on every Entry, and a Server that refuses to
start Reflection at all without an embedding model configured is a stronger dependency than "these
two tools are worth having." The comparable-`k` finding — word search alone is not meaningfully
worse than semantic alone — means a deployment that lost `similar_entries` entirely would likely
retrieve reasonably well, not fail badly, which is a materially weaker justification for a
hard startup dependency than the original 0.859-vs-0.748 numbers implied. That is an observation
this amendment records, not a change this amendment makes: nothing about the worker, the column,
or the startup gate is altered here — the verdict is keep, and what to do with a keep verdict that
rests on a moderate-confidence, narrow case is left for whoever next revisits this dependency.
