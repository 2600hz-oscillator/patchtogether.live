#!/bin/bash
# Re-assert the Edge policy patchtogether depends on. Observed to vanish
# (2026-08-29: the com.microsoft.Edge defaults domain was found empty and
# present-on stopped auto-fullscreening with "TypeError: Permissions check
# failed"). AutomaticFullscreenAllowedForUrls lets our origins call
# requestFullscreen with NO user gesture — required by the present sink.
# After running: fully quit Edge, relaunch (start_edge.sh), verify at
# edge://policy (click "Reload policies" if the key is missing).
set -euo pipefail

defaults write com.microsoft.Edge AutomaticFullscreenAllowedForUrls '<array><string>[*.]patchtogether.live</string><string>[*.]patchtogether-live-autotest.pages.dev</string><string>[*.]patchtogether-live-dev.pages.dev</string><string>localhost</string><string>http://localhost:5173</string></array>'

echo "AutomaticFullscreenAllowedForUrls is now:"
defaults read com.microsoft.Edge AutomaticFullscreenAllowedForUrls
echo
echo "Now FULLY quit Edge and relaunch it (use start_edge.sh)."
