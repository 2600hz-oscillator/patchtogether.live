// e2e/tests/workflow-dock-occupancy.spec.ts
//
// DOCK UNIFICATION — ONE bottom-drawer occupant (owner design call): the
// pinned M/E/C drawer and the expanded module full-view share a single
// bottom-drawer slot — pinned XOR full-view, never both stacked.
//
// The owner bug: pressing `c` while the full-view was open opened the clip
// launcher BEHIND the faceplate (two independent bottom overlays, z-31 over
// z-30 — unusable). Fixed at BOTH layers:
//   * dockStore models one bottom occupancy — openFullView() closes the
//     pinned occupant; toggle('bottom', …) closes the full-view and OPENS the
//     requested pinned drawer (replace, not stack);
//   * Canvas renders the two from one {#if}/{:else} container, so the
//     exclusivity is STRUCTURAL — the elements can never coexist in the DOM.
//
// SPLIT EXTENSION (owner): the full-view holds up to TWO modules SIDE-BY-SIDE
// (50/50), each pane its own overflow container (independent scroll, both
// axes); closing one pane returns the survivor to full width; `c`/`m`/`e`
// close the ENTIRE split; TAB is the rear-card flip seam (data-attr only).
// A THIRD expand replaces the least-recently-opened pane — pinned in
// workflow-dock-ux.spec.ts (the split flow test), not duplicated here.
//
// Contracts pinned here (`?shell=1` preview, where the full-view exists):
//   1. full-view open → `c` → faceplate GONE; clipplayer drawer visible and
//      INTERACTABLE in front (a real click on one of its controls lands);
//   2. `c` open → EXPAND a module → drawer gone, faceplate shows;
//   3. `m` / `e` follow the same replace pattern;
//   4. ESC closes whichever occupant is open (the full-view as a WHOLE);
//   5. preview-off (?shell absent): the shipped M/E/C drawer behavior is
//      untouched and no full-view ever materializes (byte-identical no-op —
//      the full sweep lives in workflow-mode.spec.ts, still green);
//   6. A+B split 50/50 with independent pane scroll; pane ✕ → survivor full
//      width; `c` swaps out the whole split; TAB toggles the flip attr.
//
// Runs on /rack?mode=workflow&shell=1 (no DB/relay) — same lane as
// workflow-shell.spec.ts / workflow-dock-ux.spec.ts.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';

/** The pinned trio's deterministic node ids (graph/workflow-pins.ts). */
const PINNED_IDS = ['pinned-mixmstrs', 'pinned-electraControl', 'pinned-clipplayer'] as const;

/** Wait until the workflow ensure effect has written the pinned trio (the
 *  dock keymap only toggles once the pinned node exists). */
async function waitForPinnedTrio(page: Page): Promise<void> {
  await page.waitForFunction(
    (ids) => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { data?: { pinned?: boolean } } | undefined> };
      };
      if (!w.__patch) return false;
      return ids.every((id) => w.__patch!.nodes[id]?.data?.pinned === true);
    },
    PINNED_IDS as unknown as string[],
    { timeout: 10_000 },
  );
}

async function gotoShellWorkflow(page: Page): Promise<void> {
  await page.goto('/rack?mode=workflow&shell=1');
  // 15s first-load budget (the workflow-shell.spec.ts pattern): on a COLD dev
  // server the very first /rack compile can exceed the 5s expect default —
  // reproduced locally with a cleared .vite cache; every later load is ~1s.
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
  await waitForPinnedTrio(page);
}

/** Pan the viewport so node `id`'s tile lands near screen-top — the lane tile
 *  must sit ABOVE the bottom drawer so real clicks land on it while a drawer /
 *  full-view is open (the workflow-dock-ux pattern). */
async function panTileTo(page: Page, id: string, top: number): Promise<void> {
  await page.evaluate(
    ({ id, top }) => {
      const f = (globalThis as unknown as { __flow: { getViewport: () => { x: number; y: number; zoom: number }; setViewport: (v: { x: number; y: number; zoom: number }, o?: { duration: number }) => void } }).__flow;
      const el = document.querySelector(`.svelte-flow__node[data-id="${id}"]`);
      if (!el || !f) return;
      const r = el.getBoundingClientRect();
      const vp = f.getViewport();
      f.setViewport({ x: vp.x, y: vp.y - (r.top - top), zoom: vp.zoom }, { duration: 0 });
    },
    { id, top },
  );
  await page.waitForTimeout(120);
}

