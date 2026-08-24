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

# Fails loudly rather than letting a missing artifact surface later as a
# confusing `adb install` or `codesign` error against a path that was never
# written. `du -sh` (not a bare `du -h`) matters for the macOS .app case: du
# on a directory without -s walks every subdirectory and prints one line per
# entry, and only -s collapses that to the single total this report wants.
#
# Usage: nb_report_artifact <path> <identifier-label> <identifier-value>
nb_report_artifact() {
  local path=$1 label=$2 identifier=$3
  if [ ! -e "$path" ]; then
    printf 'error: expected build artifact not found at %s\n' "$path" >&2
    printf 'the build reported success but produced nothing there — check the tool output above.\n' >&2
    exit 1
  fi
  printf '\n--- artifact ---\n'
  printf 'path:        %s\n' "$path"
  printf 'size:        %s\n' "$(du -sh "$path" | cut -f1)"
  printf '%s: %s\n' "$label" "$identifier"
  return 0
}
