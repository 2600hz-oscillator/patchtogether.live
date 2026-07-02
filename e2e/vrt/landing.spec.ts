// e2e/vrt/landing.spec.ts
//
// VRT snapshot of the static landing / front door at `/` (Phase 2 of the
// landing-page overhaul). The landing is fully static — prerendered, no
// AudioContext, no auth read, no animation — so the capture is deterministic.
//
// Two determinism guards specific to this page:
//   - The `v{version}` stamp reads `vdev` locally and `vX.Y.Z` on CI, so it is
//     MASKED (maskColor magenta) — version churn must never touch the pixel
//     budget.
//   - The header / footer orb bands are STATIC CSS-mask slices of committed
//     PNGs (image-rendering:pixelated, no flicker); we wait for those images to
//     decode before capturing.
//
// Per-platform baselines (see vrt.config.ts snapshotPathTemplate). Only the
// darwin baseline is committed from local dev; the linux baseline is captured
// by the vrt-update.yml workflow_dispatch on CI and is EXEMPT here until then
// (the recorderbox/dashboard new-baseline pattern).

import { test, expect, type Page } from '@playwright/test';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

const EXEMPT_BASELINE_PAIRS = new Set<string>(['linux/landing']);
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
      .cursor, .awareness-cursor, .selection-rect { display: none !important; }
      .feedback-bug { display: none !important; }
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
      }
    `,
  });
}

/** Wait until the two orb-band background PNGs have decoded, so the bands are
 *  painted (not blank) when we capture. They're referenced by CSS
 *  background-image, so networkidle already fetched them; this decode wait is
 *  belt-and-suspenders against a paint race. */
async function awaitBandImages(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const urls = ['/landing/sun.png', '/landing/invert.png'];
    await Promise.all(
      urls.map((u) => {
        const img = new Image();
        img.src = u;
        return img.decode().catch(() => undefined);
      }),
    );
  });
}

/** Settle until the document height is stable across two frames — guards the
 *  known ±1px fractional-height scanline flake (memory
 *  vrt-flake-1px-layout-rounding) on this text-heavy page. */
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

test.describe.configure({ mode: 'default' });

test('landing: static front door', async ({ page }) => {
  skipIfNoBaseline(test, 'landing');
  // Pin the bundled Inter face BEFORE first paint so the brand / hero / tile
  // glyphs resolve deterministically (same #598 fix the card sweep uses).
  await pinVrtFonts(page);
  await page.goto('/');
  // The landing wraps its content in `.docs-root`, which house.css makes a
  // FIXED full-viewport scroll container — so `fullPage` can't grow past the
  // viewport. Size the viewport tall enough to show the WHOLE front door
  // (content is ~1190px at 1280 wide; the band heights are vw-based, so a
  // taller viewport doesn't change content height) and capture the viewport.
  await page.setViewportSize({ width: 1280, height: 1220 });
  await page.waitForLoadState('networkidle');
  await awaitVrtFonts(page);
  await awaitBandImages(page);
  await hideJitterers(page);

  // The tiles are the last thing to lay out; wait for them + a stable height.
  await page.getByTestId('landing-tiles').waitFor({ state: 'visible', timeout: 10_000 });
  await awaitStableHeight(page);
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

  await expect(page).toHaveScreenshot('landing.png', {
    // The tall viewport above already shows the whole page (the fixed
    // .docs-root fills it), so a viewport capture IS the full front door.
    fullPage: false,
    // Version stamp churns (vdev local / vX.Y.Z on CI) — mask it out.
    mask: [page.locator('[data-testid="app-version"]')],
    maskColor: '#ff00ff',
  });
});
