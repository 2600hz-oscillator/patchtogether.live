#!/usr/bin/env bash
# scripts/helpers.sh — start / stop / status for the native helper bridges
# that live in-tree under apps/helpers/ (folded in with their history on
# 2026-09-14 — owner: "vst, es9 and etc should all be in main repo now as
# part of our native chromium app effort").
#
#   es9  → apps/helpers/es9/.build/release/es9-bridge         (port 9209)
#   vst  → apps/helpers/nativeapps/.build/release/vst-bridge  (port 9309)
#
# `task helpers:build` only COMPILES; nothing starts. This script is the
# "start" half the owner asked for, with the "stop" half it needs: a bridge
# that outlives its terminal is reparented to launchd and keeps holding both
# the port AND the ES-9 (apps/helpers/es9/README.md, "Port already in use"),
# so every start here records a PID file and every stop reads it back.
#
# Subcommands (Taskfile: helpers:start|stop|status, helpers:<id>:start|stop):
#   start  <es9|vst|all> [args…]  Run the BUILT binary detached (nohup), log +
#                                 PID under .helpers/ (gitignored, like
#                                 .dev-server/). Builds the package first if
#                                 the binary is missing. REFUSES when something
#                                 already listens on the port (prints its PID).
#                                 Extra args go to the binary verbatim
#                                 (`start es9 --synthetic`); `all` takes none —
#                                 the two binaries do not share a flag set.
#   stop   <es9|vst|all>          SIGINT the PID we recorded (both bridges
#                                 handle it), escalate TERM→KILL on a bounded
#                                 wait, free the port. With no PID file, fall
#                                 back to the port's listener — but ONLY when
#                                 its executable is this checkout's helper;
#                                 a foreign listener is named, not killed
#                                 (HELPERS_FORCE=1 overrides).
#   status [es9|vst|all]          Listening? PID? Ours? Log path.
#
# Port seams: PT_HELPER_ES9_PORT / PT_HELPER_VST_PORT — the SAME env names
# apps/desktop/src/main.ts reads (helperEnv) — or `--port N` in the args.
#
# bash 3.2 (stock macOS): no associative arrays, no ${var,,}, no mapfile.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STATE_DIR="$ROOT/.helpers"
READY_TRIES=100      # × 0.1 s — bounded wait for the socket to appear
STOP_TRIES=50        # × 0.1 s — bounded wait per signal on stop

usage() {
  echo "usage: scripts/helpers.sh <start|stop|status> <es9|vst|all> [args…]" >&2
  exit 2
}

# ---- per-helper facts (case, not declare -A: macOS ships bash 3.2) ---------
helper_bin() {
  case "$1" in
    es9) echo "apps/helpers/es9/.build/release/es9-bridge" ;;
    vst) echo "apps/helpers/nativeapps/.build/release/vst-bridge" ;;
    *) return 1 ;;
  esac
}
helper_pkg() {
  case "$1" in
    es9) echo "apps/helpers/es9" ;;
    vst) echo "apps/helpers/nativeapps" ;;
  esac
}
helper_name() {
  case "$1" in
    es9) echo "es9-bridge" ;;
    vst) echo "vst-bridge" ;;
  esac
}
helper_default_port() {
  case "$1" in
    es9) echo 9209 ;;
    vst) echo 9309 ;;
  esac
}
helper_env_port() {
  case "$1" in
    es9) echo "${PT_HELPER_ES9_PORT:-}" ;;
    vst) echo "${PT_HELPER_VST_PORT:-}" ;;
  esac
}

# The port the binary WILL bind: `--port N` / `--port=N` in the args wins,
# then the desktop's PT_HELPER_<ID>_PORT seam, then the documented default.
resolve_port() {
  local id="$1"; shift
  local port="" prev=""
  for a in "$@"; do
    case "$a" in
      --port=*) port="${a#--port=}" ;;
      *) [ "$prev" = "--port" ] && port="$a" ;;
    esac
    prev="$a"
  done
  [ -z "$port" ] && port="$(helper_env_port "$id")"
  [ -z "$port" ] && port="$(helper_default_port "$id")"
  case "$port" in
    ''|*[!0-9]*) echo "[helpers] bad port '$port' for $id" >&2; return 1 ;;
  esac
  echo "$port"
}

pid_file()  { echo "$STATE_DIR/$1.pid"; }
port_file() { echo "$STATE_DIR/$1.port"; }
log_file()  { echo "$STATE_DIR/$1.log"; }

