// e2e/tests/frametable.spec.ts
//
// FRAMETABLE (video WAVETABLE oscillator, 3-mode rework) — DETERMINISTIC
// render-smoke over the REAL source chain. The standard's "real source chain"
// gate for a video PROCESSOR: wire a real source → FRAMETABLE → assert a
// non-black, STRUCTURED output, and prove the mode/lag contract end-to-end:
//   • all three render modes (SMOOTH / MORPH / CHAOS) render DISTINCT non-blank
//     output over the same ring (CHAOS = per-pixel dither → higher variance than
//     the SMOOTH/MORPH blends),
//   • the FREEZE contract (a frozen ring HOLDS the output while the input
//     changes; releasing lets it track again),
//   • the LAG contract (SMOOTH lags the input by default = it HOLDS old content
//     while new frames wash in; LIVE forces real-time so the output MOVES toward
//     the new input; CHAOS is always real-time = it tracks immediately).
// Renderer-tolerant (floors + a coarse quadrant signature + WITHIN-RUN variance
// ordering, NOT pixel-exact, NOT fps asserts) — CI runs SwiftShader (SMOOTH taps
// gate to 4 there vs 8 on a GPU), so a flat pixel/encode assert that passes on a
// real GPU goes red there. Read RGBA8/UNSIGNED_BYTE off the RGBA8 FBO at the
// module's REDUCED (half) render resolution.
//
// Under installRenderSmokeHooks the rAF loop is PAUSED + the engine clock is
// PINNED, so the test owns the exact frame count and ACIDWARP (whose plasma is
// STATIC under a pinned clock, regenerating only on a scene/palette change) is a
// controllable input: changing ACIDWARP's `scene`/`paletteType` is how we make
// the recorded input CHANGE deterministically. Because scene0 is static, the
// first-frame-fill fills the whole 60-layer ring with it in one step, so a few
// steps establish a fully-scene0 buffer; a scene change then washes in over ~N
// frames from the write head. (No relay/collab — a single-process render spec.)
//
// Source chain:
//   acid (ACIDWARP) → ft.video_in → ft.video_out → videoOut

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

// FRAMETABLE renders at half engine resolution (FRAMETABLE_RENDER_SCALE) for the
// SwiftShader/CI budget; read its output FBO at the reduced size.
const RENDER_SCALE = 0.5;
// Mode encoding (frametable-core.ts) — literals to keep the spec import-free.
const MODE_SMOOTH = 0;
const MODE_MORPH = 1;
const MODE_CHAOS = 2;
// scene0 is static, so first-frame-fill makes the ring fully scene0 in one step;
// a handful of steps establishes a stable non-black buffer.
const FILL = 8;
// Fully seat the ring for the general non-black probe.
const FILL_FULL = 24;

interface SpawnNode { id: string; type: string; position: { x: number; y: number }; domain: 'video'; params?: Record<string, number> }
interface SpawnEdge { id: string; from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string }; sourceType?: string; targetType?: string }

