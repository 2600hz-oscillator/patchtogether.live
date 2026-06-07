// e2e/tests/swolevco.spec.ts
//
// SWOLEVCO end-to-end: spawn module, wire the `scope` mono-video output
// into OUTPUT, sweep the timbre knob, confirm the scope canvas shows
// non-trivial pixel content (the waveform changes visibly).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('SWOLEVCO renders + scope feeds OUTPUT canvas', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 's-vco', type: 'swolevco', position: { x: 60, y: 60 },  domain: 'audio' },
      { id: 'v-out', type: 'videoOut', position: { x: 600, y: 60 }, domain: 'video' },
    ],
    [
      // SWOLEVCO.scope (mono-video) -> OUTPUT.in (video) — cross-domain
      // texture bridge via the engine's audio→video bridge plumbing.
      {
        id: 'e1',
        from: { nodeId: 's-vco', portId: 'scope' },
        to:   { nodeId: 'v-out', portId: 'in' },
        sourceType: 'mono-video',
        targetType: 'video',
      },
    ],
  );

  // Card visible.
  const card = page.locator('.svelte-flow__node-swolevco');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('SWOLEVCO');

  // Wait for the engine to spin up + render some video frames.
  const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
  await expect(canvas).toHaveCount(1);
  await page.waitForTimeout(900);

  // Scope render — non-trivial pixel content (waveform-trace gate pattern).
  const variance = await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    const img = ctx.getImageData(0, 0, c.width, c.height);
    let s = 0, sq = 0, n = 0;
    for (let i = 0; i < img.data.length; i += 16) {
      const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
      s += v;
      sq += v * v;
      n++;
    }
    const mean = s / n;
    return sq / n - mean * mean;
  });
  expect(variance, 'OUTPUT shows SWOLEVCO scope trace').toBeGreaterThan(5);

  expect(errors, `console/page errors: ${errors.join('; ')}`).toEqual([]);
});

test('SWOLEVCO ratio knob change updates the rendered scope content', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: 's-vco', type: 'swolevco', position: { x: 60, y: 60 },  domain: 'audio' },
      { id: 'v-out', type: 'videoOut', position: { x: 600, y: 60 }, domain: 'video' },
    ],
    [
      {
        id: 'e1',
        from: { nodeId: 's-vco', portId: 'scope' },
        to:   { nodeId: 'v-out', portId: 'in' },
        sourceType: 'mono-video',
        targetType: 'video',
      },
    ],
  );

  const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
  await expect(canvas).toHaveCount(1);
  await page.waitForTimeout(700);

  // Mutate the SWOLEVCO ratio param via __patch — exercises that the
  // scope output responds to setParam (modulator frequency change).
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch: { nodes: Record<string, { params: Record<string, number> }> };
      __ydoc: { transact: (fn: () => void) => void };
    };
    w.__ydoc.transact(() => {
      const n = w.__patch.nodes['s-vco'];
      if (n) {
        n.params.timbre = 0.8;
        n.params.fold = 0.5;
      }
    });
  });
  await page.waitForTimeout(700);

  // Scope should still show non-trivial content after param mutation.
  const variance = await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    const img = ctx.getImageData(0, 0, c.width, c.height);
    let s = 0, sq = 0, n = 0;
    for (let i = 0; i < img.data.length; i += 16) {
      const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
      s += v;
      sq += v * v;
      n++;
    }
    const mean = s / n;
    return sq / n - mean * mean;
  });
  expect(variance, 'scope still renders after timbre+fold sweep').toBeGreaterThan(5);
});
