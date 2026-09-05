// e2e/tests/dock-pane-close-chrome.spec.ts
//
// DOCK FULL-VIEW PANE ✕ — the owner split-view close-button fix. Every pane
// of the bottom-drawer full-view (single AND 50/50 split) must show a
// clearly VISIBLE close button on the drawer chrome itself (the RACKLINE
// .win-ctrls trio in the title bar), in BOTH the front faceplate state and
// the flipped rear-card state — in addition to the lane tile's CLOSE
// pill.
//
// THE REGRESSION THIS PINS: the ✕ always existed in the DOM, but the whole
// title bar lived inside .faceplate-scroll whose content carries the kit's
// 900px min-width — in a half-width split pane the bar scrolled sideways
// with the content and the ✕ sat past the pane's right edge (the owner
// screenshot: clipped "REA…" chip, no close visible on either pane).
// Playwright's click() auto-scrolls the target into view, so a bare
// visible+click assertion CANNOT catch this — every check here is a
// GEOMETRIC one: the ✕'s bounding box must sit fully inside its own pane's
// box (no scrolling), and the button must be the live hit-target at its
// center point. The fix makes the chrome (grip + title bar + ✕) pane-fixed
// and scrolls ONLY the content region below it.
//
// Runs on /rack (no DB/relay) — same lane as
// workflow-dock-occupancy.spec.ts. Preview-off renders no full-view at all
// (pinned in workflow-dock-occupancy.spec.ts), so there is nothing to cover
// there.

import { test, expect, type Page, type Locator } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { pressFlipKey } from './_flip-key';
import { installRenderSmokeHooks } from './_render-smoke';
import { settle } from '../_helpers/frames';

