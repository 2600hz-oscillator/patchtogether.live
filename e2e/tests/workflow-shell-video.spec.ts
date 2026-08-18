// e2e/tests/workflow-shell-video.spec.ts
//
// The `?shell=1` VIDEO VISIBILITY fix, end to end (owner regression: video
// modules rendered the generic placeholder tile with a FAKE dashed-wave glyph,
// so there was NO user-viewable video output anywhere in the shell; and the
// dock full-view mounted videoOut's legacy card DEAD — its bare useStore()
// threw outside the SvelteFlow provider, while DOOM, which never calls
// useStore, worked).
//
//   1. videoOut renders a FACE TILE carrying a live picture in the video zone,
//      and the freely resizable screen is the DETACHED DISPLAY (#1821). ⚠ This
//      bullet used to read "its REAL, freely-resizable LEGACY card … NON_SHELL
//      video-surface snowflake"; videoOut now has a `face`, so the swap lands on
//      a ModuleShell with a live VideoTileThumb rather than the placeholder that
//      caused the original regression.
//   2. Video-domain tiles carry a LIVE ANIMATED THUMBNAIL of the module's
//      actual output (the legacy blitOutputToDrawingBuffer preview seam) in
//      the glyph slot — the fake wave is GONE for video modules — and the
//      thumbnail's blit DRIVES the real chain (engine draw counters advance)
//      and its pixels actually change.
//   3. The dock full-view shows LIVE video for expanded video modules, holding
//      a hard render lease while open. ⚠ videoOut reaches it through its own
//      EXPAND pill now (it has a tile); the dev seam it used to need is kept
//      here only for the modules that still have no tile.
//   4. `?shell=legacy` stays a strict no-op: no tiles, no thumbs, and videoOut's
//      verbatim card exactly as before — the escape hatch has to stay honest.
//
// DETERMINISM: chain liveness is asserted via ENGINE PROBES (framesDrawnFor —
// SwiftShader-tolerant); pixel-change asserts poll toDataURL inequality on a
// 2D canvas (renderer-tolerant: any two DIFFERENT frames of the auto-scrolling
// LINES pattern differ, no absolute pixel values are pinned).

import { test, expect, type Page } from '@playwright/test';

// CI (and a local E2E_SWIFTSHADER=1 flake-check) rasterize WebGL on the
// SwiftShader SOFTWARE renderer. With several live video surfaces churning
// (lines → backdraft → videoOut + the dock full-view's render lease), EVERY
// step crawls — CI shard 10 (run 30179147114) measured 8.8s for the EXPAND
// click and ~1s per page.evaluate, so the dock full-view test starved its flat
// default 30s TEST budget mid-way (both attempts) while every individual step
// kept completing. Repo rule (ci-swiftshader-video-e2e-timeouts): scale by the
// render load, never flat. The per-step budgets below are already generous and
// renderer-tolerant; only the whole-test ceiling needs the software-renderer
// scale. Real-GPU local runs keep the default 30s.
const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

const VIDEO_OUT = 'workflow-videoOut';
const RECORDERBOX = 'workflow-recorderbox';
const SYNESTHESIA = 'workflow-synesthesia';

const VIDEO_ZONE_GAP = 24; // shell pitch 216 − tile 192 (videoZonePackedXs)

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
  // 15s: first paint pays SvelteKit's on-demand route compile on a cold dev
  // server (and SwiftShader contention on CI) — same budget the sibling
  // first-visibility asserts use.
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

/**
 * The seeded videoOut's LANE SURFACE.
 *
 * ⚠ IT IS A SHELL TILE NOW, not the legacy card (#1821). This helper used to
 * return `[data-testid="video-out-card"]` and was named `videoOutCard`, because
 * videoOut was a NON_SHELL_LANE_TYPE carve-out — held back on its verbatim card
 * after a PLACEHOLDER tile removed the only user-viewable video output. It now
 * carries a real `face`, so the swap lands on a `ModuleShell` painting the LIVE
 * `VideoTileThumb`, and the big picture moved to right-click → DETACH DISPLAY.
 * Most call sites below use this purely as a "the video zone has mounted" gate.
 */
function videoOutLane(page: Page) {
  return page.locator(`.svelte-flow__node[data-id="${VIDEO_OUT}"] [data-testid="module-shell"]`);
}

