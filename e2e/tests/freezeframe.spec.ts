// e2e/tests/freezeframe.spec.ts
//
// FREEZEFRAME — video sample & hold + per-channel posterize.
//
// DETERMINISTIC render-smoke (DRS), converted IN-PLACE from the old wall-clock
// shape (spawn → poll-the-output-canvas-on-a-50ms-cadence until a
// brightness-fingerprint animation-diff crosses a LIVE/FROZEN fraction, with a
// 12 s deadline). That pattern raced three un-synchronized clocks (the engine's
// own rAF loop — THROTTLED in a backgrounded e2e tab — the 2D-canvas blit
// cadence, and the wall-clock poll) and proved "the frame moved" by diffing
// successive ANIMATED frames, which a frozen clock can't (and shouldn't) do.
//
// The DRS instead PAUSES the engine rAF loop + PINS the engine clock before boot
// (installRenderSmokeHooks), drives engine.step() a FIXED number of frames
// synchronously, and reads FREEZEFRAME's OWN output FBO once via the shared
// _render-smoke harness with renderer-tolerant floors. The regression-critical
// paths, re-expressed deterministically:
//
//   (a) UNGATED   → live passthrough: with nothing patched to gate_in the gate
//                   reads UNPATCHED (read('gatePatched')===false) and the output
//                   TRACKS the source — changing the source's (frozen) frame
//                   changes the output (two FROZEN reads DIFFER).
//   (b) GATE HIGH → output UPDATES: with __freezeframeForceGate=1 the gate reads
//                   PATCHED and the output still TRACKS the source (two FROZEN
//                   reads, source frame changed in between, DIFFER).
//   (c) GATE LOW  → output FROZEN: with __freezeframeForceGate=0 the held frame
//                   PERSISTS even though the source's frozen frame is changed
//                   underneath (two FROZEN reads MATCH within tolerance).
//   (d) QUANT     → raising all four QUANT knobs to max drops the number of
//                   DISTINCT colours at the output (posterization): two FROZEN
//                   reads (full-depth vs max-quant) and the distinct-colour count
//                   collapses.
//
// "Source frame changed in between" is done deterministically by setParam-ing
// ACIDWARP's `scene` (the source rebuilds its pattern texture for the new scene
// — see acidwarp.ts) rather than by waiting for it to ANIMATE: with the clock
// pinned, each (scene) is a bit-stable frozen frame, so a scene swap is a clean
// "the input changed" edge with no timing flake.
//
// The gate scenarios use the deterministic `__freezeframeForceGate` test hook (a
// number = "gate patched at this level") so the freeze-vs-live state is pinned
// without a timing-flaky real LFO. The REAL CV-bridge gate path (a gate source
// patched into gate_in) is covered by the per-module-per-port sweep + the
// freezeframe.test.ts shouldCapture unit tests; this spec proves the end-to-end
// render behaviour.
//
// No waitForTimeout, no poll, no animation-diff, no exact-pixel assert.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';
// THE constant, imported from the module that owns it — never re-typed here.
// A held HIGH level counts as a HELD gate only after standing this long, because
// for one bridge tick a trigger pulse and a just-opened gate are the same bytes.
// (Same one-source-of-truth rule as the backdraft card-vs-def defect: a control
// re-typing a number its def already declares is not a duplicate, it is a second
// value that silently disagrees. This spec WARMS for the window and then asserts
// "every qualified frame changed" — a stale mirror would warm for the wrong
// window and assert continuity against a module that had not qualified yet.)
// Precedent for reaching into the web package from a spec:
// voice-pitch-accuracy.spec.ts, picturebox-asset-select.spec.ts, vfpga-p2-cells.spec.ts.
import { HOLD_QUALIFY_MS } from '../../packages/web/src/lib/video/modules/freezeframe';

// FREEZEFRAME's own combined output port (video_out). The harness reads a node's
// OWN FBO by node id (+ optional port); FREEZEFRAME publishes video_out via
// read('outputTexture:video_out'), and outputTexture() prefers that port texture.
const FF_PORT = 'video_out';

// A fixed synchronous burst — large enough that FREEZEFRAME has captured the
// (unpatched/high-gate) source into its hold buffer (holdSeeded) and every
// output pass has run, small enough to stay cheap on CI's software renderer.
const FIXED_STEPS = 6;

