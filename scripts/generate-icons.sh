#!/usr/bin/env bash
# Regenerates every icon asset in the repo from docs/brand/icon.svg.
#
# Pipeline:
#   1. Rasterize icon.svg into the two 1024 renders described in
#      docs/brand/ (tile.png, foreground.png), plus the working PNGs
#      @capacitor/assets needs (apps/web/assets/) and the PWA icons +
#      favicon (apps/web/public/).
#   2. Feed tile.png to `cargo tauri icon`, which writes the macOS icon
#      set into apps/macos/icons/.
#   3. Feed the apps/web/assets/ PNGs to @capacitor/assets, which writes
#      the Android mipmap densities, adaptive-icon XML, and splash set
#      into apps/android/app/src/main/res/.
#
# Not covered here (one-time source edits, not derived from icon.svg):
#   - apps/web/index.html's <title>
#
# Both third-party generators leave the tree dirtier than the icon change
# itself, so this script cleans up after them so the pipeline is idempotent
# (running it twice back to back produces byte-identical `git status`):
#   - `cargo tauri icon` writes android/ and ios/ icon trees into
#     apps/macos/icons/ even though this repo has no Tauri mobile target
#     (Android ships via Capacitor; there is no iOS app) — deleted below.
#   - `@capacitor/assets` rewrites AndroidManifest.xml purely for
#     formatting (XML declaration spacing, blank lines, self-closing tags)
#     while regenerating icons — it has no flag to leave the manifest
#     alone, so this script snapshots it first and restores the snapshot
#     after, which undoes the churn without discarding any real pending
#     edits to the file.
#   - `@capacitor/assets` has no CLI/config option to skip densities, so it
#     always emits mipmap-ldpi/ and drawable-{land,port}-ldpi/. minSdk is
#     24 (Android 7.0+), and no device on API 24+ resolves ldpi resources
#     (the lowest density bucket any real device can report is mdpi), so
#     those directories are dead weight — deleted below.
#
# Usage: ./scripts/generate-icons.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> Rasterizing docs/brand/icon.svg"
node scripts/generate-icon-pngs.mjs

echo "==> Generating macOS icon set (cargo tauri icon)"
(cd apps/macos && cargo tauri icon ../../docs/brand/tile.png)

echo "==> Removing Tauri's Android/iOS icon trees (no such targets in this repo)"
rm -rf apps/macos/icons/android apps/macos/icons/ios

MANIFEST="apps/android/app/src/main/AndroidManifest.xml"
MANIFEST_SNAPSHOT="$(mktemp)"
cp "$MANIFEST" "$MANIFEST_SNAPSHOT"

echo "==> Generating Android icon + splash set (@capacitor/assets)"
(cd apps/web && npx capacitor-assets generate --android --androidProject ../android --assetPath assets)

echo "==> Restoring AndroidManifest.xml (capacitor-assets only reformats it, no icon changes)"
cp "$MANIFEST_SNAPSHOT" "$MANIFEST"
rm -f "$MANIFEST_SNAPSHOT"

echo "==> Removing ldpi outputs (minSdk 24 never resolves ldpi resources)"
rm -rf \
  apps/android/app/src/main/res/mipmap-ldpi \
  apps/android/app/src/main/res/drawable-land-ldpi \
  apps/android/app/src/main/res/drawable-port-ldpi

echo "==> Done. Review generated files with git status/diff before committing."
