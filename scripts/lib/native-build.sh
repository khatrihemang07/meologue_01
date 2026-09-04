# Shared body for scripts/build-{android,macos}-{production,sandbox}.sh.
# Sourced, never executed.
#
# The four callers are one build pipeline (web bundle -> platform build ->
# report the artifact) repeated across two axes, platform and instance, so
# what belongs here is only the parts that do not vary across BOTH axes:
# argument parsing, the step-echo style, and the artifact report. The actual
# build commands stay in each script — `./gradlew assembleRelease` vs
# `assembleSandbox`, `cargo tauri build` vs `... --config tauri.sandbox.conf.json`
# — because collapsing those into a parameterised helper here would just move
# the four-way branch from four short scripts into one longer one, for no
# reader's benefit.
#
# preflight_begin/check_*/preflight_report come from scripts/lib/preflight.sh,
# which every caller sources before this file.

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

# The colour palette lives in preflight.sh, which every caller sources first.
# Saying so out loud, and failing here with a sentence rather than 40 lines
# later with `_C_OFF: unbound variable`, is the whole point of this line.
# `?` and not `:?` — the palette is deliberately EMPTY when stdout is not a
# terminal, and `:?` fires on empty as well as unset, which would abort every
# redirected run (`./scripts/run-production.sh > log`). Unset is the only
# condition worth failing on.
: "${_C_OFF?scripts/lib/preflight.sh must be sourced before native-build.sh}"

# One line per major step, in this repo's `--- doing a thing ---` voice
# (scripts/seed-sandbox.sh, scripts/e2e.sh) rather than run-instance.sh's
# `[ * ]` tag — these scripts run once start-to-finish and print a report at
# the end, they do not interleave two long-lived child processes, so there is
# nothing here for a tag to disambiguate.
nb_say() { printf '%s--- %s ---%s\n' "$_C_BLU" "$1" "$_C_OFF"; return 0; }

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

# Every caller accepts exactly the same two flags, so the loop lives here.
# The usage text does not — each caller's is one line longer than the others
# (a different port, a different app identifier) and a shared usage string
# would need its own branching to say the right thing, which is exactly the
# kind of overlap this file is supposed to avoid taking on.
#
# Usage: nb_parse_args <usage-function-name> "$@"
# Sets NB_SKIP_PREFLIGHT on return; exits 0 on -h/--help (after printing
# usage) and exits 2 on an unrecognised option (usage to stderr), matching
# run-instance.sh's _ri_usage handling.
nb_parse_args() {
  local usage_fn=$1 arg
  shift
  NB_SKIP_PREFLIGHT=0
  for arg in "$@"; do
    case $arg in
      --no-preflight) NB_SKIP_PREFLIGHT=1 ;;
      -h|--help)      "$usage_fn"; exit 0 ;;
      *)
        printf 'unknown option: %s\n\n' "$arg" >&2
        "$usage_fn" >&2
        exit 2
        ;;
    esac
  done
  return 0
}

# ---------------------------------------------------------------------------
# Artifact report
# ---------------------------------------------------------------------------

# Resolves the .dmg Tauri just wrote for one product name. The file name carries
# both the version and the host architecture — meologue_0.2.0_aarch64.dmg — and
# hardcoding either turns a perfectly SUCCESSFUL build into a "expected build
# artifact not found" failure the moment tauri.conf.json's version is bumped, or
# the moment anyone builds on an Intel Mac. Neither is a hypothetical: the
# version in apps/macos/tauri.conf.json is the one thing here guaranteed to
# change again.
#
# `meologue_*` cannot collide with `meologue-sandbox_*` — the character after
# the product name is `_` in one and `-` in the other -- so each variant matches
# only its own. Newest first, in case an older version's disk image is still
# lying around from a previous build.
#
# RETURNS non-zero rather than calling exit, and callers must assign it on its
# own line — `DMG=$(nb_find_dmg ...)`. An `exit` here would be dead code: this
# runs inside a command substitution, so it would end only that subshell, the
# caller would carry on with an empty path, and the user would get a second and
# far more confusing "expected build artifact not found at " with nothing after
# the "at". Under `set -e` a failing assignment from a substitution aborts the
# script for real, which is what was wanted.
#
# Usage: DMG=$(nb_find_dmg <dir> <product-name>)
nb_find_dmg() {
  local dir=$1 product=$2 newest
  newest=$(ls -1t "$dir/${product}"_*.dmg 2>/dev/null | head -1)
  if [ -z "$newest" ]; then
    printf 'error: no %s_*.dmg in %s\n' "$product" "$dir" >&2
    printf 'the build reported success but wrote no disk image there.\n' >&2
    return 1
  fi
  printf '%s' "$newest"
  return 0
}

