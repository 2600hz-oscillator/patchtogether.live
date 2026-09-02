// e2e/tests/menu-viewport-clamp.spec.ts
//
// CONTEXT MENUS MUST OPEN FULLY IN VIEW — horizontally AND vertically, in ALL
// views (owner requirement; screenshot evidence: right-clicking the clip
// editor grid inside the dock opened a probability menu clipped at the right
// window edge). Every open site now positions through the shared
// clampMenuToViewport core ($lib/ui/menu-viewport + the clampMenu action):
// flip across the anchor on overflow, clamp as last resort, always in view.
//
// Each menu FAMILY is driven at EXTREME anchors (right edge, bottom edge,
// bottom-right corner, left edge) and the menu's bounding box is asserted to
// be fully inside the window:
//
//   * module add palette      — pane right-click at the pane's extremes
//   * module (node) menu      — card panned to the right/bottom/corner
//   * control menu (MIDI)     — a fader at the bottom-right corner
//   * clip-editor grid menus  — the owner's exact case: note-probability +
//                               clip-probability menus, BOTH on the canvas
//                               card (panned to the corner — also proves the
//                               portal escapes SvelteFlow's pan/zoom
//                               transform) AND inside the DOCK full-view pane
//                               (?shell=1, split so the grid hugs the right
//                               window edge)
//   * patch drill-down        — a lane tile at the LEFT window edge
//   * remap menu              — NUMPAD+ key remap menu at the corner
//
// Runs against /rack?shell=legacy&seed=none (classic canvas) and /rack (the
// dock) — the fix is ungated (plain bug fix), so no feature flag is involved.

import { test, expect, type Page, type Locator } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS } from '../_helpers/boot-budget';

// ⚠ THE PER-TEST BUDGET IS A BOUND, AND IT WAS THE INVISIBLE 30 s DEFAULT.
//
// This file bounds its boot wait with `BOOT_MS` — 30 000 on CI, IDENTICAL to
// the 30 000 default budget it was running inside. 1 site, 1.00x.
//
// An inner bound at or above the budget that CONTAINS it can never come true:
// the outer clock kills the test first, so a legible `element not found` is
// converted into an illegible `Test timeout of 30000ms exceeded` — the class
// #2291 root-caused and #2293 repaired at its second call site. Nothing in this
// file said "30000"; `e2e/playwright.config.ts` never overrides Playwright's
// default, so there was nothing to grep for except the ABSENCE of a budget.
//
// The budget therefore comes from `boot-budget` (90 000 on CI/SwiftShader,
// 30 000 local) instead of the invisible default. A bound only costs wall-clock
// when it is EXCEEDED, so this adds exactly zero to a green run; lane cost stays
// gauged by `--global-timeout`, not by this.
//
// ⚠ BOUNDS ONLY. No assertion, subject or wait target changed here.
test.describe.configure({ mode: 'parallel', timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

/** Assert the menu's bounding box sits FULLY inside the window. */
async function expectFullyInViewport(page: Page, menu: Locator): Promise<void> {
  await expect(menu).toBeVisible();
  // Let the clamp's coalesced ResizeObserver pass settle (≤1 frame).
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))),
  );
  const box = await menu.boundingBox();
  expect(box, 'menu bounding box resolves').not.toBeNull();
  const vp = page.viewportSize();
  expect(vp, 'viewport size known').not.toBeNull();
  expect(box!.x, 'menu LEFT edge on-screen').toBeGreaterThanOrEqual(0);
  expect(box!.y, 'menu TOP edge on-screen').toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, 'menu RIGHT edge on-screen').toBeLessThanOrEqual(vp!.width + 0.5);
  expect(box!.y + box!.height, 'menu BOTTOM edge on-screen').toBeLessThanOrEqual(vp!.height + 0.5);
}

/** Assert the menu opened ADJACENT to the anchor point (catches the
 *  transformed-ancestor coordinate bug class, where a "fixed" menu lands
 *  wherever the transformed pane sits instead of at the cursor). */
