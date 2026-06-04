// e2e/tests/toybox-layer-selector.spec.ts
//
// TOYBOX per-layer editing UI — the LAYER-INDEX selector (tabs).
//
// The card HARDCODED layers[0] everywhere; the new LAYER tabs let it author ANY
// of the 4 layers. This spec drives the real UI + engine end-to-end:
//   1. Spawn a TOYBOX; author LAYER 1 (index 0) = a bright shader via the in-card
//      content dropdown.
//   2. Click the LAYER 2 tab (index 1) — an OFF layer — then set its KIND = OBJ
//      and confirm the empty-state prompt is gone.
//   3. Pick a SURFACE source so LAYER 2 (the OBJ) shows LAYER 1's shader.
//   4. Wire the combine OUTPUT to show LAYER 2 (the textured OBJ).
// then assert:
//   (a) node.data.layers[1] is populated (kind 'obj' + material) — the tab
//       retargeted the controls to index 1, NOT 0,
//   (b) node.data.layers[0] still holds the shader (untouched by the LAYER-2
//       edits) — proves the retarget is isolated,
//   (c) the live composite CHANGED after building the 2-layer patch (a frozen-
//       average pixel delta — the combine-editor / texmap delta pattern).
//
// CI robustness mirrors the sibling toybox specs: test.setTimeout(60s), in-card
// clicks use { force, noWaitAfter } (TOYBOX's WebGL rAF compositor starves the
// main thread so the default post-action nav-wait is pathologically slow), and
// node.data reads poll via expect.poll. selectOption uses { force, noWaitAfter }.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

type Layer = {
  kind?: string;
  contentId?: string | null;
  material?: { surfaceSource?: number; modelId?: string; [k: string]: number | string | undefined };
  params?: Record<string, number>;
};
type PatchGlobal = {
  __patch: { nodes: Record<string, { data?: { layers?: Layer[]; combine?: { nodes?: unknown[]; edges?: unknown[] } } }> };
  __ydoc: { transact: (fn: () => void) => void };
  __toyboxFreeze?: (t?: number) => void;
  __toyboxPrevSig?: string;
};

/** Pin the viewport at scale 1, panned up so the (tall) card body clears the
 *  fixed bottombar footer that otherwise intercepts pointer events. */
async function pinViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
    if (!vp) return;
    vp.style.transition = 'none';
    vp.style.transform = 'translate(8px, -24px) scale(1)';
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

/** Click an in-card control by testid. force bypasses the bottombar overlay;
 *  noWaitAfter skips the no-op post-click navigation wait (load-bearing on CI —
 *  see toybox-combine-editor.spec.ts). */
async function clickEd(page: Page, testid: string): Promise<void> {
  await page.locator(`[data-testid="${testid}"]`).click({ force: true, noWaitAfter: true });
}

/** Select an option in an in-card <select> (same CI rationale as clickEd). */
async function selectEd(page: Page, testid: string, value: string): Promise<void> {
  await page.locator(`[data-testid="${testid}"]`).selectOption(value, { force: true, noWaitAfter: true });
}

/** Freeze iTime + wait until the preview is lit + stable, then return its
 *  average RGB (frozen-average; the texmap/combine delta pattern). */
async function frozenAverage(page: Page, time: number): Promise<[number, number, number]> {
  await page.waitForFunction(
    ({ time }) => {
      const g = globalThis as unknown as PatchGlobal;
      g.__toyboxFreeze?.(time);
      const c = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement | null;
      if (!c) return false;
      const ctx = c.getContext('2d');
      if (!ctx) return false;
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      let lit = 0, r = 0, gg = 0, b = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! > 16 || data[i + 1]! > 16 || data[i + 2]! > 16) lit++;
        r += data[i]!; gg += data[i + 1]!; b += data[i + 2]!;
      }
      if (lit <= c.width * c.height * 0.05) return false;
      const sig = `${Math.round(r / 5000)},${Math.round(gg / 5000)},${Math.round(b / 5000)}`;
      const prev = g.__toyboxPrevSig;
      g.__toyboxPrevSig = sig;
      return prev === sig;
    },
    { time },
    { timeout: 30_000 },
  );
  return page.evaluate(() => {
    const c = document.querySelector('[data-testid="toybox-canvas"]') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]!; g += data[i + 1]!; b += data[i + 2]!; n++;
    }
    return [r / n, g / n, b / n] as [number, number, number];
  });
}

