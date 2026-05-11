// e2e/tests/skins.spec.ts
//
// SkinSwitcher: ships in Canvas's topbar between Clear and Sign in.
// Lets the user pick one of 4 in-tree skins; the choice persists in
// localStorage and re-applies on reload.
//
// We assert observable behavior: the switcher renders, popover opens,
// each option flips documentElement's --bg CSS var to the expected hex,
// and a reload re-applies the chosen skin (proving localStorage round-
// trips).

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

/** Read a CSS-var off documentElement after the store has applied it. */
async function readVar(page: import('@playwright/test').Page, name: string): Promise<string> {
  return await page.evaluate((n) => {
    return document.documentElement.style.getPropertyValue(n).trim();
  }, name);
}

/** Open the skin-switcher popover. The trigger lives in the topbar
 *  immediately before the Sign in link — see Canvas.svelte. */
async function openSwitcher(page: import('@playwright/test').Page) {
  await page.getByTestId('skin-switcher-trigger').click();
  await expect(page.getByTestId('skin-switcher-popover')).toBeVisible();
}

test('skins: switcher renders in topbar with default skin active', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('skin-switcher-trigger')).toBeVisible();
  await expect(page.getByTestId('skin-current-id')).toHaveText('default');
  await expect(page.getByTestId('skin-current-label')).toHaveText('Default');
});

test('skins: popover lists all 4 in-tree skins', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await openSwitcher(page);
  for (const id of ['default', 'terminal-green', 'brutalist', 'vaporwave']) {
    await expect(page.getByTestId(`skin-option-${id}`)).toBeVisible();
  }
});

test('skins: picking terminal-green flips --bg + persists choice', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await openSwitcher(page);
  await page.getByTestId('skin-option-terminal-green').click();
  await expect(page.getByTestId('skin-current-id')).toHaveText('terminal-green');
  // --bg should now be the terminal-green skin's value.
  expect(await readVar(page, '--bg')).toBe('#000000');
  expect(await readVar(page, '--text')).toBe('#7fff7f');
  // localStorage should reflect the choice.
  const stored = await page.evaluate(() => localStorage.getItem('pt.skin'));
  expect(stored).toBe('terminal-green');
});

test('skins: choice survives a reload', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await openSwitcher(page);
  await page.getByTestId('skin-option-vaporwave').click();
  await expect(page.getByTestId('skin-current-id')).toHaveText('vaporwave');
  expect(await readVar(page, '--bg')).toBe('#0a0521');

  // Reload — store boots, reads localStorage, applies skin.
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('skin-current-id')).toHaveText('vaporwave');
  expect(await readVar(page, '--bg')).toBe('#0a0521');
  expect(await readVar(page, '--accent')).toBe('#ff7ce0');
});

test('skins: each shipped skin sets the expected --bg', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  // Iterate every skin; the trigger re-renders with the new label/id
  // after each pick so the test exercises the complete switch loop.
  const cases: Array<{ id: string; bg: string }> = [
    { id: 'default', bg: '#0e1116' },
    { id: 'terminal-green', bg: '#000000' },
    { id: 'brutalist', bg: '#000000' },
    { id: 'vaporwave', bg: '#0a0521' },
  ];
  for (const c of cases) {
    await openSwitcher(page);
    await page.getByTestId(`skin-option-${c.id}`).click();
    await expect(page.getByTestId('skin-current-id')).toHaveText(c.id);
    expect(await readVar(page, '--bg')).toBe(c.bg);
  }
});

test('skins: clicking outside closes the popover without changing skin', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await openSwitcher(page);
  // Click the topbar's h1 — outside the switcher, inside the topbar
  // (avoids accidentally triggering Add-module / Load-example).
  await page.locator('.topbar h1').click();
  await expect(page.getByTestId('skin-switcher-popover')).not.toBeVisible();
  await expect(page.getByTestId('skin-current-id')).toHaveText('default');
});
