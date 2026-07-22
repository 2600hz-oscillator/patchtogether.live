// e2e/tests/skin-persists-app-wide.spec.ts
//
// Regression: the user's selected skin must apply on EVERY route and survive
// a hard reload — not just inside the canvas. The skin store (localStorage
// "pt.skin") used to be imported only by canvas components (Canvas /
// SkinSwitcher / Fader), so non-canvas routes (dashboard, docs, sign-in) and
// any full-page reload fell back to the default theme. The most visible
// symptom: deleting a rackspace did a window.location.reload() on the
// dashboard, which re-parsed <html> and reverted the theme to default. The fix
// imports + re-applies the skin store from the root +layout.svelte.
//
// We assert on /docs — a PUBLIC, non-canvas route (no Clerk) — so the test
// needs no auth. /docs does not import the skin store itself; if the theme
// shows there, it's because the root layout applied it app-wide.
// applyPaletteToRoot() always mirrors the active palette id onto
// <html data-palette>.

import { test, expect } from '@playwright/test';

const SKIN = 'midnight'; // any non-default in-tree palette id

const readDataSkin = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.documentElement.getAttribute('data-palette'));

test.describe('skin persists app-wide', () => {
  test('saved skin applies on a non-canvas route after a hard reload', async ({ page }) => {
    // Establish the origin, then persist a non-default skin choice.
    await page.goto('/docs');
    await page.evaluate((id) => localStorage.setItem('pt.skin', id), SKIN);

    // Hard reload (the dashboard-delete scenario): <html> is re-parsed fresh,
    // so the theme must be re-applied by the root layout — not carried over
    // from a prior canvas visit.
    await page.reload();

    await expect
      .poll(() => readDataSkin(page), {
        message: 'root layout should re-apply the saved skin on /docs',
        timeout: 5000,
      })
      .toBe(SKIN);
  });

  test('rackline is the baseline when nothing is saved', async ({ page }) => {
    await page.goto('/docs');
    await page.evaluate(() => localStorage.removeItem('pt.skin'));
    await page.reload();

    await expect
      .poll(() => readDataSkin(page), { timeout: 5000 })
      .toBe('rackline');
  });
});