function chainNodes(ftParams: Record<string, number> = {}): SpawnNode[] {
  return [
    { id: 'acid', type: 'acidwarp', position: { x: 40, y: 60 }, domain: 'video', params: { scene: 0, paletteType: 0, speed: 0 } },
    { id: 'ft', type: 'frametable', position: { x: 480, y: 120 }, domain: 'video', params: ftParams },
    { id: 'v-out', type: 'videoOut', position: { x: 1080, y: 120 }, domain: 'video' },
  ];
}
function chainEdges(): SpawnEdge[] {
  return [
    { id: 'e-in', from: { nodeId: 'acid', portId: 'out' }, to: { nodeId: 'ft', portId: 'video_in' }, sourceType: 'video', targetType: 'video' },
    { id: 'e-out', from: { nodeId: 'ft', portId: 'video_out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
  ];
}

interface FrameStats {
  framesDelta: number; fbComplete: boolean; glErrors: number[];
  nonZeroFrac: number; variance: number; mean: number;
  quads: [number, number, number, number]; // per-quadrant mean luma (coarse spatial signature)
}

/** Apply arbitrary node params (base/manual path) — no stepping, no yield. */
async function setNodeParams(page: Page, nodeId: string, params: Record<string, number>): Promise<void> {
  await page.evaluate(({ nodeId, params }) => {
    const w = globalThis as unknown as { __engine: () => { getDomain: (d: string) => { setParam: (id: string, paramId: string, value: number) => void } } };
    const vid = w.__engine().getDomain('video');
    for (const [k, v] of Object.entries(params)) vid.setParam(nodeId, k, v);
  }, { nodeId, params });
}

/** Step a fixed burst, then read `nodeId`'s output FBO at the reduced render res
 *  with sparse per-channel stats + a coarse 2×2 quadrant luma signature. */
async function stepRead(page: Page, opts: { nodeId: string; steps: number; scale?: number }): Promise<FrameStats> {
  return page.evaluate(({ nodeId, steps, scale }) => {
    const w = globalThis as unknown as {
      __engine: () => {
        getDomain: (d: string) => {
          gl: WebGL2RenderingContext;
          step: () => void;
          currentFrameCount: () => number;
          outputTexture: (id: string, port?: string) => WebGLTexture | null;
          res: { width: number; height: number };
        };
      };
    };
    const vid = w.__engine().getDomain('video');
    const gl = vid.gl;
    while (gl.getError() !== gl.NO_ERROR) { /* drain */ }

    const before = vid.currentFrameCount();
    for (let i = 0; i < steps; i++) vid.step();
    const framesDelta = vid.currentFrameCount() - before;

    const glErrors: number[] = [];
    let e: number;
    while ((e = gl.getError()) !== gl.NO_ERROR) glErrors.push(e);

    const tex = vid.outputTexture(nodeId) as WebGLTexture | null;
    const s = scale ?? 1;
    const W = Math.max(1, Math.round(vid.res.width * s));
    const H = Math.max(1, Math.round(vid.res.height * s));
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    const px = new Uint8Array(W * H * 4);
    if (complete) gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    while (gl.getError() !== gl.NO_ERROR) { /* drain */ }

    let n = 0, sum = 0, sumSq = 0, nonZero = 0;
    const qSum = [0, 0, 0, 0];
    const qN = [0, 0, 0, 0];
    for (let p = 0; p < W * H; p += 8) {
      const i = p * 4;
      const r = px[i]!, g = px[i + 1]!, b = px[i + 2]!;
      const v = (r + g + b) / 3;
      sum += v; sumSq += v * v; n++;
      if (v > 8) nonZero++;
      const x = p % W, y = (p / W) | 0;
      const qi = (y < H / 2 ? 0 : 2) + (x < W / 2 ? 0 : 1);
      qSum[qi]! += v; qN[qi]!++;
    }
    const mean = n ? sum / n : 0;
    const variance = n ? sumSq / n - mean * mean : 0;
    const quads = [0, 1, 2, 3].map((q) => (qN[q] ? qSum[q]! / qN[q]! : 0)) as [number, number, number, number];
    return { framesDelta, fbComplete: complete, glErrors, nonZeroFrac: n ? nonZero / n : 0, variance, mean, quads };
  }, opts);
}

/** L1 distance of the coarse quadrant signature + global mean — renderer-tolerant
 *  "did the picture change" probe (same renderer, so pixel-scale drift cancels). */
function signatureDist(a: FrameStats, b: FrameStats): number {
  let d = Math.abs(a.mean - b.mean);
  for (let q = 0; q < 4; q++) d += Math.abs(a.quads[q]! - b.quads[q]!);
  return d;
}

function assertLiveFrame(s: FrameStats, steps: number): void {
  expect(s.framesDelta, 'engine advanced exactly the fixed frame count (loop paused)').toBe(steps);
  expect(s.fbComplete, 'output FBO readable').toBe(true);
  expect(s.glErrors, `GL errors during render: [${s.glErrors.join(',')}]`).toEqual([]);
  expect(s.nonZeroFrac, 'output is not all-black').toBeGreaterThan(0.05);
  // Variance probe (renderer-tolerant): a structured plasma is not a flat fill.
  // Low floor so SwiftShader's softer render still clears.
  expect(s.variance, 'output has spatial structure (a real picture, not a flat fill)').toBeGreaterThan(8);
}

test.describe('FRAMETABLE — video wavetable oscillator (3 modes)', () => {
  test.describe.configure({ timeout: 120_000 });

  test('real source chain: ACIDWARP → FRAMETABLE (default SMOOTH) → non-black STRUCTURED video_out', async ({ page, errorWatch }) => {
    void errorWatch;
    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, chainNodes(), chainEdges());

    // DOM structure — the card + its mode selector + preview + the OUTPUT sink render.
    await expect(page.locator('.svelte-flow__node-frametable'), 'card visible').toBeVisible();
    await expect(page.locator('[data-testid="frametable-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="frametable-mode"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="frametable-preview"]')).toHaveCount(1);
    await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);

    // Fill the ring; the default SMOOTH weighted-average field is non-black + structured.
    const out = await stepRead(page, { nodeId: 'ft', steps: FILL_FULL, scale: RENDER_SCALE });
    assertLiveFrame(out, FILL_FULL);
  });

  test('the three modes render DISTINCT non-black output over the same ring', async ({ page, errorWatch }) => {
    void errorWatch;
    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    // A wide window over a ring holding TWO scenes → the modes differ maximally:
    // CHAOS per-pixel dithers the two scenes (high spatial variance), SMOOTH/MORPH
    // blend them (lower variance); SMOOTH's waveform field warps it distinctly.
    await spawnPatch(page, chainNodes({
      morph: 0.5, spread: 30, waveAmtX: 0.5, waveAmtY: 0.5, waveFreqX: 2, waveFreqY: 2,
    }), chainEdges());

    // Seed the ring: scene0 (fills whole ring), then wash in ~half a ring of scene9.
    await stepRead(page, { nodeId: 'ft', steps: FILL, scale: RENDER_SCALE });
    await setNodeParams(page, 'acid', { scene: 9, paletteType: 3 });
    await stepRead(page, { nodeId: 'ft', steps: 25, scale: RENDER_SCALE });

    // FREEZE the ring so every mode reads IDENTICAL 60-frame content.
    await setNodeParams(page, 'ft', { freeze: 1 });

    await setNodeParams(page, 'ft', { mode: MODE_SMOOTH });
    const smooth = await stepRead(page, { nodeId: 'ft', steps: 3, scale: RENDER_SCALE });
    await setNodeParams(page, 'ft', { mode: MODE_MORPH });
    const morph = await stepRead(page, { nodeId: 'ft', steps: 3, scale: RENDER_SCALE });
    await setNodeParams(page, 'ft', { mode: MODE_CHAOS });
    const chaos = await stepRead(page, { nodeId: 'ft', steps: 3, scale: RENDER_SCALE });

    // Each mode renders a real, non-blank, structured picture.
    for (const [name, s] of [['smooth', smooth], ['morph', morph], ['chaos', chaos]] as const) {
      expect(s.fbComplete, `${name}: FBO readable`).toBe(true);
      expect(s.glErrors, `${name}: GL errors [${s.glErrors.join(',')}]`).toEqual([]);
      expect(s.nonZeroFrac, `${name}: not all-black`).toBeGreaterThan(0.05);
      expect(s.variance, `${name}: has spatial structure`).toBeGreaterThan(8);
    }

    // CHAOS is a per-pixel DITHER of the two scenes → strictly MORE spatial
    // variance than the SMOOTH/MORPH blends of the same ring (a within-run
    // ordering, renderer-independent).
    expect(chaos.variance, `CHAOS dither variance (${chaos.variance.toFixed(0)}) > SMOOTH blend (${smooth.variance.toFixed(0)})`).toBeGreaterThan(smooth.variance);
    expect(chaos.variance, `CHAOS dither variance (${chaos.variance.toFixed(0)}) > MORPH blend (${morph.variance.toFixed(0)})`).toBeGreaterThan(morph.variance);
    // All three produce visibly different pictures (coarse signature distance).
    expect(signatureDist(chaos, smooth), 'CHAOS vs SMOOTH differ').toBeGreaterThan(3);
    expect(signatureDist(chaos, morph), 'CHAOS vs MORPH differ').toBeGreaterThan(3);
    expect(signatureDist(smooth, morph), 'SMOOTH field-warp vs MORPH uniform-dissolve differ').toBeGreaterThan(2);
  });

  test('FREEZE holds the output while the input changes; releasing tracks again', async ({ page, errorWatch }) => {
    void errorWatch;
    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    // CHAOS + spread=1 → a single-frame DELTA on the newest ring layer (real-time),
    // so the output IS the most-recently-captured frame — the crispest way to see
    // freeze halt / resume, independent of the lag model.
    await spawnPatch(page, chainNodes({ mode: MODE_CHAOS, morph: 0, spread: 1, shimmer: 0 }), chainEdges());

    // Baseline: ring filled from ACIDWARP scene 0 / palette 0.
    const baseline = await stepRead(page, { nodeId: 'ft', steps: FILL, scale: RENDER_SCALE });
    assertLiveFrame(baseline, FILL);

    // FREEZE on, then change the INPUT dramatically. The frozen ring must NOT
    // capture the new frames → the output is HELD.
    await setNodeParams(page, 'ft', { freeze: 1 });
    await setNodeParams(page, 'acid', { scene: 9, paletteType: 3 });
    const frozen = await stepRead(page, { nodeId: 'ft', steps: FILL, scale: RENDER_SCALE });
    assertLiveFrame(frozen, FILL);
    expect(signatureDist(frozen, baseline), 'FREEZE holds video_out while the input changes').toBeLessThan(4);

    // Release FREEZE: the ring resumes capturing → the output tracks the NEW input.
    await setNodeParams(page, 'ft', { freeze: 0 });
    const released = await stepRead(page, { nodeId: 'ft', steps: 30, scale: RENDER_SCALE });
    assertLiveFrame(released, 30);
    expect(signatureDist(released, baseline), 'releasing FREEZE lets video_out track the new input').toBeGreaterThan(10);
    expect(signatureDist(released, frozen), 'released output diverges from the frozen hold').toBeGreaterThan(10);
  });

  test('LAG contract: SMOOTH lags (holds) by default; LIVE forces real-time (tracks); CHAOS is always real-time', async ({ page, errorWatch }) => {
    void errorWatch;
    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    // SMOOTH, deep read (morph=1 → trailing centre near the OLDEST frames), a flat
    // field (waveAmt=0) so the temporal read is clean, small spread for a tight read.
    await spawnPatch(page, chainNodes({
      mode: MODE_SMOOTH, morph: 1, spread: 8, waveAmtX: 0, waveAmtY: 0, shimmer: 0,
    }), chainEdges());

    // Establish a fully-scene0 ring (static scene → first-frame-fill fills it).
    const baseline = await stepRead(page, { nodeId: 'ft', steps: FILL, scale: RENDER_SCALE });
    assertLiveFrame(baseline, FILL);

    // Change the input, step a FEW frames. The deep LAGGED read still sees the old
    // (scene0) content near the tail → the output HOLDS (barely moves).
    await setNodeParams(page, 'acid', { scene: 9, paletteType: 3 });
    const lagged = await stepRead(page, { nodeId: 'ft', steps: 6, scale: RENDER_SCALE });
    assertLiveFrame(lagged, 6);
    expect(signatureDist(lagged, baseline), 'SMOOTH lags by default: output holds while the input changes').toBeLessThan(6);

    // Engage LIVE → real-time read near the write head → the output MOVES toward
    // the new (scene9) input (the lag escape hatch).
    await setNodeParams(page, 'ft', { live: 1 });
    const live = await stepRead(page, { nodeId: 'ft', steps: 12, scale: RENDER_SCALE });
    assertLiveFrame(live, 12);
    expect(signatureDist(live, lagged), 'LIVE forces real-time: output tracks the new input (moves off the lagged hold)').toBeGreaterThan(6);

    // CHAOS is ALWAYS real-time: on a fresh chain it tracks the live input immediately.
    await setNodeParams(page, 'ft', { mode: MODE_CHAOS, live: 0, morph: 0, spread: 1 });
    await setNodeParams(page, 'acid', { scene: 0, paletteType: 0 });
    const chaosBase = await stepRead(page, { nodeId: 'ft', steps: 30, scale: RENDER_SCALE });
    assertLiveFrame(chaosBase, 30);
    await setNodeParams(page, 'acid', { scene: 9, paletteType: 3 });
    const chaosTrack = await stepRead(page, { nodeId: 'ft', steps: 8, scale: RENDER_SCALE });
    assertLiveFrame(chaosTrack, 8);
    expect(signatureDist(chaosTrack, chaosBase), 'CHAOS is real-time: it tracks the new input within a few frames').toBeGreaterThan(8);
  });
});
