#!/usr/bin/env bash
# Attaches the signed Production artifacts that scripts/build-*-production.sh
# leave in build/production/ to a new GitHub Release, tagged v<version> where
# <version> comes from apps/macos/tauri.conf.json.
#
# This is a LOCAL script, run by hand, not a CI job. The signing identities it
# depends on transitively (through the artifacts it uploads) deliberately live
# outside the repo and outside any CI runner's reach — docs/adr/0015 is explicit
# that this project has no store account behind either platform and both
# identities are generated on the developer's own machine. A CI runner would
# have neither the macOS keychain nor the Android keystore, so there is nothing
# to automate here beyond what this script already does by hand.
#
# The eight guards below exist because the failure they each catch already
# happened once, or is one keystroke away from happening. In particular:
# guard 6 (freshness) is the one issue #157 is about — see
# build-macos-production.sh for the incident. This script guards the same
# hazard one layer up: even a build script that always publishes a FRESH
# artifact is no protection if a stale one is sitting in build/production/
# from days ago and nobody rebuilt before running this script. Guard 8
# (signature) is issue #187, one layer up again: even a build script that now
# refuses to publish an adhoc-signed .app into build/production/ (see
# nb_verify_app_signature) is no protection against a build/production/
# left over from BEFORE that fix existed — this script is the last thing
# standing between whatever is sitting in that directory and a public
# download.
set -euo pipefail
cd "$(dirname "$0")/.."

. scripts/lib/preflight.sh
. scripts/lib/native-build.sh

OUT_DIR=build/production
APK_SRC="$OUT_DIR/meologue.apk"
APP_SRC="$OUT_DIR/meologue.app"
DMG_PRODUCT=meologue
VERSION_FILE=apps/macos/tauri.conf.json
PREAMBLE=scripts/lib/release-preamble.md
BUNDLE_ID=com.meologue.app
# Matches CERT_NAME in scripts/setup-signing.sh.
SIGNING_AUTHORITY="meologue Dev"

_usage() {
  cat <<USAGE
usage: $0 [--build] [--dry-run] [--no-preflight]

Attaches build/production/'s signed macOS .dmg and Android .apk to a new
GitHub Release, tagged v<version> from $VERSION_FILE.

  --build          run scripts/build-android-production.sh and
                    scripts/build-macos-production.sh first, so the
                    artifacts in $OUT_DIR are guaranteed fresh
  --dry-run        run every guard below and stage the assets, but skip
                    every 'gh' write — print the command that would run
                    instead of running it
  --no-preflight   skip the prerequisite check (gh present and authenticated)
USAGE
  return 0
}

