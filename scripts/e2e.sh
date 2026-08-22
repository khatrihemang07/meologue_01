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
# A consequence worth naming: this no longer cares whether the personal server
# is running. It used to refuse to start if anything held a connection to the
# database it wanted to rename.
#
# One caveat that replaces it, and it is about the machine rather than the
# data: the Sandbox server (scripts/sandbox-server.sh) runs an embedding
# worker and a Digest worker that drive local LLM endpoints, and leaving it up
# during a run is enough load to push the slowest multi-Device specs past
# their timeouts. Measured on this repo: 46/46 with only the personal server
# up, 44/46 with the Sandbox server up too, the failures being timeouts in
# edit-delete and reflection rather than anything about isolation. Stop the
# Sandbox server before a full run if the suite starts flaking.
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

pnpm --filter @meologue/e2e test:e2e "$@"
