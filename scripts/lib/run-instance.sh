# The body of scripts/run-sandbox.sh.
# Sourced, never executed.
#
# Starts the Sandbox instance's backend and frontend together, hot-reload
# style: the Rust server on its own port and a Vite dev server proxying /v1 to
# it. Both streams are prefixed and interleaved into this one terminal, both
# PIDs are tracked, and Ctrl-C takes both down.
#
# Production no longer uses this file: it runs a frozen build (one process,
# no Vite, nothing watching the tree) instead of a hot-reload pair, so its
# machinery lives entirely in scripts/run-production.sh now.
#
# WHY THE PROCESS-GROUP DANCE BELOW EXISTS
#
# `cargo run` forks the meologue-server binary, and `pnpm` forks node, which
# forks esbuild. Killing the PID that `$!` reports therefore kills a wrapper and
# leaves the grandchild that actually holds :41207 or :5173 running — which is
# precisely the mess this script is meant to remove, not reproduce. So:
#
#   set -m                each `&` job becomes its own process group leader
#   cmd > >(filter) &     process substitution, so $! is cmd and not the filter
#                         (a plain `cmd | filter &` reports the filter's PID)
#   kill -TERM -- -$PID   a negative PID signals the whole group, grandchildren
#                         included
#
# Verified before this was written: with a wrapper-plus-grandchild stand-in,
# pgid == pid for the job and the group kill leaves zero survivors.
#
# Two consequences of `set -m` that are easy to miss:
#
#   - Children get `< /dev/null`. They are background process groups now, so a
#     child reading stdin (Vite watches for its shortcut keys) takes SIGTTIN and
#     suspends instead.
#   - Ctrl-C reaches only this script, not the children, because they are no
#     longer in the terminal's foreground process group. The trap forwarding
#     below is not belt-and-braces; it is the only thing that stops them.
#
# scripts/run-sandbox.sh sets: INSTANCE, COMPOSE_SERVICE, CONTAINER, DB_PORT,
# SERVER_PORT, VITE_PORT, DATABASE_URL, STATIC_DIR, WEB_BUILD_SCRIPT, WEB_DIST.

# Palette from preflight.sh, which every caller sources first. Named here so a
# future reordering fails with this sentence instead of `_C_CYA: unbound
# variable` from inside a printf.
# `?` and not `:?` — the palette is deliberately EMPTY when stdout is not a
# terminal, and `:?` fires on empty as well as unset, which would abort every
# redirected run (`./scripts/run-production.sh > log`). Unset is the only
# condition worth failing on.
: "${_C_OFF?scripts/lib/preflight.sh must be sourced before run-instance.sh}"

SRV_PID=
WEB_PID=

_ri_usage() {
  cat <<USAGE
usage: $0 [--bundle] [--no-preflight]

  --bundle         build the Sandbox web bundle first, so :$SERVER_PORT
                   serves the app too. Off by default: a hot-reload session
                   uses :$VITE_PORT, and the build costs seconds on every start.
  --no-preflight   skip the prerequisite checks. Postgres is still started —
                   that is doing the job, not checking it.
USAGE
  return 0
}

# Tags each line of a child's output. The `|| [ -n "$line" ]` flushes a final
# line that arrived without a trailing newline, which is how a panic message
# would otherwise get eaten.
_ri_prefix() {
  local tag=$1 color=$2 line
  while IFS= read -r line || [ -n "$line" ]; do
    printf '%s[%s]%s %s\n' "$color" "$tag" "$_C_OFF" "$line"
  done
  return 0
}

_ri_say() { printf '%s[ * ]%s %s\n' "$_C_BLU" "$_C_OFF" "$1"; return 0; }
_ri_warn() { printf '%s[ ! ]%s %s\n' "$_C_YEL" "$_C_OFF" "$1"; return 0; }

# `kill -0` keeps succeeding for a zombie child until it is reaped, so a plain
# kill -0 poll would never notice a crashed server. Ask for the process state
# instead and treat Z as dead.
_ri_alive() {
  local state
  state=$(ps -o state= -p "$1" 2>/dev/null | head -1)
  case ${state:-} in
    ''|Z*) return 1 ;;
    *)     return 0 ;;
  esac
}

