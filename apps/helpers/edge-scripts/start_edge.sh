#!/bin/bash
# Launch Microsoft Edge with the MIDI fix for the Chromium-152 macOS SysEx
# regression (the MidiMacUmp backend reports send() success while transmitting
# nothing — Electra flashes/CC silently vanish).
#
# ⚠ WHY THIS EXECS THE BINARY AND KILLS STRAGGLERS FIRST: `open -a ... --args`
# silently DROPS the flags if any Edge process is alive (Edge keeps background
# processes after the last window closes), and a direct exec with the default
# profile forwards to a running instance the same way. The flag only truly
# applies when NO Edge process exists at launch. Verify anytime in the running
# browser: edge://version → "Command Line" must show --disable-features=MidiMacUmp.
#
# Default: your real profile (bookmarks, sync, granted MIDI permission).
#   --scratch : throwaway profile in /tmp instead (fresh permissions each time,
#               wiped on reboot) — the variant verified during the 2026-08-29 debug.
# Override the Edge binary with EDGE_BIN if it is not in /Applications.
set -u

EDGE="${EDGE_BIN:-/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge}"
FLAGS=(--disable-features=MidiMacUmp)
[ "${1:-}" = "--scratch" ] && FLAGS+=(--user-data-dir=/tmp/edge-electra-legacy-midi)

if pgrep -f "$EDGE" >/dev/null 2>&1; then
  echo "Edge processes are still alive (background ones count) — the flag would be DROPPED."
  read -r -p "Kill them and launch flagged? [y/N] " a
  [ "$a" = "y" ] || { echo "Aborted — quit Edge fully, then rerun."; exit 1; }
  pkill -f "$EDGE"; sleep 2
  pgrep -f "$EDGE" >/dev/null 2>&1 && { echo "Still running; try again in a few seconds." >&2; exit 1; }
fi

"$EDGE" "${FLAGS[@]}" >/dev/null 2>&1 &
disown
echo "Launched. Verify at edge://version → Command Line shows: ${FLAGS[*]}"
