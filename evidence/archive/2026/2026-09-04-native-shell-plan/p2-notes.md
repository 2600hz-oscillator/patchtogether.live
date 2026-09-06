# P2 execution notes — 2026-09-03 (minimal shell + PH harness skeleton)

## What shipped

`apps/desktop` — STANDALONE npm package (own lockfile, deliberately NOT added
to the root workspaces so web CI installs and the shared root lockfile stay
untouched; revisit when the program needs shared deps). Electron pinned EXACT
at **44.1.1** (re-check MidiMacUmp exposure at every pin bump).

- `src/main.ts`: flag set (`--disable-features=MidiMacUmp`,
  `--autoplay-policy=no-user-gesture-required`, permission auto-grant +
  check-handler, `setDevicePermissionHandler` + USB/serial/HID choosers,
  `setDisplayMediaRequestHandler` → primary screen, `powerSaveBlocker`,
  `backgroundThrottling:false`, `setWindowOpenHandler` allow), native menus
  (Quit native-only per the owner ruling; File ▸ Load Patch…), single
  fullscreen window — NATIVE fullscreen, so no "Press Esc" toast exists by
  construction. `PT_DESKTOP_PORT` (default 9409; es9 9209 / vst 9309 pattern),
  `PT_DESKTOP_WEB_ROOT`, `PT_DESKTOP_WINDOWED=1` env seams.
- `src/server.ts`: loopback-only static server, COOP `same-origin` + COEP
  `credentialless` on every response (mirrors `packages/web/_headers`), SPA
  fallback via adapter-static `fallback.html`, plus the `__data.json` shim:
  the root `+layout.server.ts` (Clerk) makes the client router fetch
  `<route>/__data.json` on SPA navigations — the prerendered root file IS the
  signed-out payload, so it answers any data request with no prerendered file.
  Without the shim /rack renders the client 404 (measured — first harness run
  failed exactly there).
- `src/preload.ts`: minimal `window.ptNative` (nativeAvailable, shellVersion,
  onLoadPatchRequested, quit) via contextBridge; web never imports Electron.
- Web build seam: `PT_DESKTOP_BUILD=1` switches `svelte.config.js` to
  adapter-static (pages/assets `build`, `fallback.html`, strict:false). Web
  deploys untouched — Cloudflare adapter stays the default. New devDep
  `@sveltejs/adapter-static` in packages/web.
- electron-builder config carries the TCC usage strings (camera/mic/audio
  capture) in `extendInfo` NOW per the brief; packaging itself is later.
- Taskfile: `helpers:build`, `desktop:install`, `desktop:build:web`,
  `desktop:dev`, `desktop:e2e` (appended block; only shared-file edit).

## PH skeleton — the GATING-light lane's required subset, exactly

`apps/desktop/e2e/boot.spec.ts` via `task desktop:e2e` (deps in apps/desktop —
NEVER e2e/package.json, the webgl-attest pin). Asserts: shell boots the built
bundle from the loopback server → `/rack` URL → `.svelte-flow` paints →
`crossOriginIsolated === true` → `ptNative.nativeAvailable()` →
`__ensureEngine()` then audio ctx `state === 'running'` with ZERO gestures
(page.evaluate is not a gesture; a stock browser parks at 'suspended', so the
assertion discriminates the shell) → zero pageerrors → exactly one window.

**Evidence 2026-09-03:** green 1× (3.7 s) + `--repeat-each=3` green
(1.3/2.0/1.5 s, 3/3), zero leaked electron processes after teardown
(ps sweep filtered to the app path). Tier A subject = unpackaged `electron .`
+ PT_DESKTOP_BUILD=1 VITE_E2E_HOOKS=1 test bundle — NOT the shipped artifact.
The CI job is NOT wired — it lands later with its own owner sign-off
checkpoint per answer 3's authorization chain.

## HOUR-ONE SPIKE (P4 premise) — PASS on Electron 44.1.1

Same-origin opener→popup DOM access under `setWindowOpenHandler`: opener
`window.open('/p2-spike-blank.txt')` on the loopback origin, opener-side
`popup.document` write + canvas paint + pixel readback, popup-window rAF
advanced 3 frames under opener control, `sameOrigin: true`.
Probe output: `{"access":true,"painted":true,"popupFramesAdvanced":3,"sameOrigin":true}`
(one-off probe script, not a gate — no-new-gates ruling). P4's blit design
premise HOLDS **on one display**; no re-plan needed on the DOM-access half.
⚠ This probe ran single-display: the CROSS-DISPLAY half — the half where
captureStream actually went black — was not answered here. The repeatable
dual-monitor harness for it is `task desktop:spike`
(apps/desktop/SPIKE-OPENER-DISPLAY.md); P4 waits on that recorded result,
not on this probe.

## Battery (this branch, this commit family)

- `task lint`: eslint gate PASS (3704 files) + shellcheck gate PASS
  (34 tracked scripts incl. the vendored edge-scripts, severity=style, 0).
- `task typecheck`: all workspaces green; `apps/desktop` has its own
  `npm run typecheck` (main + e2e tsconfigs), green.
- Linux CI untouched: no workflow sets `submodules:` on any checkout (grep
  re-run post-submodule-add: zero hits); apps/desktop is not a workspace.

## Deferred (later P2/PH slices — tracked, not lost)

- Web-side `statechange → suspended → auto-resume` + AudioGate suppression
  under `nativeAvailable()` (brief P2 task 6).
- ptNative simulated double for browser/e2e; presentTargets/slotBindings/
  helperStatus surface growth.
- Packaged-.app build + quarantine/TCC runbook; Tier B seams.
- Harness: fake-device camera assertions, MIDI mock, stub helpers, the
  worklet RMS instrument + positive controls (PH proper).
