// e2e/tests/theme-diner.spec.ts
//
// DINER skin smoke. DINER is the "fancy" vaporwave skin — the neon-sign
// sibling of Vintage. This spec verifies the new contract surfaces:
//   1. registered in the SkinSwitcher dropdown
//   2. applies its vaporwave palette on selection
//   3. sets the NEW optional shape tokens (--module-radius / --module-glow /
//      --module-border-color) that drive the curved corners + purple neon
//      border in _module-card.css
//   4. opts into sprite controls (controlStyle + panel/track vars) like Vintage
//   5. injects the Orbitron font stylesheet via the silkscreen-font hook
//   6. flips documentElement[data-skin] so the scoped neon-text-glow overlay
//      in global.css attaches
//   7. persists across reload (localStorage round-trip)
//   8. switching AWAY restores defaults — crucially the optional shape tokens
//      are CLEARED so the other skins fall back to their hard-edged look.
//
// Dedicated spec (rather than folding into skins.spec.ts) so the DINER
// contract — especially the new optional tokens — is testable in isolation.

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

test('diner: selectable from switcher + applies vaporwave palette + shape tokens', async ({ page, rack }) => {
  await page.getByTestId('skin-switcher-trigger').click();
  await expect(page.getByTestId('skin-switcher-popover')).toBeVisible();
  await expect(page.getByTestId('skin-option-diner')).toBeVisible();
  await page.getByTestId('skin-option-diner').click();

  await expect(page.getByTestId('skin-current-id')).toHaveText('diner');
  await expect(page.getByTestId('skin-current-label')).toHaveText('Diner');

  // Vaporwave palette wired through.
  expect(await readVar(page, '--bg')).toBe('#0a0420');
  expect(await readVar(page, '--accent')).toBe('#ff2fd0');
  expect(await readVar(page, '--text')).toBe('#f5e9ff');

  // NEW optional shape tokens — the curved-edges + neon-border contract.
  expect(await readVar(page, '--module-radius')).toBe('14px');
  expect(await readVar(page, '--module-glow')).toMatch(/rgba/);
  expect(await readVar(page, '--module-border-color')).toBe('#c46af0');

  // Sprite controls (like Vintage).
  expect(await readVar(page, '--control-style')).toBe('sprite');
  expect(await readVar(page, '--panel-bg')).toMatch(/^url\(/);
  expect(await readVar(page, '--fader-track-bg')).toMatch(/^url\(/);

  // data-skin attribute is the hook the scoped neon-text-glow overlay hangs off.
  const dataSkin = await page.evaluate(() =>
    document.documentElement.getAttribute('data-skin'),
  );
  expect(dataSkin).toBe('diner');

  // Orbitron silkscreen font hook is active + the stylesheet is injected.
  expect(await readVar(page, '--font-silkscreen')).toMatch(/Orbitron/);
  const linkHrefs = await page.evaluate(() =>
    Array.from(document.head.querySelectorAll('link[data-skin-font]')).map(
      (l) => (l as HTMLLinkElement).href,
    ),
  );
  expect(linkHrefs.some((h) => h.includes('Orbitron'))).toBe(true);

  // localStorage round-trip.
  const stored = await page.evaluate(() => localStorage.getItem('pt.skin'));
  expect(stored).toBe('diner');
});

test('diner: choice survives a reload', async ({ page, rack }) => {
  await page.getByTestId('skin-switcher-trigger').click();
  await page.getByTestId('skin-option-diner').click();
  await expect(page.getByTestId('skin-current-id')).toHaveText('diner');

  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('skin-current-id')).toHaveText('diner');
  expect(await readVar(page, '--bg')).toBe('#0a0420');
  expect(await readVar(page, '--module-radius')).toBe('14px');
});

test('diner: switching back to default CLEARS the optional shape tokens', async ({ page, rack }) => {
  await page.getByTestId('skin-switcher-trigger').click();
  await page.getByTestId('skin-option-diner').click();
  await expect(page.getByTestId('skin-current-id')).toHaveText('diner');
  expect(await readVar(page, '--module-radius')).toBe('14px');

  // Switch back to default. The optional tokens must be REMOVED (not left
  // stale) so _module-card.css falls back to its legacy hard-edged values.
  await page.getByTestId('skin-switcher-trigger').click();
  await page.getByTestId('skin-option-default').click();
  await expect(page.getByTestId('skin-current-id')).toHaveText('default');
  expect(await readVar(page, '--module-radius')).toBe('');
  expect(await readVar(page, '--module-stripe-radius')).toBe('');
  expect(await readVar(page, '--module-glow')).toBe('');
  expect(await readVar(page, '--module-border-color')).toBe('');
  // Sprite + font hooks also clear (DINER is a sprite skin; default isn't).
  expect(await readVar(page, '--control-style')).toBe('');
  expect(await readVar(page, '--font-silkscreen')).toBe('');
});

test('diner: the six pre-existing skins never set the optional shape tokens', async ({ page, rack }) => {
  // Defensive cross-check at the live-DOM layer: cycle each non-DINER skin
  // and assert the optional tokens stay UNSET, so their _module-card.css
  // fallbacks (hard corners, no glow) hold and their VRT baselines don't move.
  const others = ['terminal-green', 'brutalist', 'vaporwave', 'vintage', 'matrixcowboy', 'default'];
  for (const id of others) {
    await page.getByTestId('skin-switcher-trigger').click();
    await page.getByTestId(`skin-option-${id}`).click();
    await expect(page.getByTestId('skin-current-id')).toHaveText(id);
    expect(await readVar(page, '--module-radius')).toBe('');
    expect(await readVar(page, '--module-glow')).toBe('');
    expect(await readVar(page, '--module-border-color')).toBe('');
  }
});
