# 0035: Entry full-text search on the Server

## Status

Accepted. Sibling to [0014](0014-entry-search-hand-maintained-fts5-index.md), not a supersession:
0014 is a Device-local SQLite index over that Device's own History, built for the Composer's own
Search (CONTEXT.md's Search entry). This ADR is a Postgres index over every Entry the Server holds,
built so [0031](0031-reflection-is-a-loop-over-tools.md)'s loop has a `search_entries` tool to
call. The two solve the same underlying problem — find Entries by word, tolerant of a word typed
in a different form than it was written in, and of a small misspelling — on two different
databases, for two different callers, and neither replaces the other.

## Context

Issue #94 gave the harness a `search_entries` tool, and it needed something to search against.
Nothing on the Server had ever done text search before this: 0014's `entries_fts` is Device-local,
and the Server had no equivalent. This is not a port of 0014's index, only of its problem, and
Postgres is not SQLite — the constraint that forced 0014's hand-maintained design does not exist
here.

## Decision

**`body_tsv` is a `GENERATED ALWAYS AS (to_tsvector('english', body)) STORED` column, not a
trigger-maintained one** (migration `0007`). 0014 was forced into a hand-maintained FTS5 index
specifically because SQLite's external-content-table shortcut binds to `entries`'s implicit
`rowid`, which isn't guaranteed stable and isn't the same thing as `entries.id` — a trigger-driven
index on that binding would drift silently the first time SQLite renumbered a row. Postgres has no
such constraint: `tsvector` is an ordinary column type, and a `GENERATED ... STORED` column is
recomputed by Postgres itself, transactionally, on every insert and update to `body`, with the
same guarantee any other column's value has. This is a strictly better position than 0014 was in —
"no trigger and no hand-maintenance" is exactly what 0014 wanted for SQLite and could not have;
Postgres gives it for free. Nothing in `sync.rs::insert_entries` (which writes `body` on Send,
Sync, edit, and delete alike) needs to change to keep this column correct.

**`entries_body_tsv_idx` is a GIN index over `body_tsv`**, Postgres's own documented
recommendation for a static, read-mostly `tsvector` column read far more often than `body` itself
changes. **`pg_trgm` plus a second GIN index over `body` itself (`entries_body_trgm_idx`,
`gin_trgm_ops`) is the misspelling-tolerance half**, mirroring what trigram similarity already
buys 0014's own design: full-text search only ever matches a *stem* the query and the body share,
and has nothing to offer when the word itself was mistyped (no stem in common, because the word
was never actually written). `to_tsvector('english', body)` names English stemming explicitly
rather than the locale-dependent `default` configuration, for the same reason 0014 named
`unicode61` explicitly for FTS5's tokenizer — an implicit, environment-dependent choice would make
search behaviour depend on how Postgres happens to be configured on whatever host runs it.

**`search_entries` (`reflect.rs::search_words`) runs a three-rung ladder, each rung tried only
when the one before it matched nothing — and each rung exists because running the eval, not
reasoning about the SQL, found the rung before it insufficient:**

1. **`websearch_to_tsquery`, ranked by `ts_rank_cd`.** The obvious first attempt, and the one that
   looked sufficient until measured. `websearch_to_tsquery` **ANDs every term of the query
   together**, so a whole natural-language question matches nothing: "How has my knee injury been
   progressing over time — is it better or worse than when it started?" reduces to `'knee' &
   'injuri' & 'progress' & 'time' & 'better' | 'wors' & 'start'` and returns **zero** rows, while
   `'knee'` alone returns 16 and the eval's hand-graded expected set for that Question is 12. First
   measured mean recall across the eval's 22 scored Questions with only this rung: **0.281, 6
   Questions scoring exactly zero** — including "What have I been reading lately?", issue #94's
   own acceptance criterion, failing outright.
2. **An OR rung, tried only when rung 1 matched nothing: every lexeme the query reduces to,
   OR-ed rather than ANDed, ranked by the same `ts_rank_cd`.** The lexemes come from
   `to_tsvector('english', $1)` evaluated *inside SQL*, not from splitting the query in Rust —
   which keeps stemming identical to what indexed `body_tsv` was generated with, and avoids
   building a `tsquery` out of raw user text, which is both a syntax-error hazard and an injection
   hazard. `ts_rank_cd` is what keeps a deliberately broad OR match usable: an Entry matching more
   of the query's terms, and rarer ones, outranks one sharing a single common word. This rung alone
   closed nearly the whole gap: mean recall **0.281 → 0.748**, zero-scoring Questions **6 → 0**.
3. **Trigram similarity (`word_similarity`, `<%`), tried only when rung 2 also matched nothing,
   and gated on `to_tsvector('english', $1) != ''::tsvector`.** The trigram rung exists to rescue a
   word that was *written down and mistyped* — `phyiso` stems to itself and still reaches this
   rung, still matches `physio`. A second defect, found by the agent implementing rung 2 and
   verified independently: without the zero-lexeme guard, a query that reduces to *no* lexemes at
   all (stop words only) fell past both tsquery rungs and matched ordinary prose on trigrams
   alone — `word_similarity('the of and', 'Uneventful evening, tea and a book.')` scores **0.727**,
   far above the 0.3 threshold, purely because "the"/"of"/"and" are common English substrings. A
   query with no words has nothing to have been mistyped, so rung 3 is unreachable for one.

**Capped at `RETRIEVAL_LIMIT` (40), deliberately the same `k` `similar_entries` uses**, so the
recall@k comparison in `tests/eval-retrieval-baseline.md` isolates the retrieval mechanism rather
than being confounded by different row budgets.

**Kept as a separate tool from `similar_entries`, not merged into one hybrid retriever** — this is
issue #94's own decision, and it is measured, not asserted: the two arms fail on different
Questions. `aurora-devika` scores 1.00 for `similar_entries` against 0.12 for `search_entries`,
because the Question names a person ("Devika") the relevant Entries mostly refer to obliquely, with
no shared word to match; `wedding-hen-do` and several others go the other way. A merged hybrid
retriever would have averaged these columns together and hidden exactly the complementarity that
turned out to matter — see [0022](0022-entry-embeddings-are-filled-by-a-background-worker.md)'s
amendment for the combined-arm result this complementarity produces when both tools are actually
available to the same model in the same run.

## Alternatives considered

- **A trigger-maintained `tsvector` column, matching 0014's FTS5 shape for consistency across the
  Device and Server.** Rejected: there is no `rowid`-instability problem here to force it — see
  Decision. A generated column is strictly less machinery for the same guarantee, and "consistent
  with 0014" is not a reason to reproduce a workaround for a constraint that doesn't apply.
- **Skip the OR rung and tune `websearch_to_tsquery`'s own operators (`OR` keywords inserted by
  the caller) instead.** Rejected: this pushes query-construction complexity onto every caller
  (here, the model choosing search terms) rather than fixing it once in the tool. The OR rung is
  reached automatically, only when needed, with no caller-side awareness required.
- **Drop the trigram rung, accepting that a misspelled word simply won't match.** Considered, since
  it measured last and contributes least of the three rungs to the eval's headline number.
  Rejected: misspelling tolerance was 0014's own stated goal for the Device-local index, and a
  Server-side search that can't recover from a typo a user actually made is a real regression
  against what History search on the Device already does, even if the eval's specific 22 Questions
  don't happen to exercise it.
- **A single combined query trying all three strategies at once (e.g., `UNION` across rungs,
  ranked together).** Rejected: it would run the more expensive trigram scan even when rung 1 or 2
  already found a good answer, and it would need a cross-rung ranking scheme invented from nothing
  — the sequential ladder gets the same effective coverage while only paying for a rung once the
  one before it has already failed.

## Consequences

**`search_entries` is measurably faster and returns far fewer rows than `similar_entries`** — the
eval recorded it as 68× faster end to end and roughly half the rows for comparable recall, because
it makes no network call at all (no embedding model in the loop) where `similar_entries` needs one
embedding call per search. This asymmetry is why the two tools are not interchangeable even before
recall is considered: a model choosing between them is trading recall characteristics against
latency and cost, not choosing a strictly-better option.

**The eval's own number for this tool is a floor, not an estimate, because it feeds raw Question
text rather than the terms a model actually chooses.** The live harness lets the model call
`search_entries` with its own chosen terms and search again when the first attempt comes back
thin — its own observed example: asked about Priya's wedding, the model called
`search_entries(query: "Priya wedding")` and retrieved all 5 correct Entries, on a phrasing that
scored 0 recall under the old fixed pipeline's floor. `semantic` search has no equivalent headroom,
since a longer, more natural-language query is not a handicap for an embedding — so any future
retuning of this comparison has to account for the two arms not having symmetrical room to improve
under real use.

**Word search shares no code and no index with 0014's Device-local `entries_fts`.** A future
change to one tokenizer or ranking scheme has no effect on the other; keeping the two aligned in
behaviour, if that is ever desired, is a decision someone has to make deliberately, not something
either implementation enforces on its own.