function expectNearAnchor(
  box: { x: number; y: number; width: number; height: number },
  anchor: { x: number; y: number },
  tolerance = 32,
): void {
  const dx = Math.max(box.x - anchor.x, anchor.x - (box.x + box.width), 0);
  const dy = Math.max(box.y - anchor.y, anchor.y - (box.y + box.height), 0);
  expect(dx, 'menu horizontally adjacent to the right-click point').toBeLessThanOrEqual(tolerance);
  expect(dy, 'menu vertically adjacent to the right-click point').toBeLessThanOrEqual(tolerance);
}

async function gotoClassic(page: Page): Promise<void> {
  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForFunction(() => {
    const w = window as unknown as { __patch?: unknown; __flow?: unknown };
    return !!w.__patch && !!w.__flow;
  });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

async function gotoWorkflowShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: BOOT_MS });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const w = window as unknown as { __patch?: unknown; __flow?: unknown };
    return !!w.__patch && !!w.__flow;
  });
}

/** Pan the flow viewport so `nodeId`'s DOM rect lands with the requested edge
 *  near the window's edge (margin px away). Keeps zoom. */
async function panNodeTo(
  page: Page,
  nodeId: string,
  place: 'right' | 'bottom' | 'corner' | 'left',
  margin = 8,
): Promise<void> {
  await page.evaluate(
    ({ nodeId, place, margin }) => {
      const w = globalThis as unknown as {
        __flow: {
          getViewport: () => { x: number; y: number; zoom: number };
          setViewport: (v: { x: number; y: number; zoom: number }, o?: { duration: number }) => void;
        };
      };
      const el = document.querySelector(`.svelte-flow__node[data-id="${nodeId}"]`);
      if (!el || !w.__flow) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let dx = 0;
      let dy = 0;
      if (place === 'right' || place === 'corner') dx = vw - margin - r.right;
      if (place === 'left') dx = margin - r.left;
      if (place === 'bottom' || place === 'corner') dy = vh - margin - r.bottom;
      const vp = w.__flow.getViewport();
      w.__flow.setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom }, { duration: 0 });
    },
    { nodeId, place, margin },
  );
  await page.waitForTimeout(120);
}

// ============================================================================
// Module add palette — pane right-click at the pane's extremes (classic rack)
// ============================================================================

test('module palette opens fully in view from right/bottom/left pane extremes', async ({ page }) => {
  await gotoClassic(page);
  const pane = page.locator('.svelte-flow__pane:visible').first();
  const box = await pane.boundingBox();
  expect(box).not.toBeNull();
  const palette = page.locator('.module-palette');

  // Anchor points hugging the pane's edges. The exact bottom-right/bottom-left
  // corners host the minimap / controls overlays (they'd swallow the
  // right-click), so the corner-ish anchors sit just clear of them while
  // still deep in the overflow zone for a ~380px-tall palette.
  const anchors = [
    { x: box!.x + box!.width - 4, y: box!.y + box!.height * 0.35 }, // right edge
    { x: box!.x + box!.width * 0.45, y: box!.y + box!.height - 4 }, // bottom edge
    { x: box!.x + box!.width - 4, y: box!.y + box!.height * 0.7 }, // right, low (corner-ish)
    { x: box!.x + 40, y: box!.y + box!.height - 4 }, // near bottom-left
  ];
  for (const anchor of anchors) {
    await page.mouse.click(anchor.x, anchor.y, { button: 'right' });
    await expectFullyInViewport(page, palette);
    const pbox = await palette.boundingBox();
    expectNearAnchor(pbox!, anchor);
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
  }
});

// ============================================================================
// Module (node) + control menus — card at the window's right/bottom/corner
// ============================================================================

test('module context menu opens fully in view with the card at the right edge, bottom edge and corner', async ({ page }) => {
  await gotoClassic(page);
  await spawnPatch(page, [{ id: 'm1', type: 'vca', position: { x: 200, y: 120 } }]);
  const node = page.locator('.svelte-flow__node[data-id="m1"]');
  const menu = page.locator('[role="menu"][aria-label="Module actions"]');

  for (const place of ['right', 'bottom', 'corner'] as const) {
    await panNodeTo(page, 'm1', place);
    const nbox = await node.boundingBox();
    expect(nbox).not.toBeNull();
    // Right-click the card's title strip (top area, clear of controls/jacks),
    // biased toward the panned-to edge so the ANCHOR is extreme.
    const anchor = {
      x: place === 'bottom' ? nbox!.x + nbox!.width / 2 : nbox!.x + nbox!.width - 12,
      y: nbox!.y + 8,
    };
    await page.mouse.click(anchor.x, anchor.y, { button: 'right' });
    await expectFullyInViewport(page, menu);
    expectNearAnchor((await menu.boundingBox())!, anchor);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  }
});

