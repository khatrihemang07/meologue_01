# Prerequisite checks, shared by every scripts/run-* and scripts/build-* entry point.
# Sourced, never executed.
#
# Why this exists at all: until now every one of these scripts' steps failed at
# the point of use, in the vocabulary of whatever tool happened to notice — a
# Gradle stack trace for a missing keystore, an opaque Compose bind error for a
# native Postgres already on :5432, and worst of the set, a Reflection call
# returning connection-refused at runtime because a configured local model was
# never actually started. That last one has its own commit (be3836e, "Note that
# a local Reflection/embedding endpoint must be running, not just configured")
# and was still only a sentence in the README.
#
# Two properties make this worth a library rather than a few inline `command -v`
# calls:
#
#   1. Checks ACCUMULATE. Nothing exits on the first problem, so one run tells
#      you everything to fix instead of making you rediscover the list one
#      restart at a time. preflight_report prints the collected fix-up commands
#      at the end and only then exits non-zero.
#
#   2. `fail` and `warn` mean different things, and the split is load-bearing.
#      A fail blocks the job. A warn does not, because plenty of this stack is
#      genuinely optional: an unreachable chat endpoint costs you Reflection and
#      Digest and nothing else — Sync, Search, Export and the app itself are
#      unaffected — so refusing to start the server over it would be wrong.
#
# Every check function returns 0 no matter what it finds. The callers run under
# `set -e`, and a check reporting a problem must not itself abort the script
# before preflight_report gets to summarise.

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

if [ -t 1 ]; then
  _C_OFF=$'\033[0m'; _C_DIM=$'\033[2m'; _C_RED=$'\033[31m'
  _C_YEL=$'\033[33m'; _C_GRN=$'\033[32m'; _C_BLD=$'\033[1m'
  _C_CYA=$'\033[36m'; _C_MAG=$'\033[35m'; _C_BLU=$'\033[34m'
else
  _C_OFF=; _C_DIM=; _C_RED=; _C_YEL=; _C_GRN=; _C_BLD=
  _C_CYA=; _C_MAG=; _C_BLU=
fi

PREFLIGHT_FAILS=0
PREFLIGHT_WARNS=0
PREFLIGHT_FIXES=()

pf_ok()   { printf '  %sok  %s %-20s %s\n' "$_C_GRN" "$_C_OFF" "$1" "$2"; return 0; }
pf_info() { printf '  %s--   %-20s %s%s\n' "$_C_DIM" "$1" "$2" "$_C_OFF"; return 0; }

