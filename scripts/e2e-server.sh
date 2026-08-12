#!/usr/bin/env bash
# Boots the real stack for the ticket-11 e2e suite: Postgres, the built web
# app, and the Rust server serving both the app and /v1/sync on one port —
# the same production serving path the e2e test is meant to exercise.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --wait

pnpm --filter @meologue/web build

cd server
export DATABASE_URL="${DATABASE_URL:-postgres://meologue:meologue@localhost:5432/meologue}"
export STATIC_DIR="../apps/web/dist/web"
exec cargo run
