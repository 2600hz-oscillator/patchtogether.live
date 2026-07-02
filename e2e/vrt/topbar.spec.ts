// e2e/vrt/topbar.spec.ts
//
// Visual-regression baseline for the app TOPBAR — the brand heading
// ("patchtogether v<version>") plus the full button layout: the preset-slot bar
// (5 numbered slots + Save Set / Load Set) and the actions cluster (Load
// example…, Clear, Export/Load Perf (.zip), Raw JSON, aspect / skin / Electra,
// Sign in). The module palette opens via canvas right-click, not a topbar
// button (removed by the 1024px topbar-overflow fix).
//
// The VERSION TEXT is MASKED — its `[data-testid="app-version"]` box is filled
// with magenta in BOTH baseline and actual before the diff — so a version bump
// (the digits change) never trips this snapshot. Only a real change to the
// brand text or the button set/layout does. (A version string that changes
// LENGTH shifts the preset bar; the actions cluster is right-anchored and stays
// put. Such a length change is rare and the owner previews the VRT diff, then
// re-captures via vrt-update.yml — the mask covers the common same-length bump.)
//
// Baseline: e2e/vrt/__screenshots__/topbar.spec.ts/{platform}/topbar-heading-buttons.png
//
// The full `vrt` lane is INFORMATIONAL (the strict gate is only vrt.spec.ts).
// The darwin baseline is captured locally; the linux baseline lands via a
// `vrt-update.yml` workflow_dispatch. Until a platform's PNG is committed, the
// test SKIPS on that platform (and self-heals once it lands) — it NEVER fails
// for a missing baseline. Regeneration (`task vrt:update`, incl. the CI job)
// sets an update mode, so the skip is bypassed and the baseline is written.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

const PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';
const BASELINE = join(
  import.meta.dirname,
  '__screenshots__',
  'topbar.spec.ts',
  PLATFORM,
  'topbar-heading-buttons.png',
);

test.describe('VRT: topbar heading + button layout', () => {
  test('topbar heading + button layout matches baseline', async ({ page }) => {
    // Only skip in a NORMAL run when this platform's baseline isn't committed
    // yet. During a regen (`--update-snapshots` → 'all' | 'changed' | 'mixed')
    // do NOT skip, so the baseline is actually generated.
    const updating = ['all', 'changed', 'mixed'].includes(
      test.info().config.updateSnapshots,
    );
    test.skip(
      !updating && !existsSync(BASELINE),
      `topbar VRT baseline for ${PLATFORM} not committed yet — dispatch vrt-update.yml (see PR notes)`,
    );

    // Pin the topbar chrome text (h1 + all button/select labels) to the bundled
    // Inter / JetBrains Mono faces BEFORE first paint so the heading + buttons
    // rasterise byte-identically on every platform/run. Without it the topbar
    // glyphs resolve via the runner's fontconfig to whatever sans is installed
    // (not stable run-to-run) — the documented VRT text-metric flake. See
    // e2e/vrt/_fonts.ts for the full root-cause writeup.
    await pinVrtFonts(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await awaitVrtFonts(page);

    const topbar = page.locator('header.topbar').first();
    await topbar.waitFor({ state: 'visible', timeout: 10_000 });

    // Wait until boot finishes so the "Load example…" select shows its final
    // (enabled) label rather than the transient "Loading…" placeholder.
    await expect(page.getByTestId('load-example-select')).toBeEnabled({
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
