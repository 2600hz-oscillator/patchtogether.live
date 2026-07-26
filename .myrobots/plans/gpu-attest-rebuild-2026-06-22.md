# WebGL Attest Suite — Phased Rebuild Plan (2026-06-22)

> Goal: make the WebGL/GPU attest lane **deterministic and zero-flake** so it can
> be flipped to a REQUIRED gate with `retries=0` — without sacrificing the
> correctness coverage we actually care about. This plan converts a wall-clock
> guessing suite into a layered, freeze-driven, single-sample-immune suite.

---

## 1. Executive summary

The WebGL attest suite is flaky because the overwhelming majority of its
GPU/render assertions verify output by **betting on wall-clock time**:
`waitForTimeout(N)` then a one-shot `getImageData()`, or an `expect.poll` over a
fixed budget that samples a transient signal (a 10 ms gate pulse, an LFO phase, a
rAF-throttled frame) that may or may not exist at the instant of capture. None of
these assertions await a *deterministic readiness signal*; they all couple the
pass/fail to the macOS WindowServer / SwiftShader scheduler, which we do not
control. On `retries=0` on a real (or software) GPU, a single mistimed sample
flakes the whole lane.

We already have the cure half-built. The engine exposes a synchronous
`VideoEngine.step()` and a `globalThis.__videoEngineFreezeRender` flag, and
several modules expose per-module freeze/seed/readiness hooks
(`__toyboxFreeze`, `__wavesculptVrtFreeze`, `__videoEngineFreezeRender`,
`framesElapsed`, `uploadCount`, per-module `*VrtSeed`). The fix is to make
**"freeze the clock → drive a FIXED number of `step()` frames synchronously →
read the FBO once"** the *one and only* pattern for every GPU render-smoke, push
DSP/bridge *correctness* down into GPU-free pure-core unit tests, and delete the
wall-clock specs. Then the attest gate can drop retries and become required.

Headline counts (from the machine-gathered catalog):

- **602** `waitForTimeout` calls across **173 / 292** specs.
- **74** specs read raw pixels (`getImageData` / `readPixels`).
- Across the analyzed catalog rows, **~150 fragile assertions** were classified;
  the dominant mechanisms are `fixed-wait-then-oneshot-read`, `tight-poll`, and
  `animation-diff` — every one of them a timing bet.
- 4 *known* live failures on the serialized quiet-machine attest:
  `toybox-node-menu` (FIXED), `foxy` (FIXED), `wavesculpt` (budget too tight),
  `video-audio-cvgate` `doom-evt_gun_p1` + `doom-evt_kill` (STILL flaky).

---

## 2. THE COMMON ROOT CAUSE (one paragraph)

**Every flaky GPU assertion verifies render output by sampling an
un-synchronized signal on the wall clock instead of awaiting a deterministic
readiness anchor, so a single mistimed sample under scheduler jitter fails the
assertion.** Aggregated across the catalog, the fragile assertions cluster into
exactly three timing-bet mechanisms: **`fixed-wait-then-oneshot-read`**
(`waitForTimeout(400–1000)` → one `getImageData` → threshold; the single largest
class — `video-controls` 10×, `video-orientation` 6×, `video-chain` 2×,
`mandleblot` 2×, `quadralogical-video` 2×, `scope-video-out` 2×, `wavecel` 2×,
`b3ntb0x` 2×, `camera-input` 2×, `cube` 3×, `videobox-output` 4×,
`videovarispeed-perf` 2×), **`tight-poll`** (an `expect.poll` / sleep-loop over
a fixed budget that samples a transient — `4plexvid` 5×, `synesthesia-composite`
14×, `synesthesia-video-mode` 6×, `freezeframe` 5×, `render-worker-toybox` 6×,
`render-worker-acidwarp` 3×, `wavesculpt` 13×, `wavesculpt-*` 4–7×,
`video-aspect-switch` 3×, `multi-video-playback` 5×, the `toybox-node-*` Yjs
polls), and **`animation-diff`** (assert two timing-dependent captures *differ*
— `quadralogical-video`, `toybox-new-content`, `toybox-shadertoy`,
`video-phase1`, `foxy`). The single worst structural offender is
**`video-audio-cvgate-coverage`**: it fires a ~10 ms gate pulse and polls a
~43 ms `AnalyserNode` window — two clocks that *must coincide* for a HIGH sample
to be captured, which is an irreducible race no budget can fix. The cure is the
same for all three: pin the clock, advance a fixed frame count synchronously,
read once — and for the bridge cases, drop the rendered-signal sampling
entirely in favor of asserting the dispatch topology.

---

## 3. Fragile spec → mechanism → deterministic replacement

> "DRS" = deterministic render-smoke (freeze → step N → read once via
> `gl.readPixels` on the FBO). "PCU" = pure-core unit test (GPU-free). "DBU" =
> deterministic bridge unit test (assert connect/disconnect topology). "OAC" =
> OfflineAudioContext ART render (held signal, fixed-index read).

