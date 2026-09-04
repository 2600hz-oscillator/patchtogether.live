# PTZ camera module research — NexiGo P610 (ASIN B0DQCFX9WN) for patchtogether.live

Date: 2026-08-29. Research + spec draft only; no code changed. Repo explored read-only at
the patchtogether repo checkout (worktree skills at
`.claude/worktrees/electrafix/.claude/skills/` are the newer authority for faces/e2e).

---

## Verdict

**Yes — controllable from the browser, with one probe standing between "likely" and "certain".**

- **API path: high confidence.** Chromium desktop (Chrome 87+, macOS included) exposes UVC
  pan/tilt/zoom through standard MediaStream constraints: `getUserMedia({video:{pan:true,tilt:true,zoom:true}})`,
  `track.getCapabilities()` for min/max/step, `track.applyConstraints({advanced:[{pan:v}]})` to move.
  This is exactly the shape the repo's video engine already feeds (CV bridge → `setParam` → per-frame apply).
- **This camera: moderate-high confidence (~75–85%).** The ASIN resolves to the **NexiGo P610**
  (10x optical, 1080p30, USB 3.0 + HDMI, RS232 VISCA/Pelco, IR remote, macOS 10.10+ listed).
  NexiGo's own P610 pages don't say "UVC PTZ", but the sibling **P620's manual explicitly lists
  "UVC 1.1 / UVC 1.5" and "UVC PTZ Control: Supported"**, and the same ODM manual sold under the
  ADKIDO brand (identical "1080P HD Smart PTZ Camera" document family) says "UVC PTZ Control: Support"
  with Windows/macOS/Linux/Android. "Works with Zoom" camera-control marketing in this product class
  rides on UVC PTZ. Nothing found that contradicts; no P610-specific `v4l2-ctl` dump surfaced.
- **The 2-minute probe below is decisive** — it answers the only open hardware question the day the
  camera arrives, with zero code written.
- **If UVC PTZ is absent** there is a genuinely good plan B: the P610 has an RS232 VISCA port and
  Chrome ships Web Serial (`navigator.serial`). VISCA adds velocity-mode pan/tilt drive, which is
  arguably a *better* fit for CV control than absolute setpoints (see Fallbacks).

Caveats that shape the design (all confirmed, sources at bottom):

1. **Chromium-only.** No Firefox/Safari PTZ. The module must degrade to plain camera input elsewhere.
2. **Absolute controls only.** Chromium maps UVC "PanTilt (Absolute)" + "Zoom (Absolute)"; relative
   UVC controls are not exposed. Continuous motion = streaming absolute setpoints.
3. **Page must be visible.** `applyConstraints` with PTZ rejects with `SecurityError` while the page
   is hidden. The apply loop must pause on `document.hidden` and resync on return. (The repo's
   audio keep-alive solves decode throttling, not this.)
4. **No documented rate limit** on `applyConstraints`, but each call is a USB round-trip and the
   camera's motors are the true limiter (pan 2.7–47°/s, tilt 2.7–30°/s). Plan for a coalescing
   ~10–15 Hz apply loop with one in-flight promise, step-quantized, not per-audio-frame writes.
5. **Permission is camera + PTZ combined**: request descriptor `{name:"camera", panTiltZoom:true}`;
   the gUM prompt becomes "use **and move** your camera". `pan:true` etc. are non-fatal wishes — a
   non-PTZ camera still yields a stream, so one code path serves both.

---

## The 2-minute hardware probe (run when the camera arrives)

Chrome (or Edge) on the Mac, camera on USB:

1. Open **https://webrtc.github.io/samples/src/content/getusermedia/pan-tilt-zoom/**
   Pick the NexiGo in the device dropdown, grant the permission (prompt should say *use and move*
   your camera). **If pan/tilt/zoom sliders appear and physically move the head → done, golden path
   confirmed.** The page exposes `track` in the console.