_ri_stop() {
  local pid=$1 name=$2 i=0
  if [ -z "$pid" ]; then return 0; fi
  if ! _ri_alive "$pid"; then return 0; fi
  _ri_warn "stopping $name (pid $pid)"
  kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  while [ "$i" -lt 50 ]; do
    if ! _ri_alive "$pid"; then break; fi
    sleep 0.1
    i=$((i + 1))
  done
  if _ri_alive "$pid"; then
    _ri_warn "$name did not exit in 5s — killing"
    kill -KILL -- -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
  return 0
}

_RI_CLEANED=0

_ri_cleanup() {
  trap - INT TERM EXIT
  if [ "$_RI_CLEANED" = 1 ]; then return 0; fi
  _RI_CLEANED=1
  # Job control off before signalling. The process groups already exist, so the
  # group kills below still land; what this suppresses is bash's own
  # "Terminated: 15  ( export ... )" notification for each job, which dumps the
  # whole subshell back into the terminal and buries the tidy stop lines.
  printf '\n'
  # stderr to /dev/null, and the supervise loop below does the same, because
  # bash announces every job it reaps — "Terminated: 15  ( cd server; export
  # ... )", the entire subshell source printed back at you. It lands in the
  # middle of the interleaved logs and reads like a stack trace. There is no
  # single call to silence, since bash emits it at whichever command it happens
  # to be running when it notices, so the redirect has to cover the whole
  # region. `set +m` was tried here first and measurably does not suppress it.
  # Nothing in _ri_stop reports anything useful on stderr — every kill in it
  # already carries its own `2>/dev/null || true` — and its progress lines go to
  # stdout, so they still show.
  _ri_stop "$WEB_PID" web 2>/dev/null
  _ri_stop "$SRV_PID" srv 2>/dev/null
  _ri_say "$INSTANCE stopped."
  return 0
}

