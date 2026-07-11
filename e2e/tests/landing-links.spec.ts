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

const GH_PAGES = 'https://2600hz-oscillator.github.io/patchtogether.live';

test.describe('landing links', () => {
  test('6 tiles + sign-in link are present with the right hrefs', async ({
    page,
  }) => {
    await page.goto('/');

    // The tiles (no numbers, no hero) — ART + VRT galleries are cards too.
    // WORKFLOW MODE: the unauthenticated front door offers BOTH shells
    // (owner directive 2026-07-11 — the dashboard-only card left anonymous
    // users with no path into workflow mode).
    await expect(page.getByTestId('tile-new-rack')).toHaveAttribute('href', '/rack');
    await expect(page.getByTestId('tile-new-workflow-rack')).toHaveAttribute('href', '/rack?mode=workflow');
    await expect(page.getByTestId('tile-rackspaces')).toHaveAttribute('href', '/dashboard');
    await expect(page.getByTestId('tile-modules')).toHaveAttribute('href', '/docs/modules');
    await expect(page.getByTestId('tile-art')).toHaveAttribute('href', `${GH_PAGES}/art/`);
    await expect(page.getByTestId('tile-docs')).toHaveAttribute('href', '/docs');
    await expect(page.getByTestId('tile-vrt')).toHaveAttribute('href', `${GH_PAGES}/vrt/`);

    // Static header sign-in.
    await expect(page.getByTestId('header-signin')).toHaveAttribute('href', '/sign-in');

    // All tiles are actually rendered/visible.
    for (const id of ['new-rack', 'new-workflow-rack', 'rackspaces', 'modules', 'art', 'docs', 'vrt']) {
      await expect(page.getByTestId(`tile-${id}`)).toBeVisible();
    }
  });

  test('the NEW DAWLESS RACK tile navigates to the canvas', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tile-new-rack').click();
    await expect(page).toHaveURL(/\/rack$/);
    await expect(page.locator('[data-testid="canvas-root"]')).toBeVisible();
  });

  test('the NEW WORKFLOW RACK tile boots the WORKFLOW shell without auth', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('tile-new-workflow-rack').click();
    await expect(page).toHaveURL(/\/rack\?mode=workflow$/);
    // The workflow shell's distinguishing chrome: the WorkflowTopbar (File..)
    // — not the dawless topbar. Anonymous users get the full shell.
    await expect(page.getByTestId('workflow-topbar')).toBeVisible();
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
