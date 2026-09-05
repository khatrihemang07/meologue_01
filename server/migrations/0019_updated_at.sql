-- Issue #196: a last-changed timestamp on the six server-side mutable
-- streams — Entries, Tasks, Projects, Sections, Labels, Comments. Merge
-- (issue #199) needs a way to tell whether two Devices' copies of a row
-- were touched at the same real-world moment; nothing before this ticket
-- recorded that. ADR 0028's own Alternatives section rejected a
-- client-supplied timestamp for *ordering Sync's own conflicts* and
-- recorded, as a named consequence, "no `updated_at` column is needed
-- anywhere" — this migration revisits that specific consequence
-- deliberately, not by oversight (see ADR 0059's own Alternatives section,
-- which already anticipated this ticket while designing #194's
-- acknowledgement mechanism). Sync's own conflict rule is otherwise
-- unchanged: row-level last-writer-wins by Server arrival order (the
-- reassigned `seq`), never by comparing this column.
--
-- `events` is excluded: it is append-only, `on conflict do nothing`
-- (../src/sync.rs's own `insert_events`), with no edit path that could
-- ever write it (ADR 0056). `filters` is excluded too, but for a
-- different reason — it has no server table at all
-- (../../packages/core/src/filter-store.ts's own header comment: no
-- Filter Sync stream exists), so there is nothing here for it to migrate.
--
-- Backfilled to `created_at`, not to whenever this migration happens to
-- run — deliberately. `created_at` is stable and identical on every
-- Device holding the same pre-existing row (none of the `set` lists in
-- ../src/sync.rs's `insert_*` functions ever include `created_at`), so
-- two Devices that already share a row before this migration ships end up
-- with the exact same backfilled `updated_at` — a tie, which is the
-- property Merge needs: neither Device's copy looks like the "winner" of
-- an edit that never happened. Backfilling to migration-run-time instead
-- would make whichever Device happened to migrate later look like it
-- touched every pre-existing row last, a spurious edit this ticket must
-- not invent.
--
-- `not null` after the backfill, mirroring
-- 0016_task_day_order.sql's own template: `sqlx::migrate!()` runs each
-- migration file inside a transaction (server/src/main.rs), so there is
-- no interrupted-partway-through state to guard against here the way the
-- transaction-free client-side SQLite migrator has to.
--
-- `default now()` is kept permanently, not dropped after the backfill —
-- every real write path (`../src/sync.rs`'s six `insert_*` functions)
-- always supplies `updated_at` explicitly from the pushing Device's own
-- row, so the default never fires for an actual Sync write. It exists for
-- the many raw, direct `insert into entries/tasks (...)` statements
-- elsewhere in this crate's own test suite (`digest.rs`, `reflect.rs`,
-- `harness/tools/`) that seed a row for an unrelated feature and have
-- never had to know this column exists — without a default, adding a
-- `not null` column here would silently break every one of them. `now()`
-- is the right default for exactly that case: a row inserted with no
-- opinion about `updated_at` at all is, definitionally, "just created,"
-- the same state a real fresh Sync push would leave it in.
alter table entries add column updated_at timestamptz default now();
update entries set updated_at = created_at where updated_at is null;
alter table entries alter column updated_at set not null;

alter table tasks add column updated_at timestamptz default now();
update tasks set updated_at = created_at where updated_at is null;
alter table tasks alter column updated_at set not null;

alter table projects add column updated_at timestamptz default now();
update projects set updated_at = created_at where updated_at is null;
alter table projects alter column updated_at set not null;

alter table sections add column updated_at timestamptz default now();
update sections set updated_at = created_at where updated_at is null;
alter table sections alter column updated_at set not null;

alter table labels add column updated_at timestamptz default now();
update labels set updated_at = created_at where updated_at is null;
alter table labels alter column updated_at set not null;

alter table comments add column updated_at timestamptz default now();
update comments set updated_at = created_at where updated_at is null;
alter table comments alter column updated_at set not null;
