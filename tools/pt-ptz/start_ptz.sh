#!/bin/bash
# Start the PT-PTZ camera helper (MIDI→UVC bridge for the NexiGo P610).
# One command = helper running and ready for patchtogether.live's ptzcam module.
#
# Runs in the FOREGROUND so the logs stay visible on stage — keep the terminal
# open; Ctrl+C stops camera control (the app shows unbound, nothing crashes).
#
# ⚠ Browser gotcha (same class as start_edge.sh): Chromium 152 on macOS
# silently drops SysEx unless launched with --disable-features=MidiMacUmp.
# Use start_edge.sh for the browser or the camera will NOT move while
# everything looks bound.
set -u

CANDIDATES=(
  "${PTZ_BIN:-}"
  "$HOME/Documents/workspace/inet.modular/tools/pt-ptz/pt-ptz"
  "$HOME/Documents/workspace/inet.modular/.claude/worktrees/ptzcam/tools/pt-ptz/pt-ptz"
)
BIN=""
for c in "${CANDIDATES[@]}"; do
  [ -n "$c" ] && [ -x "$c" ] && { BIN="$c"; break; }
done
if [ -z "$BIN" ]; then
  for d in "$HOME/Documents/workspace/inet.modular/tools/pt-ptz" \
           "$HOME/Documents/workspace/inet.modular/.claude/worktrees/ptzcam/tools/pt-ptz"; do
    [ -f "$d/pt-ptz.c" ] && { echo "building helper in $d ..."; make -C "$d" && BIN="$d/pt-ptz" && break; }
  done
fi
[ -z "$BIN" ] && { echo "pt-ptz binary not found and could not build — set PTZ_BIN=/path/to/pt-ptz" >&2; exit 1; }

if pgrep -x pt-ptz >/dev/null 2>&1; then
  echo "pt-ptz is ALREADY RUNNING — a second copy would create a second PT-PTZ port and confuse the app."
  echo "Stop it first:  pkill -x pt-ptz"
  exit 1
fi

echo "camera check:"
if ! "$BIN" --probe; then
  echo "⚠ camera not found — starting anyway; it will bind the moment you plug in the NexiGo P610."
fi

echo
echo "Verify after start: the line 'virtual MIDI destination + source \"PT-PTZ\" up',"
echo "then in the app the ptzcam module shows BOUND after you grant MIDI."
echo "Quick hardware test any time:  $BIN --nudge   (small zoom pulse + restore)"
echo "── helper log ──────────────────────────────────────────────"
exec "$BIN"