/** Spawn one migrated module and return its shell tile + EXPAND pill. */
async function spawnExpandableTile(page: Page) {
  await spawnPatch(page, [{ id: 'm1', type: 'vca', position: { x: 30, y: 40 } }]);
  const tile = page.locator('.svelte-flow__node[data-id="m1"] [data-testid="module-shell"]');
  await expect(tile).toBeVisible();
  await panTileTo(page, 'm1', 90);
  return { tile, pill: tile.getByTestId('shell-open-dock') };
}

test.describe('bottom-drawer occupancy: pinned XOR full-view (?shell=1)', () => {
  test.beforeEach(async ({ page }) => {
    await installRenderSmokeHooks(page);
  });

  // (1) THE OWNER BUG: `c` while the full-view is open must REPLACE it — the
  // faceplate closes and the clip launcher opens IN FRONT, fully interactable.
  test('`c` while the full-view is open replaces it with an INTERACTABLE clipplayer drawer', async ({ page }) => {
    await gotoShellWorkflow(page);
    const { pill } = await spawnExpandableTile(page);

    await pill.click();
    const faceplate = page.getByTestId('dock-full-view');
    await expect(faceplate).toBeVisible();
    await expect(pill).toContainText('CLOSE');

    await page.keyboard.press('c');
    // Full-view GONE (not merely covered) + the clipplayer drawer is the one
    // bottom element left.
    await expect(faceplate).toHaveCount(0);
    const drawer = page.getByTestId('dock-zone-bottom');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('data-dock-type', 'clipplayer');
    await expect(drawer.locator('[data-dock-card="pinned-clipplayer"]')).toBeVisible();
    // …and the tile's pill tracks fullViewNodeId back to EXPAND.
    await expect(pill).toContainText('EXPAND');
    await expect(pill).toHaveAttribute('data-expanded', 'false');

    // INTERACTABLE IN FRONT: a REAL click on a drawer control lands and takes
    // effect (pre-fix the z-31 faceplate intercepted the pointer). The S&H
    // toggle exposes its state as aria-pressed — click it and see it flip.
    const snh = drawer.getByTestId('clipplayer-snh-toggle');
    const before = await snh.getAttribute('aria-pressed');
    await snh.click();
    await expect(snh).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true');
  });

  // (2) The mirror image: EXPAND while the pinned drawer is open closes the
  // drawer and opens the full-view.
  test('EXPAND while the clipplayer drawer is open replaces it with the full-view', async ({ page }) => {
    await gotoShellWorkflow(page);
    const { pill } = await spawnExpandableTile(page);

    await page.keyboard.press('c');
    const drawer = page.getByTestId('dock-zone-bottom');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('data-dock-type', 'clipplayer');

    await pill.click();
    await expect(drawer).toHaveCount(0);
    const faceplate = page.getByTestId('dock-full-view');
    await expect(faceplate).toBeVisible();
    await expect(faceplate).toHaveAttribute('data-fullview-node', 'm1');
    await expect(pill).toContainText('CLOSE');
    await expect(pill).toHaveAttribute('data-expanded', 'true');
  });

  // (3) `m` / `e` follow the same replace pattern — and the shipped
  // drawer-to-drawer replacement between them still works.
  test('`m` and `e` replace the full-view the same way (and each other)', async ({ page }) => {
    await gotoShellWorkflow(page);
    const { pill } = await spawnExpandableTile(page);
    const faceplate = page.getByTestId('dock-full-view');
    const drawer = page.getByTestId('dock-zone-bottom');

    // m replaces the full-view with the mixer drawer.
    await pill.click();
    await expect(faceplate).toBeVisible();
    await page.keyboard.press('m');
    await expect(faceplate).toHaveCount(0);
    await expect(drawer).toHaveAttribute('data-dock-type', 'mixmstrs');

    // e replaces m (shipped one-at-a-time drawer semantics, unchanged).
    await page.keyboard.press('e');
    await expect(drawer).toHaveCount(1);
    await expect(drawer).toHaveAttribute('data-dock-type', 'electraControl');

    // EXPAND replaces the e drawer with the full-view again…
    await pill.click();
    await expect(drawer).toHaveCount(0);
    await expect(faceplate).toBeVisible();

    // …and e replaces the full-view.
    await page.keyboard.press('e');
    await expect(faceplate).toHaveCount(0);
    await expect(drawer).toHaveAttribute('data-dock-type', 'electraControl');
  });

  // (4) ESC closes whichever occupant is open.
  test('ESC closes the current occupant — full-view or pinned drawer', async ({ page }) => {
    await gotoShellWorkflow(page);
    const { pill } = await spawnExpandableTile(page);
    const faceplate = page.getByTestId('dock-full-view');
    const drawer = page.getByTestId('dock-zone-bottom');

    // Full-view open → ESC closes it; nothing else opens behind it.
    await pill.click();
    await expect(faceplate).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(faceplate).toHaveCount(0);
    await expect(drawer).toHaveCount(0);
    await expect(pill).toContainText('EXPAND');

    // Pinned drawer open → ESC closes it.
    await page.keyboard.press('c');
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  });
});

