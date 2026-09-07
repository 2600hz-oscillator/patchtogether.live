# Native shell spec — bundled Chromium + helpers (2026-08-31)

Owner-requested spec. Replaces the `../patchtogether.native` strategy question
with a concrete alternative: a thin **Electron-class shell** around the
EXISTING web app, in THIS repo. No divergent codebase; the web build is the
app. `patchtogether.native` (greenfield SwiftUI/Metal/CoreAudio rewrite,
nothing built yet, web repo as read-only spec) remains the maximal path and is
NOT advanced by this spec.

Facts below marked **[tree]** were verified in this repo on 2026-08-31; items
marked **[verify]** must be re-checked by the builder; Electron capabilities
are from platform knowledge — pin exact APIs against the chosen Electron
version at build time.

## 1. Owner requirements (2026-08-31, paraphrased)

1. Native macOS app bundling Chromium + our ES-9, VST, PTZ helpers/scripts.
2. Its UI is for HARDWARE: connect 1–4 camera devices, 1–4 output
   (Presentation) displays, ES-9, VST layer, gamepads, Push/Launchpad, PTZ,
   Electra.
3. The app manages Chromium windows: 1 fullscreen main-UI window + 1 per
   configured output, each assigned to a physical display, kept fullscreen by
   the app.
4. File menu: Quit (visible only in native mode), Load patch.
5. Loading/changing patches must NEVER disrupt connections to displays,
   cameras, MIDI, or bridges.
6. Probably bake 4 camera + 4 output nodes into the root tree (across the
   board, or native-only — owner leaves open).
7. Goal: stable local-machine rig, immune to hardware disruption on patch
   load/change.
8. No "press Esc to exit fullscreen" style messaging anywhere.

## 2. Shell choice

**Electron.** Reasons, and why not the alternatives:

- Tauri/WKWebView: Safari engine — **no WebMIDI, no WebUSB, no Web Serial**.
  Disqualified outright; every device layer we have rides those.
- Driving real installed Chrome (`--kiosk --app=`) from a native wrapper:
  no menu integration, no window-open interception, no permission handlers,
  browser auto-updates underneath a live rig. Fragile.
- CEF directly: everything Electron does with none of the packaging/menu/
  process tooling. More work, no gain for this scope.
