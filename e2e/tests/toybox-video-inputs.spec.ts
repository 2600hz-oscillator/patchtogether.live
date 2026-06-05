// e2e/tests/toybox-video-inputs.spec.ts
//
// TOYBOX video INPUT ports (VID A / VID B) — a VIDEO-kind layer can source a
// LIVE PATCHED FEED off the inA/inB ports instead of a local file/camera.
// Proves the END-TO-END path through the real UI + engine:
//
//   1. Spawn TOYBOX + ACIDWARP (a self-running video source). Patch ACIDWARP.out
//      into TOYBOX.inA (and a separate run: inB).
//   2. Seed layer 0 = a VIDEO layer with videoSource = 'inA'/'inB', and an
//      OUTPUT that shows layer 0.
//   3. Assert the OUTPUT canvas shows the FEED (NON-BLACK + distinct from the
//      idle dark-teal pattern a VIDEO layer paints with no source) — i.e. the
//      patched texture reached the layer FBO and composed to the output.
//   4. Assert it CHANGES WITH THE SOURCE: a layer pointed at the OTHER port
//      (no feed there) falls back to the idle pattern, distinct from the
//      patched-feed average.
//   5. (Projective) Map a patched feed onto an OBJ mesh — layer 1 = video inA,
//      layer 0 = OBJ texturing layer 1 — and assert the textured mesh differs
//      from the matcap-only baseline (so a patched feed flows through the same
//      UV-texmap / projective surface path #603 built).
//
// Determinism: ACIDWARP is animated, but the assertions are coarse (non-black,
// idle-vs-feed delta) so a single frozen TOYBOX render (which forces a full
// engine.step() that renders ACIDWARP first, then TOYBOX whose getInputTexture
// returns ACIDWARP's fresh FBO) is reproducible enough. We freeze + wait for a
// stable, lit, non-idle frame before averaging.
//
// The .selectOption uses { force, noWaitAfter } (load-bearing on CI): TOYBOX's
// WebGL rAF compositor starves the main thread so Playwright's default post-
// action nav-wait is pathologically slow here (see toybox-texture-source.spec.ts).
//
// CI budget: SwiftShader renders TOYBOX + ACIDWARP slowly; each test does 2-3
// frozen captures (each = a GL warm + step), so we give a generous budget
// (≥90s per the ci-swiftshader-video-e2e-timeouts discipline).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';

type VideoLayer = {
  kind: string;
  contentId?: string | null;
  params?: Record<string, number>;
  videoSource?: string;
  material?: Record<string, number | undefined>;
};

type PatchGlobal = {
  __patch: {
    nodes: Record<string, { data?: { layers?: VideoLayer[]; combine?: unknown } }>;
  };
  __ydoc: { transact: (fn: () => void) => void };
  __toyboxFreeze?: (t?: number) => void;
};

/** Pin the viewport at scale 1 so the canvas DOM box is stable. */
async function pinViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
    if (!vp) return;
    vp.style.transition = 'none';
    vp.style.transform = 'translate(8px, -8px) scale(1)';
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

