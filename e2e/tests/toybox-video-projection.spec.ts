// e2e/tests/toybox-video-projection.spec.ts
//
// TOYBOX video/image INPUT layer kinds (#39) + PROJECTIVE surface mode (#45) —
// end-to-end through the REAL UI + WebGL engine. Three proofs:
//
//   1. IMAGE / VIDEO layer kinds render. Setting a layer's kind to 'image' or
//      'video' (no file) makes the layer paint its input idle pattern (non-black),
//      and the card surfaces the matching file picker. (We assert the RENDER +
//      the picker UI, not a real file upload — headless file decode is flaky; the
//      decode→upload bridge is unit-covered + the idle render proves the layer-
//      kind dispatch reached the GL pass.)
//
//   2. PROJECTIVE surface mode renders + DIFFERS from UV. An OBJ sphere textured
//      from a bright shader, captured in UV mode vs projective mode (frozen-
//      average pixel delta). Proves the projective render path actually reached
//      the GPU + produced a different image (the projector geometry, not the
//      mesh UVs). Mirrors toybox-texture-source.spec.ts's delta pattern.
//
// CI robustness mirrors the sibling toybox specs: test.setTimeout(60s), in-card
// selects use { force, noWaitAfter } (TOYBOX's WebGL rAF compositor starves the
// main thread so the default post-action nav-wait is pathologically slow), and
// node.data reads poll via the frozen-average stability loop.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

type Layer = {
  kind?: string;
  contentId?: string | null;
  material?: { surfaceSource?: number; surfaceMode?: string; modelId?: string; [k: string]: number | string | undefined };
  params?: Record<string, number>;
};
type PatchGlobal = {
  __patch: { nodes: Record<string, { data?: { layers?: Layer[]; combine?: { nodes?: unknown[]; edges?: unknown[] } } }> };
  __ydoc: { transact: (fn: () => void) => void };
  __toyboxFreeze?: (t?: number) => void;
  __toyboxPrevSig?: string;
};

/** Pin the viewport at scale 1 so the canvas DOM box is stable. */
async function pinViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
    if (!vp) return;
    vp.style.transition = 'none';
    vp.style.transform = 'translate(8px, -24px) scale(1)';
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

async function selectEd(page: Page, testid: string, value: string): Promise<void> {
  await page.locator(`[data-testid="${testid}"]`).selectOption(value, { force: true, noWaitAfter: true });
}

/** Freeze iTime, wait until the frozen preview is non-black + stable, then
 *  return the canvas average RGB (the texmap/combine delta pattern). */
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
      let lit = 0, r = 0, gg = 0, b = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) lit++;
        r += data[i]!; gg += data[i + 1]!; b += data[i + 2]!;
      }
      if (lit <= canvas.width * canvas.height * 0.02) return false;
      const sig = `${Math.round(r / 5000)},${Math.round(gg / 5000)},${Math.round(b / 5000)}`;
      const prev = g.__toyboxPrevSig;
      g.__toyboxPrevSig = sig;
      return prev === sig;
    },
    { time },
    { timeout: 15_000 },
  );
  return page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement;
    const c2d = canvas.getContext('2d')!;
    const { data } = c2d.getImageData(0, 0, canvas.width, canvas.height);
    let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]!; gg += data[i + 1]!; b += data[i + 2]!; n++;
    }
    return [r / n, gg / n, b / n] as [number, number, number];
  });
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

async function resetSig(page: Page): Promise<void> {
  await page.evaluate(() => {
    (globalThis as unknown as { __toyboxPrevSig?: string }).__toyboxPrevSig = '';
  });
}

