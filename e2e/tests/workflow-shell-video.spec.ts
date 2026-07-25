// e2e/tests/workflow-shell-video.spec.ts
//
// The `?shell=1` VIDEO VISIBILITY fix, end to end (owner regression: video
// modules rendered the generic placeholder tile with a FAKE dashed-wave glyph,
// so there was NO user-viewable video output anywhere in the shell; and the
// dock full-view mounted videoOut's legacy card DEAD — its bare useStore()
// threw outside the SvelteFlow provider, while DOOM, which never calls
// useStore, worked).
//
//   1. videoOut renders its REAL, freely-resizable LEGACY card in the video
//      zone (NON_SHELL video-surface snowflake): the video surface exists,
//      corner-resize works under the shell, and the video-zone render override
//      anchors POSITION while the card sizes ITSELF (a resize repacks the
//      neighbouring tiles — never overlaps them).
//   2. Video-domain tiles carry a LIVE ANIMATED THUMBNAIL of the module's
//      actual output (the legacy blitOutputToDrawingBuffer preview seam) in
//      the glyph slot — the fake wave is GONE for video modules — and the
//      thumbnail's blit DRIVES the real chain (engine draw counters advance)
//      and its pixels actually change.
//   3. The dock full-view shows LIVE video for expanded video legacy cards
//      (backdraft via the tile's EXPAND button; videoOut via the dev seam —
//      a NON_SHELL legacy lane card has no tile), holding a hard render lease
//      while open.
//   4. Preview OFF stays a strict no-op: no tiles, no thumbs, videoOut's card
//      exactly as today.
//
// DETERMINISM: chain liveness is asserted via ENGINE PROBES (framesDrawnFor —
// SwiftShader-tolerant); pixel-change asserts poll toDataURL inequality on a
// 2D canvas (renderer-tolerant: any two DIFFERENT frames of the auto-scrolling
// LINES pattern differ, no absolute pixel values are pinned).

import { test, expect, type Page } from '@playwright/test';

const VIDEO_OUT = 'workflow-videoOut';
const RECORDERBOX = 'workflow-recorderbox';
const SYNESTHESIA = 'workflow-synesthesia';

const VIDEO_ZONE_GAP = 24; // shell pitch 216 − tile 192 (videoZonePackedXs)

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack?mode=workflow&shell=1');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible();
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/** The seeded videoOut's LEGACY card in the lane (the carve-out under test). */
function videoOutCard(page: Page) {
  return page.locator(`.svelte-flow__node[data-id="${VIDEO_OUT}"] [data-testid="video-out-card"]`);
}

/** Boot the engine via the dev global (same seam spawnPatch uses). */
async function ensureEngine(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __ensureEngine?: () => Promise<unknown> };
    return typeof w.__ensureEngine === 'function';
  });
  await page.evaluate(async () => {
    const w = globalThis as unknown as { __ensureEngine: () => Promise<unknown> };
    await w.__ensureEngine();
  });
}

/** ADD nodes/edges to the live patch WITHOUT clearing it (spawnPatch clears —
 *  that would nuke the seeded video-zone defaults + pinned trio this spec is
 *  about). Same node/edge shape spawnPatch writes. */
async function injectPatch(
  page: Page,
  nodes: { id: string; type: string; position: { x: number; y: number } }[],
  edges: { id: string; from: { nodeId: string; portId: string }; to: { nodeId: string; portId: string }; sourceType: string; targetType: string }[] = [],
): Promise<void> {
  await ensureEngine(page);
  await page.evaluate(
    ({ nodes, edges }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (const n of nodes) {
          w.__patch.nodes[n.id] = {
            id: n.id,
            type: n.type,
            domain: 'video',
            position: n.position,
            params: {},
          };
        }
        for (const e of edges) {
          w.__patch.edges[e.id] = {
            id: e.id,
            source: e.from,
            target: e.to,
            sourceType: e.sourceType,
            targetType: e.targetType,
          };
        }
      });
    },
    { nodes, edges },
  );
  await page.waitForFunction(
    (ids) => ids.every((id) => document.querySelector(`.svelte-flow__node[data-id="${id}"]`) !== null),
    nodes.map((n) => n.id),
    { timeout: 10_000 },
  );
}

