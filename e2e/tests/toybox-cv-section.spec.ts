// e2e/tests/toybox-cv-section.spec.ts
//
// TOYBOX 3-column card + the 6-input CV/MOD section UI. Proves:
//   - the 3-column layout renders (LEFT preview/editor | CENTER combine | RIGHT
//     CV section),
//   - all 6 always-on scope canvases (toybox-cv-scope-cvN) render,
//   - routing through the in-card target/param selects persists to cvRoutes,
//   - an UNPATCHED routed port shows an idle scope (always-on) + the badge
//     reads '—' (idle); a patched cv source flips the badge to CV.
//
// (The param-movement math + audio detection are covered in
// toybox-cv-routing.spec.ts; the attenuverter math in toybox-cv-math.test.ts.)

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

type PatchGlobal = {
  __patch: {
    nodes: Record<string, { data?: { layers?: unknown[]; cvRoutes?: Record<string, unknown> } }>;
    edges: Record<string, unknown>;
  };
  __ydoc: { transact: (fn: () => void) => void };
};

async function pinViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const vp = document.querySelector('.svelte-flow__viewport') as HTMLElement | null;
    if (!vp) return;
    vp.style.transition = 'none';
    vp.style.transform = 'translate(8px, -24px) scale(1)';
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

async function seedShaderLayer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as PatchGlobal;
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['tb'];
      if (!n) return;
      if (!n.data) n.data = {};
      n.data.layers = [
        { kind: 'gen', contentId: 'noise-fbm', params: { speed: 0.4 } },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
        { kind: 'off', contentId: null, params: {} },
      ];
    });
  });
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

test.describe('TOYBOX 3-column card + CV/MOD section', () => {
  test.setTimeout(90_000);

  test('renders 3 columns, all 6 inline scopes, and routes a port via the selects', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
      [],
    );
    await page.locator('.svelte-flow__node-toybox').first().waitFor({ state: 'visible', timeout: 10_000 });
    await pinViewport(page);
    await seedShaderLayer(page);

    // 3-column body.
    await expect(page.locator('[data-testid="toybox-cols"]')).toBeVisible();
    await expect(page.locator('[data-testid="toybox-col-left"]')).toBeVisible();
    await expect(page.locator('[data-testid="toybox-col-center"]')).toBeVisible();
    await expect(page.locator('[data-testid="toybox-col-right"]')).toBeVisible();

    // The CV section lives in the RIGHT column + defaults OPEN.
    await page.locator('[data-testid="toybox-cv-rows"]').waitFor({ state: 'visible', timeout: 5_000 });

    // All 6 always-on inline scope canvases render.
    for (let i = 1; i <= 6; i++) {
      await expect(page.locator(`[data-testid="toybox-cv-scope-cv${i}"]`)).toBeVisible();
    }
    // Exactly 6 rows.
    await expect(page.locator('[data-testid^="toybox-cv-row-cv"]')).toHaveCount(6);

    // An UNPATCHED port's badge reads idle ('—').
    await expect(page.locator('[data-testid="toybox-cv-badge-cv1"]')).toHaveAttribute('data-kind', 'idle');

    // Route cv1 → the shader 'speed' param via the in-card selects.
    await page
      .locator('[data-testid="toybox-cv-target-cv1"]')
      .selectOption('layer:0', { noWaitAfter: true });
    await page
      .locator('[data-testid="toybox-cv-param-cv1"]')
      .selectOption('speed', { noWaitAfter: true });

    const route = await page.evaluate(() => {
      const w = globalThis as unknown as PatchGlobal;
      return w.__patch.nodes['tb']?.data?.cvRoutes?.['cv1'] ?? null;
    });
    expect(route).toMatchObject({ target: 'layer', layer: 0, param: 'speed' });

    // A patched cv source flips the badge to CV (auto-detect off the edge).
    await page.evaluate(() => {
      const w = globalThis as unknown as PatchGlobal;
      w.__ydoc.transact(() => {
        w.__patch.edges['ein'] = {
          id: 'ein',
          source: { nodeId: 'lfo', portId: 'out' },
          target: { nodeId: 'tb', portId: 'cv1' },
          sourceType: 'cv',
          targetType: 'modsignal',
        };
      });
    });
    await expect(page.locator('[data-testid="toybox-cv-badge-cv1"]')).toHaveAttribute('data-kind', 'cv', {
      timeout: 5_000,
    });

    expect(
      errors.filter((e) => !e.includes('AudioContext')),
      'no console / page errors',
    ).toEqual([]);
  });
});