// (6) THE SPLIT (owner extension): two side-by-side 50/50 panes, independent
// scroll, per-pane close, whole-split swap-out, and the TAB flip seam.
test.describe('full-view SPLIT: two panes, one drawer occupant (?shell=1)', () => {
  test.beforeEach(async ({ page }) => {
    await installRenderSmokeHooks(page);
  });

  /** Spawn TWO migrated modules and return their tiles' EXPAND pills. */
  async function spawnTwoTiles(page: Page) {
    await spawnPatch(page, [
      { id: 'm1', type: 'vca', position: { x: 30, y: 40 } },
      { id: 'm2', type: 'adsr', position: { x: 250, y: 40 } },
    ]);
    const tile1 = page.locator('.svelte-flow__node[data-id="m1"] [data-testid="module-shell"]');
    const tile2 = page.locator('.svelte-flow__node[data-id="m2"] [data-testid="module-shell"]');
    await expect(tile1).toBeVisible();
    await expect(tile2).toBeVisible();
    await panTileTo(page, 'm1', 90);
    return { pill1: tile1.getByTestId('shell-open-dock'), pill2: tile2.getByTestId('shell-open-dock') };
  }

  const paneOf = (page: Page, id: string) =>
    page.locator(`[data-testid="dock-fullview-pane"][data-pane-node="${id}"]`);

  test('A+B sit SIDE-BY-SIDE 50/50; each pane scrolls INDEPENDENTLY', async ({ page }) => {
    await gotoShellWorkflow(page);
    const { pill1, pill2 } = await spawnTwoTiles(page);
    const drawer = page.getByTestId('dock-fullview-drawer');

    await pill1.click();
    await expect(drawer).toHaveAttribute('data-pane-count', '1');
    await pill2.click();
    await expect(drawer).toHaveAttribute('data-pane-count', '2');
    await expect(pill1).toContainText('CLOSE');
    await expect(pill2).toContainText('CLOSE');

    // 50/50 GEOMETRY: A (opened first) left, B right; equal widths; the two
    // panes + the 8px gap fill the drawer's inner width.
    const a = (await paneOf(page, 'm1').boundingBox())!;
    const b = (await paneOf(page, 'm2').boundingBox())!;
    const d = (await drawer.boundingBox())!;
    expect(a.x, 'A renders LEFT of B (open order)').toBeLessThan(b.x);
    expect(Math.abs(a.width - b.width), 'panes split 50/50').toBeLessThanOrEqual(2);
    const GAP = b.x - (a.x + a.width);
    expect(GAP, 'the split gap sits between the panes').toBeGreaterThanOrEqual(4);
    expect(GAP).toBeLessThanOrEqual(16);
    // container padding (8px sides) + gap accounts for the leftover width
    expect(Math.abs(d.width - (a.width + b.width + GAP + 16)), '2 panes + gap + padding = drawer').toBeLessThanOrEqual(4);

    // INDEPENDENT SCROLL: each pane's .faceplate-scroll is its OWN overflow
    // container on BOTH axes (the kit faceplate's 900px min-width guarantees
    // horizontal travel in a half-width pane at the 1280px viewport).
    const scrollBoxes = page.locator('[data-testid="dock-fullview-pane"] .faceplate-scroll');
    await expect(scrollBoxes).toHaveCount(2);
    const overflow = await scrollBoxes.first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return { x: cs.overflowX, y: cs.overflowY };
    });
    expect(overflow, 'pane scroll container overflows on both axes').toEqual({ x: 'auto', y: 'auto' });
    // Scroll pane B sideways → B moves, A stays put (no shared scrollbar).
    const scrolled = await paneOf(page, 'm2')
      .locator('.faceplate-scroll')
      .evaluate((el) => {
        el.scrollLeft = 150;
        return { scrollable: el.scrollWidth > el.clientWidth, scrollLeft: el.scrollLeft };
      });
    expect(scrolled.scrollable, 'half-width pane has sideways overflow to scroll').toBe(true);
    expect(scrolled.scrollLeft, 'pane B scrolled').toBeGreaterThan(0);
    const aScroll = await paneOf(page, 'm1')
      .locator('.faceplate-scroll')
      .evaluate((el) => ({ left: el.scrollLeft, top: el.scrollTop }));
    expect(aScroll, 'pane A unmoved').toEqual({ left: 0, top: 0 });
  });

  test('closing ONE pane returns the survivor to full width', async ({ page }) => {
    await gotoShellWorkflow(page);
    const { pill1, pill2 } = await spawnTwoTiles(page);
    const drawer = page.getByTestId('dock-fullview-drawer');

    await pill1.click();
    await pill2.click();
    await expect(drawer).toHaveAttribute('data-pane-count', '2');

    // Close pane A via ITS ✕ — B remains, back at full drawer width.
    await paneOf(page, 'm1').getByTestId('faceplate-close').click();
    await expect(drawer).toHaveAttribute('data-pane-count', '1');
    await expect(paneOf(page, 'm1')).toHaveCount(0);
    await expect(paneOf(page, 'm2')).toBeVisible();
    const b = (await paneOf(page, 'm2').boundingBox())!;
    const d = (await drawer.boundingBox())!;
    expect(Math.abs(d.width - (b.width + 16)), 'survivor spans the drawer (minus padding)').toBeLessThanOrEqual(4);
    // The pills track per-module presence.
    await expect(pill1).toContainText('EXPAND');
    await expect(pill2).toContainText('CLOSE');
  });

  test('`c` closes the ENTIRE split and opens the pinned drawer', async ({ page }) => {
    await gotoShellWorkflow(page);
    const { pill1, pill2 } = await spawnTwoTiles(page);
    const drawer = page.getByTestId('dock-fullview-drawer');

    await pill1.click();
    await pill2.click();
    await expect(drawer).toHaveAttribute('data-pane-count', '2');

    await page.keyboard.press('c');
    await expect(drawer).toHaveCount(0); // both panes gone — not one
    const pinned = page.getByTestId('dock-zone-bottom');
    await expect(pinned).toBeVisible();
    await expect(pinned).toHaveAttribute('data-dock-type', 'clipplayer');
    await expect(pill1).toContainText('EXPAND');
    await expect(pill2).toContainText('EXPAND');
  });

  test('TAB toggles the rear-card flip seam attr on the open view', async ({ page }) => {
    await gotoShellWorkflow(page);
    const { pill1, pill2 } = await spawnTwoTiles(page);
    const drawer = page.getByTestId('dock-fullview-drawer');

    await pill1.click();
    await expect(drawer).toHaveAttribute('data-fullview-flipped', 'false');
    await page.keyboard.press('Tab');
    await expect(drawer).toHaveAttribute('data-fullview-flipped', 'true');
    // The flip is GLOBAL for the view: a second pane joins the flipped state.
    await pill2.click();
    await expect(drawer).toHaveAttribute('data-pane-count', '2');
    await expect(drawer).toHaveAttribute('data-fullview-flipped', 'true');
    await page.keyboard.press('Tab');
    await expect(drawer).toHaveAttribute('data-fullview-flipped', 'false');
  });
});

