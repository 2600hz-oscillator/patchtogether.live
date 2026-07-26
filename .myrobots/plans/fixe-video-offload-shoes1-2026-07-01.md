# Fix E — video-off-main-thread, scoped to the SHOES1 underrun (2026-07-01)

Reconstructed after the original `fixe-offscreen-canvas-plan-2026-06-09.md` was found
MISSING from disk + git. Sources: three read-only scouts (video pipeline map, shipped
Fix-E artifacts, per-module fit for synesthesia/backdraft) + memory
[[fixe-offscreen-worker-go]] + the SHOES1 forensics [[clock-perf-glitch-output-underrun]].

## 0. What already shipped (this is NOT greenfield)
The "texture co-processor" worker is LIVE + flag-gated OFF. Phase 1 (#722, acidwarp) +
Phase 2A (#726, toybox) + vfpga-runner. Infra:
- `video/worker/protocol.ts` — main→worker JSON (`init/addNode/removeNode/setParam/setResolution/dispose/toybox-sync`); worker→main `ready{glOk}` + `frame{nodeId,bitmap}` (transferred ImageBitmap).
- `video/worker/render-worker.ts` (entry), `worker-engine.ts` (`WorkerRenderEngine`; **`getInputTexture()` returns null — worker nodes are INPUT-LESS leaf sources only**, worker-engine.ts:15-20), `worker-bridge.ts` (flag `isWorkerFlagOn()` + capability + latest-wins 1-frame back-pressure), `worker-proxy-handle.ts` (main-side proxy; uploads the ImageBitmap into a real main-GL texture; **transparent main-thread fallback** on flag-off/unsupported/glOk:false/worker-death).
- Opt-in: `renderLocus:'worker'` on the module def (`module-registry.ts:93`).
- Flag: `?videoworker=1` / `globalThis.__videoWorkerEnabled` / `VITE_VIDEO_WORKER`. Default OFF → byte-identical main path.

## 1. Target-set CORRECTION (the big surprise)
- **synesthesia is NOT a candidate — drop it.** It is `domain:'audio'`, has **zero WebGL** (2D-canvas VU/raster + per-band `AnalyserNode` reads + DOM `getImageData`), and its heavy DSP **already runs off-main-thread in an AudioWorklet** (`dsp/src/synesthesia.ts:269-326`). "Move synesthesia into a WebGL worker" is a category error — there's no GL frame to co-process, and its main-thread cost is 2D canvas + main-thread WebAudio APIs that can't be read from a worker. My earlier "synesthesia heavy GL" assumption was wrong.
- **backdraft IS the right GL target.** Pure fragment-shader-into-FBO, DOM-free factory (`backdraft.ts:994-1217`), scalar CV params the protocol already carries. Its 31-frame feedback ring is **internal to its GL context → migrates for free** (the scary part is a red herring). Heaviest GL cost in the SHOES1 patch.

## 2. The real obstacle + the honest open question
backdraft consumes **4 upstream VIDEO inputs** (`in_a/in_b/lighten/darken`). The worker path
today supports only input-LESS sources. So two things are true:
- **(gap, buildable)** Moving backdraft needs a **protocol extension: transfer input frames INTO the worker each frame** (per-frame input `ImageBitmap`). Reusable for EVERY input-consuming module, not backdraft-specific.
- **(economics, OPEN)** To feed those inputs to the worker, the main engine must **read them back from the main GL context (GPU→CPU) to make ImageBitmaps** — that readback is itself a costly main-thread GL sync, the exact thing we're removing. So moving a **single mid-graph** input-consuming module can be **net-negative** (adds N input readbacks to save 1 render). The win only clearly materializes when a **connected video subgraph** moves together, so frames stay worker-GL and never round-trip. Copy-back budget from the spike: p50 must stay < ~2 ms/frame or "the copy-back eats the win" (measured 1.7 ms real / 0.2 ms SwiftShader for ONE out-frame; 4-in+1-out is untested).

## 3. Recommended path (measure before extending)
**Phase A — MEASURE the copy-back economics (low-risk, no protocol change).**
Build a real-browser measurement (main-thread long-task rate + `outputLatency`/underrun proxy;
Playwright can't see the device underrun, so headed Chrome + PerformanceObserver `longtask`).
A/B the EXISTING worker flag on a representative heavy patch (flip acidwarp/toybox/vfpga
eligible on vs off). This answers "does the co-processor actually cut main-thread contention,
and what does one ImageBitmap round-trip really cost here?" BEFORE investing in the input-transfer
work. If it doesn't pay off even for leaf sources, the whole approach is reconsidered.

**Phase B — input-frame transfer → backdraft (only if A pays off).**
Extend `protocol.ts` + `worker-engine.ts` for per-frame input-`ImageBitmap` transfer; flip
backdraft to `renderLocus:'worker'`; decide leaf-vs-subgraph based on A's readback cost. Ship
as a **review-before-merge draft** with flag-gate + main-thread fallback (never auto-merged —
owner directive). Validate: worker-fed OUTPUT non-black under CI SwiftShader + flag-off VRT
parity + 3× flake-check + a real-Safari check + owner preview on REAL frames.

**Parallel, independent lever (not worker-related):** the per-card present path does one
`drawImage`-from-WebGL GL-sync PER visible card per frame (engine.ts:1033-1055 blit +
Card `ctx2d.drawImage(engine.canvas)`). On SHOES1 (several visible cards + recorderbox) that
main-thread cost stays regardless of where render runs. Coalescing/■skipping offscreen card
presents is a separate, cheaper win worth pricing.

## 4. Decisions needed from the owner
1. Confirm dropping **synesthesia** from the target set (it isn't GL).
2. Phase A first (measure the existing worker payoff) vs jump straight to the backdraft
   input-transfer build?
3. Appetite for the **connected-subgraph** approach (bigger, but the only way an input-consuming
   module clearly wins) vs single-module (simpler, may be net-neutral)?
4. Should the **per-card present-path** coalescing be folded in or tracked separately?