/** A combine graph whose OUTPUT passes layer 0 straight through (fade amount 0). */
function passLayer0Combine(): unknown {
  return {
    nodes: [
      { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
      { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
      { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
      { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
      { id: 'pass', kind: 'fade', x: 120, y: 40, params: { amount: 0 } },
      { id: 'out', kind: 'output', x: 286, y: 40 },
    ],
    edges: [
      { id: 'e0', from: 'src0', to: 'pass', toPort: 'in0' },
      { id: 'e1', from: 'src1', to: 'pass', toPort: 'in1' },
      { id: 'e2', from: 'pass', to: 'out', toPort: 'in0' },
    ],
  };
}

/** Seed layer 0 = a VIDEO layer pointed at `source`; OUTPUT shows layer 0. */
async function seedVideoLayer(page: Page, source: 'inA' | 'inB'): Promise<void> {
  await page.evaluate(
    (source) => {
      const w = globalThis as unknown as PatchGlobal;
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tb'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.layers = [
          { kind: 'video', contentId: null, params: {}, videoSource: source },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
        ];
        n.data.combine = {
          nodes: [
            { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
            { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
            { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
            { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
            { id: 'pass', kind: 'fade', x: 120, y: 40, params: { amount: 0 } },
            { id: 'out', kind: 'output', x: 286, y: 40 },
          ],
          edges: [
            { id: 'e0', from: 'src0', to: 'pass', toPort: 'in0' },
            { id: 'e1', from: 'src1', to: 'pass', toPort: 'in1' },
            { id: 'e2', from: 'pass', to: 'out', toPort: 'in0' },
          ],
        };
      });
    },
    source,
  );
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

/** Freeze iTime to `time`, wait until the preview is LIT (the layer has rendered
 *  SOMETHING — feed or idle), then return the canvas average [r,g,b].
 *
 *  We deliberately DON'T require a pixel-exact stable signature: the upstream
 *  source (ACIDWARP) is animated, so each forced engine.step renders a fresh
 *  frame — an exact-signature settle would fight the animation and time out on a
 *  cold/slow CI renderer. Our assertions are coarse (idle ≈ brightness 17 vs
 *  ACIDWARP feed ≫ 40; idle-vs-feed delta), so a single lit, non-black frame is
 *  enough and far more robust on SwiftShader. `lit` counts ANY pixel above the
 *  near-black floor, so both the idle teal pattern AND a feed satisfy it. */
async function frozenAverage(page: Page, time: number): Promise<[number, number, number]> {
  await page.waitForFunction(
    ({ time }) => {
      const g = globalThis as unknown as PatchGlobal;
      g.__toyboxFreeze?.(time);
      const canvas = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
      if (!canvas) return false;
      const c2d = canvas.getContext('2d');
      if (!c2d) return false;
      const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
      let lit = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 6 || data[i + 1]! > 6 || data[i + 2]! > 6) lit++;
      }
      // At least 2% lit = SOMETHING rendered (a full-canvas video layer fills
      // ~100%; an OBJ sphere on a transparent FBO lights only its silhouette,
      // still well above 2%). A low floor keeps this robust for BOTH the
      // fullscreen-video and the OBJ-on-black cases.
      return lit > canvas.width * canvas.height * 0.02;
    },
    { time },
    { timeout: 30_000 },
  );
  // Average over a few forced frames to smooth out the animated source's
  // frame-to-frame jitter (coarse assertions don't need exact stability, but a
  // 3-frame mean keeps the idle-vs-feed delta comfortably above threshold).
  const samples: Array<[number, number, number]> = [];
  for (let s = 0; s < 3; s++) {
    const avg = await page.evaluate(({ time }) => {
      const g = globalThis as unknown as PatchGlobal;
      g.__toyboxFreeze?.(time);
      const canvas = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement;
      const c2d = canvas.getContext('2d')!;
      const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
      let r = 0, gg = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i]!; gg += data[i + 1]!; b += data[i + 2]!; n++;
      }
      return [r / n, gg / n, b / n] as [number, number, number];
    }, { time });
    samples.push(avg);
  }
  const mean: [number, number, number] = [
    samples.reduce((a, s) => a + s[0], 0) / samples.length,
    samples.reduce((a, s) => a + s[1], 0) / samples.length,
    samples.reduce((a, s) => a + s[2], 0) / samples.length,
  ];
  return mean;
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function brightness(a: [number, number, number]): number {
  return (a[0] + a[1] + a[2]) / 3;
}

/** Resume the engine clock (clear the freeze) so a new layer config re-renders
 *  a few live frames before the next freeze pins it. */
async function resume(page: Page): Promise<void> {
  await page.evaluate(() => {
    (globalThis as unknown as PatchGlobal).__toyboxFreeze?.();
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

/** Spawn TOYBOX + an ACIDWARP video source patched into `port`. */
async function spawnWithFeed(page: Page, port: 'inA' | 'inB'): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const nodes: SpawnNode[] = [
    { id: 'tb', type: 'toybox', position: { x: 360, y: 40 }, domain: 'video' },
    { id: 'acid', type: 'acidwarp', position: { x: 60, y: 40 }, domain: 'video' },
  ];
  const edges: SpawnEdge[] = [
    {
      id: 'e-feed',
      from: { nodeId: 'acid', portId: 'out' },
      to: { nodeId: 'tb', portId: port },
      sourceType: 'video',
      targetType: 'video',
    },
  ];
  await spawnPatch(page, nodes, edges);
  const card = page.locator('.svelte-flow__node-toybox').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await pinViewport(page);
}

test.describe('TOYBOX video inputs (VID A / VID B) — patched-feed layer source', () => {
  // Multi-capture WebGL tests on CI's SwiftShader renderer; budget per the
  // ci-swiftshader-video-e2e-timeouts discipline (≥90s, scaled for 3 captures).
  test.beforeEach(() => {
    test.setTimeout(120_000);
  });

  test('a layer sourced from In A shows the patched feed (non-black, not idle)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await spawnWithFeed(page, 'inA');
    await seedVideoLayer(page, 'inA');

    // The patched feed (ACIDWARP plasma) reached the layer FBO + the output.
    const feedAvg = await frozenAverage(page, 1.0);
    // ACIDWARP plasma is bright + colourful — well above the dark-teal idle
    // pattern (~(10,18,24) → brightness ~17). A non-black, brighter-than-idle
    // average proves the feed (not the idle fallback) is on screen.
    expect(brightness(feedAvg)).toBeGreaterThan(40);

    // Point the SAME layer at In B (NO feed there) → the layer falls back to the
    // idle pattern, which must look DIFFERENT from the patched In-A feed.
    await resume(page);
    await page.evaluate(() => {
      const w = globalThis as unknown as PatchGlobal;
      w.__ydoc.transact(() => {
        const l = w.__patch.nodes['tb']?.data?.layers?.[0];
        if (l) l.videoSource = 'inB';
      });
    });
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    const idleAvg = await frozenAverage(page, 1.0);
    // The output CHANGES WITH THE SOURCE: feed (In A) vs idle (In B, no feed).
    expect(dist(feedAvg, idleAvg)).toBeGreaterThan(8);

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });

  test('a layer sourced from In B shows the feed patched into In B', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await spawnWithFeed(page, 'inB');
    await seedVideoLayer(page, 'inB');

    const feedAvg = await frozenAverage(page, 1.0);
    expect(brightness(feedAvg)).toBeGreaterThan(40);

    // The persisted source is In B (the Yjs write landed at the right field).
    const persisted = await page.evaluate(() => {
      const w = globalThis as unknown as PatchGlobal;
      return w.__patch.nodes['tb']?.data?.layers?.[0]?.videoSource;
    });
    expect(persisted).toBe('inB');

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });

  test('the in-card SOURCE select drives videoSource + the patched feed reaches the output', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await spawnWithFeed(page, 'inA');
    // Seed a VIDEO layer (default source — treated as 'file' → idle, no file).
    await page.evaluate(() => {
      const w = globalThis as unknown as PatchGlobal;
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tb'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.layers = [
          { kind: 'video', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
        ];
        n.data.combine = (
          () => ({
            nodes: [
              { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
              { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
              { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
              { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
              { id: 'pass', kind: 'fade', x: 120, y: 40, params: { amount: 0 } },
              { id: 'out', kind: 'output', x: 286, y: 40 },
            ],
            edges: [
              { id: 'e0', from: 'src0', to: 'pass', toPort: 'in0' },
              { id: 'e1', from: 'src1', to: 'pass', toPort: 'in1' },
              { id: 'e2', from: 'pass', to: 'out', toPort: 'in0' },
            ],
          })
        )();
      });
    });
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

    // Pick In A via the in-card SOURCE dropdown (the real UI mutator).
    await page
      .locator('[data-testid="toybox-video-source-select"]')
      .selectOption('inA', { force: true, noWaitAfter: true });

    // (a) The dropdown write persisted to the live layer.
    const persisted = await page.evaluate(() => {
      const w = globalThis as unknown as PatchGlobal;
      return w.__patch.nodes['tb']?.data?.layers?.[0]?.videoSource;
    });
    expect(persisted).toBe('inA');

    // (b) The patched feed shows up on the output.
    const feedAvg = await frozenAverage(page, 1.0);
    expect(brightness(feedAvg)).toBeGreaterThan(40);

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });

  test('a patched feed projects onto an OBJ mesh (texmap surface composes the feed)', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await spawnWithFeed(page, 'inA');

    // Layer 1 = a VIDEO layer sourced from In A; layer 0 = an OBJ sphere whose
    // SURFACE source is layer 1 (UV-texmap the patched feed onto the mesh).
    // OUTPUT shows layer 0 (the textured sphere).
    await page.evaluate(() => {
      const w = globalThis as unknown as PatchGlobal;
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tb'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.layers = [
          {
            kind: 'obj', contentId: null, params: {},
            material: {
              modelId: 'sphere', rotX: 0.3, rotY: 0.6, rotZ: 0, scale: 1,
              spin: 0, matcap: 0, tintR: 1, tintG: 1, tintB: 1,
              surfaceSource: -1, surfaceMix: 1,
            },
          },
          { kind: 'video', contentId: null, params: {}, videoSource: 'inA' },
          { kind: 'off', contentId: null, params: {} },
          { kind: 'off', contentId: null, params: {} },
        ];
        n.data.combine = (
          () => ({
            nodes: [
              { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
              { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
              { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
              { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
              { id: 'pass', kind: 'fade', x: 120, y: 40, params: { amount: 0 } },
              { id: 'out', kind: 'output', x: 286, y: 40 },
            ],
            edges: [
              { id: 'e0', from: 'src0', to: 'pass', toPort: 'in0' },
              { id: 'e1', from: 'src1', to: 'pass', toPort: 'in1' },
              { id: 'e2', from: 'pass', to: 'out', toPort: 'in0' },
            ],
          })
        )();
      });
    });
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

    // Baseline: matcap-only sphere (surfaceSource = -1).
    const matcapAvg = await frozenAverage(page, 1.0);

    // Texture the sphere with the patched feed (surfaceSource = layer 1).
    await resume(page);
    await page.evaluate(() => {
      const w = globalThis as unknown as PatchGlobal;
      w.__ydoc.transact(() => {
        const mat = w.__patch.nodes['tb']?.data?.layers?.[0]?.material;
        if (mat) mat.surfaceSource = 1;
      });
    });
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

    const texturedAvg = await frozenAverage(page, 1.0);
    // The textured sphere shows the patched feed, not the flat matcap — proving
    // a patched feed composes through the same UV-texmap surface path #603 built.
    expect(dist(matcapAvg, texturedAvg)).toBeGreaterThan(4);

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });
});