async function gotoShellWorkflow(page: Page): Promise<void> {
  await page.goto('/rack');
  // 15s first-load budget (the workflow-shell.spec.ts pattern — cold dev
  // server compile latency on the very first /rack load).
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Open a node's dock full-view via the same dockStore call the tile EXPAND
 *  pill makes (the shipped __openDockFullView hook — the rear-card recipe). */
async function openFullView(page: Page, nodeId: string): Promise<void> {
  await page.waitForFunction(
    () => typeof (globalThis as unknown as { __openDockFullView?: unknown }).__openDockFullView === 'function',
  );
  await page.evaluate(
    (id) => (globalThis as unknown as { __openDockFullView: (id: string) => void }).__openDockFullView(id),
    nodeId,
  );
  await expect(paneOf(page, nodeId)).toBeVisible();
}

function paneOf(page: Page, nodeId: string): Locator {
  return page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${nodeId}"]`);
}
function closeOf(page: Page, nodeId: string): Locator {
  return paneOf(page, nodeId).getByTestId('faceplate-close');
}

/** THE geometric contract: `nodeId`'s pane ✕ renders fully INSIDE that pane's
 *  own box (nothing scrolled, nothing clipped at the pane seam) and is the
 *  live hit-target at its center — i.e. actually clickable, not covered. */
async function expectCloseInsidePane(page: Page, nodeId: string, label: string): Promise<void> {
  const pane = (await paneOf(page, nodeId).boundingBox())!;
  const x = (await closeOf(page, nodeId).boundingBox())!;
  expect(pane, `${label}: pane box resolves`).toBeTruthy();
  expect(x, `${label}: ✕ box resolves`).toBeTruthy();
  expect(x.width, `${label}: ✕ has real size`).toBeGreaterThanOrEqual(20);
  expect(x.x, `${label}: ✕ left edge inside its pane`).toBeGreaterThanOrEqual(pane.x);
  expect(x.x + x.width, `${label}: ✕ right edge inside its pane (not clipped at the seam)`).toBeLessThanOrEqual(
    pane.x + pane.width + 1,
  );
  expect(x.y, `${label}: ✕ top edge inside its pane`).toBeGreaterThanOrEqual(pane.y);
  expect(x.y + x.height, `${label}: ✕ bottom edge inside its pane`).toBeLessThanOrEqual(pane.y + pane.height + 1);
  // Live hit-target: elementFromPoint at the ✕ center resolves to the button
  // (or a descendant of it) — nothing overlays or intercepts it.
  const hit = await page.evaluate(
    ({ cx, cy, id }) => {
      const el = document.elementFromPoint(cx, cy);
      const btn = document.querySelector(
        `[data-testid="dock-fullview-pane"][data-pane-node="${id}"] [data-testid="faceplate-close"]`,
      );
      return !!el && !!btn && (el === btn || btn.contains(el));
    },
    { cx: x.x + x.width / 2, cy: x.y + x.height / 2, id: nodeId },
  );
  expect(hit, `${label}: ✕ is the hit-target at its center`).toBe(true);
}

test.describe('dock full-view pane ✕ — visible chrome in every state (?shell=1)', () => {
  test.beforeEach(async ({ page }) => {
    await installRenderSmokeHooks(page);
  });

  test('single pane: the ✕ sits inside the pane in front AND flipped state, and closes the view', async ({
    page,
  }) => {
    await gotoShellWorkflow(page);
    await spawnPatch(page, [{ id: 'm1', type: 'vca', position: { x: 30, y: 40 } }]);
    await openFullView(page, 'm1');
    const drawer = page.getByTestId('dock-fullview-drawer');
    await expect(drawer).toHaveAttribute('data-pane-count', '1');

    // FRONT: ✕ visible inside the pane, no scrolling required.
    await expectCloseInsidePane(page, 'm1', 'single/front');

    // FLIPPED (rear card): the same chrome carries the ✕ — still inside.
    await pressFlipKey(page);
    await expect(paneOf(page, 'm1').getByTestId('dock-full-view')).toHaveAttribute('data-flipped', 'true');
    await expect(paneOf(page, 'm1').getByTestId('rear-chip')).toBeVisible();
    await expectCloseInsidePane(page, 'm1', 'single/rear');

    // The ✕ closes the (only) pane → the whole view is gone.
    await closeOf(page, 'm1').click();
    await expect(drawer).toHaveCount(0);
    await expect(page.getByTestId('dock-full-view')).toHaveCount(0);
  });

  test('A+B split: EACH pane shows its own ✕ — front, after sideways scroll, and flipped', async ({
    page,
  }) => {
    await gotoShellWorkflow(page);
    // ⚠ PANE B IS `dx7` AND THAT IS THE WHOLE SETUP — it used to be `adsr`.
    // The scroll leg below needs a pane whose CONTENT genuinely exceeds a
    // half-width pane. It used to get that for free from a defect: every
    // curated face was forced to 900 px by `.faceplate-body`'s min-width, so
    // even adsr (measured 259 px of real content) overflowed. With the plate
    // content-sized (#1796) adsr simply FITS, `scrollWidth === clientWidth`,
    // and the leg asserted a condition the layout no longer produces.
    //
    // dx7 is the widest face in the roster (measured 1139 px of content
    // against a ~620 px half-pane), so the overflow is REAL rather than
    // manufactured — which makes this a stronger pin than before, not a
    // weaker one: it now exercises the case where a pane genuinely cannot
    // show everything, which is the case the pane-fixed chrome exists for.
    await spawnPatch(page, [
      { id: 'm1', type: 'vca', position: { x: 30, y: 40 } },
      { id: 'm2', type: 'dx7', position: { x: 250, y: 40 } },
    ]);
    await openFullView(page, 'm1');
    await openFullView(page, 'm2');
    const drawer = page.getByTestId('dock-fullview-drawer');
    await expect(drawer).toHaveAttribute('data-pane-count', '2');

    // FRONT, both half-width panes: each ✕ inside ITS OWN half.
    await expectCloseInsidePane(page, 'm1', 'split/front/left');
    await expectCloseInsidePane(page, 'm2', 'split/front/right');

    // CHROME IS PANE-FIXED: scrolling pane B's content sideways must NOT
    // move its ✕ (pre-fix the bar scrolled with the content and the ✕ lived
    // past the pane edge; this is the direct regression pin).
    //
    // ⚠ IT IS ALSO THE PIN FOR A `max-width` ON `.faceplate-body`. Clamping the
    // body to the pane does not shrink its children — they overflow INSIDE the
    // body, where `.faceplate` (`overflow: hidden`) clips them, so the scroll
    // container reports `scrollWidth === clientWidth` and dx7's right-hand
    // controls become unreachable rather than scrollable. `scrollable === true`
    // below is what catches that; it was verified by re-adding the clamp and
    // watching this line go red.
    const before = (await closeOf(page, 'm2').boundingBox())!;
    const scrolled = await paneOf(page, 'm2')
      .locator('.faceplate-scroll')
      .evaluate((el) => {
        el.scrollLeft = 150;
        return { scrollable: el.scrollWidth > el.clientWidth, scrollLeft: el.scrollLeft };
      });
    expect(scrolled.scrollable, 'half-width pane content still has sideways travel').toBe(true);
    expect(scrolled.scrollLeft, 'pane B content scrolled').toBeGreaterThan(0);
    const after = (await closeOf(page, 'm2').boundingBox())!;
    expect(Math.abs(after.x - before.x), 'the ✕ did not move with the content').toBeLessThanOrEqual(1);
    await expectCloseInsidePane(page, 'm2', 'split/front/right/scrolled');

    // FLIPPED split (the owner screenshot state): BOTH rear panes carry a
    // visible ✕; the REAR·PATCH chip never displaces or clips it.
    await pressFlipKey(page);
    await expect(drawer).toHaveAttribute('data-fullview-flipped', 'true');
    for (const id of ['m1', 'm2'] as const) {
      await expect(paneOf(page, id).getByTestId('rear-card')).toBeVisible();
      await expectCloseInsidePane(page, id, `split/rear/${id}`);
    }
  });

  test('flipped split: LEFT ✕ closes left only → survivor remains (still flipped); its ✕ closes the view', async ({
    page,
  }) => {
    await gotoShellWorkflow(page);
    await spawnPatch(page, [
      { id: 'm1', type: 'vca', position: { x: 30, y: 40 } },
      { id: 'm2', type: 'adsr', position: { x: 250, y: 40 } },
    ]);
    await openFullView(page, 'm1');
    await openFullView(page, 'm2');
    const drawer = page.getByTestId('dock-fullview-drawer');
    await expect(drawer).toHaveAttribute('data-pane-count', '2');
    await pressFlipKey(page);
    await expect(drawer).toHaveAttribute('data-fullview-flipped', 'true');

    // Close the LEFT pane via ITS ✕ — right survives (content-sized since #1573),
    // still on its rear face (the flip seam is view-global and stays put).
    await closeOf(page, 'm1').click();
    await expect(drawer).toHaveAttribute('data-pane-count', '1');
    await expect(paneOf(page, 'm1')).toHaveCount(0);
    await expect(paneOf(page, 'm2')).toBeVisible();
    await expect(drawer).toHaveAttribute('data-fullview-flipped', 'true');
    await expect(paneOf(page, 'm2').getByTestId('rear-card')).toBeVisible();
    const b = (await paneOf(page, 'm2').boundingBox())!;
    const d = (await drawer.boundingBox())!;
    // #1573: panes are content-sized, so the survivor keeps its own width instead of
    // stretching to the drawer. This test is about the ✕ staying REACHABLE, which
    // expectCloseInsidePane below asserts directly — that is the real property, and it
    // is the one the 900px body min-width was originally added to protect.
    expect(b.width, 'survivor still has real width').toBeGreaterThan(0);
    expect(b.width + 16, 'survivor fits inside the drawer').toBeLessThanOrEqual(d.width + 4);
    await expectCloseInsidePane(page, 'm2', 'survivor/rear');

    // The survivor's ✕ closes the last pane → the whole view is gone.
    await closeOf(page, 'm2').click();
    await expect(drawer).toHaveCount(0);
  });

  test('the lane tile CLOSE pill still closes its module (chrome ✕ is in ADDITION, not instead)', async ({
    page,
  }) => {
    await gotoShellWorkflow(page);
    await spawnPatch(page, [{ id: 'm1', type: 'vca', position: { x: 30, y: 40 } }]);
    const tile = page.locator('.svelte-flow__node[data-id="m1"] [data-testid="module-shell"]');
    await expect(tile).toBeVisible();
    // Pan the tile clear of the bottom drawer so real clicks land on it
    // (the workflow-dock-ux pattern).
    await page.evaluate(
      ({ id, top }) => {
        const f = (
          globalThis as unknown as {
            __flow: {
              getViewport: () => { x: number; y: number; zoom: number };
              setViewport: (v: { x: number; y: number; zoom: number }, o?: { duration: number }) => void;
            };
          }
        ).__flow;
        const el = document.querySelector(`.svelte-flow__node[data-id="${id}"]`);
        if (!el || !f) return;
        const r = el.getBoundingClientRect();
        const vp = f.getViewport();
        f.setViewport({ x: vp.x, y: vp.y - (r.top - top), zoom: vp.zoom }, { duration: 0 });
      },
      { id: 'm1', top: 90 },
    );
    // `duration: 0` makes the pan instant IN THE STORE; what the click below
    // needs is the new transform PAINTED, which is a frame count, not a
    // duration — 120 ms was ~7 frames locally and under one on CI's
    // SwiftShader (7.9 fps measured). Two rAFs is Svelte-flush + paint.
    await settle(page);

    const pill = tile.getByTestId('shell-open-dock');
    await pill.click();
    const drawer = page.getByTestId('dock-fullview-drawer');
    await expect(drawer).toHaveAttribute('data-pane-count', '1');
    await expect(pill).toContainText('CLOSE');

    await pill.click();
    await expect(drawer).toHaveCount(0);
    await expect(pill).toContainText('EXPAND');
  });
});
