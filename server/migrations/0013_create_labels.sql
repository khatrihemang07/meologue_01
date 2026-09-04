-- Issue #182 / ADR 0051: a Label gets a Server table too, mirroring
-- 0012_create_projects_sections.sql's own reasoning and
-- ../../packages/core/src/sqlite/migrations/0004_labels_table.sql's
-- client-side schema. No `order_key` — a Label carries no manual order on
-- the client either (../../packages/core/src/label-store.ts's own header
-- comment on why list() sorts alphabetically instead).
create table labels (
  id           uuid primary key,
  device_id    uuid        not null,
  name         text        not null,
  colour       text        not null,
  created_at   timestamptz not null,
  seq          bigserial   not null unique,
  deleted_at   timestamptz
);
