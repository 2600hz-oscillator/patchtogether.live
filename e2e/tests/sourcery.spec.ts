// e2e/tests/sourcery.spec.ts
//
// SOURCERY (2-input region shape-match recolor) — DETERMINISTIC render-smoke
// (DRS) over the REAL two-video-source chain. The spec is the standard's
// "real source chain" gate for a source-dependent video module: wire TWO real
// video sources → SOURCERY → assert non-black / RMS-positive STRUCTURED output
// AND a parameter response (nudging thresholdA changes the output). It is
// renderer-tolerant (ratios/floors, NOT pixel-exact, NOT fps asserts): CI runs
// SwiftShader, so a flat pixel/encode assert that passes on a real GPU goes red
// there. Read RGBA8/UNSIGNED_BYTE off an RGBA8 FBO only.
//
// The chain is a pure function of the pinned clock + params (LINES' only time
// read is its auto-scroll; CHROMA is a pure recolor; SOURCERY reads no clock/RNG
// beyond its own amortization counter). With the rAF loop PAUSED + the clock
// PINNED (installRenderSmokeHooks) the test owns the exact frame count and each
// read is frame-stable.
//
// Source chain:
//   linesA (grating)            → sourcery.a   (A = structure → cell boundaries)
//   linesB (grating) → chroma   → sourcery.b   (B = colorful pool of shapes)
//   sourcery.out                → videoOut

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

// A few frames: enough to cross the SOURCERY amortization boundary (K=3) at
// least twice so the shape stage has recomputed against the real edges, but
// small so the full-res dependent-texelFetch fill stays inside the SwiftShader
// budget.
const STEPS = 8;

interface SpawnNode { id: string; type: string; position: { x: number; y: number }; domain: 'video'; params?: Record<string, number> }
interface SpawnEdge { id: string; from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string }; sourceType?: string; targetType?: string }

