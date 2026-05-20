// e2e/tests/midiclock.spec.ts
//
// MIDICLOCK end-to-end coverage. Same Web-MIDI constraint as the
// MIDI-CV-BUDDY spec: Playwright can't synthesize a MIDI clock stream,
// so the spec is limited to mount + Connect-button + no-crash. The
// divider math + System Real-Time parsing are covered in unit tests.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('midiclock: drop module → card mounts with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'mc', type: 'midiclock', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-midiclock');
  await expect(card).toBeVisible();
  await expect(card).toContainText('MIDICLOCK');
  expect(errors, errors.join('; ')).toEqual([]);
});

test('midiclock: Connect MIDI… button is visible + interactive', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'mc', type: 'midiclock', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-midiclock');
  await expect(card).toBeVisible();
  const btn = card.getByRole('button', { name: /Connect MIDI/ });
  await expect(btn).toBeVisible();
  await expect(btn).toBeEnabled();
});

test('midiclock: clicking Connect does not crash the card', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'mc', type: 'midiclock', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-midiclock');
  await card.getByRole('button', { name: /Connect MIDI/ }).click();
  // The card MUST still be in the DOM. Whichever branch Web MIDI takes
  // (permission granted with empty device list, or rejection), neither
  // tears the card down.
  await expect(card).toBeVisible();
  expect(errors, errors.join('; ')).toEqual([]);
});

test('midiclock: card exposes the four documented output ports', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'mc', type: 'midiclock', position: { x: 200, y: 200 } }]);
  // Each output renders as a port-labelled element inside the patch panel.
  // The labels come from the card's PortDescriptor list.
  const card = page.locator('.svelte-flow__node-midiclock');
  await expect(card).toContainText('CLK');
  await expect(card).toContainText('RUN');
  await expect(card).toContainText('START');
  await expect(card).toContainText('STOP');
});
