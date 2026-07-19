// e2e/tests/grains-of-vision.spec.ts
//
// GRAINS OF VISION (granular VIDEO synthesizer) — DETERMINISTIC render-smoke
// over the REAL source chain. The standard's "real source chain" gate for a
// video PROCESSOR: wire a real source → GRAINS OF VISION → assert a non-black,
// STRUCTURED output, that BOTH outputs (out full-chain + grains raw tap) emit,
// that the DRY-passthrough contract holds end-to-end (feedback + reverb dry ⇒
// out == grains), a param response (Size changes coverage), and a COMPOSITE
// response (a patched B modulates the grains). Renderer-tolerant (ratios/floors,
// NOT pixel-exact, NOT fps asserts) — CI runs SwiftShader, so a flat pixel/encode
// assert that passes on a real GPU goes red there. Read RGBA8/UNSIGNED_BYTE off
// the RGBA8 FBO only, at the module's REDUCED render resolution.
//
// With the rAF loop PAUSED + the clock PINNED (installRenderSmokeHooks) the test
// owns the exact frame count, and each burst is a pure function of (spawn, step
// count, params). NOTE: this module carries feedback + reverb accumulators + a
// frame-history ring, so a SECOND burst on the SAME node keeps EVOLVING (by
// design) — we do NOT assert frame-stability across repeated same-node bursts;
// cross-config comparisons use FRESH spawns.
//
// Source chain:
//   linesA (grating)  → gov.in_a   (A = primary material)
//   linesB (grating)  → gov.in_b   (B = modulator, composite test only)
//   gov.out           → videoOut

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

// GRAINS OF VISION renders at half engine resolution (GOV_RENDER_SCALE) for the
// SwiftShader/CI budget; read its output FBO at the reduced size.
const RENDER_SCALE = 0.5;
// A few frames: enough to fill the history ring + let feedback/reverb evolve a
// touch, small enough to stay inside the SwiftShader per-pass budget.
const STEPS = 8;

interface SpawnNode { id: string; type: string; position: { x: number; y: number }; domain: 'video'; params?: Record<string, number> }
interface SpawnEdge { id: string; from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string }; sourceType?: string; targetType?: string }

