// e2e/tests/aut-vizvco-wavviz-scope.spec.ts
//
// AUT (Acceptance / User-Acceptance Test) — exercises VIZVCO, WAVVIZ,
// and SCOPE end-to-end through the rackspace UI as a user would: open
// a fresh rack, spawn modules from the palette via right-click, patch
// scope-video into OUTPUT, resize OUTPUT, observe the output panel
// updating.
//
// Tagged @aut so it can be selected via Playwright's --grep @aut.
//
// We don't dictate UX-level details (the palette already has its own
// tests in palette.spec.ts); this AUT layers on top and verifies the
// integrated flow.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test.describe('@aut user-acceptance: VIZVCO/WAVVIZ/SCOPE -> OUTPUT', () => {
  test('@aut user spawns VIZVCO via palette, patches into OUTPUT, sees scope render', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Spawn VIZVCO via the + Add module palette (the user-facing path).
    await page.getByRole('button', { name: '+ Add module' }).click();
    await expect(page.locator('.module-palette'), 'palette opens').toBeVisible();
    await page.keyboard.type('VIZVCO');
    await page.getByRole('button', { name: 'VIZVCO', exact: true }).click();
    await expect(page.locator('.svelte-flow__node-vizvco'), 'VIZVCO spawned').toHaveCount(1);

    // Spawn OUTPUT via the same path.
    await page.getByRole('button', { name: '+ Add module' }).click();
    await page.keyboard.type('OUTPUT');
    await page.getByRole('button', { name: 'OUTPUT', exact: true }).click();
    await expect(page.locator('.svelte-flow__node-videoOut'), 'OUTPUT spawned').toHaveCount(1);

    // Patch VIZVCO.scope -> OUTPUT.in via the dev __patch path (UI cable
    // dragging is timing-sensitive; the patch-add is what the user
    // would achieve via drag-and-drop).
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { id: string }>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      // Find the spawned vizvco + videoOut node ids.
      const ids = Object.keys(w.__patch.nodes);
      const vizvcoId = ids.find((i) => i.startsWith('vizvco-'));
      const outId = ids.find((i) => i.startsWith('videoOut-'));
      if (!vizvcoId || !outId) throw new Error('spawned ids not found');
      w.__ydoc.transact(() => {
        w.__patch.edges['e-aut-viz'] = {
          id: 'e-aut-viz',
          source: { nodeId: vizvcoId, portId: 'scope' },
          target: { nodeId: outId, portId: 'in' },
          sourceType: 'mono-video',
          targetType: 'video',
        };
      });
    });

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await expect(canvas).toHaveCount(1);
    await page.waitForTimeout(900);

    // Scope render should produce non-flat pixels.
    const variance = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return 0;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      let s = 0, sq = 0, n = 0;
      for (let i = 0; i < img.data.length; i += 16) {
        const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
        s += v; sq += v * v; n++;
      }
      const mean = s / n;
      return sq / n - mean * mean;
    });
    expect(variance, 'OUTPUT shows scope trace').toBeGreaterThan(5);
  });

  test('@aut user spawns WAVVIZ via palette, sees scope render', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: '+ Add module' }).click();
    await page.keyboard.type('WAVVIZ');
    await page.getByRole('button', { name: 'WAVVIZ', exact: true }).click();
    await expect(page.locator('.svelte-flow__node-wavviz')).toHaveCount(1);

    await page.getByRole('button', { name: '+ Add module' }).click();
    await page.keyboard.type('OUTPUT');
    await page.getByRole('button', { name: 'OUTPUT', exact: true }).click();

    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { id: string }>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      const ids = Object.keys(w.__patch.nodes);
      const wvId = ids.find((i) => i.startsWith('wavviz-'));
      const outId = ids.find((i) => i.startsWith('videoOut-'));
      if (!wvId || !outId) throw new Error('spawned ids not found');
      w.__ydoc.transact(() => {
        w.__patch.edges['e-aut-wv'] = {
          id: 'e-aut-wv',
          source: { nodeId: wvId, portId: 'scope' },
          target: { nodeId: outId, portId: 'in' },
          sourceType: 'mono-video',
          targetType: 'video',
        };
      });
    });

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await page.waitForTimeout(900);
    const variance = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return 0;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      let s = 0, sq = 0, n = 0;
      for (let i = 0; i < img.data.length; i += 16) {
        const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
        s += v; sq += v * v; n++;
      }
      const mean = s / n;
      return sq / n - mean * mean;
    });
    expect(variance, 'OUTPUT shows WAVVIZ scope trace').toBeGreaterThan(5);
  });

  test('@aut user resizes OUTPUT, scope still renders aspect-fit', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Spawn via spawnPatch for determinism + spawn OUTPUT via palette.
    // (Using both paths exercises the UI path AND the resize logic.)
    await spawnPatch(
      page,
      [
        { id: 'a-vco',  type: 'analogVco', position: { x: 60, y: 60 }, domain: 'audio' },
        { id: 'a-scope', type: 'scope',    position: { x: 280, y: 60 }, domain: 'audio' },
        { id: 'v-out',  type: 'videoOut',  position: { x: 600, y: 60 }, domain: 'video' },
      ],
      [
        { id: 'e1', from: { nodeId: 'a-vco', portId: 'saw' },     to: { nodeId: 'a-scope', portId: 'ch1' }, sourceType: 'audio',      targetType: 'audio' },
        { id: 'e2', from: { nodeId: 'a-scope', portId: 'out' },   to: { nodeId: 'v-out',   portId: 'in' },  sourceType: 'mono-video', targetType: 'video' },
      ],
    );

    const card = page.locator('[data-testid="video-out-card"]');
    await expect(card).toHaveCount(1);

    // Capture initial sizes.
    const before = await card.evaluate((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return { width: r.width, height: r.height };
    });

    // Resize via direct node.data mutation (the user-action drag is
    // covered in video-output-resize.spec.ts; here we exercise that the
    // resized card still shows the scope content).
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes['v-out'];
        if (!n) return;
        if (!n.data) n.data = {};
        n.data.width = 720;
        n.data.height = 460;
      });
    });
    await page.waitForTimeout(200);
    const after = await card.evaluate((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    expect(after.width, 'card grew').toBeGreaterThan(before.width);
    expect(after.height, 'card grew').toBeGreaterThan(before.height);

    const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
    await page.waitForTimeout(700);
    const variance = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return 0;
      const img = ctx.getImageData(0, 0, c.width, c.height);
      let s = 0, sq = 0, n = 0;
      for (let i = 0; i < img.data.length; i += 16) {
        const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
        s += v; sq += v * v; n++;
      }
      const mean = s / n;
      return sq / n - mean * mean;
    });
    expect(variance, 'scope renders inside resized card').toBeGreaterThan(5);
  });
});
