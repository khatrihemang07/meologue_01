#!/usr/bin/env bash
# Loads scripts/seed/sandbox-journal.sql — ~120 realistic Entries covering the
# last two months — into the sandbox Postgres used for manual/isolated testing.
#
# Why this exists: the sandbox database is a throwaway instance meant to be
# seeded, poked at, and reseeded freely while testing features like Reflect
# and Digest against realistic content. The user's own database (the one
# `meologue-postgres` on port 5432 backs, holding their real journal) must
# never receive this corpus — writing 120 fake Entries into someone's actual
# journal would be a disaster, not a convenience.
#
# That's why CONTAINER below is hardcoded rather than read from the
# environment (unlike, say, scripts/e2e.sh's MEOLOGUE_PG_CONTAINER override):
# the entire point of this script is that it can only ever be aimed at the
# sandbox container, never accidentally repointed at port 5432 via a stray
# env var.
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER=meologue-postgres-sandbox
DB=meologue

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "error: container '$CONTAINER' is not running." >&2
  echo "Start it first: docker compose up -d --wait postgres-sandbox" >&2
  exit 1
fi

# The schema is owned by the Server, not by this script: `sqlx::migrate!()`
# applies `server/migrations/` on startup (server/src/main.rs). On a Sandbox
# whose volume has just been created there is therefore nothing to insert
# into yet, and psql's own "relation \"entries\" does not exist" says
# nothing about how to fix that. Check first and say the actual next step.
if ! docker exec "$CONTAINER" psql -U meologue -d "$DB" -tAc \
  "select to_regclass('public.entries') is not null" 2>/dev/null | grep -qx t; then
  echo "error: '$DB' in $CONTAINER has no 'entries' table yet." >&2
  echo "The Server owns the schema. Run scripts/sandbox-server.sh once to apply" >&2
  echo "migrations, then re-run this script." >&2
  exit 1
fi

echo "--- seeding $DB in $CONTAINER from scripts/seed/sandbox-journal.sql ---"
docker exec -i "$CONTAINER" psql -U meologue -d "$DB" -v ON_ERROR_STOP=1 \
  < scripts/seed/sandbox-journal.sql

psql_sandbox() { docker exec -i "$CONTAINER" psql -U meologue -d "$DB" -v ON_ERROR_STOP=1 -tA "$@"; }

total=$(psql_sandbox -c "select count(*) from entries;")
live=$(psql_sandbox -c "select count(*) from entries where deleted_at is null;")
tombstoned=$(psql_sandbox -c "select count(*) from entries where deleted_at is not null;")
span=$(psql_sandbox -c "select min(created_at) || ' .. ' || max(created_at) from entries;")

echo "--- seed applied ---"
echo "total entries:      $total"
echo "live entries:        $live"
echo "tombstoned entries:  $tombstoned"
echo "created_at span:     $span"
