// e2e/tests/warrensvisions.spec.ts
//
// WARREN'S VISIONS — DETERMINISTIC render-smoke over the REAL source chain.
//
// A real video source → warrensvisions → videoOut, with the engine's rAF loop
// PAUSED and its clock PINNED (installRenderSmokeHooks), so the test owns the
// exact frame count. Every wait here is a FRAME COUNT: the module commits an
// analysis every SLICE frames and ramps components in over STABILITY commits,
// so "has it settled" is a number of frames and nothing else. A wall-clock
// budget would be ~7.6× fewer frames on the CI software renderer than locally
// and would assert something different on every machine.
//
// Assertions are floors, ratios and DELTAS — never pixel-exact, never fps.
// Reads are RGBA8/UNSIGNED_BYTE off an RGBA8 FBO, the only pair guaranteed
// readable under SwiftShader.
//
// What this covers that the unit lane cannot: that the def's params actually
// reach the engine through setParam, that the readback→FFT→upload→composite
// chain runs inside the real engine without GL errors, and that COHERENCE —
// the control the module exists for — visibly changes the output there.

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

// Frames, not milliseconds. At the default SLICE 2 / STABILITY 3 a component
// needs 6 rendered frames to reach full contrast; 16 clears that with room for
// the SLEW envelope (0.25 s ≈ 15 frames at the pinned 60 Hz step) to arrive.
const SETTLE_FRAMES = 16;
// A short burst for "did anything change" reads once already settled.
const BURST_FRAMES = 6;
// The DC term slews with SLEW (0.25 s), so a comparison of LEVEL needs ~4 time
// constants of settling before two reads can be expected to agree. 60 frames
// at the pinned 60 Hz step is 1 s — 98 % converged. This is a FRAME count for
// the same reason everything else here is.
const LEVEL_SETTLE_FRAMES = 60;
// ⚠ The STRUCTURAL comparisons use this SAME budget, and an attempt to give
// them a cheaper one FAILED ON MEASUREMENT — recorded so it is not retried.
//
// The argument for trimming was that `rowSig` has the frame mean removed and
// is therefore blind to the DC envelope these 60 frames exist to settle, so 30
// would do. That is true about the DC and wrong about the test: SLEW governs
// every component's CONTRAST as well as the DC, so at 30 frames the whole
// reconstruction is still low-amplitude and every structural difference
// shrinks with it. The COHERENCE legs collapsed from a clean separation to
// moved 1.54 vs returned 1.58 — indistinguishable, on a module that works.
//
// The budget is not padding. It is how long the AC amplitude takes to become
// representative, and the structural metric needs that as much as the level
// one does.

interface SpawnNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  domain: 'video';
  params?: Record<string, number>;
}
interface SpawnEdge {
  id: string;
  from: { nodeId: string; portId: string };
  to: { nodeId: string; portId: string };
  sourceType?: string;
  targetType?: string;
}