pf_warn() {
  PREFLIGHT_WARNS=$((PREFLIGHT_WARNS + 1))
  printf '  %swarn%s %-20s %s\n' "$_C_YEL" "$_C_OFF" "$1" "$2"
  if [ -n "${3:-}" ]; then PREFLIGHT_FIXES[${#PREFLIGHT_FIXES[@]}]="warn|$1|$3"; fi
  return 0
}

pf_fail() {
  PREFLIGHT_FAILS=$((PREFLIGHT_FAILS + 1))
  printf '  %sFAIL%s %-20s %s\n' "$_C_RED" "$_C_OFF" "$1" "$2"
  if [ -n "${3:-}" ]; then PREFLIGHT_FIXES[${#PREFLIGHT_FIXES[@]}]="fail|$1|$3"; fi
  return 0
}

preflight_begin() {
  PREFLIGHT_FAILS=0
  PREFLIGHT_WARNS=0
  PREFLIGHT_FIXES=()
  printf '%s--- preflight: %s ---%s\n' "$_C_BLD" "$1" "$_C_OFF"
  return 0
}

# Prints the collected fix-up commands and exits non-zero if anything failed.
preflight_report() {
  local entry kind what fix
  if [ "${#PREFLIGHT_FIXES[@]}" -gt 0 ]; then
    printf '\n'
    for entry in "${PREFLIGHT_FIXES[@]}"; do
      kind=${entry%%|*}
      what=${entry#*|}; what=${what%%|*}
      fix=${entry#*|}; fix=${fix#*|}
      if [ "$kind" = fail ]; then
        printf '  %sfix%s  %-20s %s\n' "$_C_RED" "$_C_OFF" "$what" "$fix"
      else
        printf '  %shint%s %-20s %s\n' "$_C_YEL" "$_C_OFF" "$what" "$fix"
      fi
    done
  fi

  if [ "$PREFLIGHT_FAILS" -gt 0 ]; then
    printf '\n%s%s check(s) failed — not starting.%s\n' "$_C_RED" "$PREFLIGHT_FAILS" "$_C_OFF" >&2
    exit 1
  fi
  if [ "$PREFLIGHT_WARNS" -gt 0 ]; then
    printf '\n%s%s warning(s) — continuing.%s\n' "$_C_YEL" "$PREFLIGHT_WARNS" "$_C_OFF"
  fi
  printf '\n'
  return 0
}

# ---------------------------------------------------------------------------
# Shared: the JS toolchain every script needs
# ---------------------------------------------------------------------------

check_node() {
  local v major
  if ! command -v node >/dev/null 2>&1; then
    pf_fail node "not on PATH" "brew install node"
    return 0
  fi
  v=$(node -v 2>/dev/null)
  major=${v#v}; major=${major%%.*}
  case $major in
    ''|*[!0-9]*) pf_warn node "unrecognised version '$v'" "" ;;
    *)
      if [ "$major" -lt 22 ]; then
        pf_fail node "$v — package.json engines wants >= 22" "brew upgrade node"
      else
        pf_ok node "$v"
      fi
      ;;
  esac
  return 0
}

check_pnpm() {
  if ! command -v pnpm >/dev/null 2>&1; then
    pf_fail pnpm "not on PATH" "corepack enable pnpm"
    return 0
  fi
  pf_ok pnpm "$(pnpm -v 2>/dev/null)"
  # Both, not just the root: pnpm workspaces symlink per package, and a
  # half-installed tree fails much later inside a vite or tsc invocation.
  if [ ! -d node_modules ] || [ ! -d apps/web/node_modules ]; then
    pf_fail dependencies "node_modules incomplete" "pnpm install"
  else
    pf_ok dependencies "installed"
  fi
  return 0
}

check_cargo() {
  if ! command -v cargo >/dev/null 2>&1; then
    pf_fail cargo "not on PATH" "install Rust: https://rustup.rs"
    return 0
  fi
  pf_ok cargo "$(cargo -V 2>/dev/null | cut -d' ' -f2)"
  return 0
}

# ---------------------------------------------------------------------------
# Docker and Postgres
# ---------------------------------------------------------------------------

check_docker() {
  local server
  if ! command -v docker >/dev/null 2>&1; then
    pf_fail docker "not on PATH" "install Docker Desktop, or: brew install colima docker"
    return 0
  fi
  # Asking for the *server* version is what separates "CLI missing" from the
  # far more common "CLI fine, daemon not running" — which otherwise surfaces
  # as a socket error from whichever compose subcommand ran first.
  if ! server=$(docker version --format '{{.Server.Version}}' 2>/dev/null) || [ -z "$server" ]; then
    pf_fail docker "CLI present, daemon not responding" "open -a Docker   # or: colima start"
    return 0
  fi
  pf_ok docker "engine $server"
  if ! docker compose version >/dev/null 2>&1; then
    pf_fail "docker compose" "v2 plugin not available" "install the Compose plugin (Docker Desktop ships it)"
  fi
  return 0
}

# A host port that must be free before a child tries to bind it. Reporting the
# holder here turns "Address already in use" into something actionable — most
# often it is this same script still running in another terminal.
check_port_free() {
  local port=$1 label=$2 pids first holder
  pids=$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -z "$pids" ]; then
    pf_ok "port $port" "free — $label"
    return 0
  fi
  first=$(printf '%s\n' "$pids" | head -1)
  holder=$(ps -o comm= -p "$first" 2>/dev/null || echo '?')
  pids=$(printf '%s' "$pids" | tr '\n' ' ')
  pf_fail "port $port" "held by ${holder##*/} (pid ${pids% }) — $label" "kill ${pids% }"
  return 0
}

# The database ports are different: Compose is *expected* to be holding them.
# A conflict here is almost always a native Postgres (brew services) sitting on
# 5432, which turns into an opaque bind failure inside `compose up`.
check_db_port_free() {
  local port=$1 container=$2 pids first holder
  pids=$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -z "$pids" ]; then
    pf_ok "port $port" "free — $container will bind it"
    return 0
  fi
  if docker ps --filter "name=^${container}$" --format '{{.Ports}}' 2>/dev/null | grep -q ":$port->"; then
    pf_ok "port $port" "$container"
    return 0
  fi
  first=$(printf '%s\n' "$pids" | head -1)
  holder=$(ps -o comm= -p "$first" 2>/dev/null || echo '?')
  pf_fail "port $port" "held by ${holder##*/}, not $container" "stop it — e.g. brew services stop postgresql@18"
  return 0
}

# Starts the instance's Postgres and proves it is actually accepting
# connections. Naming the service explicitly is what makes Compose start
# postgres-sandbox despite its `sandbox` profile.
ensure_postgres() {
  local service=$1 container=$2
  if ! docker compose up -d --wait "$service" >/dev/null 2>&1; then
    pf_fail postgres "compose could not bring up '$service'" "docker compose up -d --wait $service   # to see the error"
    return 0
  fi
  if docker exec "$container" pg_isready -U meologue -d meologue >/dev/null 2>&1; then
    pf_ok postgres "$container accepting connections"
  else
    pf_fail postgres "$container is up but not accepting connections" "docker logs $container"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# The local LLM endpoints
# ---------------------------------------------------------------------------

# Resolves one MEOLOGUE_* variable exactly the way the server does, because a
# preflight that reports on configuration the server will never read is worse
# than no preflight. Two steps, and both matter:
#
#   1. PRESENCE, NOT EMPTINESS, decides whether server/.env is consulted.
#      dotenvy's load() sets a key only `if env::var(&key).is_err()`
#      (dotenvy-0.15.7/src/iter.rs:34), and env::var on a set-but-empty variable
#      returns Ok("") rather than an error. So an exported
#      `MEOLOGUE_CHAT_BASE_URL=` keeps server/.env from being consulted at all.
#      `${VAR:-}` would conflate that with unset and go read .env for a value
#      the server never sees — which is exactly the bug this shape avoids.
#   2. The server then treats the empty string as unconfigured:
#      LlmConfig::from_env does `.ok().filter(|value| !value.is_empty())`
#      (server/src/llm.rs). Returning "" here therefore lands on the
#      "not configured" branch below, which is the right answer.
_env_or_dotenv() {
  local name=$1 val=
  if eval "[ -n \"\${$name+is_set}\" ]"; then
    eval "val=\$$name"
    printf '%s' "$val"
    return 0
  fi
  if [ -f server/.env ]; then
    val=$(sed -n "s/^[[:space:]]*${name}=//p" server/.env | tail -1)
    # Strip one layer of surrounding quotes, as dotenvy does.
    val=${val%\"}; val=${val#\"}
    val=${val%\'}; val=${val#\'}
    printf '%s' "$val"
  fi
  return 0
}

_llm_fix_for() {
  case $1 in
    *:11434*) printf 'brew services start ollama   # or: ollama serve' ;;
    *)        printf 'start whatever serves %s, then re-run' "$1" ;;
  esac
  return 0
}

# Checks one of the two OpenAI-compatible endpoints. WARN-ONLY BY DESIGN: an
# absent or unreachable model costs Reflection and Digest and nothing else —
# capture, Sync, Search, editing and Export are all untouched (server/src/lib.rs
# simply never registers /v1/reflect or /v1/sessions), so refusing to start over
# it would be wrong. But "configured and not running" is a silent failure that
# only shows up as connection-refused inside a Reflection call, which is exactly
# what commit be3836e had to document, so it gets said out loud here instead.
check_llm_endpoint() {
  local kind=$1 base model label body code json ids
  case $kind in
    chat)
      base=$(_env_or_dotenv MEOLOGUE_CHAT_BASE_URL)
      model=$(_env_or_dotenv MEOLOGUE_CHAT_MODEL)
      label="Reflection and Digest"
      ;;
    embed)
      base=$(_env_or_dotenv MEOLOGUE_EMBED_BASE_URL)
      model=$(_env_or_dotenv MEOLOGUE_EMBED_MODEL)
      label="Reflection retrieval"
      ;;
    *) return 0 ;;
  esac

  if [ -z "$base" ]; then
    pf_info "$kind endpoint" "not configured — $label stay off"
    return 0
  fi

  if ! body=$(curl -sS -m 4 -w $'\n%{http_code}' "${base%/}/models" 2>/dev/null); then
    pf_warn "$kind endpoint" "$base unreachable — $label will fail at call time" "$(_llm_fix_for "$base")"
    return 0
  fi
  code=$(printf '%s' "$body" | tail -1)
  json=$(printf '%s' "$body" | sed '$d')
  if [ "$code" != "200" ]; then
    pf_warn "$kind endpoint" "$base answered HTTP $code — $label will fail at call time" "check that endpoint's own logs"
    return 0
  fi

  if [ -z "$model" ]; then
    pf_warn "$kind model" "$base is up but no model is configured" "set MEOLOGUE_$(echo "$kind" | tr '[:lower:]' '[:upper:]')_MODEL in server/.env"
    return 0
  fi

  # Ollama reports ids tagged ("harrier-270m:latest") while server/.env names
  # them bare ("harrier-270m") and Ollama resolves :latest itself. A plain
  # string compare would cry wolf on a config that works, so accept both.
  ids=$(printf '%s' "$json" | tr ',' '\n' | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  if printf '%s\n' "$ids" | grep -Fxq -e "$model" -e "$model:latest"; then
    pf_ok "$kind endpoint" "$base — $model"
  else
    pf_warn "$kind model" "'$model' is not served by $base" "available there: $(printf '%s' "$ids" | tr '\n' ' ')"
  fi
  return 0
}

check_llm_config() {
  if [ ! -f server/.env ]; then
    pf_info "server/.env" "absent — Reflection and Digest stay off (cp server/.env.example server/.env)"
  fi
  check_llm_endpoint chat
  check_llm_endpoint embed
  return 0
}

# ---------------------------------------------------------------------------
# Android
# ---------------------------------------------------------------------------

check_java() {
  local raw major
  if ! command -v java >/dev/null 2>&1; then
    pf_fail java "not on PATH" "brew install openjdk@21"
    return 0
  fi
  raw=$(java -version 2>&1 | head -1)
  major=$(printf '%s' "$raw" | sed -n 's/.*version "\([0-9][0-9]*\).*/\1/p')
  [ -z "$major" ] && major=0
  # apps/android/app/capacitor.build.gradle pins source/targetCompatibility to
  # VERSION_21, so anything older fails during compilation rather than here.
  if [ "$major" -lt 21 ]; then
    pf_fail java "$raw — Capacitor pins Java 21" "brew install openjdk@21"
  else
    pf_ok java "$raw"
  fi
  # Deliberately not a failure. JAVA_HOME is unset on the machine this was
  # written on and /usr/libexec/java_home cannot even see the Homebrew JDK, yet
  # Gradle builds fine off the java on PATH. The README used to list JAVA_HOME
  # as required; it is not.
  if [ -n "${JAVA_HOME:-}" ]; then
    pf_ok JAVA_HOME "$JAVA_HOME"
  else
    pf_info JAVA_HOME "unset — Gradle will use the java on PATH"
  fi
  return 0
}

check_android_sdk() {
  local sdk= compile
  if [ -f apps/android/local.properties ]; then
    sdk=$(sed -n 's/^sdk\.dir=//p' apps/android/local.properties | tail -1)
    # Gradle properties escape with backslashes; drop them.
    sdk=$(printf '%s' "$sdk" | sed 's/\\\(.\)/\1/g')
  fi
  [ -z "$sdk" ] && sdk=${ANDROID_HOME:-}
  [ -z "$sdk" ] && sdk=${ANDROID_SDK_ROOT:-}

  if [ -z "$sdk" ]; then
    pf_fail "android sdk" "no sdk.dir and no ANDROID_HOME" "echo 'sdk.dir=/opt/homebrew/share/android-commandlinetools' > apps/android/local.properties"
    return 0
  fi
  if [ ! -d "$sdk" ]; then
    pf_fail "android sdk" "$sdk does not exist" "brew install --cask android-commandlinetools, then fix apps/android/local.properties"
    return 0
  fi
  pf_ok "android sdk" "$sdk"

  compile=$(sed -n 's/.*compileSdkVersion[^0-9]*\([0-9][0-9]*\).*/\1/p' apps/android/variables.gradle 2>/dev/null | head -1)
  if [ -n "$compile" ]; then
    if [ -d "$sdk/platforms/android-$compile" ]; then
      pf_ok "android platform" "android-$compile"
    else
      # Gradle can fetch it, but only with licences already accepted — and the
      # failure when they are not is a wall of Gradle output.
      pf_warn "android platform" "android-$compile not installed" "sdkmanager 'platforms;android-$compile' && sdkmanager --licenses"
    fi
  fi
  return 0
}

check_gradlew() {
  local version
  if [ ! -x apps/android/gradlew ]; then
    pf_fail gradlew "apps/android/gradlew missing or not executable" "chmod +x apps/android/gradlew"
    return 0
  fi
  version=$(sed -n 's/.*gradle-\([0-9][0-9.]*\)-.*\.zip.*/\1/p' apps/android/gradle/wrapper/gradle-wrapper.properties 2>/dev/null | head -1)
  pf_ok gradlew "${version:-wrapper present}"
  return 0
}

check_adb() {
  # Only needed to install the APK afterwards, never to build it.
  if command -v adb >/dev/null 2>&1; then
    pf_ok adb "$(command -v adb)"
  else
    pf_info adb "not on PATH — the build works, installing the APK will not"
  fi
  return 0
}

check_android_release_signing() {
  local props=apps/android/keystore.properties store
  if [ ! -f "$props" ]; then
    pf_fail "release keystore" "$props missing" "./scripts/setup-signing.sh"
    return 0
  fi
  store=$(sed -n 's/^storeFile=//p' "$props" | tail -1)
  if [ -z "$store" ] || [ ! -f "$store" ]; then
    # setup-signing.sh warns about the opposite case (keystore present,
    # properties missing). This one — properties pointing at a keystore that
    # has been deleted — produces a much worse Gradle error.
    pf_fail "release keystore" "keystore.properties points at a missing file: ${store:-<empty>}" "rm $props && ./scripts/setup-signing.sh"
    return 0
  fi
  pf_ok "release keystore" "$store"
  return 0
}

# ---------------------------------------------------------------------------
# macOS / Tauri
# ---------------------------------------------------------------------------

check_tauri_cli() {
  local v
  if ! v=$(cargo tauri --version 2>/dev/null); then
    pf_fail "tauri cli" "not installed" "cargo install tauri-cli --version \"^2\""
    return 0
  fi
  case $v in
    *\ 2.*) pf_ok "tauri cli" "$v" ;;
    *)      pf_fail "tauri cli" "$v — this project is Tauri v2" "cargo install tauri-cli --version \"^2\"" ;;
  esac
  return 0
}

check_xcode_clt() {
  local path
  if ! path=$(xcode-select -p 2>/dev/null) || [ -z "$path" ]; then
    pf_fail "xcode clt" "not installed — cargo cannot link" "xcode-select --install"
    return 0
  fi
  pf_ok "xcode clt" "$path"
  return 0
}

check_macos_signing() {
  local keychain="$HOME/Library/Keychains/meologue-signing.keychain-db"
  # Without -v on purpose. setup-signing.sh's own output says it: `-v` reports
  # 0 identities for a self-signed certificate like this one, while codesign
  # uses it fine either way.
  if security find-identity -p codesigning 2>/dev/null | grep -q 'meologue Dev'; then
    pf_ok "signing identity" "meologue Dev"
  else
    pf_fail "signing identity" "'meologue Dev' not in any keychain" "./scripts/setup-signing.sh"
    return 0
  fi
  if [ -f "$keychain" ] && ! security list-keychains 2>/dev/null | grep -q 'meologue-signing'; then
    pf_warn "signing keychain" "exists but is not in the search list" "security list-keychains -d user -s \"\$HOME/Library/Keychains/login.keychain-db\" \"$keychain\""
  fi
  return 0
}
