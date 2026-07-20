// e2e/tests/videocube.spec.ts
//
// VIDEOCUBE (the video isomorph of the audio CUBE) — the REAL source-chain gate.
// Two proofs, both renderer-tolerant (CI runs the SwiftShader software renderer,
// where the combine's tap count gates to 4; a flat pixel/encode assert that
// passes on a real GPU goes red there — the recorderbox/edges class):
//
//   1. VIDEO (deterministic, render-smoke clock pinned): wire 3 REAL video
//      sources (ACIDWARP × 3, distinct scenes) → video_a/b/c → videocube →
//      videoOut, and assert video_out is a NON-BLANK, STRUCTURED VOLUMETRIC frame
//      (variance probe, NOT pixel-exact) AND that the render is LIVE — MORPH, the
//      orbit VIEW camera (rot + zoom) and slice Y each change the volume (a real
//      ray-march of the 3D solid, not a static passthrough).
//
//   2. AUDIO (real engine + audio thread): wire the 3 sources → videocube, and
//      videocube.audio_out → a SCOPE, resume audio, and poll the scope over a
//      window for AUDIBLE RMS — the derived cube-slice drone reaches a consumer.
//
// Source chain: acidA/B/C (ACIDWARP) → vc.video_{a,b,c} → vc.video_out → videoOut
//               (+ vc.audio_out → SCOPE for the audio proof).

import { test, expect } from './_fixtures';
import type { Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';
import { readScopeSnapshot, summarize } from './_module-coverage-helpers';

// VIDEOCUBE renders at half engine resolution (VIDEOCUBE_RENDER_SCALE) for the
// 3-ring SwiftShader/CI budget; read its output FBO at the reduced size.
const RENDER_SCALE = 0.5;
// The 6 slice-viz output ports render at the MARCH (quarter) scale
// (VIDEOCUBE_MARCH_SCALE) — read their FBOs at that size.
const MARCH_SCALE = 0.25;
// A static ACIDWARP scene fills the whole ring in one first-frame-fill step; a
// handful of steps establishes a stable, fully-seated buffer for all 3 rings.
const FILL = 24;

interface SpawnNode { id: string; type: string; position: { x: number; y: number }; domain?: 'video'; params?: Record<string, number> }
interface SpawnEdge { id: string; from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string }; sourceType?: string; targetType?: string }

