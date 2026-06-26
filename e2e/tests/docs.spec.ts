// e2e/tests/docs.spec.ts
//
// In-app docs site (post Astro/gh-pages migration). Three things to prove:
//   1. /docs/* is reachable unauthenticated and free of the beta gate.
//   2. The auto-generated catalog actually renders an I/O diagram per module.
//   3. The per-module right-click "Docs" entry on the canvas opens the
//      matching /docs/modules/<id> page in a new tab.

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

test('docs index renders unauthenticated', async ({ page }) => {
  const res = await page.goto('/docs');
  expect(res?.status()).toBeLessThan(400);
  await expect(page.getByRole('heading', { name: 'patchtogether.live', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /modules/i }).first()).toBeVisible();
});

test('docs modules gallery loads with diagrams', async ({ page }) => {
  await page.goto('/docs/modules');
  await expect(page.getByRole('heading', { name: 'module catalog' })).toBeVisible();
  // At least 19 module cards rendered (registry has 19 today; assertion is
  // a floor, not exact, so adding modules doesn't break the test).
  const cards = page.locator('.mod-card');
  await expect.poll(async () => cards.count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(19);
  // I/O diagram per card.
  const diagrams = page.locator('[data-testid="io-diagram"]');
  await expect.poll(async () => diagrams.count()).toBeGreaterThanOrEqual(19);
});

test('docs catalog surfaces the custom guide pages (grid-clip-launcher is reachable)', async ({
  page,
}) => {
  // The catalog is built from the AUDIO-only manifest, so the hand-written
  // walkthrough pages at custom routes (grid-clip-launcher, the Launchpad guide,
  // the video mappers, …) would be orphaned without an explicit "guides" section.
  await page.goto('/docs/modules');
  const guides = page.locator('[data-testid="guides"]');
  await expect(guides).toBeVisible();
  // The monome grid clip-launcher guide is linked here and navigates.
  const gridLink = guides.getByRole('link', { name: /clip player \+ monome grid/i });
  await expect(gridLink).toBeVisible();
  await gridLink.click();
  await expect(page).toHaveURL(/\/docs\/modules\/grid-clip-launcher\/?$/);
  await expect(
    page.getByRole('heading', { name: 'Clip player + monome grid', level: 1 }),
  ).toBeVisible();
  // …and the guide links back to the clip player module reference page.
  await expect(page.getByRole('link', { name: /clip player module page/i })).toBeVisible();
});

test('clip player module page surfaces the grid-clip-launcher guide callout', async ({ page }) => {
  // The auto `[id]` page for `clipplayer` must point at its illustrated guide via
  // the MODULE_GUIDES callout (the forward cross-link the owner asked for).
  await page.goto('/docs/modules/clipplayer');
  const guideLink = page.locator('[data-testid="module-guide-link"]');
  await expect(guideLink).toBeVisible();
  await expect(guideLink).toHaveAttribute('href', '/docs/modules/grid-clip-launcher');
});

test('docs per-module page renders its I/O (sequencer)', async ({ page }) => {
  await page.goto('/docs/modules/sequencer');
  await expect(page.getByRole('heading', { name: 'Sequencer' })).toBeVisible();

  // A per-module page leads with the interactive LIVE virtual module (the
  // primary view for promoted modules like sequencer), OR — before it mounts /
  // for non-promoted modules / with no JS — the numbered control FACE, OR the
  // abstract I/O diagram fallback. Any of the three proves the visual renders.
  const live = page.locator('[data-testid="virtual-module"]');
  const face = page.locator('[data-testid="module-face"]');
  const diagram = page.locator('[data-testid="module-diagram"] [data-testid="io-diagram"]');
  await expect(live.or(face).or(diagram)).toBeVisible();

  // The auto-generated I/O tables are the ground truth for every module —
  // sequencer has many gate inputs and pitch/gate/clock outputs.
  await expect(page.locator('[data-testid="io-inputs"]')).toBeVisible();
  await expect(page.locator('[data-testid="io-outputs"]')).toBeVisible();
  await expect(page.locator('[data-testid="io-outputs"]')).toContainText('pitch');
  await expect(page.locator('[data-testid="io-inputs"]')).toContainText('clock');
});

test.describe('no-JS / SSR fallback', () => {
  // The live virtual-module is onMount-gated (browser-only), so with JavaScript
  // DISABLED the prerendered fallback always renders. This verifies the static
  // IoDiagram + port-count path independently of whether the module is on the
  // interactive allowlist — analogVco IS interactive now, so a JS-on visit would
  // mount the live card and (correctly) hide the diagram. Testing the no-JS path
  // keeps this durable as the rollout promotes more modules.
  test.use({ javaScriptEnabled: false });
  test('docs per-module page falls back to the I/O diagram + port counts (no face, no JS)', async ({
    page,
  }) => {
    await page.goto('/docs/modules/analogVco');
    await expect(page.getByRole('heading', { name: 'Analog VCO' })).toBeVisible();
    await expect(page.locator('[data-testid="module-diagram"] [data-testid="io-diagram"]')).toBeVisible();
    await expect(page.locator('[data-testid="input-count"]')).toContainText(/\d+ inputs/);
    await expect(page.locator('[data-testid="output-count"]')).toContainText(/\d+ outputs/);
  });
});

test('docs page is not behind the Clerk auth wall', async ({ page }) => {
  // Anonymous fetch — should NOT redirect to /sign-in.
  const res = await page.goto('/docs/modules/analogVco');
  expect(res?.status()).toBeLessThan(400);
  expect(page.url()).toContain('/docs/modules/analogVco');
  await expect(page.getByRole('heading', { name: 'Analog VCO' })).toBeVisible();
});

test('right-click on a module opens the Docs entry, which opens the per-module docs page in a new tab', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('load-example-select').selectOption('sequenced-vco');
  await expect(page.locator('.svelte-flow__node')).toHaveCount(5, { timeout: 10_000 });

  // Right-click on the analog VCO card — its module type is 'analogVco', so
  // the Docs link should resolve to /docs/modules/analogVco.
  const vco = page.locator('.svelte-flow__node-analogVco').first();
  // Right-click the card background (title bar) — a knob/fader right-click now
  // opens the per-control MIDI menu instead of the module menu.
  await vco.locator('.title').click({ button: 'right' });

  const menu = page.locator('[role="menu"][aria-label="Module actions"]');
  await expect(menu).toBeVisible();
  const docsItem = menu.locator('[role="menuitem"]', { hasText: 'Docs' });
  await expect(docsItem).toBeVisible();

  const newPagePromise = context.waitForEvent('page');
  await docsItem.click();
  const newPage = await newPagePromise;
  await newPage.waitForLoadState('domcontentloaded');
  expect(newPage.url()).toContain('/docs/modules/analogVco');
  await expect(newPage.getByRole('heading', { name: 'Analog VCO' })).toBeVisible();
  await newPage.close();
});

test('right-clicking the empty canvas does NOT show a Docs entry (it shows the Add Module palette path instead)', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // Empty canvas — right-click on the SvelteFlow viewport, NOT on a node.
  const viewport = page.locator('.svelte-flow__pane, .svelte-flow__viewport').first();
  await viewport.click({ button: 'right' });
  // Whatever the empty-canvas menu surfaces (palette / Add Module / nothing),
  // the per-module Docs entry must not be present — that one is gated on a
  // node being right-clicked.
  const moduleMenu = page.locator('[role="menu"][aria-label="Module actions"]');
  await expect(moduleMenu).toHaveCount(0);
});