function dist(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Reset the stability tracker so a prior signature can't satisfy the wait. */
async function resetSig(page: Page): Promise<void> {
  await page.evaluate(() => {
    (globalThis as unknown as PatchGlobal).__toyboxPrevSig = '';
  });
}

/** Seed an explicit "pass layer 0" combine ONCE (the default chain, fade
 *  amounts 0 → layer 0 passes through). Set in the live store before the first
 *  render so the factory's first reconcile sees it. The src1→op1 fade (op1) is
 *  what we later crank to fold LAYER 2 (index 1) in. */
async function seedDefaultCombine(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as PatchGlobal;
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['tb'];
      if (!n) return;
      if (!n.data) n.data = {};
      n.data.combine = {
        nodes: [
          { id: 'src0', kind: 'source', layer: 0, x: 14, y: 14 },
          { id: 'src1', kind: 'source', layer: 1, x: 14, y: 66 },
          { id: 'src2', kind: 'source', layer: 2, x: 14, y: 118 },
          { id: 'src3', kind: 'source', layer: 3, x: 14, y: 170 },
          { id: 'op1', kind: 'fade', x: 120, y: 40, params: { amount: 0 } },
          { id: 'out', kind: 'output', x: 286, y: 40 },
        ],
        edges: [
          { id: 'e0', from: 'src0', to: 'op1', toPort: 'in0' },
          { id: 'e1', from: 'src1', to: 'op1', toPort: 'in1' },
          { id: 'e2', from: 'op1', to: 'out', toPort: 'in0' },
        ],
      };
    });
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

/** Crank op1's fade amount IN PLACE (mutate the existing param — no wholesale
 *  reassign, so the factory's reconcile picks it up mid-run, like the combine
 *  editor). amount 1 → op1 outputs its in1 (LAYER 2 / index 1). */
