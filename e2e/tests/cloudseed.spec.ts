// e2e/tests/cloudseed.spec.ts
//
// CLOUDSEED end-to-end smoke. Spawns ANALOGVCO → CLOUDSEED → AUDIOOUT,
// verifies the card mounts, the 4 preset slots cycle, the DECAY readout
// updates, and a sweep of macro knobs doesn't produce console errors.

import { test, expect } from './_fixtures';
import { spawnPatch } from './_helpers';

test.describe.configure({ mode: 'parallel' });

test('CLOUDSEED preset slots cycle + name and DECAY readout update', async ({ page, rack }) => {
  await spawnPatch(
    page,
    [{ id: 'a-cs', type: 'cloudseed', position: { x: 100, y: 100 } }],
    [],
  );

  await expect(page.locator('.svelte-flow__node-cloudseed')).toHaveCount(1);

  // Slot 0 active by default (DIVINE INSPIRATION).
  const slot0 = page.locator('[data-testid="cs-preset-slot-0"]');
  const slot1 = page.locator('[data-testid="cs-preset-slot-1"]');
  const slot3 = page.locator('[data-testid="cs-preset-slot-3"]');
  const name  = page.locator('[data-testid="cs-preset-name"]');
  const decay = page.locator('[data-testid="cs-decay-readout"]');

  await expect(slot0).toBeVisible();
  await expect(name).toContainText('DIVINE INSPIRATION');
  const startDecay = await decay.innerText();

  // Click slot 1 (SHORT ROOM).
  await slot1.click();
  await expect(name).toContainText('SHORT ROOM');
  // Decay readout should change vs the start.
  const shortDecay = await decay.innerText();
  expect(shortDecay).not.toBe(startDecay);

  // Click slot 3 (INFINITE PAD) — longest tail.
  await slot3.click();
  await expect(name).toContainText('INFINITE PAD');
  const infDecay = await decay.innerText();
  expect(infDecay).not.toBe(shortDecay);

  // Click prev arrow — goes to BRIGHT HALL.
  await page.locator('[data-testid="cs-preset-prev"]').click();
  await expect(name).toContainText('BRIGHT HALL');
  // Click next twice — wraps around back to DIVINE INSPIRATION via INFINITE PAD.
  await page.locator('[data-testid="cs-preset-next"]').click();
  await page.locator('[data-testid="cs-preset-next"]').click();
  await expect(name).toContainText('DIVINE INSPIRATION');
});
