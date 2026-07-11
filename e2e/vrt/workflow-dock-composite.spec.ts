// e2e/vrt/workflow-dock-composite.spec.ts
//
// VRT: the WORKFLOW bottom dock drawer with a docked card + its patch-to
// picker OPEN — pins the MENU POSITION visually (the owner-reported "patch
// to is a mess in terms of where the menu spawns": for a dock-hosted card
// the picker used to open at the (0,0) viewport origin instead of adjacent
// to the drawer card; see Canvas.cardRectFor's dock-frame resolution).
//
// PAGE-level capture (the cellshade-composite pattern) because the spatial
// relationship IS the assertion: the pinned CLIPPLAYER's drawer card at the
// bottom, its patch-panel chrome edge-aligned to the card frame, and the
// body-portaled patch-to picker clamped on-screen beside it. SvelteFlow
// floating chrome (controls / minimap / attribution) is hidden, and the
// footer's live status text (ctx/sr/lat + the trace counter) is masked.
//
// darwin-first: the darwin baseline is captured locally; the linux pair is
// EXEMPT_BASELINE_PAIRS-deferred until a vrt-update.yml dispatch lands it
// (vrt-meta's linux-deficit ratchet accounts for the pair).

import { test, expect, type Page } from '@playwright/test';
import { EXEMPT_BASELINE_PAIRS } from './vrt-exemptions';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';
test.describe.configure({ mode: 'default' });

/** Wait until the workflow ensure has written the pinned clipplayer. */
async function waitForClipplayerPin(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
      };
      return w.__patch?.nodes['pinned-clipplayer']?.data?.pinned === true;
    },
    undefined,
    { timeout: 15_000 },
  );
}

test.describe('VRT: workflow bottom drawer + patch-to picker', () => {
  test('docked clipplayer with its patch-to picker open matches baseline', async ({ page }) => {
    const id = 'workflow-dock-patch';
    test.skip(
      EXEMPT_BASELINE_PAIRS.has(`${VRT_PLATFORM}/${id}`),
      `${id} on ${VRT_PLATFORM}: baseline pending (see EXEMPT_BASELINE_PAIRS)`,
    );

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await pinVrtFonts(page);
    await page.goto('/rack?mode=workflow');
    await page.waitForLoadState('networkidle');
    await awaitVrtFonts(page);
    await waitForClipplayerPin(page);

    // Stable page capture: hide the floating flow chrome + kill animation
    // jitter (incl. the drawer flip-in / dock-flash keyframes).
    await page.addStyleTag({
      content:
        '.svelte-flow__minimap,.svelte-flow__controls,.svelte-flow__attribution,.minimap-toggle{display:none !important;}' +
        '*,*::before,*::after{animation:none !important;transition:none !important;}',
    });

    // Open the drawer on the pinned CLIPPLAYER (the C keymap), then drive
    // the real patch flow: trigger → OUTPUT → jack-click row → "patch to…".
    await page.locator('.flow .svelte-flow__pane').first().click({ position: { x: 500, y: 380 } });
    await page.keyboard.press('c');
    const drawer = page.getByTestId('dock-zone-bottom');
    await expect(drawer).toBeVisible();
    const card = drawer.locator('[data-dock-card="pinned-clipplayer"]');
    await expect(card).toBeVisible();

    await card.getByTestId('patch-trigger').click();
    const chrome = page.locator('[data-patch-panel-chrome="pinned-clipplayer"]');
    await expect(chrome).toBeVisible();
    await chrome.locator('[data-testid="patch-panel-nav"][data-nav="outputs"]').click();
    await chrome
      .locator('[data-testid="patch-panel-port-row"][data-direction="output"]')
      .first()
      .click();
    await chrome.getByTestId('patch-panel-patch-to').click();

    const picker = page.getByTestId('port-context-menu');
    await expect(picker).toBeVisible();

    // Settle: two rAFs so the post-mount clamp + edge-align land, then a
    // height-stability hold on the picker (the layout-rounding guard).
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
    await picker.evaluate(
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

    await expect(page).toHaveScreenshot(`${id}.png`, {
      mask: [
        // Live status text (ctx/sr/lat readouts + the trace counter) —
        // environment/timing-dependent; the drawer + picker geometry is
        // the assertion.
        page.locator('footer.bottombar .status'),
        page.locator('details.trace-panel summary'),
      ],
      maskColor: '#ff00ff',
      fullPage: false,
    });

    expect(
      errors.filter((e) => !/getUserMedia|audio/i.test(e)),
      `pageerrors: ${errors.join(' | ')}`,
    ).toEqual([]);
  });
});
