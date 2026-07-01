// e2e/tests/landing-links.spec.ts
//
// Phase 2 of the landing-page overhaul: the visual front door — a NEW RACK hero
// CTA above 5 numbered tiles (01 NEW RACK / 02 MY RACKSPACES / 03 MODULES /
// 04 ART GALLERY / 05 DOCS) plus a smaller VRT-gallery link and a static header
// "sign in".
//
// This spec asserts every tile/link is PRESENT and points at its real
// destination, and that the internal same-origin links actually navigate
// (no 404). The ART/VRT gallery links are the existing GitHub-Pages absolute
// URLs (owner decision Q4), asserted by href — we don't cross-origin navigate
// them (network-dependent + slow).

import { test, expect } from '@playwright/test';

const GH_PAGES = 'https://2600hz-oscillator.github.io/patchtogether.live';

test.describe('landing links', () => {
  test('hero + 5 tiles + gallery/sign-in links are present with the right hrefs', async ({
    page,
  }) => {
    await page.goto('/');

    // Hero CTA → /rack
    await expect(page.getByTestId('hero-new-rack')).toBeVisible();
    await expect(page.getByTestId('hero-new-rack')).toHaveAttribute('href', '/rack');

    // The 5 numbered tiles.
    await expect(page.getByTestId('tile-01')).toHaveAttribute('href', '/rack');
    await expect(page.getByTestId('tile-02')).toHaveAttribute('href', '/dashboard');
    await expect(page.getByTestId('tile-03')).toHaveAttribute('href', '/docs/modules');
    await expect(page.getByTestId('tile-04')).toHaveAttribute('href', `${GH_PAGES}/art/`);
    await expect(page.getByTestId('tile-05')).toHaveAttribute('href', '/docs');

    // Smaller VRT-gallery link + static header sign-in.
    await expect(page.getByTestId('vrt-gallery-link')).toHaveAttribute(
      'href',
      `${GH_PAGES}/vrt/`,
    );
    await expect(page.getByTestId('header-signin')).toHaveAttribute('href', '/sign-in');

    // All five tiles are actually rendered/visible.
    for (const n of ['01', '02', '03', '04', '05']) {
      await expect(page.getByTestId(`tile-${n}`)).toBeVisible();
    }
  });

  test('the NEW RACK hero navigates to the canvas', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('hero-new-rack').click();
    await expect(page).toHaveURL(/\/rack$/);
    await expect(page.locator('[data-testid="canvas-root"]')).toBeVisible();
  });

  test('internal doc tiles resolve to real routes (no 404)', async ({ page }) => {
    // MODULES → /docs/modules
    await page.goto('/');
    await page.getByTestId('tile-03').click();
    await expect(page).toHaveURL(/\/docs\/modules$/);
    await expect(page.locator('h1, h2').first()).toBeVisible();

    // DOCS → /docs
    await page.goto('/');
    await page.getByTestId('tile-05').click();
    await expect(page).toHaveURL(/\/docs$/);
    await expect(page.locator('h1, h2').first()).toBeVisible();
  });
});