function videoNodes(vcParams: Record<string, number> = {}): SpawnNode[] {
  return [
    { id: 'acidA', type: 'acidwarp', position: { x: 40, y: 40 }, domain: 'video', params: { scene: 0, paletteType: 0, speed: 0 } },
    { id: 'acidB', type: 'acidwarp', position: { x: 40, y: 260 }, domain: 'video', params: { scene: 5, paletteType: 2, speed: 0 } },
    { id: 'acidC', type: 'acidwarp', position: { x: 40, y: 480 }, domain: 'video', params: { scene: 9, paletteType: 3, speed: 0 } },
    { id: 'vc', type: 'videocube', position: { x: 520, y: 200 }, domain: 'video', params: vcParams },
    { id: 'v-out', type: 'videoOut', position: { x: 1120, y: 200 }, domain: 'video' },
  ];
}
function videoEdges(): SpawnEdge[] {
  return [
    { id: 'e-a', from: { nodeId: 'acidA', portId: 'out' }, to: { nodeId: 'vc', portId: 'video_a' }, sourceType: 'video', targetType: 'video' },
    { id: 'e-b', from: { nodeId: 'acidB', portId: 'out' }, to: { nodeId: 'vc', portId: 'video_b' }, sourceType: 'video', targetType: 'video' },
    { id: 'e-c', from: { nodeId: 'acidC', portId: 'out' }, to: { nodeId: 'vc', portId: 'video_c' }, sourceType: 'video', targetType: 'video' },
    { id: 'e-out', from: { nodeId: 'vc', portId: 'video_out' }, to: { nodeId: 'v-out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
  ];
}

interface FrameStats {
  framesDelta: number; fbComplete: boolean; glErrors: number[];
  nonZeroFrac: number; variance: number; mean: number;
  quads: [number, number, number, number];
}

async function setNodeParams(page: Page, nodeId: string, params: Record<string, number>): Promise<void> {
  await page.evaluate(({ nodeId, params }) => {
    const w = globalThis as unknown as { __engine: () => { getDomain: (d: string) => { setParam: (id: string, paramId: string, value: number) => void } } };
    const vid = w.__engine().getDomain('video');
    for (const [k, v] of Object.entries(params)) vid.setParam(nodeId, k, v);
  }, { nodeId, params });
}

/** Step a fixed burst, then read `nodeId`'s output FBO (default video_out, or a
 *  named `port`) at the reduced render res with sparse stats + a coarse 2×2
 *  quadrant luma signature (frametable pattern). Viz ports render at the MARCH
 *  (quarter) scale, so pass scale: MARCH_SCALE when reading them. */
async function stepRead(page: Page, opts: { nodeId: string; steps: number; scale?: number; port?: string }): Promise<FrameStats> {
  return page.evaluate(({ nodeId, steps, scale, port }) => {
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
  expect(s.variance, 'output has spatial structure (a real picture, not a flat fill)').toBeGreaterThan(8);
}

test.describe('VIDEOCUBE — video isomorph of the audio CUBE', () => {
  test.describe.configure({ timeout: 120_000 });

  test('real 3-source chain: ACIDWARP×3 → VIDEOCUBE → non-black STRUCTURED morph on video_out', async ({ page, errorWatch }) => {
    void errorWatch;
    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, videoNodes(), videoEdges());

    // DOM structure — the card + its preview + the OUTPUT sink render.
    await expect(page.locator('.svelte-flow__node-videocube'), 'card visible').toBeVisible();
    await expect(page.locator('[data-testid="videocube-card"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="videocube-preview"]')).toHaveCount(1);
    await expect(page.locator('canvas[data-testid="video-out-canvas"]')).toHaveCount(1);

    // Fill all 3 rings; the default SMOOTH combine of 3 distinct sources is a
    // non-black, STRUCTURED occupancy morph.
    const out = await stepRead(page, { nodeId: 'vc', steps: FILL, scale: RENDER_SCALE });
    assertLiveFrame(out, FILL);
  });

  test('the render is LIVE — MORPH, the orbit VIEW camera, and slice Y each change the volume', async ({ page, errorWatch }) => {
    void errorWatch;
    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    // A mid-connect blend so MORPH FC has a wide A↔C span to move.
    await spawnPatch(page, videoNodes({ connect: 0.4, morph_fc: 0 }), videoEdges());

    // Seat the rings, then read a baseline volume.
    await stepRead(page, { nodeId: 'vc', steps: FILL, scale: RENDER_SCALE });
    const r0 = await stepRead(page, { nodeId: 'vc', steps: 3, scale: RENDER_SCALE });
    assertLiveFrame(r0, 3);

    // MORPH — cross-fade the FLOOR fill toward the CEILING fill through the volume.
    await setNodeParams(page, 'vc', { morph_fc: 1 });
    const rMorph = await stepRead(page, { nodeId: 'vc', steps: 3, scale: RENDER_SCALE });
    assertLiveFrame(rMorph, 3);
    expect(
      signatureDist(r0, rMorph),
      `MORPH 0→1 renders a different volume, dist=${signatureDist(r0, rMorph).toFixed(1)}`,
    ).toBeGreaterThan(3);

    // VIEW ROT — orbit the camera: the whole solid reprojects (a big change).
    await setNodeParams(page, 'vc', { view_rot_y: 2.4 });
    const rView = await stepRead(page, { nodeId: 'vc', steps: 3, scale: RENDER_SCALE });
    assertLiveFrame(rView, 3);
    expect(
      signatureDist(rMorph, rView),
      `VIEW ROT Y orbits the camera → the volume reprojects, dist=${signatureDist(rMorph, rView).toFixed(1)}`,
    ).toBeGreaterThan(3);

    // VIEW ZOOM — pull the camera in: the solid grows in frame.
    await setNodeParams(page, 'vc', { view_zoom: 2.2 });
    const rZoom = await stepRead(page, { nodeId: 'vc', steps: 3, scale: RENDER_SCALE });
    assertLiveFrame(rZoom, 3);
    expect(
      signatureDist(rView, rZoom),
      `VIEW ZOOM changes the framed volume, dist=${signatureDist(rView, rZoom).toFixed(1)}`,
    ).toBeGreaterThan(2);

    // SLICE Y — move the cutting plane through the solid (the plane the audio reads).
    await setNodeParams(page, 'vc', { slice_y: 0.12 });
    const rSlice = await stepRead(page, { nodeId: 'vc', steps: 3, scale: RENDER_SCALE });
    assertLiveFrame(rSlice, 3);
    expect(
      signatureDist(rZoom, rSlice),
      `slice Y moves the cutting plane → the render changes, dist=${signatureDist(rZoom, rSlice).toFixed(1)}`,
    ).toBeGreaterThan(1.5);

    // WRAP — mirror-tile the source videos across the cube (B1: WRAP was DEAD on
    // the PICTURE — byte-identical either way because the marched coords never
    // leave [0,1]; the fix extends the surface-uv domain so ON mirror-tiles the
    // videos → the render must now VISIBLY change when WRAP toggles).
    await setNodeParams(page, 'vc', { wrap: 1 });
    const rWrap = await stepRead(page, { nodeId: 'vc', steps: 3, scale: RENDER_SCALE });
    assertLiveFrame(rWrap, 3);
    expect(
      signatureDist(rSlice, rWrap),
      `WRAP mirror-tiles the surface → the volume changes, dist=${signatureDist(rSlice, rWrap).toFixed(1)}`,
    ).toBeGreaterThan(1.5);
  });

  // AUDIO derivation — the MONO-DRONE cube-slice reaches a consumer. Real engine
  // (no render-smoke: the video rAF fills the rings + the throttled recompute
  // scans them off the audio thread), renderer-tolerant RMS poll (no pixel/fps
  // asserts). Video→audio bridge captures audio_out into a SCOPE analyser.
  test('audio_out: the derived cube-slice drone produces audible RMS at a SCOPE', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'acidA', type: 'acidwarp', position: { x: 40, y: 40 }, domain: 'video', params: { scene: 0, paletteType: 0 } },
        { id: 'acidB', type: 'acidwarp', position: { x: 40, y: 260 }, domain: 'video', params: { scene: 5, paletteType: 2 } },
        { id: 'acidC', type: 'acidwarp', position: { x: 40, y: 480 }, domain: 'video', params: { scene: 9, paletteType: 3 } },
        // A rich slice: mid-morph, off-centre plane so the surface-height scan
        // reads a non-flat cross-section of the 3 luma heightfields.
        { id: 'vc', type: 'videocube', position: { x: 520, y: 200 }, domain: 'video', params: { morph_fc: 0.5, slice_y: 0.35, connect: 0.3, level: 1.5 } },
        { id: 'scope', type: 'scope', position: { x: 1120, y: 200 }, params: { timeMs: 50 } },
      ],
      [
        { id: 'e-a', from: { nodeId: 'acidA', portId: 'out' }, to: { nodeId: 'vc', portId: 'video_a' }, sourceType: 'video', targetType: 'video' },
        { id: 'e-b', from: { nodeId: 'acidB', portId: 'out' }, to: { nodeId: 'vc', portId: 'video_b' }, sourceType: 'video', targetType: 'video' },
        { id: 'e-c', from: { nodeId: 'acidC', portId: 'out' }, to: { nodeId: 'vc', portId: 'video_c' }, sourceType: 'video', targetType: 'video' },
        { id: 'e-aud', from: { nodeId: 'vc', portId: 'audio_out' }, to: { nodeId: 'scope', portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' },
      ],
    );

    // Resume the AudioContext (game/video specs do this so the worklet runs).
    await page.locator('button:has-text("Tap to start")').first().click({ timeout: 2500 }).catch(() => { /* already running */ });

    // Let the rings fill + the worklet load, then nudge a slice param so a fresh
    // recompute posts a wave built from the (now-filled) rings.
    await page.waitForTimeout(1500);
    await setNodeParams(page, 'vc', { morph_fc: 0.6 });

    // Poll the scope over a window; the drone is continuous so any window catches
    // it once audio flows. Max-hold across the window (renderer/timing tolerant).
    let best = { peak: 0, rms: 0, nonzeroSamples: 0, totalSamples: 0 };
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const snap = await readScopeSnapshot(page, 'scope');
      if (snap) {
        const s = summarize(snap.ch1);
        if (s.peak > best.peak) best = s;
      }
      if (best.peak > 0.02) break;
      await setNodeParams(page, 'vc', { slice_y: 0.3 + 0.2 * Math.random() }); // keep recompute alive
      await page.waitForTimeout(200);
    }

    expect(
      best.peak,
      `derived cube-slice drone is audible at the scope (peak=${best.peak.toFixed(4)} rms=${best.rms.toFixed(4)} nonzero=${best.nonzeroSamples})`,
    ).toBeGreaterThan(0.02);
    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });

  // ── SLICE-VIZ output ports (scope/slice/depth + smooth/morph/chaos triptych):
  //    PER-PORT gating (unpatched = zero render), the slice_view flavour + reader
  //    + slice Y·rot response, the triptych's divergence under motion, and
  //    depth_out brightness tracking occupancy. ONE graph (motion sources), many
  //    cheap reads. Renderer-tolerant (variance/signature probes, not pixel-exact).
  test('slice-viz jacks: per-port gating, slice_view/reader/Y·rot response, triptych divergence, depth occupancy', async ({ page, errorWatch }) => {
    void errorWatch;
    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    // Moving sources (speed 1) so the reader modes (SMOOTH trailing vs MORPH
    // newest vs CHAOS per-pixel) read DIFFERENT ring frames → the triptych + a
    // reader-mode change are observable. Mid-connect so occupancy has room to move.
    const nodes: SpawnNode[] = [
      { id: 'acidA', type: 'acidwarp', position: { x: 40, y: 40 }, domain: 'video', params: { scene: 0, paletteType: 0, speed: 1 } },
      { id: 'acidB', type: 'acidwarp', position: { x: 40, y: 260 }, domain: 'video', params: { scene: 5, paletteType: 2, speed: 1 } },
      { id: 'acidC', type: 'acidwarp', position: { x: 40, y: 480 }, domain: 'video', params: { scene: 9, paletteType: 3, speed: 1 } },
      { id: 'vc', type: 'videocube', position: { x: 520, y: 200 }, domain: 'video', params: { connect: 0.4, morph_fc: 0.5 } },
      { id: 'o-vid', type: 'videoOut', position: { x: 1120, y: 40 }, domain: 'video' },
      { id: 'o-slice', type: 'videoOut', position: { x: 1120, y: 160 }, domain: 'video' },
      { id: 'o-depth', type: 'videoOut', position: { x: 1120, y: 280 }, domain: 'video' },
      { id: 'o-smooth', type: 'videoOut', position: { x: 1120, y: 400 }, domain: 'video' },
      { id: 'o-morph', type: 'videoOut', position: { x: 1120, y: 520 }, domain: 'video' },
      { id: 'o-chaos', type: 'videoOut', position: { x: 1120, y: 640 }, domain: 'video' },
    ];
    const vE = (id: string, from: string, to: string, port: string): SpawnEdge =>
      ({ id, from: { nodeId: from, portId: port }, to: { nodeId: to, portId: 'in' }, sourceType: 'video', targetType: 'video' });
    const edges: SpawnEdge[] = [
      { id: 'e-a', from: { nodeId: 'acidA', portId: 'out' }, to: { nodeId: 'vc', portId: 'video_a' }, sourceType: 'video', targetType: 'video' },
      { id: 'e-b', from: { nodeId: 'acidB', portId: 'out' }, to: { nodeId: 'vc', portId: 'video_b' }, sourceType: 'video', targetType: 'video' },
      { id: 'e-c', from: { nodeId: 'acidC', portId: 'out' }, to: { nodeId: 'vc', portId: 'video_c' }, sourceType: 'video', targetType: 'video' },
      vE('e-vid', 'vc', 'o-vid', 'video_out'),
      // slice_out + depth_out + the FULL triptych patched; scope_out UNPATCHED (the
      // per-port gating witness — it must stay black / unrendered).
      vE('e-slice', 'vc', 'o-slice', 'slice_out'),
      vE('e-depth', 'vc', 'o-depth', 'depth_out'),
      vE('e-smooth', 'vc', 'o-smooth', 'smooth_out'),
      vE('e-morph', 'vc', 'o-morph', 'morph_out'),
      vE('e-chaos', 'vc', 'o-chaos', 'chaos_out'),
    ];
    await spawnPatch(page, nodes, edges);

    // Reads step 2 frames to RE-RENDER the viz FBOs; with the rings FROZEN (below)
    // this never advances the ring, so a param change is the only variable.
    const readViz = (port: string, steps = 2) => stepRead(page, { nodeId: 'vc', steps, scale: MARCH_SCALE, port });
    const assertVizStructured = (s: FrameStats, label: string): void => {
      expect(s.fbComplete, `${label} FBO readable`).toBe(true);
      expect(s.glErrors, `${label} GL errors: [${s.glErrors.join(',')}]`).toEqual([]);
      expect(s.nonZeroFrac, `${label} is not all-black (patched → rendered)`).toBeGreaterThan(0.02);
      expect(s.variance, `${label} has spatial structure`).toBeGreaterThan(2);
    };

    // The render-smoke loop is a tight deterministic step() loop (no wall-clock
    // time passes), so a time-based source like ACIDWARP would capture the SAME
    // frame every step → all 60 ring frames identical → the reader modes (SMOOTH
    // trailing / MORPH newest / CHAOS dither) would be indistinguishable BY
    // DESIGN. Inject deterministic RING MOTION by cycling each source's SCENE
    // between captures so the ring window holds DISTINCT frames, then FREEZE the
    // rings so the held varied window is what every subsequent read samples.
    for (let i = 0; i < 14; i++) {
      await setNodeParams(page, 'acidA', { scene: i % 10 });
      await setNodeParams(page, 'acidB', { scene: (i + 3) % 10 });
      await setNodeParams(page, 'acidC', { scene: (i + 6) % 10 });
      await stepRead(page, { nodeId: 'vc', steps: 1, scale: MARCH_SCALE, port: 'video_out' });
    }
    await setNodeParams(page, 'vc', { freeze: 1 }); // hold the varied ring window

    // ── PER-PORT GATING: the 5 PATCHED viz jacks render (non-black + structured);
    //    the UNPATCHED scope_out never renders → stays black. ──
    const slice0 = await readViz('slice_out');
    const depth0 = await readViz('depth_out');
    const smooth = await readViz('smooth_out');
    const morph = await readViz('morph_out');
    const chaos = await readViz('chaos_out');
    assertVizStructured(slice0, 'slice_out');
    assertVizStructured(depth0, 'depth_out');
    assertVizStructured(smooth, 'smooth_out');
    assertVizStructured(morph, 'morph_out');
    assertVizStructured(chaos, 'chaos_out');
    const scopeUnpatched = await readViz('scope_out');
    expect(scopeUnpatched.nonZeroFrac, 'UNPATCHED scope_out is not rendered → black (per-port gate)').toBeLessThan(0.02);
    expect(scopeUnpatched.mean, 'UNPATCHED scope_out near-zero mean').toBeLessThan(3);

    // ── slice_out responds to SLICE VIEW (colorize flavour) ──
    await setNodeParams(page, 'vc', { slice_view: 1 }); // TEXTURED → XRAY
    const sliceXray = await readViz('slice_out');
    assertVizStructured(sliceXray, 'slice_out (xray)');
    expect(signatureDist(slice0, sliceXray), 'slice_view TEXTURED→XRAY recolours the cross-section').toBeGreaterThan(2);
    await setNodeParams(page, 'vc', { slice_view: 2 }); // XRAY → WEIGHTS
    const sliceWeights = await readViz('slice_out');
    assertVizStructured(sliceWeights, 'slice_out (weights)');
    expect(signatureDist(sliceXray, sliceWeights), 'slice_view XRAY→WEIGHTS recolours again').toBeGreaterThan(2);
    await setNodeParams(page, 'vc', { slice_view: 0 }); // back to TEXTURED

    // ── slice_out responds to READER mode (different ring frame under motion) ──
    const sliceReader0 = await readViz('slice_out');
    await setNodeParams(page, 'vc', { reader_mode: 1 }); // SMOOTH → MORPH
    const sliceReader1 = await readViz('slice_out');
    expect(signatureDist(sliceReader0, sliceReader1), 'reader_mode changes which ring frame slice_out reads').toBeGreaterThan(1.5);
    await setNodeParams(page, 'vc', { reader_mode: 0 });

    // ── slice_out responds to slice Y + rotation (the cut slides/tilts) ──
    const sliceBase = await readViz('slice_out');
    await setNodeParams(page, 'vc', { slice_y: 0.15, slice_rx: 0.8 });
    const sliceMoved = await readViz('slice_out');
    expect(signatureDist(sliceBase, sliceMoved), 'slice Y + ROT slide/tilt the cross-section through the solid').toBeGreaterThan(1.5);
    await setNodeParams(page, 'vc', { slice_y: 0.5, slice_rx: 0 });

    // ── TRIPTYCH: SMOOTH (trailing frame) / MORPH (newest frame) / CHAOS
    //    (per-pixel dither) differ from each other over the varied held window
    //    (they read different temporal frames of the SAME rings). ──
    const t_smooth = await readViz('smooth_out');
    const t_morph = await readViz('morph_out');
    const t_chaos = await readViz('chaos_out');
    expect(signatureDist(t_smooth, t_morph), 'SMOOTH (trailing) vs MORPH (newest) differ under motion').toBeGreaterThan(1.5);
    expect(signatureDist(t_chaos, t_morph), 'CHAOS (per-pixel dither) vs MORPH differ under motion').toBeGreaterThan(1.5);
    expect(signatureDist(t_chaos, t_smooth), 'CHAOS vs SMOOTH differ under motion').toBeGreaterThan(1.5);

    // ── depth_out brightness TRACKS occupancy: swelling the connector
    //    (CONNECT STRENGTH 0→1) adds solid → the heightmap gets BRIGHTER. ──
    await setNodeParams(page, 'vc', { connect_strength: 0 });
    const depthLow = await readViz('depth_out');
    await setNodeParams(page, 'vc', { connect_strength: 1 });
    const depthHigh = await readViz('depth_out');
    expect(depthHigh.mean, `more occupancy → brighter depth_out (low=${depthLow.mean.toFixed(1)} high=${depthHigh.mean.toFixed(1)})`)
      .toBeGreaterThan(depthLow.mean + 0.5);
  });

  // scope_out = a VIDEO trace of the exact 256-sample surface-height wave audio_out
  // plays. Needs the audio worklet up (the wave is the ALREADY-COMPUTED derived
  // wave). Assert the trace is non-black AND its per-column position CORRELATES
  // with the wave (renderer-tolerant Pearson |r|, flip-agnostic).
  test('scope_out: a video trace whose shape matches the audio wave', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');

    await spawnPatch(
      page,
      [
        { id: 'acidA', type: 'acidwarp', position: { x: 40, y: 40 }, domain: 'video', params: { scene: 0, paletteType: 0, speed: 0 } },
        { id: 'acidB', type: 'acidwarp', position: { x: 40, y: 260 }, domain: 'video', params: { scene: 5, paletteType: 2, speed: 0 } },
        { id: 'acidC', type: 'acidwarp', position: { x: 40, y: 480 }, domain: 'video', params: { scene: 9, paletteType: 3, speed: 0 } },
        { id: 'vc', type: 'videocube', position: { x: 520, y: 200 }, domain: 'video', params: { morph_fc: 0.5, slice_y: 0.35, connect: 0.3 } },
        { id: 'o-scope', type: 'videoOut', position: { x: 1120, y: 200 }, domain: 'video' },
      ],
      [
        { id: 'e-a', from: { nodeId: 'acidA', portId: 'out' }, to: { nodeId: 'vc', portId: 'video_a' }, sourceType: 'video', targetType: 'video' },
        { id: 'e-b', from: { nodeId: 'acidB', portId: 'out' }, to: { nodeId: 'vc', portId: 'video_b' }, sourceType: 'video', targetType: 'video' },
        { id: 'e-c', from: { nodeId: 'acidC', portId: 'out' }, to: { nodeId: 'vc', portId: 'video_c' }, sourceType: 'video', targetType: 'video' },
        { id: 'e-scope', from: { nodeId: 'vc', portId: 'scope_out' }, to: { nodeId: 'o-scope', portId: 'in' }, sourceType: 'video', targetType: 'video' },
      ],
    );

    // Resume audio so the derived-wave recompute stands up (scope reads lastWave).
    await page.locator('button:has-text("Tap to start")').first().click({ timeout: 2500 }).catch(() => { /* already running */ });

    // Poll: step the engine (fills rings + renders scope_out) and wait until the
    // engine has a non-silent derived wave AND scope_out is non-black.
    const readScopeAndWave = () => page.evaluate(({ scale }) => {
      const w = globalThis as unknown as { __engine: () => { getDomain: (d: string) => {
        gl: WebGL2RenderingContext; step: () => void;
        outputTexture: (id: string, port?: string) => WebGLTexture | null;
        read: (id: string, key: string) => unknown;
        res: { width: number; height: number };
      } } };
      const vid = w.__engine().getDomain('video');
      const gl = vid.gl;
      for (let i = 0; i < 4; i++) vid.step();
      const wave = vid.read('vc', 'lastWave') as Float32Array | null;
      const tex = vid.outputTexture('vc', 'scope_out') as WebGLTexture | null;
      const W = Math.max(1, Math.round(vid.res.width * scale));
      const H = Math.max(1, Math.round(vid.res.height * scale));
      const fb = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      const px = new Uint8Array(W * H * 4);
      if (complete) gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      // For each column x, the trace row = argmax over rows of the GREEN channel.
      let nonZero = 0;
      const trace: number[] = [];
      const cols = 24;
      for (let c = 0; c < cols; c++) {
        const x = Math.min(W - 1, Math.round((c + 0.5) / cols * W));
        let bestG = -1, bestY = 0;
        for (let y = 0; y < H; y++) {
          const g = px[(y * W + x) * 4 + 1]!;
          if (g > bestG) { bestG = g; bestY = y; }
        }
        trace.push(bestY / Math.max(1, H - 1));
      }
      for (let i = 0; i < W * H; i++) { if (px[i * 4 + 1]! > 40) nonZero++; }
      // Sample the wave at the SAME 24 column centres → wave01 = wave*0.5+0.5.
      const waveSamp: number[] = [];
      if (wave) {
        for (let c = 0; c < cols; c++) {
          const wi = Math.min(wave.length - 1, Math.round((c + 0.5) / cols * wave.length));
          waveSamp.push((wave[wi] ?? 0) * 0.5 + 0.5);
        }
      }
      return { complete, nonZeroFrac: nonZero / (W * H), hasWave: !!wave, trace, waveSamp };
    }, { scale: 0.25 });

    // Pearson correlation (flip-agnostic via |r|).
    const pearsonAbs = (a: number[], b: number[]): number => {
      const n = Math.min(a.length, b.length);
      let sa = 0, sb = 0; for (let i = 0; i < n; i++) { sa += a[i]!; sb += b[i]!; }
      const ma = sa / n, mb = sb / n;
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < n; i++) { const x = a[i]! - ma, y = b[i]! - mb; num += x * y; da += x * x; db += y * y; }
      const den = Math.sqrt(da * db);
      return den < 1e-9 ? 0 : Math.abs(num / den);
    };

    let snap = await readScopeAndWave();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !(snap.hasWave && snap.nonZeroFrac > 0.01)) {
      await setNodeParams(page, 'vc', { slice_y: 0.3 + 0.2 * Math.random() }); // keep the recompute alive
      await page.waitForTimeout(200);
      snap = await readScopeAndWave();
    }

    expect(snap.hasWave, 'the derived wave stands up (audio worklet loaded + rings filled)').toBe(true);
    expect(snap.complete, 'scope_out FBO readable').toBe(true);
    expect(snap.nonZeroFrac, 'scope_out trace is non-black once the wave exists').toBeGreaterThan(0.01);
    // The trace follows the wave: its per-column position correlates with the wave.
    const r = pearsonAbs(snap.trace, snap.waveSamp);
    expect(r, `scope_out trace matches the audio wave shape (|r|=${r.toFixed(3)})`).toBeGreaterThan(0.4);
    expect(errors, `no page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
