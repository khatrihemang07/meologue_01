-- Issue #182 / ADR 0051's own forward reference: Projects and Sections
-- (ADR 0047's second/third root nouns beyond Entry and Task) get Server
-- tables of their own, mirroring 0010_create_tasks.sql's own shape and
-- ../../packages/core/src/sqlite/migrations/0006_projects_sections.sql's
-- client-side schema column for column, rather than inventing a new one.
--
-- No collaboration column, no foreign keys — the identical reasoning
-- 0010_create_tasks.sql's own header comment gives: this server never
-- validates a Project/Section reference against anything, so a foreign key
-- would only make an otherwise-honest push fail outright.
create table projects (
  id           uuid primary key,
  device_id    uuid        not null,
  name         text        not null,
  colour       text        not null,
  favourite    boolean     not null default false,
  archived     boolean     not null default false,
  parent_id    uuid,
  description  text,
  order_key    text        not null,
  created_at   timestamptz not null,
  seq          bigserial   not null unique,
  deleted_at   timestamptz
);

create table sections (
  id           uuid primary key,
  device_id    uuid        not null,
  project_id   uuid        not null,
  name         text        not null,
  description  text,
  order_key    text        not null,
  archived     boolean     not null default false,
  created_at   timestamptz not null,
  seq          bigserial   not null unique,
  deleted_at   timestamptz
);
