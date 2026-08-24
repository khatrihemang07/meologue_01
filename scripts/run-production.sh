#!/usr/bin/env bash
# One command for the Production instance: Postgres, the Rust server, and a Vite
# dev server, with both process streams interleaved into this terminal and both
# PIDs taken down together on Ctrl-C.
#
# This is the hot-reload arrangement the README used to spell out as two
# terminals. The app is served by Vite on :5173, which proxies /v1 to the server
# on :41207; the server port serves the API and whatever is in dist/web. Pass
# --bundle to rebuild that too.
#
# The instance's identity is the six assignments below and nothing else — see
# scripts/lib/run-instance.sh for the machinery and why it is shaped that way,
# and docs/adr/0029-... for what "Production" and "Sandbox" mean here.
set -euo pipefail
cd "$(dirname "$0")/.."

INSTANCE="production"
COMPOSE_SERVICE="postgres"
CONTAINER="meologue-postgres"
DB_PORT=5432
SERVER_PORT=41207
VITE_PORT=5173
DATABASE_URL="postgres://meologue:meologue@localhost:5432/meologue"
STATIC_DIR="../apps/web/dist/web"
WEB_BUILD_SCRIPT="build:web"
VITE_MODE="web"
WEB_DIST="apps/web/dist/web"

. scripts/lib/preflight.sh
. scripts/lib/run-instance.sh

run_instance "$@"
