create table entries (
  id          uuid primary key,
  device_id   uuid        not null,
  body        text        not null,
  created_at  timestamptz not null,   -- client clock; drives display order
  seq         bigserial   not null unique  -- server order; the sync cursor
);
