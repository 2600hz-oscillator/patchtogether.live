// e2e/tests/media-burn-button.spec.ts
//
// E2E for the topbar "Media Burn" demo button. Covers:
//   1. The button exists with the right label + data-testid, sits next
//      to "GLITCHES GET RICHES", and isn't a no-op (boots the engine).
//   2. Click → 15 PICTUREBOX nodes + 1 CADILLAC land in the store.
//   3. The CADILLAC sprite renders via the existing
//      data-testid="cadillac-car" overlay (from PR #442 / the cadillac
//      branch).
//   4. ~1.5s after click, at least one PICTUREBOX has been deleted by
//      the car driving R→L through the grid.
//   5. The cadillac-explosion testid fires during the carnage.
//   6. No console errors during the demolition.
//
// Companion to the unit-level coverage in
// packages/web/src/lib/ui/example-patches/media-burn{,-math}.test.ts —
// those pin the layout/math at module-load time; this one exercises
// the load+render+collide path end-to-end through the running app.

import { test, expect, type Page } from '@playwright/test';

test.setTimeout(60_000);

test.describe('Media Burn demo button', () => {
  test('button renders + click loads 15 tiles + CADILLAC demolishes them', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // 1. Button visible with the right label + testid.
    const button = page.locator('[data-testid="load-media-burn-btn"]');
    await expect(button, 'Media Burn button exists').toHaveCount(1);
    await expect(button).toHaveText(/Media Burn/);

    // Sanity: GLITCHES button still ships next to it (we didn't break
    // the topbar layout).
    await expect(
      page.locator('[data-testid="load-glitches-btn"]'),
      'GGR button still next to Media Burn',
    ).toHaveCount(1);

    const nodeCountBefore = await readNodeCount(page);
    expect(nodeCountBefore, 'patch starts empty').toBe(0);

    // 2. Click → patch populates with 15 PICTUREBOX + 1 CADILLAC.
    await button.click();

    await expect
      .poll(async () => readNodeCount(page), {
        message: 'patch nodes loaded from MEDIA BURN envelope',
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(16);

    const initialCounts = await readTypeCounts(page);
    expect(initialCounts.picturebox).toBe(15);
    expect(initialCounts.cadillac).toBe(1);

    // 3. CADILLAC sprite renders (the overlay finds the node via
    //    snapshot, computes its position, mounts the <img>).
    await expect(
      page.locator('[data-testid="cadillac-car"]'),
      'cadillac sprite visible',
    ).toHaveCount(1);

    // 4. Wait ~1.5s past the click (covers the 1s wind-up + a 500ms
    //    cushion for the first rAF that crosses xR). At least one
    //    PICTUREBOX should be gone — the rightmost-column tiles are
    //    first to die because the car enters from the right.
    await page.waitForTimeout(1500);

    await expect
      .poll(async () => (await readTypeCounts(page)).picturebox, {
        message: 'at least one PICTUREBOX deleted by the cadillac',
        timeout: 5000,
      })
      .toBeLessThan(15);

    // 5. Explosion testid fires during the carnage. It's ephemeral
    //    (~600ms life, see CadillacOverlay.svelte) so we poll across a
    //    window rather than expecting it to still be visible at any
    //    instant. Each hit emits one; with 3 rows of tiles getting
    //    plowed we'll see at minimum 3 over the run.
    const explosionSeen = await waitForExplosion(page, 6000);
    expect(explosionSeen, 'at least one cadillac-explosion mounted').toBe(true);

    // 6. No unexpected errors during the demolition. (Some WebGL/WASM
    //    warnings are expected; we only check errors.)
    expect(errors, errors.join('\n')).toEqual([]);
  });
});

async function readNodeCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch?: { nodes: Record<string, unknown> };
    };
    return w.__patch ? Object.keys(w.__patch.nodes).length : 0;
  });
}

async function readTypeCounts(
  page: Page,
): Promise<{ picturebox: number; cadillac: number; total: number }> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch?: { nodes: Record<string, { type: string } | undefined> };
    };
    if (!w.__patch) return { picturebox: 0, cadillac: 0, total: 0 };
    let picturebox = 0;
    let cadillac = 0;
    let total = 0;
    for (const n of Object.values(w.__patch.nodes)) {
      if (!n) continue;
      total++;
      if (n.type === 'picturebox') picturebox++;
      else if (n.type === 'cadillac') cadillac++;
    }
    return { picturebox, cadillac, total };
  });
}

/** Poll for the cadillac-explosion testid to appear at least once
 *  within `timeoutMs`. Explosions are ephemeral so we have to catch
 *  one in-flight. */
async function waitForExplosion(page: Page, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const seen = await page
      .locator('[data-testid="cadillac-explosion"]')
      .count();
    if (seen > 0) return true;
    await page.waitForTimeout(100);
  }
  return false;
}
