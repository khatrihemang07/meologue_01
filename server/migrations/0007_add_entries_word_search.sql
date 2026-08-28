-- Issue #94: Reflection gains a `search_entries` tool, and it needs
-- something to search against. The Server has had no text search at all
-- until now — ADR 0014's `entries_fts` (an FTS5 virtual table) is a
-- Device-local SQLite index over that Device's own History; there is no
-- Server-side equivalent, and Postgres is not SQLite, so this is not a
-- port of ADR 0014's index, only of its problem: find Entries by word,
-- tolerant of a word typed in a different form than it was written in, and
-- of a small misspelling.
--
-- **`body_tsv` is a `GENERATED ALWAYS AS ... STORED` column, not a
-- trigger.** SQLite's FTS5 forced ADR 0014's hand-maintained-index design
-- because FTS5 is a separate virtual table with no first-class way to stay
-- in sync with a regular table short of triggers bound to a `rowid` ADR
-- 0014 found unsafe to rely on (see that ADR's Context). Postgres has no
-- such constraint: `tsvector` is an ordinary column type, and a `GENERATED
-- ... STORED` column is recomputed by Postgres itself on every insert and
-- update to `body`, transactionally, with the same guarantee any other
-- column's value has. That is a strictly better position than ADR 0014
-- was in — "no trigger and no hand-maintenance" is what that ADR wanted
-- and could not have on SQLite, and it is what a generated column gives
-- for free here. Nothing in `sync.rs::insert_entries` (which writes `body`
-- on Send, Sync, edit and delete alike) needs to change to keep this
-- column correct.
--
-- `to_tsvector('english', body)` picks English stemming explicitly rather
-- than the `default` (locale-dependent) configuration, for the same reason
-- ADR 0014 named `unicode61` explicitly for FTS5's tokenizer: an implicit,
-- environment-dependent choice would make search behavior depend on how
-- Postgres happens to be configured on whatever host runs it, rather than
-- being a property of this migration. English stemming is also exactly
-- what buys "a word typed in a different form than it was written in" —
-- `to_tsquery`/`websearch_to_tsquery` reduce both the indexed body and the
-- query to the same stems, so "run" matches a body that only ever wrote
-- "running" or "ran".
--
-- **`entries_body_tsv_idx` is a GIN index over `body_tsv`.** GIN (not
-- GiST) is Postgres's own documented recommendation for a static,
-- read-mostly `tsvector` column: faster lookups, at the cost of a slower
-- build/update than GiST — the right trade for a column that changes only
-- on Send/Sync/edit and is read on every Reflection search.
--
-- **`pg_trgm` plus a second GIN index over `body` itself is the
-- misspelling-tolerance half.** Full-text search only ever matches a
-- *stem* the query and the body share; it has nothing to offer when the
-- word itself was mistyped ("phyiso" for "physio") — there is no stem in
-- common because the word was never actually written. Trigram similarity
-- doesn't care about words or stems at all, only 3-character substrings,
-- so "phyiso" and "physio" still share most of theirs. `search_words`
-- (`reflect.rs`) uses this as an explicit *fallback*, tried only when the
-- full-text query matches nothing — trigram similarity is a much noisier
-- signal than a stemmed match and would rank a lot of loosely-related
-- prose above a real match if it ran first. `gin_trgm_ops` is what makes
-- both `similarity()`/`%` and `word_similarity()`/`<%` (what
-- `search_words`'s fallback actually queries with — the "does the query
-- resemble *some substring* of this body" operator, not "does the query
-- resemble the whole body") indexable, rather than a sequential scan every
-- time the primary search comes up empty.
--
-- Both indexes are created after the generated column exists, and both
-- (like every earlier migration in this directory) use `if not exists` /
-- generated-column re-add guards so this file is safe to run more than
-- once against a database that already has it applied — the same
-- re-runnability every migration here carries, even though sqlx's own
-- migration-tracking table means a real deployment only ever applies this
-- file once.
create extension if not exists pg_trgm;

alter table entries
  add column if not exists body_tsv tsvector generated always as (to_tsvector('english', body)) stored;

create index if not exists entries_body_tsv_idx on entries using gin (body_tsv);

create index if not exists entries_body_trgm_idx on entries using gin (body gin_trgm_ops);
