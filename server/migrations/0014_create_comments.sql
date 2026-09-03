-- Issue #182 / ADR 0051: a Comment gets a Server table too, mirroring
-- 0013_create_labels.sql's own reasoning and
-- ../../packages/core/src/sqlite/migrations/0009_comments_table.sql's
-- client-side schema. No foreign key on `task_id` — the identical
-- "nothing here validates a cross-reference" rule 0010_create_tasks.sql's
-- own header comment already states, applied a fourth time.
create table comments (
  id           uuid primary key,
  device_id    uuid        not null,
  task_id      uuid        not null,
  text         text        not null,
  created_at   timestamptz not null,
  seq          bigserial   not null unique,
  deleted_at   timestamptz
);
