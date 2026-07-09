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

import { test, expect } from './_fixtures';
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

// Output port id → uOutMode / preview value (byte-identical to colourofmagicDef
// OUTPUTS + the `preview` param). LAZY FBO: an output FBO only renders when its
// port is PATCHED downstream OR is the currently-PREVIEWED output — so to read an
// unpatched port's FBO we set `preview` to that port's mode (see setStepRead).
const PORT_MODE: Record<string, number> = {
  pass: 0, rgb: 1, ydbdr: 2, hsvhsl: 3, r: 4, g: 5, b: 6, luma: 7,
  ydb_y: 8, ydb_db: 9, ydb_dr: 10, hsv_h: 11, hsv_s: 12, hsv_v: 13,
  yiq: 14, yiq_y: 15, yiq_i: 16, yiq_q: 17, ycc: 18, ycc_y: 19, ycc_cb: 20, ycc_cr: 21,
};

// DRS read: apply params (same evaluate, no yield) → step a fixed burst → read
// the node's OWN output-port FBO with per-channel stats. Mirrors the proven
// quadralogical.spec helper. Sets `preview` to the read port's mode so the LAZY
// FBO renderer actually draws that port's FBO (unless params already set preview).
interface ChannelStats {
  framesDelta: number; fbComplete: boolean; glErrors: number[];
  nonZeroFrac: number; variance: number; mean: number; r: number; g: number; b: number;
}
async function setStepRead(
  page: Page,
  opts: { nodeId: string; portId?: string; steps: number; params?: Record<string, number> },
): Promise<ChannelStats> {
  const params = { ...(opts.params ?? {}) };
  if (opts.portId !== undefined && params.preview === undefined && PORT_MODE[opts.portId] !== undefined) {
    params.preview = PORT_MODE[opts.portId]!;
  }
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
  }, { nodeId: opts.nodeId, portId: opts.portId, steps: opts.steps, params });
}

function assertFrame(s: ChannelStats, steps: number, minNonZeroFrac = 0.05): void {
  expect(s.framesDelta, 'engine advanced exactly the fixed frame count (loop paused)').toBe(steps);
  expect(s.fbComplete, 'output FBO readable').toBe(true);
  expect(s.glErrors, `GL errors during render: [${s.glErrors.join(',')}]`).toEqual([]);
  expect(s.nonZeroFrac, 'output not all-black').toBeGreaterThan(minNonZeroFrac);
}

