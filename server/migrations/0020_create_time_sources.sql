create table time_sources (
  id uuid primary key,
  name text not null,
  kind text not null check (kind = 'toggl_activity'),
  path text not null unique,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table activity_intervals (
  id uuid primary key,
  source_id uuid not null references time_sources(id),
  provider_record_id text not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  label text not null,
  detail text,
  raw_row jsonb not null,
  created_at timestamptz not null default now(),
  check (ended_at > started_at),
  unique (source_id, provider_record_id)
);

create index activity_intervals_source_day on activity_intervals (source_id, started_at);