# ---------------------------------------------------------------------------
# Collecting artifacts
# ---------------------------------------------------------------------------

# Copies a finished artifact to `build/<instance>/`, so the things you actually
# install sit two directories deep instead of six, and the two instances'
# outputs cannot be mistaken for each other.
#
# It also quietly fixes the .dmg collision documented in
# build-macos-production.sh: Tauri clears target/release/bundle/dmg/ on every
# run, so only the most recently built variant's disk image survives *there* —
# but each one is copied out before the next build can remove it, so
# build/production/ and build/sandbox/ end up holding both.
#
# `/build/` is gitignored, anchored to the repo root: an unanchored `build/`
# would also match apps/android/build/ and apps/android/app/build/, which are
# Gradle's and are already handled by their own ignore rules.
#
# Usage: nb_publish <src> <dest-dir> <dest-name>
nb_publish() {
  local src=$1 dest_dir=$2 name=$3 dest
  dest="$dest_dir/$name"
  mkdir -p "$dest_dir"
  # rm -rf first, and it matters for the .app case specifically: a bundle is a
  # directory, so copying over an older one MERGES them, leaving files from a
  # previous build inside a bundle that now claims to be this one.
  rm -rf "$dest"
  case $src in
    *.app)
      # ditto, not `cp -R`. It is the macOS-native bundle copy and preserves the
      # extended attributes and permission bits the code signature is verified
      # against; a bundle that stops passing `codesign -v` because of how it was
      # copied is worse than not copying it at all.
      ditto "$src" "$dest"
      ;;
    *)
      cp -p "$src" "$dest"
      ;;
  esac
  printf '  %s\n' "$dest"
  return 0
}

# ---------------------------------------------------------------------------
# Artifact report
# ---------------------------------------------------------------------------

# Fails loudly rather than letting a missing artifact surface later as a
# confusing `adb install` or `codesign` error against a path that was never
# written. `du -sh` (not a bare `du -h`) matters for the macOS .app case: du
# on a directory without -s walks every subdirectory and prints one line per
# entry, and only -s collapses that to the single total this report wants.
#
# Usage: nb_report_artifact <path> [<label> <value>]...
# Any number of label/value pairs may follow the path — the macOS callers
# pass two (authority, identifier; see nb_verify_app_signature) where the
# Android caller passes one (identifier). Nothing here reads the values
# it prints; it only ever prints what a caller already knows or already
# verified. Passing an *expected* value here rather than one actually read
# off the artifact was exactly the false reassurance issue #187 is about —
# see nb_verify_app_signature for the check that reads the real thing.
nb_report_artifact() {
  local path=$1
  shift
  if [ ! -e "$path" ]; then
    printf 'error: expected build artifact not found at %s\n' "$path" >&2
    printf 'the build reported success but produced nothing there — check the tool output above.\n' >&2
    exit 1
  fi
  printf '\n--- artifact ---\n'
  printf 'path:        %s\n' "$path"
  printf 'size:        %s\n' "$(du -sh "$path" | cut -f1)"
  while [ "$#" -ge 2 ]; do
    printf '%s: %s\n' "$1" "$2"
    shift 2
  done
  return 0
}

# ---------------------------------------------------------------------------
# Signature verification (macOS)
# ---------------------------------------------------------------------------