test.describe('COLOUR OF MAGIC — multi-colorspace video processor', () => {
  test.describe.configure({ timeout: 120_000 });

  // Six full-colour block outputs — each must carry the source's spatial
  // structure (a real colorized image, not a flat fill).
  const COLOUR_OUTS = ['pass', 'rgb', 'ydbdr', 'hsvhsl', 'yiq', 'ycc'];
  // Sixteen grayscale channel taps — must emit non-black (a chroma tap sits on
  // its ~0.5 / 0.502 pedestal = mid-gray, so "non-black" is the robust,
  // renderer-tolerant floor; a flat neutral chroma tap has little variance).
  const TAP_OUTS = [
    'r', 'g', 'b', 'luma',
    'ydb_y', 'ydb_db', 'ydb_dr', 'hsv_h', 'hsv_s', 'hsv_v',
    'yiq_y', 'yiq_i', 'yiq_q', 'ycc_y', 'ycc_cb', 'ycc_cr',
  ];
  // Luma-family taps carry the stripe brightness → they DO have structure.
  const STRUCTURED_TAPS = ['luma', 'ydb_y', 'hsv_v', 'yiq_y', 'ycc_y'];

  test('real chain: all 22 outputs (6 colour + 16 taps) emit a non-black frame', async ({ page, errorWatch }) => {

    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, baseNodes(), baseEdges());

    // DOM structure — all five block columns present.
    await expect(page.locator('.svelte-flow__node-colourofmagic'), 'card visible').toBeVisible();
    await expect(page.locator('[data-testid="colourofmagic-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="colourofmagic-canvas"]')).toHaveCount(1);
    await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);
    for (const blk of ['rgb', 'ydbdr', 'hsv', 'yiq', 'ycc']) {
      await expect(page.locator(`[data-testid="colourofmagic-block-${blk}"]`), `${blk} block column`).toHaveCount(1);
    }

    // Six colour outs: non-black AND structured (a real colorized picture).
    for (const port of COLOUR_OUTS) {
      const s = await setStepRead(page, { nodeId: 'com', portId: port, steps: FIXED_STEPS });
      assertFrame(s, FIXED_STEPS, 0.05);
      expect(s.variance, `${port} colour output has spatial structure`).toBeGreaterThan(3);
    }
    // Sixteen grayscale taps: FBO renders cleanly + non-black (pedestal gray or brighter).
    for (const port of TAP_OUTS) {
      const s = await setStepRead(page, { nodeId: 'com', portId: port, steps: FIXED_STEPS });
      assertFrame(s, FIXED_STEPS, 0.02);
      const rgbSpread = Math.max(Math.abs(s.r - s.g), Math.abs(s.g - s.b));
      expect(rgbSpread, `${port} tap is grayscale (R≈G≈B)`).toBeLessThan(3);
    }
    // Luma-family taps carry the source's stripe structure.
    for (const port of STRUCTURED_TAPS) {
      const s = await setStepRead(page, { nodeId: 'com', portId: port, steps: FIXED_STEPS });
      expect(s.variance, `${port} luma-tap carries stripe structure`).toBeGreaterThan(3);
    }

    // Determinism: a second burst of the rgb out is frame-stable.
    const a = await setStepRead(page, { nodeId: 'com', portId: 'rgb', steps: FIXED_STEPS });
    const b = await setStepRead(page, { nodeId: 'com', portId: 'rgb', steps: FIXED_STEPS });
    expect(Math.abs(a.mean - b.mean), 'frozen rgb out frame-stable').toBeLessThan(0.5);

  });

  test('YIQ I-bias warms the picture; YCbCr studio-swing responds + crushes', async ({ page, errorWatch }) => {

    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, baseNodes(), baseEdges());

    // YIQ: pushing the I (orange↔cyan flesh-tone) axis warms the yiq out → red up.
    const iLo = await setStepRead(page, { nodeId: 'com', portId: 'yiq', steps: FIXED_STEPS, params: { preview: PORT_MODE.yiq, bias_yiq_i: 0 } });
    const iHi = await setStepRead(page, { nodeId: 'com', portId: 'yiq', steps: FIXED_STEPS, params: { preview: PORT_MODE.yiq, bias_yiq_i: 0.4 } });
    assertFrame(iLo, FIXED_STEPS); assertFrame(iHi, FIXED_STEPS);
    expect(iHi.r, 'YIQ +I bias warms the picture (red up)').toBeGreaterThan(iLo.r + 12);

    // Studio-swing: a positive Y' bias lifts luma on the ycc out (the crush block responds).
    const yLo = await setStepRead(page, { nodeId: 'com', portId: 'ycc', steps: FIXED_STEPS, params: { preview: PORT_MODE.ycc, bias_ycc_y: 0 } });
    const yHi = await setStepRead(page, { nodeId: 'com', portId: 'ycc', steps: FIXED_STEPS, params: { preview: PORT_MODE.ycc, bias_ycc_y: 0.3 } });
    assertFrame(yLo, FIXED_STEPS); assertFrame(yHi, FIXED_STEPS);
    expect(yHi.mean, 'studio-swing +Y bias lifts luma').toBeGreaterThan(yLo.mean + 12);

    // Studio-swing over-drive: CLAMP (legalizer clip) vs WRAP (super-white fold) differ.
    const ccClamp = await setStepRead(page, { nodeId: 'com', portId: 'ycc', steps: FIXED_STEPS, params: { preview: PORT_MODE.ycc, bias_ycc_y: 0.8, over_ycc_y: 0 } });
    const ccWrap = await setStepRead(page, { nodeId: 'com', portId: 'ycc', steps: FIXED_STEPS, params: { preview: PORT_MODE.ycc, bias_ycc_y: 0.8, over_ycc_y: 1 } });
    assertFrame(ccClamp, FIXED_STEPS); assertFrame(ccWrap, FIXED_STEPS);
    expect(Math.abs(ccClamp.mean - ccWrap.mean), 'studio-swing CLAMP vs WRAP differ at over-drive').toBeGreaterThan(15);

  });

  test('palette REPLACE visibly recolours the rgb out at the default swatches (nudge)', async ({ page, errorWatch }) => {

    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, baseNodes(), baseEdges());

    // The discoverability fix: swatches default to a NON-IDENTITY teal/orange/violet,
    // so turning REPLACE on (default off) visibly recolours the rgb out WITHOUT the
    // user first picking a colour — proving REPLACE "does something" out of the box.
    const direct = await setStepRead(page, { nodeId: 'com', portId: 'rgb', steps: FIXED_STEPS, params: { preview: PORT_MODE.rgb, replace: 0 } });
    const replaced = await setStepRead(page, { nodeId: 'com', portId: 'rgb', steps: FIXED_STEPS, params: { preview: PORT_MODE.rgb, replace: 1 } });
    assertFrame(direct, FIXED_STEPS); assertFrame(replaced, FIXED_STEPS);
    const channelShift = Math.abs(direct.r - replaced.r) + Math.abs(direct.g - replaced.g) + Math.abs(direct.b - replaced.b);
    expect(channelShift, 'REPLACE-on at the default swatches materially recolours the rgb out').toBeGreaterThan(20);

  });

  test('recolorization: bias_r reddens rgb; luma is grayscale; Db bias moves blue-yellow', async ({ page, errorWatch }) => {

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

  });

  test('mono override CLOBBERS the channel (green grating replaces a green-poor source)', async ({ page, errorWatch }) => {

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

  });

  test('OVER vs CLAMP differ at an out-of-range bias', async ({ page, errorWatch }) => {

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

  });
});
