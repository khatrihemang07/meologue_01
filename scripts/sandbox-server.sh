#!/usr/bin/env bash
# Boots the Sandbox instance (issue #74): the Sandbox Postgres, the Sandbox
# web bundle, and the Rust server serving both on :41307.
#
# This is the instance every kind of testing gets to use. It shares the
# working tree with the production instance and nothing else — a different
# database in a different container, a different port, and a different
# `dist/` directory, so neither the developer's Entries nor the bundle their
# own server is serving can be disturbed by anything done in here.
#
# DATABASE_URL and PORT are set rather than defaulted through
# `${VAR:-...}` on purpose. The point of this script is that it cannot be
# aimed at the production instance, and a `${DATABASE_URL:-...}` would let an
# exported variable from a shell that had been working on :5432 do exactly
# that. The LLM configuration is the one thing deliberately left to be
# inherited: `server/src/main.rs` loads `server/.env`, and dotenvy does not
# override variables already in the environment, so MEOLOGUE_CHAT_* /
# MEOLOGUE_EMBED_* / MEOLOGUE_TZ come from the developer's own .env while
# DATABASE_URL, STATIC_DIR, PORT and BIND below still win.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --wait postgres-sandbox

pnpm --filter @meologue/web build:sandbox

cd server
export DATABASE_URL="postgres://meologue:meologue@localhost:5442/meologue"
export STATIC_DIR="../apps/web/dist/sandbox"
export PORT=41307
export BIND="0.0.0.0"
exec cargo run
