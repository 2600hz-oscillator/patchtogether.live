// e2e/tests/landing-links.spec.ts
//
// Phase 2 of the landing-page overhaul: the visual front door — 6 link tiles
// (NEW RACK / MY RACKSPACES / MODULES / ART GALLERY / DOCS / VRT GALLERY, no
// numbers, no hero CTA — owner review removed it) and a static header "sign in".
//
// This spec asserts every tile is PRESENT and points at its real destination,
// and that the internal same-origin links actually navigate (no 404). The
// ART/VRT gallery tiles are the existing GitHub-Pages absolute URLs (owner
// decision Q4), asserted by href — we don't cross-origin navigate them
// (network-dependent + slow).

import { test, expect } from '@playwright/test';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// ⚠ THE PER-TEST BUDGET IS A BOUND, AND IT WAS THE INVISIBLE 30 s DEFAULT.
//
// This file bounds its boot waits with `BOOT_MS` — 30 000 on CI, IDENTICAL to
// the 30 000 default budget they were running inside. 2 sites, 1.00x.
//
// An inner bound at or above the budget that CONTAINS it can never come true:
// the outer clock kills the test first, so a legible `element not found` is
// converted into an illegible `Test timeout of 30000ms exceeded` — the class
// #2291 root-caused and #2293 repaired at its second call site. Nothing in this
// file said "30000"; `e2e/playwright.config.ts` never overrides Playwright's
// default, so there was nothing to grep for except the ABSENCE of a budget.
//
// The budget therefore comes from `boot-budget` (90 000 on CI/SwiftShader,
// 30 000 local) instead of the invisible default. A bound only costs wall-clock
// when it is EXCEEDED, so this adds exactly zero to a green run; lane cost stays
// gauged by `--global-timeout`, not by this.
//
// ⚠ BOUNDS ONLY. No assertion, subject or wait target changed here.
test.describe.configure({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

const GH_PAGES = 'https://2600hz-oscillator.github.io/patchtogether.live';

test.describe('landing links', () => {
  test('6 tiles + sign-in link are present with the right hrefs', async ({
    page,
  }) => {
    await page.goto('/');

    // The tiles (no numbers, no hero) — ART + VRT galleries are cards too.
    // ONE rack tile: the second one existed only to select the OTHER shell,
    // and there is one shell now.
    await expect(page.getByTestId('tile-new-rack')).toHaveAttribute('href', '/rack');
    await expect(page.getByTestId('tile-new-workflow-rack')).toHaveCount(0);
    await expect(page.getByTestId('tile-rackspaces')).toHaveAttribute('href', '/dashboard');
    await expect(page.getByTestId('tile-modules')).toHaveAttribute('href', '/docs/modules');
    await expect(page.getByTestId('tile-art')).toHaveAttribute('href', `${GH_PAGES}/art/`);
    await expect(page.getByTestId('tile-docs')).toHaveAttribute('href', '/docs');
    await expect(page.getByTestId('tile-vrt')).toHaveAttribute('href', `${GH_PAGES}/vrt/`);

    // Static header sign-in.
    await expect(page.getByTestId('header-signin')).toHaveAttribute('href', '/sign-in');

    // All tiles are actually rendered/visible.
    for (const id of ['new-rack', 'rackspaces', 'modules', 'art', 'docs', 'vrt']) {
      await expect(page.getByTestId(`tile-${id}`)).toBeVisible();
    }
  });

  test('the NEW RACK tile navigates to the canvas', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tile-new-rack').click();
    await expect(page).toHaveURL(/\/rack$/);
    await expect(page.locator('[data-testid="canvas-root"]')).toBeVisible({ timeout: BOOT_MS });
  });

  test('the rack tile boots the SHELL without auth', async ({ page }) => {
    // Was 'the NEW WORKFLOW RACK tile…', clicking the second tile. That tile is
    // gone, but the claim it made — an anonymous user reaches the FULL shell,
    // not a reduced one — is still worth holding, so it moves onto the one
    // remaining tile rather than being deleted with it.
    await page.goto('/');
    await page.getByTestId('tile-new-rack').click();
    await expect(page).toHaveURL(/\/rack$/);
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
    await expect(page.getByTestId('workflow-file-trigger')).toBeVisible();
  });

  test('internal doc tiles resolve to real routes (no 404)', async ({ page }) => {
    // MODULES → /docs/modules
    await page.goto('/');
    await page.getByTestId('tile-modules').click();
    await expect(page).toHaveURL(/\/docs\/modules$/);
    await expect(page.locator('h1, h2').first()).toBeVisible();

    // DOCS → /docs
    await page.goto('/');
    await page.getByTestId('tile-docs').click();
    await expect(page).toHaveURL(/\/docs$/);
    await expect(page.locator('h1, h2').first()).toBeVisible();
  });
});
