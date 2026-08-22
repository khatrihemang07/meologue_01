#!/usr/bin/env bash
# Boots the second Server for the ticket-31 multi-server e2e harness (ADR
# 0011). It never serves the SPA — multi-server.spec.ts's Devices load the app
# from server A and only point their Server URL setting at this one — so
# unlike scripts/e2e-server.sh, it doesn't build the web app or wait for that
# build to exist.
#
# Its independence from server A is now a separate database rather than a
# separate container (issue #74): both live in the Sandbox Postgres. What the
# spec actually proves is that an Entry follows its Device's Server URL and
# not the origin that served the page, and two databases in one cluster share
# nothing that could weaken it — see docker-compose.yml.
#
# Deliberately no MEOLOGUE_CHAT_*/MEOLOGUE_EMBED_* here (unlike
# scripts/e2e-server.sh, issue #67): reflection.spec.ts only ever asks through
# server A, so server B keeps 404ing on /v1/reflect and /v1/sessions exactly
# as it did before Reflection existed — giving it the same routes as A would
# just be an unused second copy.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --wait postgres-sandbox

cd server
export DATABASE_URL="postgres://meologue:meologue@localhost:5442/meologue_e2e_b"
exec cargo run
