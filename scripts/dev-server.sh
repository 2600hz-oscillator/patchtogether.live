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
PORT_FILE="$STATE_DIR/$MODE.port"
LOG_FILE="$STATE_DIR/$MODE.log"

# ⚠ STOP MUST TARGET THE PORT WE STARTED, NOT THE DEFAULT.
#
# `start` records the port it booted; `stop` reads it back when the caller did
# not name one. Without this, `E2E_PORT=N task e2e:serve` followed by a bare
# `task e2e:stop` resolved PORT to the DEFAULT 5173 and the "belt + suspenders"
# `lsof -ti tcp:$PORT | xargs kill` below killed whatever was listening there —
# which in this repo's normal working state is ANOTHER WORKTREE'S dev server.
# Measured 2026-08-11: it killed the server belonging to a sibling agent
# checkout while stopping this one (whose own pid file was found and honoured,
# so the state dir is correctly worktree-local — only the PORT fallback was
# global).
#
# This is the `task vrt`/`E2E_PORT` lesson from CLAUDE.md in its destructive
# direction: `e2e:serve`, `e2e:one` and `vrt:one` all honour `E2E_PORT` and
# `e2e:stop`'s fallback did not, and "an isolation mechanism that only half the
# entry points honour is not isolation." An EXPLICIT `E2E_PORT` still wins, so
# stopping a server you did not start is still possible when you mean it.
if [ -z "${E2E_PORT:-}" ] && [ -f "$STATE_DIR/$MODE.port" ]; then
  RECORDED_PORT="$(cat "$STATE_DIR/$MODE.port" 2>/dev/null || true)"
  case "$RECORDED_PORT" in
    ''|*[!0-9]*) ;;                    # blank or junk — keep the default
    *) PORT="$RECORDED_PORT" ;;
  esac
fi

URL="http://localhost:$PORT"

port_is_serving() {
  # A 200/30x/40x — anything that proves *something* is answering HTTP on the
  # port — counts as "up". The beta-gate returns 401 but that's still a live
  # server, so we accept any HTTP response, not just 2xx.
  curl -fsS -o /dev/null --max-time 2 "$URL" 2>/dev/null && return 0
  # curl -f fails on 401; fall back to a bare connect check.
  curl -sS -o /dev/null --max-time 2 "$URL" 2>/dev/null
}