// (5) PREVIEW-OFF (?shell absent): the M/E/C drawer keymap is shipped legacy
// behavior — the unification must be a strict no-op there. No full-view
// exists (nothing can open one), and the drawer toggles exactly as today
// (the full sweep stays pinned in workflow-mode.spec.ts).
test.describe('bottom-drawer occupancy: preview-off is untouched', () => {
  test.beforeEach(async ({ page }) => {
    await installRenderSmokeHooks(page);
  });

  test('`c`/`m`/`e` toggle the shipped drawer; no full-view ever materializes', async ({ page }) => {
    await page.goto('/rack?mode=workflow');
    // Same 15s first-load budget as gotoShellWorkflow (cold-compile latency).
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });
    await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
    await waitForPinnedTrio(page);

    const drawer = page.getByTestId('dock-zone-bottom');
    const faceplate = page.getByTestId('dock-full-view');

    await page.keyboard.press('c');
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('data-dock-type', 'clipplayer');
    await expect(faceplate).toHaveCount(0);

    await page.keyboard.press('m');
    await expect(drawer).toHaveAttribute('data-dock-type', 'mixmstrs');
    await expect(faceplate).toHaveCount(0);

    await page.keyboard.press('m'); // same key toggles closed (shipped semantics)
    await expect(drawer).toHaveCount(0);
    await expect(faceplate).toHaveCount(0);
  });
});
