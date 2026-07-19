// e2e/tests/frametable.spec.ts
//
// FRAMETABLE (video WAVETABLE oscillator) — DETERMINISTIC render-smoke over the
// REAL source chain. The standard's "real source chain" gate for a video
// PROCESSOR: wire a real source → FRAMETABLE → assert a non-black, STRUCTURED
// output, and prove the FREEZE contract end-to-end (a frozen ring HOLDS the output
// while the input changes; releasing FREEZE lets the output track the new input
// again). Renderer-tolerant (floors + a coarse quadrant signature, NOT pixel-exact,
// NOT fps asserts) — CI runs SwiftShader, so a flat pixel/encode assert that passes
// on a real GPU goes red there. Read RGBA8/UNSIGNED_BYTE off the RGBA8 FBO at the
// module's REDUCED (half) render resolution.
//
// Under installRenderSmokeHooks the rAF loop is PAUSED + the engine clock is PINNED,
// so the test owns the exact frame count and ACIDWARP (whose plasma is static under a
// pinned clock, regenerating only on a scene/palette change) is a controllable input:
// changing ACIDWARP's `scene`/`paletteType` is how we make the recorded input CHANGE
// deterministically for the FREEZE test. (No relay/collab here — this is a
// single-process render spec.)
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
// Enough steps to seat the change through the ring (spread=1 → the newest layer).
const FILL = 28;
// Fully seat the ring for the general non-black probe.
const FILL_FULL = 48;

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
 *  with sparse per-channel stats + a coarse 2×2 quadrant luma signature. Mirrors
 *  the grains-of-vision DRS read helper. */
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
  // Variance probe (renderer-tolerant): the selected-frame mosaic of a structured
  // plasma is not a flat fill. Low floor so SwiftShader's softer render still clears.
  expect(s.variance, 'output has spatial structure (a real picture, not a flat fill)').toBeGreaterThan(8);
}

test.describe('FRAMETABLE — video wavetable oscillator', () => {
  test.describe.configure({ timeout: 120_000 });

  test('real source chain: ACIDWARP → FRAMETABLE → non-black STRUCTURED video_out', async ({ page, errorWatch }) => {
    void errorWatch;
    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, chainNodes(), chainEdges());

    // DOM structure — the card + its preview canvas + the OUTPUT sink render.
    await expect(page.locator('.svelte-flow__node-frametable'), 'card visible').toBeVisible();
    await expect(page.locator('[data-testid="frametable-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="frametable-preview"]')).toHaveCount(1);
    await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);

    // Fill the ring with the live ACIDWARP frames; video_out is non-black + structured.
    const out = await stepRead(page, { nodeId: 'ft', steps: FILL_FULL, scale: RENDER_SCALE });
    assertLiveFrame(out, FILL_FULL);
  });

  test('FREEZE holds the output while the input changes; releasing tracks again', async ({ page, errorWatch }) => {
    void errorWatch;
    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    // spread=1 → a single-frame DELTA on the newest ring layer, so the output IS
    // the most-recently-captured frame — the crispest way to see freeze halt / resume.
    await spawnPatch(page, chainNodes({ morph: 0, spread: 1, shimmer: 0 }), chainEdges());

    // Baseline: ring filled from ACIDWARP scene 0 / palette 0.
    const baseline = await stepRead(page, { nodeId: 'ft', steps: FILL, scale: RENDER_SCALE });
    assertLiveFrame(baseline, FILL);

    // FREEZE on, then change the INPUT dramatically (new scene + palette). The
    // frozen ring must NOT capture the new frames → the output is HELD.
    await setNodeParams(page, 'ft', { freeze: 1 });
    await setNodeParams(page, 'acid', { scene: 9, paletteType: 3 });
    const frozen = await stepRead(page, { nodeId: 'ft', steps: FILL, scale: RENDER_SCALE });
    assertLiveFrame(frozen, FILL);
    // Held: the output signature barely moved despite the input change.
    expect(signatureDist(frozen, baseline), 'FREEZE holds video_out while the input changes').toBeLessThan(4);

    // Release FREEZE: the ring resumes capturing → the output tracks the NEW input.
    await setNodeParams(page, 'ft', { freeze: 0 });
    const released = await stepRead(page, { nodeId: 'ft', steps: FILL, scale: RENDER_SCALE });
    assertLiveFrame(released, FILL);
    // Tracks: the output signature now differs materially from the baseline (the
    // new scene/palette entered the ring) AND from the frozen hold.
    expect(signatureDist(released, baseline), 'releasing FREEZE lets video_out track the new input').toBeGreaterThan(10);
    expect(signatureDist(released, frozen), 'released output diverges from the frozen hold').toBeGreaterThan(10);
  });
});
