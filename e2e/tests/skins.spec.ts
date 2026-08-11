// e2e/tests/skins.spec.ts
//
// Palette switcher (formerly "skins"): ships in Canvas's topbar between Clear
// and Sign in. Lets the user pick one of the in-tree COLOR-ONLY palettes; the
// choice persists in localStorage ("pt.skin") and re-applies on reload.
//
// P0.1 re-tier: palettes are colour-only over one fixed dark structure, so
// there is no sprite/structural path to exercise here anymore (the old Vintage
// sprite-fader + DINER/LCARS shape-token tests were removed with those skins).
//
// We assert observable behavior: the switcher renders, popover opens, each
// option flips documentElement's --bg CSS var to the expected hex, and a
// reload re-applies the chosen palette.

import { test, expect, openFileMenu } from './_fixtures';

test.describe.configure({ mode: 'parallel' });

/** Read a CSS-var off documentElement after the store has applied it. */
async function readVar(page: import('@playwright/test').Page, name: string): Promise<string> {
  return await page.evaluate((n) => {
    return document.documentElement.style.getPropertyValue(n).trim();
  }, name);
}

/** REVEAL the switcher: it now lives inside File.. → Theme rather than sitting
 *  bare in the topbar, so nothing here is on screen until the menu is open. */
async function revealSwitcher(page: import('@playwright/test').Page) {
  const trigger = page.getByTestId('skin-switcher-trigger');
  if (await trigger.isVisible().catch(() => false)) return;
  await openFileMenu(page);
  // IDEMPOTENT: `workflow-file-theme` TOGGLES its section, so clicking it when
  // the section is already expanded collapses it again. The loop in "each
  // shipped palette sets the expected --bg" calls this five times in a row and
  // hit exactly that.
  await page.getByTestId('workflow-file-theme').click();
  await expect(trigger).toBeVisible();
}

/** Reveal it AND open its popover (the option list). */
async function openSwitcher(page: import('@playwright/test').Page) {
  await revealSwitcher(page);
  await page.getByTestId('skin-switcher-trigger').click();
  await expect(page.getByTestId('skin-switcher-popover')).toBeVisible();
}

test('palettes: switcher renders in the File.. menu with rackline active', async ({ page, rack }) => {
  await revealSwitcher(page);
  await expect(page.getByTestId('skin-current-id')).toHaveText('rackline');
  await expect(page.getByTestId('skin-current-label')).toHaveText('Rackline');
});

test('palettes: popover lists all 5 in-tree palettes', async ({ page, rack }) => {
  await openSwitcher(page);
  for (const id of ['rackline', 'graphite', 'midnight', 'ember', 'slate']) {
    await expect(page.getByTestId(`skin-option-${id}`)).toBeVisible();
  }
});

test('palettes: picking midnight flips --bg + persists choice', async ({ page, rack }) => {
  await openSwitcher(page);
  await page.getByTestId('skin-option-midnight').click();
  await expect(page.getByTestId('skin-current-id')).toHaveText('midnight');
  expect(await readVar(page, '--bg')).toBe('#0b0f1a');
  expect(await readVar(page, '--accent')).toBe('#5cc8ff');
  const stored = await page.evaluate(() => localStorage.getItem('pt.skin'));
  expect(stored).toBe('midnight');
});

test('palettes: cable domain hues match the mocks in every palette', async ({ page, rack }) => {
  // The cable language is constant across palettes (owner decision #1).
  await openSwitcher(page);
  await page.getByTestId('skin-option-ember').click();
  await expect(page.getByTestId('skin-current-id')).toHaveText('ember');
  expect(await readVar(page, '--cable-audio')).toBe('#38d3c8'); // teal
  expect(await readVar(page, '--cable-gate')).toBe('#f2c14e'); // amber
  expect(await readVar(page, '--cable-video')).toBe('#b57bff'); // violet
});

test('palettes: choice survives a reload', async ({ page, rack }) => {
  await openSwitcher(page);
  await page.getByTestId('skin-option-graphite').click();
  await expect(page.getByTestId('skin-current-id')).toHaveText('graphite');
  expect(await readVar(page, '--bg')).toBe('#101215');

  await page.reload();
  await page.waitForLoadState('networkidle');
  await revealSwitcher(page); // the menu does not survive a reload
  await expect(page.getByTestId('skin-current-id')).toHaveText('graphite');
  expect(await readVar(page, '--bg')).toBe('#101215');
  expect(await readVar(page, '--accent')).toBe('#38d3c8');
});

test('palettes: each shipped palette sets the expected --bg', async ({ page, rack }) => {
  const cases: Array<{ id: string; bg: string }> = [
    { id: 'rackline', bg: '#0e1013' },
    { id: 'graphite', bg: '#101215' },
    { id: 'midnight', bg: '#0b0f1a' },
    { id: 'ember', bg: '#14110f' },
    { id: 'slate', bg: '#15181c' },
  ];
  for (const c of cases) {
    await openSwitcher(page);
    await page.getByTestId(`skin-option-${c.id}`).click();
    await expect(page.getByTestId('skin-current-id')).toHaveText(c.id);
    expect(await readVar(page, '--bg')).toBe(c.bg);
  }
});

test('palettes: clicking outside closes the popover without changing palette', async ({ page, rack }) => {
  await openSwitcher(page);
  await page.locator('header.workflow-topbar h1').click();
  await expect(page.getByTestId('skin-switcher-popover')).not.toBeVisible();
  // The outside click now closes the whole File.. menu, so `skin-current-id`
  // leaves the DOM with it — re-open to read the palette back. The claim under
  // test is unchanged: dismissing without picking must not change the palette.
  await revealSwitcher(page);
  await expect(page.getByTestId('skin-current-id')).toHaveText('rackline');
});
