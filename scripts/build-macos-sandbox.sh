#!/usr/bin/env bash
# One command for the Sandbox macOS build: the web bundle, then
# `cargo tauri build --config apps/macos/tauri.sandbox.conf.json`, which
# Tauri merges over tauri.conf.json to swap productName, identifier and
# window title. apps/macos IS the Tauri project root — no src-tauri/ here.
#
# frontendDist stays whatever tauri.conf.json sets (../web/dist/macos) —
# tauri.sandbox.conf.json does not override it, and that is deliberate, not
# an omission. docs/adr/0029 records that pointing this at dist/sandbox
# "looked tidier and was wrong": sqlite-driver.sandbox.ts re-exports the WEB
# driver, so a Sandbox .app built against dist/sandbox ran OPFS inside the
# WebView and never touched TauriSqliteDriver — it tested nothing. The
# `.sandbox` application identifier is the entire isolation mechanism here;
# both macOS variants build from the same dist/macos.
#
# Same signing identity as Production (tauri.conf.json's
# bundle.macOS.signingIdentity is not overridden either) — check_macos_signing
# runs before the web build for the same reason build-macos-production.sh
# gives: a missing identity should fail in ~1s, not after a full compile.
#
# One .dmg survives at a time — building the Production variant deletes this
# one's disk image. See build-macos-production.sh for why, and for what is not
# affected.
set -euo pipefail
cd "$(dirname "$0")/.."

. scripts/lib/preflight.sh
. scripts/lib/native-build.sh

APP=apps/macos/target/release/bundle/macos/meologue-sandbox.app
DMG_DIR=apps/macos/target/release/bundle/dmg
DMG_PRODUCT=meologue-sandbox
BUNDLE_ID=com.meologue.app.sandbox

_usage() {
  cat <<USAGE
usage: $0 [--no-preflight]

Builds the Sandbox macOS release ($BUNDLE_ID): $APP and its .dmg.

  --no-preflight   skip the prerequisite checks (node, pnpm, cargo, the
                   tauri CLI, Xcode CLT, and the signing identity).
USAGE
  return 0
}

nb_parse_args _usage "$@"

preflight_begin "macos sandbox build"
if [ "$NB_SKIP_PREFLIGHT" = 0 ]; then
  check_node
  check_pnpm
  check_cargo
  check_tauri_cli
  check_xcode_clt
  check_macos_signing
fi
preflight_report

nb_say "building apps/web/dist/macos (build:macos)"
pnpm --filter @meologue/web build:macos

nb_say "cargo tauri build --config tauri.sandbox.conf.json"
(cd apps/macos && cargo tauri build --config tauri.sandbox.conf.json)

nb_report_artifact "$APP" identifier "$BUNDLE_ID"
# Own line, not inlined into nb_report_artifact: see nb_find_dmg's comment —
# a failure inside $( ) can only abort the script from an assignment.
DMG=$(nb_find_dmg "$DMG_DIR" "$DMG_PRODUCT")
nb_report_artifact "$DMG" identifier "$BUNDLE_ID"

cat <<NEXT

Signed but NOT notarized — there is no Apple Developer account
(docs/adr/0015). Opening $APP on another Mac needs one explicit
right-click → Open; a double-click alone is refused by Gatekeeper.

The Production build (com.meologue.app) has a separate identifier and
application data directory. Both can run and sync at once, each reaching
only its own Server.

Building the production variant next will delete this .dmg — Tauri clears the
dmg/ directory each run. The .app bundles coexist; only the disk image
does not.
NEXT