- Electron: bundled + **pinned** Chromium (we choose when the browser under a
  gig upgrades — the Chromium-152 SysEx regression we ship detection for in
  #2270 [tree] is the standing argument), Node main process for helper
  supervision, native menus, multi-window, per-window and per-session policy
  control. Cost: ~250 MB payload + an upgrade cadence we now own (see §10).

## 3. Architecture

```
Electron main process (the shell, ~1–2k LoC)
├── serves the built web app (see §3.1)
├── spawns + supervises helpers: es-9 bridge, vst bridge, pt-ptz   (§6)
├── owns windows: main UI + output sinks, display assignment       (§5)
├── owns native menus (File ▸ Load Patch…, Quit)                   (§8)
├── permission/device handlers (MIDI+sysex, cam/mic, USB, serial)  (§4)
└── config store: device-slot bindings, display map (NOT Y.Doc)    (§7)
        │ contextBridge preload («ptNative» API)
        ▼
renderer: THE SAME web app (packages/web build)
   main window = patcher; output windows = /present sinks
```

### 3.1 How the web app is served

Decision needed (Q4 §11): bundle the production build and serve it from a
main-process loopback HTTP server (simplest — keeps fetch/asset/relative-URL
behavior identical to the web deploy; a custom `app://` scheme is the
alternative but touches more SvelteKit assumptions [verify adapter output
shape]), with a dev switch pointing at the flox dev server (`localhost:5173`)
for development. Offline-capable by construction; no beta gate locally.

### 3.2 The native-bridge seam (web-side)

One small module, the same five-conventions shape as every device layer
[tree: monome/push2/electra pattern]: `nativeAvailable()` probe (preload
injects `window.ptNative`), typed API (`loadPatchRequested` event,
`presentTargets()`, `quit()`), and a simulated double for tests. Web code
never imports Electron; e2e keeps running the plain-browser path.

## 4. Chromium configuration — the pains each line kills

| Shell setting | Pain it removes (evidence in tree/memory) |
|---|---|
| `BrowserWindow` fullscreen/kiosk | the "press Esc" toast — it is Chrome-browser UI, Electron windows have none |
| no fullscreen gesture requirement | #2271: the no-gesture present path "was machine config all along" [tree] |
| `backgroundThrottling: false` per window | unfocused-window rAF throttling (the count-frames-in-the-driving-window class) |
| `setPermissionRequestHandler` auto-grant (midi+sysex, camera, mic, window-management) | every permission prompt; Launchpad/Push/Electra sysex prompts |
| autoplay policy: no gesture | AudioContext resume dance on boot |
| `select-usb-device` / `select-serial-port` handlers in main | Chrome's device-picker popups for Push 2 screen (WebUSB) + monome (Web Serial) — the handler IS the shell's connection UI |
| `powerSaveBlocker('prevent-display-sleep')` | displays sleeping mid-set |
| `render-process-gone` → reload window | a renderer crash never drops helpers or other windows (they live in main) |
| pinned Chromium version | browser auto-update under a live rig (#2270 class) |

## 5. Windows, displays, present

- **The existing present pipeline survives unchanged.** [tree]
  `present-window.ts` opens a same-origin chrome-less popup per output and
  the OPENER blits the OUTPUT canvas into the popup's canvas on the sink's
  frame clock (deliberately not captureStream — that rendered black on real
  dual-monitor hardware). In the shell, `setWindowOpenHandler` turns that
  `window.open('/present', …)` into a real frameless fullscreen
  BrowserWindow **placed by the shell's display map**, overriding the
  web-computed popup features. Same-origin opener→popup DOM access is
  preserved for renderer-created windows, so the blit loop runs as-is
  [verify on chosen Electron version].
- Shell owns the display map: output N ↔ `screen.getAllDisplays()` entry
  (match by display id, fall back to bounds). `display-added` /
  `display-removed` / `display-metrics-changed` events re-place and
  re-fullscreen windows; the web app never notices. Consider
  `simpleFullscreen` (pre-Lion fullscreen) to avoid macOS Spaces animations
  and keep per-display independence [verify behavior on target macOS].
- Audio stays where it is: the AudioContext lives only in the main window's
  renderer; output windows are pure canvas sinks. [tree — already the
  architecture]
- Main window: kiosk/fullscreen on the designated primary; the hardware
  UI (§7) is shell-native chrome (a window or panel of the shell, not the
  web app), so it works even when the web app is wedged.

## 6. Helpers: bundled, supervised children

- Bundle the ES-9 bridge, VST bridge, and `pt-ptz` binaries in
  `Contents/Resources`; main spawns them at launch, restarts with backoff,
  surfaces status in the shell UI.
- The localhost WS protocols stay byte-identical (`127.0.0.1:9209` es9,
  `:9309` vst [tree]); the web app's existing probes just start succeeding.
  The HTTPS→ws://localhost block memory is mooted — we control the origin.
- The es9 output-mode push policy that never got a caller
  (the stuck-note incident) has a natural home in the shell's ES-9 config
  panel — flagged as owner question Q7, not assumed.
- pt-ptz keeps its per-camera virtual CoreMIDI pairs [tree]; the shell just
  owns its lifecycle.
- This supersedes-by-owner-direction the standing "no native helper apps"
  stance (which already carried the ES-9 exemption, owner 2026-07-09).

## 7. The device-slot layer — the real design work

The disruption-immunity requirement (req 5/7) is an ownership problem, not a
shell problem, and fixing it benefits the plain web app too.

- **Baked nodes:** `camera1..4` + `output1..4` as `undeletable` singleton
  nodes in every root tree (the registry already carries `undeletable` /
  `maxInstances` / `ownerOnly` [tree: VideoModuleDef]). Recommend ACROSS THE
  BOARD, not native-only — one tree shape, one code path, no native fork of
  fixtures/EXPECTED_NODE_TYPES. In the browser an unbound slot is simply
  dark.
- **Binding lives outside the patch:** slot ↔ physical device (camera
  deviceId, display id, ES-9 config) is app/local config (shell store; web
  falls back to localStorage), NEVER the Y.Doc. Patches reference slots
  only. Precedent: `resolveGamepadSlot` remembers `gamepad.id` in
  `device-rebind.ts` [tree]; the anti-precedent is #2045 (collab peer
  dispose()s the LIVE ES-9 bridge) — per-client local binding removes that
  class, and in collab each client sees their own hardware in the slots.
- **Patch load = in-place Y.Doc load that never tears the device layer.**
  Aligns with the standing rule to save/load into the live Y.Doc rather than
  rebuild maps holding live Y types [memory]. Hardware sessions
  (MediaStream, MIDI claims via `createMidiInputClaim`, bridge sockets, USB
  claims) key on slot ids with app-session lifetime — the completion of the
  #1531 node-keyed-registry direction and the es9 engine-node-ownership move
  [tree].
- Contract surface: 8 new defs (or 2 defs × maxInstances — builder decides
  against the tree), DESCRIPTIONS, face dispositions, contract-lock,
  EXPECTED_NODE_TYPES — the standard new-module bookkeeping, priced like the
  trails PR. Camera slots should subsume/wrap the existing `cameraInput`
  machinery rather than duplicate it [verify how cameraInput + node-scoped
  stream registries compose].

## 8. Menus and native mode

- macOS app menu: Quit (Cmd-Q) — standard placement; File ▸ Load Patch…
  (and Save Patch As… [verify what save/export exists]) drive the web app
  through the preload bridge. Web-side quit affordances stay hidden unless
  `ptNative` is present (req 4's "visible only in native mode" inverted to
  the conventional macOS shape — flag if the owner literally wants Quit in
  File).
- Loading via the menu goes through the SAME in-place load seam as any other
  load; the device layer's immunity comes from §7, not from the menu.

## 9. Testing posture

Per the owner rulings (no new gates or kinds of tests without discussion; no
CI machinery), this spec proposes NO new gates. What the builder ships:
unit tests for the shell's pure logic (display mapping, window-features
override, supervision backoff) in the existing unit lane; the web-side
native-bridge seam gets the standard simulated-double coverage. Whether any
Electron-launched e2e lane should EXIST is an owner decision — report, don't
gate. The plain-browser e2e suite remains the product gate; the shell must
keep the browser path fully working (it is the same build).

