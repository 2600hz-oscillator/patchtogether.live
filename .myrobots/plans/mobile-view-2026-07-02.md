# BUILD SPEC — patchtogether.live MOBILE PROTOTYPE (`/m`): Glitch Cam + Pocket Modular

Single branch, single build agent. Two experiences as alternative VIEWS over the existing store/engine — zero engine forks, zero module-def edits, zero contract changes. Where the three designs conflicted, the decision + one-line rationale is inline, marked **DECISION**.

Governing constraint (verified): the WebGL attest basis walks `packages/web/src/lib/video/**` and `packages/web/src/lib/ui/modules/**` (`scripts/webgl-attest-lib.ts:231,237`). ALL new code lives in `packages/web/src/routes/m/**` and `packages/web/src/lib/mobile/**`. The only shared-file edits allowed are the four listed in §8.

---

## 1) Route map + server config

```
/m           chooser — static, no engine. Two full-height tiles: GLITCH CAM / POCKET MODULAR.
             Tiles link with data-sveltekit-reload (store is a module-scope singleton,
             graph/store.ts:42-50 — SPA nav would leak cam nodes into synth scenes).
/m/cam       glitch cam — one screen, overlay states: intro / live / permission-denied.
/m/synth     pocket modular — transport header + 3 bottom tabs: RACK / PATCH / MIX.
```

- Each of `/m/cam` + `/m/synth` gets a `+page.ts` with `ssr = false; csr = true; prerender = false` — copy `packages/web/src/routes/rack/+page.ts:7-9` verbatim (prerender=false also keeps the route on `_worker.js` so betaGate runs). `/m` chooser can prerender=false too for simplicity.
- **COOP/COEP**: already global via `packages/web/_headers:1-3` (`/*` → COOP same-origin + COEP credentialless) and `vite.config.ts:78-100`; route sets in hooks are belt-and-suspenders only (hooks.server.ts:122-127). Still add `'/m/cam'` and `'/m/synth'` to `ISOLATED_EXACT` (hooks.server.ts:159) and extend `packages/web/src/hooks.server.test.ts` (describe block at line 32) — parity with `/rack`/`/present`.
- **Beta gate**: do NOTHING. `/m*` is not in `BETA_GATE_PUBLIC_PATHS` (hooks.server.ts:188) → stays gated. Owner opens `https://pr-<N>.patchtogether-live-autotest.pages.dev/m` with `beta:2600hz` (deploy.yml:389-404). e2e auto-attaches creds via `httpCredentials`.
- **Clerk**: do NOTHING. `/m` is not in `AUTH_PREFIXES` (hooks.server.ts:37; `+layout.svelte:408-420`) → anonymous, no Clerk bundle, like `/rack`. Do not add it.
- **app.html**: extend the viewport meta (line 5) with `viewport-fit=cover` (safe-area insets). Do NOT add `maximum-scale=1` globally (accessibility); instead keep all mobile inputs ≥16px font to prevent iOS focus-zoom.

---

## 2) Architecture: hosting store + engine + cards without Canvas

### Store
Default scratch singleton, no `bindRackspace` (the `/rack` precedent). Import live bindings, never capture: `import { patch, ydoc, undoManager, LOCAL_ORIGIN } from '$lib/graph/store'`. Reactivity in every mobile view = the card-standard version-counter pump on `ydoc.on('update')` (MatrixMixCard.svelte:48-53).

