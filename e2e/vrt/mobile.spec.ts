// e2e/vrt/mobile.spec.ts
//
// VRT for the /m mobile prototype (spec §7): two scenes at the iPhone-ish
// 390×844 viewport — the synth PATCH tab (the pair matrix) and the MIX
// lanes. The cam route is all-canvas → skipped (nothing maskable remains).
//
// Determinism: pinVrtFonts before first paint, animations killed, the VU
// fader strips MASKED (post-fader meters animate with the running
// sequencer), and the landing.spec height-stability settle loop.
//
// Per-platform baselines: darwin committed from local dev
// (task vrt:update -- -g mobile); linux is EXEMPT until the vrt-update.yml
// workflow_dispatch captures it (the landing/dashboard new-baseline pattern).

import { test, expect, type Page } from '@playwright/test';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

const EXEMPT_BASELINE_PAIRS = new Set<string>([
  'linux/mobile-synth-patch',
  'linux/mobile-synth-mix',
]);
const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';

function skipIfNoBaseline(t: typeof test, name: string): void {
  t.skip(
    EXEMPT_BASELINE_PAIRS.has(`${VRT_PLATFORM}/${name}`),
    `${name} on ${VRT_PLATFORM}: baseline pending (CI capture follow-up)`,
  );
}

async function hideJitterers(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }
    `,
  });
}

/** Settle until the document height is stable across two frames — the ±1px
 *  fractional-height scanline guard (memory vrt-flake-1px-layout-rounding). */
async function awaitStableHeight(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let last = -1;
        const tick = () => {
          const h = document.documentElement.scrollHeight;
          if (h === last) {
            resolve();
            return;
          }
          last = h;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/** Boot the pocket modular to the FIRST BLEEP scene and land on a tab. */
async function bootSynth(page: Page, tab: 'patch' | 'mix'): Promise<void> {
  await pinVrtFonts(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/m/synth');
  await page.waitForLoadState('networkidle');
  await awaitVrtFonts(page);
  await page.getByTestId('m-first-bleep').click();
  await expect(page.getByTestId('m-tabbar')).toBeVisible({ timeout: 20_000 });
  // The boot toast is TRANSIENT (2.6s) — wait for it to APPEAR then VANISH
  // so the capture is timing-independent (a bare count-0 check can pass
  // before the toast has even mounted; never bake a toast into a baseline).
  await expect(page.getByTestId('m-toast')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('m-toast')).toHaveCount(0, { timeout: 10_000 });
  await page.getByTestId(`m-tab-${tab}`).click();
  await hideJitterers(page);
  await awaitStableHeight(page);
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
}

test.describe.configure({ mode: 'default' });

test('mobile synth: PATCH tab (pair matrix)', async ({ page }) => {
  skipIfNoBaseline(test, 'mobile-synth-patch');
  test.setTimeout(60_000);
  await bootSynth(page, 'patch');
  await expect(page.getByTestId('m-matrix-grid')).toBeVisible();
  await expect(page).toHaveScreenshot('mobile-synth-patch.png', {
    fullPage: false,
    // The transport BPM cluster is deterministic (118); nothing to mask in
    // the grid itself — cells are pure DOM driven by the template edges.
    maskColor: '#ff00ff',
  });
});

test('mobile synth: MIX lanes', async ({ page }) => {
  skipIfNoBaseline(test, 'mobile-synth-mix');
  test.setTimeout(60_000);
  await bootSynth(page, 'mix');
  await expect(page.getByTestId('m-mix-lane-1')).toBeVisible();
  await expect(page).toHaveScreenshot('mobile-synth-mix.png', {
    fullPage: false,
    // The fader strips carry LIVE post-fader VUs (the sequencer is running)
    // — mask every strip; labels/mutes/master chrome stay pixel-checked.
    mask: [page.locator('.lane-fader')],
    maskColor: '#ff00ff',
  });
});
