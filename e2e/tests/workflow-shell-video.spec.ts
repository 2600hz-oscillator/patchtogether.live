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
//      (feedback via the tile's EXPAND button; videoOut via the dev seam —
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
import { VIDEO_THUMB_FPS } from '../../packages/web/src/lib/ui/workflow/module-shell-model';

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

// ── #1785 blit-cost measurement constants ───────────────────────────────────
/** Wall-clock length of one blit-cost window, MILLISECONDS. Long enough that
 *  the thumb's own cadence produces tens of repaints (so a ±1 edge effect is
 *  noise, not the answer) and short enough that two of them plus a settle stay
 *  inside the software-renderer budget. */
const COST_WINDOW_MS = 1500;
/** A short probe window used only to WAIT for the off-screen release to settle
 *  — the gate is the observable (`drawn === 0`), this is just its sample size. */
const SETTLE_WINDOW_MS = 400;
/**
 * Head-room over `VIDEO_THUMB_FPS` the cap assertion allows.
 *
 * A POLICY THRESHOLD on a derived measurement, not a count. The throttle is
 * `now - lastDraw < 1000 / VIDEO_THUMB_FPS` evaluated on rAF ticks, so the
 * achieved rate can only ever come in AT or UNDER the cap — the head-room is
 * for window-edge effects (a window that opens just before a due repaint and
 * closes just after one carries a spare) and `performance.now()` jitter, not
 * for a legitimately faster loop.
 */
const COST_RATE_SLACK = 1.25;

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

/**
 * BLIT COST of ONE lane tile, over a WALL-CLOCK window, sampled INSIDE the page.
 *
 * ⚠ THE UNIT IS DELIBERATE AND IT IS NOT THE "count frames, never ms" case.
 * That rule governs renderer-dependent WAITS. What is measured here is a
 * PRODUCT-SIDE CADENCE — `VIDEO_THUMB_FPS`, a repaints-per-SECOND cap the
 * component enforces off `performance.now()` — and `preview-gate.ts` makes the
 * same argument for `PREVIEW_MIN_INTERVAL_MS`: a frame count would be a
 * different real rate on a 60 Hz laptop, a 144 Hz monitor and SwiftShader,
 * which is exactly what the cap must NOT be. A software renderer can only come
 * in UNDER the cap, so the assertion is one-sided and renderer-safe.
 *
 * Everything is accumulated in ONE `page.evaluate` (never a Playwright-side
 * poll of a page-side quantity), and the window reports its own `rafSamples` /
 * `elapsedMs` so a starved runner is visible in the failure message instead of
 * being indistinguishable from a frozen subject.
 */
interface ThumbCostSample {
  /** Engine `blitTexToDrawingBuffer` calls in the window — EVERY preview path
   *  funnels through it, the lane thumb's ungated one included. GLOBAL, so it
   *  is only ever read as a DIFFERENCE between two windows. */
  blitCalls: number;
  /** This node's own GL draws in the window. The blit IS the watch mark, so a
   *  node nothing blits stops being a pull root and this goes to 0. */
  drawn: number;
  /** Engine steps in the window — reported, never asserted on. */
  engineFrames: number;
  rafSamples: number;
  elapsedMs: number;
}

