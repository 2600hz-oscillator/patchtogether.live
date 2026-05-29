// e2e/tests/peakstate.spec.ts
//
// Smoke test for PEAKSTATE — verifies the module spawns, the GL pipeline
// runs, and the RGB output reaches a VIDEO-OUT with non-trivial content
// after a one-second settle.
//
// The mandala is self-driving (internal pen + ring buffer) so we just
// spawn PEAKSTATE → VIDEO-OUT, wait for the trail to fill, and assert
// the VIDEO-OUT canvas has pixel variance > 5 (i.e. it's not a uniform
// black void). No deep visual assertions — the unit tests pin the
// algorithmic details + VRT pins the rendered output exactly.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

async function setup(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  return errors;
}

/** Pixel-luma variance over the named VIDEO-OUT canvas. A flat / black
 *  canvas reads variance ≈ 0; the mandala trail reads variance ≫ 5. */
async function lumaVariance(page: Page, nodeId: string): Promise<number> {
  const handle = page.locator(`canvas[data-testid="video-out-canvas"][data-node-id="${nodeId}"]`);
  await expect(handle, `VIDEO-OUT ${nodeId} canvas present`).toHaveCount(1);
  return await handle.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const n = data.length / 4;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
    const mean = sum / n;
    let varSum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const luma = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      const d = luma - mean;
      varSum += d * d;
    }
    return varSum / n;
  });
}

test.describe('PEAKSTATE — animated mandala spawn smoke', () => {
  test('rgb_out → VIDEO-OUT shows non-trivial pixels after 1s', async ({ page }) => {
    const errors = await setup(page);

    await spawnPatch(
      page,
      [
        { id: 'mandala', type: 'peakstate', position: { x: 40,  y: 40 }, domain: 'video' },
        { id: 'sink',    type: 'videoOut',  position: { x: 480, y: 40 }, domain: 'video' },
      ],
      [
        {
          id: 'e_rgb',
          from: { nodeId: 'mandala', portId: 'rgb_out' },
          to:   { nodeId: 'sink',    portId: 'in' },
          sourceType: 'video',
          targetType: 'video',
        },
      ],
    );

    // Let the pen trace + ring buffer fill out a recognisable mandala.
    // 1s is plenty — the spec calls for "wait 1 second, variance > 5".
    await page.waitForTimeout(1000);

    const v = await lumaVariance(page, 'sink');
    expect(v, `VIDEO-OUT pixel-luma variance after 1s settle (got ${v.toFixed(2)})`).toBeGreaterThan(5);

    // Page errors during the spawn / render path would silently hide a
    // broken GL upload + a black-output false-pass; surface them here.
    expect(errors, 'no console / page errors during PEAKSTATE smoke').toEqual([]);
  });
});
