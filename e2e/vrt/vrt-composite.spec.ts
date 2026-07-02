// e2e/vrt/vrt-composite.spec.ts
//
// Composite-state VRT — captures a screenshot of TWO module cards in the
// same scene, wired with a patch cord, with the upstream module driving
// the downstream module into a deterministic state. Iterates the scenes
// declared in `vrt-composite-scenes.ts`.
//
// First composite category: NIBBLES.length_cv → SCOPE.ch1 at 5 CV levels
// (min / 25% / 50% / 75% / max). Each level is a separate scene + baseline,
// so the 5 PNGs together form a sweep that visually proves the CV value
// arriving at SCOPE's ch1 input — the trace's Y position is the CV value.
// (An earlier draft used QBRT, but QBRT's visible cutoff slider reflects
// the dialed value not the modulated AudioParam, so the screenshots were
// identical; SCOPE's trace literally IS the CV, making this a real gate.)
//
// The hook used to pin the CV value (`__nibblesForceLength`) is implemented
// in packages/web/src/lib/video/modules/nibbles.ts and unit-tested in
// nibbles.test.ts. It overrides ONLY the CV path; the visible game render
// + the audible square-wave output stay tied to live game state by design
// (we don't fake those — only the CV emit).
//
// Output:
//   e2e/vrt/__screenshots__/vrt-composite.spec.ts/{platform}/<id>.png
//
// Coverage: the screenshot bounds cover BOTH cards plus the cable between
// them — Playwright's full-page mode at the pinned VRT viewport
// (1280×720) is wide enough to fit both at the x=80 + x=560 positions.

import { test, expect } from '@playwright/test';
import { COMPOSITE_VRT_SCENES } from './vrt-composite-scenes';
import { EXEMPT_BASELINE_PAIRS } from './vrt-exemptions';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

test.describe.configure({ mode: 'default' });

test.describe('VRT: composite-state scenes', () => {
  for (const scene of COMPOSITE_VRT_SCENES) {
    test(`${scene.id} matches baseline`, async ({ page }) => {
      test.skip(
        EXEMPT_BASELINE_PAIRS.has(`${VRT_PLATFORM}/${scene.id}`),
        `${scene.id} on ${VRT_PLATFORM}: baseline pending (see EXEMPT_BASELINE_PAIRS)`,
      );
      // darwinOnly scenes can't reliably reproduce their deterministic baseline
      // under CI's headless/SwiftShader environment (e.g. the ADSR scope
      // analyser settle) — capture/compare on darwin, skip cleanly on linux.
      test.skip(
        scene.darwinOnly === true && VRT_PLATFORM === 'linux',
        `${scene.id}: darwin-only scene (skipped on linux — see CompositeVrtScene.darwinOnly)`,
      );

      // Capture page errors so a broken card fails the test BEFORE the
      // screenshot diff does — easier to debug than a thousand-pixel diff
      // from a black canvas.
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });

      await page.goto('/rack');
      await page.waitForLoadState('networkidle');

      await scene.setup(page);

      // Each scene's cards must be visible before we snap. Default to the
      // original NIBBLES→SCOPE pair when the scene doesn't declare its own.
      const cardSelectors = scene.cardSelectors ?? [
        '.svelte-flow__node-nibbles',
        '.svelte-flow__node-scope',
      ];
      for (const sel of cardSelectors) {
        await page.locator(sel).first().waitFor({ state: 'visible', timeout: 10_000 });
      }

      // One more rAF after both cards land so any post-mount layout shift
      // settles (Svelte $effects fire async to DOM attach).
      await page.evaluate(
        () => new Promise<void>((r) => requestAnimationFrame(() => r())),
      );

      // We capture the whole VRT viewport (1280×720) — frames BOTH cards
      // + the cable, which is the whole point of a composite snapshot.
      // The Svelte Flow background is deterministic given the pinned
      // viewport + reducedMotion + animations:disabled from vrt.config.ts.
      await expect(page).toHaveScreenshot(`${scene.id}.png`, {
        maskColor: '#ff00ff',
        fullPage: false,
      });

      // Filter out the AudioContext "user-gesture" warning that fires
      // before the engine's resume — it's a Chromium-only diagnostic, not
      // a test failure.
      expect(
        errors.filter((e) => !e.includes('AudioContext')),
        `${scene.id}: no console / page errors`,
      ).toEqual([]);
    });
  }
});
