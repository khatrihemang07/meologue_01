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
# Issue #200: matches scripts/e2e-server.sh's own MEOLOGUE_CONFIG_LOCK — see
# that script's comment for the full reasoning. Server B has no
# MEOLOGUE_CHAT_*/MEOLOGUE_EMBED_* of its own for a stored row to override
# (see this script's own header comment for why), but multi-server.spec.ts
# does point a Device's Server URL at this Server, so its own `/v1/config`
# is just as reachable from the suite as Server A's — locking it keeps the
# same guarantee true here for the same reason, rather than leaving one of
# the two e2e Servers unlocked for no reason tied to what it happens not to
# need today.
export MEOLOGUE_CONFIG_LOCK=1
# Issue #112: `--release`, matching scripts/e2e-server.sh's own change and
# its comment there — two debug-profile Rust servers running for the whole
# suite was the largest single contributor to the suite's self-induced CPU
# load. Same one-off cost: the first release compile on a machine takes
# tens of seconds; `cargo` caches the result under `target/release` after
# that, same as it already does for the debug build.
exec cargo run --release