// in_a always wired; in_b (the modulator) wired only for the composite test.
function baseNodes(govParams: Record<string, number> = {}, withB = false): SpawnNode[] {
  const nodes: SpawnNode[] = [
    { id: 'linesA', type: 'lines', position: { x: 40, y: 40 }, domain: 'video', params: { amp: 6, orient: 0 } },
    { id: 'gov', type: 'grainsOfVision', position: { x: 480, y: 120 }, domain: 'video', params: govParams },
    { id: 'v-out', type: 'videoOut', position: { x: 1080, y: 120 }, domain: 'video' },
  ];
  if (withB) nodes.push({ id: 'linesB', type: 'lines', position: { x: 40, y: 300 }, domain: 'video', params: { amp: 5, orient: 1 } });
  return nodes;
}
function baseEdges(withB = false): SpawnEdge[] {
  const edges: SpawnEdge[] = [
    { id: 'e-a', from: { nodeId: 'linesA', portId: 'out' }, to: { nodeId: 'gov', portId: 'in_a' }, sourceType: 'mono-video', targetType: 'video' },
    { id: 'e-o', from: { nodeId: 'gov', portId: 'out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
  ];
  if (withB) edges.push({ id: 'e-b', from: { nodeId: 'linesB', portId: 'out' }, to: { nodeId: 'gov', portId: 'in_b' }, sourceType: 'mono-video', targetType: 'video' });
  return edges;
}

interface FrameStats {
  framesDelta: number; fbComplete: boolean; glErrors: number[];
  nonZeroFrac: number; variance: number; mean: number; r: number; g: number; b: number;
}

// DRS read: (optionally) apply params in the SAME evaluate, step a fixed burst,
// then read the node's output FBO (a given PORT) at the module's REDUCED render
// res with sparse per-channel stats. Mirrors the sourcery / colourofmagic helper.
async function setStepRead(
  page: Page,
  opts: { nodeId: string; steps: number; port?: string; scale?: number; params?: Record<string, number> },
): Promise<FrameStats> {
  return page.evaluate(({ nodeId, steps, port, scale, params }) => {
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

    const tex = vid.outputTexture(nodeId, port) as WebGLTexture | null;
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

test.describe('GRAINS OF VISION — granular video synthesizer', () => {
  test.describe.configure({ timeout: 120_000 });

  test('real source chain: A patched → structured non-black OUT + GRAINS tap emits', async ({ page, errorWatch }) => {
    void errorWatch;
    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, baseNodes(), baseEdges());

    // DOM structure — the card + its preview canvas + the OUTPUT sink render.
    await expect(page.locator('.svelte-flow__node-grainsOfVision'), 'card visible').toBeVisible();
    await expect(page.locator('[data-testid="grainsOfVision-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="grainsOfVision-preview"]')).toHaveCount(1);
    await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);

    // OUT (full chain) is non-black AND spatially STRUCTURED (a grain field over
    // the grating, not a flat fill).
    const out = await setStepRead(page, { nodeId: 'gov', steps: STEPS, scale: RENDER_SCALE });
    assertFrame(out, STEPS, 0.05);
    expect(out.variance, 'OUT has spatial structure (grains)').toBeGreaterThan(3);

    // GRAINS (the raw scatter tap, 2nd output) also emits a non-black frame.
    const grains = await setStepRead(page, { nodeId: 'gov', steps: STEPS, port: 'grains', scale: RENDER_SCALE });
    assertFrame(grains, STEPS, 0.05);
    expect(grains.variance, 'GRAINS tap has structure').toBeGreaterThan(3);
  });

  test('dry-passthrough contract: feedback + reverb dry ⇒ OUT equals the GRAINS tap', async ({ page, errorWatch }) => {
    void errorWatch;
    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    // Both blocks bypassed → the chain is transparent → out == grains.
    await spawnPatch(page, baseNodes({ fb_dry: 1, rev_dry: 1 }), baseEdges());

    const out = await setStepRead(page, { nodeId: 'gov', steps: STEPS, scale: RENDER_SCALE });
    const grains = await setStepRead(page, { nodeId: 'gov', steps: 0, port: 'grains', scale: RENDER_SCALE });
    assertFrame(out, STEPS, 0.05);
    // 0 extra steps for the second read → same frame; out (post-dry-blocks) must
    // equal the grains tap it passed through.
    expect(grains.framesDelta).toBe(0);
    expect(Math.abs(out.mean - grains.mean), 'dry feedback+reverb ⇒ OUT == GRAINS').toBeLessThan(2);
  });

  test('param response: Size grows grain coverage (bigger grains ⇒ brighter frame)', async ({ page, errorWatch }) => {
    void errorWatch;
    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    // Bypass feedback + reverb so we read the PURE grain field (isolates Size).
    await spawnPatch(page, baseNodes({ fb_dry: 1, rev_dry: 1 }), baseEdges());

    // Small grains leave gaps filled by the dim fallback (darker); big grains
    // fully cover the frame with source colour (brighter). Renderer-tolerant:
    // assert the mean rises materially, a coverage change the fill can't fake.
    const small = await setStepRead(page, { nodeId: 'gov', steps: STEPS, scale: RENDER_SCALE, params: { grain_size: 0.3 } });
    const big = await setStepRead(page, { nodeId: 'gov', steps: STEPS, scale: RENDER_SCALE, params: { grain_size: 2.4 } });
    assertFrame(big, STEPS, 0.05);
    expect(big.mean - small.mean, 'bigger grains cover more (brighter mean)').toBeGreaterThan(6);
  });

  test('composite: a patched B (density-map) modulates the grains vs mono-source', async ({ page, errorWatch }) => {
    void errorWatch;
    // Mono (no B): composite is inert → a full grain field.
    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, baseNodes({ fb_dry: 1, rev_dry: 1, composite: 1, comp_amount: 1 }), baseEdges(false));
    const mono = await setStepRead(page, { nodeId: 'gov', steps: STEPS, scale: RENDER_SCALE });
    assertFrame(mono, STEPS, 0.05);

    // With B patched + density-map at full depth, B's dark grating troughs thin
    // the grains out → the coverage/structure changes materially vs mono.
    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, baseNodes({ fb_dry: 1, rev_dry: 1, composite: 1, comp_amount: 1 }, true), baseEdges(true));
    const comp = await setStepRead(page, { nodeId: 'gov', steps: STEPS, scale: RENDER_SCALE });
    assertFrame(comp, STEPS, 0.02);

    const meanDelta = Math.abs(mono.mean - comp.mean);
    const varDelta = Math.abs(mono.variance - comp.variance);
    expect(meanDelta + varDelta, 'B (density-map) modulates the grains vs mono-source').toBeGreaterThan(4);
  });
});
