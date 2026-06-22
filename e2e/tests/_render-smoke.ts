// e2e/tests/_render-smoke.ts
//
// Shared harness for Layer-B DETERMINISTIC render-smoke (DRS) specs — the cure
// for the wall-clock-sampling flake class (plan §5 Layer B). Instead of
// `spawn → waitForTimeout(N) → read pixels once and hope enough rAF frames +
// decode cadence happened` (three un-synchronized clocks, all flaky), the DRS:
//
//   1. installRenderSmokeHooks() BEFORE page.goto(): PAUSE the engine rAF loop
//      (so the test owns the exact frame count) + PIN the engine clock (so a
//      time-animated module renders an identical frame every step).
//   2. spawn a deterministic source (`shapes`) → module.
//   3. stepAndReadStats(): inside ONE page.evaluate (no await → rAF/decode/blit
//      can't interleave) drive engine.step() a FIXED number of times, then read
//      the node's output FBO ONCE via gl.readPixels and compute sparse luma
//      stats + the EXACT engine frame-count DELTA + any GL errors.
//   4. assertRenderStats(): floors + counts only — exact frame delta, FBO
//      readable, zero GL errors, non-black, structured. Renderer-tolerant
//      (SwiftShader vs real GPU disagree on exact pixels but both clear the
//      floors), so a genuine black/flat/GL-error regression still fails while
//      driver pixel divergence never trips it.
//
// No waitForTimeout, no poll, no animation-diff, no exact-pixel assert.

import { type Page, expect } from '@playwright/test';

export interface RenderStats {
  /** Engine frame count advanced by EXACTLY the steps we drove (loop paused). */
  framesDelta: number;
  fbComplete: boolean;
  glErrors: number[];
  nonZeroFrac: number;
  variance: number;
  mean: number;
}

/** Install the determinism hooks BEFORE the app boots (call before page.goto):
 *  pause the engine rAF loop + pin the engine clock. `frozenTimeSec` is any
 *  constant (default 2.0, off-zero so drift terms are exercised, not the t=0
 *  degenerate). */
export async function installRenderSmokeHooks(page: Page, frozenTimeSec = 2.0): Promise<void> {
  await page.addInitScript((t) => {
    const g = globalThis as unknown as { __videoEnginePause?: boolean; __videoEngineFreezeTime?: number };
    g.__videoEnginePause = true;
    g.__videoEngineFreezeTime = t;
  }, frozenTimeSec);
}

/** Drive the video engine `steps` frames SYNCHRONOUSLY (one evaluate, no yield),
 *  then read `nodeId`'s output texture (optionally a named output `portId`) once
 *  and return luma stats + the exact engine frame-count delta + GL errors. */
export async function stepAndReadStats(
  page: Page,
  opts: { nodeId: string; portId?: string; steps: number },
): Promise<RenderStats> {
  return page.evaluate(({ nodeId, portId, steps }) => {
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
    while (gl.getError() !== gl.NO_ERROR) { /* drain pre-existing */ }

    const before = vid.currentFrameCount();
    for (let i = 0; i < steps; i++) vid.step();
    const framesDelta = vid.currentFrameCount() - before;

    const glErrors: number[] = [];
    let e: number;
    while ((e = gl.getError()) !== gl.NO_ERROR) glErrors.push(e);

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
    while (gl.getError() !== gl.NO_ERROR) { /* drain readback (already captured) */ }

    let n = 0, sum = 0, sumSq = 0, nonZero = 0;
    for (let i = 0; i < px.length; i += 4 * 16) {
      const v = (px[i]! + px[i + 1]! + px[i + 2]!) / 3;
      sum += v; sumSq += v * v; n++;
      if (v > 8) nonZero++;
    }
    const mean = n ? sum / n : 0;
    const variance = n ? sumSq / n - mean * mean : 0;
    return { framesDelta, fbComplete: complete, glErrors, nonZeroFrac: n ? nonZero / n : 0, variance, mean };
  }, opts);
}

/** The standard DRS assertion bundle: exact frame count, FBO readable, zero GL
 *  errors, non-black, structured. Floors only (renderer-tolerant). */
export function assertRenderStats(
  stats: RenderStats,
  steps: number,
  opts: { minNonZeroFrac?: number; minVariance?: number } = {},
): void {
  expect(stats.framesDelta, 'engine advanced exactly the fixed frame count (loop paused)').toBe(steps);
  expect(stats.fbComplete, 'output FBO readable').toBe(true);
  expect(stats.glErrors, `GL errors during render: [${stats.glErrors.join(',')}]`).toEqual([]);
  expect(stats.nonZeroFrac, 'output is not all-black').toBeGreaterThan(opts.minNonZeroFrac ?? 0.02);
  expect(stats.variance, 'output has spatial structure (not a flat fill)').toBeGreaterThan(opts.minVariance ?? 15);
}
