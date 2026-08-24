#!/usr/bin/env bash
# One command for the Sandbox Android build: the web bundle, `cap sync`, and
# `gradlew assembleSandbox`.
#
# No release-signing check here, unlike build-android-production.sh. The
# `sandbox` build type (apps/android/app/build.gradle) is `initWith debug`,
# so it signs with the debug key Android's own tooling generates on first
# use — there is no keystore.properties to be missing. That is also why this
# script has nothing to fail fast on before the web build: every other
# preflight check here is identical to production's.
#
# Both variants build INTO `dist/android` — there is no `dist/sandbox`
# artifact here, that name is the WEB Sandbox's bundle on :41307 only. What
# makes this install distinct from Production is the applicationId
# (`.sandbox` suffix baked into the Gradle build type), not which dist/
# directory fed `cap sync`. docs/adr/0029 spells out why the native Sandbox
# does not get its own dist/ directory: the identifier suffix is the whole
# isolation mechanism, and giving it a separate bundle already produced one
# real bug (the macOS Sandbox briefly pointed at dist/sandbox and silently
# ran the web SQLite driver instead of the native one, testing nothing).
#
# `pnpm --filter @meologue/web exec cap sync android`, not `npx cap sync
# android`: see build-android-production.sh for why.
set -euo pipefail
cd "$(dirname "$0")/.."

. scripts/lib/preflight.sh
. scripts/lib/native-build.sh

APK=apps/android/app/build/outputs/apk/sandbox/app-sandbox.apk
APP_ID=com.meologue.app.sandbox
SERVER_PORT=41307

_usage() {
  cat <<USAGE
usage: $0 [--no-preflight]

Builds the Sandbox Android APK ($APP_ID), debug-signed.

  --no-preflight   skip the prerequisite checks (node, pnpm, Java, the
                   Android SDK, gradlew, adb).
USAGE
  return 0
}

nb_parse_args _usage "$@"

preflight_begin "android sandbox build"
if [ "$NB_SKIP_PREFLIGHT" = 0 ]; then
  check_node
  check_pnpm
  check_java
  check_android_sdk
  check_gradlew
  check_adb
fi
preflight_report

nb_say "building apps/web/dist/android (build:android)"
pnpm --filter @meologue/web build:android

nb_say "cap sync android"
pnpm --filter @meologue/web exec cap sync android

nb_say "gradlew assembleSandbox"
(cd apps/android && ./gradlew assembleSandbox)

nb_report_artifact "$APK" applicationId "$APP_ID"

cat <<NEXT

Install and reach a local Server over USB:
  adb install -r $APK
  adb reverse tcp:$SERVER_PORT tcp:$SERVER_PORT

Use http://127.0.0.1:$SERVER_PORT in Settings, not localhost — Capacitor
intercepts that hostname.

The Sandbox installs alongside a debug or release Production build — its
own applicationId means it never collides with either.
NEXT