/** ONE discarded step+read before the first ASSERTED read.
 *
 *  ── THE REAL CAUSE, BISECTED (corrected 2026-08-01) ──
 *  An earlier version of this comment said "the FIRST stepAndReadStats call
 *  reads ALL-BLACK no matter how many steps it drives … the deficit is one
 *  pipeline round-trip". That was WRONG, and it was falsifiable from inside this
 *  very file: test (e) does NOT warm, its first assertion covers prints[0], and
 *  it is GREEN under E2E_SWIFTSHADER=1 (verified, 3 separate processes). A
 *  "first readback is always black" cause predicts (e) is red. It isn't.
 *
 *  Bisected on the real chain (acidwarp → freezeframe → videoOut, 6 × step(),
 *  full-frame readPixels of v-ff/video_out, nonZeroFrac):
 *
 *    what runs BEFORE the step() burst          SwiftShader   real GPU
 *    ─────────────────────────────────────────  ───────────   ────────
 *    nothing                                       0.8936      0.8936
 *    gl.getParameter(MAX_TEXTURE_SIZE)             0.8936        —
 *    gl.flush()                                    0.8936        —
 *    while (gl.getError() !== NO_ERROR) {}         0.0000      0.8936
 *      …the same drain + gl.finish()               0.0000        —
 *
 *  So it is not the reader, not the read size, not render time and not a warm-up
 *  period: it is `_render-smoke.ts`'s PRE-STEP `gl.getError()` drain (line 69),
 *  which drains ZERO errors and still blanks that burst's readback, under
 *  SwiftShader only, on the FIRST call in the page. Every later call does the
 *  same drain and reads 0.8936, so absorbing exactly one call fixes it. Another
 *  synchronous query in the same position does NOT reproduce it, and finish()
 *  does not repair it — it is specific to getError(), which is why "more steps"
 *  cannot help and why a discarded CALL is the right shape of workaround.
 *
 *  ⚠ THIS IS A SHARED-HARNESS DEFECT, NOT A FREEZEFRAME ONE. Any DRS spec whose
 *  FIRST stepAndReadStats result is asserted on is exposed under SwiftShader.
 *  It is worked around here rather than fixed in _render-smoke.ts because that
 *  file is loaded by every DRS spec and re-validating them all is out of scope
 *  for this PR — filed as follow-up, with the bisection above so it needs no
 *  re-derivation. (e) is immune because driveGateFrames never calls getError().
 *
 *  This was a REAL PRE-EXISTING RED: test (a) failed under E2E_SWIFTSHADER=1 on
 *  commit 9be2146e too. It was invisible because freezeframe.spec.ts ran in NO
 *  CI lane — which is why (a) is now tagged @webgl-smoke alongside (e).
 *
 *  The content is otherwise IDENTICAL across renderers (nonZeroFrac 0.8936,
 *  variance 3213.02, mean 61.72 on both), so this is a command-stream artefact,
 *  not a rendering difference — established before touching anything. */
async function warmRenderPipeline(page: Page): Promise<void> {
  await stepAndReadStats(page, { nodeId: 'v-ff', portId: FF_PORT, steps: 1 });
}

/** Read FREEZEFRAME's OWN combined-output FBO ONCE and return luma stats PLUS a
 *  distinct-colour count (5-bit-per-channel buckets) — the posterize headline
 *  metric the shared harness doesn't compute. Single page.evaluate (one
 *  round-trip, no await inside → rAF/decode/blit can't interleave), no poll, no
 *  sleep. Mirrors _render-smoke's gl.readPixels readback. */
async function readColorStats(
  page: Page,
  nodeId: string,
  portId: string,
): Promise<{ nonZeroFrac: number; distinctColors: number; samples: number }> {
  return page.evaluate(({ nodeId, portId }) => {
    const w = globalThis as unknown as {
      __engine: () => {
        getDomain: (d: string) => {
          gl: WebGL2RenderingContext;
          outputTexture: (id: string, port?: string) => WebGLTexture | null;
          res: { width: number; height: number };
        };
      };
    };
    const vid = w.__engine().getDomain('video');
    const gl = vid.gl;
    while (gl.getError() !== gl.NO_ERROR) { /* drain pre-existing */ }
    const tex = vid.outputTexture(nodeId, portId) as WebGLTexture | null;
    const { width: W, height: H } = vid.res;
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    const px = new Uint8Array(W * H * 4);
    if (complete) gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    while (gl.getError() !== gl.NO_ERROR) { /* drain readback */ }

    let n = 0, nonZero = 0;
    const colors = new Set<number>();
    for (let i = 0; i < px.length; i += 4 * 16) {
      const r = px[i]!, g = px[i + 1]!, b = px[i + 2]!;
      if ((r + g + b) / 3 > 8) nonZero++;
      colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
      n++;
    }
    return { nonZeroFrac: n ? nonZero / n : 0, distinctColors: colors.size, samples: n };
  }, { nodeId, portId });
}

/** Read a video-engine node diagnostic hook value from the page (e.g.
 *  read('gatePatched') / read('holdSeeded')). */
async function readNodeHook(page: Page, nodeId: string, key: string): Promise<unknown> {
  return page.evaluate(({ nodeId, key }) => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (d: string) => { read: (id: string, k: string) => unknown } };
    };
    return w.__engine().getDomain('video').read(nodeId, key);
  }, { nodeId, key });
}

/** setParam on a video node through the engine (deterministic, no Y.Doc write):
 *  drives the handle's setParam directly — used to swap ACIDWARP's frozen frame
 *  (scene) and to crank FREEZEFRAME's QUANT knobs. */
async function setVideoParam(page: Page, nodeId: string, paramId: string, value: number): Promise<void> {
  await page.evaluate(({ nodeId, paramId, value }) => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (d: string) => { setParam: (id: string, p: string, v: number) => void } };
    };
    w.__engine().getDomain('video').setParam(nodeId, paramId, value);
  }, { nodeId, paramId, value });
}