2. Cross-check: open **`about://media-internals`** → *Video Capture* tab → find the NexiGo row →
   the **Pan-Tilt-Zoom column** should read `pan tilt zoom` (this reflects the UVC absolute controls
   Chromium detected, independent of any page).
3. On the sample page's console, record the mapping constants we'll need:
   ```js
   const c = track.getCapabilities();
   ({pan: c.pan, tilt: c.tilt, zoom: c.zoom, settings: track.getSettings()})
   ```
   (Expect pan/tilt in UVC arc-second-ish device units with large ranges; zoom in vendor units.)
4. Motion character check (30s): drag the pan slider steadily end to end, then jump it. Note whether
   streamed absolute setpoints track smoothly or stutter — this decides the default slew rate.
5. If step 1 shows **no sliders**: `navigator.hid.requestDevice({filters:[]})` in any page console to
   see whether the camera offers a HID interface (unlikely — the remote is IR to the head), and note
   the result. Then plan B (Web Serial + VISCA) becomes the control path; video input still works.

Optional deeper dump if a Linux box is handy: `v4l2-ctl -d /dev/videoN --list-ctrls` and look for
`pan_absolute`, `tilt_absolute`, `zoom_absolute`.

---

## Module spec sketch — `ptzcam`

A **new video source module** (`type: 'ptzcam'`), not an extension of `cameraInput`:
`cameraInput` is rack-locked (`3u/2hp [LOCKED]` in `packages/web/src/lib/ui/rack-sizes.ts:170`), is a
`NON_SHELL_LANE_TYPES` carve-out with a bespoke legacy card, and adding CV ports to it would move its
attested def hash. `ptzcam` composes the same seams instead.

### Ports and params

CV is bipolar ±1 per ADR-004 (`docs/adr/004-cv-range-convention.md`); continuous `cv` inputs **must**
carry `cvScale` (gate: `packages/web/src/lib/video/cv-scale-registry.test.ts`).

```ts
inputs: [
  // Absolute-position class → center:'default' so a patched cable tracks the
  // source directly (QUADRALOGICAL pos_x/pos_y is the named precedent).
  { id: 'pan',  type: 'cv', paramTarget: 'pan',  cvScale: { mode: 'linear', center: 'default' } },
  { id: 'tilt', type: 'cv', paramTarget: 'tilt', cvScale: { mode: 'linear', center: 'default' } },
  // Bias-knob metaphor → default center:'param'.
  { id: 'zoom', type: 'cv', paramTarget: 'zoom', cvScale: { mode: 'linear' } },
],
outputs: [ { id: 'out', type: 'video' } ],
params: [
  { id: 'pan',  min: -1, max: 1, default: 0 },   // normalized; mapped to capability range at apply time
  { id: 'tilt', min: -1, max: 1, default: 0 },
  { id: 'zoom', min:  0, max: 1, default: 0 },   // 0 = capability min (wide), 1 = capability max
  { id: 'slew', min:  0, max: 1, default: 0.3 }, // max normalized units/sec toward target; 1 = instant
]
```

