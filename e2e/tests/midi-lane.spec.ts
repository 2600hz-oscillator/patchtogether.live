// e2e/tests/midi-lane.spec.ts
//
// MIDI LANE end-to-end coverage. The full MIDI demux path (channel filter,
// CC taps, by-note gate, poly chord) is unit-tested in
// packages/web/src/lib/audio/modules/midi-lane.test.ts by mocking
// requestMIDIAccess; the per-module-per-port sweep drives the note + CC
// outputs through the cross-domain bridge into a SCOPE. Here we assert the
// card-level UX a unit test can't see:
//   1. The module spawns + the card mounts with no console errors, and
//      exposes the lane's output port handles.
//   2. The "Connect MIDI…" button is present + interactive before grant.
//   3. Clicking Connect doesn't crash (either grant → device dropdown, or
//      reject → permission hint).

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('midi-lane: drop module → card mounts with no console errors + output handles present', async ({ page, rack, errorWatch }) => {
  await spawnPatch(page, [{ id: 'm', type: 'midiLane', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-midiLane');
  await expect(card).toBeVisible();
  await expect(card.locator('[data-testid="name-label-button"]')).toHaveText(/^MIDILANE(\d+)?$/);
  // The core (always-present) output handles render on the card.
  for (const portId of ['pitch_cv', 'gate', 'velocity_cv', 'cc_a', 'cc_b', 'note_gate']) {
    await expect(card.locator(`[data-handleid="${portId}"]`)).toHaveCount(1);
  }
});

test('midi-lane: Connect MIDI… button is visible + interactive', async ({ page, rack }) => {
  await spawnPatch(page, [{ id: 'm', type: 'midiLane', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-midiLane');
  await expect(card).toBeVisible();
  const btn = card.getByRole('button', { name: /Connect MIDI/ });
  await expect(btn).toBeVisible();
  await expect(btn).toBeEnabled();
});

test('midi-lane: clicking Connect does not crash the card', async ({ page, rack, errorWatch }) => {
  await spawnPatch(page, [{ id: 'm', type: 'midiLane', position: { x: 200, y: 200 } }]);
  const card = page.locator('.svelte-flow__node-midiLane');
  await expect(card).toBeVisible();
  const btn = card.getByRole('button', { name: /Connect MIDI/ });
  await btn.click();
  await page.waitForTimeout(300);
  await expect(card).toBeVisible();
  await expect(card.locator('[data-testid="name-label-button"]')).toHaveText(/^MIDILANE(\d+)?$/);
});
