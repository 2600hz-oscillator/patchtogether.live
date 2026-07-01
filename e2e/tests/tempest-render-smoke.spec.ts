// e2e/tests/tempest-render-smoke.spec.ts
//
// TEMPEST P1 render-smoke — the real source→render chain on the (CI) SwiftShader
// renderer. Spawn the generator alone (it needs no video input), step the engine
// a FIXED few frames synchronously, and assert its `out` FBO is non-black,
// spatially structured (the additive vector well — rim/lane lines + claw), and
// GL-error-free. Deliberately SwiftShader-FRUGAL (few steps, renderer-tolerant
// floors, no fps gate) per the composite-spike lesson; the geometry math itself
// is covered GL-free by tempest-core.test.ts + tempest.test.ts.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks, stepAndReadStats, assertRenderStats } from './_render-smoke';

const FIXED_STEPS = 4;

test('TEMPEST — vector well renders non-black + structured (deterministic smoke)', async ({ page }) => {
  test.setTimeout(60_000);
  await installRenderSmokeHooks(page);
  await page.goto('/rack');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [{ id: 'tp', type: 'tempest', position: { x: 120, y: 120 }, domain: 'video', params: { rim: 0, shape: 0 } }],
    [],
  );
  await expect(page.locator('[data-testid="tempest-card"]'), 'card mounted').toHaveCount(1);

  const stats = await stepAndReadStats(page, { nodeId: 'tp', steps: FIXED_STEPS });
  // Vector lines are sparse vs a fullscreen fill → use modest floors (renderer-
  // tolerant). The well + claw guarantee SOME lit pixels with spatial variance.
  assertRenderStats(stats, FIXED_STEPS, { minNonZeroFrac: 0.001, minVariance: 1 });
});
