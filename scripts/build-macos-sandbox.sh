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
OUT_DIR=build/sandbox
BUNDLE_ID=com.meologue.app.sandbox
# Matches CERT_NAME in scripts/setup-signing.sh — the only place this
# identity is created, and check_macos_signing already checks for it under
# this exact name.
SIGNING_AUTHORITY="meologue Dev"

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

# `cargo tauri build` bundles the .app FIRST and the .dmg SECOND, and it
# exits non-zero if either fails. Under `set -euo pipefail` that took the
# whole script down — including the publish step below — even when the .app
# itself had been built and signed perfectly, which is the overwhelmingly
# common case: DMG bundling is what breaks, usually because a stale
# /Volumes/meologue is still mounted and `hdiutil` will not attach a second
# image with the same volume name.
#
# The consequence was the worst kind of build outcome. Loud failure, a
# correct artifact sitting in target/, and $OUT_DIR silently still holding a
# BUILD FROM A PREVIOUS DAY. On 2026-09-01 that shipped a .app 36 hours older
# than the feature under test; the stale copy was then tested and reported as
# a defect (issue #157). A build that succeeds but publishes nothing is worse
# than one that fails outright.
#
# So a non-zero exit is no longer fatal on its own. It is fatal only if no
# FRESH .app came out of it — checked by mtime against the moment the build
# started, so a leftover .app from an earlier run can never be mistaken for
# this run's output and republished.
#
# But "fresh" alone is NOT enough, and treating it as enough is exactly what
# issue #187 happened through: codesign failed with errSecInternalComponent
# (a lapsed signing keychain — see nb_diagnose_tauri_failure), Tauri's
# bundler fell back to an adhoc signature rather than aborting, `cargo tauri
# build` exited non-zero, this script attributed that to the .dmg step
# because a fresh .app existed, and the adhoc-signed .app — carrying a
# generated identifier instead of $BUNDLE_ID — published anyway. macOS runs
# adhoc-signed apps locally without any warning, so nothing surfaced it for
# six builds. A fresh .app is therefore necessary but not sufficient; the
# gate below is whether that fresh .app is ALSO signed the way it is
# supposed to be, checked by reading codesign's own opinion of it
# (nb_verify_app_signature), never by cargo tauri build's exit code alone.
#
# Output is captured to a log (while still streaming to the terminal via
# `tee`) so a failure can be diagnosed by what codesign actually said, not
# just by the fact that something failed. `if ! ... ; then` (not `||`) around
# the piped command is what keeps `set -e`/`pipefail` from aborting the
# script before this can look at the result, and `${PIPESTATUS[0]}` recovers
# `cargo tauri build`'s own exit code rather than `tee`'s.
_tauri_started_at=$(date +%s)
_tauri_log=$(mktemp)
trap 'rm -f "$_tauri_log"' EXIT
_tauri_status=0
if ! (cd apps/macos && cargo tauri build --config tauri.sandbox.conf.json) 2>&1 | tee "$_tauri_log"; then
  _tauri_status=${PIPESTATUS[0]}
fi

if [ "$_tauri_status" -ne 0 ]; then
  nb_diagnose_tauri_failure "$_tauri_log"
fi

_app_bin=$(find "$APP/Contents/MacOS" -maxdepth 1 -type f -perm -u+x 2>/dev/null | head -1)
if [ -z "$_app_bin" ] || [ "$(stat -f %m "$_app_bin")" -lt "$_tauri_started_at" ]; then
  nb_say "cargo tauri build exited $_tauri_status and produced no fresh .app — aborting."
  # NOT `exit "${_tauri_status:-1}"`. `${x:-1}` only substitutes when $x is
  # UNSET or EMPTY, and _tauri_status is initialised to the string "0" —
  # non-empty — so that form let a `cargo tauri build` that itself exited 0
  # (while $APP was missing, stale, or had moved) fall through to `exit 0`
  # here, reporting success for exactly the kind of failure this whole script
  # exists to catch. This abort must never exit zero regardless of
  # $_tauri_status's value.
  [ "$_tauri_status" -ne 0 ] && exit "$_tauri_status" || exit 1
fi

if ! nb_verify_app_signature "$APP" "$SIGNING_AUTHORITY" "$BUNDLE_ID"; then
  nb_say "cargo tauri build exited $_tauri_status and produced a fresh .app, but it is NOT correctly signed — aborting, NOT publishing."
  exit 1
fi

if [ "$_tauri_status" -ne 0 ]; then
  nb_say "WARNING: cargo tauri build exited $_tauri_status, but a fresh, correctly-signed .app was produced."
  nb_say "  This is almost always the .dmg step, which runs AFTER the .app is complete."
  nb_say "  Publishing the .app anyway; the disk image is a convenience, not a gate."
  nb_say "  If a disk image is stuck, clear it with:  hdiutil detach /Volumes/meologue -force"
fi

nb_report_artifact "$APP" authority "$NB_VERIFIED_AUTHORITY" identifier "$NB_VERIFIED_IDENTIFIER"

nb_say "collecting into $OUT_DIR/"
# Real bundle names kept, unlike the APKs: the .app filename is what
# Finder and the Dock display, so renaming the Sandbox to meologue.app
# would put two indistinguishable "meologue" entries on screen. The .dmg
# keeps its versioned name because that is the file you would hand
# someone.
# The .app is published BEFORE the .dmg is even looked for, and the disk
# image is best-effort from here on. That ordering is the whole point of
# this block, and it is worth saying why, because the obvious order caused
# a real and expensive failure.
#
# `cargo tauri build` writes the .app first and the .dmg second. DMG
# bundling fails outright whenever a stale /Volumes/meologue is still
# mounted from a previous run — `hdiutil` will not attach a second image
# with the same volume name. Under `set -euo pipefail` the old
# `DMG=$(nb_find_dmg ...)` assignment sat ABOVE these publishes, so that
# failure aborted the script here, after a completely successful compile
# and signing, and before the .app was ever copied into $OUT_DIR.
#
# The result was the worst kind of build outcome: loud failure, correct
# artifact sitting in target/, and $OUT_DIR silently still holding a
# BUILD FROM A PREVIOUS DAY. On 2026-09-01 that shipped a .app 36 hours
# older than the feature under test, and the stale copy was tested and
# reported as a defect (issue #157). A build that succeeds but publishes
# nothing is worse than one that fails.
#
# So: the thing that was actually built gets published unconditionally,
# and a missing disk image is a warning, not an abort. The .dmg is a
# convenience for handing the app to someone else; nothing in the
# verification loop needs it.
nb_publish "$APP" "$OUT_DIR" "$(basename "$APP")"

if DMG=$(nb_find_dmg "$DMG_DIR" "$DMG_PRODUCT"); then
  nb_report_artifact "$DMG" identifier "$BUNDLE_ID"
  nb_publish "$DMG" "$OUT_DIR" "$(basename "$DMG")"
else
  nb_say "WARNING: no .dmg was produced — the .app above is published and usable."
  nb_say "  Most often a stale /Volumes/meologue is still mounted; clear it with:"
  nb_say "    hdiutil detach /Volumes/meologue -force"
fi

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
