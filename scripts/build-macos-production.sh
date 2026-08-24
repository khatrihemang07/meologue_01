#!/usr/bin/env bash
# One command for a signed Production macOS release build: the web bundle,
# then `cargo tauri build` from apps/macos, which is the Tauri project root
# itself — there is no src-tauri/ subdirectory here to cd into.
#
# Preflight runs BEFORE the web build. check_macos_signing looks for the
# self-signed `meologue Dev` identity apps/macos/tauri.conf.json's
# `bundle.macOS.signingIdentity` names; without it `cargo tauri build` fails
# deep inside its own bundling step, after cargo has already compiled the
# whole crate. Checking here turns a missing identity into a ~1s failure
# instead of a wasted compile.
#
# ONE .dmg SURVIVES AT A TIME. Tauri's dmg bundler clears
# target/release/bundle/dmg/ on every run, so building the other macOS variant
# deletes this one's disk image — verified by doing it. The two .app bundles in
# bundle/macos/ are unaffected and do coexist, as do both APKs (Gradle gives each
# build type its own output directory). Only the .dmg is winner-takes-all, and
# nothing warns you: the build that removes it reports nothing but its own
# success. Rebuild the variant you need last, or copy its .dmg aside.
set -euo pipefail
cd "$(dirname "$0")/.."

. scripts/lib/preflight.sh
. scripts/lib/native-build.sh

APP=apps/macos/target/release/bundle/macos/meologue.app
DMG_DIR=apps/macos/target/release/bundle/dmg
DMG_PRODUCT=meologue
BUNDLE_ID=com.meologue.app

_usage() {
  cat <<USAGE
usage: $0 [--no-preflight]

Builds a signed Production macOS release ($BUNDLE_ID): $APP and its .dmg.

  --no-preflight   skip the prerequisite checks (node, pnpm, cargo, the
                   tauri CLI, Xcode CLT, and the signing identity).
USAGE
  return 0
}

nb_parse_args _usage "$@"

preflight_begin "macos production build"
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

nb_say "cargo tauri build"
(cd apps/macos && cargo tauri build)

nb_report_artifact "$APP" identifier "$BUNDLE_ID"
# Own line, not inlined into nb_report_artifact: see nb_find_dmg's comment —
# a failure inside $( ) can only abort the script from an assignment.
DMG=$(nb_find_dmg "$DMG_DIR" "$DMG_PRODUCT")
nb_report_artifact "$DMG" identifier "$BUNDLE_ID"

cat <<NEXT

Signed but NOT notarized — there is no Apple Developer account
(docs/adr/0015). Opening $APP on another Mac needs one explicit
right-click → Open; a double-click alone is refused by Gatekeeper.

The Sandbox build (com.meologue.app.sandbox) has a separate identifier and
application data directory. Both can run and sync at once, each reaching
only its own Server.

Building the sandbox variant next will delete this .dmg — Tauri clears the
dmg/ directory each run. The .app bundles coexist; only the disk image
does not.
NEXT
