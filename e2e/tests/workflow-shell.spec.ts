// e2e/tests/workflow-shell.spec.ts
//
// P0.3b — the WORKFLOW-SHELL legacy-fallback bridge, end to end. Proves the
// core day-one guarantee: under the `?shell=1` preview an UN-MIGRATED module
// renders a uniform styled PLACEHOLDER in its lane (cables stay attached), while
// its REAL, unchanged legacy card opens verbatim in the bottom dock full-view
// and is fully OPERABLE there (drive a control → the graph param changes).
//
// And the NO-OP guarantee: with the preview OFF (the default) the module renders
// its real card in the lane EXACTLY as today — the bridge is inert until owner
// sign-off, so nothing else in workflow mode changes.
//
// Runs on /rack?mode=workflow (no DB/relay) — the normal e2e lane, same as
// workflow-dock.spec.ts. Shell state is transient/local (never in the Y.Doc).

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

async function gotoWorkflow(page: Page, opts: { shell: boolean }): Promise<void> {
  await page.goto(opts.shell ? '/rack?mode=workflow&shell=1' : '/rack?mode=workflow');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible();
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** Read one node param through the dev __patch global. */
async function readParam(page: Page, nodeId: string, paramId: string): Promise<number | undefined> {
  return page.evaluate(
    ({ nodeId, paramId }) => {
      const w = globalThis as unknown as {
        __patch?: { nodes: Record<string, { params?: Record<string, number> } | undefined> };
      };
      return w.__patch?.nodes?.[nodeId]?.params?.[paramId];
    },
    { nodeId, paramId },
  );
}

const NODE = 'v1';

// ── RACKLINE tile-geometry re-spec helpers ──────────────────────────────────
// channel-columns.ts geometry (kept in sync with the pure module).
const COLUMN_W = 765; // 34 * HP_UNIT(22.5)
const SHELL_TILE_W = 192; // module-shell-model.ts SHELL_TILE_W / tokens --shell-tile-w
const TILE_H = { mini: 88, compact: 150, full: 180 } as const; // --tile-h-{mini,compact,full}

/** A flow-space spawn anchor inside channel column `ch` (X selects the column). */
function colPos(ch: number): { x: number; y: number } {
  return { x: (ch - 1) * COLUMN_W + 60, y: 40 };
}

/** Wait until the Canvas dev spawn/viewport hooks are registered. */
async function waitForHooks(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const w = globalThis as unknown as { __setSpawnFlowPos?: unknown; __spawnFromPalette?: unknown; __flow?: unknown };
      return typeof w.__setSpawnFlowPos === 'function' && typeof w.__spawnFromPalette === 'function' && !!w.__flow;
    },
    undefined,
    { timeout: 20_000 },
  );
}

/** Drive the REAL palette-drop path into channel column `ch`. */
async function dropInColumn(page: Page, type: string, ch: number): Promise<void> {
  await page.evaluate(
    ({ type, pos }) => {
      const w = globalThis as unknown as {
        __setSpawnFlowPos: (p: { x: number; y: number }) => void;
        __spawnFromPalette: (t: string) => void;
      };
      w.__setSpawnFlowPos(pos);
      w.__spawnFromPalette(type);
    },
    { type, pos: colPos(ch) },
  );
}

/** UNSCALED layout metrics of every mounted shell/placeholder tile — offsetWidth/
 *  Height are immune to the xyflow viewport zoom transform, so they are the TRUE
 *  tile px + data-shell-tier. */
async function measureTiles(page: Page): Promise<{ node: string | null; tier: string | null; w: number; h: number }[]> {
  return page.evaluate(() => {
    const tiles = Array.from(
      document.querySelectorAll('[data-testid="module-shell-placeholder"], [data-testid="module-shell"]'),
    ) as HTMLElement[];
    return tiles.map((t) => ({
      node: t.getAttribute('data-shell-node'),
      tier: t.getAttribute('data-shell-tier'),
      w: t.offsetWidth,
      h: t.offsetHeight,
    }));
  });
}

