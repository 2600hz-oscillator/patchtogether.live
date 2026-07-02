// e2e/vrt/skin-lcars.spec.ts
//
// Skin-level VRT for the LCARS skin — like skin-diner.spec.ts, one of the few
// VRTs we capture per-skin (the per-module vrt.spec.ts always runs under the
// default skin). LCARS is worth a pixel baseline because it adds visual
// surfaces the other skins don't have, pushed further than DINER:
//   - MAXIMUM card-corner radius (--module-radius 22px) → fully-rounded pill
//   - an amber LCARS neon-tube border + warm outer glow (--module-glow +
//     --module-border-color)
//   - sprite fader handles (rounded amber pills) + a black/amber panel texture
//   - the Antonio condensed-grotesque signage label font (uppercase, lit)
//   - pure-black void background
//
// We spawn a representative card (VCA — it has both a unipolar + a bipolar
// fader, so the sprite handles + 0V hash are exercised), activate LCARS via
// the SkinSwitcher, wait for the web font to settle, and snapshot the card.
//
// Path template + per-platform layout follow vrt.config.ts. This dev machine
// is darwin-only, so the linux baseline is deferred via EXEMPT_BASELINE_PAIRS
// here (regenerate via `task vrt:update` inside docker on a linux runner and
// remove the entry).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';

const EXEMPT_BASELINE_PAIRS = new Set<string>([
  // darwin captured on this dev machine; linux pending a CI `task vrt:update`.
  'linux/lcars-card',
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

test('lcars-card: VCA card under the LCARS skin (rounded pill + amber glow + sprite faders)', async ({
  page,
}) => {
  skipIfNoBaseline(test, 'lcars-card');

  await page.goto('/rack');
  await page.waitForLoadState('networkidle');
  await hideJitterers(page);

  await spawnPatch(
    page,
    [{ id: 'vrt-1', type: 'vca', position: { x: 100, y: 100 } }],
    [],
  );
  const card = page.locator('.svelte-flow__node-vca').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });

  // Activate LCARS via the switcher (drives the real applySkinToRoot path:
  // palette + optional shape tokens + sprite vars + font link).
  await page.getByTestId('skin-switcher-trigger').click();
  await page.getByTestId('skin-option-lcars').click();
  await expect(page.getByTestId('skin-current-id')).toHaveText('lcars');

  // Wait for the Antonio web font to load so the label glyphs are stable in
  // the baseline (otherwise we'd snap a fallback-font frame on a cold cache
  // and the real font frame on a warm one).
  await page.evaluate(async () => {
    try {
      await (document as Document & { fonts?: FontFaceSet }).fonts?.ready;
    } catch {
      /* fonts API absent — ignore */
    }
  });
  // Settle two rAFs after the skin swap (sprite handles re-render + the
  // amber glow box-shadow paints).
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

  // Sanity: sprite handles are actually live before we snap.
  await expect(
    card.locator('[data-testid="fader-handle-sprite"]').first(),
  ).toBeVisible();

  await expect(card).toHaveScreenshot('lcars-card.png');
});
