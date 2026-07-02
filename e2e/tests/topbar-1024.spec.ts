// e2e/tests/topbar-1024.spec.ts
//
// Topbar overflow regression (owner report): at narrow viewports the single
// flex row of topbar controls ran past the viewport edge and pushed the
// rightmost control — the Sign in / account link at the end of the .actions
// cluster — clean off the header. 1024×768 is a fully supported viewport:
// the topbar must WRAP (flex-wrap, see the .topbar CSS in Canvas.svelte)
// instead of overflowing, keeping every control (incl. auth) inside the
// viewport. Guarded at three widths:
//   - 1024×768 — narrow: the actions cluster wraps to a second row; every
//     control (incl. auth) stays inside the viewport.
//   - 1280×720 — the VRT viewport: contained too (the full actions cluster
//     is ~1.4k px of natural content, so it also wraps here — before this
//     fix the Sign in link sat ~80px past the right edge at this width).
//   - 1920×1080 — wide: unregressed, still a contained SINGLE row.

import { test, expect, type Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.locator('header.topbar').waitFor({ state: 'visible', timeout: 10_000 });
  // Boot settles the "Load example…" select from the transient "Loading…"
  // placeholder to its final (widest-known) label — wait so the control
  // widths we measure are the settled ones.
  await expect(page.getByTestId('load-example-select')).toBeEnabled({ timeout: 15_000 });
}

/** Assert every topbar control — specifically the auth control and the
 *  version stamp — is fully inside the viewport, and nothing in the header
 *  overflows horizontally. */
async function assertTopbarContained(page: Page, width: number): Promise<void> {
  const header = page.locator('header.topbar');

  // The auth control (anon e2e env → the Sign in link, the exact element the
  // owner's screenshot showed pushed off) is visible and fully inside.
  const signin = page.getByTestId('signin-link');
  await expect(signin).toBeVisible();
  const sb = await signin.boundingBox();
  expect(sb, 'signin link must have a bounding box').not.toBeNull();
  expect(sb!.x, 'signin link left edge inside viewport').toBeGreaterThanOrEqual(0);
  expect(sb!.x + sb!.width, 'signin link right edge inside viewport').toBeLessThanOrEqual(width);

  // The version stamp too.
  const version = page.getByTestId('app-version');
  await expect(version).toBeVisible();
  const vb = await version.boundingBox();
  expect(vb, 'version stamp must have a bounding box').not.toBeNull();
  expect(vb!.x + vb!.width, 'version stamp inside viewport').toBeLessThanOrEqual(width);

  // No horizontal overflow: the header contains its content…
  const m = await header.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(m.scrollWidth, 'header content must not overflow the header box').toBeLessThanOrEqual(
    m.clientWidth,
  );
  // …and the document doesn't scroll sideways.
  const docXOverflow = await page.evaluate(() => {
    const d = document.scrollingElement;
    return d ? d.scrollWidth - d.clientWidth : 0;
  });
  expect(docXOverflow, 'document must have no x-overflow').toBeLessThanOrEqual(0);

  // Belt-and-suspenders: the rightmost edge of ANY element inside the header
  // (covers the child-component controls — aspect / skin / Electra) is
  // inside the viewport. +0.5 tolerates fractional-px layout rounding.
  const maxRight = await header.evaluate((el) =>
    Math.max(
      el.getBoundingClientRect().right,
      ...Array.from(el.querySelectorAll('*')).map((c) => c.getBoundingClientRect().right),
    ),
  );
  expect(maxRight, 'no topbar element may extend past the viewport').toBeLessThanOrEqual(
    width + 0.5,
  );
}

/** The topbar renders as a SINGLE flex row: the brand heading and the auth
 *  control vertically overlap (a wrapped .actions row would sit fully below
 *  the h1). */
async function assertSingleRow(page: Page): Promise<void> {
  const h1 = await page.locator('header.topbar h1').boundingBox();
  const signin = await page.getByTestId('signin-link').boundingBox();
  expect(h1).not.toBeNull();
  expect(signin).not.toBeNull();
  expect(
    signin!.y < h1!.y + h1!.height,
    'auth control must share the first topbar row (no wrap at this width)',
  ).toBe(true);
}

test('1024×768: every topbar control (incl. the Sign in control) stays inside the viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await boot(page);
  await assertTopbarContained(page, 1024);
});

test('1280×720 (VRT viewport): every topbar control stays inside the viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await boot(page);
  await assertTopbarContained(page, 1280);
});

test('1920×1080: wide layout unregressed — contained, single row', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await boot(page);
  await assertTopbarContained(page, 1920);
  await assertSingleRow(page);
});
