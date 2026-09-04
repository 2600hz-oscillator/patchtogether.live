// e2e/tests/toybox-cv-section.spec.ts
//
// TOYBOX console + the 6-input CV/MOD section UI. Proves:
//   - the faceplate console structure renders (screen zone | persistent layer
//     band | tab rail, cv-mod the default pane — the card's 3-COLUMN layout
//     died with the card; the cv section IS the default tab's content),
//   - all 6 always-on scope canvases (toybox-cv-scope-cvN) render,
//   - routing through the console's target/param selects persists to cvRoutes,
//   - an UNPATCHED routed port shows an idle scope (always-on) + the badge
//     reads '—' (idle); a patched cv source flips the badge to CV.
//
// (The param-movement math + audio detection are covered in
// toybox-cv-routing.spec.ts; the attenuverter math in toybox-cv-math.test.ts.)

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, openToyboxDock } from './_helpers';

type PatchGlobal = {
  __patch: {
    nodes: Record<string, { data?: { layers?: unknown[]; cvRoutes?: Record<string, unknown> } }>;
    edges: Record<string, unknown>;
  };
  __ydoc: { transact: (fn: () => void) => void };
};

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

test.describe('TOYBOX console + CV/MOD section', () => {
  test.setTimeout(90_000);

  test('renders the console zones, all 6 inline scopes, and routes a port via the selects', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');
    await spawnPatch(
      page,
      [{ id: 'tb', type: 'toybox', position: { x: 80, y: 40 }, domain: 'video' }],
      [],
    );
    await openToyboxDock(page);
    await seedShaderLayer(page);

    // Console structure: screen + persistent layer band + tab rail, with the
    // cv-mod pane as the DEFAULT tab (the card's toybox-cols 3-column body
    // died with the card; see the manifest row).
    await expect(page.locator('[data-testid="toybox-face-console"]')).toBeVisible();
    await expect(page.locator('[data-testid="toybox-face-layer-band"]')).toBeVisible();
    await expect(page.locator('[data-testid="toybox-face-pane"]')).toHaveAttribute('data-tab', 'cv');

    // The CV section is the default pane's content.
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
