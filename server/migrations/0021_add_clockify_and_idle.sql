-- Clockify Desktop's Auto Tracker joins Toggl Track as a second Time source
-- adapter (issue #420). The check is widened rather than dropped: `kind` is
-- what decides which reader opens the file, so an unknown value would mean a
-- source row nothing can import.
alter table time_sources drop constraint time_sources_kind_check;
alter table time_sources
  add constraint time_sources_kind_check
  check (kind in ('toggl_activity', 'clockify_auto_tracker'));

-- Whether the recorder flagged idleness on this record.
--
-- The two providers express idleness differently and this column deliberately
-- does not pretend otherwise: Toggl stores a ZISIDLE flag on the record, while
-- Clockify stores ZIDLETIME, a number of idle seconds inside it. A `true` here
-- means only "the recorder reported idleness", never "the whole interval was
-- idle" — the exact provider value stays in `raw_row`, which is what the
-- lossless raw row exists for.
--
-- Existing rows default to false rather than being backfilled: every row
-- imported before this migration came from Toggl, where the column this maps
-- from was zero for all of them on the database it was built against.
alter table activity_intervals add column idle boolean not null default false;