async function sampleThumbCost(page: Page, nodeId: string, windowMs: number): Promise<ThumbCostSample> {
  return page.evaluate(
    async ({ nodeId, windowMs }) => {
      const w = globalThis as unknown as {
        __engine: () => {
          getDomain: (d: string) => {
            framesDrawnFor: (id: string) => number;
            currentFrameCount: () => number;
            renderCostStats: () => { blit: { calls: number } };
            resetRenderCost: () => void;
          };
        };
      };
      const vid = w.__engine().getDomain('video');
      const drawn0 = vid.framesDrawnFor(nodeId);
      const frame0 = vid.currentFrameCount();
      vid.resetRenderCost();
      const t0 = performance.now();
      let rafSamples = 0;
      await new Promise<void>((resolve) => {
        const tick = (): void => {
          rafSamples++;
          if (performance.now() - t0 >= windowMs) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return {
        blitCalls: vid.renderCostStats().blit.calls,
        drawn: vid.framesDrawnFor(nodeId) - drawn0,
        engineFrames: vid.currentFrameCount() - frame0,
        rafSamples,
        elapsedMs: performance.now() - t0,
      };
    },
    { nodeId, windowMs },
  );
}

/** Shift nodes far below the viewport in flow space (the patch moves, the
 *  viewport does not — so every OTHER tile's cost stays constant and the
 *  difference between two windows is attributable to THESE nodes). */
async function shiftNodes(page: Page, ids: string[], dy: number): Promise<void> {
  await page.evaluate(
    ({ ids, dy }) => {
      const w = globalThis as unknown as {
        __ydoc: { transact: (fn: () => void) => void };
        __patch: { nodes: Record<string, { position: { x: number; y: number } }> };
      };
      w.__ydoc.transact(() => {
        for (const id of ids) {
          const n = w.__patch.nodes[id];
          if (n) n.position = { x: n.position.x, y: n.position.y + dy };
        }
      });
    },
    { ids, dy },
  );
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
    // Software-renderer scale (see SLOW_RENDER): the resize-drag + repack polls
    // run against live video-zone tiles.
    test.setTimeout(SLOW_RENDER ? 60_000 : 30_000);
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
    // Software-renderer scale (see SLOW_RENDER): the frames-drawn + pixel-
    // change polls (20s budgets each) don't fit a flat 30s under contention.
    test.setTimeout(SLOW_RENDER ? 90_000 : 30_000);
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
        // ⚠ A SECOND DOWNSTREAM NODE. It was added when `backdraft` was
        // promoted and lost its thumb (#1785), because the "thumb blit DRIVES
        // the real chain and the picture ANIMATES" half of this case needs a
        // tile that HAS one. #1785 gave the faced tile its picture back, so
        // that is no longer the reason to keep it — this one is:
        // `grainsOfVision` is UN-MIGRATED, so it exercises the PLACEHOLDER
        // thumb loop, and b1 now exercises the FACED one. Two hosts, one
        // `VideoTileThumb`; dropping either would leave a host unproven.
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
    // ⚠ `b1` (BACKDRAFT) IS NOT ONE OF THEM because it is FACED, not because it
    // has no thumb — it has one again (#1785), asserted on the shell host a few
    // lines below. This loop is the placeholder host.
    for (const id of ['l1', RECORDERBOX]) {
      const tile = page.locator(`.svelte-flow__node[data-id="${id}"] [data-testid="module-shell-placeholder"]`);
      await expect(tile, `${id} renders a placeholder tile`).toHaveCount(1);
      await expect(tile.locator('[data-testid="video-tile-thumb"]'), `${id} has the live thumb canvas`).toHaveCount(1);
      await expect(tile.locator('.tile-wave'), `${id} fake wave glyph gone`).toHaveCount(0);
    }

    // ⚠ A PROMOTED VIDEO MODULE KEEPS ITS LANE THUMBNAIL (#1785) — the owner
    // ruling that "the picture IS a video module's identity in a rack", and the
    // DOM half of it. The pure half is `module-shell-model.test.ts`.
    //
    // THE BUG THIS REPLACES, kept because it is why the assertion exists at
    // all: `backdraft` became the first VIDEO face and the tile went blank.
    // `hasVideoSurface` said yes (`domain === 'video'`) so the shell's
    // `hasGlyph` was true — but at the `full` tier a face this size takes the
    // PLATE layout, where "ranked controls outrank the glyph" dropped the strip.
    // MEASURED both ways, so the cause was not guessed: WITH `face.paramCells`
    // declaring the card's faders the tile painted 3 cells and 0 thumbs; with
    // those declarations REMOVED, 6 cells and still 0 thumbs. Face SIZE removed
    // the picture, not the fader kind.
    //
    // The fix inverts the precedence for the VIDEO DOMAIN only (`laneGlyphFor`
    // → 'picture'): the strip is reserved first and the cells take what is
    // left. backdraft's fader rows do not fit under it, so the plan falls back
    // to the ROW layout — the picture beside two cells, which is exactly what
    // its own `compact` tile has painted all along. The trade is one lane cell
    // (`mix`), and the dock renders every ranked control regardless.
    const b1Tile = page.locator('.svelte-flow__node[data-id="b1"] [data-testid="module-shell"]');
    await expect(b1Tile, 'b1 is a FACED tile, not a placeholder').toHaveCount(1);
    await expect(
      b1Tile.locator('[data-testid="video-tile-thumb"]'),
      'a faced video module at the full lane tier paints its LIVE thumb — the picture outranks ranked cells (#1785)',
    ).toHaveCount(1);
    // …and it is the shell's glyph slot that holds it, not some other surface:
    // the same cell that would hold a trace on an audio face.
    await expect(
      b1Tile.locator('.tile-glyph[data-glyph-kind="video"] [data-testid="video-tile-thumb"]'),
      'the thumb is IN the glyph cell, and that cell reports itself as video',
    ).toHaveCount(1);
    // FUNCTIONAL PARITY: the picture did not cost the tile its controls. The
    // ROW layout still paints whole knob columns beside it.
    await expect(
      b1Tile.locator('.tile-body .kcol'),
      'ranked control cells still render beside the picture',
    ).not.toHaveCount(0);
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

  test('the RESTORED lane thumbnail is still GATED: off-screen costs nothing, on-screen is capped (#1785 / #1802)', async ({
    page,
  }) => {
    // ⚠ THIS IS THE BILL #1785 COULD HAVE RE-OPENED. #1802/#1836 gated the
    // per-card preview blits (measured: off-screen blits 5061 → 0, main-thread
    // share 49.7 % → 24.7 %), and giving a promoted video face its picture back
    // puts a live blit loop into every video lane tile again. So the claim is
    // measured on the FACED host rather than assumed from the placeholder's.
    //
    // `VideoTileThumb` is the repo's one NAMED exemption from the engine-side
    // gate (`card-preview-gate.test.ts` / `UNGATED_OK`), and the reason it is
    // exempt is that it carries a STRONGER gate: an IntersectionObserver on the
    // thumbnail CANVAS that really calls `cancelAnimationFrame`, so an
    // off-screen tile schedules no callback at all, plus its own
    // `VIDEO_THUMB_FPS` cadence — HALF `PREVIEW_FPS`. It takes NO render lease.
    test.setTimeout(SLOW_RENDER ? 120_000 : 45_000);
    await gotoShell(page);
    await expect(videoOutCard(page)).toBeVisible({ timeout: 15_000 });

    // ⚠ EXACTLY ONE INJECTED NODE, and that is the INSTRUMENT, not laziness.
    // `renderCostStats().blit` is engine-WIDE, so it can only attribute a rate
    // to one tile if one tile is the only thing blitting. The first draft of
    // this test put LINES → BACKDRAFT on screen together and measured 21.3
    // blits/s, which read as a broken cap and was in fact TWO capped thumbs
    // (10.65/s each) — a wrong instrument returning a confident wrong number.
    // With one tile the ON window's blit count IS this thumb's, no differencing
    // and no attribution argument.
    //
    // backdraft's INPUT and OUTPUT are both patched NOWHERE, which is the #1802
    // shape exactly: the tile's own thumbnail is the ONLY thing watching it, so
    // "the thumb stopped blitting" and "the chain stopped rendering" are the
    // same event and the engine's per-node draw counter can see it.
    await injectPatch(page, [{ id: 'bcost', type: 'backdraft', position: { x: -700, y: 6200 } }]);

    const thumb = page.locator('.svelte-flow__node[data-id="bcost"] [data-testid="video-tile-thumb"]');
    await expect(thumb, 'the promoted video face paints its thumb — the subject exists').toHaveCount(1);

    // ── ON-SCREEN: the picture is live, and the loop is running ──────────────
    await centerOnNode(page, 'bcost', 0.9);
    await expect(thumb).toBeVisible();
    await expect
      .poll(async () => await framesDrawn(page, 'bcost'), {
        message: 'the thumb has armed and the chain is rendering before the window opens',
        timeout: 20_000,
      })
      .toBeGreaterThan(0);
    const on = await sampleThumbCost(page, 'bcost', COST_WINDOW_MS);
    console.log(`[1785] lane thumb ON-screen ${JSON.stringify(on)}`);
    expect(
      on.rafSamples,
      `the window ran at all — ${on.rafSamples} rAF samples over ${on.elapsedMs.toFixed(0)} ms. ` +
        'A starved runner and a frozen subject are indistinguishable from the counters alone.',
    ).toBeGreaterThan(2);
    expect(on.drawn, 'POSITIVE CONTROL: the chain renders while the tile is on screen').toBeGreaterThan(0);
    expect(on.blitCalls, 'and preview blits are happening at all').toBeGreaterThan(0);

    // ── OFF-SCREEN: zero. Not "fewer" — the rAF is cancelled ─────────────────
    // The NODES move; the viewport does not. Every other tile's cost is
    // therefore identical across the two windows, which is what makes the
    // global blit counter's DIFFERENCE attributable to this tile.
    await shiftNodes(page, ['bcost'], 9000);
    await expect(thumb).not.toBeInViewport();
    await expect
      .poll(
        async () => (await sampleThumbCost(page, 'bcost', SETTLE_WINDOW_MS)).drawn,
        {
          message: 'the off-screen tile stops being an observer (the blit IS the watch mark)',
          timeout: 30_000,
        },
      )
      .toBe(0);
    const off = await sampleThumbCost(page, 'bcost', COST_WINDOW_MS);
    console.log(`[1785] lane thumb OFF-screen ${JSON.stringify(off)}`);
    expect(
      off.drawn,
      `an OFF-SCREEN lane thumbnail costs ZERO: ${off.drawn} node draws over ` +
        `${off.elapsedMs.toFixed(0)} ms (${off.rafSamples} rAF samples). Anything above 0 means ` +
        'the tile is still blitting, still marking itself watched, and still pulling its whole ' +
        'upstream chain into every frame — the exact bill #1802 paid off.',
    ).toBe(0);
    expect(
      off.blitCalls,
      `and the engine-wide blit count goes with it: ${off.blitCalls} off-screen vs ` +
        `${on.blitCalls} on-screen. This tile was the only blitter, so anything left here is a ` +
        'loop that outlived its element.',
    ).toBe(0);
    expect(
      off.engineFrames,
      'POSITIVE CONTROL on the OFF window: the ENGINE is still stepping, so "0 blits" means this ' +
        'tile was RELEASED, not that everything stopped — the #1721/#1728 reading of the same ' +
        'counter going down',
    ).toBeGreaterThan(0);

    // ── THE CAP: the on-screen loop runs at the thumb cadence, not at rAF ────
    // No differencing: the OFF window proved this tile is the only blitter, so
    // the ON window's count is this thumb's count.
    const thumbBlits = on.blitCalls;
    const rate = (thumbBlits / on.elapsedMs) * 1000;
    console.log(`[1785] lane thumb blit rate ${rate.toFixed(1)}/s over ${thumbBlits} blits`);
    expect(
      rate,
      `an ON-SCREEN lane thumbnail is CAPPED: ${rate.toFixed(1)} blits/s (${thumbBlits} blits over ` +
        `${on.elapsedMs.toFixed(0)} ms, ${on.rafSamples} rAF samples). Units are BLITS PER SECOND, ` +
        `against the component's own VIDEO_THUMB_FPS cadence — a wall-clock product interval, not ` +
        `a frame budget. Exceeding it means the thumb is repainting at full rAF, which is the ` +
        `pre-#1802 behaviour.`,
    ).toBeLessThanOrEqual(VIDEO_THUMB_FPS * COST_RATE_SLACK);
    // NEGATIVE CONTROL on the instrument itself: a cap assertion that a DEAD
    // loop would also satisfy proves nothing.
    expect(rate, 'and the capped loop is actually running, not merely slow').toBeGreaterThan(0);
  });

  test('dock full-view renders LIVE video for expanded video legacy cards (feedback via EXPAND; videoOut via the dev seam) with a render lease', async ({ page }) => {
    // Software-renderer scale (see SLOW_RENDER): TWO sequential dock full-views
    // with pixel-change polls + lease polls starved the flat 30s budget on CI
    // shard 10 (run 30179147114, both attempts) while every step completed.
    test.setTimeout(SLOW_RENDER ? 120_000 : 30_000);
    const providerErrors: string[] = [];
    page.on('pageerror', (e) => {
      if (/useStore|SvelteFlowProvider/i.test(e.message)) providerErrors.push(e.message);
    });

    await gotoShell(page);
    await expect(videoOutCard(page)).toBeVisible({ timeout: 15_000 });

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
    await page.goto('/rack?shell=legacy');
    await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });
    await expect(videoOutCard(page)).toBeVisible({ timeout: 15_000 });
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
      await expect(videoOutCard(page), `${url}: videoOut card mounts`).toBeVisible({ timeout: 15_000 });

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
      const outSel = `.svelte-flow__node[data-id="${VIDEO_OUT}"] [data-testid="video-out-canvas"]`;
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
    await expect(videoOutCard(page)).toBeVisible({ timeout: 15_000 });

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
    await expect(videoOutCard(page)).toBeVisible({ timeout: 15_000 });

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