# ⚠ A SERVER ANSWERING ON THE PORT IS NOT NECESSARILY *THIS WORKTREE'S* SERVER.
#
# This is the "green sweep of the WRONG BRANCH" hazard from CLAUDE.md, in the
# half that was never fixed. `task vrt` was routed through `vrt:run` so it
# honours E2E_PORT; the SERVE path still only asked "is something answering?".
# Measured 2026-08-11: `E2E_PORT=5261 task e2e:serve` printed "already UP —
# reusing" against a DIFFERENT WORKTREE'S dev server, and every subsequent
# `e2e:one` / `vrt:one` then exercised that other branch while reporting
# against this one. Reproduced again 2026-08-12: port 5173 was being served
# from .claude/worktrees/agent-aaab2e553c711a296 while `dev-server.sh status`
# in THIS worktree cheerfully reported `UP`.
#
# So identify the OWNER, don't just probe the socket. We ask the OS who is
# listening and where that process's cwd is: a vite booted from this checkout
# has a cwd at or under $ROOT, a sibling worktree's does not. That is a
# POSITIVE identity check rather than a liveness check, and it works for a
# server started by hand (`npm run dev` in a terminal) as well as one we
# started — the PID file alone could not tell those apart.
#
# Prints exactly one of:
#   ours            — the listener's cwd is inside this checkout
#   foreign:<cwd>   — someone else's; <cwd> names WHOSE, so the message is actionable
#   unknown         — something answers but the OS would not tell us who
#   no-instrument   — no lsof on this machine, so the question cannot be asked
#
# ⚠ `unknown` and `no-instrument` are DELIBERATELY DISTINCT. "The instrument
# says I don't know" and "there is no instrument" are different facts and want
# opposite handling: the first is refused (an unidentifiable server is exactly
# the hazard), the second warns loudly and proceeds (refusing would make the
# tool unusable on a machine without lsof, and lsof is only a soft dependency
# elsewhere in this script).
server_owner() {
  if ! command -v lsof >/dev/null 2>&1; then
    echo "no-instrument"
    return 0
  fi
  local pid cwd root_phys
  pid="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)"
  if [ -z "$pid" ]; then
    echo "unknown"
    return 0
  fi
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  if [ -z "$cwd" ]; then
    echo "unknown"
    return 0
  fi
  # Compare against the PHYSICAL path too — $ROOT is the logical one and lsof
  # always reports the resolved path, so a symlinked checkout would otherwise
  # read as foreign to itself.
  root_phys="$(cd "$ROOT" 2>/dev/null && pwd -P)"
  case "$cwd" in
    "$ROOT" | "$ROOT"/* | "$root_phys" | "$root_phys"/*) echo "ours" ;;
    *) echo "foreign:$cwd" ;;
  esac
}

# Loud refusal for a port owned by someone else. `$1` is the verb for the
# message ("reuse" / "run against" / "stop").
refuse_not_ours() {
  local verb="$1" owner="$2"
  echo "────────────────────────────────────────────────────────────" >&2
  echo "[dev-server] REFUSING to $verb the server on port $PORT — it is NOT this worktree's." >&2
  case "$owner" in
    foreign:*) echo "[dev-server]   listener cwd : ${owner#foreign:}" >&2 ;;
    unknown) echo "[dev-server]   listener      : something is answering, but the OS would not say who" >&2 ;;
  esac
  echo "[dev-server]   this checkout: $ROOT" >&2
  echo "" >&2
  echo "  Using it would run your specs against ANOTHER BRANCH while reporting" >&2
  echo "  them against this one — a green sweep that never loaded your code." >&2
  echo "" >&2
  echo "  → Give this worktree its own port:  E2E_PORT=<free-port> flox activate -- task e2e:serve" >&2
  echo "  → or stop the other server from ITS checkout: flox activate -- task e2e:stop" >&2
  echo "  → override only if you genuinely mean it: E2E_ALLOW_FOREIGN_SERVER=1" >&2
  echo "────────────────────────────────────────────────────────────" >&2
}

# Resolve ownership into a decision. Returns 0 = go ahead, 1 = refused.
# Honours the explicit override, and treats a missing instrument as a warning
# rather than a block (see the note on `no-instrument` above).
ownership_permits() {
  local verb="$1" owner
  if [ "${E2E_ALLOW_FOREIGN_SERVER:-0}" = "1" ]; then
    echo "[dev-server] E2E_ALLOW_FOREIGN_SERVER=1 — not checking who owns port $PORT."
    return 0
  fi
  owner="$(server_owner)"
  case "$owner" in
    ours) return 0 ;;
    no-instrument)
      echo "[dev-server] ⚠ lsof unavailable — CANNOT VERIFY that port $PORT belongs to this" >&2
      echo "[dev-server]   checkout ($ROOT). Proceeding UNVERIFIED; if your results look like" >&2
      echo "[dev-server]   another branch's, this is why." >&2
      return 0
      ;;
    *)
      refuse_not_ours "$verb" "$owner"
      return 1
      ;;
  esac
}

cmd_status() {
  if port_is_serving; then
    local owner
    owner="$(server_owner)"
    echo "[dev-server] UP   mode=$MODE url=$URL owner=$owner"
    case "$owner" in
      foreign:*) echo "[dev-server] ⚠ that server belongs to ${owner#foreign:} — NOT this checkout ($ROOT)" ;;
    esac
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
    # Only reuse a server this checkout owns — see server_owner() above.
    ownership_permits "reuse" || return 1
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
  # So a later bare `task e2e:stop` frees THIS port rather than the default.
  echo "$PORT" >"$PORT_FILE"

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
  rm -f "$PORT_FILE"
  # Belt + suspenders: free the port even if the PID file was stale (e.g. the
  # server was started outside this script). Avoid leaking a dev server.
  #
  # ⚠ …but NEVER onto someone else's port. The PID-file kill above is ours by
  # construction; this fallback is not, and it is the leg that actually killed
  # a sibling worktree's dev server (measured 2026-08-11, via the E2E_PORT
  # fallback that has since been fixed above). Recording the port closed the
  # route that was measured; checking the OWNER closes the class — an explicit
  # `E2E_PORT` pointing at a sibling's port still reaches this line.
  local port_pids owner
  port_pids="$(lsof -ti tcp:"$PORT" 2>/dev/null || true)"
  if [ -n "$port_pids" ]; then
    owner="$(server_owner)"
    case "$owner" in
      foreign:*)
        echo "[dev-server] ⚠ NOT killing port $PORT — it is served from ${owner#foreign:}," >&2
        echo "[dev-server]   not this checkout ($ROOT). Stop it from its own worktree." >&2
        ;;
      *)
        echo "$port_pids" | xargs kill 2>/dev/null || true
        stopped=1
        ;;
    esac
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
  if port_is_serving; then
    # ⚠ THE MOST IMPORTANT OWNERSHIP CHECK IN THIS FILE. `e2e:one` and
    # `vrt:one` call assert-up and then hand Playwright a `reuseExistingServer`
    # config — so if the port belongs to another worktree, the spec runs
    # against that branch and reports against this one. A liveness probe
    # cannot tell those apart; server_owner() can.
    ownership_permits "run against" || return 1
    return 0
  fi
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
