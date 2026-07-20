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

/** Step a fixed burst, then read `nodeId`'s output FBO at the reduced render res
 *  with sparse stats + a coarse 2×2 quadrant luma signature (frametable pattern). */
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
});
