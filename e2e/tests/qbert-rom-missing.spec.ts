// e2e/tests/qbert-rom-missing.spec.ts
//
// QBERT "ROM missing" path — spawning the module without the ROM zip in
// /static/roms/qbert/ MUST render the on-card "ROM MISSING — run
// `task setup:qbert`" overlay, with NO console errors + no audio output.
//
// Mirrors the DOOM pattern: ROM is gitignored and user-provided; cloud
// deploys + clean checkouts always hit this path, so it has to be solid.
//
// This spec assumes the ROM is ABSENT — the static dir contains only
// `README.md`, no `qbert.zip`. If a contributor's local box has
// `qbert.zip` installed via `task setup:qbert`, this spec gates on
// HEAD-fetching the zip and SKIPs when present (we don't want to mis-
// detect a contributor's locally-installed ROM as a failure).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

async function isRomPresent(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    try {
      const r = await fetch('/roms/qbert/qbert.zip', { method: 'HEAD' });
      return r.ok;
    } catch {
      return false;
    }
  });
}

test('qbert: ROM missing → "ROM MISSING" overlay renders, no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Skip cleanly when the local box happens to have the ROM installed —
  // this spec asserts the MISSING path; the present path is covered by
  // qbert-cv-joystick.spec.ts.
  if (await isRomPresent(page)) {
    test.skip(true, 'ROM is locally installed; this spec covers the MISSING path');
  }

  await spawnPatch(page, [
    { id: 'q', type: 'qbert', position: { x: 200, y: 200 }, domain: 'video' },
  ]);

  const card = page.locator('.svelte-flow__node-qbert');
  await expect(card).toBeVisible();
  await expect(card).toContainText('QBERT');

  // The "ROM MISSING" overlay appears asynchronously — the runtime
  // factory fires the fetch, the fetch 404s, the runtime swaps to the
  // "ROM missing" state, the card's 100 ms poll picks it up. Give it
  // ~3s on a slow CI runner.
  const overlay = card.locator('[data-testid="qbert-rom-missing"]');
  await expect(overlay).toBeVisible({ timeout: 5000 });
  await expect(overlay).toContainText('ROM MISSING');
  await expect(overlay).toContainText('task setup:qbert');

  // The canvas exists and is the native size — even with no ROM the
  // engine paints the diamond test pattern so the card never looks
  // broken.
  const canvas = card.locator('[data-testid="qbert-screen"]');
  await expect(canvas).toBeVisible();
  const size = await canvas.evaluate((el: Element) => {
    const c = el as HTMLCanvasElement;
    return { w: c.width, h: c.height };
  });
  expect(size.w).toBe(256);
  expect(size.h).toBe(240);

  // No UNEXPECTED console errors during the spawn + ROM-fetch + overlay
  // render. Chromium logs "Failed to load resource: ... 404 (Not Found)"
  // for every failed fetch (the HEAD check + the runtime's GET); those
  // 404s are exactly what THIS spec is exercising and are NOT regressions.
  // We also filter AudioContext spawn warnings (always present on a
  // fresh tab without a user gesture).
  const unexpected = errors.filter(
    (e) =>
      !e.includes('AudioContext') &&
      !(e.includes('404') && e.includes('Not Found')),
  );
  expect(unexpected, `unexpected console errors: ${unexpected.join('; ')}`).toEqual([]);
});