// ---------------------------------------------------------------------------
// (e) THE GATE SEMANTICS, read off REAL RENDERED FRAMES.
//
// This is the regression test for the owner report of 2026-07-31 ("with the
// gate patched, the image should be frozen and it should update once on a
// trigger, or continuously on a held gate") — measured, before the fix, as
// ZERO of 23 rendered frames updating across 6 triggers.
//
// WHAT IT DRIVES. Not `__freezeframeForceGate` (that pins a LEVEL, which is the
// one thing a trigger never presents at draw time and therefore exactly the
// wrong instrument for this bug). It drives FREEZEFRAME's real handle with the
// literal write sequence `PatchEngine.installGateDispatch` emits on a scheduler
// tick — `setParam(gateLevel,0); setParam(gateLevel,1)` per counted rising
// edge, then `setParam(gateLevel, currentLevel)`. That sequence was verified
// byte-for-byte against the live audio→video bridge (SEQUENCER.clock →
// FREEZEFRAME.gate_in), which logs one trigger as three writes in the SAME
// millisecond: `3221:0 3221:1 3221:0`.
//
// WHY NOT WIRE A LIVE SEQUENCER HERE. The real bridge delivers on a ~25 ms
// Worker tick that is unsynchronised with the render loop, so a live-source
// version of this test could only assert "roughly N" — and "roughly" is what
// let the bug ship. Driving the exact sequence keeps "EXACTLY N" assertable.
// The live chain is covered by shapegen-clock.spec.ts (the dropped-edge canary
// on the same bridge) and by the freezeframe.test.ts fps×phase sweep.
//
// ⚠ THE VACUOUS-ASSERTION TRAP. "the frame did not change" is satisfied by two
// black frames. So every phase below first proves the instrument: the source is
// re-scened EVERY frame (a scene swap rebuilds ACIDWARP's pattern texture, so
// consecutive frames provably differ even with the engine clock pinned), the
// UNGATED phase must show a change on EVERY frame, and every fingerprint must
// be non-black. If the ungated phase does not change, the freeze assertions
// below it mean nothing and the test says so.
//
// Frames are counted via engine.step() — a fixed, renderer-independent count,
// never a wall-clock budget. The ONE quantity read in milliseconds is the
// deliberate hold-qualification window (HOLD_QUALIFY_MS), which is a wall-clock
// property of the bridge's replay cadence by construction; the per-frame
// timestamps are returned so the assertion can locate that window exactly
// instead of guessing a frame count for it.
// ---------------------------------------------------------------------------

/** ACIDWARP scene count. 41 is PRIME, so any stride below is automatically
 *  co-prime to it and to the trigger period — captured frames cannot alias onto
 *  the same scene and read as "unchanged" when they really were re-captured. */
const SCENE_COUNT = 41;

interface GateFrame {
  /** Rising edges the bridge counted for this tick; -1 = no tick this frame
   *  (the 60 fps case, where frames are faster than the 25 ms tick). */
  edges: number;
  /** The level the tick reports after replaying its edges. */
  level: number;
}

interface FramePrint {
  h: string;
  t: number;
  nz: number;
  /** The SOURCE scene this frame was rendered with. Carried so a "the image
   *  changed" assertion can prove the two frames were even LOOKING at different
   *  source content — two frames on the same scene are legitimately identical,
   *  and reading that as "it did not update" is a false negative. */
  sc: number;
}

/** Drive FREEZEFRAME frame by frame with an explicit bridge-write plan, reading
 *  its OWN video_out FBO after each engine step. ONE page.evaluate — no await
 *  inside, so rAF / decode / blit cannot interleave with the sequence. */
async function driveGateFrames(
  page: Page,
  plan: GateFrame[],
  sceneStride: number,
  sceneStart = 0,
): Promise<{ prints: FramePrint[]; captureCount: number; gatePatched: unknown; sceneEnd: number }> {
  return page.evaluate(({ plan, sceneStride, SCENE_COUNT, sceneStart }) => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (d: string) => {
        gl: WebGL2RenderingContext;
        step: () => void;
        setParam: (id: string, p: string, v: number) => void;
        getNodeHandle: (id: string) => { setParam: (p: string, v: number) => void } | null;
        read: (id: string, k: string) => unknown;
        outputTexture: (id: string, port?: string) => WebGLTexture | null;
        res: { width: number; height: number };
      } };
    };
    const vid = w.__engine().getDomain('video');
    const gl = vid.gl;
    const handle = vid.getNodeHandle('v-ff')!;

    // A 128×128 centre crop is enough to fingerprint a full-frame plasma and
    // keeps the per-frame readback affordable on CI's software renderer.
    const RW = 128, RH = 128;
    const px = new Uint8Array(RW * RH * 4);
    const fb = gl.createFramebuffer()!;

    interface FramePrintLocal { h: string; t: number; nz: number; sc: number }

    function fingerprint(sc: number): FramePrintLocal {
      const tex = vid.outputTexture('v-ff', 'video_out') as WebGLTexture | null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      px.fill(0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
        gl.readPixels((vid.res.width - RW) >> 1, (vid.res.height - RH) >> 1, RW, RH,
          gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      let hash = 2166136261 >>> 0;
      let n = 0, nz = 0;
      for (let i = 0; i < px.length; i += 4) {
        hash = (((hash ^ px[i]!) >>> 0) * 16777619) >>> 0;
        hash = (((hash ^ px[i + 1]!) >>> 0) * 16777619) >>> 0;
        hash = (((hash ^ px[i + 2]!) >>> 0) * 16777619) >>> 0;
        n++;
        if ((px[i]! + px[i + 1]! + px[i + 2]!) / 3 > 8) nz++;
      }
      return { h: hash.toString(16), t: performance.now(), nz: n ? nz / n : 0, sc };
    }

    /** ONE scheduler tick, exactly as installGateDispatch replays it. */
    function schedulerTick(edges: number, level: number): void {
      for (let i = 0; i < edges; i++) {
        handle.setParam('gateLevel', 0);
        handle.setParam('gateLevel', 1);
      }
      handle.setParam('gateLevel', level);
    }

    const prints: FramePrintLocal[] = [];
    // The scene walk CONTINUES across calls (threaded via sceneStart/sceneEnd).
    // Restarting it at 0 each call could hand two consecutive phases the same
    // scene across the seam, and "the source did not change" is precisely the
    // condition that would make a freeze assertion pass vacuously.
    let scene = sceneStart;
    for (const f of plan) {
      // The source's frozen frame CHANGES every single frame — the instrument
      // check the freeze assertions depend on.
      scene = (scene + sceneStride) % SCENE_COUNT;
      vid.setParam('v-src', 'scene', scene);
      if (f.edges >= 0) schedulerTick(f.edges, f.level);
      vid.step();
      prints.push(fingerprint(scene));
    }
    gl.deleteFramebuffer(fb);
    return {
      prints,
      captureCount: vid.read('v-ff', 'captureCount') as number,
      gatePatched: vid.read('v-ff', 'gatePatched'),
      sceneEnd: scene,
    };
  }, { plan, sceneStride, SCENE_COUNT, sceneStart });
}

