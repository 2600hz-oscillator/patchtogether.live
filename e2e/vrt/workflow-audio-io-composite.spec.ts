// e2e/vrt/workflow-audio-io-composite.spec.ts
//
// VRT: the WORKFLOW topbar 🎧 audio-I/O panel, OPEN — the owner-reported
// breakage class this scene exists to catch ("this should have been caught
// with vrt analysis"): the panel's two hosted card faces must render
// PROPERLY FITTED (plain-mounted via DockCardHost — no clipped AUDIO IN, no
// dead space around AUDIO OUT, no "Svelte Flow" attribution badge, columns
// sized to the rack-sized card boxes) with the patch-out rows beneath the
// input column.
//
// ENVIRONMENT-DEPENDENT TEXT IS MASKED, layout/chrome stays in the diff:
//   * the two device <select>s (OS device names differ per machine/CI),
//   * the AUDIO IN status row (idle/permission text depends on the
//     runner's getUserMedia posture and settles at different states on
//     darwin-local vs CI headless).
// Everything else — panel chrome, dock-card headers + zoom controls, card
// faces, faders, patch-out rows — is unmasked geometry.
//
// darwin-first: the darwin baseline is captured locally; the linux pair is
// EXEMPT_BASELINE_PAIRS-deferred until a vrt-update.yml dispatch lands it
// (the cellshade-composite pattern; vrt-meta's linux-deficit ratchet
// accounts for the pair).

import { test, expect, type Page } from '@playwright/test';
import { EXEMPT_BASELINE_PAIRS } from './vrt-exemptions';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

const VRT_PLATFORM = process.platform === 'darwin' ? 'darwin' : 'linux';
test.describe.configure({ mode: 'default' });

/** Wait until the workflow ensure has written the pinned audio pair. */
async function waitForAudioPins(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
      };
      if (!w.__patch) return false;
      return ['pinned-audioIn', 'pinned-audioOut'].every(
        (id) => w.__patch!.nodes[id]?.data?.pinned === true,
      );
    },
    undefined,
    { timeout: 15_000 },
  );
}

test.describe('VRT: workflow 🎧 audio-I/O panel (open)', () => {
  test('open panel with both card faces properly fitted matches baseline', async ({ page }) => {
    const id = 'workflow-audio-io';
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
    await waitForAudioPins(page);

    // Stable page capture: hide the floating flow chrome + kill
    // animation/transition jitter (LED pulses etc.).
    await page.addStyleTag({
      content:
        '.svelte-flow__minimap,.svelte-flow__controls,.svelte-flow__attribution,.minimap-toggle{display:none !important;}' +
        '*,*::before,*::after{animation:none !important;transition:none !important;}',
    });

    // Open the 🎧 panel.
    await page.getByTestId('workflow-topbar-slot-audio-io').click();
    const panel = page.getByTestId('workflow-io-panel');
    await expect(panel).toHaveAttribute('data-open', 'true');
    await expect(
      panel.locator('[data-dock-card="pinned-audioIn"] [data-testid="audioin-device-select"]'),
    ).toBeVisible();
    await expect(panel.locator('[data-dock-card="pinned-audioOut"]')).toBeVisible();

    // Let the AUDIO IN card's auto-acquire settle out of the transient
    // 'requesting' state (masked anyway — this just stops a mid-transition
    // frame from changing the row's LAYOUT, e.g. the enable button
    // mounting/unmounting between baseline and actual).
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="audioin-status"]');
      return !!el && el.getAttribute('data-state') !== 'requesting';
    }, undefined, { timeout: 10_000 });

    // Height-stability settle (the documented 1px-layout-rounding guard):
    // hold until the panel box is stable for 3 consecutive frames.
    await panel.evaluate(
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

    // PAGE-level capture (element-screenshotting the absolutely-positioned
    // dropdown mis-offsets its clip box) — this also pins the panel's
    // anchored position under the 🎧 topbar slot.
    await expect(page).toHaveScreenshot(`${id}.png`, {
      mask: [
        panel.locator('[data-testid="audioin-device-select"]'),
        panel.locator('[data-testid="audioout-device-select"]'),
        panel.locator('[data-testid="audioin-status"]'),
        // Footer live status text (ctx/sr/lat + trace counter) — not part
        // of this scene's assertion.
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
