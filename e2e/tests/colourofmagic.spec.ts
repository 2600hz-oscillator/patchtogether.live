// e2e/tests/colourofmagic.spec.ts
//
// COLOUR OF MAGIC (multi-colorspace video processor) — DETERMINISTIC
// render-smoke (DRS). The real chain LINES → CHROMA(tint) → COLOUR OF MAGIC
// → videoOut is a pure function of the pinned clock + params (LINES' only time
// read is auto-scroll; CHROMA + COLOUR OF MAGIC read no clock/RNG). With the
// rAF loop PAUSED + the clock PINNED (installRenderSmokeHooks) the test owns
// the exact frame count and each read is a bit-stable sample.
//
// Owner ask: "lines patched in → verify recolorization AND the channel-
// clobbering inputs." This proves, renderer-tolerantly (ratios/dominance, no
// exact triples — CI is SwiftShader):
//   1. all 8 outputs (pass/rgb/ydbdr/hsvhsl/r/g/b/luma) emit non-black
//      (outputs-emit auto-skips the generic sweep because the module has a
//      media input, so the 8 outs are covered HERE);
//   2. recolorization: bias_r raises the rgb out's red; luma out is grayscale;
//      a YDbDr Db bias moves the blue-yellow axis;
//   3. a mono override patched into a channel CLOBBERS that channel (its output
//      pixels change materially vs unpatched) — the real "channel-clobbering"
//      gate;
//   4. OVER vs CLAMP differ at an out-of-range bias.

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

const FIXED_STEPS = 6;

// A structured, all-channel-nonzero source: grayscale LINES stripes tinted by
// CHROMA (deterministic — pure function of the pinned clock).
const SRC_TINT = { tintR: 0.85, tintG: 0.55, tintB: 0.7, tintMix: 0.7 };
// A red-dominant source (green ≈ 0) so a green-channel clobber is unambiguous.
const RED_TINT = { tintR: 0.95, tintG: 0.03, tintB: 0.08, tintMix: 0.92 };

interface SpawnNode { id: string; type: string; position: { x: number; y: number }; domain: 'video'; params?: Record<string, number> }
interface SpawnEdge { id: string; from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string }; sourceType?: string; targetType?: string }

