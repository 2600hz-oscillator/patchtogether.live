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
const SHELL_COLUMN_W = 216; // channel-columns.ts SHELL_COLUMN_W (tight ?shell=1 pitch)
const SHELL_TILE_W = 192; // module-shell-model.ts SHELL_TILE_W / tokens --shell-tile-w
const TILE_H = { mini: 88, compact: 150, full: 180 } as const; // --tile-h-{mini,compact,full}
// channel-columns.ts vertical geometry: RACK_UNIT 180 → COLUMN_SLOT_H 720 →
// COLUMN_H 4320 → the baseline the lanes bottom-anchor to; the video zone is the
// backdraft-tall (3u = 540px) band directly BELOW it.
const COLUMN_BASELINE_Y = 4320; // COLUMN_TOP_Y(0) + COLUMN_SLOT_H(720) * COLUMN_MAX_SLOTS(6)
const VIDEO_AREA_HEIGHT = 540; // RACK_UNIT(180) * 3
/** Flow-space top-left X that CENTERS the uniform 192px tile in column `ch`'s tight
 *  216px band (columnCardX at the shell pitch) — the value the drop must persist. */
const shellColCardX = (ch: number) => (ch - 1) * SHELL_COLUMN_W + (SHELL_COLUMN_W - SHELL_TILE_W) / 2;

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

  test('lanes are the TIGHT ~216px shell pitch: drops land in the narrowed column + tiles fill the lane with no overlap', async ({ page }) => {
    // The RACKLINE narrowing: under ?shell=1 the app-scale 765px band collapses to
    // the mock's tight 216px lane pitch, so the uniform 192px tiles FILL their
    // lanes (24px gutter) instead of floating in huge gutters. Prove (a) a real
    // palette drop lands in the correct NARROWED column via the pitch-aware
    // hit-test, (b) the rendered column pitch is ~216px, and (c) tiles don't
    // overlap (clean gutter).
    const SHELL_COLUMN_W = 216;
    await gotoWorkflow(page, { shell: true });
    await waitForHooks(page);

    // Anchor each spawn INSIDE the narrow band of columns 1..3 (X selects the
    // column at the tight pitch — the same frame the rendered lanes live in).
    const shellColPos = (ch: number) => ({ x: (ch - 1) * SHELL_COLUMN_W + 30, y: 40 });
    const types = ['tidyVco', 'vca', 'delay'];
    for (let i = 0; i < types.length; i++) {
      await page.evaluate(
        ({ type, pos }) => {
          const w = globalThis as unknown as {
            __setSpawnFlowPos: (p: { x: number; y: number }) => void;
            __spawnFromPalette: (t: string) => void;
          };
          w.__setSpawnFlowPos(pos);
          w.__spawnFromPalette(type);
        },
        { type: types[i], pos: shellColPos(i + 1) },
      );
      await page.waitForTimeout(250);
    }

    // (a) Each drop landed in the intended narrowed column: channels 1, 2, 3 each
    //     hold exactly one member (the pitch-aware hit-test resolved the column).
    const counts = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { columns?: Record<string, string[]> } } | undefined> };
      };
      const cols = w.__patch.nodes['pinned-mixmstrs']?.data?.columns ?? {};
      return [1, 2, 3].map((ch) => (cols[String(ch)] ?? []).length);
    });
    expect(counts, 'each drop joined its own narrowed column').toEqual([1, 1, 1]);

    // (b)+(c) Read the RENDERED flow-space X + tile width of each column head.
    const tiles = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __flow: { getInternalNode: (id: string) => { internals?: { positionAbsolute?: { x: number } }; position?: { x: number } } | undefined };
        __patch: { nodes: Record<string, { data?: { columns?: Record<string, string[]> } } | undefined> };
      };
      const cols = w.__patch.nodes['pinned-mixmstrs']?.data?.columns ?? {};
      const out: { ch: number; x: number; w: number }[] = [];
      for (const ch of [1, 2, 3]) {
        const id = (cols[String(ch)] ?? [])[0];
        if (!id) continue;
        const inode = w.__flow.getInternalNode(id);
        const x = inode?.internals?.positionAbsolute?.x ?? inode?.position?.x ?? NaN;
        const el = document.querySelector(
          `.svelte-flow__node[data-id="${id}"] [data-testid="module-shell-placeholder"], .svelte-flow__node[data-id="${id}"] [data-testid="module-shell"]`,
        ) as HTMLElement | null;
        out.push({ ch, x, w: el?.offsetWidth ?? 0 });
      }
      return out;
    });
    expect(tiles.length).toBe(3);

    // (b) Consecutive column heads are ~SHELL_COLUMN_W (216px) apart — the tight
    //     pitch (NOT the old 765px). ±1px for sub-pixel rounding.
    for (let i = 1; i < tiles.length; i++) {
      const delta = tiles[i].x - tiles[i - 1].x;
      expect(delta, `column ${tiles[i - 1].ch}→${tiles[i].ch} pitch ≈ ${SHELL_COLUMN_W}`).toBeGreaterThanOrEqual(SHELL_COLUMN_W - 1);
      expect(delta).toBeLessThanOrEqual(SHELL_COLUMN_W + 1);
    }

    // (c) Every tile is the uniform SHELL_TILE_W (fills the lane), and tiles do
    //     NOT overlap: each tile's right edge sits left of the next tile's left
    //     edge (a clean gutter, no collision).
    for (const t of tiles) expect(t.w).toBe(SHELL_TILE_W);
    for (let i = 1; i < tiles.length; i++) {
      expect(tiles[i - 1].x + tiles[i - 1].w, 'no horizontal overlap between adjacent tiles').toBeLessThanOrEqual(tiles[i].x + 1);
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

// ─── P0.3b ?shell=1 bug fixes (video-zone inset · lane-snap · expand button) ──
test.describe('P0.3b workflow-shell ?shell=1 bug fixes', () => {
  const VZONE_IDS = ['workflow-videoOut', 'workflow-recorderbox', 'workflow-synesthesia'];

  /** Drop `type` at the tight SHELL pitch so the pitch-aware hit-test resolves the
   *  intended narrowed column `ch` (the wide COLUMN_W anchor would land elsewhere). */
  async function dropInShellColumn(page: Page, type: string, ch: number): Promise<void> {
    await page.evaluate(
      ({ type, pos }) => {
        const w = globalThis as unknown as {
          __setSpawnFlowPos: (p: { x: number; y: number }) => void;
          __spawnFromPalette: (t: string) => void;
        };
        w.__setSpawnFlowPos(pos);
        w.__spawnFromPalette(type);
      },
      { type, pos: { x: (ch - 1) * SHELL_COLUMN_W + 30, y: 40 } },
    );
  }

  /** Flow-space top-left of a node (immune to the xyflow viewport transform). */
  async function flowPos(page: Page, id: string): Promise<{ x: number; y: number; h: number } | null> {
    return page.evaluate((id) => {
      const f = (globalThis as any).__flow;
      const n = f?.getInternalNode(id);
      if (!n) return null;
      const x = n.internals?.positionAbsolute?.x ?? n.position?.x;
      const y = n.internals?.positionAbsolute?.y ?? n.position?.y;
      const h = n.measured?.height ?? 0;
      return typeof x === 'number' && typeof y === 'number' ? { x, y, h } : null;
    }, id);
  }

  // BUG 1 — the video-zone default tiles used to anchor their TOP flush on
  // COLUMN_BASELINE_Y (== the zone's dashed top edge / "VIDEO" label), so the top
  // jack rail straddled the line + collided with the lane-number badges. The shell
  // render override now insets them DOWN, fully inside the darker video area.
  test('video-zone tiles sit INSIDE the video area (below COLUMN_BASELINE_Y)', async ({ page }) => {
    await gotoWorkflow(page, { shell: true });
    for (const id of VZONE_IDS) {
      await expect(
        page.locator(`.svelte-flow__node[data-id="${id}"] [data-testid="module-shell-placeholder"]`),
      ).toBeVisible({ timeout: 15_000 });
    }
    for (const id of VZONE_IDS) {
      const p = await flowPos(page, id);
      expect(p, `${id} internal node resolved`).not.toBeNull();
      // TOP strictly BELOW the baseline (the dashed video line) — pre-fix it sat
      // exactly ON it (p.y === COLUMN_BASELINE_Y). ±1px sub-pixel tolerance.
      expect(p!.y, `${id} tile top is below the video-zone baseline`).toBeGreaterThan(COLUMN_BASELINE_Y + 1);
      // …and the whole tile stays INSIDE the 540px video area (top well within it).
      expect(p!.y, `${id} tile top is inside the video area`).toBeLessThan(COLUMN_BASELINE_Y + VIDEO_AREA_HEIGHT);
    }
  });

  // BUG 2 — a palette drop into a lane persisted its X at the WIDE 765px slot
  // (columnFlushPositions with no pitch), while the render override used the tight
  // 216px pitch — so for the frame before the override snapped it, the tile landed
  // far right of the lane ("off-lane"). The persisted X now uses the active pitch,
  // so persisted + rendered both equal the tight column centre, flush-stacked.
  test('a lane drop persists + renders at the tight column centre, flush-stacked, no invalid state', async ({ page }) => {
    await gotoWorkflow(page, { shell: true });
    await waitForHooks(page);
    for (const t of ['tidyVco', 'vca']) {
      await dropInShellColumn(page, t, 1);
      await page.waitForTimeout(250);
    }

    // No invalid state: both drops joined channel 1's order (the membership truth).
    const order = await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: { columns?: Record<string, string[]> } } | undefined> };
      };
      return w.__patch.nodes['pinned-mixmstrs']?.data?.columns?.['1'] ?? [];
    });
    expect(order.length, 'both modules joined channel 1').toBe(2);

    // PERSISTED position (the BUG-2 regression): each member's stored top-left X is
    // the TIGHT column-card X (12px), NOT the wide 765-band value (286.5) it was.
    const persisted = await page.evaluate((ids) => {
      const w = globalThis as unknown as { __patch: { nodes: Record<string, { position?: { x: number } } | undefined> } };
      return ids.map((id) => w.__patch.nodes[id]?.position?.x ?? NaN);
    }, order);
    for (const x of persisted) expect(Math.abs(x - shellColCardX(1)), `persisted X == tight column-card X (${shellColCardX(1)})`).toBeLessThanOrEqual(1);

    // RENDERED position: same tight X, and the tile CENTRE lands on the column band
    // centre (card-centre == channel-number centre) — the "renders at the column
    // centre" guarantee.
    const bandCenter = (1 - 1) * SHELL_COLUMN_W + SHELL_COLUMN_W / 2; // 108
    const tiles: { x: number; y: number; h: number }[] = [];
    for (const id of order) {
      const p = await flowPos(page, id);
      expect(p, `${id} internal node resolved`).not.toBeNull();
      expect(Math.abs(p!.x - shellColCardX(1)), 'rendered X == tight column-card X').toBeLessThanOrEqual(1);
      expect(Math.abs(p!.x + SHELL_TILE_W / 2 - bandCenter), 'tile centre == column band centre').toBeLessThanOrEqual(1);
      tiles.push(p!);
    }

    // FLUSH stack (no overlap, no gap): the two members' flow-space tops are exactly
    // one measured tile-height apart.
    tiles.sort((a, b) => a.y - b.y);
    const gap = tiles[1].y - tiles[0].y;
    expect(gap).toBeGreaterThanOrEqual(tiles[0].h - 1);
    expect(gap).toBeLessThanOrEqual(tiles[0].h + 1);
  });

  // BUG 3 — the "open full module in the dock" affordance was a tiny faint glyph-
  // only button (undiscoverable). It is now a clear, LABELLED pill; the wired path
  // (onExpand → dockStore.openFullView → the .dock-faceplate full view) is unchanged.
  test('the EXPAND affordance is a labelled button that opens the dock faceplate + ESC closes', async ({ page }) => {
    await gotoWorkflow(page, { shell: true });
    await spawnPatch(page, [{ id: NODE, type: 'vca', position: { x: 460, y: 240 } }]);

    const laneNode = page.locator(`.svelte-flow__node[data-id="${NODE}"]`);
    const placeholder = laneNode.locator('[data-testid="module-shell-placeholder"]');
    await expect(placeholder).toBeVisible();

    const expandBtn = placeholder.getByTestId('shell-open-dock');
    await expect(expandBtn).toBeVisible();
    // DISCOVERABILITY: the button carries a readable text LABEL (not a bare glyph),
    // so it reads as a clear "expand" action.
    await expect(expandBtn).toContainText('EXPAND');

    // The wired full path still works: click → the RACKLINE .dock-faceplate opens.
    await expandBtn.click();
    const faceplate = page.getByTestId('dock-full-view');
    await expect(faceplate).toBeVisible();
    await expect(faceplate).toHaveClass(/dock-faceplate/);

    // ESC closes it; the lane placeholder remains.
    await page.keyboard.press('Escape');
    await expect(faceplate).toHaveCount(0);
    await expect(placeholder).toBeVisible();
  });
});