test('control (MIDI) context menu opens fully in view from a fader at the bottom-right corner', async ({ page }) => {
  await gotoClassic(page);
  await spawnPatch(page, [{ id: 'm1', type: 'vca', position: { x: 200, y: 120 } }]);
  await panNodeTo(page, 'm1', 'corner');
  const fader = page.locator('.svelte-flow__node[data-id="m1"] [data-testid="control-base"]');
  await expect(fader).toBeVisible();
  await fader.click({ button: 'right' });
  const menu = page.getByTestId('control-context-menu');
  await expectFullyInViewport(page, menu);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

// ============================================================================
// Remap menu family — NUMPAD+ key remap menu at the corner
// ============================================================================

// ⚠ THIS ONE STAYS ON `?shell=legacy`, AND THE REASON MATTERS AFTER THE FACE
// PROMOTION. Its subject is a `position: fixed` menu escaping SvelteFlow's
// TRANSFORMED node — a property only the CARD has, because the faceplate's
// keymap panel is dock-only and the dock is not inside that transform. So this
// is not a gate pinning an old host as correct: the card is still a shipped
// surface (`?shell=legacy` must keep working) and it is the only surface where
// this failure mode exists. The FACE's own menu — portal plus viewport clamp,
// out of the dock — is driven in `numpad-plus-face.spec.ts`.
test('numpad key remap menu opens fully in view at the bottom-right corner', async ({ page }) => {
  await gotoClassic(page);
  await spawnPatch(page, [{ id: 'n1', type: 'numpadPlus', position: { x: 200, y: 120 } }]);
  await panNodeTo(page, 'n1', 'corner');
  const key = page.locator('.svelte-flow__node[data-id="n1"] [data-testid="numpad-key-11"]');
  await expect(key).toBeVisible();
  await key.click({ button: 'right' });
  const menu = page.getByTestId('numpad-key-menu');
  await expectFullyInViewport(page, menu);
  await page.keyboard.press('Escape');
});

// ============================================================================
// Clip-editor grid menus on the CANVAS card (panned to the corner — also
// proves the portal escapes SvelteFlow's transformed viewport)
// ============================================================================

test('clip editor note-probability + clip-probability menus stay in view with the card at the corner (canvas)', async ({ page }) => {
  await gotoClassic(page);
  await spawnPatch(page, [{ id: 'cp1', type: 'clipplayer', position: { x: 120, y: 80 } }]);
  const node = page.locator('.svelte-flow__node[data-id="cp1"]');

  // Enter the clip editor (double-click pad 0 — also CREATES clip 0; the
  // clip-probability menu only opens on pads that HAVE a clip), pan the
  // card's bottom-right to the window corner, and right-click the LAST grid
  // cell — the owner's exact gesture at the most extreme anchor.
  const pad = node.locator('[data-testid="clipplayer-pad-0"]');
  await expect(pad).toBeVisible();
  await pad.dblclick();
  const roll = node.locator('[data-testid="clipplayer-pianoroll"]');
  await expect(roll).toBeVisible();
  // RIGHT-edge extremity (the owner's exact symptom: menu clipped at the
  // right window edge). The canvas' bottom-right corner is owned by the
  // minimap + attribution overlays (they'd swallow the clicks), so the cell
  // anchor is the LAST step column at mid-window height instead.
  await panNodeTo(page, 'cp1', 'right');
  const lastCol = roll.locator('.cell[data-step="15"]');
  const vh = page.viewportSize()!.height;
  const cell = await (async () => {
    const n = await lastCol.count();
    let best = lastCol.first();
    let bestDist = Infinity;
    for (let i = 0; i < n; i++) {
      const b = await lastCol.nth(i).boundingBox();
      if (!b) continue;
      const cy = b.y + b.height / 2;
      if (cy < 60 || cy > vh - 60) continue; // fully on-screen, clear of overlays
      const d = Math.abs(cy - vh * 0.45);
      if (d < bestDist) {
        bestDist = d;
        best = lastCol.nth(i);
      }
    }
    return best;
  })();
  // The probability menu only opens on a cell that HOLDS a note — toggle one
  // on with a left-click first.
  await cell.click();
  await cell.click({ button: 'right' });
  const probMenu = page.getByTestId('clipplayer-prob-menu-cp1');
  await expectFullyInViewport(page, probMenu);
  const cellBox = (await cell.boundingBox())!;
  expectNearAnchor((await probMenu.boundingBox())!, {
    x: cellBox.x + cellBox.width / 2,
    y: cellBox.y + cellBox.height / 2,
  });

  // ⚠ THE SUBMENU FLYOUT IS NOW THE THING THAT CAN OVERFLOW, and it needs its
  // own assertion — otherwise this test would keep passing while measuring
  // nothing that matters. Until 2026-08-24 the note menu was ONE ~90-row column,
  // so "the prob menu is fully in viewport" was a real constraint. The owner's
  // restructure moved the option lists into flyouts, leaving the parent menu
  // seven short rows that fit almost anywhere — the parent assertion above went
  // from hard to nearly free, and the long column it used to cover moved into a
  // box no assertion here saw. The flyout also opens to the RIGHT of a menu
  // already at the window's right edge, which is the worst case for it.
  await page.getByTestId('clipplayer-sub-note-cp1').click();
  const flyout = page.getByTestId('clipplayer-submenu-note-cp1');
  await expect(flyout).toBeVisible();
  await expectFullyInViewport(page, flyout);
  // …and it must not paint ON TOP of the parent it flew out of (the failure a
  // pure in-viewport clamp allows: slide it back inside by covering its own
  // menu). `flip: false` is what keeps it sliding along the edge instead.
  const parentBox = (await probMenu.boundingBox())!;
  const flyBox = (await flyout.boundingBox())!;
  const overlapX = Math.min(parentBox.x + parentBox.width, flyBox.x + flyBox.width) - Math.max(parentBox.x, flyBox.x);
  const overlapY = Math.min(parentBox.y + parentBox.height, flyBox.y + flyBox.height) - Math.max(parentBox.y, flyBox.y);
  expect(
    overlapX <= 0 || overlapY <= 0,
    `flyout must not cover its parent menu (overlap ${Math.round(overlapX)}x${Math.round(overlapY)} CSS px)`,
  ).toBe(true);

  // The prob menus dismiss via their backdrop (they have no Esc handler —
  // and Esc would close a dock full-view out from under the dock variant).
  await page.getByRole('button', { name: 'close clip menu' }).click();
  await expect(probMenu).toBeHidden();
  await expect(flyout).toBeHidden();

  // Back to the session grid; right-click the (now clip-carrying) pad with
  // the card's right edge hugging the window's right edge.
  await node.locator('[data-testid="clipplayer-strip-2-cp1"]').click();
  await expect(pad).toBeVisible();
  await panNodeTo(page, 'cp1', 'right');
  await pad.click({ button: 'right' });
  const clipProbMenu = page.getByTestId('clipplayer-clip-prob-menu-cp1');
  await expectFullyInViewport(page, clipProbMenu);
  const padBox = (await pad.boundingBox())!;
  expectNearAnchor((await clipProbMenu.boundingBox())!, {
    x: padBox.x + padBox.width / 2,
    y: padBox.y + padBox.height / 2,
  });
});

// ============================================================================
// THE OWNER'S CASE — clip editor inside the DOCK full-view pane (?shell=1)
// ============================================================================

test('clip editor menus inside the dock full-view pane stay fully in view (owner case, ?shell=1)', async ({ page }) => {
  await gotoWorkflowShell(page);
  await spawnPatch(page, [
    { id: 'a1', type: 'vca', position: { x: 30, y: 40 } },
    { id: 'cp1', type: 'clipplayer', position: { x: 250, y: 40 } },
  ]);

  // Split the dock (vca left, clipplayer RIGHT) so the clip grid sits in the
  // right half — its right-side pads/cells then anchor near the window's
  // right edge, and the drawer itself hugs the bottom edge. The vca tile has
  // the real EXPAND pill; the clipplayer (a NON-tile legacy lane card in
  // ?shell=1) opens through the same dockStore call the pills make, exposed
  // as the dev hook __openDockFullView (the sanctioned e2e path for legacy
  // cards — see Canvas.svelte).
  const vcaExpand = page.locator('.svelte-flow__node[data-id="a1"] [data-testid="shell-open-dock"]');
  await vcaExpand.scrollIntoViewIfNeeded();
  await vcaExpand.click();
  await expect(page.locator('[data-testid="dock-fullview-pane"][data-pane-node="a1"]')).toBeVisible();
  await page.evaluate(() => {
    (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView('cp1');
  });
  const pane = page.locator('[data-testid="dock-fullview-pane"][data-pane-node="cp1"]');
  await expect(pane).toBeVisible();

  // ⚠ THE CHOREOGRAPHY CHANGED WITH THE PROMOTION, AND THE SUBJECT DID NOT.
  // `clipplayer` was promoted (#2320), so this pane paints the FACEPLATE: the
  // launch grid and the note editor are two BANDS that render at the same time
  // rather than two mutually exclusive card VIEWS. That deletes three steps
  // this test used to need — the click-then-wait-then-dblclick dance around the
  // card's focus chrome (a bare `focus()` scrolled the 540 px card inside its
  // ~352 px scrollport, landing click 2 on a different pad), and the control
  // strip press further down that switched back to the grid. What is measured
  // is unchanged: a menu opened deep in the drawer's bottom-right must stay
  // fully in view, and must anchor to the thing it was opened on.
  const roll = pane.locator('[data-testid="clipplayer-pianoroll"]');
  await expect(roll).toBeVisible();
  // The probability menu only opens on a cell that HOLDS a note — toggle one
  // on the LAST cell (bottom-right of the grid) with a left-click first.
  const lastCell = roll.locator('.cell').last();
  await lastCell.scrollIntoViewIfNeeded();
  await lastCell.click();
  await lastCell.click({ button: 'right' });
  const probMenu = page.getByTestId('clipplayer-prob-menu-cp1');
  await expectFullyInViewport(page, probMenu);
  const cellBox = (await lastCell.boundingBox())!;
  expectNearAnchor((await probMenu.boundingBox())!, {
    x: cellBox.x + cellBox.width / 2,
    y: cellBox.y + cellBox.height / 2,
  });
  // Dismiss via the backdrop — Esc would close the dock full-view itself.
  await page.getByRole('button', { name: 'close clip menu' }).click();
  await expect(probMenu).toBeHidden();

  // Clip-probability menu from a pad on the session grid — no view switch
  // needed, since the faceplate paints the grid and the editor at once.
  const pad = pane.locator('[data-testid="clipplayer-pad-0"]');
  await expect(pad).toBeVisible();
  await pad.scrollIntoViewIfNeeded();
  await pad.click({ button: 'right' });
  const clipProbMenu = page.getByTestId('clipplayer-clip-prob-menu-cp1');
  await expectFullyInViewport(page, clipProbMenu);
  const padBox = (await pad.boundingBox())!;
  expectNearAnchor((await clipProbMenu.boundingBox())!, {
    x: padBox.x + padBox.width / 2,
    y: padBox.y + padBox.height / 2,
  });
});

// ============================================================================
// Patch drill-down — a lane tile at the LEFT window edge (?shell=1)
// ============================================================================

test('patch drill-down menu from a lane tile at the left edge stays fully in view (?shell=1)', async ({ page }) => {
  await gotoWorkflowShell(page);
  await spawnPatch(page, [{ id: 'v1', type: 'vca', position: { x: 30, y: 40 } }]);
  // The workflow LEFT DOCK RAIL overlays the window's left strip and
  // intercepts clicks — the effective left edge for lane tiles starts just
  // right of it.
  const railBox = await page.getByTestId('workflow-leftbar').boundingBox();
  const leftEdge = (railBox ? railBox.x + railBox.width : 0) + 6;
  await panNodeTo(page, 'v1', 'left', leftEdge);
  const trigger = page
    .locator('.svelte-flow__node[data-id="v1"] [data-testid="patch-trigger"]')
    .first();
  await expect(trigger).toBeVisible();
  await trigger.click();
  const panel = page.getByTestId('patch-panel');
  await expectFullyInViewport(page, panel);
});
