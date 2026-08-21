-- A Digest (CONTEXT.md's Digest entry, docs/adr/0027): prose the Server
-- writes about a completed Period, without being asked. Written once by
-- the background worker in server/src/digest.rs and never again — the
-- `unique (period, period_start)` constraint below is what makes that
-- immutability structural rather than a promise the application code has
-- to keep on its own: a second attempt to write the same Period's Digest
-- (a retry, a race between two ticks, a re-run after a crash) can only
-- ever no-op against this table, never overwrite or duplicate.
create table digests (
  id                   uuid        primary key,
  period               text        not null,          -- "day" | "week" | "month" — see Period::as_str
  period_start         date        not null,           -- the Period's first local date (server::period::period_start_of)
  body                 text        not null,
  grounding_entry_ids  uuid[]      not null,           -- the Entries this Digest was built from, as Grounding
  created_at           timestamptz not null default now(),
  unique (period, period_start)
);
