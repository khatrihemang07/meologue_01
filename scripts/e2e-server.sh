#!/usr/bin/env bash
# Boots the real stack for the ticket-11 e2e suite: the Sandbox Postgres, the
# built web app, and the Rust server serving both it and /v1/sync on one port
# — the same production serving path the e2e test is meant to exercise.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --wait postgres-sandbox

# The `web` target, not `sandbox` — pwa.spec.ts cuts the network and asserts
# History still renders, which only holds if the bundle carries a service
# worker, and vite.config.ts gates VitePWA on `target === "web"` alone. The
# suite is meant to exercise the real shipping target, so this has to stay
# the web one.
#
# But it goes to its own directory (issue #74). `dist/web` is what a
# developer's own server on :41207 serves, and a suite run that rebuilt it
# from a half-finished working tree would swap their app out from under them
# — the same class of accident this issue removed from the database side.
# The outDir flag overrides vite.config.ts's `dist/${target}` for this build
# only; the target, and therefore the service worker, is unchanged.
pnpm --filter @meologue/web exec vite build --mode web --outDir dist/e2e

cd server
export DATABASE_URL="postgres://meologue:meologue@localhost:5442/meologue_e2e_a"
export STATIC_DIR="../apps/web/dist/e2e"
# issue #67: without these, MEOLOGUE_CHAT_*/MEOLOGUE_EMBED_* would be
# whatever the developer's own server/.env happens to hold, and an unset pair
# means `/v1/reflect`/`/v1/sessions` never get registered at all
# (server/src/lib.rs gates both on LlmConfig::reflect_config() resolving) — so
# reflection.spec.ts couldn't run. Pointed at apps/e2e/llm-stub.ts's
# deterministic double (its LLM_STUB_PORT, apps/e2e/servers.ts) rather than a
# real model: a real chat call costs ~7s, returns different prose every time,
# and lives in a process this repo doesn't manage — all three are wrong for a
# test suite. Setting them here also pins them against server/.env, which
# server/src/main.rs now loads (commit 5eacf99) — dotenvy does not override a
# variable already in the environment, so these exports still win. Server B
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
# happens to run it. This matters more now that server/.env is loaded: the
# developer's own is MEOLOGUE_TZ=Asia/Kolkata.
export MEOLOGUE_TZ="${MEOLOGUE_TZ:-UTC}"
# Issue #200: a Server now stores settings of its own in Postgres, and a
# stored value wins over the environment (docs/adr/0059-*). This process
# stays up for the whole suite, across every spec file Playwright runs
# against it — so a `PATCH /v1/config` any one spec makes (a settings-page
# spec, once one exists) would otherwise silently override the LLM stub
# configuration exported above for every spec that runs after it in the
# same suite run, since a stored value normally wins over the environment.
# Locking makes this Server read only the environment, always, so the
# suite's LLM stub config can never be poisoned by a settings write any
# spec — or a developer poking at this Server by hand — happens to make.
export MEOLOGUE_CONFIG_LOCK=1
# Issue #112: `--release`, not a debug build. Two `cargo run` servers (this
# one and e2e-server-b.sh's) doing real JSON/SQL/pgvector work for the whole
# suite, on top of Playwright's own 4 parallel Chromium+SQLite-Worker
# stacks and a Postgres container, was the largest single contributor to
# the suite's own self-induced CPU load — a debug-profile server is several
# times the CPU of a release one for the same request. The one-off cost is
# the first release compile on a given machine (in the tens of seconds, not
# minutes, from an already-warm `target/` — cargo caches it same as debug),
# so only the very first run after this change, or after a source change,
# pays it; every run after that reuses the cached `target/release` binary
# same as debug builds already do.
exec cargo run --release
