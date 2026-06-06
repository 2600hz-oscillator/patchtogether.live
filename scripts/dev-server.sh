#!/usr/bin/env bash
# scripts/dev-server.sh — manage ONE long-lived local app server for the
# single-test dev loop.
#
# The whole point: boot the SvelteKit dev (or `vite preview`) server ONCE and
# leave it up, so `task e2e:one` / `task vrt:one` can run a single spec against
# it via Playwright's `reuseExistingServer` WITHOUT paying the ~5-10s server
# boot on every iteration. The first `task e2e -- <spec>` boots + tears down the
# server each run; this keeps it warm across many runs.
#
# Subcommands:
#   start        Start the server in the background (idempotent — no-op if the
#                port is already serving). DSP dist + registry manifest are made
#                ready first (see `task e2e:serve`, which calls this).
#   stop         Stop the server we started (by PID file); also frees the port.
#   status       Print whether the server is up + which mode (dev|preview).
#   wait         Block until the server answers on its port (used by callers).
#
# Modes (env):
#   E2E_PREVIEW=1   serve `vite preview` (prod build, port 4173) instead of the
#                   dev server (port 5173). Mirrors playwright.config's
#                   E2E_USE_PREVIEW toggle so a single spec exercises the same
#                   target the @smoke prod-build lane uses.
#   HEADED / etc.   not used here (those affect Playwright, not the server).
#
# Machine-friendly by design (memory: don't leak dev-servers): the server is
# explicitly teardownable via `stop`, its PID is tracked, and `start` is a
# no-op when something is already serving the port.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PREVIEW="${E2E_PREVIEW:-0}"
if [ "$PREVIEW" = "1" ]; then
  MODE="preview"
  PORT="${E2E_PORT:-4173}"
else
  MODE="dev"
  PORT="${E2E_PORT:-5173}"
fi

STATE_DIR="$ROOT/.dev-server"
PID_FILE="$STATE_DIR/$MODE.pid"
LOG_FILE="$STATE_DIR/$MODE.log"
URL="http://localhost:$PORT"

port_is_serving() {
  # A 200/30x/40x — anything that proves *something* is answering HTTP on the
  # port — counts as "up". The beta-gate returns 401 but that's still a live
  # server, so we accept any HTTP response, not just 2xx.
  curl -fsS -o /dev/null --max-time 2 "$URL" 2>/dev/null && return 0
  # curl -f fails on 401; fall back to a bare connect check.
  curl -sS -o /dev/null --max-time 2 "$URL" 2>/dev/null
}

cmd_status() {
  if port_is_serving; then
    echo "[dev-server] UP   mode=$MODE url=$URL"
    [ -f "$PID_FILE" ] && echo "[dev-server] pid=$(cat "$PID_FILE") log=$LOG_FILE"
    return 0
  fi
  echo "[dev-server] DOWN mode=$MODE url=$URL"
  return 1
}

cmd_wait() {
  local tries="${1:-120}" # ~120 * 1s = 2 min, matches playwright webServer timeout
  local i=0
  while [ "$i" -lt "$tries" ]; do
    if port_is_serving; then return 0; fi
    sleep 1
    i=$((i + 1))
  done
  echo "[dev-server] timed out waiting for $URL after ${tries}s" >&2
  return 1
}

cmd_start() {
  mkdir -p "$STATE_DIR"
  if port_is_serving; then
    echo "[dev-server] already UP at $URL (mode=$MODE) — reusing, not re-booting"
    return 0
  fi

  if [ "$MODE" = "preview" ]; then
    # `vite preview` serves the prebuilt bundle; the caller (task) is
    # responsible for having run a build first.
    echo "[dev-server] starting PREVIEW server on $URL (logs → $LOG_FILE)"
    nohup npm run preview -w packages/web -- --port "$PORT" --strictPort \
      >"$LOG_FILE" 2>&1 &
  else
    echo "[dev-server] starting DEV server on $URL (logs → $LOG_FILE)"
    nohup npm run dev -w packages/web -- --port "$PORT" --strictPort \
      >"$LOG_FILE" 2>&1 &
  fi
  echo $! >"$PID_FILE"

  if cmd_wait 120; then
    echo "[dev-server] UP at $URL (pid=$(cat "$PID_FILE"))"
    echo "[dev-server] run single specs with: flox activate -- task e2e:one -- <spec-or-grep>"
    echo "[dev-server] tear down with:         flox activate -- task e2e:stop"
  else
    echo "[dev-server] server failed to come up — tail of $LOG_FILE:" >&2
    tail -20 "$LOG_FILE" >&2 || true
    cmd_stop || true
    return 1
  fi
}

cmd_stop() {
  local stopped=0
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      # Kill the whole process group — `npm run` spawns vite as a child.
      kill "$pid" 2>/dev/null || true
      pkill -P "$pid" 2>/dev/null || true
      stopped=1
    fi
    rm -f "$PID_FILE"
  fi
  # Belt + suspenders: free the port even if the PID file was stale (e.g. the
  # server was started outside this script). Avoid leaking a dev server.
  local port_pids
  port_pids="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"
  if [ -n "$port_pids" ]; then
    echo "$port_pids" | xargs kill 2>/dev/null || true
    stopped=1
  fi
  if [ "$stopped" = "1" ]; then
    echo "[dev-server] stopped mode=$MODE (port $PORT freed)"
  else
    echo "[dev-server] nothing to stop for mode=$MODE (port $PORT)"
  fi
}

# `assert-up` — used by `task e2e:one` to fail fast with a clear hint when the
# persistent server isn't running, instead of silently letting Playwright boot
# its own (which defeats the speed-up).
cmd_assert_up() {
  if port_is_serving; then return 0; fi
  cat >&2 <<EOF
[dev-server] No server answering at $URL (mode=$MODE).

  Single-spec runs reuse a long-lived server for speed. Start it once with:

      flox activate -- task e2e:serve          # dev server (port 5173)
      flox activate -- E2E_PREVIEW=1 task e2e:serve   # prod preview (port 4173)

  then re-run your single spec. (Or run \`task e2e -- <spec>\` to boot+teardown
  a server per-run — slower, but no persistent server needed.)
EOF
  return 1
}

case "${1:-}" in
  start)      cmd_start ;;
  stop)       cmd_stop ;;
  status)     cmd_status ;;
  wait)       cmd_wait "${2:-120}" ;;
  assert-up)  cmd_assert_up ;;
  *)
    echo "usage: $0 {start|stop|status|wait|assert-up}" >&2
    exit 2
    ;;
esac
