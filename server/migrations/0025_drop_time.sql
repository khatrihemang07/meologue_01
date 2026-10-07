-- The Time Destination was removed (issue #452); its tables go with it.
--
-- Migrations 0020-0024 stay as they are, because sqlx checksums applied
-- migrations. The drops are idempotent on purpose: restoring an older pg_dump
-- backup brings the tables back together with the old _sqlx_migrations rows,
-- so the next startup runs this migration again and must not fail.
drop table if exists activity_intervals;
drop table if exists time_sources;
