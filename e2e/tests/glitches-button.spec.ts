// e2e/tests/glitches-button.spec.ts
//
// E2E for the topbar "GLITCHES GET RICHES" demo button. Covers:
//   1. The button exists with the right label + data-testid.
//   2. Clicking it materializes the bundled envelope's patch
//      (window.__patch.nodes goes from empty → populated).
//   3. The patch contains a PICTUREBOX node with imageBytes attached
//      (proves the bundled glitch.jpg landed in the store).
//   4. At least one downstream VIDEO OUT canvas is non-blank
//      (variance > 5) — proves the image actually flowed through the
//      video engine, not just the data layer.
//
// Replaces the (never-shipped) atlantis-button.spec.ts in spirit.

import { test, expect, type Page } from '@playwright/test';

test.describe('GLITCHES GET RICHES demo button', () => {
  test('button renders + click loads the patch + picturebox shows glitch.jpg', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // 1. Button visible with the right label + testid.
    const button = page.locator('[data-testid="load-glitches-btn"]');
    await expect(button, 'GLITCHES button exists').toHaveCount(1);
    await expect(button).toHaveText(/GLITCHES GET RICHES/);

    // Sanity: the retired Visit Atlantis button should NOT be present.
    await expect(
      page.locator('[data-testid="visit-atlantis-btn"]'),
      'Visit Atlantis button removed',
    ).toHaveCount(0);

    // 2. Click → patch should populate. Use polling rather than a hard
    //    timeout so flaky CI doesn't fight us.
    const nodeCountBefore = await readNodeCount(page);
    expect(nodeCountBefore, 'patch starts empty').toBe(0);

    await button.click();

    await expect.poll(async () => readNodeCount(page), {
      message: 'patch nodes loaded from GLITCHES envelope',
      timeout: 15_000,
    }).toBeGreaterThan(5);

    // 3. PICTUREBOX node landed with imageBytes populated.
    const pictureboxInfo = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { id: string; type: string; data?: { imageBytes?: string | null; imageMime?: string; imageName?: string } }> };
      };
      const pbs = Object.values(w.__patch.nodes).filter((n) => n.type === 'picturebox');
      return pbs.map((n) => ({
        id: n.id,
        imageBytesLen: typeof n.data?.imageBytes === 'string' ? n.data.imageBytes.length : 0,
        imageMime: n.data?.imageMime ?? null,
        imageName: n.data?.imageName ?? null,
      }));
    });
    expect(pictureboxInfo.length, 'envelope has a PICTUREBOX node').toBeGreaterThan(0);
    expect(pictureboxInfo[0].imageBytesLen, 'PICTUREBOX carries image bytes').toBeGreaterThan(1000);
    expect(pictureboxInfo[0].imageMime).toBe('image/jpeg');

    // 4. At least one downstream VIDEO OUT canvas is non-blank. Wait
    //    long enough for the picturebox bytes to decode + upload to the
    //    GL texture + the render loop to push at least one frame.
    await page.waitForTimeout(1200);

    const canvases = page.locator('canvas[data-testid="video-out-canvas"]');
    const canvasCount = await canvases.count();
    expect(canvasCount, 'at least one VIDEO OUT canvas present').toBeGreaterThan(0);

    // Walk every video-out canvas + find one with content variance > 5
    // (the threshold used by wavecel-video-outs.spec.ts). The envelope
    // has 5 videoOut nodes; at least one of them is on the picturebox
    // path.
    let bestVariance = -1;
    for (let i = 0; i < canvasCount; i++) {
      const stats = await canvases.nth(i).evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const ctx = c.getContext('2d');
        if (!ctx) return null;
        const img = ctx.getImageData(0, 0, c.width, c.height);
        const w = c.width, h = c.height;
        let n = 0, sum = 0, sumSq = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const idx = (y * w + x) * 4;
            const v = (img.data[idx]! + img.data[idx + 1]! + img.data[idx + 2]!) / 3;
            sum += v; sumSq += v * v; n++;
          }
        }
        const mean = sum / n;
        return { variance: sumSq / n - mean * mean, n };
      });
      if (stats && stats.variance > bestVariance) bestVariance = stats.variance;
    }
    expect(bestVariance, `at least one VIDEO OUT canvas variance > 5 (saw ${bestVariance})`).toBeGreaterThan(5);

    // No unexpected errors. Some warnings are expected (third-party WASM
    // bootstraps log noisily); we only check errors.
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

async function readNodeCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = globalThis as unknown as { __patch?: { nodes: Record<string, unknown> } };
    return w.__patch ? Object.keys(w.__patch.nodes).length : 0;
  });
}