### Engine boot — `$lib/mobile/mobile-host.ts`
Replicate Canvas's `ensureEngine` (~40 lines, Canvas.svelte:4399-4460; all callees are lib):
- `new AudioContext({ latencyHint: 0.045, sampleRate: 48000 })` — 48 kHz pin is mandatory (Canvas:4414-4419). **DECISION: hard-code Stable 45 ms on mobile** (all three designs agree) — the owner's drag-glitch is an output underrun and phone+video is the worst-case profile (`audio-latency-store.svelte.ts:44-69`).
- `navigator.audioSession.type = 'playback'` when present (iOS silent switch).
- `new PatchEngine()` + `registerDomain(new AudioEngine(ctx))` + try/catch `new VideoEngine(...)` (audio must survive missing WebGL2, Canvas:4434-4448) + `attachReconciler(e)` + `setActiveEngine(e)`. Memoized boot promise; dispose on route destroy (Canvas:4930-4939 pattern).
- MUST side-effect-import the barrels `$lib/audio/modules`, `$lib/video/modules`, `$lib/meta/modules` (Canvas:105-114) or the registries are empty.
- Also exports the three unexported Canvas recipes reimplemented locally: `spawnModule(type)` (def lookup across 3 registries → `canAddModule` → `wouldExceedCap` from `$lib/graph/cap` → id `` `${type}-${crypto.randomUUID().slice(0,8)}` `` → `nextDefaultName` → one `LOCAL_ORIGIN` transact writing `patch.nodes[id]` → `void ensureEngine()`; Canvas:4263-4271), `deleteNode(id)` (refuse `def.undeletable`; delete touching edges + node in one transact; Canvas:3944-3973), `unpatchNode(id)`.
- Page roots call `provideEngineContext` (`$lib/audio/engine-context.ts`) + first tap funnels through `createAudioGate().resume()` with the existing `<AudioGate>` overlay component (`audio-gate.svelte.ts:104-133`; `/r/[id]` wiring precedent).

### Cards — **DECISION: CardStage (single-node real `<SvelteFlow>`), not a bespoke generic faceplate**
Cards CANNOT mount bare: PatchPanel (inside 185/201 cards) calls `useStore()` and renders `<Handle>`s, both of which throw outside a flow (PatchPanel.svelte:49,563,699-716; xyflow Handle.svelte:37), and BentboxCard +17 others use runtime xyflow APIs. A one-node flow reuses all cards **unmodified** — zero edits under `lib/ui/modules/**` (attest basis) and zero desktop risk; the touch-first design's generic MobileFaceplate is a bigger build for a worse prototype (rebuilds 15 UIs, loses scopes/quicksave/status machines).

