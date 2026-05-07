// e2e/tests/docs.spec.ts
//
// In-app /docs site (SvelteKit routes under packages/web/src/routes/docs/).
// Asserts:
//   - public access (beta gate carve-out works for /docs/*)
//   - module catalog renders one card per registered module
//   - per-module page renders an I/O diagram with the right port count
//   - right-click on a canvas module opens a menu with a "Docs" entry
//     that opens the right /docs/modules/<type> URL in a new tab

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

test('docs index renders unauthenticated', async ({ page }) => {
  const response = await page.goto('/docs');
  expect(response?.status()).toBeLessThan(400);
  // Hero copy is stable; if it ever changes, this assertion is the canary.
  await expect(page.getByRole('heading', { name: 'patchtogether.live', level: 1 })).toBeVisible();
  // Top nav has the four expected entries.
  for (const label of ['home', 'modules', 'testing', 'deploy']) {
    await expect(page.locator('.docs-topbar nav', { hasText: label })).toBeVisible();
  }
});

test('docs/modules gallery lists every module from the manifest', async ({ page }) => {
  await page.goto('/docs/modules');
  await expect(page.getByRole('heading', { name: 'module catalog' })).toBeVisible();
  // Cards carry data-testid="docs-mod-card"; the catalog should render
  // 19 cards as of the registry at PR open. Use >= so a future module
  // addition doesn't fail the test.
  const cards = page.locator('[data-testid="docs-mod-card"]');
  await expect(cards.first()).toBeVisible();
  const count = await cards.count();
  expect(count).toBeGreaterThanOrEqual(19);
});

test('docs/modules/sequencer renders the I/O diagram + 3 outputs', async ({ page }) => {
  await page.goto('/docs/modules/sequencer');
  await expect(page.getByRole('heading', { name: /Sequencer/ })).toBeVisible();
  // The IoDiagram component renders a single SVG with the moduleType label.
  const svg = page.getByTestId('docs-io-svg');
  await expect(svg).toBeVisible();
  // Sequencer has 3 outputs: pitch, gate, clock. Header text inside the SVG.
  await expect(page.getByRole('heading', { name: /Outputs \(3\)/ })).toBeVisible();
  // Source link points at the GitHub blob URL.
  const src = page.getByTestId('docs-source-link');
  await expect(src).toHaveAttribute(
    'href',
    /https:\/\/github\.com\/2600hz-oscillator\/patchtogether\.live\/blob\/main\/packages\/web\/src\/lib\/audio\/modules\/sequencer\.ts/,
  );
});

test('docs/modules/[bad-id] returns a 404', async ({ page }) => {
  const response = await page.goto('/docs/modules/this-module-does-not-exist');
  expect(response?.status()).toBe(404);
});

test('right-click on a module opens a Docs entry that links to that module', async ({ page, context }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Load example' }).click();
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

  // Right-click on the analog VCO card.
  const vco = page.locator('.svelte-flow__node-analogVco').first();
  await vco.click({ button: 'right' });

  // Menu opens with the Docs entry.
  const menu = page.locator('[role="menu"][aria-label="Module actions"]');
  await expect(menu).toBeVisible();
  const docsItem = menu.getByTestId('node-ctx-docs');
  await expect(docsItem).toBeVisible();
  await expect(docsItem).toHaveText(/Docs/);

  // Clicking opens a new tab pointed at /docs/modules/analogVco.
  const [popup] = await Promise.all([
    context.waitForEvent('page'),
    docsItem.click(),
  ]);
  await popup.waitForLoadState('domcontentloaded');
  expect(popup.url()).toContain('/docs/modules/analogVco');
  await expect(popup.getByRole('heading', { name: /Analog VCO/ })).toBeVisible();
  await popup.close();
});
