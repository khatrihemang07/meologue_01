-- Issue #172 / ADR 0051: a Task (ADR 0047's second root noun) gets its own
-- table here, mirroring 0001_create_entries.sql's own shape and
-- 0005_add_entry_deleted_at.sql's tombstone technique exactly rather than
-- inventing new ones — a Task's Sync stream reuses ADR 0002's advisory-lock
-- ordering and ADR 0028's seq-reassignment/tombstone rules unchanged
-- (server/src/sync.rs's own doc comment on insert_tasks explains why each
-- guard is load-bearing again here, column for column).
--
-- No collaboration column, deliberately — mirroring
-- ../../packages/core/src/task-types.ts's own refusal, word for word:
-- meologue is one person's journal and one person's task list, and a
-- column for a feature nobody asked for doesn't sit here quietly "for
-- later."
--
-- `project_id`/`section_id`/`parent_id` are plain nullable `uuid` columns
-- with no foreign key constraint, and `label_ids` is a plain `uuid[]` with
-- no constraint on what it contains either. Projects, Sections and Labels
-- do not sync in this ticket (issue #172's own scope decision, recorded in
-- ADR 0051) — a Task can arrive here naming a Project, Section or Label
-- this database has never heard of, and a foreign key would make that push
-- fail outright rather than store the Task with an honestly-dangling
-- reference. Validating these ids would cost a cross-table check this
-- server has no reason to make: it never reads a `projects`, `sections` or
-- `labels` table at all, because none of the three exist here yet. A
-- dangling id is exactly as harmless server-side as it already is
-- client-side (../../packages/core/src/task-types.ts's own `labelIds`/
-- `projectId` doc comments call this an accepted, transient state, not
-- something a store reaches across tables to enforce).
create table tasks (
  id           uuid primary key,
  device_id    uuid        not null,
  content      text        not null,
  completed_at timestamptz,
  order_key    text        not null,
  created_at   timestamptz not null,   -- client clock; never rewritten on edit
  seq          bigserial   not null unique,  -- server order; the sync cursor
  deleted_at   timestamptz,            -- tombstone (ADR 0028, applied to Tasks)
  date         text,                   -- floating YYYY-MM-DD[THH:MM] — never a real timestamptz
  deadline     text,                   -- date-only YYYY-MM-DD
  duration     integer,                -- minutes
  priority     integer     not null default 1,
  label_ids    uuid[]      not null default '{}',
  date_string  text,                   -- the recurrence rule as typed, or null
  project_id   uuid,
  section_id   uuid,
  parent_id    uuid
);