/** Number of frames whose fingerprint differs from the frame before it. */
function changedFrames(prints: FramePrint[]): number {
  let n = 0;
  for (let i = 1; i < prints.length; i++) if (prints[i]!.h !== prints[i - 1]!.h) n++;
  return n;
}

const bits = (prints: FramePrint[]): string =>
  prints.map((p, i) => (i > 0 && p.h !== prints[i - 1]!.h ? '1' : '0')).join('');

test.describe('FREEZEFRAME — video sample & hold + posterize', () => {
  // @webgl-smoke — (a) is the test that was ACTUALLY RED under SwiftShader (see
  // warmRenderPipeline's bisection) and it ran in NO CI lane, so the fix for it
  // was unverifiable anywhere. It is also the only coverage of the
  // __freezeframeForceGate LEVEL path and of the shared _render-smoke harness on
  // this chain. Measured cost under E2E_SWIFTSHADER=1 on a warm server: 6.1 s.
  test('(a) @webgl-smoke ungated = live passthrough; (b/c) gate high updates / gate low freezes', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // Pause the engine rAF loop (the test owns the exact frame count) + pin the
    // engine clock (ACIDWARP halts its scene cycler + palette rotation, so each
    // `scene` is a bit-stable frozen frame) BEFORE boot.
    await installRenderSmokeHooks(page);

    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');

    // Clear any stale force-gate from a previous test in the worker.
    await page.evaluate(() => {
      (globalThis as unknown as { __freezeframeForceGate?: number | undefined }).__freezeframeForceGate = undefined;
    });

    await spawnPatch(
      page,
      [
        // ACIDWARP — colourful plasma source. scene 0 to start; we swap scene to
        // deterministically change its FROZEN frame (no reliance on animation).
        { id: 'v-src', type: 'acidwarp',    position: { x: 40,  y: 40 }, domain: 'video', params: { speed: 0.5, scene: 0 } },
        { id: 'v-ff',  type: 'freezeframe', position: { x: 380, y: 40 }, domain: 'video' },
        { id: 'v-out', type: 'videoOut',    position: { x: 720, y: 40 }, domain: 'video' },
      ],
      [
        { id: 'e-src-ff', from: { nodeId: 'v-src', portId: 'out' },       to: { nodeId: 'v-ff',  portId: 'video_in' }, sourceType: 'video', targetType: 'video' },
        { id: 'e-ff-out', from: { nodeId: 'v-ff',  portId: 'video_out' }, to: { nodeId: 'v-out', portId: 'in' },       sourceType: 'video', targetType: 'video' },
      ],
    );

    await expect(page.locator('.svelte-flow__node-acidwarp'),    'ACIDWARP visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-freezeframe'), 'FREEZEFRAME visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'),    'OUTPUT visible').toBeVisible();

    // ---- (a) UNGATED: live passthrough — output renders + TRACKS the source ----
    // Drive a fixed burst synchronously, read FREEZEFRAME's OWN output FBO once:
    // non-black + structured + exact frame delta + zero GL errors. (Replaces the
    // old waitForMoving poll, which proved "moved" by diffing animated frames.)
    await warmRenderPipeline(page);
    const aBefore = await stepAndReadStats(page, { nodeId: 'v-ff', portId: FF_PORT, steps: FIXED_STEPS });
    assertRenderStats(aBefore, FIXED_STEPS);
    expect(aBefore.nonZeroFrac, 'ungated output renders content').toBeGreaterThan(0);

    // Unpatched gate → the module reports the gate is NOT patched (so it's on the
    // live-passthrough path) and the hold buffer is seeded with real content.
    expect(await readNodeHook(page, 'v-ff', 'gatePatched'), 'ungated → gate reads unpatched').toBe(false);
    expect(await readNodeHook(page, 'v-ff', 'holdSeeded'), 'ungated → hold buffer seeded').toBe(true);

    // LIVE PASSTHROUGH (deterministic): change the source's FROZEN frame (swap
    // scene). With the gate unpatched the output must FOLLOW — a second FROZEN
    // read differs from the first. This is the deterministic equivalent of "the
    // frame keeps changing at the output".
    await setVideoParam(page, 'v-src', 'scene', 2);
    const aAfter = await stepAndReadStats(page, { nodeId: 'v-ff', portId: FF_PORT, steps: FIXED_STEPS });
    expect(aAfter.framesDelta, 'burst advanced the exact frame count').toBe(FIXED_STEPS);
    const aMeanDelta = Math.abs(aAfter.mean - aBefore.mean);
    const aVarDelta = Math.abs(aAfter.variance - aBefore.variance);
    expect(
      aMeanDelta > 1 || aVarDelta > 5,
      `ungated output TRACKS the source: a scene swap changed the output (Δmean=${aMeanDelta.toFixed(2)} Δvar=${aVarDelta.toFixed(2)})`,
    ).toBe(true);

    // ---- (b) GATE HIGH: output updates (tracks the live source) ----
    await page.evaluate(() => {
      (globalThis as unknown as { __freezeframeForceGate?: number }).__freezeframeForceGate = 1;
    });
    const bBefore = await stepAndReadStats(page, { nodeId: 'v-ff', portId: FF_PORT, steps: FIXED_STEPS });
    assertRenderStats(bBefore, FIXED_STEPS);
    // NB: we do NOT assert read('gatePatched') here. That hook reports whether a
    // REAL edge is patched into gate_in (it keys off gateWriteFrame, written only
    // by the CV bridge on a live edge); `__freezeframeForceGate` overrides the
    // gate LEVEL for the test, which is deliberately NOT the same as "patched".
    // The gate-HIGH BEHAVIOUR (output tracks the live source) is proven below.

    // Gate HIGH → still TRACKS: swap scene again, the output must follow (two
    // FROZEN reads differ).
    await setVideoParam(page, 'v-src', 'scene', 4);
    const bAfter = await stepAndReadStats(page, { nodeId: 'v-ff', portId: FF_PORT, steps: FIXED_STEPS });
    expect(bAfter.framesDelta, 'burst advanced the exact frame count').toBe(FIXED_STEPS);
    const bMeanDelta = Math.abs(bAfter.mean - bBefore.mean);
    const bVarDelta = Math.abs(bAfter.variance - bBefore.variance);
    expect(
      bMeanDelta > 1 || bVarDelta > 5,
      `gate HIGH keeps tracking: a scene swap changed the output (Δmean=${bMeanDelta.toFixed(2)} Δvar=${bVarDelta.toFixed(2)})`,
    ).toBe(true);
    expect(bAfter.nonZeroFrac, 'gate-high output renders content').toBeGreaterThan(0);

    // ---- (c) GATE LOW: output FROZEN while the source frame changes underneath ----
    await page.evaluate(() => {
      (globalThis as unknown as { __freezeframeForceGate?: number }).__freezeframeForceGate = 0;
    });
    // Settle the held frame: one burst with the gate LOW captures nothing further,
    // so the hold buffer now holds the LAST captured (scene-4) frame.
    const cFrozen = await stepAndReadStats(page, { nodeId: 'v-ff', portId: FF_PORT, steps: FIXED_STEPS });
    assertRenderStats(cFrozen, FIXED_STEPS);

    // Headline sample-&-hold guarantee, expressed deterministically: change the
    // SOURCE's frozen frame (scene swap) and step a wider burst. With the gate LOW
    // the FROZEN output must NOT follow — two FROZEN reads MATCH within tolerance.
    // (Replaces the old waitForFrozen poll + the stepAndSample(30) animation-diff:
    // here the source is provably DIFFERENT, not merely "still animating".)
    await setVideoParam(page, 'v-src', 'scene', 1);
    const cLater = await stepAndReadStats(page, { nodeId: 'v-ff', portId: FF_PORT, steps: 30 });
    expect(cLater.framesDelta, 'frozen burst advanced the exact frame count').toBe(30);
    const cMeanDelta = Math.abs(cLater.mean - cFrozen.mean);
    const cVarDelta = Math.abs(cLater.variance - cFrozen.variance);
    expect(
      cMeanDelta < 0.5 && cVarDelta < 1.0,
      `gate LOW: frozen frame PERSISTS while the source frame changes underneath (Δmean=${cMeanDelta.toFixed(2)} Δvar=${cVarDelta.toFixed(2)})`,
    ).toBe(true);
    expect(cLater.nonZeroFrac, 'frozen output still shows the held frame').toBeGreaterThan(0);

    // Clean up the hook so it can't leak into another test in the worker.
    await page.evaluate(() => {
      (globalThis as unknown as { __freezeframeForceGate?: number | undefined }).__freezeframeForceGate = undefined;
    });

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });

  // @webgl-smoke — this test is the REGRESSION GUARD for the owner-reported bug
  // and it is deliberately enrolled in the SwiftShader `webgl-smoke` CI floor.
  // Rationale: freezeframe.spec.ts matches a WEBGL_HEAVY glob, and the lane that
  // used to run those was DELETED on 2026-06-20 — so without a tag this fix ships
  // with ZERO on-CI coverage. It is affordable there because it is a DRS (rAF
  // paused, engine clock pinned, a fixed step() count) reading a 128×128 centre
  // crop, not a full-frame screenshot. Measured under E2E_SWIFTSHADER=1 on a
  // warm server: (a) 6.4 s + (e) 3.9 s ≈ 10 s of test time; expect ~20-40 s on a
  // loaded runner including browser launch — well under the ~2 min flag
  // threshold. (d) stays untagged: posterize is unrelated to this fix.
  test('(e) @webgl-smoke gate: frozen when low, EXACTLY ONE update per trigger, continuous while held', async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await installRenderSmokeHooks(page);
    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => {
      (globalThis as unknown as { __freezeframeForceGate?: number | undefined }).__freezeframeForceGate = undefined;
    });

    await spawnPatch(
      page,
      [
        { id: 'v-src', type: 'acidwarp',    position: { x: 40,  y: 40 }, domain: 'video', params: { speed: 0.5, scene: 0 } },
        { id: 'v-ff',  type: 'freezeframe', position: { x: 380, y: 40 }, domain: 'video' },
        { id: 'v-out', type: 'videoOut',    position: { x: 720, y: 40 }, domain: 'video' },
      ],
      [
        { id: 'e-src-ff', from: { nodeId: 'v-src', portId: 'out' },       to: { nodeId: 'v-ff',  portId: 'video_in' }, sourceType: 'video', targetType: 'video' },
        { id: 'e-ff-out', from: { nodeId: 'v-ff',  portId: 'video_out' }, to: { nodeId: 'v-out', portId: 'in' },       sourceType: 'video', targetType: 'video' },
      ],
    );
    await expect(page.locator('.svelte-flow__node-freezeframe'), 'FREEZEFRAME visible').toBeVisible();

    const STRIDE = 7; // co-prime to SCENE_COUNT(41) and to TRIGGER_EVERY(3)

    // ---- INSTRUMENT CHECK: ungated, the output must change on EVERY frame ----
    // Nothing is written to gateLevel, so the gate reads UNPATCHED and the
    // module is on the live-passthrough path. If this does not change every
    // frame, the source is not moving and every freeze assertion below would
    // be satisfied by two identical dead frames. This is the negative control
    // for the whole test.
    const live = await driveGateFrames(page, Array.from({ length: 12 }, () => ({ edges: -1, level: 0 })), STRIDE, 0);
    expect(live.gatePatched, 'no gate writes → gate reads UNPATCHED').toBe(false);
    expect(
      Math.min(...live.prints.map((p) => p.nz)),
      'INSTRUMENT: every ungated frame is non-black (a freeze test on black passes vacuously)',
    ).toBeGreaterThan(0.05);
    expect(
      changedFrames(live.prints),
      `INSTRUMENT: ungated passthrough changes on EVERY frame — if it does not, the freeze assertions below are meaningless (pattern ${bits(live.prints)})`,
    ).toBe(live.prints.length - 1);

    // ---- (1) GATE PATCHED, LEVEL LOW → FROZEN ----
    // The bridge ticks every frame writing 0 (a patched cable whose gate is
    // low). The source keeps re-scening underneath; the output must not move.
    const frozen = await driveGateFrames(page, Array.from({ length: 14 }, () => ({ edges: 0, level: 0 })), STRIDE, live.sceneEnd);
    expect(frozen.gatePatched, 'gate writes arriving → gate reads PATCHED').toBe(true);
    // The FIRST frame of this phase may still capture (the transition out of
    // live passthrough), so the freeze is asserted from frame 1 on.
    const frozenTail = frozen.prints.slice(1);
    expect(
      changedFrames(frozenTail),
      `gate LOW: successive frames are IDENTICAL while the source changes underneath (pattern ${bits(frozenTail)})`,
    ).toBe(0);
    expect(
      Math.min(...frozenTail.map((p) => p.nz)),
      'the FROZEN frame is a real held image, not black',
    ).toBeGreaterThan(0.05);

    // ---- (2) TRIGGER TRAIN → EXACTLY ONE UPDATE EACH ----
    // 8 triggers, one bridge tick per frame, a trigger every 3rd frame. Each
    // trigger's HIGH is gone by the tick's level report (the measured real
    // behaviour: `0, 1, 0` in one millisecond), so ONLY the rising-edge latch
    // can produce an update. "At least one" would not catch the double-fire
    // this bug class produces — the assertion is EXACTLY N.
    // The plan opens with two QUIET frames so the phase carries its own frozen
    // baseline — otherwise the first trigger's update lands on frame 0 and a
    // within-phase transition count silently reads N-1 (caught by this test's
    // own first run: pattern 000100100… = 7 changes for 8 triggers).
    const TRIGGERS = 8, TRIGGER_EVERY = 3;
    const trigPlan: GateFrame[] = [{ edges: 0, level: 0 }, { edges: 0, level: 0 }];
    for (let i = 0; i < TRIGGERS; i++) {
      trigPlan.push({ edges: 1, level: 0 });
      for (let k = 1; k < TRIGGER_EVERY; k++) trigPlan.push({ edges: 0, level: 0 });
    }
    const capBeforeTrig = frozen.captureCount;
    const trig = await driveGateFrames(page, trigPlan, STRIDE, frozen.sceneEnd);
    expect(
      changedFrames(trig.prints),
      `EXACTLY ${TRIGGERS} updates for ${TRIGGERS} triggers — one per rising edge, still otherwise (pattern ${bits(trig.prints)})`,
    ).toBe(TRIGGERS);
    // Cross-check against the module's own capture counter: the pixel count and
    // the decision count must agree, or one of the two instruments is lying.
    expect(
      trig.captureCount - capBeforeTrig,
      'the module captured exactly one frame per trigger (capture-counter cross-check)',
    ).toBe(TRIGGERS);
    expect(
      Math.min(...trig.prints.map((p) => p.nz)),
      'triggered output is real content, not black',
    ).toBeGreaterThan(0.05);

    // ---- (3) HELD GATE → CONTINUOUS ----
    // One rising edge, then the level stays HIGH and is RE-REPORTED by every
    // subsequent tick — which is what makes it a HOLD rather than a trigger.
    //
    // ⚠ TWO CLOCKS, DELIBERATELY SEPARATED. The qualify window is a WALL-CLOCK
    // property of the bridge's replay cadence, so waiting for it in ms is
    // correct. The ASSERTION must not be: "N frames" is a different amount of
    // time on every renderer (7.9 fps under SwiftShader vs ~60+ on a real GPU),
    // so a fixed-length held burst either fails to reach the window on a fast
    // machine or wastes seconds on a slow one. Earlier this test used a single
    // 24-frame burst and located the boundary inside it — which silently became
    // a different assertion per renderer, and at a 75 ms window would not span
    // the window AT ALL on a fast GPU. Split the two: WARM until the wall clock
    // passes the window, then assert over a FIXED frame count.
    const HELD_WARM_CHUNK = 6;   // frames per warm-up round trip
    const HELD_WARM_MAX = 40;    // bound the failure; ~5 s at SwiftShader's 8 fps
    const HELD_TAIL = 8;         // the renderer-INDEPENDENT assertion window
    let heldScene = trig.sceneEnd;
    let warm = await driveGateFrames(
      page,
      Array.from({ length: HELD_WARM_CHUNK }, (_, i) => ({ edges: i === 0 ? 1 : 0, level: 1 })),
      STRIDE, heldScene,
    );
    heldScene = warm.sceneEnd;
    // The rising edge updates a frame immediately (the one-shot), so there is
    // no visible gap while the hold qualifies.
    //
    // ⚠ Compare against the IMMEDIATELY PRECEDING rendered frame — the last
    // frame of the trigger phase. Comparing against an older phase is not the
    // claim being made, and it can ALIAS: the scene walk is modular, so a frame
    // several phases back can legitimately be rendering the same ACIDWARP scene
    // and then "identical" means nothing. Assert the two frames were even
    // looking at different source content before believing the pixel result.
    const beforeHeld = trig.prints[trig.prints.length - 1]!;
    expect(warm.prints[0]!.sc, `INSTRUMENT: the held frame and the frame before it must render DIFFERENT source scenes (both = ${beforeHeld.sc})`)
      .not.toBe(beforeHeld.sc);
    expect(warm.prints[0]!.h, `the rising edge updated the very first held frame (scene ${beforeHeld.sc} → ${warm.prints[0]!.sc})`)
      .not.toBe(beforeHeld.h);
    const riseMs = warm.prints[0]!.t;
    let warmFrames = warm.prints.length;
    while (warm.prints[warm.prints.length - 1]!.t - riseMs < HOLD_QUALIFY_MS && warmFrames < HELD_WARM_MAX) {
      warm = await driveGateFrames(
        page,
        Array.from({ length: HELD_WARM_CHUNK }, () => ({ edges: 0, level: 1 })),
        STRIDE, heldScene,
      );
      heldScene = warm.sceneEnd;
      warmFrames += warm.prints.length;
    }
    const heldElapsedMs = warm.prints[warm.prints.length - 1]!.t - riseMs;
    expect(
      heldElapsedMs,
      `the held warm-up must clear the ${HOLD_QUALIFY_MS} ms qualify window (got ${heldElapsedMs.toFixed(1)} ms over ${warmFrames} frames — raise HELD_WARM_MAX if a renderer is slower than assumed)`,
    ).toBeGreaterThanOrEqual(HOLD_QUALIFY_MS);

    // Now the level is QUALIFIED. Every one of a FIXED number of frames must
    // update — a renderer-independent assertion by construction.
    const heldTail = await driveGateFrames(
      page,
      Array.from({ length: HELD_TAIL }, () => ({ edges: 0, level: 1 })),
      STRIDE, heldScene,
    );
    expect(
      changedFrames(heldTail.prints),
      `HELD gate updates CONTINUOUSLY — every qualified frame changes (pattern ${bits(heldTail.prints)}, after ${heldElapsedMs.toFixed(1)} ms / ${warmFrames} warm frames)`,
    ).toBe(heldTail.prints.length - 1);
    expect(
      Math.min(...heldTail.prints.map((p) => p.nz)),
      'the held-gate output is real content, not black',
    ).toBeGreaterThan(0.05);

    // ---- (4) BACK TO LOW → FROZEN AGAIN (the hold did not latch on) ----
    const refrozen = await driveGateFrames(page, Array.from({ length: 10 }, () => ({ edges: 0, level: 0 })), STRIDE, heldTail.sceneEnd);
    expect(
      changedFrames(refrozen.prints.slice(1)),
      `releasing the held gate freezes again (pattern ${bits(refrozen.prints)})`,
    ).toBe(0);

    // One summary line of the MEASURED frame counts. Printed unconditionally so
    // a CI failure is diagnosable from the log alone (the per-assertion patterns
    // only appear on the assertion that actually broke), and so the renderer's
    // frame pacing — the quantity that differs most between a real GPU and
    // SwiftShader — is on the record for every run.
    // eslint-disable-next-line no-console
    console.log(
      `[freezeframe] changed/total frames — unpatched ${changedFrames(live.prints)}/${live.prints.length - 1}` +
      ` · gate low ${changedFrames(frozenTail)}/${frozenTail.length - 1}` +
      ` · ${TRIGGERS} triggers ${changedFrames(trig.prints)}/${trig.prints.length - 1}` +
      ` · held ${changedFrames(heldTail.prints)}/${heldTail.prints.length - 1}` +
      ` · released ${changedFrames(refrozen.prints.slice(1))}/${refrozen.prints.length - 2}` +
      ` | captures ${trig.captureCount - capBeforeTrig} for ${TRIGGERS} triggers` +
      ` | hold qualified after ${heldElapsedMs.toFixed(1)} ms / ${warmFrames} frames`,
    );

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });

  test('(d) raising QUANT knobs drops the distinct-colour count (posterize)', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await installRenderSmokeHooks(page);

    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');

    await page.evaluate(() => {
      (globalThis as unknown as { __freezeframeForceGate?: number | undefined }).__freezeframeForceGate = undefined;
    });

    // Start with QUANT at 0 (full depth → many colours).
    await spawnPatch(
      page,
      [
        { id: 'v-src', type: 'acidwarp',    position: { x: 40,  y: 40 }, domain: 'video', params: { speed: 0.4, scene: 0 } },
        { id: 'v-ff',  type: 'freezeframe', position: { x: 380, y: 40 }, domain: 'video',
          params: { quant_r: 0, quant_g: 0, quant_b: 0, quant_luma: 0 } },
        { id: 'v-out', type: 'videoOut',    position: { x: 720, y: 40 }, domain: 'video' },
      ],
      [
        { id: 'e-src-ff', from: { nodeId: 'v-src', portId: 'out' },       to: { nodeId: 'v-ff',  portId: 'video_in' }, sourceType: 'video', targetType: 'video' },
        { id: 'e-ff-out', from: { nodeId: 'v-ff',  portId: 'video_out' }, to: { nodeId: 'v-out', portId: 'in' },       sourceType: 'video', targetType: 'video' },
      ],
    );

    await expect(page.locator('.svelte-flow__node-freezeframe'), 'FREEZEFRAME visible').toBeVisible();
    await expect(page.locator('.svelte-flow__node-videoOut'),    'OUTPUT visible').toBeVisible();

    // Drive a fixed burst synchronously so full-depth content is on FREEZEFRAME's
    // FBO, then read it once (non-black + structured + exact frame delta + zero GL
    // errors). Capture the FULL-DEPTH distinct-colour count. (Replaces the old
    // waitForContent poll.)
    await warmRenderPipeline(page);
    const fullStats = await stepAndReadStats(page, { nodeId: 'v-ff', portId: FF_PORT, steps: FIXED_STEPS });
    assertRenderStats(fullStats, FIXED_STEPS);
    const full = await readColorStats(page, 'v-ff', FF_PORT);
    expect(full.nonZeroFrac, 'full-depth output renders content').toBeGreaterThan(0);

    // Crank every QUANT knob to MAX (2 levels per channel → heavy posterize).
    // setParam (engine) is deterministic and avoids a per-frame Y.Doc write.
    await setVideoParam(page, 'v-ff', 'quant_r', 1);
    await setVideoParam(page, 'v-ff', 'quant_g', 1);
    await setVideoParam(page, 'v-ff', 'quant_b', 1);
    await setVideoParam(page, 'v-ff', 'quant_luma', 1);

    // Re-render a fixed burst (FROZEN clock + FROZEN source → the ONLY thing that
    // changed is the QUANT params), read the posterized output FBO once. Two
    // FROZEN reads: posterizing to 2 levels per channel collapses the colour space
    // hard, so the distinct-colour count must DROP below the full-depth count.
    // (Replaces the old waitForCondition poll.)
    const quantStats = await stepAndReadStats(page, { nodeId: 'v-ff', portId: FF_PORT, steps: FIXED_STEPS });
    expect(quantStats.framesDelta, 'quant burst advanced the exact frame count').toBe(FIXED_STEPS);
    const quantized = await readColorStats(page, 'v-ff', FF_PORT);
    expect(quantized.nonZeroFrac, 'quantized output still renders content').toBeGreaterThan(0);
    expect(
      quantized.distinctColors,
      `posterize drops distinct colours (full=${full.distinctColors} quantized=${quantized.distinctColors})`,
    ).toBeLessThan(full.distinctColors);

    expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
  });
});
