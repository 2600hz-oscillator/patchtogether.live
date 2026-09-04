// e2e/vrt/workflow-dock-composite.spec.ts
//
// VRT: the WORKFLOW bottom dock — two composite scenes.
//
//  1. `workflow-dock-patch` — the pinned MIXMSTRS open in the bottom dock with
//     its patch-to picker OPEN. Pins the MENU POSITION visually (the
//     owner-reported "patch to is a mess in terms of where the menu spawns":
//     for a dock-hosted card the picker used to open at the (0,0) viewport
//     origin instead of adjacent to the card; see Canvas.cardRectFor's
//     dock-frame resolution). RE-CAPTURED twice: 2026-07-26 when `c` moved the
//     clip player into a full-view pane, and again when that pane's jack rail
//     turned out not to exist (`ModuleShell` gates it on `view !== 'dock-full'`)
//     — the drill needs a rail, so the scene moved to the surface that has one.
//     The CONTRACT is unchanged and so is the precondition it rests on: a
//     PINNED occupant has no canvas element, so the picker can only be placed
//     from the dock frame.
//  2. `workflow-dock-clip-split` — the OWNER ASK itself: the clip player pane
//     SIDE-BY-SIDE 50/50 with a module pane. The spatial relationship (two
//     equal faceplates, each with its own title bar + ✕, sharing the drawer)
//     IS the deliverable, so it gets its own pixel gate.
//
// PAGE-level capture (the cellshade-composite pattern) because the spatial
// relationship IS the assertion. SvelteFlow floating chrome (controls /
// minimap / attribution) is hidden, and the footer's live status text
// (ctx/sr/lat + the trace counter) is masked.
//
// Baselines are authored by LINUX CI — one set, no {platform} segment (see
// vrt.config.ts). `task vrt:commit` dispatches the capture; a local macOS run
// is a smoke test, not a capture.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';
import { pinVrtFonts, awaitVrtFonts } from './_fonts';

test.describe.configure({ mode: 'default' });

/** Wait until the workflow ensure has written a given pinned singleton. */
async function waitForPin(page: Page, nodeId: string): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
      };
      return w.__patch?.nodes[id]?.data?.pinned === true;
    },
    nodeId,
    { timeout: 15_000 },
  );
}

/** Hide the floating flow chrome + kill animation jitter (the drawer flip-in
 *  / dock-flash keyframes) so a page capture is deterministic. */
async function freezeChrome(page: Page): Promise<void> {
  await page.addStyleTag({
    content:
      '.svelte-flow__minimap,.svelte-flow__controls,.svelte-flow__attribution,.minimap-toggle{display:none !important;}' +
      '*,*::before,*::after{animation:none !important;transition:none !important;}',
  });
}

/** Masks shared by both scenes: environment/timing-dependent status text. */
const liveTextMasks = (page: Page) => [
  page.locator('footer.bottombar .status'),
  page.locator('details.trace-panel summary'),
];

/** Hold until an element's rounded height is stable for 3 frames — the 1px
 *  layout-rounding flake guard (fractional faceplate heights re-round for a
 *  frame or two after a pane lands). */
