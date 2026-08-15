#!/usr/bin/env bash
# Boots the second Server for the ticket-31 multi-server e2e harness (ADR
# 0011): its own Postgres (postgres-e2e-b in docker-compose.yml, a separate
# container/volume/port from the one scripts/e2e-server.sh uses), no shared
# state with server A. It never serves the SPA — multi-server.spec.ts's
# Devices load the app from server A and only point their Server URL
# setting at this one — so unlike scripts/e2e-server.sh, it doesn't build
# the web app or wait for that build to exist.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --wait postgres-e2e-b

cd server
export DATABASE_URL="${DATABASE_URL:-postgres://meologue:meologue@localhost:5433/meologue}"
exec cargo run
