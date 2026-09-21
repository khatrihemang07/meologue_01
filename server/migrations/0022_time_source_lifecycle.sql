-- Archival and the point a Time source's identity becomes fixed (issue #423).
--
-- `first_imported_at` is what makes "the adapter kind and database path may
-- change before the first successful import, and not after" answerable. It
-- cannot be derived from whether `activity_intervals` has rows: a source can
-- import successfully and find nothing to import — a recorder installed
-- yesterday, a database whose only records are still open — and repointing
-- such a source at a different database afterwards would silently attribute
-- one recorder's evidence to another's history.
--
-- Existing rows get `now()` rather than NULL. They were created before this
-- column existed, their imports have long since run, and defaulting them to
-- "never imported" would hand the one Time source anyone has today a freedom
-- this migration exists to take away.
alter table time_sources add column first_imported_at timestamptz;
update time_sources set first_imported_at = created_at;

-- There is deliberately no destructive delete in v1 (issue #423): `enabled`
-- already carries archival, and Activity intervals reference their source, so
-- removing a row would either orphan evidence or take it with it. The column
-- has existed since 0020; this comment is the record of what it now means.
