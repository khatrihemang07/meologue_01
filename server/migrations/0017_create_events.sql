-- Issue #184 / ADR 0056: an activity log for Todo, Synced additively
-- inside protocol 6 (no `PROTOCOL_VERSION` bump — see server/src/sync.rs's
-- own doc comment on why this stream needs no version gate of its own).
--
-- No `deleted_at`. Every other table this migrator has ever created
-- carries a tombstone column because ADR 0028's compacted change log
-- needs one: a mutable row can go from *something* to *nothing*, and
-- absence-of-row cannot travel through Sync on its own, so "removed" has
-- to be represented as a surviving row with a flag. An Event is never
-- mutated or removed once written (ADR 0056's own Decision — this is a
-- record of what happened, not a row anything ever edits), so there is no
-- "nothing" state to encode and no tombstone to add one for.
--
-- No `is distinct from` guard on this table's own write path either (see
-- `insert_events` in server/src/sync.rs) — a row that can never change
-- has nothing for that guard to compare against; replaying the same push
-- twice is `on conflict (id) do nothing`, not an update that might or
-- might not be a no-op.
create table events (
  id           uuid primary key,
  device_id    uuid        not null,
  event_type   text        not null,
  object_type  text        not null,
  object_id    uuid        not null,
  -- The Task this Event is about — `object_id` itself when
  -- `object_type = 'task'`, the parent Task when `object_type = 'comment'`,
  -- null for a `project`/`section` Event, which has no Task of its own.
  -- Drives the per-Task surface (issue #184's own acceptance criterion:
  -- "a Task shows its own history"). No foreign key — mirrors every other
  -- cross-reference in this schema (`tasks.project_id`,
  -- `comments.task_id`): nothing here validates it, or reaches across
  -- tables to keep it consistent.
  task_id      uuid,
  -- The Project this Event happened in, snapshotted at the moment it was
  -- recorded — drives the per-Project surface. Deliberately a snapshot,
  -- not "this Task's current Project": completing a Task while it lived
  -- in Project A, then later moving it to Project B, must not make the
  -- completion Event migrate to B's own history — it happened in A.
  project_id   uuid,
  -- The clock of the Device that performed the act, never the time this
  -- row reached the Server — ADR 0056's own Decision, and the whole
  -- reason this ticket exists. Compare `entries.created_at`, which has
  -- carried the identical trust in a Device's own clock since this
  -- project's first migration.
  occurred_at  timestamptz not null,
  -- Whatever this specific event_type/object_type pair needs to say
  -- about what changed — `{"content": "...", "last_content": "..."}` for
  -- a rename, `{"date": "2026-09-10", "last_date": null}` for "you set
  -- the date" (rendering "set" vs. "changed" from whether `last_date` is
  -- present is a render-time decision — issue #184's own acceptance
  -- criterion — not a second event_type). A single jsonb column rather
  -- than a wide table of nullable `last_*` columns, one pair per
  -- attribute a Task can carry: no event ever sets more than a couple of
  -- these at once, and a JSON blob for "whatever this one row needs to
  -- say" is the same choice `tasks.label_ids` already made for "whatever
  -- this one row needs to hold" (../../packages/core/src/task-types.ts's
  -- own `labelIds` doc comment) rather than reinventing a second
  -- technique for the identical shape of problem.
  extra        jsonb,
  seq          bigserial   not null unique
);

create index events_task_id_seq_idx on events (task_id, seq);
create index events_project_id_seq_idx on events (project_id, seq);
