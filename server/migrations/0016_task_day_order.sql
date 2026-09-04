-- Issue #182: `day_order` (Today's own manual order,
-- ../../packages/core/src/task-types.ts's own `dayOrder` doc comment) gains
-- a wire representation and a column here, in the same bump as the four new
-- entity streams rather than a later one — Todoist keeps `child_order` and
-- `day_order` as two independent fields on the same row, and this is that
-- second field.
--
-- Existing rows (there are essentially none at the point this migration
-- ships, but the backfill costs nothing and keeps the invariant honest
-- regardless) get `order_key`'s own value — the identical bootstrap
-- ../../packages/core/src/sqlite/migrations/0010_task_day_order.sql already
-- gives pre-#182 rows client-side, and the identical bootstrap
-- packages/core/src/mapping.ts's own fromWireTaskOutput no longer needs at
-- the wire layer once this column exists, but a client's own local
-- migration still uses. Unlike that client-side migration, this one can set
-- `not null` afterward: `sqlx::migrate!()` runs each migration file inside a
-- transaction (server/src/main.rs), so there is no interrupted-partway-
-- through state to guard against the way the transaction-free SQLite
-- migrator has to.
alter table tasks add column day_order text;
update tasks set day_order = order_key where day_order is null;
alter table tasks alter column day_order set not null;