function nodes(params: Record<string, number> = {}): SpawnNode[] {
  return [
    // A grating is the ideal source here: it is exactly one wavevector, so the
    // analysis has a right answer and a broken FFT cannot accidentally look
    // plausible.
    { id: 'lines', type: 'lines', position: { x: 40, y: 60 }, domain: 'video', params: { amp: 6, orient: 0 } },
    { id: 'wv', type: 'warrensvisions', position: { x: 360, y: 60 }, domain: 'video', params },
    { id: 'v-out', type: 'videoOut', position: { x: 980, y: 60 }, domain: 'video' },
  ];
}
const edges = (): SpawnEdge[] => [
  { id: 'e-in', from: { nodeId: 'lines', portId: 'out' }, to: { nodeId: 'wv', portId: 'video_in' }, sourceType: 'mono-video', targetType: 'video' },
  { id: 'e-out', from: { nodeId: 'wv', portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
];

interface Stats {
  framesDelta: number;
  fbComplete: boolean;
  glErrors: number[];
  nonZeroFrac: number;
  variance: number;
  mean: number;
  /**
   * A coarse row signature with the frame mean REMOVED, so it measures
   * STRUCTURE and is invariant to overall level.
   *
   * ⚠ The mean subtraction is the whole point and was added after the raw
   * version produced a confident false negative. The module's DC term slews
   * with SLEW (0.25 s ≈ 15 frames), so an early burst and a late one differ in
   * overall brightness by more than any phase change moves the geometry — the
   * COHERENCE test reported "coherence does nothing" (moved 9.40 < returned
   * 12.35) while measuring nothing but the brightness envelope converging.
   * Level lives in `mean`; structure lives here; neither pretends to be the
   * other.
   */
  rowSig: number[];
  committedFrames: number;
  liveComponents: number;
  smoothPath: boolean;
}

/**
 * Apply params, step a fixed burst, and read the node's own output FBO — all
 * inside ONE page.evaluate, so nothing can interleave and nothing is sampled
 * by a Playwright-side poll loop (which would contend with the very main
 * thread it is measuring).
 */
async function setStepRead(
  page: Page,
  opts: { nodeId: string; steps: number; params?: Record<string, number>; startTime?: number },
): Promise<Stats> {
  return page.evaluate(({ nodeId, steps, params, startTime }) => {
    const w = globalThis as unknown as {
      __videoEngineFreezeTime?: number;
      __engine: () => {
        getDomain: (d: string) => {
          gl: WebGL2RenderingContext;
          step: () => void;
          currentFrameCount: () => number;
          setParam: (id: string, paramId: string, value: number) => void;
          markWatched: (id: string) => void;
          read: (id: string, key: string) => unknown;
          outputTexture: (id: string, port?: string) => WebGLTexture | null;
          res: { width: number; height: number };
        };
      };
    };
    const vid = w.__engine().getDomain('video');
    const gl = vid.gl;
    while (gl.getError() !== gl.NO_ERROR) { /* drain pre-existing */ }
    if (params) for (const [k, v] of Object.entries(params)) vid.setParam(nodeId, k, v);

    // ⚠ KEEP THE NODE WATCHED FOR EVERY STEP.
    //
    // Pull evaluation only draws the subgraph reachable from a WATCHED node,
    // and a watch mark expires after WATCH_TTL_MS = 1500 ms (engine.ts:611).
    // `addNode` marks a node watched on spawn, which is enough on a fast
    // renderer — and is NOT enough on SwiftShader, where booting the page and
    // spawning the patch takes longer than the TTL. The symptom is silent and
    // deeply misleading: `currentFrameCount()` advances exactly as asked and
    // `gl.getError()` is clean, because the engine faithfully ran a frame in
    // which it drew NOTHING. Measured here: every read came back flat with
    // committedFrames 0, i.e. "the module is broken under the software
    // renderer" when the module had simply never been asked to draw.
    //
    // Re-marking before each burst makes the spec independent of how long the
    // boot took, which is the same renderer-independence the frame counting
    // buys everywhere else. Marking the module also covers its upstream: the
    // active set is the reverse-reachable subgraph from the roots.
    vid.markWatched(nodeId);
    const before = vid.currentFrameCount();
    // Advance the PINNED clock one 60 Hz tick per step. The module derives its
    // dt from `frame.time` (the simulation clock) precisely so this works: the
    // engine's own `frame.timeDelta` is wall-clock and collapses to ~0 in a
    // tight step loop, which would leave every envelope at zero and have the
    // test assert against a module that had not run.
    //
    // ⚠ REWIND the simulation clock to a fixed origin when the caller asks.
    // LINES auto-scrolls its phase by `time * 0.15`, so a burst that started
    // later saw a DIFFERENT SOURCE — and comparing two such bursts measures
    // the source moving, not the module. That is exactly how the first draft
    // of the COHERENCE test failed: it reported "coherence does nothing"
    // (moved 5.60 < returned 8.53) on a module whose coherence worked, because
    // the two coherent reads were 16 frames of scroll apart. Pinning the
    // origin makes every burst see the identical frame.
    const t0 = startTime ?? w.__videoEngineFreezeTime ?? 2;
    for (let i = 0; i < steps; i++) {
      w.__videoEngineFreezeTime = t0 + (i + 1) / 60;
      vid.markWatched(nodeId);
      vid.step();
    }
    const framesDelta = vid.currentFrameCount() - before;

    const glErrors: number[] = [];
    let e: number;
    while ((e = gl.getError()) !== gl.NO_ERROR) glErrors.push(e);

    const tex = vid.outputTexture(nodeId) as WebGLTexture | null;
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

    let n = 0, sum = 0, sumSq = 0, nonZero = 0;
    const ROWS = 12;
    const rowSum = new Array<number>(ROWS).fill(0);
    const rowN = new Array<number>(ROWS).fill(0);
    for (let y = 0; y < H; y += 4) {
      const row = Math.min(ROWS - 1, Math.floor((y / H) * ROWS));
      for (let x = 0; x < W; x += 4) {
        const i = (y * W + x) * 4;
        const v = (px[i]! + px[i + 1]! + px[i + 2]!) / 3;
        sum += v; sumSq += v * v; n++;
        rowSum[row]! += v; rowN[row]!++;
        if (v > 8) nonZero++;
      }
    }
    const mean = n ? sum / n : 0;
    return {
      framesDelta,
      fbComplete: complete,
      glErrors,
      nonZeroFrac: n ? nonZero / n : 0,
      variance: n ? sumSq / n - mean * mean : 0,
      mean,
      rowSig: rowSum.map((s, i) => (rowN[i] ? s / rowN[i]! - mean : 0)),
      committedFrames: Number(vid.read(nodeId, 'committedFrames') ?? -1),
      liveComponents: Number(vid.read(nodeId, 'liveComponents') ?? -1),
      smoothPath: vid.read(nodeId, 'smoothPath') === true,
    };
  }, opts);
}

/** A fixed clock origin, so every comparison burst renders the SAME source
 *  frame. Off zero so time-driven terms are exercised rather than degenerate. */
const T0 = 2;

/** Mean absolute difference between two row signatures — a picture that
 *  RESTRUCTURED moves this where a uniform brightening does not. */
const sigDelta = (a: number[], b: number[]): number =>
  a.reduce((acc, v, i) => acc + Math.abs(v - (b[i] ?? 0)), 0) / Math.max(1, a.length);

function assertFrame(s: Stats, steps: number): void {
  expect(s.framesDelta, 'engine advanced exactly the fixed frame count (loop paused)').toBe(steps);
  expect(s.fbComplete, 'output FBO readable').toBe(true);
  expect(s.glErrors, `GL errors during render: [${s.glErrors.join(',')}]`).toEqual([]);
}

async function boot(page: Page, params: Record<string, number> = {}): Promise<void> {
  await installRenderSmokeHooks(page);
  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, nodes(params), edges());
  await expect(page.locator('[data-testid="warrensvisions-card"]')).toHaveCount(1);
}

test.describe("WARREN'S VISIONS — 2D spectral video resynthesis", () => {
  test.describe.configure({ timeout: 120_000 });

  test('real source chain: a grating in → a structured, non-black resynthesis out', async ({ page, errorWatch }) => {
    await boot(page);

    await expect(page.locator('.svelte-flow__node-warrensvisions'), 'card visible').toBeVisible();
    await expect(page.locator('[data-testid="warrensvisions-canvas"]')).toHaveCount(1);
    await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);

    const s = await setStepRead(page, { nodeId: 'wv', steps: SETTLE_FRAMES });
    assertFrame(s, SETTLE_FRAMES);

    // The analysis actually ran, and it ran the number of times SLICE says it
    // should. At SLICE 2 over 16 frames that is 8 commits; allow ±1 for where
    // the counter lands relative to the first frame. A module that silently
    // never committed would still render (black) and pass a bare non-black
    // check against a bright source leaking through MIX — this is the leg that
    // says the SPECTRAL path is what produced the picture.
    expect(s.committedFrames, `commits over ${SETTLE_FRAMES} frames at SLICE 2`).toBeGreaterThanOrEqual(7);
    expect(s.committedFrames).toBeLessThanOrEqual(9);
    expect(s.liveComponents, 'the component bank is populated').toBeGreaterThan(0);

    expect(s.nonZeroFrac, 'output is not all-black').toBeGreaterThan(0.05);
    expect(s.variance, 'output has spatial structure, not a flat fill').toBeGreaterThan(3);

    // Determinism under the pinned clock: two identical bursts from the same
    // settled state agree closely. (Not byte-exact — DRIFT is 0 by default but
    // the SLEW envelope is still converging, so this is a tight floor, not an
    // equality.)
    // Determinism: two bursts from the SAME clock origin see the same source
    // frame and must agree closely. (A floor, not an equality — the SLEW
    // envelope is still converging between them.)
    await setStepRead(page, { nodeId: 'wv', steps: LEVEL_SETTLE_FRAMES, startTime: T0 });
    const a = await setStepRead(page, { nodeId: 'wv', steps: BURST_FRAMES, startTime: T0 });
    const b = await setStepRead(page, { nodeId: 'wv', steps: BURST_FRAMES, startTime: T0 });
    expect(Math.abs(a.mean - b.mean), 'settled output is frame-stable').toBeLessThan(2);
  });

  test('COHERENCE changes the picture — and the instrument can see it', async ({ page, errorWatch }) => {
    // The module's defining claim. COHERENCE 1 re-seats every component's
    // phase on the incoming frame, so the reconstruction sits where the source
    // does; COHERENCE 0 lets phase free-run, so the same spectrum lands
    // somewhere else. Both outputs are structured and have similar overall
    // brightness — which is exactly why the assertion is on the ROW SIGNATURE
    // and not on the mean. A mean-only test would read ~0 difference and
    // report "coherence does nothing" on a working module.
    await boot(page);

    const coherent = await setStepRead(page, {
      nodeId: 'wv',
      steps: LEVEL_SETTLE_FRAMES,
      startTime: T0,
      params: { visionsCoherence: 1, visionsDrift: 0, visionsResidual: 0, visionsMix: 1 },
    });
    assertFrame(coherent, LEVEL_SETTLE_FRAMES);
    expect(coherent.variance, 'coherent reconstruction is structured').toBeGreaterThan(3);

    // Let the free-running bank actually diverge: with the servo off, phase
    // only moves under DRIFT, so DRIFT is what makes "free-running" observable
    // within a bounded frame budget.
    const free = await setStepRead(page, {
      nodeId: 'wv',
      steps: LEVEL_SETTLE_FRAMES,
      startTime: T0,
      params: { visionsCoherence: 0, visionsDrift: 1, visionsResidual: 0, visionsMix: 1 },
    });
    assertFrame(free, LEVEL_SETTLE_FRAMES);
    expect(free.variance, 'free-running output is still a picture, not black').toBeGreaterThan(1);

    // POSITIVE CONTROL FOR THE INSTRUMENT, run first in spirit: re-applying
    // COHERENCE 1 must bring the signature back toward the coherent one. If
    // rowSig could not distinguish these two states at all, this leg and the
    // next would both fail rather than both passing vacuously.
    const back = await setStepRead(page, {
      nodeId: 'wv',
      steps: LEVEL_SETTLE_FRAMES,
      startTime: T0,
      params: { visionsCoherence: 1, visionsDrift: 0, visionsResidual: 0, visionsMix: 1 },
    });
    assertFrame(back, LEVEL_SETTLE_FRAMES);

    const moved = sigDelta(coherent.rowSig, free.rowSig);
    const returned = sigDelta(coherent.rowSig, back.rowSig);
    expect(
      moved,
      `COHERENCE 0 + DRIFT restructured the picture (moved=${moved.toFixed(2)}, returned=${returned.toFixed(2)})`,
    ).toBeGreaterThan(returned);
  });

  test('MIX 0 is a passthrough of the source', async ({ page, errorWatch }) => {
    // The cheapest honest check that the composite is wired the way the def
    // says: at MIX 0 the module must hand the source straight through, so its
    // output has to match what the source alone produces.
    await boot(page);
    const wet = await setStepRead(page, { nodeId: 'wv', steps: SETTLE_FRAMES, startTime: T0, params: { visionsMix: 1, visionsComponents: 4 } });
    assertFrame(wet, SETTLE_FRAMES);
    const dry = await setStepRead(page, { nodeId: 'wv', steps: BURST_FRAMES, startTime: T0, params: { visionsMix: 0 } });
    assertFrame(dry, BURST_FRAMES);
    const src = await setStepRead(page, { nodeId: 'lines', steps: BURST_FRAMES, startTime: T0 });

    expect(sigDelta(dry.rowSig, src.rowSig), 'MIX 0 matches the source').toBeLessThan(6);
    // …and the negative control: the WET state at 4 components does NOT match
    // the source, so "matches the source" is not something every state does.
    expect(sigDelta(wet.rowSig, src.rowSig), 'MIX 1 with a thinned bank does NOT match the source')
      .toBeGreaterThan(sigDelta(dry.rowSig, src.rowSig));
  });

  test('FREEZE stops the analysis while the module keeps rendering', async ({ page, errorWatch }) => {
    await boot(page);
    const live = await setStepRead(page, { nodeId: 'wv', steps: SETTLE_FRAMES });
    assertFrame(live, SETTLE_FRAMES);
    expect(live.committedFrames).toBeGreaterThan(0);

    const frozen = await setStepRead(page, { nodeId: 'wv', steps: SETTLE_FRAMES, params: { engineFreeze: 1 } });
    assertFrame(frozen, SETTLE_FRAMES);
    // The commit counter did not move…
    expect(frozen.committedFrames, 'FREEZE stops the analysis').toBe(live.committedFrames);
    // …but the module still drew every frame, and still has a picture.
    expect(frozen.nonZeroFrac, 'a frozen bank still renders').toBeGreaterThan(0.05);

    // Releasing it resumes — the negative control that stops the leg above
    // passing against a module whose analysis is simply broken.
    const resumed = await setStepRead(page, { nodeId: 'wv', steps: SETTLE_FRAMES, params: { engineFreeze: 0 } });
    assertFrame(resumed, SETTLE_FRAMES);
    expect(resumed.committedFrames, 'releasing FREEZE resumes the analysis').toBeGreaterThan(frozen.committedFrames);
  });

  test('unpatched input renders black without erroring', async ({ page, errorWatch }) => {
    await installRenderSmokeHooks(page);
    await page.goto('/rack?shell=legacy&seed=none');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [{ id: 'wv', type: 'warrensvisions', position: { x: 360, y: 60 }, domain: 'video' }],
      [],
    );
    const s = await setStepRead(page, { nodeId: 'wv', steps: BURST_FRAMES });
    assertFrame(s, BURST_FRAMES);
    expect(s.nonZeroFrac, 'an effect with no input is black').toBeLessThan(0.02);
  });
});
