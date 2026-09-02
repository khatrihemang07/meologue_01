#!/usr/bin/env bash
# One command for the Sandbox instance: the Sandbox Postgres, the Rust server on
# :41307, and a Vite dev server on :5174, with both streams interleaved into this
# terminal and both PIDs taken down together on Ctrl-C.
#
# NOT a replacement for scripts/sandbox-server.sh, which stays. That script is
# the production-style serving path: one process, the built dist/sandbox bundle
# and the API together on :41307. This script is the hot-reload counterpart —
# nothing is pre-built, and the app you use is Vite's on :5174.
#
# Either one applies migrations to a freshly created Sandbox volume, because
# both boot the Server and server/src/main.rs runs sqlx::migrate!() on every
# start. scripts/seed-sandbox.sh's error message names both for that reason.
#
# Both instances can run at once. Nothing is shared but the working tree: a
# different container, port, database, bundle directory and browser origin
# (docs/adr/0029-testing-runs-in-a-sandbox-instance-that-shares-only-the-working-tree.md).
set -euo pipefail
cd "$(dirname "$0")/.."

INSTANCE="sandbox"
COMPOSE_SERVICE="postgres-sandbox"
CONTAINER="meologue-postgres-sandbox"
DB_PORT=5442
SERVER_PORT=41307
VITE_PORT=5174
BIND="0.0.0.0"
DATABASE_URL="postgres://meologue:meologue@localhost:5442/meologue"
STATIC_DIR="../apps/web/dist/sandbox"
WEB_BUILD_SCRIPT="build:sandbox"
VITE_MODE="sandbox"
WEB_DIST="apps/web/dist/sandbox"

. scripts/lib/preflight.sh
. scripts/lib/run-instance.sh

run_instance "$@"
