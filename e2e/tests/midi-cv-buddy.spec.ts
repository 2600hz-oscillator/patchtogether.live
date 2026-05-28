// e2e/tests/midi-cv-buddy.spec.ts
//
// MIDI-CV-BUDDY end-to-end coverage. Without a real MIDI device (or a
// Playwright fake-device flag for Web MIDI — there isn't one), we can't
// drive the full event path here. What we CAN assert:
//   1. The module spawns + the card mounts with no console errors.
//   2. The "Connect MIDI…" button is present + interactive in the
//      no-permission-yet state.
//   3. Clicking the button does not crash — Web MIDI access either
//      resolves (Chromium grants permission with no real device, in
//      which case the device dropdown becomes visible) or rejects
//      (the button stays + a "permission denied" hint shows).
//
// A real-device functional test is a known follow-up. The MIDI math +
// voice priority + retrig + bend mapping all have unit coverage in
// packages/web/src/lib/audio/modules/midi-cv-buddy.test.ts.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('midi-cv-buddy: drop module → card mounts with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'm', type: 'midiCvBuddy', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-midiCvBuddy');
  await expect(card).toBeVisible();
  // Card now shows the bare-prefix auto-name (MIDICVBUDDY) — the def's
  // `MIDI-CV-BUDDY` label is no longer rendered in the title bar because
  // the editable name button takes precedence over `defaultLabel` once
  // `migrateAssignNames` runs at spawn (see $lib/multiplayer/module-naming.ts).
  await expect(card.locator('[data-testid="name-label-button"]')).toHaveText(/^MIDICVBUDDY(\d+)?$/);
  expect(errors, errors.join('; ')).toEqual([]);
});

test('midi-cv-buddy: Connect MIDI… button is visible + interactive', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'm', type: 'midiCvBuddy', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-midiCvBuddy');
  await expect(card).toBeVisible();
  // The button text contains an ellipsis ("Connect MIDI…") — match
  // substring to be ellipsis-agnostic.
  const btn = card.getByRole('button', { name: /Connect MIDI/ });
  await expect(btn).toBeVisible();
  await expect(btn).toBeEnabled();
});

test('midi-cv-buddy: clicking Connect does not crash the card', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await spawnPatch(page, [{ id: 'm', type: 'midiCvBuddy', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-midiCvBuddy');
  await expect(card).toBeVisible();
  const btn = card.getByRole('button', { name: /Connect MIDI/ });
  // Browsers without Web MIDI (or without a granted permission) will
  // reject the request — the card should swallow the rejection and
  // surface the "permission-denied" hint rather than throwing.
  await btn.click();
  // Give the promise a tick to settle. Either outcome (connected /
  // permission-denied) is acceptable; both are non-crash states.
  await page.waitForTimeout(300);
  // The card is still visible and still bears the label — no unhandled
  // exception tore it down.
  await expect(card).toBeVisible();
  // Card now shows the bare-prefix auto-name (MIDICVBUDDY) — the def's
  // `MIDI-CV-BUDDY` label is no longer rendered in the title bar because
  // the editable name button takes precedence over `defaultLabel` once
  // `migrateAssignNames` runs at spawn (see $lib/multiplayer/module-naming.ts).
  await expect(card.locator('[data-testid="name-label-button"]')).toHaveText(/^MIDICVBUDDY(\d+)?$/);
  // No unhandled pageerror / console.error along the way.
  expect(errors, errors.join('; ')).toEqual([]);
});
