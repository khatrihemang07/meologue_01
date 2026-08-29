-- Issue #132 / ADR 0039: a Digest can go stale (an Entry in its Period
-- moved after this Digest was written — added, edited, or deleted) and can
-- be asked for again. **Nothing here changes what 0004_create_digests.sql
-- already said: "Written once ... and never again."** That row is still
-- true, word for word — regenerating INSERTs a new row, never touches an
-- existing one. ADR 0027's immutability clause stands unchanged and is
-- still load-bearing; what ADR 0039 supersedes is narrower — only "at most
-- one Digest per Period" (ADR 0027's Decision section) gives way to "at
-- most one Digest per (Period, revision)".

-- revision: 1 for the background worker's own, first-generation write
-- (server/src/digest.rs::insert_digest, which only ever writes 1, and only
-- where no Digest exists yet for that Period at all — the worker
-- generates, it does not regenerate); 2, 3, ... for each successive
-- `POST /v1/digests/{period}/{date}/regenerate`. A Period the worker never
-- managed to write at all (stuck past `MAX_ATTEMPTS`, ADR 0027's
-- Consequences) can also be rescued straight to revision 1 by that same
-- route — see `digest::regenerate_digest_handler`'s own comment.
alter table digests add column revision int not null default 1;

-- "At most one Digest per Period" (ADR 0027) is replaced by "at most one
-- Digest per (Period, revision)". The schema still makes a duplicate write
-- of one exact revision structurally impossible — a retry or a race
-- against `insert_digest`'s `on conflict do nothing` can only ever no-op —
-- it just no longer caps how many revisions of a Period may coexist.
alter table digests drop constraint digests_period_period_start_key;
alter table digests add constraint digests_period_period_start_revision_key
  unique (period, period_start, revision);

-- source_seq: the highest entries.seq among the Entries this Digest was
-- built from (0 if the Period held none). This is the staleness watermark
-- ADR 0039 reuses from ADR 0028's Sync change log, rather than adding an
-- `updated_at` column anywhere — ADR 0028 rejects one by name ("no
-- `updated_at` column is needed anywhere ... because nothing ever compares
-- one"). A Digest is what compares one now: `entries.seq` is reassigned
-- from the sequence on every edit and delete (`sync.rs`'s
-- `on conflict do update ... seq = nextval(...)`), so it already means
-- last-touch order, and a Digest is stale exactly when some Entry in its
-- Period now carries a seq above this watermark (see
-- `digest::select_is_stale`). Deliberately not filtered by `deleted_at`
-- anywhere it's compared — a deletion is exactly a change worth reporting.
alter table digests add column source_seq bigint not null default 0;

-- Existing rows predate the concept, and defaulting them to 0 would not be
-- the conservative choice it looks like — it would be uniformly wrong.
-- `entries.seq` starts at 1, so a watermark of 0 makes `select_is_stale`'s
-- `seq > source_seq` true for *every* Entry, and every Digest already on
-- disk would report stale the instant this migration ran, before anything
-- had actually changed. A marker that fires for every Period at once tells
-- a reader nothing.
--
-- The watermark is recoverable exactly, without guessing and without SQL
-- timezone math (ADR 0027 buckets Periods in Rust and never in SQL, so
-- this deliberately does not try to recompute period bounds here): each
-- row already records the Entries it was built from in
-- `grounding_entry_ids`, so the highest `seq` among precisely those is the
-- watermark that stood when it was written.
--
-- One known limit, and it errs quiet rather than loud: an Entry edited
-- between its Digest being written and this migration running already
-- carries a re-assigned, higher `seq` (`sync.rs`'s `seq = nextval(...)`),
-- so it raises this watermark to include a change the Digest never saw,
-- and that one pre-existing edit goes unreported. A false negative on
-- history is worth trading for not flagging every Digest ever written.
update digests d
   set source_seq = coalesce(
         (select max(e.seq) from entries e where e.id = any (d.grounding_entry_ids)),
         0
       );