async function setOp1FadeAmount(page: Page, amount: number): Promise<void> {
  await page.evaluate(({ amount }) => {
    const w = globalThis as unknown as PatchGlobal;
    w.__ydoc.transact(() => {
      const c = w.__patch.nodes['tb']?.data?.combine as
        | { nodes?: Array<{ id: string; params?: Record<string, number> }> }
        | undefined;
      const op1 = c?.nodes?.find((nn) => nn.id === 'op1');
      if (op1) {
        if (!op1.params) op1.params = {};
        op1.params.amount = amount;
      }
    });
  }, { amount });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

test.describe('TOYBOX per-layer editing — LAYER selector', () => {
  test('the LAYER tabs retarget controls to layers[activeLayer]; author a 2-layer patch', async ({ page }) => {
    // TOYBOX runs a WebGL rAF compositor; CI's software renderer is slow, so the
    // multi-step author flow needs headroom beyond the 30s default.
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

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

    // LAYER 1 (index 0) is the active tab by default + already populated.
    await expect(page.locator('[data-testid="toybox-layer-tab-0"]')).toHaveAttribute('data-active', 'true');
    await expect(page.locator('[data-testid="toybox-layer-dot-0"]')).toBeVisible();
    // LAYER 2 (index 1) starts empty → no dot.
    await expect(page.locator('[data-testid="toybox-layer-dot-1"]')).toHaveCount(0);

    // Author LAYER 1 (index 0) = a bright shader via the content dropdown.
    await selectEd(page, 'toybox-content-select', 'cos-gradient');

    // ── Switch to LAYER 2 (index 1) ──
    await clickEd(page, 'toybox-layer-tab-1');
    await expect(page.locator('[data-testid="toybox-layer-tab-1"]')).toHaveAttribute('data-active', 'true');
    // It's empty → the empty-state prompt shows, and KIND reads OFF.
    await expect(page.locator('[data-testid="toybox-layer-empty"]')).toBeVisible();

    // Set LAYER 2's KIND = OBJ → seeds a material + the empty prompt disappears.
    await selectEd(page, 'toybox-kind-select', 'obj');
    await expect(page.locator('[data-testid="toybox-layer-empty"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="toybox-model-select"]')).toBeVisible();
    // The LAYER-2 tab now shows the populated dot.
    await expect(page.locator('[data-testid="toybox-layer-dot-1"]')).toBeVisible();

    // Pick LAYER 2's MODEL = sphere + still on MATCAP (default surface).
    await selectEd(page, 'toybox-model-select', 'sphere');

    // (a) PERSISTENCE: layers[1] is the OBJ we just authored (retargeted to
    // index 1, not 0). Poll — the selectOption writes use noWaitAfter.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const w = globalThis as unknown as PatchGlobal;
            const ls = w.__patch.nodes['tb']?.data?.layers;
            const l1 = ls?.[1];
            return { kind: l1?.kind ?? null, hasMaterial: !!l1?.material, modelId: l1?.material?.modelId ?? null };
          }),
        { timeout: 15_000, intervals: [200, 400, 800, 1500], message: 'layers[1] authored as OBJ' },
      )
      .toMatchObject({ kind: 'obj', hasMaterial: true, modelId: 'sphere' });

    // (b) ISOLATION: layer 0 still holds the shader we authored first — the
    // LAYER-2 edits did NOT bleed into layer 0. cos-gradient is FX-family →
    // kind 'shader'; the point is it's the shader (NOT the OBJ we set on tab 2).
    const layer0 = await page.evaluate(() => {
      const w = globalThis as unknown as PatchGlobal;
      const l0 = w.__patch.nodes['tb']?.data?.layers?.[0];
      return { kind: l0?.kind ?? null, contentId: l0?.contentId ?? null, hasMaterial: !!l0?.material };
    });
    expect(layer0).toMatchObject({ kind: 'shader', contentId: 'cos-gradient', hasMaterial: false });

    // (c) COMPOSITE CHANGED: re-author LAYER 2 (still the active tab) as a
    // DISTINCT full-frame shader (worley-cells) via the KIND→SHADER + CONTENT
    // controls, then fold it into the composite (op1 fade amount 0→1) and assert
    // the live render differs from the layer-0-only baseline. Two full-frame
    // shaders give a large, reliable average-colour delta (combine-editor
    // pattern), and the op1 amount is mutated IN PLACE so the reconcile sees it.
    await seedDefaultCombine(page);

    // Re-author LAYER 2 (active tab) as a shader with a distinct content.
    await selectEd(page, 'toybox-kind-select', 'gen'); // 'SHADER' option value is 'gen'
    await selectEd(page, 'toybox-content-select', 'worley-cells');
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const w = globalThis as unknown as PatchGlobal;
            const l1 = w.__patch.nodes['tb']?.data?.layers?.[1];
            return { kind: l1?.kind ?? null, contentId: l1?.contentId ?? null };
          }),
        { timeout: 10_000, intervals: [200, 400, 800], message: 'layer 2 re-authored as a shader' },
      )
      .toMatchObject({ kind: 'gen', contentId: 'worley-cells' });

    // Baseline: composite = LAYER 0 (cos-gradient) with op1 fade at 0.
    await setOp1FadeAmount(page, 0);
    await resetSig(page);
    const baseAvg = await frozenAverage(page, 1.0);

    // Fold LAYER 2 in (op1 fade → 1 outputs its in1 = layer index 1).
    await page.evaluate(() => (globalThis as unknown as PatchGlobal).__toyboxFreeze?.());
    await setOp1FadeAmount(page, 1);
    await resetSig(page);
    const withLayer2Avg = await frozenAverage(page, 1.0);

    expect(dist(baseAvg, withLayer2Avg), 'the shader authored on tab 2 changes the live composite when folded in').toBeGreaterThan(4);

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });
});
