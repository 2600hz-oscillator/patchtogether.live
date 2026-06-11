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
//
// CONSOLIDATED 4→2 (webgl-suite-optimization §2): the In-A and In-B feed tests
// were near-dups (spawn a feed into a port, point a video layer at that port,
// assert the feed reaches the output) — they are now ONE parametrized test over
// both ports that keeps EVERY unique claim per port (feed reaches output, the
// videoSource Yjs write persists at the right field, AND the feed≠idle delta when
// the layer is pointed at the OTHER, feed-less port). The former 4th test — a
// patched feed projected onto an OBJ mesh — was DROPPED: that surface-texmap
// render path is owned by toybox-texture-source (now folded into
// toybox-video-projection) + the projective render proof in
// toybox-video-projection.spec.ts; what is UNIQUE here (a patched live FEED as
// the layer source) is fully exercised by the kept feed + SOURCE-select tests.
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

  // Parametrized over BOTH input ports (consolidation §2). Per port this keeps
  // every unique claim the two former per-port tests made: (a) the patched feed
  // reaches the layer FBO + output (non-black, brighter than idle), (b) the
  // videoSource Yjs write persisted at the right field, and (c) the output
  // CHANGES WITH THE SOURCE — pointing the SAME layer at the OTHER (feed-less)
  // port falls back to the idle pattern, distinct from the patched feed.
  for (const { feed, other } of [
    { feed: 'inA', other: 'inB' },
    { feed: 'inB', other: 'inA' },
  ] as const) {
    test(`a layer sourced from In ${feed === 'inA' ? 'A' : 'B'} shows the patched feed (non-black, not idle; changes with the source)`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

      await spawnWithFeed(page, feed);
      await seedVideoLayer(page, feed);

      // (a) The patched feed (ACIDWARP plasma) reached the layer FBO + the output.
      // ACIDWARP plasma is bright + colourful — well above the dark-teal idle
      // pattern (~(10,18,24) → brightness ~17). A non-black, brighter-than-idle
      // average proves the feed (not the idle fallback) is on screen.
      const feedAvg = await frozenAverage(page, 1.0);
      expect(brightness(feedAvg), `In ${feed}: patched feed is brighter than idle`).toBeGreaterThan(40);

      // (b) The persisted source is the patched port (the Yjs write landed at the
      // right field).
      const persisted = await page.evaluate(() => {
        const w = globalThis as unknown as PatchGlobal;
        return w.__patch.nodes['tb']?.data?.layers?.[0]?.videoSource;
      });
      expect(persisted, `In ${feed}: videoSource persisted`).toBe(feed);

      // (c) Point the SAME layer at the OTHER port (NO feed there) → the layer
      // falls back to the idle pattern, which must look DIFFERENT from the feed.
      await resume(page);
      await page.evaluate((other) => {
        const w = globalThis as unknown as PatchGlobal;
        w.__ydoc.transact(() => {
          const l = w.__patch.nodes['tb']?.data?.layers?.[0];
          if (l) l.videoSource = other;
        });
      }, other);
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      const idleAvg = await frozenAverage(page, 1.0);
      expect(dist(feedAvg, idleAvg), `In ${feed}: output changes with the source (feed vs idle ${other})`).toBeGreaterThan(8);

      expect(
        errors.filter((e) => !e.includes('AudioContext')),
        'no console / page errors',
      ).toEqual([]);
    });
  }

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

  // NOTE (consolidation §2): the former "a patched feed projects onto an OBJ mesh
  // (texmap surface composes the feed)" test was DROPPED. The UV-texmap / surface
  // render path (mapping a layer's output onto a mesh) is owned by the surface-
  // select + projective proofs in toybox-video-projection.spec.ts (which absorbed
  // toybox-texture-source). What is UNIQUE to THIS spec — a live PATCHED feed
  // (ACIDWARP.out → TOYBOX.inA/B) reaching the layer FBO + output — is fully
  // exercised by the parametrized feed tests + the SOURCE-select test above; the
  // dropped test re-tested the same texmap path with a feed instead of a shader,
  // which adds no new coverage (it boots TWO heavy modules per case, the priciest
  // in the cluster).
});
