// e2e/tests/docs.spec.ts
//
// In-app /docs/* SvelteKit routes (replaces the retired Astro gh-pages site).
//
// Coverage:
//   1. /docs/modules is reachable unauthenticated; no beta-gate prompt
//   2. /docs/modules/sequencer renders with the I/O diagram + at least one port
//   3. Right-click on a module card shows a "Docs" menu item; clicking it
//      opens /docs/modules/<type> in a new tab
//   4. Landing page header renders the spaced wordmark "patchtogether.live"
//      with no "Day 7" subtitle

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

test('@smoke /docs/modules is reachable unauthenticated, no beta gate', async ({ page }) => {
  const response = await page.goto('/docs/modules');
  expect(response?.status(), 'GET /docs/modules').toBe(200);
  // Beta gate would manifest as a 401 + WWW-Authenticate header; .status() above
  // proves we got the SvelteKit page through. Confirm visible chrome.
  await expect(page.getByRole('heading', { name: 'module catalog' })).toBeVisible();
  // Catalog page lists the canonical category anchors.
  await expect(page.getByRole('link', { name: /sources \(/ })).toBeVisible();
});

test('/docs/modules/sequencer renders the diagram + ports', async ({ page }) => {
  await page.goto('/docs/modules/sequencer');
  await expect(page.getByRole('heading', { name: /sequencer/i })).toBeVisible();
  // I/O diagram is an SVG with the module-aria-label.
  await expect(page.locator('svg.io-svg')).toBeVisible();
  // At least one port row in the inputs table; sequencer has clock + chord.
  await expect(page.locator('table tbody tr').first()).toBeVisible();
  // Source link present.
  await expect(page.getByRole('link', { name: /sequencer\.ts/ })).toBeVisible();
});

test('right-click a module card → Docs entry → opens /docs/modules/<type> in new tab', async ({ page, context }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Load example' }).click();
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

  const vco = page.locator('.svelte-flow__node-analogVco').first();
  await vco.click({ button: 'right' });

  const docsItem = page.getByTestId('ctx-docs');
  await expect(docsItem).toBeVisible();

  const popupPromise = context.waitForEvent('page');
  await docsItem.click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  expect(popup.url()).toContain('/docs/modules/analogVco');
  await expect(popup.getByRole('heading', { name: /analog vco/i })).toBeVisible();
  await popup.close();
});

test('landing page shows spaced wordmark, no "Day 7" subtitle', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // The wordmark contains literal "patchtogether.live"; spacing is CSS-only.
  const wordmark = page.getByTestId('app-wordmark');
  await expect(wordmark).toBeVisible();
  await expect(wordmark).toHaveText('patchtogether.live');
  // Confirm the visual letter-spacing rule is applied.
  const ls = await wordmark.evaluate((el) => getComputedStyle(el).letterSpacing);
  // 0.45em with the canvas's 1.05rem font-size resolves to ~6.6px; any
  // value > 4px is enough to assert the spaced-wordmark intent.
  expect(parseFloat(ls)).toBeGreaterThan(4);
  // No "Day 7" caption survives anywhere in the topbar.
  await expect(page.locator('.topbar')).not.toContainText('Day 7');
});
