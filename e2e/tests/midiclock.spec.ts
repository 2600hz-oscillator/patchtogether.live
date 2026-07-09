// e2e/tests/midiclock.spec.ts
//
// MIDICLOCK end-to-end coverage. Same Web-MIDI constraint as the
// MIDI-CV-BUDDY spec: Playwright can't synthesize a MIDI clock stream,
// so the spec is limited to mount + Connect-button + no-crash. The
// divider math + System Real-Time parsing are covered in unit tests.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('midiclock: drop module → card mounts with no console errors', async ({ page, rack, errorWatch }) => {
  await spawnPatch(page, [{ id: 'mc', type: 'midiclock', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-midiclock');
  await expect(card).toBeVisible();
  await expect(card).toContainText('MIDICLOCK');
});

test('midiclock: Connect MIDI… button is visible + interactive', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'mc', type: 'midiclock', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-midiclock');
  await expect(card).toBeVisible();
  const btn = card.getByRole('button', { name: /Connect MIDI/ });
  await expect(btn).toBeVisible();
  await expect(btn).toBeEnabled();
});

test('midiclock: clicking Connect does not crash the card', async ({ page, rack, errorWatch }) => {
  await spawnPatch(page, [{ id: 'mc', type: 'midiclock', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-midiclock');
  await card.getByRole('button', { name: /Connect MIDI/ }).click();
  // The card MUST still be in the DOM. Whichever branch Web MIDI takes
  // (permission granted with empty device list, or rejection), neither
  // tears the card down.
  await expect(card).toBeVisible();
});

test('midiclock: card exposes the four documented output ports', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'mc', type: 'midiclock', position: { x: 200, y: 200 } }]);
  // Each output renders as a port-labelled row inside the patch panel. Under
  // the patch-menu redesign the labels live in the PORTALED chrome (appended to
  // <body>, only present when the menu is open) — NOT inline in the closed-card
  // DOM — so open the panel + drill into OUTPUT before asserting. The labels
  // come from the card's PortDescriptor list (CLK/RUN/START/STOP).
  await page
    .locator('.svelte-flow__node[data-id="mc"] [data-testid="patch-trigger"]')
    .click();
  const chrome = page.locator('[data-patch-panel-chrome="mc"]');
  await expect(chrome).toHaveAttribute('aria-hidden', 'false');
  await chrome.locator('[data-testid="patch-panel-nav"][data-nav="outputs"]').click();
  await expect(chrome).toContainText('CLK');
  await expect(chrome).toContainText('RUN');
  await expect(chrome).toContainText('START');
  await expect(chrome).toContainText('STOP');
});
