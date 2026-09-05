// e2e/vrt/dashboard.spec.ts
//
// Public/unauthed scratch-canvas snapshot. `/rack?seed=none` is the scratch canvas
// (moved off `/` in the landing-page overhaul; `/` is now the static
// landing). `/dashboard` redirects to /sign-in for anon users, so a
// signed-out "dashboard" shot would just be the sign-in page. The
// canvas-empty shot catches topbar / SkinSwitcher / bottombar chrome
// regressions, which is the actual user-visible signed-out surface. The
// baseline name stays `landing-empty` (the canvas chrome is route-
// independent, so the darwin pixels are unchanged by the move).
//
// Baselines are authored by LINUX CI — one set, no {platform} segment (see
// vrt.config.ts). `task vrt:commit` dispatches the capture; a local macOS run
// is a smoke test, not a capture.

import { test, expect, type Page } from '@playwright/test';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

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

test.describe.configure({ mode: 'default' });

test('landing-empty: public canvas with no modules', async ({ page }) => {
  // Pin the topbar chrome text (h1 / "Load example…" +
  // "Raw JSON" dropdowns / Clear / Export·Load Perf / skin switcher) to the
  // bundled Inter face
  // BEFORE first paint — same deterministic-font fix #598 applied to the
  // per-card sweep (vrt.spec.ts). Without it the topbar glyphs resolve via
  // the runner's fontconfig to whatever sans is installed, which is not
  // stable run-to-run and drifts the landing-empty baseline (esp. on the
  // ubuntu linux runner). See e2e/vrt/_fonts.ts for the full writeup.
  await pinVrtFonts(page);
  await page.goto('/rack?seed=none');
  await page.waitForLoadState('networkidle');
  await awaitVrtFonts(page);
  await hideJitterers(page);
  // Wait for the canvas root to render. Capture the viewport-scale shot
  // (Canvas is huge; only the topbar + canvas region + bottombar chrome
  // are visible at default viewport, which is what we care about anyway).
  const root = page.locator('[data-testid="canvas-root"]');
  await root.waitFor({ state: 'visible', timeout: 10_000 });
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => r())),
  );
  await expect(page).toHaveScreenshot('landing-empty.png', { fullPage: false });
});
