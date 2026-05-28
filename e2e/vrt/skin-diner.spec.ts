// e2e/vrt/skin-diner.spec.ts
//
// Skin-level VRT for the DINER skin — the only VRT we capture per-skin
// (the per-module vrt.spec.ts always runs under the default skin). DINER
// is the first skin whose look is worth a pixel baseline because it adds
// NEW visual surfaces the other skins don't have:
//   - curved card corners (--module-radius)
//   - a thin purple neon-tube border + soft outer glow (--module-glow +
//     --module-border-color)
//   - sprite fader handles + a vaporwave grid/scanline panel texture
//   - the Orbitron neon-signage label font
//
// We spawn a representative card (VCA — it has both a unipolar + a bipolar
// fader, so the sprite handles + 0V hash are exercised), activate DINER via
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
  'linux/diner-card',
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

test('diner-card: VCA card under the DINER skin (curved + neon glow + sprite faders)', async ({
  page,
}) => {
  skipIfNoBaseline(test, 'diner-card');

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await hideJitterers(page);

  await spawnPatch(
    page,
    [{ id: 'vrt-1', type: 'vca', position: { x: 100, y: 100 } }],
    [],
  );
  const card = page.locator('.svelte-flow__node-vca').first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });

  // Activate DINER via the switcher (drives the real applySkinToRoot path:
  // palette + optional shape tokens + sprite vars + font link).
  await page.getByTestId('skin-switcher-trigger').click();
  await page.getByTestId('skin-option-diner').click();
  await expect(page.getByTestId('skin-current-id')).toHaveText('diner');

  // Wait for the Orbitron web font to load so the label glyphs are stable
  // in the baseline (otherwise we'd snap a fallback-font frame on a cold
  // cache and the real font frame on a warm one).
  await page.evaluate(async () => {
    try {
      await (document as Document & { fonts?: FontFaceSet }).fonts?.ready;
    } catch {
      /* fonts API absent — ignore */
    }
  });
  // Settle two rAFs after the skin swap (sprite handles re-render + the
  // neon glow box-shadow paints).
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

  // Sanity: sprite handles + glow vars are actually live before we snap.
  await expect(
    card.locator('[data-testid="fader-handle-sprite"]').first(),
  ).toBeVisible();

  await expect(card).toHaveScreenshot('diner-card.png');
});
