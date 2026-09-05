// e2e/vrt/workflow-audio-io-composite.spec.ts
//
// VRT: the WORKFLOW topbar 🎧 audio-I/O panel, OPEN — the owner-reported
// breakage class this scene exists to catch ("this should have been caught
// with vrt analysis"): the panel's two hosted faceplates must render PROPERLY
// FITTED (plain-mounted via DockCardHost — no clipped AUDIO IN, no dead space
// around AUDIO OUT, no "Svelte Flow" attribution badge, columns sized to the
// natural faceplate boxes) with the patch-out rows beneath the input column.
//
// ⚠ RE-POINTED ONTO THE FACEPLATE TESTIDS (legacy removal). This scene used to
// gate on `audioin-device-select` and settle on `audioin-status[data-state]` —
// BOTH emitted only by the surface both modules had before their promotion, and
// `AudioInSourceControls.svelte` refuses those spellings BY NAME so the two
// could never be confused. With that surface gone the precondition matched
// nothing and the settle polled for an element that never appears, so the scene
// could only ever time out. It now reads the face's own
// `audioin-face-*` / `audioout-face-*` ids.
//
// ENVIRONMENT-DEPENDENT TEXT IS MASKED, layout/chrome stays in the diff:
//   * the two device <select>s (OS device names differ per machine/CI),
//   * the AUDIO IN action button and fault lamp (their caption and lit state
//     depend on the runner's getUserMedia posture and settle differently on
//     darwin-local vs CI headless).
// Everything else — panel chrome, dock-card headers + zoom controls, the
// faceplates, faders, patch-out rows — is unmasked geometry.
//
// Baselines are authored by LINUX CI — one set, no {platform} segment (see
// vrt.config.ts). `task vrt:commit` dispatches the capture; a local macOS run
// is a smoke test, not a capture.

import { test, expect, type Page } from '@playwright/test';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

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

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await pinVrtFonts(page);
    await page.goto('/rack');
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
      panel.locator('[data-dock-card="pinned-audioIn"] [data-testid="audioin-face-device"]'),
    ).toBeVisible();
    await expect(panel.locator('[data-dock-card="pinned-audioOut"]')).toBeVisible();

    // Let AUDIO IN's auto-acquire settle out of its transient state (masked
    // anyway — this just stops a mid-transition frame from changing the row's
    // LAYOUT, e.g. the action button's caption changing width between baseline
    // and actual). `data-action` is `none` exactly while the state machine has
    // no gesture to offer, which is the transient the old `data-state` poll
    // named.
    await page.waitForFunction(() => {
      const el = document.querySelector(
        '[data-audioin-node="pinned-audioIn"] [data-testid="audioin-face-action"]',
      );
      return !!el && el.getAttribute('data-action') !== 'none';
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
        panel.locator('[data-testid="audioin-face-device"]'),
        panel.locator('[data-testid="audioout-face-device-select"]'),
        panel.locator('[data-testid="audioin-face-action"]'),
        panel.locator('[data-testid="audioin-face-fault"]'),
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