/** Center the viewport on a node at the given zoom (flow-space anchor). */
async function centerOnNode(page: Page, nodeId: string, zoom: number): Promise<void> {
  await page.evaluate(
    ({ nodeId, zoom }) => {
      const w = globalThis as unknown as {
        __flow: {
          getInternalNode: (id: string) => {
            internals?: { positionAbsolute?: { x: number; y: number } };
            position?: { x: number; y: number };
            measured?: { width?: number; height?: number };
          } | undefined;
          setViewport: (vp: { x: number; y: number; zoom: number }, o?: { duration?: number }) => void;
        };
      };
      const n = w.__flow.getInternalNode(nodeId);
      if (!n) return;
      const x = n.internals?.positionAbsolute?.x ?? n.position?.x ?? 0;
      const y = n.internals?.positionAbsolute?.y ?? n.position?.y ?? 0;
      const cw = (n.measured?.width ?? 200) / 2;
      const ch = (n.measured?.height ?? 200) / 2;
      const pane = document.querySelector('.svelte-flow') as HTMLElement;
      const r = pane.getBoundingClientRect();
      w.__flow.setViewport(
        { x: r.width / 2 - (x + cw) * zoom, y: r.height / 2 - (y + ch) * zoom, zoom },
        { duration: 0 },
      );
    },
    { nodeId, zoom },
  );
}

/** Flow-space top-left + measured size of a node (viewport-transform-immune). */
async function nodeRect(page: Page, id: string): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __flow?: {
        getInternalNode: (id: string) => {
          internals?: { positionAbsolute?: { x: number; y: number } };
          position?: { x: number; y: number };
          measured?: { width?: number; height?: number };
        } | undefined;
      };
    };
    const n = w.__flow?.getInternalNode(id);
    if (!n) return null;
    const x = n.internals?.positionAbsolute?.x ?? n.position?.x;
    const y = n.internals?.positionAbsolute?.y ?? n.position?.y;
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    return { x, y, w: n.measured?.width ?? 0, h: n.measured?.height ?? 0 };
  }, id);
}

/** The engine's per-node draw counter — the SwiftShader-proof liveness probe. */
async function framesDrawn(page: Page, id: string): Promise<number> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain: (d: string) => { framesDrawnFor: (id: string) => number } };
    };
    try {
      return w.__engine!().getDomain('video').framesDrawnFor(id);
    } catch {
      return -1;
    }
  }, id);
}

/** Snapshot a canvas's pixels (2D canvases only — all our preview canvases). */
async function canvasData(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel) => {
    const c = document.querySelector(sel) as HTMLCanvasElement | null;
    return c ? c.toDataURL() : '';
  }, selector);
}

/** Poll until the canvas's pixels CHANGE from `before` (a live picture). CI's
 *  SwiftShader renders slowly, so the budget is generous; the assert itself is
 *  renderer-tolerant (pure inequality between two frames of the same canvas). */
async function expectCanvasChanges(page: Page, selector: string, before: string, what: string): Promise<void> {
  await expect
    .poll(async () => (await canvasData(page, selector)) !== before, {
      message: `${what}: canvas pixels change between frames`,
      timeout: 20_000,
    })
    .toBe(true);
}