# nb_parse_args (scripts/lib/native-build.sh) only knows --no-preflight and
# -h/--help — it is shared by all four build scripts and none of them takes
# --build or --dry-run. Rather than teach a shared helper two flags only this
# caller uses, strip those two out first and hand the rest to nb_parse_args
# unmodified, so -h/--help and the unknown-option error still behave exactly
# as they do in every build script.
DO_BUILD=0
DRY_RUN=0
_pass_through=()
for _arg in "$@"; do
  case $_arg in
    --build)   DO_BUILD=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *)         _pass_through[${#_pass_through[@]}]=$_arg ;;
  esac
done
nb_parse_args _usage ${_pass_through[@]+"${_pass_through[@]}"}

# ---------------------------------------------------------------------------
# error() / abort with a full sentence, matching nb_find_dmg's and
# nb_report_artifact's "error: ..." convention in native-build.sh.
# ---------------------------------------------------------------------------
_abort() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

# gh is the one prerequisite this script adds on top of what the build
# scripts already check — it is not something check_node/check_pnpm/etc in
# preflight.sh has any reason to know about, so it stays local here rather
# than joining the shared library for a single caller.
check_gh() {
  if ! command -v gh >/dev/null 2>&1; then
    pf_fail gh "not on PATH" "brew install gh"
    return 0
  fi
  pf_ok gh "$(gh --version 2>/dev/null | head -1 | awk '{print $3}')"
  if gh auth status >/dev/null 2>&1; then
    pf_ok "gh auth" "authenticated"
  else
    pf_fail "gh auth" "not authenticated" "gh auth login"
  fi
  return 0
}

preflight_begin "release publish"
if [ "$NB_SKIP_PREFLIGHT" = 0 ]; then
  check_gh
fi
preflight_report

if [ "$DO_BUILD" = 1 ]; then
  nb_say "building production artifacts (--build)"
  # Android first, macOS last: cargo tauri build's dmg bundler clears
  # target/release/bundle/dmg/ on every run (see build-macos-production.sh),
  # so running macOS last is what leaves ITS .dmg as the one nb_find_dmg
  # below sees as newest — not because order matters to Android at all.
  ./scripts/build-android-production.sh
  ./scripts/build-macos-production.sh
fi

# ---------------------------------------------------------------------------
# Version: apps/macos/tauri.conf.json is the one source of truth.
# ---------------------------------------------------------------------------
# No `jq` here on purpose — nothing else under scripts/ depends on it being
# installed, and adding the first such dependency for one three-line read
# would be a worse trade than a `sed` that only ever has to parse a single
# quoted string on its own line. This pattern is deliberately narrow: it reads
# the first `"version": "..."` line in the file and nothing else, which is
# exactly what every source below also does to itself.
# `|| true` on every one of these pipeline reads, and it is load-bearing.
# Under `set -euo pipefail` a failing `sed`/`git show` makes the PIPELINE
# non-zero, which makes the ASSIGNMENT a failed simple command, which makes
# `set -e` kill the script right here — before the hand-written `if [ -z ... ]`
# below ever runs. Since the stderr of these reads is discarded, the operator
# would get a bare non-zero exit and no message at all: the exact
# failed-with-no-diagnostic outcome these crafted errors exist to prevent.
# Swallowing the status lets the emptiness check downstream do the talking.
VERSION=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$VERSION_FILE" | head -1 || true)
if [ -z "$VERSION" ]; then
  _abort "could not read \"version\" from $VERSION_FILE — is it still valid JSON?"
fi
nb_say "publishing v$VERSION"

# ---------------------------------------------------------------------------
# Guard 1 — working tree clean.
# ---------------------------------------------------------------------------
# The tag this script creates points at HEAD. If the tree is dirty, HEAD is
# not what is actually sitting on disk, and the Release would claim to be a
# commit that does not match what was built and tested.
nb_say "guard: working tree is clean"
if [ -n "$(git status --porcelain)" ]; then
  _abort "the working tree is not clean (git status --porcelain shows pending changes) — commit or stash them, then re-run. The tag this script creates points at HEAD, and HEAD must be what was actually built."
fi

# ---------------------------------------------------------------------------
# Guard 2 — HEAD is on origin.
# ---------------------------------------------------------------------------
# A tag on a commit only origin has never seen is a tag pointing at nothing
# useful to anyone who clones the repo instead of pulling this exact
# checkout — the Release's "Source code" link and its commit reference would
# both 404 relative to what anyone else can see.
nb_say "guard: HEAD is pushed to origin"
if ! git branch -r --contains HEAD 2>/dev/null | grep -q 'origin/'; then
  _abort "HEAD ($(git rev-parse --short HEAD)) is not on any origin/* branch — push it first: git push origin HEAD, then re-run."
fi

# ---------------------------------------------------------------------------
# Guard 3 — every version site agrees with $VERSION_FILE.
# ---------------------------------------------------------------------------
# These six files each carry their own copy of the version string because
# nothing in this workspace derives them from one place (pnpm workspaces
# don't require it, and Cargo/Gradle have no notion of a JS package.json at
# all) — so drift between them is a manual-bump problem, not a tooling one,
# and the only real defense is checking before a Release ships with some of
# them stale.
#
# server/Cargo.toml is DELIBERATELY EXCLUDED from this list. It sits at
# 0.1.0 and has drifted because nothing ever ships an artifact from it — the
# Server runs from source (docker compose / cargo run), never packaged into
# this Release — so its version field has no reader and no consequence. Do
# not "fix" this by adding it here; that would turn a harmless, permanent gap
# into a guard that blocks every future release until someone bumps a number
# nobody reads.
nb_say "guard: version sites agree with $VERSION_FILE ($VERSION)"

MISMATCHES=()

_check_pkg_version() {
  local file=$1 v
  v=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -1 || true)
  if [ "$v" != "$VERSION" ]; then
    MISMATCHES[${#MISMATCHES[@]}]="$file: \"version\": \"$v\""
  fi
}

_check_cargo_version() {
  local file=$1 v
  v=$(sed -n 's/^version = "\([^"]*\)".*/\1/p' "$file" | head -1 || true)
  if [ "$v" != "$VERSION" ]; then
    MISMATCHES[${#MISMATCHES[@]}]="$file: version = \"$v\""
  fi
}

_check_gradle_version_name() {
  local file=$1 v
  v=$(sed -n 's/.*versionName "\([^"]*\)".*/\1/p' "$file" | head -1 || true)
  if [ "$v" != "$VERSION" ]; then
    MISMATCHES[${#MISMATCHES[@]}]="$file: versionName \"$v\""
  fi
}

_check_pkg_version package.json
_check_pkg_version packages/core/package.json
_check_pkg_version apps/web/package.json
_check_pkg_version apps/e2e/package.json
_check_cargo_version apps/macos/Cargo.toml
_check_gradle_version_name apps/android/app/build.gradle

if [ "${#MISMATCHES[@]}" -gt 0 ]; then
  {
    printf 'error: %d file(s) disagree with %s (version %s):\n' "${#MISMATCHES[@]}" "$VERSION_FILE" "$VERSION"
    for _m in "${MISMATCHES[@]}"; do
      printf '  - %s\n' "$_m"
    done
    printf 'bump every one of them to %s and re-run.\n' "$VERSION"
  } >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Guard 4 — Android versionCode strictly increases.
# ---------------------------------------------------------------------------
# apps/android/app/build.gradle:24 asks for this invariant in a comment and
# nothing enforces it today: "versionCode must increase monotonically
# forever." Android's package installer takes that literally — a release APK
# whose versionCode is not strictly greater than the one already installed is
# refused outright, not merely warned about, and the failure only surfaces on
# whatever device someone happens to try the upgrade on. Catching a
# non-increasing versionCode here, before the tag exists, is a lot cheaper
# than catching it on a phone.
nb_say "guard: android versionCode increases"
CUR_VERSION_CODE=$(sed -n 's/.*versionCode[[:space:]]*\([0-9][0-9]*\).*/\1/p' apps/android/app/build.gradle | head -1 || true)
if [ -z "$CUR_VERSION_CODE" ]; then
  _abort "could not read versionCode from apps/android/app/build.gradle."
fi

# `v[0-9]*`, not `v*` — this repo already has proto-v1 and proto-v2 tags from
# before real releases existed, and both would sort ahead of a bare `v*`
# glob's absence-check if it were left to match anything starting with "v".
# Neither starts with "v" itself (they start with "proto-"), so `v*` would
# not actually have matched them either, but `v[0-9]*` says out loud that
# only vMAJOR.MINOR.PATCH-shaped tags count, which is what "most recent
# release" is supposed to mean here.
PREV_TAG=$(git tag -l 'v[0-9]*' --sort=-version:refname | head -1 || true)
if [ -n "$PREV_TAG" ]; then
  PREV_VERSION_CODE=$(git show "$PREV_TAG":apps/android/app/build.gradle 2>/dev/null | sed -n 's/.*versionCode[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -1 || true)
  if [ -z "$PREV_VERSION_CODE" ]; then
    _abort "could not read versionCode from apps/android/app/build.gradle at $PREV_TAG — cannot verify it only increases."
  fi
  if [ "$CUR_VERSION_CODE" -le "$PREV_VERSION_CODE" ]; then
    _abort "apps/android/app/build.gradle's versionCode ($CUR_VERSION_CODE) is not greater than $PREV_TAG's ($PREV_VERSION_CODE) — bump versionCode (and versionName) by hand in apps/android/app/build.gradle. A non-increasing versionCode produces an APK Android refuses to install over the previous one."
  fi
  nb_say "  $CUR_VERSION_CODE > $PREV_TAG's $PREV_VERSION_CODE"
else
  nb_say "  no v[0-9]* tag exists yet — nothing to compare against (first release)"
fi

# ---------------------------------------------------------------------------
# Guard 5 — the tag and the Release do not already exist.
# ---------------------------------------------------------------------------
nb_say "guard: v$VERSION is not already tagged or released"
if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
  _abort "tag v$VERSION already exists locally — delete it first (git tag -d v$VERSION) if this is meant to replace it, or bump the version if it is meant to be a new release."
fi
if git ls-remote --exit-code --tags origin "refs/tags/v$VERSION" >/dev/null 2>&1; then
  _abort "tag v$VERSION already exists on origin — this version has already been released."
fi
if gh release view "v$VERSION" >/dev/null 2>&1; then
  _abort "a GitHub Release for v$VERSION already exists — bump the version, or delete that release first: gh release delete v$VERSION."
fi

# ---------------------------------------------------------------------------
# Guard 6 — freshness. THE MOST IMPORTANT GUARD.
# ---------------------------------------------------------------------------
# build-macos-production.sh documents issue #157: a .app that was 36 hours
# stale sat in build/production/ while a completely unrelated build failure
# elsewhere left it untouched, was tested as though it were current, and was
# reported as a defect. That happened to a build script publishing into
# build/production/ for local testing. This script publishes whatever is
# sitting in that same directory to a PUBLIC download page — reproducing that
# exact hazard here is worse, because the person misled by a stale artifact
# might not even be the one who built it.
#
# "Fresh" is defined the only way that is actually checkable from outside the
# build: the artifact's mtime must be at or after HEAD's commit time. An
# artifact older than the commit it is about to be tagged against cannot
# possibly reflect that commit — it was built from some earlier tree, however
# similar. `stat -f %m` is BSD stat's epoch-seconds mtime; this script only
# ever runs on macOS (docs/adr/0015 — the signing identities it uploads are
# macOS/Android release artifacts, only ever produced on the developer's own
# Mac), so there is no GNU-stat fallback to carry.
nb_say "guard: artifacts are not older than HEAD"
HEAD_TIME=$(git log -1 --format=%ct)
HEAD_HUMAN=$(git log -1 --date=local --format=%cd)

_check_freshness() {
  local path=$1 mtime human
  if [ ! -e "$path" ]; then
    _abort "$path does not exist — build it first: re-run with --build, or run scripts/build-*-production.sh yourself."
  fi
  mtime=$(stat -f %m "$path")
  if [ "$mtime" -lt "$HEAD_TIME" ]; then
    human=$(date -r "$mtime")
    _abort "$path is older than HEAD ($human vs HEAD's $HEAD_HUMAN) — it predates the commit this Release would tag and does not provably reflect it (this is the exact shape of issue #157). Re-run with --build to rebuild both artifacts, or rebuild the stale one yourself with scripts/build-*-production.sh."
  fi
}

_check_freshness "$APK_SRC"
# nb_find_dmg (scripts/lib/native-build.sh) locates the newest
# meologue_*.dmg in $OUT_DIR and fails the same way it does inside the build
# scripts if none exists — that failure doubles as this guard's existence
# check for the .dmg, so there is no separate `[ -e ]` for it here.
DMG_SRC=$(nb_find_dmg "$OUT_DIR" "$DMG_PRODUCT")
_check_freshness "$DMG_SRC"

# ---------------------------------------------------------------------------
# Guard 7 — the .dmg's filename matches $VERSION.
# ---------------------------------------------------------------------------
# nb_find_dmg only ever guarantees "newest meologue_*.dmg in the directory" —
# it has no idea what version tauri.conf.json currently claims, and an old
# .dmg from a previous version bump can still be mtime-fresh (touched by an
# unrelated `cp`, or simply not yet cleaned out) without being a build OF
# this version at all. The filename is the one place Tauri stamped the
# version it actually built, so it is the last independent check before this
# gets uploaded as v$VERSION.
nb_say "guard: $(basename "$DMG_SRC")'s filename matches v$VERSION"
DMG_BASENAME=$(basename "$DMG_SRC")
case $DMG_BASENAME in
  "${DMG_PRODUCT}_${VERSION}_"*.dmg) : ;;
  *) _abort "$DMG_BASENAME does not embed version $VERSION — rebuild macOS (--build, or scripts/build-macos-production.sh) so the .dmg matches $VERSION_FILE." ;;
esac

# ---------------------------------------------------------------------------
# Guard 8 — the .app carries a real signature, not an adhoc fallback.
# ---------------------------------------------------------------------------
# The .dmg staged and uploaded below is a disk image OF this exact .app —
# Tauri bundles them from the same build — so an adhoc-signed .app here means
# an adhoc-signed .app inside the .dmg going out on a public GitHub Release.
# build-macos-production.sh now refuses to ever leave one of those in
# $OUT_DIR (nb_verify_app_signature, added for issue #187), which makes this
# guard redundant against anything that script just produced. It is NOT
# redundant against $OUT_DIR being stale in the one way guard 6 cannot see:
# a .app that predates that fix and has simply never been rebuilt since. This
# is the check that would have caught the six adhoc-signed builds issue #187
# describes, run at the one point that actually gates a public download.
nb_say "guard: $(basename "$APP_SRC") is signed with \"$SIGNING_AUTHORITY\" as \"$BUNDLE_ID\""
if [ ! -e "$APP_SRC" ]; then
  _abort "$APP_SRC does not exist — build it first: re-run with --build, or run scripts/build-macos-production.sh yourself."
fi
if ! nb_verify_app_signature "$APP_SRC" "$SIGNING_AUTHORITY" "$BUNDLE_ID"; then
  _abort "$APP_SRC is not correctly signed (see codesign output above) — this is precisely the failure issue #187 describes. Rebuild with scripts/build-macos-production.sh (after confirming ./scripts/setup-signing.sh if that build's preflight flags the signing identity) and re-run."
fi
nb_say "  Authority=$NB_VERIFIED_AUTHORITY Identifier=$NB_VERIFIED_IDENTIFIER"

# ---------------------------------------------------------------------------
# Stage under public names, then upload.
# ---------------------------------------------------------------------------
# Staged in a mktemp -d, never renamed inside build/production/ itself — the
# build scripts own the names in that directory (nb_publish's whole job is
# writing them), and a publish script reaching back in to rename its inputs
# is exactly the kind of two-owners-one-file problem that leads to a build
# script's next run silently "fixing" a name this script depends on, or vice
# versa.
nb_say "staging assets"
STAGE_DIR=$(mktemp -d)
trap 'rm -rf "$STAGE_DIR"' EXIT

APK_ASSET="$STAGE_DIR/meologue_${VERSION}.apk"
cp -p "$APK_SRC" "$APK_ASSET"
printf '  %s\n' "$APK_ASSET"

# The APK gets no arch suffix — this is deliberate, not an oversight to make
# consistent with the .dmg. apps/android/app/build.gradle configures no ABI
# splits, so `assembleRelease` already emits exactly one universal APK
# covering every Android ABI; there is no second arch-specific APK it could
# be confused with. The .dmg carries `_aarch64` because Tauri builds for the
# host architecture only, and an Intel Mac's build of the same version would
# produce a differently-named file sitting right next to this one.
DMG_ASSET="$STAGE_DIR/$DMG_BASENAME"
cp -p "$DMG_SRC" "$DMG_ASSET"
printf '  %s\n' "$DMG_ASSET"

# One static caveats file, edited in one place when the caveats themselves
# change, rather than retyped (and inevitably drifting) into every Release's
# notes by hand. `gh release create --notes-file` PREPENDS this content above
# `--generate-notes`'s own changelog — verified against this gh install
# (2.97.0) before writing the combination below, so no version guard on gh
# itself is needed for this behaviour specifically.
NOTES="$STAGE_DIR/release-notes.md"
cp "$PREAMBLE" "$NOTES"

# NOT marked --prerelease, and that is a deliberate reversal of the original
# design decision — recorded here because the reasoning for the flag still
# sounds right in the abstract and someone will be tempted to add it back.
#
# `--prerelease` is semver-honest about a 0.x version carrying no compatibility
# promise. What it also does, which is not obvious until you watch it happen, is
# make the Release INVISIBLE where people actually look for it. GitHub's repo
# sidebar only ever shows the latest NON-prerelease release, so the homepage
# said "1 tag / Create a new release" with a published Release sitting right
# there. Worse, /releases/latest does not resolve to a prerelease at all: the
# REST endpoint answers 404 and the browser URL redirects to the bare /releases
# list. That is the exact URL README.md hands people as the download link, so
# the flag silently broke the one path this whole script exists to create.
#
# The honesty the flag bought was worth less than the discoverability it cost,
# for a project whose Releases are how anyone installs without a toolchain. If
# a future version genuinely needs to ship un-advertised — a real release
# candidate — pass --prerelease by hand for that one, and expect it to be
# absent from both the sidebar and /releases/latest.

# --target is NOT optional here, and leaving it off is a silent, serious bug.
# `gh release create` documents that when the tag does not already exist, "one
# will automatically get created from the latest state of the default branch"
# — origin/main's tip, NOT local HEAD. Every guard above vets HEAD: the tree is
# clean at HEAD, the version sites agree at HEAD, the artifacts are no older
# than HEAD's commit. If origin/main has moved on (someone else pushed, or this
# is being published from a branch), gh would tag a commit that none of those
# guards ever looked at, and the Release would carry artifacts built from a
# different tree than the tag claims. Pinning the resolved SHA makes the commit
# the guards checked and the commit the tag names the same commit by
# construction. Guard 2 above is what makes this SHA fetchable by origin.
#
# This assignment was deleted once already, which is why it is worth saying so
# here. The #176 follow-up that removed the `--prerelease` block immediately
# above rewrote this whole region and took the assignment with it, leaving the
# `--target "$HEAD_SHA"` reference below with nothing to read. Under `set -u`
# that aborts the script — on the real publish path exactly as on the dry-run
# one, since GH_ARGS is built before the two diverge — so no Release has been
# publishable since 2026-09-02, and nobody noticed because none was attempted.
# Keep the assignment adjacent to its own reasoning, and to the array that
# reads it.
HEAD_SHA=$(git rev-parse HEAD)

GH_ARGS=(release create "v$VERSION" --title "v$VERSION" \
  --target "$HEAD_SHA" \
  --notes-file "$NOTES" --generate-notes \
  "$APK_ASSET" "$DMG_ASSET")

if [ "$DRY_RUN" = 1 ]; then
  nb_say "dry run — no tag, no Release, no upload"
  printf '\nstaged assets:\n'
  printf '  %s\n' "$APK_ASSET" "$DMG_ASSET" "$NOTES"
  printf '\nwould run:\n  gh'
  printf ' %q' "${GH_ARGS[@]}"
  printf '\n'
  exit 0
fi

nb_say "creating GitHub Release v$VERSION"
gh "${GH_ARGS[@]}"

RELEASE_URL=$(gh release view "v$VERSION" --json url --template '{{.url}}')

cat <<NEXT

Release v$VERSION is published:
  $RELEASE_URL

Attached:
  $(basename "$APK_ASSET")
  $(basename "$DMG_ASSET")

The release notes lead with $PREAMBLE's caveats (unsigned/unnotarized macOS,
self-signed Android, no auth, sync opt-in), followed by gh's own generated
changelog since the previous tag.

Nothing here was pushed as a git tag until 'gh release create' ran above —
git fetch to see v$VERSION locally: git fetch origin --tags
NEXT