/** Set the viewport ZOOM (keeps pan) and wait for the LOD tier to settle to the
 *  expected string on every tile. Programmatic setViewport publishes the zoom to
 *  the shared LOD store, so the tiles re-key their data-shell-tier + height. */
async function setZoomTier(page: Page, zoom: number, expectTier: string): Promise<void> {
  await page.evaluate((zoom) => {
    const f = (globalThis as any).__flow;
    const vp = f.getViewport();
    f.setViewport({ x: vp.x, y: vp.y, zoom }, { duration: 0 });
  }, zoom);
  await page.waitForFunction(
    (tier) => {
      const tiles = Array.from(document.querySelectorAll('[data-shell-tier]'));
      return tiles.length > 0 && tiles.every((t) => t.getAttribute('data-shell-tier') === tier);
    },
    expectTier,
    { timeout: 10_000 },
  );
}

test.describe('P0.3b workflow-shell legacy-fallback bridge', () => {
  test('un-migrated module → placeholder in lane + legacy card operable in the dock', async ({ page }) => {
    await gotoWorkflow(page, { shell: true });
    await spawnPatch(page, [{ id: NODE, type: 'vca', position: { x: 460, y: 240 } }]);

    const laneNode = page.locator(`.svelte-flow__node[data-id="${NODE}"]`);
    await expect(laneNode).toHaveCount(1);

    // 1) The lane shows the UNIFORM PLACEHOLDER — not the legacy vca card.
    const placeholder = laneNode.locator('[data-testid="module-shell-placeholder"]');
    await expect(placeholder).toBeVisible();
    // No legacy controls in the lane (they moved to the dock):
    await expect(laneNode.locator('[data-testid^="control-"]')).toHaveCount(0);
    // Cables stay attached: the node keeps its full invisible handle stack.
    await expect(laneNode.locator('.svelte-flow__handle').first()).toHaveCount(1);

    // 2) Open in dock (the jack-rail "⤢" expand) → the RACKLINE full-view
    //    FACEPLATE opens in the bottom drawer (NOT a generic .dock-card).
    await placeholder.getByTestId('shell-open-dock').click();
    const faceplate = page.getByTestId('dock-full-view');
    await expect(faceplate).toBeVisible();
    // The spec chrome: grip, title bar (badge + name + mono sub), the window-
    // control trio (collapse + close in P0.3b; undock omitted), the tab-rail
    // seam with a single "MODULE" tab, and the domain-classed faceplate frame.
    await expect(faceplate.getByTestId('faceplate-grip')).toBeVisible();
    await expect(faceplate.locator('.faceplate-bar .face-badge')).toBeVisible();
    await expect(faceplate.locator('.faceplate-bar .face-name')).toBeVisible();
    // The mono sub reads "<module label> · lane N" — assert the "lane" descriptor.
    await expect(faceplate.locator('.faceplate-bar .face-sub')).toBeVisible();
    await expect(faceplate.getByTestId('faceplate-close')).toBeVisible();
    await expect(faceplate.getByTestId('faceplate-collapse')).toBeVisible();
    await expect(faceplate.getByTestId('faceplate-tab')).toHaveText('MODULE');
    await expect(faceplate.locator('.faceplate.audio')).toHaveCount(1); // vca = audio domain

    // …and the REAL, unchanged legacy card mounts verbatim in .editor at native
    //  scale (carrying the data-dock-card anchor so PickupCable/patch-menu work).
    const dockCard = faceplate.getByTestId('faceplate-editor').locator(`[data-dock-card="${NODE}"]`);
    await expect(dockCard).toBeVisible();
    await expect(dockCard.locator('.mod-card, .card, .moog-panel').first()).toBeVisible();
    // The faceplate hosts NO xyflow handles / node wrappers (PatchPanel self-gates):
    await expect(faceplate.locator('.svelte-flow__handle')).toHaveCount(0);
    await expect(faceplate.locator('.svelte-flow__node')).toHaveCount(0);

    // 3) The lane placeholder STILL shows (Option #1: lane face + dock faceplate
    //    coexist — the module was never persist-docked / swapped to a stub).
    await expect(placeholder).toBeVisible();
    await expect(laneNode.locator('[data-testid="dock-stub"]')).toHaveCount(0);

    // 4) Drive a control in the mounted card → the graph param changes (operable).
    const before = await readParam(page, NODE, 'base');
    const track = dockCard.locator('.fader-wrap .track').first();
    const box = await track.boundingBox();
    expect(box, 'a fader track should be present in the docked card').toBeTruthy();
    if (!box) return;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx, cy - 34, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    const after = await readParam(page, NODE, 'base');
    expect(after, `base should change after driving the fader (was ${before}, now ${after})`).not.toBe(before);

    // 5) ESC closes the full-view faceplate; the placeholder remains in the lane.
    await page.keyboard.press('Escape');
    await expect(faceplate).toHaveCount(0);
    await expect(placeholder).toBeVisible();
  });

  test('placeholder tiles are UNIFORM WIDTH + uniform per-tier height with a consistent badge anchor', async ({ page }) => {
    // The owner "same-size all modules HORIZONTALLY" + "tiles non-uniform / smaller
    // than the mock" fix: under ?shell=1 the default video-zone trio (videoOut
    // 'dynamic', recorderbox 2u, synesthesia 3u — three DIFFERENT rack tiers, so
    // three different LEGACY widths) all render as the SAME uniform RACKLINE tile —
    // identical WIDTH (SHELL_TILE_W) and identical HEIGHT (the current LOD tier),
    // so the baseline number badges cap them flush.
    await gotoWorkflow(page, { shell: true });
    const ids = ['workflow-videoOut', 'workflow-recorderbox', 'workflow-synesthesia'];
    for (const id of ids) {
      await expect(
        page.locator(`.svelte-flow__node[data-id="${id}"] [data-testid="module-shell-placeholder"]`),
      ).toBeVisible({ timeout: 15_000 });
    }

    const metrics = await page.evaluate((nodeIds) => {
      return nodeIds.map((id) => {
        const tile = document.querySelector(
          `.svelte-flow__node[data-id="${id}"] [data-testid="module-shell-placeholder"]`,
        ) as HTMLElement | null;
        const badge = tile?.querySelector('.tile-badge') as HTMLElement | null;
        if (!tile || !badge) return null;
        // offset* are UNSCALED layout px (immune to the xyflow viewport zoom
        // transform): the TRUE tile W/H + the badge's anchor within the tile.
        return { w: tile.offsetWidth, h: tile.offsetHeight, tier: tile.getAttribute('data-shell-tier'), badgeTop: badge.offsetTop };
      });
    }, ids);

    expect(metrics.every((m) => m !== null), 'all three placeholders resolved').toBe(true);
    // UNIFORM WIDTH — every tile the SAME SHELL_TILE_W across three rack tiers.
    for (const m of metrics) expect(m!.w).toBe(SHELL_TILE_W);
    // UNIFORM HEIGHT — every tile the SAME height (the current LOD tier's value),
    // which is one of the three per-tier design points (no longer a flat 88).
    const h0 = metrics[0]!.h;
    for (const m of metrics) expect(m!.h).toBe(h0);
    expect(Object.values(TILE_H)).toContain(h0);
    expect(TILE_H[metrics[0]!.tier as keyof typeof TILE_H]).toBe(h0);
    // The badge sits at an IDENTICAL offset from each tile's top (the anchor no
    // longer floats mid-card because the tiles are uniform).
    const badgeTops = metrics.map((m) => m!.badgeTop);
    expect(Math.max(...badgeTops) - Math.min(...badgeTops)).toBeLessThanOrEqual(1);
  });

  test('column members are UNIFORM width + FLUSH-stacked (no overlap, no gap)', async ({ page }) => {
    // Stack a real source→fx chain in ONE channel column via the REAL palette-drop
    // path, then prove every tile is the SAME width/height AND the stack is flush
    // (each member's flow-space slot is exactly one tile-height above the next —
    // no overlap, no gap), so the reserved slot == the rendered tile at every zoom.
    await gotoWorkflow(page, { shell: true });
    await waitForHooks(page);
    const types = ['tidyVco', 'vca', 'delay'];
    for (const t of types) {
      await dropInColumn(page, t, 1);
      await page.waitForTimeout(250);
    }
    // The three ch1 members are placeholders in the lane.
    await expect(page.locator('[data-testid="module-shell-placeholder"]')).not.toHaveCount(0);

    // Uniform width + height across every mounted tile.
    const tiles = await measureTiles(page);
    expect(tiles.length).toBeGreaterThanOrEqual(types.length);
    expect(new Set(tiles.map((t) => t.w)).size, 'one uniform width').toBe(1);
    expect(tiles[0].w).toBe(SHELL_TILE_W);
    expect(new Set(tiles.map((t) => t.h)).size, 'one uniform height').toBe(1);

    // FLUSH stacking: the ch1 members' flow-space TOP-Y are exactly one measured
    // tile-height apart (immune to the viewport transform) — no overlap, no gap.
    const stack = await page.evaluate(() => {
      const f = (globalThis as any).__flow;
      const patch = (globalThis as any).__patch;
      const out: { y: number; h: number }[] = [];
      for (const nid of Object.keys(patch.nodes)) {
        if (patch.nodes[nid]?.data?.channel !== 1) continue;
        const inode = f.getInternalNode(nid);
        const y = inode?.internals?.positionAbsolute?.y ?? inode?.position?.y;
        const h = inode?.measured?.height;
        if (typeof y === 'number' && typeof h === 'number') out.push({ y, h });
      }
      return out.sort((a, b) => a.y - b.y);
    });
    expect(stack.length).toBe(types.length);
    for (let i = 1; i < stack.length; i++) {
      const gap = stack[i].y - stack[i - 1].y;
      // gap == the previous tile's height → tiles ABUT: no overlap (gap ≥ h) AND
      // no empty space (gap ≤ h). ±1px for sub-pixel rounding.
      expect(gap).toBeGreaterThanOrEqual(stack[i - 1].h - 1);
      expect(gap).toBeLessThanOrEqual(stack[i - 1].h + 1);
    }
  });

  test('tiles PROMOTE per LOD tier: uniform height grows mini→compact→full as you zoom in', async ({ page }) => {
    await gotoWorkflow(page, { shell: true });
    await waitForHooks(page);
    for (const t of ['tidyVco', 'vca']) {
      await dropInColumn(page, t, 1);
      await page.waitForTimeout(250);
    }
    await expect(page.locator('[data-testid="module-shell-placeholder"]')).not.toHaveCount(0);

    // mini (zoomed way out) → compact → full (zoomed in): the tile height grows,
    // and every tile stays UNIFORM (same width, same height) at each tier.
    const seen: number[] = [];
    for (const [zoom, tier] of [[0.2, 'mini'], [0.4, 'compact'], [0.7, 'full']] as const) {
      await setZoomTier(page, zoom, tier);
      const tiles = await measureTiles(page);
      expect(new Set(tiles.map((t) => t.w)).size, `${tier}: uniform width`).toBe(1);
      expect(tiles[0].w, `${tier}: SHELL_TILE_W`).toBe(SHELL_TILE_W);
      expect(new Set(tiles.map((t) => t.h)).size, `${tier}: uniform height`).toBe(1);
      expect(tiles[0].h, `${tier}: matches token`).toBe(TILE_H[tier]);
      seen.push(tiles[0].h);
    }
    // strictly growing across the tiers (the promotion).
    expect(seen[0]).toBeLessThan(seen[1]);
    expect(seen[1]).toBeLessThan(seen[2]);
  });

  test('preview OFF (default) is a strict no-op: the legacy card renders in the lane', async ({ page }) => {
    await gotoWorkflow(page, { shell: false });
    await spawnPatch(page, [{ id: NODE, type: 'vca', position: { x: 460, y: 240 } }]);

    const laneNode = page.locator(`.svelte-flow__node[data-id="${NODE}"]`);
    await expect(laneNode).toHaveCount(1);
    // The REAL card + its controls render in the lane, exactly as today.
    await expect(laneNode.locator('[data-testid="control-base"]')).toBeVisible();
    // …and NO placeholder is emitted.
    await expect(laneNode.locator('[data-testid="module-shell-placeholder"]')).toHaveCount(0);
  });
});