function baseNodes(comParams: Record<string, number> = {}, tint = SRC_TINT): SpawnNode[] {
  return [
    { id: 'lines', type: 'lines', position: { x: 40, y: 40 }, domain: 'video', params: { amp: 10 } },
    { id: 'chroma', type: 'chroma', position: { x: 260, y: 40 }, domain: 'video', params: tint },
    { id: 'com', type: 'colourofmagic', position: { x: 520, y: 60 }, domain: 'video', params: comParams },
    { id: 'v-out', type: 'videoOut', position: { x: 1080, y: 60 }, domain: 'video' },
  ];
}
function baseEdges(): SpawnEdge[] {
  return [
    { id: 'e-l', from: { nodeId: 'lines', portId: 'out' }, to: { nodeId: 'chroma', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
    { id: 'e-c', from: { nodeId: 'chroma', portId: 'out' }, to: { nodeId: 'com', portId: 'in' }, sourceType: 'video', targetType: 'video' },
    { id: 'e-o', from: { nodeId: 'com', portId: 'rgb' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
  ];
}

// DRS read: apply params (same evaluate, no yield) → step a fixed burst → read
// the node's OWN output-port FBO with per-channel stats. Mirrors the proven
// quadralogical.spec helper.
interface ChannelStats {
  framesDelta: number; fbComplete: boolean; glErrors: number[];
  nonZeroFrac: number; variance: number; mean: number; r: number; g: number; b: number;
}
async function setStepRead(
  page: Page,
  opts: { nodeId: string; portId?: string; steps: number; params?: Record<string, number> },
): Promise<ChannelStats> {
  return page.evaluate(({ nodeId, portId, steps, params }) => {
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

function assertFrame(s: ChannelStats, steps: number, minNonZeroFrac = 0.05): void {
  expect(s.framesDelta, 'engine advanced exactly the fixed frame count (loop paused)').toBe(steps);
  expect(s.fbComplete, 'output FBO readable').toBe(true);
  expect(s.glErrors, `GL errors during render: [${s.glErrors.join(',')}]`).toEqual([]);
  expect(s.nonZeroFrac, 'output not all-black').toBeGreaterThan(minNonZeroFrac);
}

test.describe('COLOUR OF MAGIC — multi-colorspace video processor', () => {
  test.describe.configure({ timeout: 120_000 });

  test('real chain: all 8 outputs emit a structured non-black frame', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, baseNodes(), baseEdges());

    // DOM structure.
    await expect(page.locator('.svelte-flow__node-colourofmagic'), 'card visible').toBeVisible();
    await expect(page.locator('[data-testid="colourofmagic-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="colourofmagic-canvas"]')).toHaveCount(1);
    await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);

    for (const port of ['pass', 'rgb', 'ydbdr', 'hsvhsl', 'r', 'g', 'b', 'luma']) {
      const s = await setStepRead(page, { nodeId: 'com', portId: port, steps: FIXED_STEPS });
      assertFrame(s, FIXED_STEPS, 0.05);
      expect(s.variance, `${port} output has spatial structure`).toBeGreaterThan(3);
    }

    // Determinism: a second burst of the rgb out is frame-stable.
    const a = await setStepRead(page, { nodeId: 'com', portId: 'rgb', steps: FIXED_STEPS });
    const b = await setStepRead(page, { nodeId: 'com', portId: 'rgb', steps: FIXED_STEPS });
    expect(Math.abs(a.mean - b.mean), 'frozen rgb out frame-stable').toBeLessThan(0.5);

    expect(errors, 'no console / page errors').toEqual([]);
  });

  test('recolorization: bias_r reddens rgb; luma is grayscale; Db bias moves blue-yellow', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, baseNodes(), baseEdges());

    // rgb out: bias_r low vs high raises mean red.
    const lo = await setStepRead(page, { nodeId: 'com', portId: 'rgb', steps: FIXED_STEPS, params: { bias_r: 0 } });
    const hi = await setStepRead(page, { nodeId: 'com', portId: 'rgb', steps: FIXED_STEPS, params: { bias_r: 0.6 } });
    assertFrame(lo, FIXED_STEPS); assertFrame(hi, FIXED_STEPS);
    expect(hi.r, 'bias_r raises the rgb out red channel').toBeGreaterThan(lo.r + 15);

    // luma out is grayscale (shader writes vec3(v,v,v)).
    const luma = await setStepRead(page, { nodeId: 'com', portId: 'luma', steps: FIXED_STEPS, params: { bias_r: 0 } });
    assertFrame(luma, FIXED_STEPS);
    expect(Math.abs(luma.r - luma.g), 'luma R≈G (grayscale)').toBeLessThan(2);
    expect(Math.abs(luma.g - luma.b), 'luma G≈B (grayscale)').toBeLessThan(2);

    // ydbdr out: a positive Db bias pushes the blue-yellow axis → blue rises.
    const db0 = await setStepRead(page, { nodeId: 'com', portId: 'ydbdr', steps: FIXED_STEPS, params: { bias_db: 0 } });
    const dbHi = await setStepRead(page, { nodeId: 'com', portId: 'ydbdr', steps: FIXED_STEPS, params: { bias_db: 0.4 } });
    assertFrame(db0, FIXED_STEPS); assertFrame(dbHi, FIXED_STEPS);
    expect(dbHi.b, 'positive Db bias raises blue (blue-yellow axis)').toBeGreaterThan(db0.b + 15);

    expect(errors, 'no console / page errors').toEqual([]);
  });

  test('mono override CLOBBERS the channel (green grating replaces a green-poor source)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await installRenderSmokeHooks(page);

    // Baseline A: red-dominant source (green ≈ 0), NO override → g out is dark.
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, baseNodes({}, RED_TINT), baseEdges());
    const a = await setStepRead(page, { nodeId: 'com', portId: 'g', steps: FIXED_STEPS });
    assertFrame(a, FIXED_STEPS, 0.0); // green-poor → may be near-black (that's the point)

    // Baseline B: same source + a SECOND lines grating patched into rgb_g_in →
    // the green channel is CLOBBERED with the bright grating.
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    const nodesB = [
      ...baseNodes({}, RED_TINT),
      { id: 'lines-ovr', type: 'lines', position: { x: 40, y: 300 }, domain: 'video' as const, params: { amp: 14 } },
    ];
    const edgesB: SpawnEdge[] = [
      ...baseEdges(),
      { id: 'e-ovr', from: { nodeId: 'lines-ovr', portId: 'out' }, to: { nodeId: 'com', portId: 'rgb_g_in' }, sourceType: 'mono-video', targetType: 'mono-video' },
    ];
    await spawnPatch(page, nodesB, edgesB);
    const b = await setStepRead(page, { nodeId: 'com', portId: 'g', steps: FIXED_STEPS });
    assertFrame(b, FIXED_STEPS, 0.05);

    // The clobber: the green grating fills the green channel that the source
    // lacked — a wide, renderer-tolerant margin the override can't fake if it
    // regressed to a no-op.
    expect(b.g, 'green override clobbers the green channel (bright grating)').toBeGreaterThan(a.g + 30);
    expect(b.variance, 'clobbered green out has grating structure').toBeGreaterThan(a.variance + 100);

    expect(errors, 'no console / page errors').toEqual([]);
  });

  test('OVER vs CLAMP differ at an out-of-range bias', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, baseNodes(), baseEdges());

    // Drive the red channel past 1.0 (source R ≈ 0.85, +0.9 → up to 1.75).
    // CLAMP clips to 1.0; OVER wraps via fract() → distinct rgb frames.
    const clamp = await setStepRead(page, { nodeId: 'com', portId: 'rgb', steps: FIXED_STEPS, params: { bias_r: 0.9, over_r: 0 } });
    const wrap = await setStepRead(page, { nodeId: 'com', portId: 'rgb', steps: FIXED_STEPS, params: { bias_r: 0.9, over_r: 1 } });
    assertFrame(clamp, FIXED_STEPS); assertFrame(wrap, FIXED_STEPS);
    expect(Math.abs(clamp.r - wrap.r), 'OVER (wrap) and CLAMP (clip) produce different red').toBeGreaterThan(15);

    expect(errors, 'no console / page errors').toEqual([]);
  });
});