# ---- who is on the port -----------------------------------------------------
# Prints "<pid> <command>" for the first LISTENer on the port, or nothing.
# lsof -F is used instead of ps: the sandboxed agent shell hides other users'
# ps rows but still answers lsof.
listener() {
  local port="$1" pid="" cmd=""
  command -v lsof >/dev/null 2>&1 || return 0
  while IFS= read -r line; do
    case "$line" in
      p*) pid="${line#p}" ;;
      c*) cmd="${line#c}" ;;
    esac
    [ -n "$pid" ] && [ -n "$cmd" ] && break
  done < <(lsof -nP -iTCP:"$port" -sTCP:LISTEN -Fpc 2>/dev/null)
  [ -n "$pid" ] && echo "$pid $cmd"
  return 0
}

# Prints "ours" when the listener's executable lives under this checkout's
# apps/helpers/, "foreign:<path>" when the OS names another executable, or
# "unknown" when it will not say. Positive identity — the same discipline as
# scripts/dev-server.sh's server_owner(): a stop must never kill a listener
# just because it is on OUR port.
listener_owner() {
  local pid="$1" exe="" root_phys
  root_phys="$(pwd -P)"
  # `-a` ANDs the selectors. Without it lsof ORs them — `-p PID -d txt` then
  # lists EVERY process's text segments and the first es9-bridge on the box
  # (the owner's live one) got reported as the owner of OUR pid. Measured
  # 2026-09-14 on the first round trip; dev-server.sh's cwd probe uses -a too.
  exe="$(lsof -a -p "$pid" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | grep -E '/(es9-bridge|vst-bridge)$' | head -1)"
  if [ -z "$exe" ]; then
    echo "unknown"
    return 0
  fi
  case "$exe" in
    "$ROOT"/apps/helpers/* | "$root_phys"/apps/helpers/*) echo "ours" ;;
    *) echo "foreign:$exe" ;;
  esac
}

alive() { kill -0 "$1" 2>/dev/null; }

recorded_pid() {
  local f; f="$(pid_file "$1")"
  [ -f "$f" ] || return 0
  local pid; pid="$(cat "$f" 2>/dev/null || true)"
  case "$pid" in ''|*[!0-9]*) return 0 ;; esac
  echo "$pid"
}

# ---- build-if-missing ---------------------------------------------------------
ensure_built() {
  local id="$1" bin pkg
  bin="$(helper_bin "$id")"; pkg="$(helper_pkg "$id")"
  [ -x "$bin" ] && return 0
  echo "[helpers] $bin is missing — building it first (the same swift build task helpers:build runs)"
  if ! command -v swift >/dev/null 2>&1; then
    echo "[helpers] swift is not on PATH; the helpers are Swift/macOS-only. Install Xcode CLT, then: task helpers:build" >&2
    return 1
  fi
  swift build -c release --package-path "$pkg"
  [ -x "$bin" ] || { echo "[helpers] build finished but $bin is still missing" >&2; return 1; }
}

# ---- start --------------------------------------------------------------------
cmd_start_one() {
  local id="$1"; shift
  local name bin port pid pidf portf logf who
  name="$(helper_name "$id")"; bin="$(helper_bin "$id")"
  port="$(resolve_port "$id" "$@")" || return 1
  pidf="$(pid_file "$id")"; portf="$(port_file "$id")"; logf="$(log_file "$id")"

  ensure_built "$id" || return 1

  # Already started by US and still alive → idempotent no-op (report where).
  pid="$(recorded_pid "$id")"
  if [ -n "$pid" ] && alive "$pid"; then
    echo "[helpers] $name already running (pid $pid, started by this checkout) — not starting a second one"
    echo "[helpers]   harness : http://127.0.0.1:$(cat "$portf" 2>/dev/null || echo "$port")/"
    echo "[helpers]   stop    : task helpers:$id:stop"
    return 0
  fi

  # Somebody else on the port → REFUSE and name them. Starting anyway would
  # only produce the binary's own "port in use" exit, and for es9 that stray
  # process also still holds the ES-9 device.
  who="$(listener "$port")"
  if [ -n "$who" ]; then
    local lpid="${who%% *}" lcmd="${who#* }" owner
    owner="$(listener_owner "$lpid")"
    echo "────────────────────────────────────────────────────────────" >&2
    echo "[helpers] REFUSING to start $name: port $port is already in use by PID $lpid ($lcmd)." >&2
    case "$owner" in
      ours) echo "[helpers]   that is this checkout's $name (a stray one — stop it: task helpers:$id:stop)" >&2 ;;
      foreign:*) echo "[helpers]   executable: ${owner#foreign:} — NOT this checkout's build; stop it yourself: kill $lpid" >&2 ;;
      unknown) echo "[helpers]   the OS would not say whose it is; stop it yourself if it is yours: kill $lpid" >&2 ;;
    esac
    echo "[helpers]   or run this one elsewhere: task helpers:$id:start -- --port $((port + 1))" >&2
    echo "────────────────────────────────────────────────────────────" >&2
    return 1
  fi

  mkdir -p "$STATE_DIR"
  echo "[helpers] starting $name on port $port (log → $logf)"
  [ "$#" -gt 0 ] && echo "[helpers]   args: $*"
  nohup "$bin" "$@" >"$logf" 2>&1 &
  pid=$!
  echo "$pid" >"$pidf"
  echo "$port" >"$portf"

  # Readiness is the socket being bound — an observable state, polled on a
  # bound — never a fixed sleep. A binary that exits first (no ES-9 attached
  # without --synthetic, a bad flag, --list) is reported with its log.
  local i=0
  while [ "$i" -lt "$READY_TRIES" ]; do
    if [ -n "$(listener "$port")" ]; then break; fi
    if ! alive "$pid"; then
      echo "[helpers] $name (pid $pid) exited before binding port $port — last lines of $logf:" >&2
      tail -n 20 "$logf" >&2 || true
      rm -f "$pidf" "$portf"
      return 1
    fi
    sleep 0.1
    i=$((i + 1))
  done
  if [ -z "$(listener "$port")" ]; then
    echo "[helpers] ⚠ $name (pid $pid) is alive but not listening on $port after $((READY_TRIES / 10))s — see $logf" >&2
    return 1
  fi
  echo "[helpers] $name UP  pid=$pid"
  echo "[helpers]   harness : http://127.0.0.1:$port/"
  echo "[helpers]   protocol: ws://127.0.0.1:$port/ws"
  echo "[helpers]   log     : $logf"
  echo "[helpers]   stop    : task helpers:$id:stop"
}

cmd_start() {
  local which="$1"; shift
  case "$which" in
    es9|vst) cmd_start_one "$which" "$@" ;;
    all)
      if [ "$#" -gt 0 ]; then
        echo "[helpers] 'start all' takes no flags (es9-bridge and vst-bridge do not share one flag set)." >&2
        echo "[helpers]   use the per-helper task: task helpers:es9:start -- $*" >&2
        return 2
      fi
      local rc=0
      cmd_start_one es9 || rc=1
      cmd_start_one vst || rc=1
      return "$rc"
      ;;
    *) usage ;;
  esac
}

# ---- stop ---------------------------------------------------------------------
# Signal a pid, wait (bounded) for it to go, return 0 when gone.
signal_and_wait() {
  local pid="$1" sig="$2" i=0
  kill "-$sig" "$pid" 2>/dev/null || true
  while [ "$i" -lt "$STOP_TRIES" ]; do
    alive "$pid" || return 0
    sleep 0.1
    i=$((i + 1))
  done
  alive "$pid" && return 1
  return 0
}

stop_pid() {
  local name="$1" pid="$2"
  # Both bridges handle SIGINT (es9: `running = false`; vst: a DispatchSource
  # on .main) — that is the Ctrl-C the READMEs prescribe. TERM, then KILL,
  # only if INT did not land.
  if signal_and_wait "$pid" INT; then echo "[helpers] $name (pid $pid) stopped on SIGINT"; return 0; fi
  if signal_and_wait "$pid" TERM; then echo "[helpers] $name (pid $pid) stopped on SIGTERM"; return 0; fi
  if signal_and_wait "$pid" KILL; then echo "[helpers] $name (pid $pid) stopped on SIGKILL"; return 0; fi
  echo "[helpers] ⚠ $name (pid $pid) survived SIGKILL?!" >&2
  return 1
}

cmd_stop_one() {
  local id="$1" name pid port pidf portf who rc=0
  name="$(helper_name "$id")"
  pidf="$(pid_file "$id")"; portf="$(port_file "$id")"
  pid="$(recorded_pid "$id")"
  port="$(cat "$portf" 2>/dev/null || true)"
  case "$port" in ''|*[!0-9]*) port="$(resolve_port "$id")" ;; esac

  if [ -n "$pid" ] && alive "$pid"; then
    stop_pid "$name" "$pid" || rc=1
  elif [ -n "$pid" ]; then
    echo "[helpers] $name pid file names $pid but it is not running — clearing stale state"
  else
    echo "[helpers] no $name pid file under $STATE_DIR (nothing started by this checkout)"
  fi
  rm -f "$pidf" "$portf"

  # Belt and suspenders: the port must be FREE when we return. But the
  # fallback only ever kills a listener whose executable is THIS checkout's
  # helper. The owner's hardware test runs a real es9-bridge on 9209; a bare
  # `task helpers:stop` from an agent worktree must NAME it, not kill it.
  who="$(listener "$port")"
  if [ -n "$who" ]; then
    local lpid="${who%% *}" lcmd="${who#* }" owner
    owner="$(listener_owner "$lpid")"
    if [ "$owner" = "ours" ] || [ "${HELPERS_FORCE:-0}" = "1" ]; then
      echo "[helpers] port $port still held by pid $lpid ($lcmd, $owner) — stopping it"
      stop_pid "$name" "$lpid" || rc=1
    else
      echo "────────────────────────────────────────────────────────────" >&2
      echo "[helpers] NOT stopping pid $lpid ($lcmd) on port $port — it is not this checkout's $name." >&2
      case "$owner" in
        foreign:*) echo "[helpers]   executable: ${owner#foreign:}" >&2 ;;
        unknown) echo "[helpers]   the OS would not name its executable" >&2 ;;
      esac
      echo "[helpers]   if it is yours: kill $lpid      (or HELPERS_FORCE=1 task helpers:$id:stop)" >&2
      echo "────────────────────────────────────────────────────────────" >&2
      rc=1
    fi
  fi
  [ -z "$(listener "$port")" ] && echo "[helpers] port $port is free"
  return "$rc"
}

cmd_stop() {
  case "$1" in
    es9|vst) cmd_stop_one "$1" ;;
    all)
      local rc=0
      cmd_stop_one es9 || rc=1
      cmd_stop_one vst || rc=1
      return "$rc"
      ;;
    *) usage ;;
  esac
}

# ---- status -------------------------------------------------------------------
cmd_status_one() {
  local id="$1" name bin port pid who state="DOWN"
  name="$(helper_name "$id")"; bin="$(helper_bin "$id")"
  pid="$(recorded_pid "$id")"
  port="$(cat "$(port_file "$id")" 2>/dev/null || true)"
  case "$port" in ''|*[!0-9]*) port="$(resolve_port "$id")" ;; esac
  who="$(listener "$port")"
  if [ -n "$who" ]; then
    local lpid="${who%% *}" lcmd="${who#* }" owner
    owner="$(listener_owner "$lpid")"
    state="UP"
    echo "[helpers] $name  $state   port=$port pid=$lpid ($lcmd) owner=$owner"
    if [ -n "$pid" ] && [ "$pid" != "$lpid" ]; then
      echo "[helpers]   ⚠ pid file says $pid but $lpid holds the port — a stray? (task helpers:$id:stop names it)"
    fi
    [ -n "$pid" ] && [ "$pid" = "$lpid" ] && echo "[helpers]   started by this checkout — log: $(log_file "$id")"
    echo "[helpers]   harness : http://127.0.0.1:$port/"
  else
    echo "[helpers] $name  $state port=$port"
    if [ -n "$pid" ]; then
      if alive "$pid"; then
        echo "[helpers]   ⚠ pid file names $pid, which is alive but NOT listening on $port — see $(log_file "$id")"
      else
        echo "[helpers]   stale pid file ($pid is gone) — task helpers:$id:stop clears it"
      fi
    fi
    [ -x "$bin" ] || echo "[helpers]   binary not built ($bin) — task helpers:build"
  fi
}

cmd_status() {
  case "${1:-all}" in
    es9|vst) cmd_status_one "$1" ;;
    all) cmd_status_one es9; cmd_status_one vst ;;
    *) usage ;;
  esac
}

# ---- dispatch -----------------------------------------------------------------
[ "$#" -ge 1 ] || usage
cmd="$1"; shift
case "$cmd" in
  start)  [ "$#" -ge 1 ] || usage; cmd_start "$@" ;;
  stop)   [ "$#" -ge 1 ] || usage; cmd_stop "$1" ;;
  status) cmd_status "${1:-all}" ;;
  *) usage ;;
esac