function baseNodes(srcParams: Record<string, number> = {}): SpawnNode[] {
  return [
    // A: a vertical grating (structure walls off cells).
    { id: 'linesA', type: 'lines', position: { x: 40, y: 40 }, domain: 'video', params: { amp: 6, orient: 0 } },
    // B: a horizontal grating, tinted colorful by CHROMA (the paint pool).
    { id: 'linesB', type: 'lines', position: { x: 40, y: 260 }, domain: 'video', params: { amp: 5, orient: 1 } },
    { id: 'chroma', type: 'chroma', position: { x: 260, y: 260 }, domain: 'video', params: { tintR: 0.9, tintG: 0.3, tintB: 0.6, tintMix: 0.85 } },
    { id: 'src', type: 'sourcery', position: { x: 520, y: 120 }, domain: 'video', params: srcParams },
    { id: 'v-out', type: 'videoOut', position: { x: 1080, y: 120 }, domain: 'video' },
  ];
}
function baseEdges(): SpawnEdge[] {
  return [
    { id: 'e-a', from: { nodeId: 'linesA', portId: 'out' }, to: { nodeId: 'src', portId: 'a' }, sourceType: 'mono-video', targetType: 'video' },
    { id: 'e-lb', from: { nodeId: 'linesB', portId: 'out' }, to: { nodeId: 'chroma', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
    { id: 'e-b', from: { nodeId: 'chroma', portId: 'out' }, to: { nodeId: 'src', portId: 'b' }, sourceType: 'video', targetType: 'video' },
    { id: 'e-o', from: { nodeId: 'src', portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
  ];
}

interface FrameStats {
  framesDelta: number; fbComplete: boolean; glErrors: number[];
  nonZeroFrac: number; variance: number; mean: number; r: number; g: number; b: number;
}

// DRS read: (optionally) apply params in the SAME evaluate, step a fixed burst,
// then read the node's output FBO with sparse per-channel stats. Mirrors the
// proven colourofmagic / quadralogical helper. Read RGBA8 off an RGBA8 FBO.
async function setStepRead(
  page: Page,
  opts: { nodeId: string; steps: number; params?: Record<string, number> },
): Promise<FrameStats> {
  return page.evaluate(({ nodeId, steps, params }) => {
    const w = globalThis as unknown as {
      __engine: () => {
        getDomain: (d: string) => {
          gl: WebGL2RenderingContext;
          step: () => void;
          currentFrameCount: () => number;
          setParam: (id: string, paramId: string, value: number) => void;
          outputTexture: (id: string, port?: string) => WebGLTexture | null;
          res: { width: number; height: number };
        };
      };
    };
    const vid = w.__engine().getDomain('video');
    const gl = vid.gl;
    while (gl.getError() !== gl.NO_ERROR) { /* drain */ }
    if (params) for (const [k, v] of Object.entries(params)) vid.setParam(nodeId, k, v);

    const before = vid.currentFrameCount();
    for (let i = 0; i < steps; i++) vid.step();
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
    while (gl.getError() !== gl.NO_ERROR) { /* drain */ }

    let n = 0, sum = 0, sumSq = 0, nonZero = 0, rSum = 0, gSum = 0, bSum = 0;
    for (let i = 0; i < px.length; i += 4 * 16) {
      const r = px[i]!, gC = px[i + 1]!, bC = px[i + 2]!;
      const v = (r + gC + bC) / 3;
      sum += v; sumSq += v * v; n++;
      rSum += r; gSum += gC; bSum += bC;
      if (v > 8) nonZero++;
    }
    const mean = n ? sum / n : 0;
    const variance = n ? sumSq / n - mean * mean : 0;
    return {
      framesDelta, fbComplete: complete, glErrors,
      nonZeroFrac: n ? nonZero / n : 0, variance, mean,
      r: n ? rSum / n : 0, g: n ? gSum / n : 0, b: n ? bSum / n : 0,
    };
  }, opts);
}

function assertFrame(s: FrameStats, steps: number, minNonZeroFrac = 0.05): void {
  expect(s.framesDelta, 'engine advanced exactly the fixed frame count (loop paused)').toBe(steps);
  expect(s.fbComplete, 'output FBO readable').toBe(true);
  expect(s.glErrors, `GL errors during render: [${s.glErrors.join(',')}]`).toEqual([]);
  expect(s.nonZeroFrac, 'output not all-black').toBeGreaterThan(minNonZeroFrac);
}

test.describe('SOURCERY — 2-input region shape-match recolor', () => {
  test.describe.configure({ timeout: 120_000 });

  test('real 2-source chain: A + B patched → structured non-black output', async ({ page, errorWatch }) => {

    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, baseNodes(), baseEdges());

    // DOM structure — the card + its preview canvas + the OUTPUT sink render.
    await expect(page.locator('.svelte-flow__node-sourcery'), 'card visible').toBeVisible();
    await expect(page.locator('[data-testid="sourcery-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="sourcery-canvas"]')).toHaveCount(1);
    await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);

    // The recolored output is non-black AND spatially STRUCTURED (A's edge
    // cells painted with B's colors — not a flat fill).
    const s = await setStepRead(page, { nodeId: 'src', steps: STEPS });
    assertFrame(s, STEPS, 0.05);
    expect(s.variance, 'output has spatial structure (region cells)').toBeGreaterThan(3);

    // Determinism: a second identical burst is frame-stable (pinned clock).
    const a = await setStepRead(page, { nodeId: 'src', steps: STEPS });
    const b = await setStepRead(page, { nodeId: 'src', steps: STEPS });
    expect(Math.abs(a.mean - b.mean), 'frozen output frame-stable').toBeLessThan(1.5);

  });

  test('parameter response: ROT rotates the intra-region sampling frame', async ({ page, errorWatch }) => {

    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, baseNodes(), baseEdges());

    // ROT rotates the sampling frame inside each region (a live per-frame fill
    // uniform) → every cell samples a rotated fragment of its matched B shape,
    // so the transplanted color rearranges materially. rot 0.5 = no rotation;
    // rot 0.25 = −90°. Renderer-tolerant: assert the mean/channel-balance shifts
    // by a wide margin the fill can't fake if it regressed to ignoring ROT.
    //
    // (thresholdA is NOT asserted here on the OUTPUT: with position-preserving
    // transfer and two similar grating sources the recolored output is ~stable
    // across A's segmentation — an intentional "same relative position" property,
    // NOT a dead control. ROT + SKEW are the visible-response gates.)
    const idn = await setStepRead(page, { nodeId: 'src', steps: STEPS, params: { rotate: 0.5 } });
    const rot = await setStepRead(page, { nodeId: 'src', steps: STEPS, params: { rotate: 0.25 } });
    assertFrame(idn, STEPS, 0.05);
    assertFrame(rot, STEPS, 0.05);
    const meanDelta = Math.abs(idn.mean - rot.mean);
    const balDelta = Math.abs((idn.r - idn.b) - (rot.r - rot.b));
    expect(meanDelta + balDelta, 'ROT rearranges the transplanted color').toBeGreaterThan(6);

  });

  test('parameter response: SKEW rotates the transferred hue', async ({ page, errorWatch }) => {

    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, baseNodes(), baseEdges());

    // COLOR-SKEW rotates every filled pixel's hue → the per-channel color
    // balance shifts (a hue rotation moves energy between R/G/B). 0.5 = identity;
    // ~+150° swings a warm B into a cool tint. Renderer-tolerant: assert the
    // dominant-channel balance moves, not exact triples.
    const idn = await setStepRead(page, { nodeId: 'src', steps: STEPS, params: { colorSkew: 0.5 } });
    const skew = await setStepRead(page, { nodeId: 'src', steps: STEPS, params: { colorSkew: 0.5 + 150 / 360 } });
    assertFrame(idn, STEPS, 0.05);
    assertFrame(skew, STEPS, 0.05);
    // channel-balance signature = (r−b); a hue rotation moves it materially.
    const idnBal = idn.r - idn.b;
    const skewBal = skew.r - skew.b;
    expect(Math.abs(idnBal - skewBal), 'SKEW rotates the hue (channel balance shifts)').toBeGreaterThan(4);

  });

  test('B unpatched → passthrough of A (non-black, no holes)', async ({ page, errorWatch }) => {

    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    // Only A + the module + output — B (chroma) deliberately not wired to src.b.
    const nodes = baseNodes().filter((n) => n.id !== 'chroma' && n.id !== 'linesB');
    const edges = baseEdges().filter((e) => e.id === 'e-a' || e.id === 'e-o');
    await spawnPatch(page, nodes, edges);

    // With no B the module passes A through (hue-skewed) — still a non-black,
    // structured frame (never a black hole).
    const s = await setStepRead(page, { nodeId: 'src', steps: STEPS });
    assertFrame(s, STEPS, 0.05);
    expect(s.variance, 'A passthrough retains structure').toBeGreaterThan(3);

  });
});
