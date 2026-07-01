// e2e/tests/vfpga-floorplan.spec.ts
//
// vfpga-runner P5 — the FABRIC FLOORPLAN view. Spawns the host, toggles the
// floorplan on, and asserts the tile-grid + routing-nets diagram actually
// RENDERS (the Canvas2D surface is non-blank with structure) and that switching
// to a richer fabric (sync-bender) re-draws it. Canvas2D (not WebGL), so this is
// renderer-tolerant by construction (no SwiftShader/real-GPU divergence) — but
// we still assert a non-black + variance FLOOR rather than exact pixels.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

/** Read the floorplan canvas' pixel stats (it draws on a 2D context, so reading
 *  it back is exact + deterministic). */
async function floorplanStats(page: Page): Promise<{ nonZeroFrac: number; variance: number } | null> {
  const canvas = page.locator('[data-testid="vfpga-floorplan-canvas"]');
  await expect(canvas, 'floorplan canvas mounted').toHaveCount(1);
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0, sum = 0, sumSq = 0, nonZero = 0;
    for (let i = 0; i < data.length; i += 16) {
      const v = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      sum += v; sumSq += v * v; n++;
      if (v > 8) nonZero++;
    }
    const mean = sum / n;
    return { nonZeroFrac: nonZero / n, variance: sumSq / n - mean * mean };
  });
}

async function spawnRunner(page: Page) {
  await spawnPatch(
    page,
    [
      { id: 'vf', type: 'vfpgaRunner', position: { x: 80, y: 80 }, domain: 'video' },
      { id: 'out', type: 'videoOut', position: { x: 600, y: 80 }, domain: 'video' },
    ],
    [
      { id: 'e1', from: { nodeId: 'vf', portId: 'vout1' }, to: { nodeId: 'out', portId: 'in' }, sourceType: 'video', targetType: 'video' },
    ],
  );
  await expect(page.locator('[data-testid="vfpga-runner-card"]')).toHaveCount(1);
}

test.describe('vfpga-runner — fabric floorplan view (P5)', () => {
  test('the floorplan is off by default and toggles a non-blank tile-grid/nets diagram', async ({ page }) => {
    test.setTimeout(45_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnRunner(page);

    // Off by default — the card already shows the preview + controls.
    await expect(page.locator('[data-testid="vfpga-floorplan"]')).toHaveCount(0);

    // Toggle it on.
    const toggle = page.locator('[data-testid="vfpga-floorplan-toggle"]');
    await expect(toggle).toHaveCount(1);
    await toggle.click();
    await expect(page.locator('[data-testid="vfpga-floorplan"]')).toHaveCount(1);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    // The Canvas2D diagram paints tiles + nets → non-blank with spatial
    // structure. Poll for the first $effect draw to land.
    let stats = await floorplanStats(page);
    for (let i = 0; i < 40 && (!stats || stats.nonZeroFrac <= 0.01); i++) {
      await page.waitForTimeout(100);
      stats = await floorplanStats(page);
    }
    expect(stats, 'floorplan canvas readable').not.toBeNull();
    expect(stats!.nonZeroFrac, `tiles/nets drawn (nonZeroFrac=${stats!.nonZeroFrac})`).toBeGreaterThan(0.02);
    expect(stats!.variance, `floorplan has structure (var=${stats!.variance})`).toBeGreaterThan(10);

    // Toggling off removes it.
    await toggle.click();
    await expect(page.locator('[data-testid="vfpga-floorplan"]')).toHaveCount(0);

    expect(errors, 'no console / page errors').toEqual([]);
  });

  test('switching to a richer fabric (sync-bender) re-draws the floorplan with its legend', async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await spawnRunner(page);

    await page.locator('[data-testid="vfpga-floorplan-toggle"]').click();
    await expect(page.locator('[data-testid="vfpga-floorplan"]')).toHaveCount(1);

    // Load the sync-bender fabric (IIN1 → syncBend → OUT1).
    const select = page.locator('[data-testid="vfpga-preset"]');
    await select.selectOption('sync-bender');
    await expect(page.locator('[data-testid="vfpga-loaded"]')).toHaveText('sync-bender');

    // The legend lists the tile types present in this fabric (a clb cell), and
    // the diagram is non-blank.
    const legend = page.locator('[data-testid="vfpga-floorplan-legend"]');
    await expect(legend).toHaveCount(1);
    await expect(legend).toContainText('clb');

    let stats = await floorplanStats(page);
    for (let i = 0; i < 40 && (!stats || stats.nonZeroFrac <= 0.01); i++) {
      await page.waitForTimeout(100);
      stats = await floorplanStats(page);
    }
    expect(stats!.nonZeroFrac, 'sync-bender floorplan drawn').toBeGreaterThan(0.02);
  });
});
