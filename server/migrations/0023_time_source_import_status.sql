-- What the last import run made of each Time source (issue #421).
--
-- Persisted per source rather than as a log of runs. The question the Time
-- page asks is "is this recorder working, and if not why not", which is about
-- the source's current standing; a run history would be a different feature
-- with a different retention problem, and nothing asks for one yet.
--
-- `last_attempt_at` and `last_success_at` are separate because the difference
-- between them is the whole point: a source whose last attempt is recent and
-- whose last success is not is failing right now, and one where they match is
-- healthy. Collapsing them into a single "last run" column would hide exactly
-- the state worth showing.
alter table time_sources
  add column last_attempt_at timestamptz,
  add column last_success_at timestamptz,
  -- How many Activity intervals the last run actually inserted. Zero is an
  -- ordinary, successful answer: a recorder that observed nothing new since
  -- the previous run inserts nothing.
  add column last_inserted_count integer not null default 0,
  -- Rows the last run could not make sense of and skipped. Counted rather
  -- than stored, because a malformed row's own contents are what could not be
  -- read in the first place.
  add column last_warning_count integer not null default 0,
  -- Why the last run failed, if it did. Cleared on the next success, so this
  -- never describes a problem that has since gone away.
  add column last_error text;