- Normalized→device mapping happens at the apply layer using live `getCapabilities()` min/max/step —
  never hard-coded device units (they're camera-specific and unknown until the probe).
- Ranges bind from the def via `paramSpec(def, id)` in the card (not exported `*_RANGE` constants —
  the accessor doesn't move the attest hash); enroll the card in `RANGE_BOUND_CARDS`
  (`card-range-source.test.ts`).
- `slew` is in normalized units/sec — wall-clock at the apply layer, frames in tests
  (repo rule: frames not ms applies to e2e waits; the slew itself is a rate, tested purely).
- Optional later: a `recenter` trigger input (`edge: 'trigger'`, no cvScale, needs a
  `VIDEO_PASSTHROUGH_BY_DESIGN` justification entry). Not in v1.

### Architecture (mirrors the cameraInput split exactly)

- **Factory (DOM-free)** `packages/web/src/lib/video/modules/ptzcam.ts`: identical texture path to
  `camera-input.ts` — `attachExternalSource('video', el)`, `requestVideoFrameCallback`-driven
  `texImage2D`/`texSubImage2D` upload into its own FBO, `UNPACK_FLIP_Y_WEBGL`, silent-audio
  keep-alive. `setParam` stores normalized pan/tilt/zoom/slew; expose them via `readParam`.
  The factory never touches the MediaStreamTrack. (Reuse/extract shared helpers from camera-input
  rather than copy where the diff stays small; note `ctx.res` is mutated in place — read per draw.)
- **Acquisition (pure seam)**: extend the `acquireCameraStream(gum, deviceId)` pattern
  (`packages/web/src/lib/ui/camera-acquire.ts`) with a PTZ variant that adds
  `pan:true, tilt:true, zoom:true` to the video constraints. Injectable `GetUserMediaFn` is the
  existing unit-test seam. Stream ownership stays with
  `packages/web/src/lib/ui/media/node-media-registry.ts` (`setStream`) — the card never calls
  `track.stop()` (documented cameraInput UNRECOVERABLE bug).
- **PTZ apply layer (pure logic + thin binding)** — the only genuinely new engine piece,
  `packages/web/src/lib/video/ptz-control.ts`:
  - `planPtzApply(state, targets, caps, dtMs)` — pure: slew-limit normalized targets, map to device
    units via caps min/max, quantize to `step`, return `null` when nothing changed by ≥1 step.
    This is the unit-testable core.
  - A tiny driver owned by the card: every ~80ms (12.5 Hz) read `handle.readParam('pan'|…)`,
    run the plan, and if non-null `track.applyConstraints({advanced:[plan]})` — **one in-flight
    promise, latest-wins coalescing** (never queue a backlog). Pause while `document.hidden`
    (SecurityError otherwise); on visibilitychange re-read `getSettings()` and resync.
  - **Graceful no-PTZ downgrade**: after acquisition, probe `getCapabilities()`. Missing pan/tilt/zoom
    ⇒ the module runs as a plain camera source, CV ins inert, face shows a "no PTZ" state. Handle
    `OverconstrainedError` per the `AudioinCard`/`devices.ts` precedent (probe caps → request within
    reported range → read back `getSettings()`).
- **Card/surface** `packages/web/src/lib/ui/modules/PtzcamCard.svelte`: device picker + state machine
  cloned from `CameraInputCard.svelte`'s `CameraState` union (add `'no-ptz'`), reusing
  `camera-device.ts` recovery decisions where possible. Prefer a declarative `face` +
  `shell-extension` over another `NON_SHELL_LANE_TYPES` carve-out: `face.order` complete over all
  params, `face.extension: 'ptzcam'` at `$lib/ui/modules/ptzcam/shell-extension.ts` using the wired
  slots (`glyph`, `fullViewBody` — `editorSurface` is declared but unwired). A live preview or PTZ
  XY pad is a named width-earner (compact is otherwise the default; no resting decimal readouts).
  `face` on a video def is hash-transparent (no GPU re-attest); `PortDef.label` is **not**.

### Permission UX (mirror `midi-access.ts` — "the one place that can explain a NO")

New `packages/web/src/lib/ui/ptz-access.ts` (or fold into camera-acquire):

- Feature test first: `navigator.mediaDevices?.getSupportedConstraints().pan/tilt/zoom` →
  `'unsupported'` outcome with copy naming Chrome/Edge desktop (browser support ≠ camera support).
- gUM called **synchronously from the click handler** — no `await` above it (the midi-access rule:
  an await spends the user activation and Chromium may refuse to prompt).
- Named four-way outcome `'granted' | 'denied' | 'no-prompt' | 'unsupported'` + timeout heuristic +
  `onLateResolve`, with a `ptzOutcomeMessage()` producing actionable copy per outcome
  ("Camera + PTZ permission blocked. Grant in browser site settings." etc.).
- Card surfaces it exactly like CameraInputCard: `role="alert"` error div, LED state class,
  state-dependent retry button, plus the local-only privacy hint testid convention.
- Permission introspection (settings panel, not the hot path):
  `navigator.permissions.query({name:'camera', panTiltZoom:true})`.

### Test story (per repo standards)

- **Unit (node, no DOM shims)** — the cameraInput strategy: every decision a pure function.
  - `ptz-control.test.ts`: `planPtzApply` against fake caps `{min,max,step}` — mapping, step
    quantization (no-op below one step), slew limiting, latest-wins coalescing decisions, hidden-page
    gating, no-PTZ downgrade classification. Fake track = `{ applyConstraints: vi.fn(), getCapabilities: () => caps }`
    recording calls (precedent: `camera-acquire.test.ts`'s `vi.fn<GetUserMediaFn>` + `domErr(name)`;
    `node-audio-input-registry.test.ts`'s track stub).
  - `ptz-access.test.ts` mirroring `midi-access.test.ts`'s four outcomes.
  - Registry gates that auto-apply: cv-scale registry (pan/tilt/zoom carry `cvScale` — nothing to
    allowlist), palette test, module-manifest description test.
- **E2E** — live inside `e2e/tests/camera-input.spec.ts` under the existing `chromium-camera`
  project. Adding a new spec file or project edits `e2e/playwright.config.ts`, which is in the WebGL
  attest basis (a real-GPU re-attest); cramming camera integration into one file is the documented
  convention (`camera-input.spec.ts:11-18`).
  - Chromium's `--use-fake-device-for-media-stream` does **not** expose PTZ capabilities, so the PTZ
    path needs a page-side seam: inject a fake `GetUserMediaFn` (the seam already exists) returning a
    stream whose track implements `getCapabilities`/`applyConstraints`/`getSettings`. **Seam rule
    from the tree's most instructive bug** (`camera-input.ts:424-457`): the seam must override
    *everything* the draw and apply loop read — pixels, geometry, caps, settings — not just some.
  - **Real-chain assertion** (the audible-RMS analog, CLAUDE.md rule 7): wire a real default-mode CV
    source (LFO) → `ptzcam.pan`, step the engine a fixed burst with the clock pinned, and assert the
    fake track **received `applyConstraints` calls with monotonically changing device-unit pan** —
    not merely that the edge materialized (per-port sweeps auto-enroll and only prove
    materialization; that's explicitly "strictly weaker").
  - Deterministic render smoke: synthetic-frame seam + `installRenderSmokeHooks`/`assertRenderStats`
    from `_render-smoke.ts`, untagged so attest Pass C runs it; live-gUM flow under the
    `@camera-integration` tag. Frames not ms (`waitFrames`/`settle` from `e2e/_helpers/frames.ts`;
    the waitForTimeout ledger only shrinks).
  - Anything requiring a real PTZ camera: capability-probe-and-skip with a loud-skip env flag, and
    confirm the gate is green ON CI before trusting it ("a gate that cannot fail on CI is decoration").
  - VRT: exempt like cameraInput (`EXEMPT_FROM_VRT` + `ALLOWED_PERMANENT_EXEMPT`, >40-char reason —
    live MediaStream defeats deterministic capture).
  - Local discipline: `REPEAT=3` flake check + `task typecheck` before push; re-run
    `flox activate -- task test:emit-manifest` so the per-port sweeps see the new ports.
- **Hardware probe checklist** (manual, ships in the module docs): the 2-minute probe above, plus:
  record caps min/max/step into the PR description; verify smooth motion at the default slew; verify
  hidden-tab pause/resume resync; verify a second `ptzcam` instance on the same device behaves
  (or document single-instance).

### Registry touchpoints (hand-maintained set for a new module)

Automatic: def glob (`packages/web/src/lib/video/modules/index.ts`), palette via `palette:` on the
def, card glob (`modules-card-map.ts`), docs via `task docs:accept`. Hand edits:
`module-manifest.ts` DESCRIPTIONS (unit-gated) · `strict-docs.ts` STRICT_DOCS ·
`modules-card-map.test.ts` EXPECTED_NODE_TYPES · `rack-sizes.ts` (suggest 3u, hp per face width
earned) · `face-migration-inventory.ts` disposition record (totality-gated) · `strict-faces.ts` in
the same PR as the `face` · VRT exemptions (both entries) · optional `push-card-config.ts` entry ·
`RANGE_BOUND_CARDS`. Scaffold: `scripts/new-module.ts`. Note the CLAUDE.md-vs-module-surfaces-skill
conflict on "every feature needs a GitHub issue" — CLAUDE.md is the higher authority; flag to owner.

---

## Fallbacks if UVC PTZ is absent

Ranked:

1. **Web Serial + VISCA over the P610's RS232 port** — the real plan B, and a possible *upgrade*
   even on the golden path. Needs a USB→RS232 adapter (FTDI) + the camera's 8-pin mini-DIN control
   cable; VISCA is 9600 8N1. Chrome desktop ships `navigator.serial` (gesture-gated picker, same
   permission-UX pattern). VISCA offers **velocity-mode pan/tilt drive** (direction + speed 2.7–47°/s)
   and up to 255 presets — velocity mode maps beautifully to bipolar CV (CV = signed speed), avoiding
   the absolute-setpoint stutter question entirely. Cost: a cable purchase and a `viscaFrame(pan,tilt,zoom)`
   encoder + ack/completion parser (well-documented protocol). Video still flows over USB regardless.
2. **WebHID to a vendor HID interface** — almost certainly moot here: the P610's remote is IR direct
   to the head, not a USB HID dongle, and no HID interface was reported for this ODM family. 30-second
   check in the probe (step 5). Only relevant if the probe surprises us.
3. **WebUSB — dead end, don't attempt.** UVC (video class 0x0E) is on WebUSB's protected interface
   class blocklist, and the OS owns the device anyway.
4. **Native helper daemon** (uvc-util / VVUVCKit-style CoreMedia helper bridging to the page over
   WebSocket/loopback) — precedented by today's local-tooling debugging, but strictly last resort;
   it breaks the "works in the browser" story for other users.

---

## Open questions

1. **Does the P610 specifically expose UVC PanTilt/Zoom Absolute?** The probe answers this. (P620
   sibling + ODM twin say yes; P610-specific documentation is silent.)
2. **Capability units and ranges on this unit** — needed to sanity-check the normalized mapping and
   pick a sensible zoom curve (linear device units often feel non-linear optically).
3. **Motion quality under streamed absolute setpoints at ~12 Hz** — smooth or stepped? Decides the
   default `slew` and whether the VISCA velocity path is worth building anyway.
4. **macOS 26 + current Chrome**: no breakage reports found, but macOS 26 is newer than most reports;
   the probe on the actual machine is the truth. Also confirm Chrome (not Safari) is the deployment
   assumption for this module's PTZ affordance.
5. **Does `applyConstraints` traffic disturb the video stream** (frame drops during moves)? Observe
   during the probe.
6. **Zoom certification nuance**: "works with Zoom" marketing ≠ verified in-client camera control for
   this exact SKU; if someone has Zoom handy, its local camera-control arrows are a second independent
   UVC PTZ confirmation.
7. **Multi-instance semantics**: two `ptzcam` nodes on one physical camera would fight over the head;
   likely `maxInstances` per *device* guard or documented last-writer-wins.
8. **Power-cycle behavior**: does the camera restore pan/tilt/zoom, and do saved patches want to
   re-assert position on load (probably yes — apply once on `granted` + caps probe)?

---

## Sources

- Chrome PTZ API (shape, permission, visibility rule, desktop support): https://web.dev/articles/camera-pan-tilt-zoom
- W3C explainer: https://github.com/w3c/mediacapture-image/blob/main/ptz-explainer.md
- Probe page: https://webrtc.github.io/samples/src/content/getusermedia/pan-tilt-zoom/ (source: https://github.com/webrtc/samples/tree/gh-pages/src/content/getusermedia/pan-tilt-zoom)
- Chrome 87 ship announcement: https://blog.chromium.org/2020/10/chrome-87-beta-webauthn-in-devtools.html
- Absolute-vs-relative UVC controls + `about://media-internals` PTZ column: W3C webrtc list posts by F. Beaufort — https://lists.w3.org/Archives/Public/public-webrtc-logs/2021Jan/0167.html , https://lists.w3.org/Archives/Public/public-webrtc-logs/2021Mar/0321.html
- ASIN → NexiGo P610: https://us.amazon.com/NexiGo-Conference-Autofocus-Streaming-Education/dp/B0DQCFX9WN , https://www.amazon.ae/NexiGo-P610-PTZ-Webcam/dp/B0DQCFX9WN
- P610 product/specs (VISCA/RS232, macOS 10.10+, speeds): https://www.nexigo.com/products/nexigo-p610-ptz-camera-with-10x-optical-zoom , https://www.nexigo.com/pages/p610-support , https://www.bhphotovideo.com/c/product/1972440-REG/nexigo_nexigop610ptzcamera_p610_full_hd_ptz.html
- P620 manual with "UVC PTZ Control: Supported" (UVC 1.1/1.5): https://manuals.plus/nexigo/1080p-hd-smart-ptz-camera-manual-2
- Same-ODM (ADKIDO) manual, "UVC PTZ Control: Support", macOS/Linux: https://manuals.plus/nexigo/1080p-hd-smart-ptz-camera-manual
- Zoom camera control rides UVC PTZ: https://developers.zoom.us/docs/video-sdk/web/video-camera-controls/ , https://ptzoptics.com/remote-ptz-camera-controls-in-zoom-video-conferencing/
- macOS user-space UVC control precedent (no kernel conflict): https://github.com/mrRay/VVUVCKit , https://obsproject.com/forum/threads/ptz-camera-control-over-usb-using-uvc-protocol-macos-bigsur.145723/
- VISCA protocol (9600 8N1, velocity drive, daisy-chain): https://en.wikipedia.org/wiki/VISCA_Protocol , https://www.prisual.us/blogs/camera-control/serial-control-e-g-rs232-rs485-visca
- Repo facts: explored read-only from the patchtogether repo checkout (files cited inline above).

---

## Hardware probe results (2026-08-29, owner's machine, camera in hand)

**Descriptor dump (uvc-caps.c, scratchpad):** P610 CameraTerminal bmControls `6a 1e 02` —
declares **Zoom (Absolute)**, **PanTilt (Absolute)**, both Relative variants, Focus abs/rel/auto,
AE mode, Exposure Time abs. Six vendor EXTENSION_UNITs present. Full UVC PTZ firmware. ✔

**Browser check:** `edge://media-internals` Video Capture → Pan-Tilt-Zoom = **N/A** despite the
descriptors — Chromium/macOS never surfaces the controls.

**Control probe (uvc-zoom-probe.c):** `USBInterfaceOpen` → `0xe00002c5` kIOReturnExclusiveAccess
(macOS 26 kernel UVC driver owns the VideoControl interface — this is why Chromium's PTZ path,
which requires the open, reports nothing). **However bare EP0 class requests on the unopened
interface WORK**: GET_MIN/MAX/RES/CUR zoom → 0–3040 step 1; SET_CUR accepted and visibly moved
the head, restore accepted. **User-space PTZ control is proven on this exact stack.**

**Revised verdict:** golden path (in-browser constraints) is DEAD on macOS 26 for this device;
**helper app path is PROVEN**. Candidate transports: (a) virtual CoreMIDI device "PT-PTZ"
(sysex/14-bit CC → UVC writes; zero new app transport, rides existing MIDI plumbing + permission),
(b) localhost WebSocket helper. Pan/tilt = CT_PANTILT_ABSOLUTE_CONTROL 0x0D, 8 bytes
(int32 pan, int32 tilt), same request pattern as the proven zoom writes.
