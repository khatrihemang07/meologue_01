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
# issue #67: without these, MEOLOGUE_CHAT_*/MEOLOGUE_EMBED_* are unset, and
# `/v1/reflect`/`/v1/sessions` never get registered at all (server/src/lib.rs
# gates both on LlmConfig::reflect_config() resolving) — so reflection.spec.ts
# can't run. Pointed at apps/e2e/llm-stub.ts's deterministic double (its
# LLM_STUB_PORT, apps/e2e/servers.ts) rather than a real model: a real chat
# call costs ~7s, returns different prose every time, and lives in a process
# this repo doesn't manage — all three are wrong for a test suite. Only this
# script sets these — a developer's own `cargo run` (server/src/main.rs reads
# the environment directly, nothing loads a .env) is unaffected. Server B
# (scripts/e2e-server-b.sh) deliberately does not set these — see that
# script's own comment.
export MEOLOGUE_CHAT_BASE_URL="${MEOLOGUE_CHAT_BASE_URL:-http://localhost:41237/v1}"
export MEOLOGUE_CHAT_MODEL="${MEOLOGUE_CHAT_MODEL:-llm-stub-chat}"
export MEOLOGUE_EMBED_BASE_URL="${MEOLOGUE_EMBED_BASE_URL:-http://localhost:41237/v1}"
export MEOLOGUE_EMBED_MODEL="${MEOLOGUE_EMBED_MODEL:-llm-stub-embed}"
# issue #73: `server/src/period.rs::parse_timezone` already falls back to
# UTC when `MEOLOGUE_TZ` is unset, so this isn't strictly load-bearing —
# but Digest's Period boundaries (day/week/month) are calendar maths keyed
# on this timezone, and digest.spec.ts seeds `digests` rows at fixed plain
# calendar dates. Pinning UTC here explicitly, rather than relying on the
# default staying UTC forever, means those boundaries can't shift under
# the suite depending on which machine or CI runner's own default zone
# happens to run it.
export MEOLOGUE_TZ="${MEOLOGUE_TZ:-UTC}"
exec cargo run