run_instance() {
  local skip_preflight=0 build_bundle=0 arg rc=0

  for arg in "$@"; do
    case $arg in
      --bundle)       build_bundle=1 ;;
      --no-preflight) skip_preflight=1 ;;
      -h|--help)      _ri_usage; return 0 ;;
      *)              printf 'unknown option: %s\n\n' "$arg" >&2; _ri_usage >&2; exit 2 ;;
    esac
  done

  preflight_begin "$INSTANCE instance"
  if [ "$skip_preflight" = 0 ]; then
    check_node
    check_pnpm
    check_cargo
    check_docker
    check_db_port_free "$DB_PORT" "$CONTAINER"
    check_port_free "$SERVER_PORT" "$INSTANCE server"
    check_port_free "$VITE_PORT" "$INSTANCE vite"
  fi
  # Outside the --no-preflight guard on purpose: bringing Postgres up is part of
  # doing the job, not part of checking whether the job can be done.
  ensure_postgres "$COMPOSE_SERVICE" "$CONTAINER"
  if [ "$skip_preflight" = 0 ]; then
    check_llm_config
  fi
  preflight_report

  if [ "$build_bundle" = 1 ]; then
    _ri_say "building $WEB_DIST ($WEB_BUILD_SCRIPT)"
    pnpm --filter @meologue/web "$WEB_BUILD_SCRIPT"
  fi

  # The signal traps exit rather than returning: a bare `trap _ri_cleanup INT`
  # hands control back to the poll loop below, which then rediscovers the
  # children it just reaped and reports the shutdown a second time. 130 and 143
  # are the conventional 128+signal statuses.
  trap '_ri_cleanup; exit 130' INT
  trap '_ri_cleanup; exit 143' TERM
  trap _ri_cleanup EXIT
  set -m

  # DATABASE_URL, STATIC_DIR and PORT are exported inside the subshell rather
  # than assigned with ${VAR:-...} defaults, for the reason scripts/
  # sandbox-server.sh spells out at length: the point of a per-instance script
  # is that it cannot be aimed at the other instance, and a `${DATABASE_URL:-}`
  # fallback would let an exported variable from a shell that had been working
  # on the other one do exactly that. The LLM configuration is deliberately left
  # inherited — server/src/main.rs loads server/.env, and dotenvy does not
  # override variables already in the environment, so these still win.
  (
    cd server
    export DATABASE_URL="$DATABASE_URL"
    export STATIC_DIR="$STATIC_DIR"
    export PORT="$SERVER_PORT"
    exec cargo run
  ) > >(_ri_prefix 'srv' "$_C_CYA") 2>&1 </dev/null &
  SRV_PID=$!

  # --strictPort matters: without it Vite silently walks to the next free port
  # when its own is taken, which would quietly defeat both the preflight check
  # above and the "one instance per port" split this whole arrangement rests on.
  #
  # --mode matters for the same class of reason. A bare `vite` runs in mode
  # "development", which is not in vite.config.ts's BUILD_TARGETS, so it falls
  # back to the "web" target — meaning a Sandbox hot-reload session would serve
  # the WEB platform seam while --bundle built the sandbox one. Nothing behaves
  # differently today, but ADR 0029 is explicit that a Sandbox failing to
  # exercise the seam it exists to test "is worse than no Sandbox, because it
  # reports success for code that never ran". Naming the mode keeps the two
  # paths the same build.
  (
    export MEOLOGUE_PROXY_TARGET="http://localhost:$SERVER_PORT"
    exec pnpm --filter @meologue/web exec vite \
      --mode "$VITE_MODE" --port "$VITE_PORT" --strictPort
  ) > >(_ri_prefix 'web' "$_C_MAG") 2>&1 </dev/null &
  WEB_PID=$!

  printf '\n%s--- %s: server :%s · web :%s ---%s\n' \
    "$_C_BLD" "$INSTANCE" "$SERVER_PORT" "$VITE_PORT" "$_C_OFF"
  printf '  %s[srv]%s pid %-7s cargo run · postgres :%s\n' "$_C_CYA" "$_C_OFF" "$SRV_PID" "$DB_PORT"
  printf '  %s[web]%s pid %-7s vite · /v1 -> http://localhost:%s\n' "$_C_MAG" "$_C_OFF" "$WEB_PID" "$SERVER_PORT"
  printf '\n'
  printf '  Open %shttp://localhost:%s%s and set that same address as the Server URL\n' \
    "$_C_BLD" "$VITE_PORT" "$_C_OFF"
  printf '  in Settings — an unset Server URL means Sync is off.\n'
  if [ ! -d "$WEB_DIST" ] && [ "$build_bundle" = 0 ]; then
    printf '\n  %s%s is absent, so :%s serves the API but 404s the app.%s\n' \
      "$_C_DIM" "$WEB_DIST" "$SERVER_PORT" "$_C_OFF"
    printf '  %sThat is fine for hot reload — use :%s. Pass --bundle to build it.%s\n' \
      "$_C_DIM" "$VITE_PORT" "$_C_OFF"
  fi
  printf '\n  Ctrl-C stops both.\n\n'

  # No `wait -n` in bash 3.2 (this machine ships 3.2.57), so poll. Either child
  # dying takes the other with it: a half-running pair is more confusing than a
  # clean exit, and a Rust compile error should not leave Vite serving happily.
  while :; do
    if ! _ri_alive "$SRV_PID"; then
      rc=0
      wait "$SRV_PID" 2>/dev/null || rc=$?
      # A child leaving at all fails the pair, whatever status it left with.
      # Reporting 0 because `cargo run` happened to exit cleanly would tell a
      # caller the session succeeded, when what actually happened is that half
      # of it vanished.
      if [ "$rc" -eq 0 ]; then rc=1; fi
      _ri_warn "server exited (status ${rc:-0}) — stopping web too"
      SRV_PID=
      break
    fi
    if ! _ri_alive "$WEB_PID"; then
      rc=0
      wait "$WEB_PID" 2>/dev/null || rc=$?
      # A child leaving at all fails the pair, whatever status it left with.
      # Reporting 0 because `cargo run` happened to exit cleanly would tell a
      # caller the session succeeded, when what actually happened is that half
      # of it vanished.
      if [ "$rc" -eq 0 ]; then rc=1; fi
      _ri_warn "web exited (status ${rc:-0}) — stopping the server too"
      WEB_PID=
      break
    fi
    sleep 1
    # 2>/dev/null for the same reason as _ri_cleanup's — see there. Nothing in
    # this loop writes anything else to stderr: the children's output goes
    # through the prefix filters on stdout, and _ri_warn prints to stdout too.
  done 2>/dev/null

  _ri_cleanup
  exit "$rc"
}
