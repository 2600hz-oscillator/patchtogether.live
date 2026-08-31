# Present on a second display: fullscreen and the browser environment

**What it is:** "Present on <display>" opens a chrome-less popup (`/present`, the
sink) sized to the target screen's working area and blits the output card's
canvas into it (`packages/web/src/lib/ui/modules/present-window.ts`,
`packages/web/src/routes/present/+page.svelte`). The popup then requests TRUE
fullscreen on itself to drop the OS titlebar + browser strip.

## How the popup becomes fullscreen — three paths

1. **Automatic (no gesture), environment-dependent.** `requestFullscreen()`
   without a user gesture succeeds only when the browser's **Automatic
   Fullscreen** content setting is granted for the origin. Chromium only lets
   regular sites get that grant through the `AutomaticFullscreenAllowedForUrls`
   enterprise policy (the user-facing settings page grants it to Isolated Web
   Apps only; Edge additionally exposes
   `edge://settings/content/automaticFullScreen`). When granted, the sink's
   retry loop (focus + up to 40 attempts) handles the F5-lands-windowed case.
2. **Delegated from the patcher's NEXT gesture (no setup).** `window.open()`
   consumes the click's transient activation, so delegation at popup-ready time
   never carries activation. Instead, when the sink reports it is not
   fullscreen, the opener arms a one-shot listener and — synchronously inside
   the user's next pointerdown/keydown in the patcher — posts a
   Capability-Delegation message (`delegate: 'fullscreen'`); the sink's
   `requestFullscreen()` then succeeds on the delegated token. One gesture
   converges one projector; N projectors take N gestures.
3. **A real gesture in the popup.** Any click/keypress on the projector window
   itself (the pulsing "click anywhere for full screen" hint).

## Incident 2026-08-29 (why this runbook exists)

Present-on stopped auto-fullscreening on the owner's rig, coinciding with the
Edge 152 update. Console showed, twice per toggle:
`[present] sink: fullscreen NOT entered after 40 attempts; last error =
TypeError: Permissions check failed` — Blink's rejection for "no transient
activation AND automatic-fullscreen permission denied". Root cause was **not**
an app commit and **not** a documented Chromium 152 change: the hand-written
`/Library/Managed Preferences/com.microsoft.Edge.plist` carrying
`AutomaticFullscreenAllowedForUrls` had been wiped (macOS owns that directory
and deletes manually planted files on reboot/OS update). Path 1 silently
depended on machine state; paths 2 (added after the incident) and 3 need none.

## Restore / verify the automatic path (macOS, Edge)

```sh
sudo defaults write "/Library/Managed Preferences/com.microsoft.Edge" \
  AutomaticFullscreenAllowedForUrls -array "https://patchtogether.live"
sudo killall cfprefsd   # flush the prefs cache, then fully relaunch Edge
```

- Verify at `edge://policy` (status OK after "Reload policies") and
  `edge://settings/content/automaticFullScreen`.
- Include every origin the popup document is served from (dev / previews /
  localhost as needed); a `.mobileconfig` device profile survives OS updates,
  a hand-planted plist does not.
- The sink reports the live permission state in its console line:
  `automatic-fullscreen permission = granted|denied|unavailable`
  (`navigator.permissions.query({ name: 'fullscreen', allowWithoutGesture: true })`).

## Console signatures

- `fullscreen blocked on first attempt: …` — first gesture-less attempt was
  refused (normal without the policy grant; delegation is being armed).
- `Automatic fullscreen is blocked by this browser …` — the one actionable
  advisory (`automaticFullscreenBlockedAdvisory()`), printed once per session
  when the permission probe says `denied`.
- `fullscreen entered on attempt N` — the retry loop recovered (granted-policy
  rigs, typically after an F5 while the patcher held focus).
- `fullscreen NOT entered after 40 attempts; …; automatic-fullscreen
  permission = …` — the loop exhausted itself with the permission NOT denied
  (a genuinely odd rig; read the last error).
