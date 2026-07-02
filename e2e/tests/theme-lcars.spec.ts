// e2e/tests/theme-lcars.spec.ts
//
// LCARS skin smoke. LCARS is the Star Trek: TNG "Okudagram" skin — the third
// "fancy" sprite skin (after Vintage + Diner). This spec verifies its contract
// surfaces:
//   1. registered in the SkinSwitcher dropdown
//   2. applies its black-void + warm LCARS palette on selection
//   3. sets the optional shape tokens (--module-radius 22px / --module-glow /
//      --module-border-color) that drive the fully-rounded pill cards +
//      amber glow border in _module-card.css — radius pushed to MAX here
//   4. opts into sprite controls (controlStyle + panel/track vars) like
//      Vintage/Diner
//   5. injects the Antonio font stylesheet via the silkscreen-font hook
//   6. flips documentElement[data-skin] so the scoped LCARS elbow-bracket +
//      uppercase-label overlay in global.css attaches
//   7. persists across reload (localStorage round-trip)
//   8. switching AWAY restores defaults — crucially the optional shape tokens
//      are CLEARED so the other skins fall back to their hard-edged look, and
//      the OTHER skins are unaffected.
//
// Dedicated spec (mirrors theme-diner.spec.ts) so the LCARS contract is
// testable in isolation.

import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

async function readVar(
  page: import('@playwright/test').Page,
  name: string,
): Promise<string> {
  return await page.evaluate((n) => {
    return document.documentElement.style.getPropertyValue(n).trim();
  }, name);
}

test('lcars: selectable from switcher + applies Okudagram palette + shape tokens', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await page.getByTestId('skin-switcher-trigger').click();
  await expect(page.getByTestId('skin-switcher-popover')).toBeVisible();
  await expect(page.getByTestId('skin-option-lcars')).toBeVisible();
  await page.getByTestId('skin-option-lcars').click();

  await expect(page.getByTestId('skin-current-id')).toHaveText('lcars');
  await expect(page.getByTestId('skin-current-label')).toHaveText('LCARS');

  // Black-void + warm LCARS palette wired through.
  expect(await readVar(page, '--bg')).toBe('#000000');
  expect(await readVar(page, '--accent')).toBe('#FF9900');
  expect(await readVar(page, '--text')).toBe('#FFCC99');

  // Optional shape tokens — the fully-rounded pill + amber-border contract.
  // Radius is pushed to MAX (22px) so cards read as LCARS blocks.
  expect(await readVar(page, '--module-radius')).toBe('22px');
  expect(await readVar(page, '--module-glow')).toMatch(/rgba/);
  expect(await readVar(page, '--module-border-color')).toBe('#FF9900');

  // Sprite controls (like Vintage/Diner).
  expect(await readVar(page, '--control-style')).toBe('sprite');
  expect(await readVar(page, '--panel-bg')).toMatch(/^url\(/);
  expect(await readVar(page, '--fader-track-bg')).toMatch(/^url\(/);

  // data-skin attribute is the hook the scoped elbow-bracket overlay hangs off.
  const dataSkin = await page.evaluate(() =>
    document.documentElement.getAttribute('data-skin'),
  );
  expect(dataSkin).toBe('lcars');

  // Antonio silkscreen font hook is active + the stylesheet is injected.
  expect(await readVar(page, '--font-silkscreen')).toMatch(/Antonio/);
  const linkHrefs = await page.evaluate(() =>
    Array.from(document.head.querySelectorAll('link[data-skin-font]')).map(
      (l) => (l as HTMLLinkElement).href,
    ),
  );
  expect(linkHrefs.some((h) => h.includes('Antonio'))).toBe(true);

  // localStorage round-trip.
  const stored = await page.evaluate(() => localStorage.getItem('pt.skin'));
  expect(stored).toBe('lcars');
});

test('lcars: choice survives a reload', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('skin-switcher-trigger').click();
  await page.getByTestId('skin-option-lcars').click();
  await expect(page.getByTestId('skin-current-id')).toHaveText('lcars');

  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('skin-current-id')).toHaveText('lcars');
  expect(await readVar(page, '--bg')).toBe('#000000');
  expect(await readVar(page, '--module-radius')).toBe('22px');
});

test('lcars: switching back to default CLEARS the optional shape tokens', async ({ page }) => {
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await page.getByTestId('skin-switcher-trigger').click();
  await page.getByTestId('skin-option-lcars').click();
  await expect(page.getByTestId('skin-current-id')).toHaveText('lcars');
  expect(await readVar(page, '--module-radius')).toBe('22px');

  // Switch back to default. The optional tokens must be REMOVED (not left
  // stale) so _module-card.css falls back to its legacy hard-edged values.
  await page.getByTestId('skin-switcher-trigger').click();
  await page.getByTestId('skin-option-default').click();
  await expect(page.getByTestId('skin-current-id')).toHaveText('default');
  expect(await readVar(page, '--module-radius')).toBe('');
  expect(await readVar(page, '--module-stripe-radius')).toBe('');
  expect(await readVar(page, '--module-glow')).toBe('');
  expect(await readVar(page, '--module-border-color')).toBe('');
  // Sprite + font hooks also clear (LCARS is a sprite skin; default isn't).
  expect(await readVar(page, '--control-style')).toBe('');
  expect(await readVar(page, '--font-silkscreen')).toBe('');
});

test('lcars: switching to LCARS does not disturb the other skins', async ({ page }) => {
  // Cross-check that activating LCARS then another skin produces that other
  // skin's expected palette — i.e. LCARS's vars don't leak across a switch.
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await page.getByTestId('skin-switcher-trigger').click();
  await page.getByTestId('skin-option-lcars').click();
  await expect(page.getByTestId('skin-current-id')).toHaveText('lcars');

  // Switch to DINER — its palette + tokens should be exactly DINER's, with no
  // residual LCARS amber.
  await page.getByTestId('skin-switcher-trigger').click();
  await page.getByTestId('skin-option-diner').click();
  await expect(page.getByTestId('skin-current-id')).toHaveText('diner');
  expect(await readVar(page, '--bg')).toBe('#0a0420');
  expect(await readVar(page, '--accent')).toBe('#ff2fd0');
  expect(await readVar(page, '--module-border-color')).toBe('#c46af0');

  // Switch to a CSS-only skin (terminal-green) — optional tokens must clear.
  await page.getByTestId('skin-switcher-trigger').click();
  await page.getByTestId('skin-option-terminal-green').click();
  await expect(page.getByTestId('skin-current-id')).toHaveText('terminal-green');
  expect(await readVar(page, '--bg')).toBe('#000000'); // terminal-green's black
  expect(await readVar(page, '--text')).toBe('#7fff7f');
  expect(await readVar(page, '--module-radius')).toBe('');
  expect(await readVar(page, '--control-style')).toBe('');
  expect(await readVar(page, '--font-silkscreen')).toBe('');
});
