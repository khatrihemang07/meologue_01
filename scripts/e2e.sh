#!/usr/bin/env bash
# Runs the e2e suite against the Sandbox Postgres, on two databases of its
# own that are recreated empty first.
#
# This used to be a much larger script (issues #67 and #73). Both e2e servers
# read DATABASE_URL, which on a developer machine pointed at the same database
# holding their Entries, so the suite quietly wrote into it — "that has
# happened, and had to be cleaned up by hand". The workaround was to rename
# that database aside, hand the suite an empty one, and restore it on every
# exit path with a trap.
#
# Issue #74 removed the reason for all of that. Testing has its own Postgres
# now (docker-compose.yml, `postgres-sandbox`), so there is nothing here worth
# protecting and nothing to put back — the suite just gets two empty databases
# inside it. Server A and server B still need one each, because
# multi-server.spec.ts proves an Entry follows its Device's Server URL rather
# than the origin that served the page, which a shared database would defeat.
#
# A consequence worth naming: this no longer cares whether the production server
# is running. It used to refuse to start if anything held a connection to the
# database it wanted to rename.
#
# One caveat that replaces it, and it is about the machine rather than the
# data. An earlier version of this comment blamed the Sandbox server
# (scripts/sandbox-server.sh) specifically — its embedding worker and Digest
# worker driving local LLM endpoints, left running during a suite run — for
# pushing the slowest multi-Device specs past their timeouts. Issue #112
# found that framing too narrow: every failing run it recorded had the
# Sandbox server *stopped* the whole time, and clean `main` with nothing
# else changed still failed at load average ~11.7 while it passed clean at
# ~4. The actual variable is machine load in general, from anything
# competing for CPU — this suite boots two real Rust servers, a Postgres
# container and a Node stub, and several of its specs used to guess a fixed
# number of milliseconds for Server-side background work (an embedding, a
# synced tombstone) that has no fixed duration once the machine is busy.
# Issue #112 replaced the worst of those guesses with polls for the actual
# condition and raised the suite's default assertion timeout, but a red run
# is still only informative next to the load average printed beside it
# below — compare it against a run at load ~4 before trusting it.
set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER=meologue-postgres-sandbox

docker compose up -d --wait postgres-sandbox

for db in meologue_e2e_a meologue_e2e_b; do
  docker exec "$CONTAINER" psql -U meologue -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS $db WITH (FORCE);" >/dev/null
  docker exec "$CONTAINER" psql -U meologue -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE $db OWNER meologue;" >/dev/null
done
echo "--- e2e databases recreated empty: meologue_e2e_a, meologue_e2e_b ---"

# Issue #112: a red run on its own doesn't say whether the code regressed or
# the machine was just busy. Recording load average before and after, and
# printing it beside the result, is what lets a reader tell those apart
# without re-running the suite on a quiet machine to compare.
load_average() {
  uptime | sed -E 's/.*load averages?: */load average: /'
}

load_before="$(load_average)"

set +e
pnpm --filter @meologue/e2e test:e2e "$@"
result=$?
set -e

load_after="$(load_average)"

echo "--- e2e $([ "$result" -eq 0 ] && echo PASSED || echo FAILED) — ${load_before} (before) / ${load_after} (after) ---"

exit "$result"
