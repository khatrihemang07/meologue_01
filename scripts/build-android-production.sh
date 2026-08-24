#!/usr/bin/env bash
# One command for a signed, installable Production Android release build:
# the web bundle, `cap sync`, and `gradlew assembleRelease`.
#
# Preflight runs BEFORE the web build on purpose. The release keystore check
# (check_android_release_signing) is the one most likely to be missing on a
# machine that has never run ./scripts/setup-signing.sh, and
# apps/android/app/build.gradle already fails assembleRelease loudly if it
# is — but only once Gradle configures the release task, which is after
# `tsc -b && vite build` has already run. Failing here first turns that into
# a ~1s no-op instead of a wasted web build.
#
# Why `pnpm --filter @meologue/web exec cap sync android` and not the
# `npx cap sync android` the README shows: npx can reach out to the registry
# to resolve @capacitor/cli, and this project already carries it as a
# devDependency (apps/web/package.json) — scripts/e2e-server.sh invokes vite
# the same way, through the workspace's own binary, for the same reason.
#
# Production and the Sandbox share one identifier for the artifact they
# build INTO — both variants build `dist/android`, there is no
# `dist/production` — because Capacitor's `webDir` is fixed at
# apps/web/capacitor.config.ts and is not itself instance-aware. What
# separates the two installs is the applicationId baked into each Gradle
# build type (docs/adr/0029), not which dist/ directory fed the sync.
set -euo pipefail
cd "$(dirname "$0")/.."

. scripts/lib/preflight.sh
. scripts/lib/native-build.sh

APK=apps/android/app/build/outputs/apk/release/app-release.apk
APP_ID=com.meologue.app
SERVER_PORT=41207

_usage() {
  cat <<USAGE
usage: $0 [--no-preflight]

Builds a signed Production Android release APK ($APP_ID).

  --no-preflight   skip the prerequisite checks (node, pnpm, Java, the
                   Android SDK, gradlew, adb, and the release keystore).
USAGE
  return 0
}

nb_parse_args _usage "$@"

preflight_begin "android production build"
if [ "$NB_SKIP_PREFLIGHT" = 0 ]; then
  check_node
  check_pnpm
  check_java
  check_android_sdk
  check_gradlew
  check_adb
  check_android_release_signing
fi
preflight_report

nb_say "building apps/web/dist/android (build:android)"
pnpm --filter @meologue/web build:android

nb_say "cap sync android"
pnpm --filter @meologue/web exec cap sync android

nb_say "gradlew assembleRelease"
(cd apps/android && ./gradlew assembleRelease)

nb_report_artifact "$APK" applicationId "$APP_ID"

cat <<NEXT

Install and reach a local Server over USB:
  adb install -r $APK
  adb reverse tcp:$SERVER_PORT tcp:$SERVER_PORT

Use http://127.0.0.1:$SERVER_PORT in Settings, not localhost — Capacitor
intercepts that hostname.

Debug and release builds sign with different keys: uninstall $APP_ID before
switching between them, or the install will fail with a signature mismatch.
The Sandbox (com.meologue.app.sandbox) installs alongside either one.
NEXT
