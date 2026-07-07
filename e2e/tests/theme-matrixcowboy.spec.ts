// e2e/tests/theme-matrixcowboy.spec.ts
//
// MATRIXCOWBOY skin smoke. Verifies the new 90s CRT terminal skin:
//   1. is registered in the SkinSwitcher dropdown
//   2. applies its phosphor-green CSS vars on selection
//   3. flips documentElement[data-skin] so the scoped scanline + flicker
//      overlays in global.css attach
//   4. injects the IBM Plex Mono stylesheet via the existing
//      silkscreen-font hook
//   5. persists across reload (localStorage round-trip)
//   6. doesn't throw on subsequent navigation / re-renders
//
// This is intentionally a single dedicated spec (rather than folding into
// skins.spec.ts) so the MATRIXCOWBOY contract is testable in isolation
// and easy to grep for when the theme evolves.

import { test, expect } from './_fixtures';

test.describe.configure({ mode: 'parallel' });

async function readVar(
  page: import('@playwright/test').Page,
  name: string,
): Promise<string> {
  return await page.evaluate((n) => {
    return document.documentElement.style.getPropertyValue(n).trim();
  }, name);
}

test('matrixcowboy: selectable from switcher + applies phosphor palette', async ({ page, rack }) => {
  // Open switcher + select MATRIXCOWBOY.
  await page.getByTestId('skin-switcher-trigger').click();
  await expect(page.getByTestId('skin-switcher-popover')).toBeVisible();
  await expect(page.getByTestId('skin-option-matrixcowboy')).toBeVisible();
  await page.getByTestId('skin-option-matrixcowboy').click();

  // Active-skin id + label flip.
  await expect(page.getByTestId('skin-current-id')).toHaveText('matrixcowboy');
  await expect(page.getByTestId('skin-current-label')).toHaveText('Matrixcowboy');

  // Core palette wired through to documentElement.style.
  expect(await readVar(page, '--bg')).toBe('#020805');
  expect(await readVar(page, '--text')).toBe('#33ff66');
  expect(await readVar(page, '--accent')).toBe('#7cffb0');

  // data-skin attribute is the contract the scoped CRT overlay CSS hangs
  // off of. If this regresses, the scanlines + flicker silently disappear.
  const dataSkin = await page.evaluate(() =>
    document.documentElement.getAttribute('data-skin'),
  );
  expect(dataSkin).toBe('matrixcowboy');

  // Monospace silkscreen font hook is active (reuses Vintage's font stylesheet).
  expect(await readVar(page, '--font-silkscreen')).toMatch(/Plex Mono/);
  const linkHrefs = await page.evaluate(() =>
    Array.from(document.head.querySelectorAll('link[data-skin-font]')).map(
      (l) => (l as HTMLLinkElement).href,
    ),
  );
  expect(linkHrefs.some((h) => h.includes('IBM+Plex+Mono'))).toBe(true);

  // localStorage round-trip.
  const stored = await page.evaluate(() => localStorage.getItem('pt.skin'));
  expect(stored).toBe('matrixcowboy');
});

test('matrixcowboy: choice survives a reload + page stays functional', async ({ page, rack }) => {
  await page.getByTestId('skin-switcher-trigger').click();
  await page.getByTestId('skin-option-matrixcowboy').click();
  await expect(page.getByTestId('skin-current-id')).toHaveText('matrixcowboy');

  // Reload. The store boots from localStorage and reapplies the skin.
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('skin-current-id')).toHaveText('matrixcowboy');
  expect(await readVar(page, '--bg')).toBe('#020805');

  // No console errors during the load (subsequent renders don't throw).
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // Bump a render by toggling the switcher open/closed.
  await page.getByTestId('skin-switcher-trigger').click();
  await expect(page.getByTestId('skin-switcher-popover')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('skin-switcher-popover')).not.toBeVisible();
  expect(errors).toEqual([]);
});

test('matrixcowboy: switching back to default clears data-skin overlay hook', async ({ page, rack }) => {
  await page.getByTestId('skin-switcher-trigger').click();
  await page.getByTestId('skin-option-matrixcowboy').click();
  await expect(page.getByTestId('skin-current-id')).toHaveText('matrixcowboy');
  let dataSkin = await page.evaluate(() =>
    document.documentElement.getAttribute('data-skin'),
  );
  expect(dataSkin).toBe('matrixcowboy');

  // Switch back to default. data-skin should now be 'default' (not
  // missing — applySkinToRoot always writes the active skin id).
  await page.getByTestId('skin-switcher-trigger').click();
  await page.getByTestId('skin-option-default').click();
  await expect(page.getByTestId('skin-current-id')).toHaveText('default');
  dataSkin = await page.evaluate(() =>
    document.documentElement.getAttribute('data-skin'),
  );
  expect(dataSkin).toBe('default');
  // Default skin doesn't ship a silkscreen font, so the var clears.
  expect(await readVar(page, '--font-silkscreen')).toBe('');
});