/** The same node under `?shell=legacy`, where the verbatim card still renders —
 *  the escape hatch, which promotion must NOT change. */
function videoOutLegacyCard(page: Page) {
  return page.locator(`.svelte-flow__node[data-id="${VIDEO_OUT}"] [data-testid="video-out-card"]`);
}

/** The videoOut surface that paints in a given mode: the face tile's live thumb
 *  under the default shell, the legacy card's canvas under `?shell=legacy`.
 *  ⚠ Mode-dependent BY NECESSITY — the two renderers are the subject of the
 *  parity claim, so one selector for both would be asserting about whichever
 *  happened to exist. */
function videoOutSurfaceSel(url: string): string {
  return url.includes('shell=legacy')
    ? `.svelte-flow__node[data-id="${VIDEO_OUT}"] [data-testid="video-out-canvas"]`
    : `.svelte-flow__node[data-id="${VIDEO_OUT}"] [data-testid="module-shell"] canvas`;
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
  test('videoOut renders a FACE TILE with a live picture in the video zone, and DETACH is the resizable display', async ({ page }) => {
    // ⚠ THIS TEST IS THE INVERSE OF THE ONE IT REPLACES, and the reversal is the
    // point. It used to assert videoOut kept its verbatim LEGACY card with its
    // own corner-resize handle, because a PLACEHOLDER tile had removed the only
    // user-viewable video output (the owner ?shell=1 regression). #1821 removes
    // the cause instead of the symptom: videoOut carries a real `face`, so the
    // lane tile is a ModuleShell painting a LIVE picture — and the freely
    // resizable screen moved to where the owner asked for it, right-click →
    // DETACH DISPLAY (*"the card does not need the arbitrary resizing on the
    // card"*).
    //
    // ⚠ A GREEN RUN HERE WOULD BE MEANINGLESS WITHOUT THE PICTURE LEG. "the tile
    // mounted" is true of a placeholder too — which is exactly the regression
    // the carve-out existed to prevent — so the tile's own live canvas is
    // asserted, not just its presence.
    test.setTimeout(SLOW_RENDER ? 60_000 : 30_000);
    const providerErrors: string[] = [];
    page.on('pageerror', (e) => {
      if (/useStore|SvelteFlowProvider/i.test(e.message)) providerErrors.push(e.message);
    });

    await gotoShell(page);

    // 1) A REAL FACE TILE — not a placeholder, and not the legacy card.
    await expect(videoOutLane(page)).toBeVisible({ timeout: 15_000 });
    const laneNode = page.locator(`.svelte-flow__node[data-id="${VIDEO_OUT}"]`);
    await expect(laneNode.locator('[data-testid="module-shell-placeholder"]')).toHaveCount(0);
    await expect(laneNode.locator('[data-testid="video-out-card"]')).toHaveCount(0);
    // …carrying a LIVE surface. #1785 evicts a video face's thumbnail when its
    // ranked cells outgrow a plate row; videoOut ranks NOTHING, so the strip
    // survives at every tier (pinned purely in `videoout-face-model.test.ts`).
    await expect(videoOutLane(page).locator('canvas')).toHaveCount(1);
    // The card's own resize handle is GONE — that is the affordance the owner
    // said the card does not need.
    await expect(laneNode.locator('[data-testid="video-out-resize-handle"]')).toHaveCount(0);

    // 2) PACKED zone: recorderbox clears videoOut by exactly one gutter. The
    //    packing derives from each occupant's real width, so a uniform tile
    //    lands on the same gutter the wide legacy card used to.
    await expect(
      page.locator(`.svelte-flow__node[data-id="${RECORDERBOX}"] [data-testid="module-shell-placeholder"]`),
    ).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => {
        const vo = await nodeRect(page, VIDEO_OUT);
        const rb = await nodeRect(page, RECORDERBOX);
        if (!vo || !rb || vo.w === 0) return NaN;
        return rb.x - (vo.x + vo.w);
      }, { message: 'recorderbox sits one 24px gutter right of the videoOut tile', timeout: 10_000 })
      .toBe(VIDEO_ZONE_GAP);

    // 3) THE RESIZABLE DISPLAY, where it lives now: right-click the tile →
    //    Detach display → a free-floating panel with a corner grip, and NOT a
    //    flow node (so it can carry no patch wires).
    await laneNode.click({ button: 'right', position: { x: 6, y: 6 } });
    await page.getByTestId('ctx-detach-display').click();
    const panel = page.getByTestId('detached-display');
    await expect(panel).toHaveCount(1);
    await expect(page.getByTestId('detached-display-resize')).toHaveCount(1);
    expect(
      await page.evaluate(
        () => !!document.querySelector('[data-testid="detached-display"]')?.closest('.svelte-flow__node'),
      ),
      'the detached display is not a flow node, so it has no patch wires',
    ).toBe(false);
    // …and re-attach is reachable from the tile, the owner's second entry point.
    await laneNode.click({ button: 'right', position: { x: 6, y: 6 } });
    await page.getByTestId('ctx-reattach-display').click();
    await expect(panel).toHaveCount(0);

    expect(providerErrors, `no useStore/provider throws: ${providerErrors.join(' | ')}`).toEqual([]);
  });

  test('video-domain tiles show LIVE ANIMATED thumbnails via the real chain; the fake wave glyph is GONE for them', async ({ page }) => {
    // Software-renderer scale (see SLOW_RENDER): the frames-drawn + pixel-
    // change polls (20s budgets each) don't fit a flat 30s under contention.
    test.setTimeout(SLOW_RENDER ? 90_000 : 30_000);
    await gotoShell(page);
    await expect(videoOutLane(page)).toBeVisible({ timeout: 15_000 });

    // A REAL animated chain: LINES (auto-scrolling procedural source) →
    // BACKDRAFT (the owner-named tile under test). Positioned on the free
    // canvas below the video zone — membership in a lane is irrelevant here.
    await injectPatch(
      page,
      [
        { id: 'l1', type: 'lines', position: { x: -1200, y: 4500 } },
        { id: 'b1', type: 'backdraft', position: { x: -700, y: 4500 } },
        // ⚠ A SECOND DOWNSTREAM NODE, added when `backdraft` was promoted. The
        // "thumb blit DRIVES the real chain and the picture ANIMATES" half of
        // this case needs a tile that HAS a thumb, and a faced video module no
        // longer does (see the pinned gap below). `grainsOfVision` is
        // un-migrated, video-domain and takes the same `in_a`, so the claim
        // moves to it verbatim instead of being weakened or deleted.
        { id: 'g1', type: 'grainsOfVision', position: { x: -200, y: 4500 } },
      ],
      [
        { id: 'e-lb', from: { nodeId: 'l1', portId: 'out' }, to: { nodeId: 'b1', portId: 'in_a' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-lg', from: { nodeId: 'l1', portId: 'out' }, to: { nodeId: 'g1', portId: 'in_a' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );

    // Each PLACEHOLDER tile's glyph slot is the LIVE THUMB, and the fake
    // dashed-wave SVG is GONE for video modules.
    //
    // ⚠ `b1` (BACKDRAFT) IS NO LONGER ONE OF THEM, and the reason is a MEASURED
    // platform gap rather than a test-fixture detail — see the block below.
    for (const id of ['l1', RECORDERBOX]) {
      const tile = page.locator(`.svelte-flow__node[data-id="${id}"] [data-testid="module-shell-placeholder"]`);
      await expect(tile, `${id} renders a placeholder tile`).toHaveCount(1);
      await expect(tile.locator('[data-testid="video-tile-thumb"]'), `${id} has the live thumb canvas`).toHaveCount(1);
      await expect(tile.locator('.tile-wave'), `${id} fake wave glyph gone`).toHaveCount(0);
    }

    // ⚠ A PROMOTED VIDEO MODULE LOSES ITS LANE THUMBNAIL, and this pins the
    // fact so it cannot change silently in either direction.
    //
    // `backdraft` became the first VIDEO face. `hasVideoSurface` still says yes
    // (`domain === 'video'`), so `hasGlyph` is true — but the lane tile renders
    // `hasGlyph && lanePlan.glyph`, and at the `full` tier a face this size
    // takes the PLATE layout, where "ranked controls outrank the glyph": the
    // strip renders only if a whole strip-row still fits under the cell rows,
    // and with 28 lane-eligible controls it never does.
    //
    // MEASURED on the live tile, both ways, so the cause is not guessed: WITH
    // `face.paramCells` declaring the card's 20 faders the tile paints 3 cells
    // and 0 thumbs; with those declarations REMOVED it paints 6 cells and still
    // 0 thumbs. So the fader declaration costs lane CELLS (96px vs 42px rows,
    // exactly the trade the shell-control-kind doc names) and is NOT what
    // removes the picture — promotion plus face SIZE is.
    //
    // The module's own output stays reachable through the dock (`fullViewBody`,
    // which is the whole reason that slot was wired), so nothing is unreachable
    // — but the AT-A-GLANCE rack picture is gone for big video faces, and that
    // is a platform ruling for the owner, not something a face can declare its
    // way out of. Asserted as-is rather than skipped: if the platform later
    // gives a video surface priority over ranked cells, this line goes red and
    // whoever changes it reads this note.
    const b1Tile = page.locator('.svelte-flow__node[data-id="b1"] [data-testid="module-shell"]');
    await expect(b1Tile, 'b1 is a FACED tile, not a placeholder').toHaveCount(1);
    await expect(
      b1Tile.locator('[data-testid="video-tile-thumb"]'),
      'a faced video module at the full lane tier currently paints NO thumb (ranked cells outrank the glyph strip)',
    ).toHaveCount(0);
    // Boundary: synesthesia is AUDIO-domain (no engine surface) — it must NOT
    // get a (necessarily dead/black) video thumb.
    await expect(
      page.locator(`.svelte-flow__node[data-id="${SYNESTHESIA}"] [data-testid="video-tile-thumb"]`),
    ).toHaveCount(0);

    // Bring g1's tile on-screen so the visibility gate ARMS the tap…
    await centerOnNode(page, 'g1', 0.9);
    const thumbSel = `.svelte-flow__node[data-id="g1"] [data-testid="video-tile-thumb"]`;
    await expect(page.locator(thumbSel)).toBeVisible();

    // …the thumbnail's blit DRIVES the real chain (deterministic engine probe:
    // the per-node draw counter advances — the tap is the only watcher of g1)…
    const base = await framesDrawn(page, 'g1');
    expect(base, 'video engine reachable').toBeGreaterThanOrEqual(0);
    await expect
      .poll(async () => (await framesDrawn(page, 'g1')) - base, {
        message: 'the downstream video node draws frames while its tile thumb is on-screen',
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(2);

    // …and the PICTURE actually animates (two different frames). ⚠ MOVEMENT,
    // not non-blackness: a producer can go bright AND FROZEN, and a blackness
    // check calls that healthy.
    const first = await canvasData(page, thumbSel);
    expect(first, 'thumb canvas snapshot captured').not.toBe('');
    await expectCanvasChanges(page, thumbSel, first, 'g1 tile thumbnail');
  });

  test('dock full-view renders LIVE video for expanded video modules (feedback and videoOut, each via its own EXPAND pill) with a render lease', async ({ page }) => {
    // Software-renderer scale (see SLOW_RENDER): TWO sequential dock full-views
    // with pixel-change polls + lease polls starved the flat 30s budget on CI
    // shard 10 (run 30179147114, both attempts) while every step completed.
    test.setTimeout(SLOW_RENDER ? 120_000 : 30_000);
    const providerErrors: string[] = [];
    page.on('pageerror', (e) => {
      if (/useStore|SvelteFlowProvider/i.test(e.message)) providerErrors.push(e.message);
    });

    await gotoShell(page);
    await expect(videoOutLane(page)).toBeVisible({ timeout: 15_000 });

    // LINES feeds BOTH cards under test so their pictures animate: → FEEDBACK
    // in, and → the seeded videoOut's in (its idle pattern is static).
    //
    // WHY FEEDBACK AND NOT BACKDRAFT (which this case used to expand): the
    // EXPAND half of this test needs a shell-lane video card that owns a LIVE
    // PREVIEW CANVAS, and BACKDRAFT no longer has one. Its in-card display was
    // removed for good; the card keeps a <canvas> only as the OUTPUT SURFACE
    // for Full Frame / Full Screen / Present, and that surface is 0×0 and
    // unpainted while the card sits in the rack — so a dock full-view of
    // BACKDRAFT would show controls, not a picture. FEEDBACK is the same shape
    // (video-domain, shell-lane so it gets a tile + EXPAND, one video in / one
    // video out) and DOES own a blitOutputToDrawingBuffer preview. The
    // ORIGINAL regression this case guards — a legacy card whose bare
    // useStore() threw outside the SvelteFlow provider and mounted DEAD in the
    // dock — is the videoOut half below (videoOut is the card it was found on
    // and still calls into the flow store); the `providerErrors` sink covers
    // both halves regardless.
    await injectPatch(
      page,
      [
        { id: 'l1', type: 'lines', position: { x: -1200, y: 4500 } },
        { id: 'b1', type: 'feedback', position: { x: -700, y: 4500 } },
      ],
      [
        { id: 'e-lb', from: { nodeId: 'l1', portId: 'out' }, to: { nodeId: 'b1', portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-lo', from: { nodeId: 'l1', portId: 'out' }, to: { nodeId: VIDEO_OUT, portId: 'in' }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );

    // (a) FEEDBACK via the tile's EXPAND affordance — the user path.
    await centerOnNode(page, 'b1', 0.9);
    const b1Tile = page.locator(`.svelte-flow__node[data-id="b1"] [data-testid="module-shell-placeholder"]`);
    await expect(b1Tile).toBeVisible();
    await b1Tile.getByTestId('shell-open-dock').click();
    const faceplate = page.getByTestId('dock-full-view');
    await expect(faceplate).toBeVisible();
    const dockPreview = faceplate.locator('[data-dock-card="b1"] [data-testid="feedback-canvas"]');
    await expect(dockPreview, 'feedback video surface mounts in the dock').toBeVisible();
    const bFirst = await canvasData(page, '[data-dock-card="b1"] [data-testid="feedback-canvas"]');
    expect(bFirst).not.toBe('');
    await expectCanvasChanges(page, '[data-dock-card="b1"] [data-testid="feedback-canvas"]', bFirst, 'docked feedback');
    // Plain-mount contract holds: no xyflow handles/nodes inside the faceplate.
    await expect(faceplate.locator('.svelte-flow__handle')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(faceplate).toHaveCount(0);

    // (b) VIDEOOUT through its OWN EXPAND PILL — the user path, which it did
    // not have until #1821. ⚠ This leg used to go through the `__openDockFullView`
    // dev seam with the note "a NON_SHELL legacy lane card has no tile / EXPAND
    // button". It has a tile now, so the seam is no longer the only route and
    // driving it would be testing a hook instead of the product.
    await centerOnNode(page, VIDEO_OUT, 0.9);
    await videoOutLane(page).getByTestId('shell-open-dock').click();
    await expect(faceplate).toBeVisible();
    // ⚠ AND THE SURFACE IS THE FACEPLATE'S OWN, not the legacy card's: promotion
    // swaps DockFullView's body for <ModuleShell>, whose `fullViewBody`
    // extension mounts videoOut's picture.
    const dockOutSel = '[data-testid="videoout-face-canvas"]';
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

  test('?shell=legacy stays a strict no-op: no tiles, no thumbs, videoOut verbatim card as before', async ({ page }) => {
    // ⚠ THE ESCAPE HATCH MUST STAY HONEST. Promoting videoOut changes the
    // DEFAULT renderer; `?shell=legacy` means "the verbatim legacy cards inside
    // the same shell", and a promotion that leaked into it would make the hatch
    // a lie — so this reads the legacy CARD deliberately, not the shared gate.
    await page.goto('/rack?shell=legacy');
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });
    await expect(videoOutLegacyCard(page)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="module-shell-placeholder"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="module-shell"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="video-tile-thumb"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="headless-source-host"]')).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// THE CHAIN ITSELF (owner P0 follow-up: "no video AT ALL under ?shell=1 —
// camera → output and acidwarp → output render nothing").
//
// The earlier describe proves the SURFACES exist under the shell (videoOut's
// real card, live tile thumbs, the dock full-view). This one proves the ENGINE
// CHAIN behind them is identical to preview-off — the part that was still dead:
//
//   1. A pure-GPU chain (ACIDWARP → OUTPUT) is LIVE under the shell, and the
//      engine's materialized node set is EXACTLY the preview-off set for the
//      same rack (the parity invariant: which UI renders a module must not
//      change what the engine has).
//   2. A DOM-SOURCE module — one whose pixels come from a card-owned
//      <video>/<img> handed over with `attachExternalSource` — keeps its REAL
//      card mounted in the off-screen <HeadlessSourceHost> when the shell swaps
//      its lane card for a tile. That attach is the whole reason camera /
//      videobox / archivist / … → OUTPUT was patched-but-black.
//   3. cameraInput's DEVICE PICKER is reachable in the lane under the shell
//      (its `<select>` is card-only DOM, not a ParamDef, so no face can render
//      it — hence the NON_SHELL carve-out). The "lists real devices" half is
//      CAPABILITY-GATED on a runtime enumerateDevices() probe: the default CI
//      project has no camera and no permission, so an ungated assert would be
//      green locally and red on CI (the capability-dependent-e2e discipline).
//      The LIVE camera → OUTPUT pixel chain is asserted in camera-input.spec.ts
//      (@camera-integration), which runs under the fake-device project.
//
// Renderer-tolerant throughout: engine probes + canvas INEQUALITY, never exact
// pixels; no new spec file, so no shard re-binning and no heavy-glob edit (that
// file is in the WebGL attest basis).
// ---------------------------------------------------------------------------

/** Every node the video engine has MATERIALIZED this frame (evaluated ∪ skipped
 *  covers the whole topo order, whatever pull-eval decided to draw). The
 *  registration probe — deliberately independent of what rendered. */
async function engineNodeIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain: (d: string) => { pullStats: () => { evaluated: string[]; skipped: string[] } } };
    };
    try {
      const s = w.__engine!().getDomain('video').pullStats();
      return [...new Set([...s.evaluated, ...s.skipped])].sort();
    } catch {
      return [];
    }
  });
}

test.describe('?shell=1 video CHAIN parity', () => {
  test('ACIDWARP → OUTPUT is LIVE under the shell, and the engine node set matches preview-off exactly', async ({ page }) => {
    // Software-renderer scale (see SLOW_RENDER): two full rack boots, each with
    // a live acidwarp→videoOut chain and a pixel-change poll.
    test.setTimeout(SLOW_RENDER ? 120_000 : 60_000);

    /** Build the SAME rack in a given mode and report what the engine has +
     *  whether the OUTPUT surface is actually painting moving pixels. */
    async function buildAndProbe(url: string): Promise<{ nodes: string[] }> {
      await page.goto(url);
      await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });
      const lane = url.includes('shell=legacy') ? videoOutLegacyCard(page) : videoOutLane(page);
      await expect(lane, `${url}: videoOut lane surface mounts`).toBeVisible({ timeout: 15_000 });

      await injectPatch(
        page,
        [{ id: 'aw1', type: 'acidwarp', position: { x: -1200, y: 4500 } }],
        [{ id: 'e-aw-out', from: { nodeId: 'aw1', portId: 'out' }, to: { nodeId: VIDEO_OUT, portId: 'in' }, sourceType: 'video', targetType: 'video' }],
      );

      // The engine MATERIALIZED both ends of the chain (graph-driven — this is
      // what must not depend on the lane renderer).
      await expect
        .poll(async () => await engineNodeIds(page), {
          message: `${url}: engine materializes the acidwarp → videoOut chain`,
          timeout: 20_000,
        })
        .toEqual(expect.arrayContaining(['aw1', VIDEO_OUT]));

      // The chain RUNS: acidwarp's draw counter advances…
      const base = await framesDrawn(page, 'aw1');
      expect(base, `${url}: video engine reachable`).toBeGreaterThanOrEqual(0);
      await expect
        .poll(async () => (await framesDrawn(page, 'aw1')) - base, {
          message: `${url}: acidwarp draws frames while the OUTPUT is watching it`,
          timeout: 20_000,
        })
        .toBeGreaterThanOrEqual(2);

      // …and the user-viewable OUTPUT surface actually paints MOVING pixels
      // (not a black canvas — the owner's "nothing renders").
      const outSel = videoOutSurfaceSel(url);
      const first = await canvasData(page, outSel);
      expect(first, `${url}: OUTPUT canvas snapshot captured`).not.toBe('');
      await expectCanvasChanges(page, outSel, first, `${url}: OUTPUT surface`);

      return { nodes: await engineNodeIds(page) };
    }

    const shell = await buildAndProbe('/rack');
    const off = await buildAndProbe('/rack?shell=legacy');

    // THE PARITY INVARIANT: which UI renders a module must not change what the
    // engine has materialized for the same rack.
    expect(shell.nodes, 'shell engine node set === preview-off engine node set').toEqual(off.nodes);
  });

  test('a DOM-SOURCE video module keeps its REAL card alive off-screen when the shell swaps its lane card', async ({ page }) => {
    test.setTimeout(SLOW_RENDER ? 90_000 : 30_000);
    await gotoShell(page);
    await expect(videoOutLane(page)).toBeVisible({ timeout: 15_000 });

    // VIDEOBOX: its picture comes from a card-owned <video> handed to the engine
    // via attachExternalSource — the class that went dark under the shell.
    await injectPatch(page, [{ id: 'vb1', type: 'videobox', position: { x: -1200, y: 5100 } }]);

    // The LANE still shows the uniform tile (the shell look is preserved — this
    // fix is NOT "give every source module the legacy card back")…
    await expect(
      page.locator(`.svelte-flow__node[data-id="vb1"] [data-testid="module-shell-placeholder"]`),
      'videobox still renders the uniform RACKLINE tile in its lane',
    ).toHaveCount(1);

    // …while its REAL card is mounted in the off-screen lifecycle host, so its
    // source attach/detach still runs.
    const host = page.locator('[data-testid="headless-source-host"][data-node-id="vb1"]');
    await expect(host, 'videobox gets an off-screen lifecycle host').toHaveCount(1);
    await expect(host, 'the host mounts the REAL videobox card').toHaveAttribute('data-node-type', 'videobox');
    await expect(
      host.locator('[data-testid="videobox-card"]'),
      "the hosted card is the module's real card, not a stub",
    ).toHaveCount(1);
    await expect(
      host.locator('[data-testid="videobox-video"]'),
      '…including the <video> element it hands to the engine (attachExternalSource)',
    ).toHaveCount(1);

    // Exactly ONE mount FOR THIS NODE: a second live <video> would double
    // getUserMedia/decode and the first to unmount would detach the survivor.
    //
    // ⚠ SCOPED TO THE NODE, and that is the whole assertion — it used to count
    // every host in the DOCUMENT, which said "for the node" while measuring
    // something else entirely. The seeded rack's own TIMELORDE joined the
    // headless set in #1587 (its card is the sole writer of its video_out), so
    // the document count became 2 and this reddened without a single thing
    // about videobox having changed. A per-node count states what it means and
    // cannot be moved by an unrelated module joining the set.
    await expect(
      page.locator('[data-testid="headless-source-host"][data-node-id="vb1"]'),
    ).toHaveCount(1);

    // cameraInput must NEVER be hosted — it keeps its real card IN the lane
    // (carve-out), so hosting it would be the double-mount above.
    await injectPatch(page, [{ id: 'cam1', type: 'cameraInput', position: { x: -700, y: 5100 } }]);
    await expect(page.locator('[data-testid="headless-source-host"][data-node-id="cam1"]')).toHaveCount(0);
  });

  test('the CAMERA source picker is reachable in the lane under the shell (device list capability-gated)', async ({ page }) => {
    test.setTimeout(SLOW_RENDER ? 90_000 : 30_000);
    await gotoShell(page);
    await expect(videoOutLane(page)).toBeVisible({ timeout: 15_000 });

    await injectPatch(page, [{ id: 'cam1', type: 'cameraInput', position: { x: -1200, y: 5100 } }]);

    const laneNode = page.locator('.svelte-flow__node[data-id="cam1"]');
    // The REAL card, not the tile — the carve-out (like videoOut).
    await expect(laneNode.locator('[data-testid="module-shell-placeholder"]')).toHaveCount(0);
    const picker = laneNode.locator('[data-testid="camera-device-select"]');
    await expect(picker, 'the device picker is present + usable in the shell lane').toBeVisible({ timeout: 15_000 });

    // CAPABILITY GATE (ci-capability discipline): only assert "lists a real
    // device" where a videoinput actually exists. CI's default project has no
    // camera and no permission — there the picker correctly shows "(no cameras)"
    // and the presence assert above is the whole contract.
    const cameraCount = await page.evaluate(async () => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return 0;
      try {
        return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput').length;
      } catch {
        return 0;
      }
    });
    test.skip(cameraCount === 0, 'no videoinput device in this runtime — device-list assert not applicable');
    await expect
      .poll(async () => picker.locator('option').count(), {
        message: 'the picker lists at least one real camera',
        timeout: 15_000,
      })
      .toBeGreaterThanOrEqual(1);
    await expect(picker).toBeEnabled();
  });
});
