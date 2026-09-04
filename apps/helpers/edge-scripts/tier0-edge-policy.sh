#!/bin/bash
# tier0-edge-policy.sh — grant patchtogether.live the two Edge content settings
# that remove the per-projector click:
#
#   AutomaticFullscreenAllowedForUrls  -> requestFullscreen() with no gesture
#   PopupsAllowedForUrls               -> window.open() with no gesture
#
# Must run as root: mandatory (non-"recommended") policies are ONLY read from
# /Library/Managed Preferences/. AutomaticFullscreenAllowedForUrls declares
# "Can be recommended: No", so /Library/Preferences/ is NOT an option.
#
# Domain is com.microsoft.Edge — NOT the app's CFBundleIdentifier
# (com.microsoft.edgemac). All Edge channels read com.microsoft.Edge since 78.
#
# ⚠ The plist is written as RAW XML, not via `defaults write`. cfprefsd treats
# /Library/Managed Preferences/<domain> as read-only managed storage: a
# `defaults write` there EXITS 0 AND WRITES NOTHING, so the whole thing
# silently no-ops. Measured on this machine 2026-08-26: dir created, file
# absent, exit status 0.
#
# The [*.] patterns cover per-PR Cloudflare Pages previews, which land on
# pr-<N>.patchtogether-live-autotest.pages.dev — a DIFFERENT origin from the
# named deploys, so without these a preview silently tests the popup blocker.
#
# Port is deliberately omitted from the localhost patterns => matches ANY port.
# This repo derives a per-worktree dev port in 5600-5999 (scripts/e2e-port.sh),
# so pinning one would break the moment you work in a different worktree.
set -euo pipefail

PLIST="/Library/Managed Preferences/com.microsoft.Edge.plist"

if [ "$(id -u)" -ne 0 ]; then echo "run me with sudo" >&2; exit 1; fi

# Does not exist on a machine that has never been MDM-enrolled.
mkdir -p "/Library/Managed Preferences"

cat > "$PLIST" <<'PLIST_XML'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AutomaticFullscreenAllowedForUrls</key>
  <array>
    <string>https://patchtogether.live</string>
    <string>https://dev.patchtogether.live</string>
    <string>[*.]patchtogether-live-autotest.pages.dev</string>
    <string>[*.]patchtogether-live-dev.pages.dev</string>
    <string>http://localhost</string>
    <string>http://127.0.0.1</string>
  </array>
  <key>PopupsAllowedForUrls</key>
  <array>
    <string>https://patchtogether.live</string>
    <string>https://dev.patchtogether.live</string>
    <string>[*.]patchtogether-live-autotest.pages.dev</string>
    <string>[*.]patchtogether-live-dev.pages.dev</string>
    <string>http://localhost</string>
    <string>http://127.0.0.1</string>
  </array>
</dict>
</plist>
PLIST_XML

plutil -lint "$PLIST"
chown root:wheel "$PLIST"
chmod 644 "$PLIST"

killall cfprefsd 2>/dev/null || true

echo
echo "wrote $PLIST"
plutil -p "$PLIST"
echo
echo "NEXT:"
echo "  1. Quit Edge COMPLETELY (Cmd-Q, not just the window) and reopen."
echo "  2. Open edge://policy — both policies must be listed with status OK."
echo "     If edge://policy is empty, this machine ignores hand-made managed"
echo "     prefs; use a signed/unsigned .mobileconfig profile instead."
echo "  3. On the site, confirm with:"
echo "       await navigator.permissions.query({name:'fullscreen',allowWithoutGesture:true})"
echo "     -> must report state 'granted'."
