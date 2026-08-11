// e2e/vrt/topbar.spec.ts
//
// Visual-regression baseline for the app TOPBAR — the brand heading
// ("patchtogether v<version>") plus the full button layout: the preset-slot bar
// (5 numbered slots + Save Set / Load Set) and the actions cluster (New rack,
// Clear, Export/Load Perf (.zip), Raw JSON, aspect / skin, Sign in). The module
// palette opens via canvas right-click, not a topbar button (removed by the
// 1024px topbar-overflow fix).
//
// The VERSION TEXT is MASKED — its `[data-testid="app-version"]` box is filled
// with magenta in BOTH baseline and actual before the diff — so a version bump
// (the digits change) never trips this snapshot. Only a real change to the
// brand text or the button set/layout does. (A version string that changes
// LENGTH shifts the preset bar; the actions cluster is right-anchored and stays
// put. Such a length change is rare and the owner previews the VRT diff, then
// re-captures via vrt-update.yml — the mask covers the common same-length bump.)
//
// Baseline: e2e/vrt/__screenshots__/topbar.spec.ts/topbar-heading-buttons.png
//
// The full `vrt` lane is INFORMATIONAL (the strict gate is only vrt.spec.ts).
// Baselines are authored by LINUX CI — one set, no {platform} segment (see
// vrt.config.ts). `task vrt:commit` dispatches the capture; a local macOS run
// is a smoke test, not a capture.
// Until the PNG is committed the test SKIPS (and self-heals once it lands) —
// it NEVER fails for a missing baseline. Regeneration (`task vrt:update`, incl.
// the CI job) sets an update mode, so the skip is bypassed and the baseline is
// written.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

const BASELINE = join(
  import.meta.dirname,
  '__screenshots__',
  'topbar.spec.ts',
  'topbar-heading-buttons.png',
);

test.describe('VRT: topbar heading + button layout', () => {
  test('topbar heading + button layout matches baseline', async ({ page }) => {
    // Only skip in a NORMAL run when the baseline isn't committed yet. During a regen (`--update-snapshots` → 'all' | 'changed' | 'mixed')
    // do NOT skip, so the baseline is actually generated.
    const updating = ['all', 'changed', 'mixed'].includes(
      test.info().config.updateSnapshots,
    );
    test.skip(
      !updating && !existsSync(BASELINE),
      'topbar VRT baseline not committed yet — dispatch vrt-update.yml (`task vrt:commit`)',
    );

    // Pin the topbar chrome text (h1 + all button/select labels) to the bundled
    // Inter / JetBrains Mono faces BEFORE first paint so the heading + buttons
    // rasterise byte-identically on every platform/run. Without it the topbar
    // glyphs resolve via the runner's fontconfig to whatever sans is installed
    // (not stable run-to-run) — the documented VRT text-metric flake. See
    // e2e/vrt/_fonts.ts for the full root-cause writeup.
    await pinVrtFonts(page);
    // The overflow-fixed topbar is the CANVAS topbar (Canvas.svelte), on /rack
    // since the landing move (#995); `/` is the static landing (no rack topbar).
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await awaitVrtFonts(page);

    // `header.topbar` was the SECOND shell's bar and no longer exists in the
    // DOM at all — this scene re-targets the one topbar rather than being
    // deleted, because "the topbar renders and does not overflow" is still the
    // thing worth a baseline.
    const topbar = page.locator('header.workflow-topbar').first();
    await topbar.waitFor({ state: 'visible', timeout: 10_000 });

    // Wait until the actions cluster is mounted. (This used to wait on the
    // "Load example…" select leaving its transient "Loading…" placeholder — the
    // one topbar label whose WIDTH changed after boot. That control is gone;
    // every remaining label is a static string, and the height-settle loop
    // below is now the whole settle gate.)
    await expect(page.getByTestId('workflow-file-trigger')).toBeVisible({
      timeout: 15_000,
    });

    // Settle: hold until the topbar box height is stable for 3 consecutive
    // frames so a late $effect reflow can't bake a half-settled frame into the
    // baseline (the documented 1px-layout-rounding VRT flake — see vrt.spec.ts).
    await topbar.evaluate(
      (el) =>
        new Promise<void>((resolve) => {
          let lastH = -1;
          let stable = 0;
          const tick = () => {
            const h = Math.round(el.getBoundingClientRect().height);
            if (h === lastH) {
              if (++stable >= 3) return resolve();
            } else {
              stable = 0;
              lastH = h;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );

    await expect(topbar).toHaveScreenshot('topbar-heading-buttons.png', {
      // Mask ONLY the version text so version bumps don't churn the baseline;
      // the brand word + every button stays in the diff. Playwright fills the
      // masked box with maskColor in both baseline + actual before diffing.
      mask: [page.getByTestId('app-version')],
      maskColor: '#ff00ff',
    });
  });
});
