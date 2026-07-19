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

  // FILE SAVE / LOAD — the wavetable-style workflow. A LEAN, renderer-tolerant
  // round-trip (variance-probe, NOT pixel-exact — FRAMETABLE is whole-module
  // VRT+behavioral exempt): read the 60 ring layers back → tile into a lossless
  // PNG atlas (NO codec → CI/SwiftShader-safe) → detile it back into the ring
  // and assert the buffer is restored (non-blank + structured), PLUS drive the
  // REAL card file input to prove onFrametableFileChange + the node.data
  // persistence descriptor.
  test('SAVE→LOAD round-trip: ring → PNG atlas → detile restores the buffer; card LOAD persists the file id', async ({ page, errorWatch }) => {
    void errorWatch;
    await installRenderSmokeHooks(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnPatch(page, chainNodes({ mode: MODE_CHAOS, morph: 0.5, spread: 20, shimmer: 0 }), chainEdges());

    // Seed the ring with real varied content (scene0 fills it, scene9 washes in).
    await stepRead(page, { nodeId: 'ft', steps: FILL, scale: RENDER_SCALE });
    await setNodeParams(page, 'acid', { scene: 9, paletteType: 3 });
    await stepRead(page, { nodeId: 'ft', steps: 25, scale: RENDER_SCALE });
    await setNodeParams(page, 'ft', { freeze: 1 });
    const saved = await stepRead(page, { nodeId: 'ft', steps: 3, scale: RENDER_SCALE });
    assertLiveFrame(saved, 3);

    // (1) SAVE — read the 60 ring layers back + tile into a PNG atlas, entirely
    // in-page (a pure canvas encode, no H.264). Assert the atlas is the expected
    // COLS*w × ROWS*h dims + a real non-empty PNG (magic bytes). Stash the atlas
    // CANVAS on window for the in-page detile in step (3) — no giant serialize.
    const atlasInfo = await page.evaluate(() => {
      const COLS = 10, ROWS = 6, TILES = 60;
      const w = globalThis as unknown as {
        __engine: () => { getDomain: (d: string) => { read: (id: string, key: string) => unknown } };
        __ftAtlas?: HTMLCanvasElement;
      };
      const vid = w.__engine().getDomain('video');
      const rb = vid.read('ft', 'ringReadback') as
        | { w: number; h: number; chrono: Uint8Array[] } | undefined;
      if (!rb || !rb.chrono || rb.chrono.length !== TILES) return { ok: false, width: 0, height: 0, tw: 0, th: 0, size: 0, isPng: false };
      const tw = rb.w, th = rb.h, stride = tw * 4;
      const canvas = document.createElement('canvas');
      canvas.width = COLS * tw; canvas.height = ROWS * th;
      const cx = canvas.getContext('2d')!;
      for (let c = 0; c < TILES; c++) {
        const src = rb.chrono[c]!;
        const up = new Uint8ClampedArray(src.length); // flip bottom-origin → upright
        for (let y = 0; y < th; y++) up.set(src.subarray(y * stride, (y + 1) * stride), (th - 1 - y) * stride);
        cx.putImageData(new ImageData(up, tw, th), (c % COLS) * tw, Math.floor(c / COLS) * th);
      }
      w.__ftAtlas = canvas;
      // A synchronous data-URL is enough to assert the encode + magic bytes.
      const url = canvas.toDataURL('image/png');
      const b64 = url.slice(url.indexOf(',') + 1);
      const bin = atob(b64);
      const isPng = bin.charCodeAt(0) === 137 && bin.charCodeAt(1) === 80 && bin.charCodeAt(2) === 78 && bin.charCodeAt(3) === 71;
      return { ok: true, width: canvas.width, height: canvas.height, tw, th, size: bin.length, isPng };
    });
    expect(atlasInfo.ok, 'ringReadback returned 60 chronological layers').toBe(true);
    expect(atlasInfo.isPng, 'atlas encodes a real PNG (magic bytes)').toBe(true);
    expect(atlasInfo.size, 'atlas PNG is non-empty').toBeGreaterThan(100);
    expect(atlasInfo.width, 'atlas width = COLS*tileW').toBe(10 * atlasInfo.tw);
    expect(atlasInfo.height, 'atlas height = ROWS*tileH').toBe(6 * atlasInfo.th);

    // (2) OVERWRITE the ring with a DIFFERENT scene so a restore is observable.
    await setNodeParams(page, 'ft', { freeze: 0 });
    await setNodeParams(page, 'acid', { scene: 0, paletteType: 0 });
    await stepRead(page, { nodeId: 'ft', steps: 60, scale: RENDER_SCALE });

    // (3) LOAD — detile the saved atlas back into the 60 ring layers via the
    // factory's attachExternalSource channel, freeze, and assert the buffer is
    // restored: non-blank + structured (the lean variance-probe).
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __engine: () => { getDomain: (d: string) => { attachExternalSource: (id: string, kind: string, el: unknown) => void } };
        __ftAtlas?: HTMLCanvasElement;
      };
      w.__engine().getDomain('video').attachExternalSource('ft', 'image', w.__ftAtlas);
    });
    await setNodeParams(page, 'ft', { freeze: 1 });
    const restored = await stepRead(page, { nodeId: 'ft', steps: 3, scale: RENDER_SCALE });
    assertLiveFrame(restored, 3); // buffer repopulated from the atlas (not blank)

    // (4) The REAL card LOAD path — set the file input to a small valid synthetic
    // atlas (10×6 tiles of high-contrast noise → detiled layers keep structure),
    // and assert onFrametableFileChange persists the node.data descriptor.
    const atlasBytes = await page.evaluate(async () => {
      const COLS = 10, ROWS = 6, TW = 12, TH = 10;
      const canvas = document.createElement('canvas');
      canvas.width = COLS * TW; canvas.height = ROWS * TH;
      const cx = canvas.getContext('2d')!;
      const img = cx.createImageData(canvas.width, canvas.height);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = Math.random() < 0.5 ? 0 : 255;
        img.data[i] = v; img.data[i + 1] = 255 - v; img.data[i + 2] = (i * 7) & 255; img.data[i + 3] = 255;
      }
      cx.putImageData(img, 0, 0);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
      const buf = new Uint8Array(await blob!.arrayBuffer());
      return Array.from(buf);
    });
    expect(atlasBytes.length, 'synthetic atlas PNG generated').toBeGreaterThan(50);

    await page.setInputFiles('[data-testid="frametable-file-input"]', {
      name: 'roundtrip.frametable.png',
      mimeType: 'image/png',
      buffer: Buffer.from(atlasBytes),
    });
    // The async handler decodes + uploads + persists → surfaces a status line.
    await expect(page.getByTestId('frametable-file-status'), 'card reports a successful load').toContainText('loaded', { timeout: 15_000 });

    // node.data carries ONLY the tiny descriptor (the bytes live in IndexedDB).
    const meta = await page.evaluate(() => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { data?: { frametableFile?: { id: string; frames: number; cols: number; rows: number } } }> } };
      return w.__patch.nodes.ft?.data?.frametableFile ?? null;
    });
    expect(meta, 'node.data.frametableFile persisted').not.toBeNull();
    expect(typeof meta!.id, 'frametableFile.id set (IndexedDB key)').toBe('string');
    expect(meta!.frames, 'descriptor records 60 frames').toBe(60);
    expect(meta!.cols).toBe(10);
    expect(meta!.rows).toBe(6);

    // The card-loaded atlas detiles → the output is a real, non-blank picture.
    const cardLoaded = await stepRead(page, { nodeId: 'ft', steps: 3, scale: RENDER_SCALE });
    assertLiveFrame(cardLoaded, 3);
  });
});