| Spec | Fragile mechanism(s) | Deterministic replacement |
|---|---|---|
| `4plexvid.spec.ts` | tight-poll (5× `waitForLuma`) | DRS: freeze, fire gate via `setParam` step-deterministic, step N, read each of 4 output FBOs once; gate-advance index is pure function of step count |
| `b3ntb0x.spec.ts` | fixed-wait + animation-diff (2×) | DRS — **see §5B reference exemplar verbatim** (already designed) |
| `freezeframe.spec.ts` | tight-poll (5×) | Keep the 9 deterministic-hook/`stepAndSample` assertions; convert the 3 `waitForMoving`/`waitForFrozen` + 2 `waitForCondition` to DRS via `engine.step()` + `read('holdSeeded')` (hooks already present) |
| `mandleblot.spec.ts` | fixed-wait (2×) | DRS: add `__mandleblotClockFreeze` + `read('framesElapsed')`, then freeze→step N→readPixels variance/nonZero |
| `multi-video-playback.spec.ts` | tight-poll (5×) | Keep the 2 deterministic `uploadCount`/`uploadDeltasOverSteps` hooks; replace the 3 `outAdvances` pixel polls + audio poll with DRS (per-source `uploadCount` delta) + OAC peak check |
| `quadralogical-assign.spec.ts` | none (0 fragile) | **No change** — exemplar of correct pattern (Yjs-settlement `expect.poll`, `__videoEngineFreezeRender`) |
| `quadralogical-video.spec.ts` (`quadralogical.spec.ts`) | fixed-wait (2×) + animation-diff (2×) | DRS for corner-dominance + preview; for per-edge-fx "differs": freeze→step N with fx=A→read, freeze→step N with fx=B→read, compare two FROZEN samples (deterministic diff, not animation-diff) |
| `render-worker-acidwarp.spec.ts` | tight-poll (3×) | DRS via `engine.step()`; acidwarp needs `__acidwarpFreezeTime` (has seed+readiness already) |
| `render-worker-toybox.spec.ts` | tight-poll (6×) | DRS; toybox freeze/step/readiness all present — drop the `outputStats` poll for `step()`+readPixels |
| `scope-video-out.spec.ts` | fixed-wait (2×) + animation-diff (1×) | Split: DSP correctness (waveform → trace) to PCU on the scope draw helpers; video presence to DRS after adding `__scopeVrtFreeze` + `read('framesElapsed')` (seed already present) |
| `synesthesia-video-mode.spec.ts` | tight-poll (6×) | PCU on the worklet's sample-and-hold meter math (deterministic snapshot); DRS for the raster-band video outputs after adding `__synesthesiaVrtFreeze` + step path |
| `synesthesia-composite.spec.ts` | tight-poll (14×) + one-shot (heavy) | **PCU** — band-energy mapping is FFT-bin math on a known tone; move to OAC/offline render + `maxBandLevels` on a rendered buffer at fixed indices (no live analyser poll) |
| `toybox-combine-editor.spec.ts` | none (0 fragile) | **No change** — exemplar (`__toyboxFreeze` + lit-pixel readiness) |
| `toybox-cv-section.spec.ts` | fixed-wait (2× `waitFor` timeouts) | Replace `waitFor visible` + badge-attr timeout with `expect.poll` on Yjs `cvRoutes` state (deterministic, already partially used) |
| `toybox-disk-loading.spec.ts` | none (0 fragile) | **No change** — generous SwiftShader-tuned polls + `__toyboxFreeze` |
| `toybox-feedback.spec.ts` | none (0 fragile) | **No change** — `stepAndAverage`/`advance` deterministic |
| `toybox-layer-input.spec.ts` | none (0 fragile) | **No change** — `frozenAverage` deterministic |
| `toybox-layer-selector.spec.ts` | tight-poll (1×) + animation-diff (1×) | `expect.poll` on Yjs `layers[1]` keep; convert the `dist > 4` of two `frozenAverage` to compare-two-frozen (already frozen — tighten threshold rationale, not mechanism) |
| `toybox-new-content.spec.ts` | animation-diff (1×) | Two `freezeAndWaitLit` samples already frozen; assert signature inequality on frozen frames — keep but document as deterministic-diff |
| `toybox-node-batch.spec.ts` | tight-poll (2×: ADD-row, resize) | ADD-row: `dispatchEvent` + `expect.poll` on Yjs node insert (closeMenu helper pattern); resize: poll `combineView.h` (Yjs) — both data-layer, no GPU |
| `toybox-node-controls.spec.ts` | tight-poll (6×: knob-stick + delete) | Knob-stick polls are Yjs param reads — widen to data-settlement poll; snap-back read must `expect.poll` not sync-read-after-poll |
| `toybox-node-menu.spec.ts` | tight-poll (4×) | **FIXED** via `closeMenu` helper awaiting `toHaveCount(0)`; remaining `readCombine` polls are Yjs-settlement (deterministic-ish — keep, widen budget) |
| `toybox-presets-io.spec.ts` | tight-poll (2×) | Yjs `readLayers()[].contentId` polls — deterministic state, keep (no GPU) |
| `toybox-presets.spec.ts` | tight-poll (2×) | Yjs combine-graph node-id polls after `selectOption noWaitAfter` — add settlement anchor before poll |
| `toybox-shadertoy.spec.ts` | tight-poll (2×) + animation-diff (2×) | Convert `waitForFunction` lit-poll to `engine.step()` DRS; the click-to-grow diff already uses `ve.step()` loop + `__toyboxFreeze` — keep, assert frozen-vs-frozen |
| `toybox-video-inputs.spec.ts` | none (0 fragile) | **No change** — `frozenAverage` |
| `toybox-video-projection.spec.ts` | tight-poll (2×) | The 2 `expect.poll` on `surfaceMode` mutation → poll Yjs material state with explicit budget (data-layer) |
| `video-aspect-switch.spec.ts` | tight-poll (3×) | Engine-res reallocation: `readEngineRes()` already step-gated; convert the `expect.poll(width).toBe(N)` to step-deterministic read after `engine.step()` |
| `video-audio-cvgate-coverage.spec.ts` | fixed-wait + tight-poll (5×; doom-evt STILL flaky) | **DBU + OAC** — **see §5C**; delete the 3 doom-evt rows, prove dispatch topology + held-signal offline render |
| `video-audio-output.spec.ts` | tight-poll + fixed-wait (4×) | OAC: render videovarispeed audio → audioOut offline, read terminal peak at fixed indices; keep `audioWired`/`hasKeepAlive` deterministic flags |
| `video-chain.spec.ts` | fixed-wait (2×) | DRS: freeze→step N (≥30 to fill vdelay ring)→readPixels nonZero/variance |
| `video-controls.spec.ts` | fixed-wait + animation-diff (**10×** — worst) | DRS per module: freeze→step N→read(before); `setParam`; freeze→step N→read(after); `statsDiffer` on two FROZEN reads. Correctness of each shader is renderer-tolerant floor |
| `video-fullscreen.spec.ts` | fixed-wait + tight-poll (2×) | CSS state machine assertions keep; aspect-buffer realloc → step-gated `read` after `engine.step()`; drop the `getBoundingClientRect` vs `innerHeight` race (assert engine res, not OS layout) |
| `video-fullscreen-multimonitor.spec.ts` | tight-poll (2×) | `__fsCalls` spy poll — add a settle anchor (await menu click resolves) before poll; data-layer, no GPU |
| `video-full-frame.spec.ts` | none (0 fragile) | **No change** — structural + `readFullFrame` |
| `video-hide-controls.spec.ts` | tight-poll + dom-race (6×) | `dragCorner` → poll node.data size (Yjs) instead of sync-read; dblclick→menu race → `toBeVisible` with budget |
| `video-orientation.spec.ts` | fixed-wait + tight-poll (**15×**) | DRS: freeze→step N→`analyzeTriangleOrientation` on FROZEN frame (orientation is geometric, fully deterministic once frozen); the 3 deterministic video-readyState tests keep |
| `video-phase1.spec.ts` | tight-poll + animation-diff (3×) | CV-bridge correctness → PCU on the LFO→param mapping; the "pixels change over LFO" → DRS at two frozen LFO phases (set phase via freeze, not wall-clock) |
| `videobox-output.spec.ts` | fixed-wait + animation-diff (6×) | Keep the 6 deterministic `liveness`/`uploadCount`/`resolveInputSourceId` hooks; convert the `canvasStats` one-shots to DRS readPixels after `engine.step()` |
| `videobox-performance-bundle.spec.ts` | tight-poll (2×) | `nodeCount` polls are Yjs reconciliation — deterministic-ish, widen budget; no GPU |
| `videobox-upload-perf.spec.ts` | transient-event + fixed-wait (3×) | Keep `uploadsPerStep` deterministic guard; the rVFC decode + `gl.finish` FPS probes are inherently timing → gate local-only (already are) |
| `videovarispeed-output.spec.ts` | fixed-wait + dom-race (4×) | Loop-button toggles → `expect.poll`/`toHaveAttribute` (await state); time-window bounds → step-deterministic sampling |
| `videovarispeed-perfzip.spec.ts` | tight-poll (4×) | `nodeCount` Yjs polls — deterministic, widen budget; no GPU |
| `videovarispeed-switch.spec.ts` | tight-poll (6×) | Already renderer-independent (`uploadCount` hook); widen poll budgets, no pixel reads — these are deterministic counters under jitter, mostly budget tuning |
| `wavecel-viz.spec.ts` | tight-poll + fixed-wait (3×) | DRS: add `__wavecelVrtFreeze` + `read('framesElapsed')`; freeze→step N→read centroid once; spread test = two frozen reads |
| `wavecel.spec.ts` (`wavecel video out`) | fixed-wait (2×) | DRS after the same wavecel freeze/step/readiness hooks |
| `wavesculpt.spec.ts` | tight-poll + animation-diff (**13×**) | DRS via `__wavesculptVrtFreeze` (present) + a deterministic step path (NEEDS engine step wiring for wavesculpt's rAF); all 7 ribbon/spectro/trace polls → freeze→step→read once; the morph/mode diffs → two frozen reads |
| `wavesculpt-camera-cv.spec.ts` | tight-poll + animation-diff (4×) | Engine `readParam` stddev → PCU on the camera-CV mapping (deterministic, no GPU); histogram L1 → two frozen reads at two frozen LFO phases |
| `wavesculpt-spatial-audio.spec.ts` | tight-poll + fixed-wait + animation-diff (3×) | Audio RMS shift → OAC offline render at fixed camera positions; keep the deterministic `engine.read('camera')` convergence hook |
| `wavesculpt-state-unity.spec.ts` | tight-poll (7×) | PCU: `readParam`/`read('camera')`/`read('morph')` alignment is deterministic engine state — sample at FROZEN LFO phases (set via freeze) not wall-clock 100ms intervals |
| `cube.spec.ts` | fixed-wait (3×) | DRS: add `__cubeFreeze`/`__cubeStep` + `data-cube-ready`; freeze→step N→litPixels once; SCRN-off = frozen read of placeholder |
| `foxy.spec.ts` | tight-poll + animation-diff (3×; FIXED) | **FIXED via `expect.poll`**; foxy has `__foxyVrtSeed` (clock-freeze + seed + readiness). Audio bridge has no sync step → keep `expect.poll` with generous budget OR move band correctness to PCU |
| `camera-input.spec.ts` | fixed-wait (2×) | DRS after adding camera frame-ready signal + static test-frame injection (`__camerainputTestFrame`); inject fixed ImageData, step, read once |

---

## 4. Hook-gap inventory

Legend: ✅ present · ❌ missing · n/a not applicable (stateless/audio-async).

### 4a. GPU/video modules

| Module | clockFreeze | seed | syncFrameStep | readinessSignal | Gap to close for DRS |
|---|:--:|:--:|:--:|:--:|---|
| `shapes` | ❌ | n/a | ✅(engine) | ❌ | add `__shapesFreezeTime` (optional; time-agnostic) + `read('framesElapsed')` |
| `4plexvid` | ❌ | ❌ | ❌ | ❌ | add `read('framesElapsed')` + per-output ready + freeze + `gl.finish` |
| `videoOut` | ✅(engine) | ❌ | ✅ | ❌ | expose `read('framesElapsed')` + `data-readiness` |
| `b3ntb0x` | ❌ | ❌ | ✅ | ✅(`framesElapsed`) | add `__b3ntb0xFreezeTimeSec` (use `frame.time`) — **§5B** |
| `acidwarp` | ❌ | ✅ | ✅ | ✅ | add `__acidwarpFreezeTime` only |
| `freezeframe` | ✅ | ✅ | ✅ | ✅ | **complete** — already fully testable |
| `mandleblot` | ❌ | n/a | ✅ | ❌ | add `__mandleblotClockFreeze` + `read('framesElapsed')` |
| `videovarispeed` | ✅ | ❌ | ✅ | ✅ | add explicit `gl.finish`/sync barrier after step (optional) |
| `mixer`/`videoMixer` | ✅ | ❌ | ✅ | ❌ | expose `read('framesElapsed')` + `read('outputTexture:out')` |
| `quadralogical` | ✅(freeze param) | ❌ | ✅ | ❌ | add `read('framesElapsed')` / readiness; drop rAF wall-clock guard |
| `lines` | ❌ | ❌ | ✅ | ❌ | add `__linesFreeze` (use `frame.time`) + `read('framesElapsed')` |
| `chroma` | ✅ | ❌ | ✅ | ✅ | expose public frame counter; route reads via OUTPUT FBO |
| `toybox` | ✅(`__toyboxFreeze`) | ❌ | ✅ | ✅ | **complete** for DRS |
| `monoglitch` | ✅ | ❌ | ✅ | ❌ | expose `read('framesElapsed')` + `read('outputTexture:out')` |
| `ruttetra` | ❌ | ❌ | ✅ | ❌ | add `__ruttetraFreeze` (phase static) + `read('framesElapsed')` |
| `vdelay` | ❌ | ❌ | ❌ | ❌ | expose existing `framesElapsed` via `read()` + freeze |
| `inwards` | ❌ | ❌ | ✅ | ❌ | add `__inwardsFreeze` (uTime) + `read('frame')` |
| `destructor` | ✅(engine) | n/a | ✅ | ❌ | public frame-count accessor + `read('framesElapsed')` + readPixels helper |
| `luma` | ❌ | n/a | ✅ | ❌ | add `read('outputTexture')` + `read('framesElapsed')` (stateless processor) |
| `chromakey` | ❌ | n/a | ❌(engine only) | ❌ | add `read('framesElapsed')` (deterministic shader; engine-freeze covers time) |
| `lumakey` | ❌ | n/a | ❌ | ❌ | add `read('framesElapsed')`+`read('outputTexture:rgba')`; expose `engine.step()` |
| `colorizer` | ❌ | n/a | ❌ | ❌ | add `read('framesElapsed')` + `data-frames-elapsed` (stateless) |
| `feedback` | ✅(engine) | ❌ | ❌(private step) | ❌ | public `step()` + public frame counter + `gl.finish` + per-module readiness |
| `videobox` | ✅ | ❌ | ✅ | ✅(`uploadCount`) | add engine `setTime(sec)`/`__videoEngineFreezeTime` to pin animation phase |
| `bentbox` | ❌ | ❌ | ✅ | ✅(`framesElapsed`) | add `__bentboxFreezeTime` (override uTime) |
| `cameraInput` | ❌ | ❌ | ✅ | ❌ | add `__camerainputTestFrame` inject + `read('framesElapsed')`/`uploadCount` |
| `reshaper` | ❌ | ❌ | ✅ | ❌ | add `read('framesElapsed')` + `data-ready` (stateless remap) |
| `backdraft` | ✅(freeze param) | ❌ | ✅ | ✅(internal) | expose `freeze`/`framesElapsed`/`outputTexture:out` via `read()` |
| `picturebox` | ✅ | ❌ | ✅ | ❌ | add `read('framesElapsed')` + `data-ready` + `gl.finish` |
| `cube` | ❌ | ❌ | ❌(card rAF) | ✅(internal) | add `__cubeFreeze`/`__cubeStep` + expose `glReady && renderedOnce` as `data-cube-ready` |
| `wavesculpt` | ✅(`__wavesculptVrtFreeze`) | ❌ | ❌(card rAF) | ✅ | wire a sync step path (or `gl.finish` after one rAF) + export frame count |
| `wavecel` | ❌ | ❌ | ❌(card rAF) | ❌ | add `__wavecelVrtFreeze` + `read('framesElapsed')` + `data-frames-elapsed` |

### 4b. Audio / non-GPU modules (DRS not applicable — use PCU / OAC / DBU)

| Module | Note |
|---|---|
| `scope` | has seed; needs `__scopeVrtFreeze` + `read('framesElapsed')` IF the video-out is DRS'd; DSP correctness → PCU on `scope-draw.ts` |
| `audioOut` | audio sink; correctness via OAC (OfflineAudioContext) — no sync frame step possible |
| `analogVco` | audio; waveform draw correctness → PCU on `analog-vco-scope.ts`; needs `__analogVcoFreezeTime`+seed only if scope is VRT'd |
| `synesthesia` | audio worklet; meter math → PCU on snapshot; raster video-out → DRS after `__synesthesiaVrtFreeze` |
| `vca`, `adsr`, `lfo`, `sequencer`, `clipplayer` | audio; correctness → PCU on pure cores / OAC; not GPU render-smoke targets |
| `foxy` | hybrid; `__foxyVrtSeed` present (freeze+seed+readiness); audio bridge has no sync step → band correctness → PCU, video-out via seeded paint |
| `joystick`, `controlSurface`, `electraControl` | UI/meta, **not GPU modules** — assertions are DOM/Yjs (already deterministic) |

---

## 5. Target architecture (three layers)

The principle: **correctness lives in fast GPU-free unit tests; the GPU lane only
proves "it renders, deterministically, without GL errors."** Each module's
behavior is verified at the cheapest layer that can verify it.

### Layer A — correctness in GPU-free pure-core unit tests (PCU)

Anything that is *math* — a shader's color transform, an FFT-band mapping, a
camera-CV projection, an envelope, an orientation flip, a draw-helper's pixel
layout — gets extracted into a pure function and unit-tested with deterministic
inputs. No WebGL, no AudioContext, no scheduler. Examples already in-tree that
prove the pattern: `scope-draw.ts`, `analog-vco-scope.ts`, `lfo-state.ts`
(`computeLfoState`), `wavecel-draw.ts`. New PCUs to add per §3:
synesthesia band-energy mapping, wavesculpt camera-CV projection +
readParam/`read('camera')` alignment, video-phase1 LFO→param bridge,
scope waveform→trace, foxy band selection.

**Rule (folds into CLAUDE.md):** *DSP/mapping correctness → pure unit-tested
cores, never e2e pixel reads.* (Already a queued standard:
`feedback_e2e_quality_refactor`.)

### Layer B — ONE deterministic render-smoke per GPU module (DRS)

For each GPU module, exactly **one** e2e that proves the render pipeline
produces a non-black, structured, GL-error-free frame — deterministically. The
canonical shape, with the cure baked in:

1. `page.addInitScript` sets the module's freeze hook **before boot** so even the
   app's first `step()` reads the frozen clock.
2. Spawn a deterministic source (`shapes` — no decode/getUserMedia/asset) →
   module.
3. Inside **one** `page.evaluate` (no `await`/yield, so rAF/decode/blit can't
   interleave): drain GL errors, `for (i<FIXED_STEPS) vid.step()`, collect GL
   errors, bind `read(id,'fboTexture')` to a scratch FBO, `gl.readPixels` once,
   compute sparse luma stats, read `framesElapsed`.
4. Assert: `framesElapsed === FIXED_STEPS` (no missed/extra step), FBO complete,
   `glErrors == []`, `nonZeroFrac > 0.02` (floor), `variance > 15` (floor,
   renderer-tolerant), `errors == []`.

No `waitForTimeout`, no poll, no animation-diff, no exact-pixel assert. Floors +
counts only, so SwiftShader-vs-real-GPU divergence can't trip it while a genuine
black/flat/GL-error regression still fails. "Param visibly changes output" tests
become **two frozen reads** (freeze→step→read with param A; freeze→step→read with
param B; assert they differ) — a deterministic diff, not an animation-diff.

#### Reference exemplar 1 — animated pure-GL source (B3NTB0X)

> Verbatim from the machine-gathered reference (`ref:animated-gl-source`). This
> is the template every animated GPU module's DRS should follow.

```ts
// e2e/tests/b3ntb0x-render-smoke.spec.ts
//
// DETERMINISTIC render-smoke for B3NTB0X (an ANIMATED pure-GL video module).
//
// Replaces the flaky wall-clock pattern (spawn → waitForTimeout(600) → read the
// on-card canvas and hope enough rAF frames + enough decode cadence happened).
// That pattern couples the assertion to (a) headless Chromium's background-rAF
// throttling (~1 frame/sec under parallel workers), (b) the module's own
// performance.now() subcarrier-drift baseline, and (c) the card's rAF blit
// cadence — three independent timing races, none observable, all flaky on CI.
//
// Instead we: freeze the clock to a FIXED value, drive the engine a FIXED
// number of frames SYNCHRONOUSLY (mirrors videobox-upload-perf.spec.ts's
// `for (i<n) vid.step()` loop), then read the output ONCE and assert
// non-black + spatial structure + zero GL errors. No waitForTimeout, no poll,
// no animation-diff.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

// How many engine frames to advance before reading. FIXED + small. b3ntb0x is a
// 4-pass pipeline with ping-pong persistence/feedback + a 1-frame-cold bend
// baseline; a handful of steps fully warms every sentinel FBO (encode→bend→
// decode→CRT and both ping-pong pairs) to steady state. 8 is well past warm and
// keeps GL traffic trivial on CI's SwiftShader (no GPU watchdog risk).
const FIXED_STEPS = 8;
// The frozen subcarrier-drift time (seconds). Any constant works — the point is
// it's CONSTANT, so the encode pass's `uTime` (carrier phase) is identical on
// every run. Picked off-zero so drift-dependent terms are exercised, not the
// t=0 degenerate.
const FROZEN_TIME_SEC = 2.0;

test.describe('B3NTB0X — deterministic render smoke', () => {
  test('fixed-frame synchronous render → non-black, structured, zero GL errors', async ({ page }) => {
    // Heavy 8×-oversampled NTSC chain compiles slowly on CI's SwiftShader.
    test.setTimeout(60_000);

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Freeze the clock BEFORE the app boots so the very first engine.step() the
    // app fires already reads the frozen time (no transient real-clock frame).
    await page.addInitScript((t) => {
      (globalThis as unknown as { __b3ntb0xFreezeTimeSec?: number }).__b3ntb0xFreezeTimeSec = t;
    }, FROZEN_TIME_SEC);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Real source → b3ntb0x. SHAPES is a deterministic generated source (no
    // decode cadence, no getUserMedia, no asset fetch) so the ONLY thing that
    // could vary frame-to-frame is the module's own clock — which we've frozen.
    await spawnPatch(
      page,
      [
        { id: 'src', type: 'shapes',  position: { x: 100, y: 100 }, domain: 'video', params: { shape: 0, zoom: 1.4 } },
        // TBC=1 (rock-steady time-base), feedback=0, sub_drift=0 → no
        // intra-pipeline animation source other than uTime (which is frozen).
        { id: 'bb',  type: 'b3ntb0x', position: { x: 540, y: 100 }, domain: 'video',
          params: { tbc: 1, feedback: 0, sub_drift: 0 } },
      ],
      [
        { id: 'e_src', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'bb', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );

    await expect(page.locator('[data-testid="b3ntb0x-canvas"]'), 'canvas mounted').toHaveCount(1);

    // Drive the engine OURSELVES, synchronously, a FIXED number of times, then
    // read the CRT front-buffer's pixels ONCE via gl.readPixels — all inside a
    // single page.evaluate so the event loop never yields between steps (no rAF,
    // no decode callback, no card blit can interleave and perturb the frame).
    // Reading the engine FBO directly (not the on-card 2D canvas) removes the
    // card's rAF blit from the loop entirely.
    const stats = await page.evaluate(({ nSteps }) => {
      const w = globalThis as unknown as {
        __engine: () => {
          getDomain: (d: string) => {
            gl: WebGL2RenderingContext;
            step: () => void;
            read: (id: string, k: string) => unknown;
            res: { width: number; height: number };
          };
        };
      };
      const vid = w.__engine().getDomain('video');
      const gl = vid.gl;

      // Drain any pre-existing GL error so we only measure THIS render's errors.
      while (gl.getError() !== gl.NO_ERROR) { /* flush */ }

      // FIXED synchronous frame count. framesElapsed (field parity + ping-pong
      // + cold-baseline) is now a pure function of nSteps; uTime is frozen.
      for (let i = 0; i < nSteps; i++) vid.step();

      // Collect every GL error raised across the whole render burst.
      const glErrors: number[] = [];
      let e: number;
      while ((e = gl.getError()) !== gl.NO_ERROR) glErrors.push(e);

      // Read the CRT front buffer ONCE. read('fboTexture') returns the live
      // texture; we bind it to a scratch framebuffer + readPixels. (texture is
      // not serializable across the evaluate boundary — pixels are.)
      const tex = vid.read('bb', 'fboTexture') as WebGLTexture | null;
      const { width: W, height: H } = vid.res;
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      const px = new Uint8Array(W * H * 4);
      if (complete) gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      while (gl.getError() !== gl.NO_ERROR) { /* drain readback errors, already captured above */ }

      // Pixel statistics (luma). Sample a sparse grid — enough for non-black +
      // spatial-structure (variance) without shipping a megabyte back.
      let n = 0, sum = 0, sumSq = 0, nonZero = 0;
      for (let i = 0; i < px.length; i += 4 * 16) {
        const v = (px[i]! + px[i + 1]! + px[i + 2]!) / 3;
        sum += v; sumSq += v * v; n++;
        if (v > 8) nonZero++;
      }
      const mean = sum / n;
      const variance = sumSq / n - mean * mean;
      const framesElapsed = vid.read('bb', 'framesElapsed') as number;
      return {
        fbComplete: complete,
        framesElapsed,
        glErrors,
        nonZeroFrac: nonZero / n,
        variance,
        mean,
      };
    }, { nSteps: FIXED_STEPS });

    // The render burst actually advanced the FIXED number of frames.
    expect(stats.framesElapsed, 'engine advanced the fixed frame count').toBe(FIXED_STEPS);
    expect(stats.fbComplete, 'CRT front-buffer FBO readable').toBe(true);

    // Zero GL errors across the whole 4-pass burst + readback.
    expect(stats.glErrors, `GL errors during render: [${stats.glErrors.join(',')}]`).toEqual([]);

    // Non-black: the encode→bend→decode→CRT path produced an image.
    expect(stats.nonZeroFrac, 'decoded output is not all-black').toBeGreaterThan(0.02);

    // Spatial structure: it's a real picture, not a flat fill. (Renderer-
    // tolerant: a variance FLOOR, not an exact value — SwiftShader and a real
    // GPU disagree on exact pixels but both produce structured, non-flat output
    // from a SHAPES source through the NTSC pipeline.)
    expect(stats.variance, 'decoded output has spatial structure').toBeGreaterThan(15);

    expect(errors, 'no console / page errors during render').toEqual([]);
  });
});
```

Hook additions needed (modeled on TOYBOX's `__toyboxFreeze`/`__toyboxFreezeTime`):

- **`packages/web/src/lib/video/modules/b3ntb0x.ts`** — read a frozen time inside
  `draw()` instead of `performance.now()`:

```ts
// Top-level helper (mirrors toybox.ts frozenTime()):
function b3ntb0xFrozenTimeSec(): number | null {
  const g = globalThis as unknown as { __b3ntb0xFreezeTimeSec?: number | null };
  return typeof g.__b3ntb0xFreezeTimeSec === 'number' ? g.__b3ntb0xFreezeTimeSec : null;
}

// Inside surface.draw(frame), replace the wall-clock tSec line:
//   const tSec = (performance.now() - startWallMs) / 1000;
// with:
const frozen = b3ntb0xFrozenTimeSec();
const tSec = frozen !== null ? frozen : (frame.time);  // frame.time already = (now - startTime)/1000
```

The module shouldn't keep its own `startWallMs` baseline at all — use the
engine-provided `frame.time` and let the freeze override it. `read('fboTexture')`
and `read('framesElapsed')` already exist. An optional `__b3ntb0xFreeze(time?)`
setter on `B3ntb0xCard.svelte` (mirroring ToyboxCard) is only needed for an
on-card VRT baseline, **not** for this render-smoke. Also add the new spec to the
heavy-WebGL set in `e2e/webgl-heavy-globs.ts`.

#### Reference exemplar 2 — audio/event bridge (DOOM gate → scope, deterministic)

> Verbatim from the machine-gathered reference (`ref:audio-event-bridge`). This
> replaces the `doom-evt_*` race with a GPU-free dispatch unit test (Layer C) +
> an OfflineAudioContext held-signal render. **See the full design rendered as
> Layer C below.**

### Layer C — audio/event bridges as deterministic dispatch unit tests (DBU + OAC)

The `doom-evt_*` flake is irreducible at the e2e level: a ~10 ms gate pulse must
coincide with a ~43 ms analyser capture — two un-synchronized clocks. The cure is
to stop sampling a rendered signal and instead (1) assert the **dispatch
topology** (a GPU/WASM/clock-free unit test: the real DOOM gate CSN gets
`.connect()`ed onto the real scope `ch1` and `.disconnect()`ed on edge removal —
this is the actual #414 regression surface), and (2) if an end-to-end render is
still wanted, render a **HELD** signal (DOOM's `forceHold`, no auto fall-back)
through `OfflineAudioContext` and read the destination buffer at fixed indices
(one deterministic sample clock, signal HIGH at every sample — no window to miss).

**Layer 1 — GPU-free dispatch unit (`packages/web/src/lib/audio/doom-gate-scope-bridge.test.ts`):**

```ts
// packages/web/src/lib/audio/doom-gate-scope-bridge.test.ts
//
// DETERMINISTIC replacement (layer 1) for the racy `doom-evt_*` cases in
// e2e/tests/video-audio-cvgate-coverage.spec.ts.
//
// The e2e proves "a DOOM event gate reaches scope.ch1 through the video→audio
// bridge (the #414 regression)". It did so by firing a ~10ms forcePulse() and
// polling scope's ~43ms AnalyserNode for a HIGH sample — two unsynchronized
// clocks that must coincide. This test proves the SAME contract by inspecting
// the bridge DISPATCH directly: the real DOOM gate CSN (the exact node DOOM
// publishes in audioSources) is .connect()ed onto the real scope ch1 input by
// PatchEngine.addEdge, and .disconnect()ed on removeEdge. No pulse, no
// analyser, no clock → nothing to race.
//
// What this catches that the existing engine-video-audio-bridge.test.ts sweep
// does not: that sweep uses a synthetic VideoEngineStub source + synthetic
// sink. This wires the REAL doomDef.factory CSN (audioSources['evt_kill']) and
// the REAL scopeDef.factory ch1 input handle, so a regression in EITHER
// endpoint (DOOM stops publishing the gate, or scope's ch1 stops exposing a
// node input) trips it.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AudioEngine, PatchEngine, type DomainEngine } from './engine';
import type { Edge, ModuleNode } from '$lib/graph/types';

import { doomDef } from '$lib/video/modules/doom';
import { scopeDef } from '$lib/audio/modules/scope';
import { registerModule } from './module-registry';
import type { VideoEngineContext } from '$lib/video/engine';

// ---- Connection-recording AudioContext fake (real WebAudio NOT needed:
//      we assert the GRAPH TOPOLOGY the bridge built, not rendered samples).
//      Mirrors engine-video-audio-bridge.test.ts so connect()/disconnect()
//      land in a single inspectable log. ----
interface ConnRec { from: AudioNode; to: unknown; output?: number; input?: number; kind: 'connect' | 'disconnect'; }
let log: ConnRec[] = [];

function recordingNode(tag: string): AudioNode {
  const n = {
    __tag: tag,
    connect: (to: unknown, output?: number, input?: number) => { log.push({ from: n as unknown as AudioNode, to, output, input, kind: 'connect' }); return to as AudioNode; },
    disconnect: (to?: unknown, output?: number, input?: number) => { log.push({ from: n as unknown as AudioNode, to, output, input, kind: 'disconnect' }); },
  };
  return n as unknown as AudioNode;
}

function makeRecordingCtx(): AudioContext {
  // Minimal surface scope.factory + doom.factory touch. createAnalyser/
  // createGain/createConstantSource return recording nodes so the bridge's
  // .connect() of the DOOM CSN onto scope's ch1 gain is logged.
  const mk = (tag: string) => {
    const base = recordingNode(tag) as unknown as Record<string, unknown>;
    base.gain = { value: 1, setValueAtTime: vi.fn() };
    base.offset = { value: 0, setValueAtTime: vi.fn() };
    base.frequency = { value: 0, setValueAtTime: vi.fn() };
    base.fftSize = 2048; base.smoothingTimeConstant = 0;
    base.getFloatTimeDomainData = () => {};
    base.start = vi.fn(); base.stop = vi.fn();
    return base as unknown as AudioNode;
  };
  return {
    currentTime: 0, sampleRate: 48000,
    destination: mk('destination'),
    audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    createGain: () => mk('gain'),
    createAnalyser: () => mk('analyser'),
    createConstantSource: () => mk('const'),
    createChannelSplitter: () => mk('splitter'),
    createChannelMerger: () => mk('merger'),
    createOscillator: () => mk('osc'),
  } as unknown as AudioContext;
}

function makeFakeGl(): WebGL2RenderingContext {
  const stub = (): unknown => ({});
  return {
    getUniformLocation: stub, createTexture: () => ({}), bindTexture: () => {},
    texImage2D: () => {}, texSubImage2D: () => {}, texParameteri: () => {},
    pixelStorei: () => {}, deleteTexture: () => {}, deleteFramebuffer: () => {},
    deleteProgram: () => {},
    TEXTURE_2D: 0, RGBA: 0, UNSIGNED_BYTE: 0, TEXTURE_MIN_FILTER: 0,
    TEXTURE_MAG_FILTER: 0, TEXTURE_WRAP_S: 0, TEXTURE_WRAP_T: 0, LINEAR: 0,
    CLAMP_TO_EDGE: 0, UNPACK_FLIP_Y_WEBGL: 0,
  } as unknown as WebGL2RenderingContext;
}

// A tiny VideoEngine that materializes ONE real doomDef handle and exposes
// its published gate CSNs via getAudioSource — exactly the seam the bridge
// reads (engine.ts addCrossDomainAudioBridge: ve.getAudioSource(...)).
class RealDoomVideoEngine implements DomainEngine {
  domain = 'video' as const;
  private audioCtx: AudioContext | null = null;
  private handle: ReturnType<typeof doomDef.factory> | null = null;
  setAudioContext(ctx: AudioContext | null): void { this.audioCtx = ctx; }
  async addNode(n: ModuleNode): Promise<void> {
    const gl = makeFakeGl();
    const ctx: VideoEngineContext = {
      gl, res: { width: 320, height: 200 },
      compileFragment: () => ({}) as WebGLProgram,
      createFbo: () => ({ fbo: {} as WebGLFramebuffer, texture: {} as WebGLTexture }),
      drawFullscreenQuad: () => {},
      audioCtx: this.audioCtx ?? undefined,
    };
    this.handle = doomDef.factory(ctx, n as never);
  }
  getAudioSource(_nodeId: string, portId: string): { node: AudioNode; output: number } | null {
    return (this.handle?.audioSources?.get(portId) as { node: AudioNode; output: number }) ?? null;
  }
  removeNode(): void {} addEdge(): void {} removeEdge(): void {}
  setParam(): void {} readParam(): undefined { return undefined; }
  read(): unknown { return undefined; } dispose(): void {}
}

const DOOM_GATE_PORTS = ['evt_kill', 'evt_door', 'evt_gun_p1'] as const;

let scopeRegistered = false;
describe('DOOM event gate → scope.ch1 bridge dispatch (deterministic; replaces racy doom-evt e2e)', () => {
  beforeEach(() => {
    log = [];
    if (!scopeRegistered) { registerModule(scopeDef); scopeRegistered = true; }
  });

  it.each(DOOM_GATE_PORTS)(
    'doom.%s (gate) is .connect()ed onto the REAL scope ch1 input by addEdge, .disconnect()ed by removeEdge (#414)',
    async (port) => {
      const ctx = makeRecordingCtx();
      const ae = new AudioEngine(ctx);
      const ve = new RealDoomVideoEngine();
      const pe = new PatchEngine();
      pe.registerDomain(ae);   // threads ctx into ve.setAudioContext
      pe.registerDomain(ve);

      // Materialize the REAL DOOM handle (its factory publishes the gate CSNs)
      await ve.addNode({ id: 'v-doom', type: 'doom', domain: 'video', position: { x: 0, y: 0 }, params: {} });
      // Materialize the REAL scope on the audio engine (its ch1 input handle
      // is the bridge's destination).
      await ae.addNode({ id: 'a-scope', type: 'scope', domain: 'audio', position: { x: 0, y: 0 }, params: {} });

      // The exact gate CSN DOOM published — captured BEFORE the edge so we
      // can identity-match the connect() source.
      const gateCsn = ve.getAudioSource('v-doom', port)!.node;
      expect(gateCsn, `DOOM must publish ${port} in audioSources`).toBeDefined();

      const edge: Edge = {
        id: `e-${port}`,
        source: { nodeId: 'v-doom', portId: port },
        target: { nodeId: 'a-scope', portId: 'ch1' },
        sourceType: 'gate',
        targetType: 'audio',
      };

      pe.addEdge(edge, 'video', 'audio');

      // The bridge must have .connect()ed THE gate CSN (identity) into scope's
      // ch1 node input. ch1 is an `audio` input → routes to a node input, not
      // an AudioParam (scope.ts ch1: { type:'audio' }). Pre-#414 the dispatcher
      // dropped this edge → zero connects from this CSN → scope stayed silent.
      const conns = log.filter((c) => c.from === gateCsn && c.kind === 'connect');
      expect(conns.length, `${port}: dispatcher must bridge the gate CSN onto scope.ch1`).toBe(1);
      expect(conns[0]!.output).toBe(0);
      // Destination is scope's ch1 GainNode (an AudioNode, NOT an AudioParam).
      expect((conns[0]!.to as { __tag?: string }).__tag).toBe('gain');

      pe.removeEdge(edge, 'video');
      const disc = log.filter((c) => c.from === gateCsn && c.kind === 'disconnect');
      expect(disc.length, `${port}: removeEdge must tear the bridge down`).toBe(1);

      pe.dispose();
    },
  );
});
```

> Note: the `__tag` assertion may read `'gain'` depending on which input handle
> shape `scope.ch1` exposes (it taps `gain1`) — adjust once run; the load-bearing
> assertions are *the gate CSN is connected once on addEdge and disconnected once
> on removeEdge with output index 0*.

**Layer 2 — deterministic OfflineAudioContext render (`art/scenarios/doom/gate-bridge.test.ts`):**

```ts
// art/scenarios/doom/gate-bridge.test.ts
//
// DETERMINISTIC replacement (layer 2) for the racy `doom-evt_*` e2e gate
// cases. The e2e fired a 10ms forcePulse and polled scope's ~43ms analyser
// for a chance HIGH sample. Here we instead:
//   (a) inject a HELD gate level (forceHold semantics: offset=1, NO auto
//       fall-back) so the bridged signal is HIGH for the WHOLE render — there
//       is no 10ms window that can fall between samples, and
//   (b) render a fixed number of samples through OfflineAudioContext and read
//       the destination buffer at EXACT indices — not a live-polled analyser.
//
// We render the bridge end-to-end at the GRAPH level (CSN gate → scope ch1
// passthrough gain → destination) using the SAME node topology the engine
// builds, but assembled here with the real node-web-audio-api so we get a real
// rendered buffer.

import { describe, it, expect } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';

const SR = 48000;

describe('DOOM gate → scope bridge: HELD signal renders deterministically (no 10ms/43ms race)', () => {
  it('a held gate (offset=1, no fall-back) is HIGH at every sampled index of the render', async () => {
    const DURATION_S = 0.05; // ~2 full 2048-sample analyser windows; arbitrary
    const ctx = new OfflineAudioContext({
      numberOfChannels: 1,
      length: Math.round(SR * DURATION_S),
      sampleRate: SR,
    });

    // The DOOM gate CSN, HELD high from t=0 (this is exactly what
    // extras.forceHold(port, true) schedules: offset.setValueAtTime(1, t0),
    // with NO scheduled fall-back — doom.ts forceHold).
    const gate = ctx.createConstantSource();
    gate.offset.setValueAtTime(1, 0);

    // scope.ch1 is a unity passthrough GainNode tapped to an analyser
    // (scope.ts: input → gain1 → analyser; gain1 → ch1_out). The bridge
    // .connect()s the gate CSN INTO gain1.
    const ch1Gain = ctx.createGain();
    ch1Gain.gain.value = 1;

    gate.connect(ch1Gain);
    ch1Gain.connect(ctx.destination);
    gate.start();

    const buf = (await ctx.startRendering()).getChannelData(0);

    // DETERMINISTIC: held HIGH for the entire render → every probed index is 1.
    for (const t of [0, 0.001, 0.0107, 0.025, 0.043, DURATION_S - 1 / SR]) {
      const i = Math.min(buf.length - 1, Math.floor(t * SR));
      expect(buf[i] ?? 0, `held gate must read 1 at ${t * 1000}ms`).toBeCloseTo(1, 4);
    }
    const peak = buf.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak, 'bridged held gate must clear the floor (pre-#414 stayed 0)').toBeGreaterThan(0.5);
  });

  it('an UN-bridged gate (no connect) renders all-zero — proves the assertion can fail (#414 negative)', async () => {
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: Math.round(SR * 0.02), sampleRate: SR });
    const gate = ctx.createConstantSource();
    gate.offset.setValueAtTime(1, 0);
    gate.start();
    const buf = (await ctx.startRendering()).getChannelData(0);
    const peak = buf.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeCloseTo(0, 6);
  });

  it('a 10ms pulse is HIGH only inside its window when rendered offline (deterministic, unlike the live e2e)', async () => {
    const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: Math.round(SR * 0.05), sampleRate: SR });
    const gate = ctx.createConstantSource();
    gate.offset.setValueAtTime(0, 0);
    gate.offset.setValueAtTime(1, 0.010);  // rising
    gate.offset.setValueAtTime(0, 0.020);  // falling (10ms wide)
    const g = ctx.createGain(); g.gain.value = 1;
    gate.connect(g); g.connect(ctx.destination); gate.start();
    const buf = (await ctx.startRendering()).getChannelData(0);
    const at = (t: number) => buf[Math.floor(t * SR)] ?? 0;
    expect(at(0.005)).toBeCloseTo(0, 4);   // before
    expect(at(0.015)).toBeCloseTo(1, 4);   // mid-pulse — guaranteed sampled
    expect(at(0.030)).toBeCloseTo(0, 4);   // after
  });
});
```

**Removal:** delete the three `gatedOnDoomWasm: true` rows from `PAIRS` in
`e2e/tests/video-audio-cvgate-coverage.spec.ts` (and the now-dead
`doomWasmPresent` skip machinery if `nibbles-pellet` no longer needs it). The
DOOM gate→bridge contract is now proven in the fast `task test` lane (Layer 1) +
ART lane (Layer 2), neither needing the DOOM WASM asset — closing the
"skip-if-asset-absent makes the e2e vacuous" hole too.

---

## 6. Phased execution plan

> Ordering principle: build the **shared determinism machinery first** (one
> engine hook + the per-module freeze hooks the most-flaky and
> attest-gating specs need), then migrate specs in waves cheapest-first, then
> delete the wall-clock specs, then flip the gate. **#861/#863 are unblocked in
> Phase 1** by landing the shared hook + the exact freeze hooks their modules
> need, and shipping those modules' DRS first.

### Phase 0 — Foundation: shared "render N frames deterministically" surface (~0.5–1 day)

- Audit/confirm `VideoEngine.step()` is public and `__videoEngineFreezeRender`
  semantics (advance frame counter + timing while skipping GL draw is the
  *freeze-for-VRT* mode; DRS instead wants **step-with-draw** under a *pinned
  clock*). Add, if missing, a single public entry point used by all DRS specs:
  - `globalThis.__videoEngineFreezeTime: number | null` (or `engine.setTime(sec)`)
    that pins `VideoFrameContext.time` to a constant for **all** modules in one
    place — closing the gap flagged for `videobox`/`bentbox`/`feedback` (animation
    drift even with render-freeze) without per-module time code.
  - a public frame-count accessor (`engine.getFrameCount()`) + a documented
    `read(id,'framesElapsed')` convention.
- Write a tiny shared helper `e2e/tests/_render-smoke.ts`:
  `freezeStepReadStats(page, { nodeId, freezeTimeSec, steps })` → returns
  `{ framesElapsed, fbComplete, glErrors, nonZeroFrac, variance, mean }`. Every
  DRS calls this; the b3ntb0x exemplar's inline `page.evaluate` becomes the
  helper body.
- **Effort:** 0.5–1 day. **Output:** one reusable hook + one reusable helper.

### Phase 1 — Per-module freeze hooks + first DRS wave (unblocks #861/#863) (~2–3 days)

- Land the per-module freeze hooks for the modules with the **highest fragile
  count and/or that gate #861/#863** first. Priority order:
  1. **wavesculpt** (13 fragile — worst single spec; `__wavesculptVrtFreeze`
     present, needs a sync step path / `gl.finish`-after-rAF + frame-count
     export). Convert all 7 ribbon/spectro/trace polls to DRS, the 2 morph/mode
     diffs to two-frozen-reads.
  2. **b3ntb0x** (ship the §5B exemplar verbatim + the `frame.time` freeze edit;
     add to `webgl-heavy-globs.ts`).
  3. **video-controls** (10 fragile) and **video-orientation** (15 fragile) —
     these are mechanical: `setParam` + two frozen reads / frozen
     `analyzeTriangleOrientation`. They share the helper, so they go fast once
     it exists.
  4. **toybox** family already has freeze/step/readiness — convert the
     `render-worker-toybox` + `toybox-shadertoy` GPU polls to DRS (the only
     toybox specs with fragile *GPU* assertions; the Yjs-poll ones are Phase 2).
  5. The exact modules behind **#861/#863** (confirm which from the PRs) get
     their freeze hook + DRS in this phase so those PRs can rebase onto a green,
     deterministic lane.
- For each new/changed DRS: run `REPEAT=3 task e2e:one -- <spec>` per the
  flake-check standard before opening the wave's PR.
- **Effort:** 2–3 days. **Output:** the worst offenders deterministic; #861/#863
  unblocked.

### Phase 2 — Migrate remaining GPU specs in waves (~3–4 days)

- **Wave 2a (DRS-convertible GPU pixel reads):** mandleblot, video-chain,
  scope-video-out (video half), wavecel/wavecel-viz, quadralogical-video,
  cube, videobox-output (one-shot halves), camera-input, 4plexvid,
  render-worker-acidwarp, freezeframe (poll halves), multi-video-playback
  (pixel halves), video-aspect-switch, video-fullscreen (realloc halves). Each
  uses the Phase-0 helper + its module's freeze hook.
- **Wave 2b (PCU extractions):** synesthesia band-energy, wavesculpt-camera-cv +
  wavesculpt-state-unity (camera-CV mapping + readParam alignment),
  video-phase1 (LFO→param bridge), scope/analog-vco draw helpers, foxy band
  selection. These become fast vitest files; the corresponding e2e GPU
  assertions are deleted or reduced to a single DRS.
- **Wave 2c (OAC extractions):** synesthesia-composite (offline band render),
  video-audio-output (terminal peak), wavesculpt-spatial-audio (RMS-per-position).
- **Wave 2d (Yjs/DOM-poll tightening — no GPU):** toybox-node-batch/-controls/
  -menu (already FIXED)/-presets/-presets-io/-cv-section, video-hide-controls,
  videobox-performance-bundle, videovarispeed-perfzip/-output/-switch,
  video-fullscreen-multimonitor. These are data-layer settlement polls: add an
  explicit settle anchor before each poll and widen budgets; `expect.poll` on
  Yjs/`data-*` state is deterministic-under-jitter, just needs a readiness
  anchor and adequate budget.
- **Effort:** 3–4 days. **Output:** every fragile assertion replaced or moved.

### Phase 3 — Delete wall-clock specs / dead machinery (~0.5 day)

- Delete the doom-evt rows + skip machinery (§5C). Delete any e2e GPU assertions
  fully superseded by a PCU/OAC (don't keep both — per the reconcile=fix-or-delete
  standard). Remove now-unused `waitForLuma`/`waitForMoving`/`waitForCondition`
  helpers and the `outAdvances` pixel-poll helpers. Grep for residual
  `waitForTimeout` in the heavy-WebGL set and drive it toward 0 (only legitimate
  fixed waits — e.g. an OS-fullscreen layout settle that has no readiness signal —
  stay, documented).
- **Effort:** 0.5 day.

### Phase 4 — Flip the attest to the deterministic gate; drop retries (~0.5 day)

- With the heavy-WebGL set now deterministic: set `retries=0` on the attest lane
  (or confirm it stays 0), run the **3× quiet-machine** attest to prove zero
  flake (per the webgl-attest "must run SOLO" discipline — concurrent agents
  starve it). Re-pin the webgl-attest basis (heavy-WebGL specs + video defs) on
  metal.
- Make the deterministic webgl-attest a **REQUIRED** check (mirrors the
  collab-attest campaign: ruleset edit + ci.yml umbrella needs/env/if).
- Estimate + flag CI wall-time delta (DRS specs are *faster* than wall-clock
  ones — fixed small step counts vs. 600–1000ms sleeps — so this should *reduce*
  wall time; confirm it doesn't add >2 min anywhere, per the CI-walltime
  standard).
- **Effort:** 0.5 day + one solo 3× attest cycle.

**Total rough effort:** ~8–10 working days, front-loaded so #861/#863 unblock at
the end of Phase 1 (~day 3–4).

---

## 7. Non-goals / risks

**Non-goals:**

- **Not** pixel-exact VRT. DRS asserts floors + counts (non-black, variance,
  GL-error-free, frame-count) — renderer-tolerant per CLAUDE.md. Exact-pixel
  baselines remain the separate VRT harness's job (linux+darwin baselines).
- **Not** rewriting the audio engine for synchronous frame-stepping. Audio
  modules (`adsr`, `vca`, `lfo`, `sequencer`, `clipplayer`, `analogVco`,
  `audioOut`) have no sync step and Web Audio is async by design — their
  correctness goes to PCU / OAC, not DRS. Do not add a fake audio stepper.
- **Not** touching DOM/Yjs-deterministic specs that are already non-fragile
  (`quadralogical-assign`, `toybox-combine-editor`, `toybox-layer-input`,
  `toybox-video-inputs`, `video-full-frame`, `toybox-disk-loading`,
  `toybox-feedback`) — they are the *exemplars*, leave them.
- **Not** keeping both an e2e GPU assertion and its PCU/OAC replacement
  (reconcile = fix-or-delete; one source of truth per behavior).

**Risks:**

- **Per-module time-pinning gaps.** A shared `__videoEngineFreezeTime` only
  helps modules that read the engine's `frame.time`. Modules with their *own*
  `performance.now()` baseline (`b3ntb0x` `startWallMs`, `bentbox` `startWallMs`,
  `acidwarp` `frame.time` ok, `feedback`/`videobox` engine clock) each need a
  one-line edit to read `frame.time`/the freeze hook. Audit every heavy-WebGL
  module for a private wall clock before assuming the shared hook covers it.
- **`read('fboTexture')` not implemented on every module.** Several modules
  (chromakey, lumakey, colorizer, reshaper, luma, mixer, monoglitch, vdelay)
  don't expose an output texture via `read()`. DRS for those needs the texture
  read added first (Phase 1/2 hook work), or routes through a downstream
  `videoOut` FBO. Prefer the downstream-OUTPUT route for stateless processors to
  avoid per-module read plumbing.
- **`gl.finish`/readback on SwiftShader watchdog.** A tight `gl.finish()` busy
  loop can trigger CI's GPU watchdog (the reason videobox-perf gates timing
  probes local-only). DRS avoids this by using a small FIXED step count and a
  single readback — no busy loop — but keep step counts low (≤~12) and never add
  a wall-clock timing probe to a DRS.
- **Card rAF vs engine step double-render.** Modules whose Card drives its own
  rAF (`cube`, `wavesculpt`, `wavecel`, `clipplayer`) can blit between our
  steps. DRS reads the **engine FBO directly** (not the on-card 2D canvas) inside
  one `page.evaluate` so the card's rAF can't interleave — but the freeze hook
  must also pause the card's rAF (set `frozen=true`) for any on-card VRT variant.
- **Attest basis drift.** Flipping to required + retries=0 is only safe after a
  **solo 3×** green attest on metal; a concurrent agent run can starve WebGL and
  produce a false red (documented discipline). Schedule the flip when the lane is
  uncontended.
- **#861/#863 coupling.** If those PRs add *new* GPU modules, their DRS must land
  with them (per the "new module ships its own test" + auto-enrollment
  standards), using the Phase-0 helper — don't let them merge with a wall-clock
  smoke that re-introduces flake.
