-- Issue #182: `description` (#180, ../../packages/core/src/task-types.ts's
-- own `description` field) gets a wire representation for the first time
-- — see server/src/sync.rs's `TaskInput`/`TaskOutput` doc comments for the
-- client-side workaround this retires. A single nullable column, mirroring
-- ../../packages/core/src/sqlite/migrations/0008_task_description.sql's
-- client-side shape exactly.
alter table tasks add column description text;