async function settleHeight(el: ReturnType<Page['locator']>): Promise<void> {
  await el.evaluate(
    (node) =>
      new Promise<void>((resolve) => {
        let lastH = -1;
        let stable = 0;
        const tick = () => {
          const h = Math.round(node.getBoundingClientRect().height);
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
}

test.describe('VRT: workflow bottom dock composites', () => {
  test('docked clipplayer with its patch-to picker open matches baseline', async ({ page }) => {
    const id = 'workflow-dock-patch';

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await pinVrtFonts(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await awaitVrtFonts(page);
    await waitForPin(page, 'pinned-mixmstrs');
    await freezeChrome(page);

    // ⚠ THE OCCUPANT IS THE PINNED MIXMSTRS, AND THE SUBJECT IS WHY. This scene
    // is the DOCK-HOSTED-CARD + PATCH-PICKER composite: it pins, in pixels, the
    // geometry `Canvas.cardRectFor` resolves from a `[data-dock-card-frame]`
    // for an occupant with NO canvas element (`isCanvasHiddenNode`) to fall
    // back to. Every pinned singleton has that shape, so the claim is unchanged.
    //
    // ⚠ IT USED TO DRIVE THE CLIP PLAYER'S FULL-VIEW PANE, AND THAT PANE HAS NO
    // JACK RAIL. `ModuleShell` gates the rail on `view !== 'dock-full'` — a
    // full-view pane deliberately drops it and patches through its REAR CARD
    // (Tab) — so there is no `patch-trigger` in that pane to start this drill
    // from. The scene had been forcing the pane onto a second render branch to
    // borrow a rail; that branch is deleted, so the honest subject is the
    // surface that genuinely owns the gesture: the M drawer, whose
    // `DockCardHost` mounts the rail as the tray's only patch surface. The
    // matching e2e assertion (`workflow-dock.spec.ts`) re-points the same way,
    // so the pixel gate and the behavioural gate describe one surface.
    //
    // ⚠ THE BASELINE THEREFORE CHANGES, DELIBERATELY: a different pinned module
    // in a different bottom-dock host. Re-capture on Linux CI via a scoped
    // `task vrt:commit` and review the bot's diff — the picture must still show
    // a picker adjacent to the dock frame, never one at the viewport origin.

    // Open the pinned MIXMSTRS in the dock (the M keymap → the pinned drawer),
    // then drive the real patch flow: trigger → OUTPUT → jack-click row →
    // "patch to…".
    await page.locator('.flow .svelte-flow__pane').first().click({ position: { x: 500, y: 380 } });
    await page.keyboard.press('m');
    const drawer = page.getByTestId('dock-zone-bottom');
    await expect(drawer).toBeVisible();
    const card = drawer.locator('[data-dock-card="pinned-mixmstrs"]');
    await expect(card).toBeVisible();

    await card.getByTestId('patch-trigger').click();
    const chrome = page.locator('[data-patch-panel-chrome="pinned-mixmstrs"]');
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
    await settleHeight(picker);

    await expect(page).toHaveScreenshot(`${id}.png`, {
      // Live status text (ctx/sr/lat readouts + the trace counter) —
      // environment/timing-dependent; the pane + picker geometry is the
      // assertion.
      mask: liveTextMasks(page),
      maskColor: '#ff00ff',
      fullPage: false,
    });

    expect(
      errors.filter((e) => !/getUserMedia|audio/i.test(e)),
      `pageerrors: ${errors.join(' | ')}`,
    ).toEqual([]);
  });

  // THE OWNER ASK, as pixels: "need to be able to have clip player (built in)
  // open along side a module in drawer." A module EXPANDed first (left pane) +
  // the clip player joined with `c` (right pane), 50/50, each pane carrying
  // its own faceplate chrome + ✕. Runs under `?shell=1` so the module's lane
  // tile carries the EXPAND pill — the real gesture the owner uses.
  test('clip player SIDE-BY-SIDE with a module pane matches baseline', async ({ page }) => {
    const id = 'workflow-dock-clip-split';

    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await pinVrtFonts(page);
    await page.goto('/rack');
    await page.waitForLoadState('networkidle');
    await awaitVrtFonts(page);
    await waitForPin(page, 'pinned-clipplayer');

    // Seed ONE migrated module (its lane tile gets the EXPAND pill).
    await spawnPatch(page, [{ id: 'vrt-vca', type: 'vca', position: { x: 40, y: 40 } }]);
    await waitForPin(page, 'pinned-clipplayer'); // spawnPatch wiped the rack; ensure re-spawns
    await freezeChrome(page);

    const tile = page.locator('.svelte-flow__node[data-id="vrt-vca"] [data-testid="module-shell"]');
    await expect(tile).toBeVisible({ timeout: 15_000 });
    await tile.getByTestId('shell-open-dock').click();

    const drawer = page.getByTestId('dock-fullview-drawer');
    await expect(drawer).toHaveAttribute('data-pane-count', '1');
    await page.keyboard.press('c');
    await expect(drawer).toHaveAttribute('data-pane-count', '2');
    await expect(
      page.locator('[data-testid="dock-fullview-pane"][data-pane-node="pinned-clipplayer"]'),
    ).toBeVisible();

    await settleHeight(drawer);

    await expect(page).toHaveScreenshot(`${id}.png`, {
      mask: liveTextMasks(page),
      maskColor: '#ff00ff',
      fullPage: false,
    });

    expect(
      errors.filter((e) => !/getUserMedia|audio/i.test(e)),
      `pageerrors: ${errors.join(' | ')}`,
    ).toEqual([]);
  });
});
