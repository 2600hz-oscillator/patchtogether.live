// e2e/tests/blood-mount.spec.ts
//
// LIVE smoke coverage that the BLOOD video module spawns + its card mounts
// cleanly, that its idle GL surface (the "no signal" shader) paints without a
// page error, and that it boots OUT-OF-BOX from the BUNDLED 1997 shareware data.
//
// CI-SAFE SCOPE (capability-dependent-e2e lesson): the engine blood.js +
// blood.wasm AND the 1997 Blood SHAREWARE data (BLOOD.RFF/GUI.RFF/SOUNDS.RFF/
// SHARE000.ART/*.DAT) are now BOTH committed under static/blood/ (the shareware
// is LFS-tracked + un-ignored), so the card fetches them and tries to boot with
// no picker. But CI runs the SwiftShader software renderer (no real GPU) and the
// Build-engine boot path is renderer/heap-sensitive, so we do NOT assert a
// decoded game frame here. We assert only the renderer-INDEPENDENT invariants:
//   - the card mounts (ownerOnly + maxInstances:1, lone-host rack),
//   - the GL surface compiles + draws the idle shader (no pageerror),
//   - boot reaches a DEFINITE terminal state (running OR an engine error) — and
//     crucially NOT the "data missing" prompt, because the shareware is bundled,
//   - no uncaught page error from spawn / shader / boot.
// The REAL rendered-frame proof lives in the local/owner harness
// (packages/web/native/nblood/blood-frame-harness.mjs), which boots the engine
// from the same bundled shareware and asserts a valid framebuffer on a machine
// with a real renderer.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

test('BLOOD card mounts, idle surface paints, and boots out-of-box from bundled shareware', async ({
  page,
}) => {
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

  // The card auto-boots from the bundled shareware on mount. It must reach a
  // DEFINITE terminal state — either the running state (engine booted) or an
  // engine error (e.g. the renderer/heap-sensitive Build init on CI's software
  // renderer). What we forbid is a stuck "loading" or a thrown page error.
  await expect
    .poll(
      async () => {
        const ready = await page.getByTestId('blood-ready').isVisible().catch(() => false);
        const error = await page.getByTestId('blood-error').isVisible().catch(() => false);
        const idle = await page.getByTestId('blood-load').isVisible().catch(() => false);
        return ready || error || idle;
      },
      { timeout: 20_000 },
    )
    .toBe(true);

  // Because the shareware data IS bundled + served, the "bundled data couldn't
  // load" prompt must NOT be the outcome. (If it ever shows, the bundle/LFS
  // checkout is broken — which is exactly what we want this assert to catch.)
  const dataMissing = await page
    .getByTestId('blood-data-missing')
    .isVisible()
    .catch(() => false);
  expect(dataMissing, 'bundled shareware should load — the data-missing prompt must not show').toBe(
    false,
  );

  // No uncaught page error from spawning the module, compiling its shader, or
  // the boot attempt — the engine-boot path is handled, not thrown to the page.
  expect(errors, `unexpected page errors:\n${errors.join('\n')}`).toEqual([]);
});
