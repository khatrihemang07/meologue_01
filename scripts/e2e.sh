#!/usr/bin/env bash
# Runs the e2e suite against a scratch database, then puts the real one back.
#
# Why this exists (issues #67 and #73): the suite's servers read DATABASE_URL,
# and on a developer machine that points at the same database holding the
# 572-Entry test journal. Every spec writes Entries into it, and digest.spec.ts
# now writes `digests` rows too, so a naive `pnpm --filter @meologue/e2e
# test:e2e` quietly pollutes the corpus. That has happened, and had to be
# cleaned up by hand.
#
# Overriding DATABASE_URL is NOT the fix: scripts/e2e-server-b.sh reads the
# same variable, so both servers would land on one database and
# multi-server.spec.ts fails by construction. Renaming the corpus aside and
# giving the suite a fresh `meologue` to fill is what keeps both servers
# isolated *and* the corpus untouched.
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER="${MEOLOGUE_PG_CONTAINER:-meologue-postgres}"
LIVE=meologue
PARKED=meologue_corpus_backup

psql_postgres() { docker exec "$CONTAINER" psql -U meologue -d postgres -v ON_ERROR_STOP=1 "$@"; }

# A rename needs every other connection gone. Fail loudly rather than killing
# somebody's session: a running dev server is the usual cause, and terminating
# it from here would be a surprising thing for a test script to do.
connections=$(psql_postgres -tAc "select count(*) from pg_stat_activity where datname = '$LIVE'")
if [ "$connections" != "0" ]; then
  echo "error: $connections connection(s) still open to '$LIVE'." >&2
  echo "Stop anything using it (usually a dev server: pkill -f meologue-server) and re-run." >&2
  exit 1
fi

if psql_postgres -tAc "select 1 from pg_database where datname = '$PARKED'" | grep -q 1; then
  echo "error: '$PARKED' already exists — a previous run did not finish restoring." >&2
  echo "Inspect both databases by hand before continuing; do not let this script guess." >&2
  exit 1
fi

restore() {
  local status=$?
  echo "--- restoring the corpus database ---"
  psql_postgres -c "DROP DATABASE IF EXISTS $LIVE;" >/dev/null
  psql_postgres -c "ALTER DATABASE $PARKED RENAME TO $LIVE;" >/dev/null
  echo "corpus restored: $(docker exec "$CONTAINER" psql -U meologue -d "$LIVE" -tAc 'select count(*) from entries') entries"
  exit $status
}

psql_postgres -c "ALTER DATABASE $LIVE RENAME TO $PARKED;" >/dev/null
psql_postgres -c "CREATE DATABASE $LIVE OWNER meologue;" >/dev/null
# From here on the corpus is parked, so every exit path must put it back.
trap restore EXIT

pnpm --filter @meologue/e2e test:e2e "$@"