## 10. Phased plan

- **Phase 0 — device-slot layer (web-only PR(s), no Electron):** baked
  slots, local binding store, in-place-load-preserves-devices. Biggest
  shared win; independently shippable and testable in the browser.
- **Phase 1 — minimal shell:** `apps/desktop` (or `packages/desktop` —
  match workspace conventions) with main window, flag set (§4), menus,
  loopback serving of the build, helper spawn/supervision + status.
- **Phase 2 — outputs:** display map UI, `setWindowOpenHandler` present
  integration, hotplug handling, kiosk polish.
- **Phase 3 — hardware UI:** camera pickers (enumerate via a shell-owned
  renderer), USB/serial device handlers, ES-9/VST/PTZ config panels,
  persistence.
- **Phase 4 — distribution (owner-gated):** electron-builder DMG, signing +
  notarization (needs Developer ID + entitlements + TCC usage strings for
  camera/mic), release lane in CI — explicitly requires owner sign-off under
  the no-CI-changes ruling.

## 11. Open questions for the owner

1. Electron confirmed as the shell? (Tauri is disqualified by WebMIDI/WebUSB;
   the realistic alternatives are Electron or "keep funding the native
   rewrite".)
2. Device slots across the board (recommended) or native-only?
3. Slot counts: fixed 4+4, or configurable with 4 as default?
4. Serve bundled build (recommended, offline-stable, versioned with the app)
   or point at dev/prod URLs?
5. Collab inside native mode v1: in or out? (Slots are per-client either
   way.)
6. Release lane + signing: green-light needed (CI ruling), and an Apple
   Developer ID.
7. Should the ES-9 output-mode push policy finally get its caller in the
   shell's ES-9 panel? (Owner hw-verify on that policy is still outstanding.)
8. Repo placement: `apps/desktop` in this repo (recommended) vs elsewhere.
9. Disposition of `../patchtogether.native`: park/archive, or keep as the
   long-horizon track?
10. Literal File ▸ Quit, or conventional macOS app-menu Quit?

## 12. Sizing (rough, for planning not commitment)

Phase 0 is the substantial one (a real product PR series: new defs, load
semantics, ownership moves — comparable to a large module program slice).
Phases 1–2 are each small (days of agent work) once 0 exists. Phase 3 grows
with polish appetite. Phase 4 is mostly accounts/certs/process.
