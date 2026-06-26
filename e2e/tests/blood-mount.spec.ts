// e2e/tests/blood-mount.spec.ts
//
// LIVE smoke coverage that the BLOOD video module spawns + its card mounts
// cleanly, and that its idle GL surface (the "no signal" shader) paints
// without a page error.
//
// CI-SAFE SCOPE (capability-dependent-e2e lesson): Blood game data
// (BLOOD.RFF/GUI.RFF/SOUNDS.RFF/TILES000.ART) is user-supplied + gitignored +
// NOT redistributable, so it is ABSENT on CI. We therefore assert ONLY the
// data-independent invariants:
//   - the card mounts (ownerOnly + maxInstances:1, lone-host rack),
//   - the GL surface compiles + draws the idle shader (no pageerror),
//   - clicking "Load BLOOD" reaches the graceful "data missing" overlay
//     rather than crashing.
// We deliberately DO NOT assert a rendered game frame (it requires the
// non-redistributable RFFs + the WASM blob, which CI doesn't have). A frame
// assertion belongs in a local/manual run with owned data (the harness at
// packages/web/native/nblood/blood-frame-harness.mjs does exactly that).

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test('BLOOD card mounts + idle surface paints without a page error', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const bloodId = 'blood-mount-smoke';
  await spawnPatch(
    page,
    [{ id: bloodId, type: 'blood', position: { x: 120, y: 80 }, domain: 'video' }],
    [],
  );

  // The card mounts (we're the lone host of a single-user rack, so the
  // ownerOnly gate is satisfied).
  const card = page.locator('[data-card-type="blood"]').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await expect(page.getByTestId('blood-card')).toBeVisible();

  // Idle state shows the Load affordance (no data loaded yet).
  await expect(page.getByTestId('blood-load')).toBeVisible();

  // Clicking Load must reach a DEFINITE terminal state — either the graceful
  // "data missing" overlay (the expected CI outcome: no RFFs present) or, if a
  // tester DID supply data + built the WASM, the running state. Either is a
  // clean, non-crashing outcome; what we forbid is a stuck "loading" or a
  // thrown page error.
  await page.getByTestId('blood-load').click();
  await expect
    .poll(
      async () => {
        const error = await page.getByTestId('blood-error').isVisible().catch(() => false);
        const ready = await page.getByTestId('blood-ready').isVisible().catch(() => false);
        return error || ready;
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  // No uncaught page error from spawning the module, compiling its shader, or
  // the load attempt — the data-missing path is handled, not thrown.
  expect(errors, `unexpected page errors:\n${errors.join('\n')}`).toEqual([]);
});