async function spawnToybox(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(
    page,
    [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
    [],
  );
  const card = page.locator('.svelte-flow__node-toybox').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await pinViewport(page);
}

test.describe('TOYBOX input layer kinds (#39)', () => {
  test('an IMAGE layer renders its idle pattern + shows the image file picker', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await spawnToybox(page);

    // Set layer 0's kind to IMAGE (no file) via __ydoc, plus a trivial combine
    // that shows layer 0.
    await page.evaluate(() => {
      const w = globalThis as unknown as PatchGlobal;
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['tb'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.layers = [
          { kind: 'image', contentId: null, params: {} },
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
    });
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

    // The kind dropdown reflects IMAGE → its file picker shows.
    await expect(page.locator('[data-testid="toybox-image-picker"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="toybox-image-input"]')).toHaveCount(1);

    // The image layer renders its idle pattern (non-black) — the input layer-kind
    // dispatch reached the GL pass.
    await resetSig(page);
    const avg = await frozenAverage(page, 1.0);
    expect(avg[0] + avg[1] + avg[2]).toBeGreaterThan(8);

    expect(errors.filter((e) => !e.includes('AudioContext')), 'no console / page errors').toEqual([]);
  });

  test('a VIDEO layer renders its idle pattern + shows the video file picker', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await spawnToybox(page);

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
    });
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

    await expect(page.locator('[data-testid="toybox-video-picker"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="toybox-video-input"]')).toHaveCount(1);

    await resetSig(page);
    const avg = await frozenAverage(page, 1.0);
    expect(avg[0] + avg[1] + avg[2]).toBeGreaterThan(8);

    expect(errors.filter((e) => !e.includes('AudioContext')), 'no console / page errors').toEqual([]);
  });
});

test.describe('TOYBOX projective surface mode (#45)', () => {
  // QUARANTINE(e2e-flake-purge): failed 2/5 passes under retries=0 — heavy
  // projective WebGL near the 60s budget. See .myrobots/e2e-quarantine.md.
  test.fixme('projective mapping renders non-black AND differs from UV mode', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await spawnToybox(page);

    // Layer 0 = sphere textured FROM layer 1 (a bright cos-gradient shader).
    // surfaceMode 'uv' to start (matches the existing texmap default). spin 0 for
    // determinism. OUTPUT shows layer 0 (the textured sphere).
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
              surfaceSource: 1, surfaceMix: 1, surfaceMode: 'uv',
            },
          },
          { kind: 'gen', contentId: 'cos-gradient', params: { speed: 0.5, phase: 0.3, scale: 4 } },
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
    });
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

    // The MAP toggle is visible (a surface source IS set) + reads 'uv'.
    await expect(page.locator('[data-testid="toybox-surfmode-select"]')).toBeVisible({ timeout: 10_000 });

    // UV-mode baseline.
    await resetSig(page);
    const uvAvg = await frozenAverage(page, 1.0);
    expect(uvAvg[0] + uvAvg[1] + uvAvg[2]).toBeGreaterThan(8);

    // Switch to PROJECTIVE via the in-card dropdown (resume the clock first so
    // the new frame re-renders).
    await page.evaluate(() => {
      (globalThis as unknown as PatchGlobal).__toyboxFreeze?.();
    });
    await selectEd(page, 'toybox-surfmode-select', 'projective');

    // (a) the mode persisted to the live material at the right field.
    await expect.poll(async () =>
      page.evaluate(() => (globalThis as unknown as PatchGlobal).__patch.nodes['tb']?.data?.layers?.[0]?.material?.surfaceMode),
    ).toBe('projective');

    // (b) projective renders non-black AND differs from UV (the projection
    // sampled the source by the projector geometry, not the mesh UVs).
    await resetSig(page);
    const projAvg = await frozenAverage(page, 1.0);
    expect(projAvg[0] + projAvg[1] + projAvg[2]).toBeGreaterThan(8);
    expect(dist(uvAvg, projAvg)).toBeGreaterThan(3);

    expect(errors.filter((e) => !e.includes('AudioContext')), 'no console / page errors').toEqual([]);
  });

  // QUARANTINE(e2e-flake-purge): failed 3/5 passes under retries=0 — heavy
  // projective WebGL near the 60s budget. See .myrobots/e2e-quarantine.md.
  test.fixme('the PROJECTION MAP preset loads + renders non-black', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await spawnToybox(page);

    // Load the bundled projection-mapping preset via the determinism hook.
    const applied = await page.evaluate(async () => {
      const g = globalThis as unknown as { __toyboxLoadPreset?: (id: string) => Promise<boolean> };
      return g.__toyboxLoadPreset ? g.__toyboxLoadPreset('projection-map') : false;
    });
    expect(applied).toBe(true);
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

    // The preset's layer 0 is an OBJ with projective surface mode.
    await expect.poll(async () =>
      page.evaluate(() => (globalThis as unknown as PatchGlobal).__patch.nodes['tb']?.data?.layers?.[0]?.material?.surfaceMode),
    ).toBe('projective');

    await resetSig(page);
    const avg = await frozenAverage(page, 1.0);
    expect(avg[0] + avg[1] + avg[2]).toBeGreaterThan(8);

    expect(errors.filter((e) => !e.includes('AudioContext')), 'no console / page errors').toEqual([]);
  });
});