test.describe('?shell=1 video visibility', () => {
  test('videoOut renders its LEGACY resizable card in the video zone; corner-resize works and repacks the tile neighbours', async ({ page }) => {
    // Collect the exact failure class the dock/useStore regression produced —
    // a provider-context throw must never fire anywhere in this flow.
    const providerErrors: string[] = [];
    page.on('pageerror', (e) => {
      if (/useStore|SvelteFlowProvider/i.test(e.message)) providerErrors.push(e.message);
    });

    await gotoShell(page);

    // 1) The REAL card — not the placeholder, with its live video surface +
    //    its native resize handle.
    await expect(videoOutCard(page)).toBeVisible({ timeout: 15_000 });
    const laneNode = page.locator(`.svelte-flow__node[data-id="${VIDEO_OUT}"]`);
    await expect(laneNode.locator('[data-testid="module-shell-placeholder"]')).toHaveCount(0);
    await expect(laneNode.locator('[data-testid="video-out-canvas"]')).toBeVisible();
    await expect(laneNode.locator('[data-testid="video-out-resize-handle"]')).toHaveCount(1);

    // 2) PACKED zone: recorderbox's tile clears videoOut's ACTUAL width + the
    //    24px gutter (pre-fix the fixed 216px slots would overlap a 360-wide
    //    legacy card). Poll: the packed override lands after first measure.
    await expect(
      page.locator(`.svelte-flow__node[data-id="${RECORDERBOX}"] [data-testid="module-shell-placeholder"]`),
    ).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => {
        const vo = await nodeRect(page, VIDEO_OUT);
        const rb = await nodeRect(page, RECORDERBOX);
        if (!vo || !rb || vo.w === 0) return NaN;
        return rb.x - (vo.x + vo.w);
      }, { message: 'recorderbox tile sits one 24px gutter right of the legacy videoOut card', timeout: 10_000 })
      .toBe(VIDEO_ZONE_GAP);

    // 3) RESIZE under the shell: corner-drag at zoom 1 grows the card by whole
    //    180px rack tiles (the card's own resize contract) — the zone override
    //    anchors POSITION but never fights the card's SIZE.
    const before = await nodeRect(page, VIDEO_OUT);
    expect(before, 'videoOut internal node resolved').not.toBeNull();
    await centerOnNode(page, VIDEO_OUT, 1);
    const handle = laneNode.locator('[data-testid="video-out-resize-handle"]');
    const hb = await handle.boundingBox();
    expect(hb, 'resize handle on screen').toBeTruthy();
    if (!hb) return;
    const startX = hb.x + hb.width / 2;
    const startY = hb.y + hb.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // +170 screen px at zoom 1 → intrinsic 530 → quantized UP to 540 (3 tiles);
    // dy 0 keeps the height at its 360 default.
    await page.mouse.move(startX + 170, startY, { steps: 8 });
    await page.mouse.up();

    // Persisted (Y.Doc-synced) size took the quantized value…
    await expect
      .poll(async () =>
        page.evaluate((id) => {
          const w = globalThis as unknown as {
            __patch: { nodes: Record<string, { data?: { width?: number; height?: number } } | undefined> };
          };
          const d = w.__patch.nodes[id]?.data;
          return { w: d?.width ?? null, h: d?.height ?? null };
        }, VIDEO_OUT),
      { message: 'persisted node.data.width/height after the corner drag' })
      .toEqual({ w: 540, h: 360 });

    // …the RENDERED card box followed (its own size — nothing clamped it back
    // to a tile), and the zone override REPACKED the neighbour to clear it.
    await expect
      .poll(async () => (await nodeRect(page, VIDEO_OUT))?.w ?? NaN, { message: 'rendered card width follows the resize' })
      .toBe(540);
    await expect
      .poll(async () => {
        const vo = await nodeRect(page, VIDEO_OUT);
        const rb = await nodeRect(page, RECORDERBOX);
        if (!vo || !rb) return NaN;
        return rb.x - (vo.x + vo.w);
      }, { message: 'recorderbox repacked right of the RESIZED card', timeout: 10_000 })
      .toBe(VIDEO_ZONE_GAP);
    // Position stayed anchored on the zone slot (x unchanged by the resize).
    const after = await nodeRect(page, VIDEO_OUT);
    expect(after!.x, 'zone anchor X unchanged by resize').toBe(before!.x);

    expect(providerErrors, `no useStore/provider throws: ${providerErrors.join(' | ')}`).toEqual([]);
  });

  test('video-domain tiles show LIVE ANIMATED thumbnails via the real chain; the fake wave glyph is GONE for them', async ({ page }) => {
    await gotoShell(page);
    await expect(videoOutCard(page)).toBeVisible({ timeout: 15_000 });

    // A REAL animated chain: LINES (auto-scrolling procedural source) →
    // BACKDRAFT (the owner-named tile under test). Positioned on the free
    // canvas below the video zone — membership in a lane is irrelevant here.
    await injectPatch(
      page,
      [
        { id: 'l1', type: 'lines', position: { x: -1200, y: 4500 } },
        { id: 'b1', type: 'backdraft', position: { x: -700, y: 4500 } },
      ],
      [
        { id: 'e-lb', from: { nodeId: 'l1', portId: 'out' }, to: { nodeId: 'b1', portId: 'in_a' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );

    // Both spawn as placeholder tiles whose glyph slot is the LIVE THUMB —
    // and the fake dashed-wave SVG is GONE for video modules.
    for (const id of ['l1', 'b1', RECORDERBOX]) {
      const tile = page.locator(`.svelte-flow__node[data-id="${id}"] [data-testid="module-shell-placeholder"]`);
      await expect(tile, `${id} renders a placeholder tile`).toHaveCount(1);
      await expect(tile.locator('[data-testid="video-tile-thumb"]'), `${id} has the live thumb canvas`).toHaveCount(1);
      await expect(tile.locator('.tile-wave'), `${id} fake wave glyph gone`).toHaveCount(0);
    }
    // Boundary: synesthesia is AUDIO-domain (no engine surface) — it must NOT
    // get a (necessarily dead/black) video thumb.
    await expect(
      page.locator(`.svelte-flow__node[data-id="${SYNESTHESIA}"] [data-testid="video-tile-thumb"]`),
    ).toHaveCount(0);

    // Bring b1's tile on-screen so the visibility gate ARMS the tap…
    await centerOnNode(page, 'b1', 0.9);
    const thumbSel = `.svelte-flow__node[data-id="b1"] [data-testid="video-tile-thumb"]`;
    await expect(page.locator(thumbSel)).toBeVisible();

    // …the thumbnail's blit DRIVES the real chain (deterministic engine probe:
    // the per-node draw counter advances — the tap is the only watcher of b1)…
    const base = await framesDrawn(page, 'b1');
    expect(base, 'video engine reachable').toBeGreaterThanOrEqual(0);
    await expect
      .poll(async () => (await framesDrawn(page, 'b1')) - base, {
        message: 'backdraft draws frames while its tile thumb is on-screen',
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(2);

    // …and the PICTURE actually animates (two different frames).
    const first = await canvasData(page, thumbSel);
    expect(first, 'thumb canvas snapshot captured').not.toBe('');
    await expectCanvasChanges(page, thumbSel, first, 'b1 tile thumbnail');
  });

  test('dock full-view renders LIVE video for expanded video legacy cards (backdraft via EXPAND; videoOut via the dev seam) with a render lease', async ({ page }) => {
    const providerErrors: string[] = [];
    page.on('pageerror', (e) => {
      if (/useStore|SvelteFlowProvider/i.test(e.message)) providerErrors.push(e.message);
    });

    await gotoShell(page);
    await expect(videoOutCard(page)).toBeVisible({ timeout: 15_000 });

    // LINES feeds BOTH cards under test so their pictures animate: → backdraft
    // in_a, and → the seeded videoOut's in (its idle pattern is static).
    await injectPatch(
      page,
      [
        { id: 'l1', type: 'lines', position: { x: -1200, y: 4500 } },
        { id: 'b1', type: 'backdraft', position: { x: -700, y: 4500 } },
      ],
      [
        { id: 'e-lb', from: { nodeId: 'l1', portId: 'out' }, to: { nodeId: 'b1', portId: 'in_a' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-lo', from: { nodeId: 'l1', portId: 'out' }, to: { nodeId: VIDEO_OUT, portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );

    // (a) BACKDRAFT via the tile's EXPAND affordance — the user path. Pre-fix
    // its card DIED at init in the dock (bare useStore() outside the provider).
    await centerOnNode(page, 'b1', 0.9);
    const b1Tile = page.locator(`.svelte-flow__node[data-id="b1"] [data-testid="module-shell-placeholder"]`);
    await expect(b1Tile).toBeVisible();
    await b1Tile.getByTestId('shell-open-dock').click();
    const faceplate = page.getByTestId('dock-full-view');
    await expect(faceplate).toBeVisible();
    const dockBackdraft = faceplate.locator('[data-dock-card="b1"] [data-testid="backdraft-canvas"]');
    await expect(dockBackdraft, 'backdraft video surface mounts in the dock').toBeVisible();
    const bFirst = await canvasData(page, '[data-dock-card="b1"] [data-testid="backdraft-canvas"]');
    expect(bFirst).not.toBe('');
    await expectCanvasChanges(page, '[data-dock-card="b1"] [data-testid="backdraft-canvas"]', bFirst, 'docked backdraft');
    // Plain-mount contract holds: no xyflow handles/nodes inside the faceplate.
    await expect(faceplate.locator('.svelte-flow__handle')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(faceplate).toHaveCount(0);

    // (b) VIDEOOUT via the dev seam (a NON_SHELL legacy lane card has no tile /
    // EXPAND button). Same assertion DOOM passes: surface present AND rendering.
    await page.evaluate((id) => {
      const w = globalThis as unknown as { __openDockFullView: (id: string) => void };
      w.__openDockFullView(id);
    }, VIDEO_OUT);
    await expect(faceplate).toBeVisible();
    const dockOutSel = `[data-dock-card="${VIDEO_OUT}"] [data-testid="video-out-canvas"]`;
    await expect(faceplate.locator(dockOutSel), 'videoOut video surface mounts in the dock').toBeVisible();
    // The full-view holds a HARD render lease on the video node (the lane copy
    // may be off-screen; pull-eval must not decay the dock's live picture).
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const w = globalThis as unknown as {
            __engine: () => { getDomain: (d: string) => { pullStats: () => { leased: string[] } } };
          };
          return w.__engine().getDomain('video').pullStats().leased;
        }),
      { message: 'videoOut holds a render lease while its full-view is open' })
      .toContain(VIDEO_OUT);
    const oFirst = await canvasData(page, dockOutSel);
    expect(oFirst).not.toBe('');
    await expectCanvasChanges(page, dockOutSel, oFirst, 'docked videoOut (lines patched in)');
    await page.keyboard.press('Escape');
    await expect(faceplate).toHaveCount(0);
    // Lease released with the view.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const w = globalThis as unknown as {
            __engine: () => { getDomain: (d: string) => { pullStats: () => { leased: string[] } } };
          };
          return w.__engine().getDomain('video').pullStats().leased;
        }),
      { message: 'lease released when the full-view closes' })
      .not.toContain(VIDEO_OUT);

    expect(providerErrors, `no useStore/provider throws: ${providerErrors.join(' | ')}`).toEqual([]);
  });

  test('preview OFF (default) stays a strict no-op: no tiles, no thumbs, videoOut legacy card as today', async ({ page }) => {
    await page.goto('/rack?mode=workflow');
    await expect(page.getByTestId('workflow-topbar')).toBeVisible();
    await expect(videoOutCard(page)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="module-shell-placeholder"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="module-shell"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="video-tile-thumb"]')).toHaveCount(0);
  });
});