`$lib/mobile/CardStage.svelte` (~80 lines):
- `<SvelteFlow>` with exactly one node `{ id, type, position:{x:0,y:0}, data:{ node } }` (Canvas:845-851 shape), `nodeTypes` from the existing `buildNodeTypes` (`modules-card-map.ts`), `nodesDraggable={false}`, pan/zoom disabled, `preventScrolling={false}`.
- **1:1 rendering always** (no fitView scale-down — scaling shrinks the sequencer's 22px targets and its 16px inputs below the iOS zoom floor). Cards >370px wide render inside an `overflow-x: auto` container sized to the card's natural width, with an edge-fade scroll hint.
- Host-scoped CSS hides the PatchPanel corner patch-trigger (its `patchpanel:*` CustomEvents have no listener outside Canvas — PatchPanel:408-439; patching is matrix-only on mobile).

### Patching — matrixmix seam, no matrixMix node
All edge writes go through `createMatrixEdge` / `removeMatrixEdge` (`graph/matrixmix.ts:92-119,139-145` — shared `validateEdge`, replace-on-input, one `LOCAL_ORIGIN` transact) and classification through the pure core `jacksForDef` / `classifyCell` (`ui/matrixmix-grid.ts:34,202`). **DECISION: no matrixMix node in mobile scenes and no axis persistence** (`setXAxisModule` skipped; rail selection is component state) — the findings bless this (matrixmix-deep §5) and it avoids meta-node litter in docs opened on desktop. Undo is free (`undoManager`, store.ts:39,66-75).

---

## 3) Pocket modular (`/m/synth`)

### Shell
- Header (44px): scene name • TIMELORDE mini-transport — BPM value + run toggle via `setNodeParam(timelordeId,'bpm'|'running', v)` • UNDO button (`undoManager.undo()`).
- Bottom tab bar (56px + `env(safe-area-inset-bottom)`): **RACK / PATCH / MIX**. **DECISION: 3 tabs** (module list + pager share RACK) — fewer top-level destinations, list→faceplate is one flow.

### Boot / first-run
Start card over an empty doc, two buttons:
- **FIRST BLEEP** (big, default) — one tap = audio-gate gesture + `ensureEngine` + ONE transact spawning + wiring the template: `sequencer.pitch→analogVco.pitch`, `sequencer.gate→adsr.gate`, `analogVco.saw→vca.audio`, `adsr.env→vca.cv`, `vca.audio→delay.in`, `delay.out→mixmstrs ch1L AND ch1R` (mono double-patch), `mixmstrs.masterL/R→audioOut.L/R`, plus `timelorde`; set `sequencer.isPlaying=1`. Ship a vitest running `validateGraphFragment` over the template so a port rename fails the unit lane, not the phone. If seeding a step pattern via the transport-helpers `node.data` shape fights back, CUT the seed and land on the sequencer faceplate with a "tap some steps" hint (sound is 2 taps away).
- **empty rack** (small) — spawns only timelorde + mixmstrs + audioOut, pre-wires `masterL/R→audioOut` via `createMatrixEdge`. Nothing on mobile is silent-by-default.
- If a saved envelope exists (see §6 keep-list): a third "restore last session" button.

### RACK tab — list, add, remove, pager
- Top: horizontally scrolling module **chip strip** (spawn order, current highlighted). Below: **CardStage pager**, ONE page mounted at a time (hard rule — caps rAF load; never mounts MixmstrsCard's 61 Knob rAF loops). Chevrons ‹ › (44px) + chip taps navigate; card body does NOT swipe (every card control is a `touch-action:none` drag surface — gesture collision).
- **mixmstrs and matrixMix never mount in the pager**: mixmstrs chip jumps to MIX; matrixMix (only present in imported desktop docs) is hidden.
- **bentbox**: on spawn write `data.width = data.height = 370` once (card honors persisted dims, BentboxCard:49-50) — fits natively forever.
- **Add**: floating [+] (56px, bottom-right) → full-screen sheet; hardcoded `MOBILE_MODULE_TYPES = ['sequencer','analogVco','adsr','vca','delay','reverb','drummergirl','mixmstrs','audioIn','audioOut','cameraInput','bentbox','timelorde']` grouped Sound/Shape/Sequence/Mix/Video; each tile = lowercase label + existing `DESCRIPTIONS` one-liner (`docs/module-manifest.ts`). Cap-blocked tiles disabled with "4/4" (`wouldExceedCap`; cameraInput max 4, timelorde max 1). Tap = `spawnModule` → pager opens the new module → toast "wire it up in PATCH".
- **Remove**: "…" in the pager header → sheet "Remove DELAY? 2 cables will be disconnected." → [Disconnect all] / [Remove (red)] → the `deleteNode`/`unpatchNode` transacts + undo pill. Timelorde (`def.undeletable`): hide the affordance entirely.

### PATCH tab — the mobile matrix
**DECISION: keep the two-module FROM→TO pair grid** (touch-first + reuse-first) rather than flow-first's source-jack→destination-list — it reuses the pure core's mental model 1:1, and the pair grid gives spatial scan-ability the list lacks; the scene overview gap is closed by the ALL-CABLES toggle below.

Layout (top→bottom):
1. Header: "PATCH" • **ALL CABLES** toggle (top-right) • "show incompatible" toggle (off).
2. **Grid**: columns = FROM module's **outputs** (sticky top header; outputs are the scarce side — max 14 on timelorde), rows = TO module's **inputs** (sticky left labels; vertical scroll is the cheap axis). **48×48px cells** (desktop's 30×26 is under the touch floor, MatrixMixCard:455-459). Pre-filter to outputs×inputs only (`jacksForDef` emits ALL jacks; ~half the desktop grid is dead). Type-incompatible rows hidden by default with a footer "N incompatible inputs hidden".
3. **MIXMSTRS TO-density**: segmented control `CH1…CH6 · RET · MASTER-CV` scoping the 77 inputs to one section (16 audio + 61 CV, mixmstrs.ts:155-166); per-section CV inputs collapsed behind a "+ cv" expander. Default CH1.
4. **Stereo-pair rows** (minimal version): `ch{N}L/R`, `ret{1,2}L/R`, and audioOut `L/R` render as ONE combined "L+R" row with an expand chevron. Tap from a mono source = two `createMatrixEdge` calls (both sides); from a recognizable stereo pair (`masterL/R`, `audio_l/r_out`, `send{N}L/R`) = L→L, R→R. Matches the queued stereo-autowire direction (memory `project_stereo_autowire_rework`).
5. **Pair selector in the THUMB zone** (directly above the tab bar, not at the top): two 56px chips `FROM [analog vco ▾] → [mixmstrs ▾] TO` + ⇄ swap. Chip tap = full-screen module picker (64px rows, `resolveDisplayName` + jack-count + type dots). ◀ ▶ chevrons on each chip step modules without the sheet.

Cell language (from `classifyCell`'s 5 kinds, matrixmix-grid.ts:45-59):

| kind | render | tap |
|---|---|---|
| `legalEmpty` | hollow ring | patch immediately (`createMatrixEdge`), `navigator.vibrate(10)` — the sound is the confirmation |
| `direct` | solid dot, `--cable-<type>` color | unpatch immediately (`removeMatrixEdge`) + 4s undo pill — no confirm; undo is free |
| `inputTaken` | dim dot + ↷ badge | bottom sheet with `confirmMessageFor` text (matrixmix-grid.ts:279) → [Replace] (56px, thumb zone) / [Cancel] — replaces `window.confirm` |
| `outputFanout` | ring + fan badge | patch immediately + informational toast — non-destructive, **no confirm** (desktop's confirm is undo-less friction) |
| `illegal` | blank, inert | — |

Long-press a cell = inspect sheet (endpoints, cable type, UNPATCH). Long-press a header = jump to that module's faceplate.

**ALL CABLES view**: `Object.values(patch.edges)` as 56px rows `analog vco · saw → mixmstrs · ch1L` colored by cableType; ✕ = `removeMatrixEdge`; tap = focus the pair rails on that edge. ~40 lines, the whole-scene overview.

### MIX tab — MIXMSTRS lanes + channel detail
No card reuse — params are flat `ch{N}_*` ids in `node.params`; pure `setNodeParam`/`read` UI (mixmstrs-deep §5). Binds the first mixmstrs node; none → empty state + ADD.

**DECISION: horizontal full-width lanes, not 7 vertical faders** — 390/7 ≈ 55px columns can't hold fader+VU+mute+label at touch size and make tap-a-lane vs drag-a-fader ambiguous; a full-width horizontal fader strip is an unmissable target.

- **Six 88px lanes** (ch1–6): label zone (tap → detail) | horizontal fader strip ~220px, **relative drag** (never jump-to-touch), **VU rendered as a fill bar behind the track** | 56×56 MUTE flush right. Long-press strip = reset to default.
- **MASTER lane pinned bottom**, above the tab bar (best thumb position): `master_volume` + master VU from the singleton audioOut's `outputSnapshot` analyser (audio-out.ts:149-153; RMS math per host.ts:168-178). If time is short, master VU is the first cut.
- Fader wiring: read `node.params['ch'+N+'_volume']` (fallback 0.8); write `setNodeParam` **through `createDragCommit`** (`$lib/ui/controls/drag-commit.ts` — mandatory; raw per-move writes flood the snapshot bus).
- Meters: **ONE** `onMeterFrame` subscription (`meter-frame.ts:86-103` — private rAF loops caused the underrun regression) reading `engine.read(mxNode,'levels') → number[6]` post-fader RMS (mixmstrs.ts:299-332). First on-screen consumer of the tap. Do NOT copy Electra's `ch>4` clamp bug (host.ts:181).
- **MUTE — no param exists** (def has no mute/pan/solo; Electra reserves the row). **DECISION: volume-write + stash in `node.data['ch'+N+'_muteStash']` via `mutateNode`** (in-place, mutate.ts:73) — syncs to peers so two clients can't fight a view-local stash; desktop truthfully shows volume 0. Known tradeoff: CV into the volume input defeats it. Real `ch{N}_mute` param = deliberate follow-up PR (contract change → `docs:accept` + re-pin; also unblocks the Electra mute row).

**Channel detail** (push/sheet on lane tap; ◀ ▶ channel chevrons): all 10 real params from `buildParams` (mixmstrs.ts:118-129), full-width 44px horizontal sliders, top→bottom: VOLUME (+inline VU) → EQ LOW/MID/HIGH (±12 dB, center-detent render, tap-label-to-zero) → **COMP = the one-knob `comp{N}` macro** (fans to enable/thresh/ratio via `mapCompMacro`, mixmstrs.ts:84-97 — built for exactly this) with "advanced ▾" exposing thresh/ratio/compEnable → SENDS S1/S2. Values read on open + on doc updates; no per-control live-CV rAF readback in the prototype.

---

## 4) Glitch cam (`/m/cam`)

One screen; the scene is a REAL patch in the same store/engine.

**Boot (State A — intro)**: big "OPEN CAMERA" button. That one tap = `audioGate.resume()` → `ensureEngine` → `navigator.wakeLock.request('screen')` (net-new ~15 lines; re-request on `visibilitychange`) → one transact spawning `cameraInput → bentbox → recorderbox` wired via `createMatrixEdge` (`camera.out→bentbox.in`, `bentbox.out→recorderbox.in`) → camera acquisition.

**Camera acquisition**: **DECISION: extend the shared `acquireCameraStream`** (`$lib/ui/camera-acquire.ts:45-55` — NOT in any attest basis, unlike `lib/video/**`) with an optional `facingMode?: 'user'|'environment'` folded into the constraint builder (+unit test). `facingMode` appears nowhere in the repo and deviceId-only selection can't do front/back on iOS (labels empty pre-permission). Default `environment`. The mobile page owns a hidden `<video>`, hands it to the module via the engine handle → `attachExternalSource('video', el)` (engine.ts:770-777; camera-input.ts:471-484) — rVFC upload + decode keep-alive come free. FLIP button (top-right + bottom-left duplicate) toggles facingMode + re-acquires; the existing `NotReadableError` bare-retry seam (300 ms, camera-acquire.ts:64-77) is preserved. Track-`ended` + `visibilitychange` → re-acquire (iOS kills tracks on backgrounding; CameraInputCard:244-251 precedent). Permission denied → State C explainer + retry (mirror CameraInputCard:186-204 error mapping).

**Display (State B — live)**: **DECISION: direct in-page canvas blit, NOT `/present` and NOT the Fullscreen API** — the popup path is desktop-only (gated on `getScreenDetails`, use-fullscreen.svelte.ts:197-203) and iPhone Safari has no element `requestFullscreen`. Full-viewport 2D canvas (`100dvh` + `env(safe-area-inset-*)`, DPR-capped at 2), rAF loop = `videoEngine.blitOutputToDrawingBuffer(bentboxNodeId)` + cover-crop `drawImage(videoEngine.canvas)` — the exact card primitive (engine.ts:1033-1055; VideoOutCard:213-268). `getContext('2d')` only (a mobile `getContext('webgl')` would trip the fail-closed WebGL coverage scan). Blit bentbox, not recorderbox, so display is recorder-independent.

**Overlay** (auto-hides after 3 s, tap wakes):
- **REC** 72px circle, bottom-center. Tap → `mutateNode(recNode, d => d.recording = !d.recording)` — the card's own designed toggle seam (RecorderboxCard:144-148, `$effect` 246-253). **DECISION: the record lifecycle runs in a real `RecorderboxCard` mounted hidden in a CardStage tray** (offscreen-translated ⚙ sheet, kept mounted) — reuses the ENTIRE tested pipeline (probe, `pickEncodeProfile`, WebCodecs/mediabunny, OPFS chunking, crash recovery) with zero rewritten plumbing. Red pulse + mm:ss chip while hot.
- Encoder gate: the page runs `defaultCanEncodeVideo` once (recorder.ts:136-233, real encode smoke test — the same gate CI needs); failure → REC disabled + "no encoder" caption (old iOS degrades to a disabled button, never a crash).
- **Glitch strip** (translucent, scrollable, thumb zone): **DECISION: 6 single-param sliders, not UI-side macros** — simpler, zero fanout logic, and defaults already look CRT-alive (bloom 0.4 / noise 0.05): `wavefold` (SOLARIZE), `hsync_loss` (TEAR), `chroma_phase` (HUE), `feedback_gain` (TRAILS), `noise`, `master_gain` — the documented most-dramatic set (bentbox.ts:445-487) — plus MIRROR X / MIRROR Y chips (`mirrorX`/`mirrorY` params). All `setNodeParam` + drag-commit.
- Top: [×] exit (left), FLIP (right), ⚙ (device-list sheet for capture cards, post-permission only).

**Save**: v1 skips `showDirectoryPicker` everywhere — record to OPFS/memory + `<a download>` blob on stop (the existing null-picker fallback, recorderbox-save-flow.ts:104-133; surfaces the iOS share sheet). Filename preset `glitchcam`, no text entry. Audio is NOT patched in v1 (video-only MP4; iOS AAC AudioEncoder is ~18.4+ anyway).

Perf ladder if the phone chokes, in order: 45 ms buffer (already default) → `VideoEngine.setResolution` down-step (live-mutable, engine.ts:786-866; boot cam at 960×540) → recorder already CFR-30 + prefer-hardware.

---

## 5) Mobile platform notes (apply to all `/m` routes)

- **Audio gesture**: every experience opens with a full-screen tap-to-start funneling through `audioGate.resume()`; `bind()` watches `statechange` (iOS suspends on backgrounding). On `/m/cam` the same gesture also fires getUserMedia + wake lock.
- **iOS silent switch**: `navigator.audioSession.type = 'playback'` in boot when available.
- **No Fullscreen API on iPhone**: all "fullscreen" is CSS — `100dvh` + `env(safe-area-inset-*)` (global.css:448 dvh precedent), `viewport-fit=cover`.
- **Touch CSS**: `touch-action: manipulation` on all non-control chrome (kills double-tap zoom; cards' own controls already carry `touch-action:none`); `input { font-size: 16px }` floor (iOS focus-zoom); all NEW controls ≥44px targets, relative drag, long-press = reset (replaces dblclick/wheel/right-click, which are simply absent on mobile — accepted).
- **Wake lock**: `/m/cam` only (in-gesture request + `visibilitychange` re-request). Synth route: cut.
- **iOS runs un-isolated** (COEP `credentialless` unsupported → `crossOriginIsolated===false`, no SAB). Fine — nothing in the engine constructs a SAB — but no mobile feature may assume isolation; the e2e `crossOriginIsolated` assert runs on desktop-Chromium CI only.

---

## 6) Prototype scope — explicit cuts

OUT (each with its re-entry path):
1. `ch{N}_mute` param — UI mute now; own small contract-change PR later (also fixes Electra).
2. Sequencer mobile re-layout (8×2 pad grid) — 1:1 + horizontal scroll stands.
3. Mic/audio into cam recordings — video-only MP4; audioIn→recorderbox later.
4. `showDirectoryPicker` folder flow, chunk-management UI, crash-recovery list UI on mobile — download fallback only (recovery still runs inside the hidden card).
5. Multiplayer `/m` over `/r/[id]` — scratch store only; `bindRackspace` is mechanical later.
6. PWA manifest / service worker / installability / theme-color — PR-preview URL is the delivery.
7. Touch-size (`size="touch"`) props on shared Fader/Knob — cards stay fiddly-but-functional.
8. Live-CV rAF readback on mobile controls; DICE randomizer; master VU if time-pressed; landscape layouts; matrixMix axis persistence; desktop-card generic-faceplate rewrite (permanently out — CardStage is the strategy).

KEEP despite pressure (cheap, high-value): localStorage envelope autosave on `visibilitychange` + "restore last session" on the start card (~20 lines via `makeEnvelope`/`loadEnvelopeIntoStore`, `graph/persistence.ts` — iOS evicts tabs and the doc is memory-only); wake lock on cam; the 45 ms latency default; the undo pill; the FIRST BLEEP template test.

---

## 7) Test plan (repo conventions; landing PR #995 is the template)

**e2e** (auto-enroll in the 10-shard matrix; file-top `test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })` — per-spec, NEVER a new project in `e2e/playwright.config.ts`, which is in BOTH attest hash bases):
- `e2e/tests/mobile-synth.spec.ts` — `/m/synth` returns 200; `crossOriginIsolated === true`; desktop canvas absent (`[data-testid="canvas-root"]` count 0); FIRST BLEEP → **assert audible RMS through the REAL chain** (real-source-chain doctrine); then one matrix tap (e.g. add reverb, patch it) and RMS persists; mute → lane RMS drops; undo restores.
- `e2e/tests/mobile-cam.spec.ts` — inject `globalThis.__camerainputTestFrame` via `page.addInitScript` (camera-input.ts:124-139 — full GL path, no getUserMedia); assert the fullscreen canvas is non-black (renderer-tolerant pixel assert — SwiftShader) and pixels change when the SOLARIZE slider moves; ALL record asserts gated on the encoder probe / `isConfigSupported` (CI has no OS H.264 encoder — recorderbox #687 precedent).
- Spec names are safe: no `video-*`/`toybox-*`/other `WEBGL_HEAVY_GLOBS` match.

**VRT**: `e2e/vrt/mobile.spec.ts` — mobile viewport set in-spec, `deviceScaleFactor: 1`; 2 scenes (synth PATCH tab, MIX lanes; cam is all-canvas — skip or fully mask). Mask ALL canvases/VUs/version stamps (`maskColor '#ff00ff'`); reuse `pinVrtFonts` + the height-stability settle loop from `e2e/vrt/landing.spec.ts`. **+1 line**: append `'mobile.spec.ts'` to `FULL_MATCH` in `e2e/vrt/vrt.config.ts` (~line 44). Darwin baseline via `task vrt:update -- --grep mobile`, spec-local `EXEMPT_BASELINE_PAIRS = new Set(['linux/<scene>'])` (landing.spec.ts:23-31 copy); linux via `vrt-update.yml` dispatch after. Cannot touch `vrt-strict` (STRICT_MATCH is `vrt.spec.ts` only).

**Unit (vitest)**: FIRST-BLEEP template `validateGraphFragment` test; `hooks.server.test.ts` extension for the new ISOLATED entries; `camera-acquire` facingMode constraint test; mute-stash logic test (real Y.Doc per the yjs-save-load rule, never mocks).

**Footgun warnings (hard rules)**: NEVER write the literal `@collab` or `@capacity` strings anywhere in any new file, comments included — `resolveCollabSpecs` content-greps every spec and a match drags it into the required collab-attest basis (write "collab" bare). Don't edit `e2e/playwright.config.ts`, `_helpers.ts`, `_drivers.ts`, `_registry.ts`, `_collab-helpers.ts` — need a helper? create `e2e/tests/_mobile-helpers.ts`. Don't touch `lib/video/**` or `lib/ui/modules/**`.

**Local verification before push**: `flox activate -- task typecheck`; `task e2e:serve` then `REPEAT=3 flox activate -- task e2e:one -- <each new spec>` (flake-check ×3 — the audible-RMS spec hardest); `REPEAT=3 task vrt:one -- <scene>`; prod build for `build-web`/prerender-crawl parity. CI wall-time delta: 2 light specs + 1 VRT file ≈ well under the 2-min flag threshold.

---

## 8) File-by-file build plan (build order)

**Phase 0 — plumbing**
1. `packages/web/src/app.html` — EDIT: `viewport-fit=cover` (shared edit 1/4).
2. `packages/web/src/hooks.server.ts` — EDIT: `'/m/cam'`,`'/m/synth'` in `ISOLATED_EXACT` (:159) (2/4). `packages/web/src/hooks.server.test.ts` — extend.
3. `packages/web/src/lib/mobile/mobile-host.ts` — NEW: ensureEngine clone (45 ms/48 k), barrel imports, spawn/delete/unpatch transacts, envelope autosave/restore.
4. `packages/web/src/lib/mobile/CardStage.svelte` — NEW: single-node SvelteFlow host + trigger-hiding CSS + oversize h-scroll.
5. `packages/web/src/lib/mobile/HSlider.svelte` + `LaneFader.svelte` — NEW: 44px+ touch sliders, relative drag, long-press reset, drag-commit wired.
6. `packages/web/src/routes/m/+page.svelte` — NEW: chooser (data-sveltekit-reload links); `+page.ts` flags.

**Phase 1 — glitch cam (smallest full flow, biggest wow)**
7. `packages/web/src/lib/ui/camera-acquire.ts` — EDIT: optional `facingMode` (3/4) + `camera-acquire.test.ts` addition.
8. `packages/web/src/lib/mobile/cam-source.ts` — NEW: hidden `<video>` acquire/attach/re-acquire/flip controller.
9. `packages/web/src/routes/m/cam/+page.svelte` + `+page.ts` — NEW: intro/live/denied states, blit loop, overlay, glitch strip, hidden RecorderboxCard tray, wake lock.
10. `e2e/tests/mobile-cam.spec.ts` — NEW.

**Phase 2 — pocket modular shell + rack**
11. `packages/web/src/lib/mobile/first-bleep.ts` — NEW: template edges + spawn transact; `first-bleep.test.ts` (validateGraphFragment).
12. `packages/web/src/routes/m/synth/+page.svelte` + `+page.ts` — NEW: start card, header/transport, tabs, toasts/undo pill.
13. `packages/web/src/lib/mobile/RackTab.svelte` + `AddModuleSheet.svelte` — NEW: chip strip, pager (CardStage), add/remove sheets, `MOBILE_MODULE_TYPES`.

**Phase 3 — matrix**
14. `packages/web/src/lib/mobile/MobileMatrix.svelte` (+ `matrix-mobile.ts` for stereo-pair/row-filter helpers + unit test) — NEW: pair rails, grid, cell semantics, sheets, ALL CABLES list, mixmstrs segmenting.

**Phase 4 — mix**
15. `packages/web/src/lib/mobile/MixLanes.svelte` + `ChannelDetail.svelte` (+ `mute-stash.ts` + test) — NEW: lanes, onMeterFrame VUs, mute stash, 10-param detail.

**Phase 5 — tests/baselines**
16. `e2e/tests/mobile-synth.spec.ts` — NEW. 17. `e2e/vrt/mobile.spec.ts` — NEW + `e2e/vrt/vrt.config.ts` FULL_MATCH +1 (4/4). 18. Darwin baselines + linux exemptions; typecheck + REPEAT=3 sweep; prod build.

Shared-file edit surface, total: `app.html`, `hooks.server.ts`(+test), `camera-acquire.ts`(+test), `vrt.config.ts`. Zero module defs, zero contract changes, zero attest-basis files.

---

## 9) OPEN QUESTIONS for the owner (build proceeds on the stated defaults)

1. **Mute semantics**: OK shipping UI-level mute (volume-0 + stash; CV into volume defeats it), with the real `ch{N}_mute` param as a follow-up contract PR? *Default: yes.*
2. **Glitch-cam audio**: is video-only recording acceptable for v1, or is phone-mic capture a must-have (adds audioIn→recorderbox wiring + iOS AAC ~18.4 dependency)? *Default: video-only.*
3. **Target device(s)**: iPhone Safari, Android Chrome, or both first-class? Drives on-device verification order and whether the REC-disabled state on older iOS is a blocker. *Default: iPhone-first, Chrome-Android verified second.*
4. **Sequencer at 1:1 + horizontal scroll** (soft-keyboard note entry) acceptable for the prototype, with the pad re-layout later? *Default: yes.*
5. **FIRST BLEEP template**: happy with the seq→vco→adsr/vca→delay→mixmstrs ch1 starter patch as the demo sound, or do you want drummergirl-led? *Default: as specced.*
6. **Persistence**: is silent envelope autosave + "restore last session" enough, or do you want an explicit save/share (.imp.json export) button in v1? *Default: autosave only.*
7. **Matrix model**: confirm two-module FROM→TO paging (with ALL-CABLES overview) over a single scene-wide destination list. *Default: pair grid.*
8. **MIX lanes horizontal** (full-width fader rows, master pinned bottom) rather than a 7-column vertical-fader mixer picture — confirm the ergonomics-over-metaphor call. *Default: horizontal.*