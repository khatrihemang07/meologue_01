#!/usr/bin/env bash
# One command for the Production instance: a single frozen process. It builds
# the web bundle and the Rust server once, then execs the server binary to
# serve the app and the API together on :41207. Nothing here watches the
# working tree — an edit made while this is running does not change what is
# being served, because nothing is re-run to notice the edit.
#
# That is deliberate, not a missing feature. Production holds real Entries,
# not test data, and the old hot-reload arrangement — a Vite dev server on
# :5173 watching the whole tree — meant an unrelated edit made while
# Production happened to be open could swap the app out from under whatever
# was on screen. ADR 0029 already treats the Android APK and the macOS .app
# as frozen artifacts you rebuild and reinstall rather than hot-reload; this
# makes the web+server path match that. Development, hot reload included,
# belongs in ./scripts/run-sandbox.sh — see docs/adr/0029-... for what
# "Production" and "Sandbox" mean here.
#
# The instance's identity is the assignments below and nothing else.
set -euo pipefail
cd "$(dirname "$0")/.."

INSTANCE="production"
COMPOSE_SERVICE="postgres"
CONTAINER="meologue-postgres"
DB_PORT=5432
SERVER_PORT=41207
BIND="0.0.0.0"
DATABASE_URL="postgres://meologue:meologue@localhost:5432/meologue"
STATIC_DIR="../apps/web/dist/web"
WEB_BUILD_SCRIPT="build:web"
WEB_DIST="apps/web/dist/web"
SERVER_BIN="server/target/release/meologue-server"

. scripts/lib/preflight.sh

_usage() {
  cat <<USAGE
usage: $0 [--no-preflight] [--no-build]

  --no-preflight   skip the prerequisite checks. Postgres is still started —
                   that is doing the job, not checking it.
  --no-build       skip building the web bundle and the server binary; run
                   whatever is already built. Fails if either is missing.
USAGE
  return 0
}

skip_preflight=0
skip_build=0
for arg in "$@"; do
  case $arg in
    --bundle)
      printf '%s\n' '--bundle is now the default — the Production bundle is always built.' >&2
      printf '%s\n' 'Drop the flag, or pass --no-build to reuse what is already built.' >&2
      exit 2
      ;;
    --no-preflight) skip_preflight=1 ;;
    --no-build)     skip_build=1 ;;
    -h|--help)      _usage; exit 0 ;;
    *)
      printf 'unknown option: %s\n\n' "$arg" >&2
      _usage >&2
      exit 2
      ;;
  esac
done

preflight_begin "$INSTANCE instance"
if [ "$skip_preflight" = 0 ]; then
  check_node
  check_pnpm
  check_cargo
  check_docker
  check_db_port_free "$DB_PORT" "$CONTAINER"
  check_port_free "$SERVER_PORT" "$INSTANCE server"
fi
# Outside the --no-preflight guard on purpose: bringing Postgres up is part of
# doing the job, not part of checking whether the job can be done.
ensure_postgres "$COMPOSE_SERVICE" "$CONTAINER"
if [ "$skip_preflight" = 0 ]; then
  check_llm_config
fi
preflight_report

_missing() {
  printf 'error: %s is missing — run %s without --no-build first.\n' "$1" "$0" >&2
  exit 1
}

if [ "$skip_build" = 1 ]; then
  [ -d "$WEB_DIST" ]   || _missing "$WEB_DIST"
  [ -x "$SERVER_BIN" ] || _missing "$SERVER_BIN"
else
  printf '%s--- building %s (%s) ---%s\n' "$_C_BLU" "$WEB_DIST" "$WEB_BUILD_SCRIPT" "$_C_OFF"
  pnpm --filter @meologue/web "$WEB_BUILD_SCRIPT"

  printf '%s--- building %s (cargo build --release) ---%s\n' "$_C_BLU" "$SERVER_BIN" "$_C_OFF"
  printf '%sA cold server/target/release takes minutes. Later runs are near-instant%s\n' \
    "$_C_DIM" "$_C_OFF"
  printf '%sonce nothing has changed, and --no-build skips this entirely.%s\n' \
    "$_C_DIM" "$_C_OFF"
  (cd server && cargo build --release)
fi

printf '\n%s--- %s: server :%s (frozen build) ---%s\n' "$_C_BLD" "$INSTANCE" "$SERVER_PORT" "$_C_OFF"
printf '  postgres :%s · bundle %s · %s\n' "$DB_PORT" "$WEB_DIST" "$SERVER_BIN"
printf '\n'
printf '  Open %shttp://localhost:%s%s and set that same address as the Server URL in\n' \
  "$_C_BLD" "$SERVER_PORT" "$_C_OFF"
printf '  Settings — an unset Server URL means Sync is off.\n'
printf '\n'
printf '  %s:%s is a different browser origin than :5173 was. localStorage and the OPFS%s\n' \
  "$_C_DIM" "$SERVER_PORT" "$_C_OFF"
printf '  %sstore are origin-keyed, so History starts empty here and fills from Sync.%s\n' \
  "$_C_DIM" "$_C_OFF"
printf '\n'
printf '  %sNothing watches the working tree. Rebuild by restarting; hot reload lives in%s\n' \
  "$_C_DIM" "$_C_OFF"
printf '  %s./scripts/run-sandbox.sh.%s\n' "$_C_DIM" "$_C_OFF"
printf '\n'
printf '  Ctrl-C stops it.\n\n'

# There is exactly one process now, so `exec` — rather than backgrounding it
# with `&` and tracking its PID — replaces this script's own process image
# with the server. That puts the server directly in the terminal's foreground
# process group, so Ctrl-C reaches it without anything here forwarding a
# signal. scripts/lib/run-instance.sh's job control, process-group kills and
# poll loop exist to manage TWO long-lived children; with one, none of that
# applies, and it must not be re-added here.
#
# `cd server` is load-bearing twice over, not tidiness: STATIC_DIR above is
# written relative to server/, and server/src/main.rs calls dotenvy::dotenv(),
# which searches upward from the working directory — from the repo root it
# would look for a root .env and never find server/.env, silently dropping the
# MEOLOGUE_* chat and embedding configuration and taking Reflection and Digest
# with it.
#
# The four variables are exported rather than defaulted through
# `${VAR:-...}`, for the reason scripts/sandbox-server.sh spells out at length:
# the point of a per-instance script is that it cannot be aimed at the other
# instance, and a `${DATABASE_URL:-}` fallback would let an exported variable
# from a shell that had been working on the Sandbox do exactly that. The LLM
# configuration is deliberately left inherited — dotenvy does not override
# variables already in the environment, so a developer's own .env still wins
# there while these three still win here.
cd server
export DATABASE_URL="$DATABASE_URL"
export STATIC_DIR="$STATIC_DIR"
export PORT="$SERVER_PORT"
export BIND="$BIND"
# SERVER_BIN is written relative to the repo root, because that is where the
# --no-build check and the banner above both read it from; `../` re-anchors it
# now that we are inside server/. One definition, so the two cannot drift.
exec "../$SERVER_BIN"