# Reads codesign's own opinion of a built .app rather than trusting that its
# existence, or `cargo tauri build`'s exit code, says anything about whether
# it was signed with THIS project's identity. Issue #187: codesign failed
# with errSecInternalComponent (see nb_diagnose_tauri_failure below), Tauri's
# bundler fell back to an adhoc signature rather than treating that as fatal,
# `cargo tauri build` exited non-zero for what the build scripts assumed was
# the unrelated .dmg step, and an adhoc-signed .app carrying a generated
# identifier (`meologue-166e81fce17d0f09`, not `com.meologue.app.sandbox`)
# published clean. macOS runs adhoc-signed apps locally with no warning at
# all, so nothing surfaced it for six builds.
#
# Two codesign facts distinguish a real signature from that fallback, and
# both are checked because either alone can lie:
#
#   Authority=<name>   Present only on a signature made with an identity
#                       codesign actually found usable. Adhoc signing prints
#                       `Signature=adhoc` instead and omits Authority=
#                       entirely — there is no partial or malformed Authority
#                       line to accidentally match, so its absence alone is
#                       already the tell.
#   Identifier=<id>    The CFBundleIdentifier when signed properly. Under an
#                       adhoc fallback this becomes a generated
#                       `<product>-<16 hex chars>` instead, because no
#                       identity was available to bind the requested one to.
#                       ADR 0029 relies on this exact string as the entire
#                       isolation mechanism between the Production and
#                       Sandbox installs, so a mismatch here is not cosmetic.
#
# `codesign --verify --strict` is the other half: a bundle could in principle
# carry a correct Authority/Identifier pair from a stale or partially-copied
# signature and still not verify structurally (e.g. contents changed after
# signing), so both the content check and the structural check must pass.
#
# Sets NB_VERIFIED_AUTHORITY and NB_VERIFIED_IDENTIFIER to what was actually
# read, for the caller to report — see nb_report_artifact.
#
# Usage: nb_verify_app_signature <app-path> <expected-authority> <expected-identifier>
nb_verify_app_signature() {
  local app=$1 want_authority=$2 want_identifier=$3 info authority identifier
  if ! info=$(codesign -dv --verbose=4 "$app" 2>&1); then
    printf 'error: codesign could not read a signature from %s at all:\n' "$app" >&2
    printf '%s\n' "$info" | sed 's/^/  /' >&2
    return 1
  fi

  authority=$(printf '%s\n' "$info" | sed -n 's/^Authority=//p' | head -1)
  identifier=$(printf '%s\n' "$info" | sed -n 's/^Identifier=//p' | head -1)

  if [ -z "$authority" ]; then
    printf 'error: %s is ADHOC-SIGNED, not signed with "%s" — it has no Authority= line.\n' "$app" "$want_authority" >&2
    printf '  identifier read off the bundle: %s\n' "${identifier:-<none>}" >&2
    printf '  fix: ./scripts/setup-signing.sh, then rebuild.\n' >&2
    return 1
  fi
  if [ "$authority" != "$want_authority" ]; then
    printf 'error: %s is signed by "%s", not the expected "%s".\n' "$app" "$authority" "$want_authority" >&2
    return 1
  fi
  if [ "$identifier" != "$want_identifier" ]; then
    printf 'error: %s carries identifier "%s", not the expected "%s".\n' "$app" "$identifier" "$want_identifier" >&2
    printf '  ADR 0029 relies on this identifier alone to keep Production and Sandbox data separate.\n' >&2
    return 1
  fi
  if ! codesign --verify --strict "$app" >/dev/null 2>&1; then
    printf 'error: %s reports Authority=%s and Identifier=%s but fails `codesign --verify --strict`.\n' "$app" "$authority" "$identifier" >&2
    return 1
  fi

  NB_VERIFIED_AUTHORITY=$authority
  NB_VERIFIED_IDENTIFIER=$identifier
  return 0
}

# Translates the one OSStatus this project has actually hit in the wild
# (issue #187) into a named cause and a named fix, instead of letting
# `errSecInternalComponent` reach the terminal as a bare code that means
# nothing without reading Apple's own Security framework source. It signals
# that the signing key scripts/setup-signing.sh imported is no longer usable
# without an interactive keychain prompt — empirically, this keychain lapses
# out of that state on its own after enough time or enough unrelated keychain
# activity — and `cargo tauri build`'s own bundler has no idea why codesign
# just failed, so it reports the same generic non-zero exit whether the cause
# was this or an unrelated .dmg failure. Grepping its captured output for the
# one string Apple actually prints is the only way to tell them apart short
# of reimplementing codesign's own error handling.
#
# Purely informational — always returns 0. The caller decides whether the
# build actually failed by checking the produced .app's signature
# (nb_verify_app_signature), not by whether this function found the string.
#
# Usage: nb_diagnose_tauri_failure <log-file>
nb_diagnose_tauri_failure() {
  local log=$1
  if [ -f "$log" ] && grep -q 'errSecInternalComponent' "$log" 2>/dev/null; then
    nb_say "diagnosis: codesign failed with errSecInternalComponent"
    nb_say "  The signing keychain has lapsed out of the state ./scripts/setup-signing.sh"
    nb_say "  establishes — its private key is no longer reachable without an interactive"
    nb_say "  prompt, which a non-interactive build can never answer, so codesign fails."
    nb_say "  Fix: ./scripts/setup-signing.sh   (safe to re-run — recreates only the macOS half)"
  fi
  return 0
}
