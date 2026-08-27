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
import { VIDEO_THUMB_FPS } from '../../packages/web/src/lib/ui/workflow/module-shell-model';
import {
  VIDEO_SINK_FIXTURE,
  fixtureProblems,
  fixtureType,
  videoInPortId,
} from './_face-fixtures';

// ── THE PLACEHOLDER-HOST SUBJECT IS DERIVED, NOT NAMED (#1929) ─────────────
//
// This spec used to spawn a literal `grainsOfVision` as `g1`, with a comment
// explaining that the pick was load-bearing: it had to be UN-MIGRATED, because
// the assertions on it are the PLACEHOLDER host of `VideoTileThumb` (`b1`,
// backdraft, is the faced host). Promoting that module leaves all three
// assertions passing while the thing they prove quietly stops being proven —
// green and blind, not red.
//
// The pick is now resolved from the contract golden by the predicates the
// assertions actually need, so a future promotion drops the subject out of the
// pool automatically and the pool refills as new video modules land. See
// `VIDEO_SINK_FIXTURE`; the health of that resolution is asserted below rather
// than assumed.
// ⚠ NEGATIVE-CONTROLLED BY HAND BEFORE MERGE, and the result is recorded here
// because the control cannot live in the tree: pointing SINK_TYPE at a FACED
// module (`backdraft`) makes the placeholder assertion below fail with
// "the derived subject 'backdraft' must render a PLACEHOLDER tile". So this
// case now goes RED when its subject is promoted, which is exactly what it did
// NOT do before — that is the whole of #1929.
const SINK_TYPE = VIDEO_SINK_FIXTURE.kind === 'ok' ? fixtureType(VIDEO_SINK_FIXTURE) : '';
const SINK_IN_PORT = SINK_TYPE ? videoInPortId(SINK_TYPE) : null;

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
/**
 * Minimum rAF ticks a cost window must OBSERVE before it is a measurement at
 * all. The window ends on `COST_WINDOW_MS` **and** this, whichever is later.
 *
 * ⚠ A SAMPLE-SIZE FLOOR IS A FRAME QUANTITY, AND IT USED TO BE SPENT IN
 * MILLISECONDS. Measured (#1982; caught on PR #1980's e2e shard 5, job
 * 96261657927 — the first wild catch of the #1907 fail-on-flaky gate): with backdraft
 * on-screen under SwiftShader on a contended CI runner the page ran at
 * **1.30 rAF/s**, so the flat 1500 ms window collected **2** samples; the retry
 * ran at 1.76 rAF/s and collected **3**. The floor was `> 2`, i.e. it demanded
 * a frame rate above 2/1.5 s = **1.33 rAF/s** — a threshold sitting INSIDE the
 * range that runner actually produces, so it was a coin flip, not a gate. The
 * identical window on a local `E2E_SWIFTSHADER=1` Mac collects **94**: same
 * assertion, 47× the evidence, which is the "a wall-clock budget is a different
 * assertion per machine" rule with the usual sign flipped — here it starved the
 * SAMPLE COUNT rather than the effect under test.
 *
 * Only the RATE below stays wall-clock; see the sampler's note.
 */
const MIN_COST_SAMPLES = 8;
/** Hard ceiling on ONE cost window, MILLISECONDS. It BOUNDS THE FAILURE, it is
 *  never the gate — the same shape the sibling samplers in
 *  `video-preview-gate.spec.ts` already use ("wall-clock cap bounds the failure;
 *  the frame count is the gate"). At the 1.30 rAF/s the CI runner produced,
 *  `MIN_COST_SAMPLES` costs ~6.2 s, so this is ~5× the slowest window yet
 *  observed; a page that has genuinely stopped painting trips it and fails on
 *  the sample floor with its own numbers printed. */
const COST_WINDOW_MAX_MS = 30_000;
/** A short probe window used only to WAIT for the off-screen release to settle
 *  — the gate is the observable (`drawn === 0`), this is just its sample size.
 *  Deliberately NOT frame-floored: it runs inside a poll, so extending each
 *  iteration would spend the poll's budget instead of the window's. */
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

// ⚠ `framesDrawn(page, id)` WAS HERE AND IS DELETED (#1993). It read the
// engine's per-node draw counter in ONE round-trip, which is correct for a
// single reading and was wrong for the only thing it was used for: an
// `expect.poll` loop that sampled it repeatedly from the Playwright side, on
// the subject's own main thread. The counter itself is fine; the SAMPLING
// PATTERN was the defect. It is deleted rather than left unused so the next
// author cannot reach for a one-shot reader and rebuild the poll around it —
// `sampleDrawAdvance` below is the accumulator-in-the-page replacement, and it
// takes its own baseline, so a caller never needs the one-shot form.

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
 * ⚠ BUT THE WINDOW'S *LENGTH* IS NOT PURELY WALL-CLOCK, AND THAT IS THE #1982
 * FIX. The RATE is per-second and stays that way — `elapsedMs` is its real
 * denominator however long the window ran. What is renderer-dependent is how
 * many SAMPLES a given stretch of wall clock buys, and the sanity floor on that
 * count is a FRAME quantity. So the window closes when it has BOTH spent
 * `windowMs` AND seen `minSamples` ticks, bounded by `COST_WINDOW_MAX_MS`. On a
 * fast renderer the wall clock binds (unchanged behaviour: ~94 samples in
 * 1500 ms); on a 1.3 rAF/s CI runner the sample count binds and the window
 * simply takes longer, which costs the rate nothing.
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

async function sampleThumbCost(
  page: Page,
  nodeId: string,
  windowMs: number,
  minSamples = 1,
  maxMs = COST_WINDOW_MAX_MS,
): Promise<ThumbCostSample> {
  return page.evaluate(
    async ({ nodeId, windowMs, minSamples, maxMs }) => {
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
          const elapsed = performance.now() - t0;
          // Wall clock AND sample count — the rate needs the first, the sanity
          // floor needs the second, and a renderer decides which one binds. The
          // ceiling only bounds the failure.
          if ((elapsed >= windowMs && rafSamples >= minSamples) || elapsed >= maxMs) {
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
    { nodeId, windowMs, minSamples, maxMs },
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
/**
 * FRAME budgets for the two liveness instruments below, and they are FRAMES
 * because what is being waited for is a per-frame event (a draw, a repaint).
 *
 * Sized off the product's own cadence rather than by taste: `VIDEO_THUMB_FPS`
 * caps a thumb at 15 repaints/s, so on a 60 Hz renderer a repaint lands every
 * ~4 rAF frames and two draws need ~8. On a software renderer the cadence gate
 * never bites (frames are already further apart than 1/15 s) so two draws need
 * ~2. **The worst case is therefore the FAST renderer at ~8 frames**, which is
 * the whole reason a frame budget is renderer-independent here and a millisecond
 * budget is not. 90 leaves an order of magnitude of headroom over that worst
 * case while staying far under any runner's patience.
 */
const LIVENESS_FRAME_BUDGET = 90;
const CHANGE_FRAME_BUDGET = 90;
/**
 * ⚠ CEILINGS ONLY — they bound a FAILURE and must never be what decides a
 * healthy run; the frame budgets above are the gate. Generous under
 * `SLOW_RENDER` because a starved runner spends real wall clock buying the same
 * small number of frames, and shortening this would convert "slow" into "red",
 * which is precisely the confusion #1993 is about.
 */
const LIVENESS_MAX_MS = SLOW_RENDER ? 60_000 : 20_000;
const CHANGE_MAX_MS = SLOW_RENDER ? 60_000 : 20_000;

/**
 * THE TEST ENVELOPE, DERIVED FROM THE BUDGETS THE CASE ACTUALLY SPENDS.
 *
 * ⚠ THE DEFECT THIS REMOVES IS ARITHMETIC, NOT "CI IS SLOW". The two ceilings
 * above are `60_000` each under `SLOW_RENDER`, and the cases below spend BOTH —
 * yet their `test.setTimeout` was a hand-written literal (`90_000`) that could
 * not contain them. 60 000 + 60 000 = 120 000 > 90 000, before a single ms of
 * page load, `injectPatch` or DOM assertion. **A run that was still legitimately
 * inside every budget it was given would be killed by the envelope around
 * them** — and it fails as `Test timeout of 90000ms exceeded`, which reads
 * exactly like "the runner is slow" and gets answered by a retry.
 *
 * That is how it presented: `main` went RED at a58ccc846 on e2e shard 5 with
 * this case failing once and passing on retry, tripping the #1847 flake gate.
 * ⚠ AND IT HAD HAPPENED BEFORE, one layer down — see `sampleDrawAdvance`'s
 * header: main was red at 7eeccfb30 for the same case on the same shard, when
 * the INNER budget was the flat one. #1993 fixed the polls by moving them into
 * the page and raised these ceilings to 60 s; the OUTER envelopes were left as
 * literals and silently became too small in the same commit. This closes that
 * half.
 *
 * So the envelope is COMPUTED from what the case spends. A future change to
 * either ceiling moves every envelope with it, which is the property the
 * literals did not have — the class, not the instance.
 *
 * ⚠ IT IS A BOUND, NEVER A GATE. Enlarging it cannot make a broken case pass:
 * the gate is the FRAME budget (`LIVENESS_FRAME_BUDGET` / `CHANGE_FRAME_BUDGET`)
 * and the animated-thumbnail assertions themselves, all of which still fail on
 * their own terms. It only decides how long a genuinely hung case takes to go
 * red, so it costs no wall clock on a green run.
 *
 * @param liveness how many `sampleDrawAdvance` calls the case makes
 * @param change   how many `expectCanvasChanges` calls the case makes
 */
function videoCaseTimeout(liveness: number, change: number): number {
  // Page load + `injectPatch` + the 15 s lane-visible waits + DOM assertions.
  // Deliberately generous under SLOW_RENDER for the same reason the ceilings
  // are: a starved runner spends real wall clock on the same small work.
  const SETUP_MS = SLOW_RENDER ? 45_000 : 15_000;
  return SETUP_MS + liveness * LIVENESS_MAX_MS + change * CHANGE_MAX_MS;
}

/**
 * Wait, INSIDE THE PAGE, for a node's engine draw counter to ADVANCE by
 * `target`. Returns what it saw rather than throwing, so the caller's assertion
 * message can carry the evidence.
 *
 * ⚠ SAME #1993 FIX AS `expectCanvasChanges` ABOVE, and this is the instrument
 * that actually went red: main was RED at 7eeccfb30 because an
 * `expect.poll(() => framesDrawn(page,'g1') - base)` with a flat 20 000 ms
 * budget timed out on e2e shard 5, then passed on retry. A Playwright-side poll
 * of a page-side counter is one round-trip per sample on the subject's own main
 * thread, so under shard contention the instrument starves the rAF loop whose
 * output it is reading — and a bare `Timeout 20000ms exceeded while waiting on
 * the predicate` cannot distinguish that from a genuinely dead chain.
 */
interface DrawAdvanceSample {
  /** `framesDrawnFor(node)` minus its baseline, at exit. */
  delta: number;
  rafSamples: number;
  elapsedMs: number;
  /** -1 when the engine was unreachable, which is a DIFFERENT failure from a
   *  chain that simply did not draw — and one a bare delta would hide. */
  base: number;
}

async function sampleDrawAdvance(
  page: Page,
  nodeId: string,
  target: number,
  frameBudget: number,
  maxMs: number,
): Promise<DrawAdvanceSample> {
  return page.evaluate(
    async ({ nodeId, target, frameBudget, maxMs }) => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain: (d: string) => { framesDrawnFor: (id: string) => number } };
      };
      const read = (): number => {
        try {
          return w.__engine!().getDomain('video').framesDrawnFor(nodeId);
        } catch {
          return -1;
        }
      };
      const base = read();
      const t0 = performance.now();
      let rafSamples = 0;
      let delta = 0;
      await new Promise<void>((resolve) => {
        const tick = (): void => {
          rafSamples++;
          delta = read() - base;
          const elapsed = performance.now() - t0;
          if (delta >= target || rafSamples >= frameBudget || elapsed >= maxMs) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return { delta, rafSamples, elapsedMs: performance.now() - t0, base };
    },
    { nodeId, target, frameBudget, maxMs },
  );
}

async function canvasData(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel) => {
    const c = document.querySelector(sel) as HTMLCanvasElement | null;
    return c ? c.toDataURL() : '';
  }, selector);
}

/**
 * Wait for the canvas's pixels to CHANGE from `before` (a live picture),
 * sampled INSIDE THE PAGE.
 *
 * ⚠ THIS USED TO BE A PLAYWRIGHT-SIDE `expect.poll`, AND THAT IS THE #1993
 * DEFECT, not a budget that was merely too tight. A poll is one round-trip per
 * sample ON THE SAME MAIN THREAD as the subject — and each sample shipped a
 * whole `toDataURL()` PNG across the wire — so on a loaded runner the
 * instrument competed with the rAF loop it was measuring. Worse, its output
 * could not tell the two apart: "the picture is frozen" and "we never got a
 * look" both arrive as the same bare timeout. This is the same fix #1982/#1983
 * made to `sampleThumbCost` in this file; that change left these two helpers
 * behind, which is why the poll survived to fail on shard 5 at 7eeccfb30.
 *
 * ⚠ THE GATE IS A FRAME COUNT, NOT A CLOCK. What is being waited for is a
 * REPAINT, which is a per-frame event, so the budget is frames. The ms ceiling
 * exists only to bound a catastrophic failure and is never the thing that
 * decides a healthy run.
 *
 * ⚠ AND THE SAMPLER IS THROTTLED TO THE SUBJECT'S OWN CADENCE, deliberately:
 * `VIDEO_THUMB_FPS` caps the thumb at 15 repaints/s off `performance.now()`, so
 * encoding a PNG on every rAF tick would burn main-thread time on frames that
 * cannot have changed — an instrument slowing the thing it measures. Sampling
 * no faster than the subject can repaint is the principled rate, not a
 * hand-tuned one.
 *
 * The result carries `rafSamples` / `elapsedMs` / `samples`, so a starved
 * runner is VISIBLE in the failure message instead of indistinguishable from a
 * dead producer.
 */
interface CanvasChangeSample {
  changed: boolean;
  rafSamples: number;
  /** How many times the canvas was actually encoded + compared. */
  samples: number;
  elapsedMs: number;
}

async function sampleCanvasChange(
  page: Page,
  selector: string,
  before: string,
  frameBudget: number,
  maxMs: number,
): Promise<CanvasChangeSample> {
  return page.evaluate(
    async ({ selector, before, frameBudget, maxMs, minGapMs }) => {
      const t0 = performance.now();
      let rafSamples = 0;
      let samples = 0;
      let changed = false;
      let lastSampleAt = -Infinity;
      await new Promise<void>((resolve) => {
        const tick = (): void => {
          rafSamples++;
          const now = performance.now();
          if (now - lastSampleAt >= minGapMs) {
            lastSampleAt = now;
            samples++;
            const c = document.querySelector(selector) as HTMLCanvasElement | null;
            if (c && c.toDataURL() !== before) {
              changed = true;
              resolve();
              return;
            }
          }
          if (rafSamples >= frameBudget || now - t0 >= maxMs) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return { changed, rafSamples, samples, elapsedMs: performance.now() - t0 };
    },
    { selector, before, frameBudget, maxMs, minGapMs: 1000 / VIDEO_THUMB_FPS },
  );
}

async function expectCanvasChanges(page: Page, selector: string, before: string, what: string): Promise<void> {
  const s = await sampleCanvasChange(page, selector, before, CHANGE_FRAME_BUDGET, CHANGE_MAX_MS);
  expect(
    s.changed,
    `${what}: canvas pixels change between frames — saw NO change over ${s.samples} encoded ` +
      `sample(s) across ${s.rafSamples} rAF frames in ${Math.round(s.elapsedMs)}ms. ` +
      `⚠ Read rafSamples FIRST: a low count means the RUNNER was starved (the picture may be ` +
      `fine); a high count with no change means the producer really is frozen.`,
  ).toBe(true);
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

  // ⚠ THE FIXTURE'S OWN HEALTH, as a named test rather than an import-time
  // throw (the #1864 shape). Red at the point a promotion empties the pool,
  // in the suite that owns it, naming what it lost — never a suite-wide crash
  // for a reason none of the other cases has anything to do with.
  test('the derived video-SINK fixture is healthy', () => {
    expect(fixtureProblems(VIDEO_SINK_FIXTURE), VIDEO_SINK_FIXTURE.why).toEqual([]);
    // And it must be WIRABLE, which is the half `VIDEO_FIXTURE` does not
    // promise: a resolved subject with no video input port would fail at
    // injectPatch with an edge to a port that does not exist.
    expect(SINK_IN_PORT, `the derived sink '${SINK_TYPE}' exposes a video input port`).not.toBeNull();
  });

  test('video-domain tiles show LIVE ANIMATED thumbnails via the real chain; the fake wave glyph is GONE for them', async ({ page }) => {
    // ⚠ DERIVED, and the stale comment it replaces is why. It read "the
    // frames-drawn + pixel-change polls (20s budgets each) don't fit a flat 30s"
    // — but #1993 raised those ceilings to 60 s under SLOW_RENDER and this
    // literal stayed at 90 000, so the envelope stopped containing the two
    // budgets it spends (60 + 60 = 120). This case spends ONE
    // `sampleDrawAdvance` and ONE `expectCanvasChanges`.
    test.setTimeout(videoCaseTimeout(1, 1));
    // An exhausted pool is a MIGRATION state, not a failure — the named test
    // above is what goes red for it. Skipping here keeps the failure in one
    // place instead of two.
    test.skip(
      VIDEO_SINK_FIXTURE.kind !== 'ok' || SINK_IN_PORT === null,
      VIDEO_SINK_FIXTURE.why,
    );
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
        // ⚠ A SECOND DOWNSTREAM NODE. It was added when `backdraft` was
        // promoted and lost its thumb (#1785), because the "thumb blit DRIVES
        // the real chain and the picture ANIMATES" half of this case needs a
        // tile that HAS one. #1785 gave the faced tile its picture back, so
        // that is no longer the reason to keep it — this one is: `g1` is
        // UN-MIGRATED, so it exercises the PLACEHOLDER thumb loop, and b1 now
        // exercises the FACED one. Two hosts, one `VideoTileThumb`; dropping
        // either would leave a host unproven.
        //
        // ⚠ AND THE TYPE IS DERIVED (#1929) — it was the literal
        // `grainsOfVision` until that module was promoted, which would have
        // turned this into the FACED host twice over with every assertion still
        // green. See SINK_TYPE at the top of this file.
        { id: 'g1', type: SINK_TYPE, position: { x: -200, y: 4500 } },
      ],
      [
        { id: 'e-lb', from: { nodeId: 'l1', portId: 'out' }, to: { nodeId: 'b1', portId: 'in_a' }, sourceType: 'mono-video', targetType: 'video' },
        { id: 'e-lg', from: { nodeId: 'l1', portId: 'out' }, to: { nodeId: 'g1', portId: SINK_IN_PORT! }, sourceType: 'mono-video', targetType: 'video' },
      ],
    );

    // ⚠ THE SUBJECT MUST STILL BE A PLACEHOLDER, ASSERTED ON THE PAGE. The
    // fixture derives an UN-PROMOTED type from the golden, but the golden is a
    // committed file and `STRICT_FACES` is code — if they ever disagree, every
    // assertion below would silently move to the faced host and this case would
    // duplicate `b1` while reading green. This is the one leg that cannot be
    // replaced by a stronger derivation, because it is the derivation's own
    // negative control.
    await expect(
      page.locator(`.svelte-flow__node[data-id="g1"] [data-testid="module-shell-placeholder"]`),
      `the derived subject '${SINK_TYPE}' must render a PLACEHOLDER tile — if it is faced, this ` +
        `case is a second copy of b1 and the placeholder thumb host is no longer proven anywhere`,
    ).toHaveCount(1);

    // Each PLACEHOLDER tile's glyph slot is the LIVE THUMB, and the fake
    // dashed-wave SVG is GONE for video modules.
    //
    // ⚠ `b1` (BACKDRAFT) IS NOT ONE OF THEM because it is FACED, not because it
    // has no thumb — it has one again (#1785), asserted on the shell host a few
    // lines below. This loop is the placeholder host.
    //
    // ⚠ `l1` USED TO BE IN THIS LOOP AND IS NOT ANY MORE — batch-23a promoted
    // `lines`, so it renders a FACED shell tile and has no
    // `module-shell-placeholder` at all. The case went honestly RED
    // ("l1 renders a placeholder tile … Received: 0"), which is the good
    // outcome: `l1` was doing two unrelated jobs here, ANIMATED SOURCE for the
    // chain and PLACEHOLDER HOST for this loop, and only the second one
    // promotion invalidates. It keeps the first — it is still the auto-scrolling
    // source feeding `b1` and `g1`, which is why the node is still spawned.
    //
    // ⚠ THE REPLACEMENT IS `g1`, THE DERIVED SUBJECT, NOT ANOTHER LITERAL. That
    // is the whole point of #1929, which this file already argues for `SINK_TYPE`
    // a few lines up: a hard-coded un-migrated module is a promotion away from
    // breaking, and picking a different name here would just reset that clock.
    // `g1` is resolved from the contract golden by the predicates these
    // assertions actually need (un-promoted, video domain, resolvable card, not a
    // NON_SHELL_LANE_TYPES snowflake, video in AND out), so it CANNOT be a faced
    // module — and a future promotion drops it from the pool automatically
    // instead of reddening this line.
    for (const id of ['g1', RECORDERBOX]) {
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
    const adv = await sampleDrawAdvance(page, 'g1', 2, LIVENESS_FRAME_BUDGET, LIVENESS_MAX_MS);
    // The engine-reachable leg stays SEPARATE, because "-1, unreachable" and
    // "0, reachable but never drew" are different failures and a bare delta
    // conflates them.
    expect(adv.base, 'video engine reachable').toBeGreaterThanOrEqual(0);
    expect(
      adv.delta,
      'the downstream video node draws frames while its tile thumb is on-screen — saw ' +
        `delta=${adv.delta} over ${adv.rafSamples} rAF frames in ${Math.round(adv.elapsedMs)}ms. ` +
        `⚠ Read rafSamples FIRST: a count near ${LIVENESS_FRAME_BUDGET} means the page really ran ` +
        'and the chain did not draw; a small count means the RUNNER was starved and this is an ' +
        'instrument reading, not a product failure (#1993).',
    ).toBeGreaterThanOrEqual(2);

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
    // ⚠ Re-pointed by #1821: this is a "the video zone has mounted" gate, and
    // videoOut is a promoted FACE TILE now rather than a legacy card. The gate
    // is incidental; the subject is `bcost` below.
    await expect(videoOutLane(page)).toBeVisible({ timeout: 15_000 });

    // ⚠ AND THE ONE-BLITTER ARGUMENT SURVIVES THAT PROMOTION, which is worth
    // stating because it is the instrument. videoOut now paints a live
    // `VideoTileThumb` of its own, so a second thumb COULD have been blitting
    // into the engine-wide `renderCostStats().blit` this test attributes to one
    // tile — the exact "two capped thumbs read as a broken cap" error the note
    // below describes. It does not, because `centerOnNode(bcost)` frames a node
    // at y=6200 and leaves the video zone (y≈4560) off-screen, where the thumb's
    // own IntersectionObserver cancels its rAF outright.
    //
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
    // ⚠ CONVERTED FROM A PLAYWRIGHT-SIDE POLL (#1993) — and the assertion got
    // STRONGER in the process, which is worth saying because it is a change of
    // subject and not just of instrument. The poll read the ABSOLUTE counter
    // and asked for `> 0`, which is satisfied by a chain that drew once at boot
    // and has since died. What this window needs is that the chain is rendering
    // NOW, so the replacement waits for the counter to ADVANCE from a baseline
    // taken here.
    const armed = await sampleDrawAdvance(page, 'bcost', 1, LIVENESS_FRAME_BUDGET, LIVENESS_MAX_MS);
    expect(
      armed.delta,
      'the thumb has armed and the chain is rendering before the window opens — saw ' +
        `delta=${armed.delta} over ${armed.rafSamples} rAF frames in ${Math.round(armed.elapsedMs)}ms ` +
        '(low rafSamples ⇒ starved runner, not a dead chain — #1993)',
    ).toBeGreaterThanOrEqual(1);
    const on = await sampleThumbCost(page, 'bcost', COST_WINDOW_MS, MIN_COST_SAMPLES);
    console.log(`[1785] lane thumb ON-screen ${JSON.stringify(on)}`);
    expect(
      on.rafSamples,
      `the window ran at all — ${on.rafSamples} rAF samples over ${on.elapsedMs.toFixed(0)} ms. ` +
        'A starved runner and a frozen subject are indistinguishable from the counters alone. ' +
        `Units are FRAMES: the window SELF-EXTENDS until it has seen ${MIN_COST_SAMPLES}, so ` +
        `coming up short means it hit the ${COST_WINDOW_MAX_MS} ms ceiling and the page is not ` +
        'painting — it does NOT mean the runner was merely slow.',
    ).toBeGreaterThanOrEqual(MIN_COST_SAMPLES);
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
    const off = await sampleThumbCost(page, 'bcost', COST_WINDOW_MS, MIN_COST_SAMPLES);
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
    // ⚠ WHICH LIMIT WAS ACTUALLY BINDING — the gate states its own scope,
    // because the cadence cap CAN ONLY BITE where the page paints faster than
    // the cadence. Where rAF itself is slower than VIDEO_THUMB_FPS the thumb is
    // due on every tick, so the rate assertion below is satisfied by the
    // RENDERER rather than by the throttle. Both regimes are real and both were
    // measured: 61–70 rAF/s locally under E2E_SWIFTSHADER=1 (CADENCE-BOUND —
    // one run's 94 ticks produced only 19 blits, the throttle dropping 75) and
    // 1.3 rAF/s on a contended CI runner (rAF-BOUND — 3 ticks, 3 blits, so the
    // throttle never engaged at all). So on CI the cadence
    // cap is a green that certifies nothing, and the per-frame bound at the
    // bottom of this block is what holds the line there.
    const rafRate = (on.rafSamples / on.elapsedMs) * 1000;
    const regime = rafRate > VIDEO_THUMB_FPS ? 'CADENCE-BOUND' : 'rAF-BOUND';
    console.log(
      `[1785] lane thumb blit rate ${rate.toFixed(1)}/s over ${thumbBlits} blits ` +
        `(${rafRate.toFixed(1)} rAF/s — ${regime})`,
    );
    expect(
      rate,
      `an ON-SCREEN lane thumbnail is CAPPED: ${rate.toFixed(1)} blits/s (${thumbBlits} blits over ` +
        `${on.elapsedMs.toFixed(0)} ms, ${on.rafSamples} rAF samples). Units are BLITS PER SECOND, ` +
        `against the component's own VIDEO_THUMB_FPS cadence — a wall-clock product interval, not ` +
        `a frame budget. Exceeding it means the thumb is repainting at full rAF, which is the ` +
        `pre-#1802 behaviour. This window was ${regime} at ${rafRate.toFixed(1)} rAF/s.`,
    ).toBeLessThanOrEqual(VIDEO_THUMB_FPS * COST_RATE_SLACK);
    // NEGATIVE CONTROL on the instrument itself: a cap assertion that a DEAD
    // loop would also satisfy proves nothing.
    expect(rate, 'and the capped loop is actually running, not merely slow').toBeGreaterThan(0);
    // THE BOUND THAT SURVIVES A SLOW RENDERER. The thumb repaints from ONE rAF
    // registration, so it cannot blit more than once per frame at ANY frame
    // rate — unlike the cadence cap, this holds in the rAF-BOUND regime, which
    // is the regime CI runs in. It is what would catch a SECOND blitter there:
    // the "two capped thumbs measured 21.3 blits/s and read as a broken cap"
    // error the header note describes, arriving on a runner too slow for that
    // number to ever appear. `+1` is the window-edge allowance — the sampler's
    // rAF loop and the thumb's are separate registrations, so the thumb can
    // catch one extra tick at an edge. A policy allowance on a derived
    // measurement, not a population count.
    expect(
      on.blitCalls,
      `ONE rAF loop means AT MOST ONE BLIT PER FRAME: ${on.blitCalls} blits against ` +
        `${on.rafSamples} rAF samples (${regime}). More than that many blits means a SECOND ` +
        `thumbnail — or a second loop on this one — is blitting into the engine-wide counter, ` +
        `which breaks the one-blitter attribution every number in this test rests on.`,
    ).toBeLessThanOrEqual(on.rafSamples + 1);
  });

  test('dock full-view renders LIVE video for expanded video modules (feedback and videoOut, each via its own EXPAND pill) with a render lease', async ({ page }) => {
    // Software-renderer scale: TWO sequential dock full-views with pixel-change
    // polls + lease polls starved the flat 30s budget on CI shard 10 (run
    // 30179147114, both attempts) while every step completed.
    //
    // ⚠ NOW DERIVED, because the literal was at the limit rather than past it
    // and would have gone the same way as the case above: this spends TWO
    // `expectCanvasChanges` (docked feedback, docked videoOut), i.e. 120 000 ms
    // of ceiling under SLOW_RENDER inside a 120 000 ms envelope — zero room for
    // two rack boots and two EXPAND interactions.
    test.setTimeout(videoCaseTimeout(0, 2));
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
    // ⚠ RE-POINTED WHEN FEEDBACK WAS PROMOTED (batch 24). Promotion is a
    // BEHAVIOUR change, not a skin: `migrated('feedback')` is now true, so the
    // lane renders a real `module-shell` TILE instead of the
    // `module-shell-placeholder` that stands in for an unfaced module, and the
    // dock renders `<ModuleShell view="dock-full">` instead of
    // `FeedbackCard.svelte`. Both locators below moved for that reason and only
    // that reason — the SUBJECT changed, so the assertions follow it.
    //
    // ⚠ THIS IS STRICTLY STRONGER THAN WHAT IT REPLACED, which is why the leg was
    // re-pointed rather than re-homed on another module. The canvas it now polls
    // is `FeedbackOutputBody`'s — the module's own `fullViewBody` extension —
    // so the same three assertions (mounts / paints / ANIMATES) now prove the
    // faced dock surface end-to-end, including that the extension's rAF loop
    // survives the dock mount. Before promotion they proved it of a card the
    // dock no longer renders.
    //
    // ⚠ AND THE REGRESSION THIS CASE EXISTS FOR IS UNAFFECTED. The original
    // defect — a legacy card whose bare `useStore()` threw outside the
    // SvelteFlow provider and mounted DEAD in the dock — is the videoOut leg
    // below, and videoOut is NOT faced (it is the one named exemption in
    // `video-face-screen-source.test.ts`). The `providerErrors` sink still
    // covers both halves.
    const b1Tile = page.locator(`.svelte-flow__node[data-id="b1"] [data-testid="module-shell"]`);
    await expect(b1Tile, 'the faced feedback shell tile').toBeVisible();
    await b1Tile.getByTestId('shell-open-dock').click();
    const faceplate = page.getByTestId('dock-full-view');
    await expect(faceplate).toBeVisible();
    const FEEDBACK_FACE_CANVAS = '[data-testid="dock-full-view"] [data-testid="feedback-face-canvas"]';
    const dockPreview = faceplate.locator('[data-testid="feedback-face-canvas"]');
    await expect(dockPreview, 'feedback video surface mounts in the dock').toBeVisible();
    const bFirst = await canvasData(page, FEEDBACK_FACE_CANVAS);
    expect(bFirst).not.toBe('');
    await expectCanvasChanges(page, FEEDBACK_FACE_CANVAS, bFirst, 'docked feedback');
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

    // ⚠ RE-POINTED (2026-08-23, #1754), AND THE OLD LINE IS WORTH READING BEFORE
    // THE NEW ONE. It was `expect(headless-source-host).toHaveCount(0)` — "the
    // legacy shell hosts nothing" — and it was TRUE ONLY BECAUSE A PRODUCER WAS
    // DEAD. The pinned TIMELORDE every rack auto-spawns is canvas-hidden, so its
    // card mounted NOWHERE in either shell; `video_out` served its idle field
    // forever (measured `nonBlack 0/3072, maxLuma 8`). Fixing that gives legacy a
    // host, so the old assertion could only stay green by leaving the bug in.
    //
    // ⚠ AND THE CLAIM THIS TEST IS ACTUALLY MAKING IS UNDAMAGED. Its subject is
    // "the SHELL is a strict no-op under ?shell=legacy" — no shell tiles, no
    // thumbs, the videoOut verbatim card. A headless host is not a shell feature:
    // it is a LIFETIME mechanism keyed on `laneOmitsNode`, the one arm of
    // `needsHeadlessSourceMount` that its own doc-comment calls "the ONE ARM THAT
    // IS NOT SHELL-SPECIFIC". So the assertion is narrowed to what the shell
    // itself may not do — host a module the SHELL swapped away — which is the
    // regression the original line was written to catch, and it still fails on it.
    // ⚠ AN ATTRIBUTE SELECTOR, NOT `filter({hasNot})`: the type lives on the host
    // element ITSELF, and `filter` matches DESCENDANTS — it would have excluded
    // nothing and passed for the wrong reason.
    await expect(
      page.locator('[data-testid="headless-source-host"]:not([data-node-type="timelorde"])'),
      'a headless host under ?shell=legacy for something OTHER than the canvas-hidden clock — ' +
        'the shell is supposed to be a strict no-op here',
    ).toHaveCount(0);
    // POSITIVE CONTROL for the narrowing: the clock's host really is the one
    // being excluded, so this cannot quietly become "count anything, exclude
    // everything".
    await expect(
      page.locator('[data-testid="headless-source-host"][data-node-type="timelorde"]'),
      'the canvas-hidden clock has no host on legacy either — #1754 is only half fixed',
    ).toHaveCount(1);
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
    // Software-renderer scale: two full rack boots, each with a live
    // acidwarp→videoOut chain and a pixel-change poll.
    //
    // ⚠ THE WORST OF THE THREE, and only visible once the envelope is written
    // as arithmetic: `buildAndProbe` is called TWICE (`/rack` and
    // `/rack?shell=legacy`) and EACH call spends a `sampleDrawAdvance` AND an
    // `expectCanvasChanges` — 2 x (60 000 + 60 000) = 240 000 ms of ceiling
    // under SLOW_RENDER, inside a 120 000 ms literal. Half the budget the case
    // is allowed to spend was unreachable.
    test.setTimeout(videoCaseTimeout(2, 2));

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
      // ⚠ THE SAME #1993 POLL AS THE `g1` LEG, on a different node. It is
      // converted here rather than left for the next red run: this file carried
      // THREE copies of the pattern and only one of them lost the race at
      // 7eeccfb30 — fixing that one alone would have left two armed.
      const aw = await sampleDrawAdvance(page, 'aw1', 2, LIVENESS_FRAME_BUDGET, LIVENESS_MAX_MS);
      expect(aw.base, `${url}: video engine reachable`).toBeGreaterThanOrEqual(0);
      expect(
        aw.delta,
        `${url}: acidwarp draws frames while the OUTPUT is watching it — saw delta=${aw.delta} ` +
          `over ${aw.rafSamples} rAF frames in ${Math.round(aw.elapsedMs)}ms ` +
          '(low rafSamples ⇒ starved runner, not a dead chain — #1993)',
      ).toBeGreaterThanOrEqual(2);

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

    // ⚠ SUBJECT MOVED THREE TIMES (LEG-02, #1511): `videobox` in P1,
    // `videovarispeed` in P2, `tvLibrarian` after that — and the SECOND move is
    // the cautionary one. P1 re-pointed this test at videovarispeed; P2
    // converted videovarispeed, so the subject went stale again and this test
    // went RED ON CI ("videovarispeed gets an off-screen lifecycle host"),
    // caught by nothing local because the phase's own spec runs were scoped to
    // the module's OWN specs. The lesson is mechanical: converting a module
    // means re-running every spec that NAMES it, found by grep, not by filename.
    // P3 converted BOTH tuners, so the subject is now `archivist` — card-owned,
    // unfaced, and exercising the identical arm. When IT converts, re-point
    // again; when the set empties, this test's subject is gone for good and the
    // test goes with it. This test's subject
    // is "a module whose engine-visible source lives on its CARD gets an
    // off-screen host". VIDEOBOX IS NO LONGER SUCH A MODULE: its attach, audio
    // wiring and loops moved to `$lib/ui/media/node-video-source-registry` on
    // graph lifetime, so it left `DOM_SOURCE_LANE_TYPES` and gets no host at all.
    //
    // Left pointed at videobox, this test would have gone RED — but the wrong
    // repair is what to watch for here: relaxing it to `toHaveCount(0)` would
    // have kept the NAME while inverting the CLAIM, leaving a test called "keeps
    // its REAL card alive off-screen" that asserts nothing of the kind. So the
    // subject is re-pointed at a module that still has the property, and
    // videobox's new behaviour is asserted separately below as its own claim.
    // `archivist` is unfaced and still card-owned, so it renders the same
    // placeholder tile videobox used to and exercises the identical arm.
    await injectPatch(page, [{ id: 'arc1', type: 'archivist', position: { x: -1200, y: 5100 } }]);

    // The LANE still shows the uniform tile (the shell look is preserved — this
    // fix is NOT "give every source module the legacy card back")…
    await expect(
      page.locator(`.svelte-flow__node[data-id="arc1"] [data-testid="module-shell-placeholder"]`),
      'archivist still renders the uniform RACKLINE tile in its lane',
    ).toHaveCount(1);

    // …while its REAL card is mounted in the off-screen lifecycle host, so its
    // source attach/detach still runs.
    const host = page.locator('[data-testid="headless-source-host"][data-node-id="arc1"]');
    await expect(host, 'archivist gets an off-screen lifecycle host').toHaveCount(1);
    await expect(host, 'the host mounts the REAL archivist card').toHaveAttribute('data-node-type', 'archivist');
    await expect(
      host.locator('[data-testid="archivist-card"]'),
      "the hosted card is the module's real card, not a stub",
    ).toHaveCount(1);

    // ── THE CONVERTED MODULE, asserted as its own claim ──────────────────────
    //
    // A node-owned source gets NO host, and that absence is the whole payoff of
    // #1511: the off-screen mount was a tax every rack paid. Asserted here, in
    // the test that owns the host's behaviour, so the two answers live side by
    // side and a future edit cannot give videobox a host back unnoticed.
    // Whether its SOURCE is actually live without one is
    // `node-source-videobox.spec.ts`'s job — this leg only owns the host.
    //
    // ⚠ THE CARD TESTID IS CARRIED PER ROW rather than derived from the type.
    // It used to be `type.toLowerCase() + '-card'`, which happens to be right
    // for videobox and videovarispeed and is WRONG for `tvLibrarian`
    // (`tv-librarian-card`) — so P3's additions would have looked for a selector
    // that matches nothing and the `toHaveCount(0)` leg would have passed
    // vacuously, certifying exactly the state it exists to refuse.
    //
    // ⚠ THE LANE TILE IS ALSO CARRIED PER ROW, for the same reason the card
    // testid is. "Node-owned source" and "un-migrated" are two INDEPENDENT
    // properties that happened to coincide for the first three rows, and reading
    // one off the other is what breaks the moment either moves. `tvLibrarian` is
    // now PROMOTED, so its lane tile is a real faceplate (`module-shell`) rather
    // than the RACKLINE placeholder — which changes nothing about the two legs
    // this test actually owns (no headless host, no card mounted anywhere), and
    // those still run unchanged for every row.
    const converted = [
      ['vb1', 'videobox', 'videobox-card', 'module-shell-placeholder'],
      ['vv1', 'videovarispeed', 'videovarispeed-card', 'module-shell-placeholder'],
      ['pt1', 'peertube', 'peertube-card', 'module-shell-placeholder'],
      ['tv1', 'tvLibrarian', 'tv-librarian-card', 'module-shell'],
    ] as const;
    for (const [nodeId, type, cardTestId, laneTile] of converted) {
      await injectPatch(page, [{ id: nodeId, type, position: { x: -1600, y: 5100 } }]);
      await expect(
        page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="${laneTile}"]`),
        `${type} does not render the ${laneTile} tile its migration state calls for`,
      ).toHaveCount(1);
      await expect(
        page.locator(`[data-testid="headless-source-host"][data-node-id="${nodeId}"]`),
        `${type} got an off-screen host — its lifecycle is node-owned, so nothing should be keeping its card alive`,
      ).toHaveCount(0);
      await expect(
        page.locator(`[data-testid="${cardTestId}"]`),
        `a ${type} card is mounted somewhere despite the module being converted`,
      ).toHaveCount(0);
    }

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
      page.locator('[data-testid="headless-source-host"][data-node-id="arc1"]'),
    ).toHaveCount(1);

    // ⚠ cameraInput IS HOSTED NOW, AND THIS ASSERTION USED TO SAY THE OPPOSITE.
    // It read:
    //
    //   // cameraInput must NEVER be hosted — it keeps its real card IN the
    //   // lane (carve-out), so hosting it would be the double-mount above.
    //   await expect(page.locator('…[data-node-id="cam1"]')).toHaveCount(0);
    //
    // Both halves of that were true when written and the FIRST half is what
    // changed: `cameraInput` was in `NON_SHELL_LANE_TYPES`, so its real card
    // rendered in the lane and a host would indeed have been a second mount.
    // It was promoted and left that set, so the lane paints its faceplate and
    // the host is now the ONLY mount — which makes it an ordinary member of
    // this test's subject rather than the exception to it.
    //
    // The double-mount hazard the old line guarded has NOT been waived; it has
    // moved to where it can still occur, and it is asserted BELOW rather than
    // deleted: exactly one host for this node, and none at all under
    // `?shell=legacy` (see `camerainput-shell-source.spec.ts`, which drives the
    // legacy shell and asserts the count is zero there).
    await injectPatch(page, [{ id: 'cam1', type: 'cameraInput', position: { x: -700, y: 5100 } }]);
    const camHost = page.locator('[data-testid="headless-source-host"][data-node-id="cam1"]');
    await expect(camHost, 'a promoted CAMERA keeps its real card in the off-screen host').toHaveCount(1);
    await expect(
      camHost.locator('[data-testid="camera-device-select"]'),
      "the hosted card is the module's real card, not a stub",
    ).toHaveCount(1);
  });

  test('the CAMERA source picker is reachable on the FACEPLATE under the shell (device list capability-gated)', async ({ page }) => {
    // ⚠ THIS TEST WAS GREEN AND BLIND, AND THAT IS WHY IT IS REWRITTEN RATHER
    // THAN RE-TARGETED. It was titled "…reachable in the lane" and asserted:
    //
    //   const laneNode = page.locator('.svelte-flow__node[data-id="cam1"]');
    //   await expect(laneNode.locator('[data-testid="module-shell-placeholder"]')).toHaveCount(0);
    //   const picker = laneNode.locator('[data-testid="camera-device-select"]');
    //   await expect(picker, '…present + usable in the shell lane').toBeVisible();
    //
    // After cameraInput's promotion it KEPT PASSING while the thing it names
    // stopped being true. Two mechanisms combined, and neither is visible from
    // the assertion:
    //
    //   1. `<HeadlessSourceHost>` mounts the real card inside its OWN
    //      single-node `<SvelteFlow>`, passing `type`/`id` through — so
    //      `.svelte-flow__node[data-id="cam1"]` matches TWO elements, the lane
    //      tile AND the hosted card. `laneNode.locator(...)` resolved through
    //      the HOST's copy.
    //   2. Playwright's `toBeVisible` means "has a non-empty box and is not
    //      display:none/visibility:hidden". The host parks at `left:-9999px`,
    //      which satisfies that — so OFF-SCREEN reads as VISIBLE.
    //
    // MEASURED on the promoted tree, with the old locators still in place:
    //   totalPickers 1 · pickersInsideHeadlessHost 1 · pickersOutsideHeadlessHost 0
    //   nodesMatchingLaneSelector 2 (laneNodeIsHost [false, true])
    //   firstPickerRect.left -9976 · host pointer-events "none"
    // i.e. the ONLY picker in the document was 9976 px off-screen inside a
    // subtree that cannot receive a click, and the test called it "usable in
    // the shell lane". The `module-shell-placeholder` leg also still passed,
    // but for a NEW reason (the lane is a `module-shell` FACE now, not a
    // placeholder) rather than the old one (the carve-out gave it a real card).
    //
    // ⚠ SO THE SUBJECT MOVED, AND THE ASSERTION FOLLOWS IT rather than being
    // weakened: the picker is no longer a lane affordance at all. It lives in
    // the faceplate's extension body, which is a real, clickable surface. The
    // locators below are scoped so that an off-screen copy can NEVER satisfy
    // them again — that is the repair, not the re-title.
    test.setTimeout(SLOW_RENDER ? 90_000 : 30_000);
    await gotoShell(page);
    await expect(videoOutLane(page)).toBeVisible({ timeout: 15_000 });

    await injectPatch(page, [{ id: 'cam1', type: 'cameraInput', position: { x: -1200, y: 5100 } }]);

    // (a) THE LANE CARRIES NO PICKER, stated as a property of the whole
    //     document rather than of a selector that cannot tell the two mounts
    //     apart: every `camera-device-select` there is must be inside the host.
    const hostedPicker = page.locator(
      '[data-testid="headless-source-host"][data-node-id="cam1"] [data-testid="camera-device-select"]',
    );
    await expect(hostedPicker, "the real card's picker is in the off-screen host")
      .toHaveCount(1, { timeout: 15_000 });
    await expect(
      page.locator('[data-testid="camera-device-select"]'),
      'and it is the ONLY one — nothing reachable in the lane, which is the point',
    ).toHaveCount(1);

    // (b) THE FACEPLATE CARRIES ONE, and it is genuinely operable. `[data-testid=
    //     "module-shell"]` exists only on the lane tile, so this locator cannot
    //     resolve through the host the way the old one did.
    //
    // Same re-pointing discipline the FEEDBACK leg above records for batch 24:
    // "Promotion is a BEHAVIOUR change, not a skin … the SUBJECT changed, so the
    // assertions follow it." `centerOnNode` is required before the click for the
    // same reason it is there — the lane band sits far down in flow space, so an
    // un-centred tile is off-screen and the click times out.
    await centerOnNode(page, 'cam1', 0.9);
    const camTile = page.locator('.svelte-flow__node[data-id="cam1"] [data-testid="module-shell"]');
    await expect(camTile, 'the faced CAMERA shell tile').toBeVisible({ timeout: 15_000 });
    await camTile.getByTestId('shell-open-dock').click();
    const dock = page.getByTestId('dock-full-view');
    await expect(dock).toBeVisible({ timeout: 15_000 });

    const picker = dock.getByTestId('cameraInput-face-device-select');
    await expect(picker, 'the device picker is present on the faceplate').toBeVisible({ timeout: 15_000 });

    // ⚠ NOT `toBeVisible` ALONE — that is the exact predicate that went blind,
    // so re-using it here would rebuild the same hole one surface over. Two
    // checks that a left:-9999px mount cannot satisfy:
    //
    //   (i) SCROLL-REACHABLE. The faceplate body is taller than the pane (the
    //       480x360 preview sits above this row), so the picker legitimately
    //       starts below the fold — which is why `toBeInViewport` alone is the
    //       WRONG bar: it would fail a control a user reaches by scrolling.
    //       Scrolling IS the user action, so do it and then require the result.
    //       The host cannot be rescued this way: it is `position: fixed`, so no
    //       amount of scrolling moves it into the viewport.
    await picker.scrollIntoViewIfNeeded();
    await expect(picker, 'the picker comes into view when scrolled to').toBeInViewport();

    //  (ii) ON-CANVAS, stated against the number that was actually measured.
    //       The blind version resolved a picker whose box was at x = -9976.
    const box = await picker.boundingBox();
    expect(box, 'the picker has a layout box at all').not.toBeNull();
    expect(
      box!.x,
      `the picker must sit on-canvas, not parked off it (the blind version ` +
        `resolved one at x=-9976 inside the headless host); saw x=${Math.round(box!.x)}`,
    ).toBeGreaterThanOrEqual(0);

    // (iii) HIT-TESTABLE — the property that actually separates a real surface
    //       from a copy of one, asked the way the browser answers it.
    //
    // ⚠ TWO WRONG PREDICATES WERE TRIED HERE FIRST, and both are worth naming
    // because each looked obviously right:
    //
    //   * `toBeEnabled()` — passed locally, FAILED ON CI. The body renders
    //     `<select disabled={devices.length === 0}>`, and CI has no videoinput,
    //     so a disabled picker is CORRECT there. It was a capability-dependent
    //     assertion sitting ABOVE the capability gate — the exact trap the
    //     ci-capability discipline exists for. The genuine enabled-ness check
    //     belongs below the gate, and that is where it still is.
    //   * walking every ancestor for `pointer-events: none` — FAILED LOCALLY
    //     once zero cameras were simulated, and correctly so: the offender was
    //     `DIV.dock-fullview-drawer`, a `none` container whose inner panel sets
    //     `auto`. That is an ordinary overlay idiom, not a defect, so the
    //     predicate was wrong rather than the app.
    //
    // `elementFromPoint` at the element's own centre is the real question — it
    // is what the browser does on a click. It is true for a disabled control
    // (disabled changes event DISPATCH, not hit-testing) so it stays
    // capability-independent, and it is false for the headless host, whose
    // centre lies at a negative coordinate no point in the viewport maps to.
    const hitTestable = await picker.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
    });
    expect(
      hitTestable,
      'the picker is hit-testable at its own centre — a click would land on it, which is what ' +
        '"reachable" means and what the off-screen host can never satisfy',
    ).toBe(true);

    // ⚠ PERMANENT NEGATIVE CONTROL — the repaired predicate must still be able
    // to FAIL on the thing it was blind to, or this rewrite has only moved the
    // blindness. Run by hand against the hosted copy while repairing: pointing
    // `picker` at
    // `[data-testid="headless-source-host"][data-node-id="cam1"] [data-testid="camera-device-select"]`
    // fails at the scroll leg with `viewport ratio 0` — where the OLD predicate
    // (`toBeVisible`) passed on that same element. Kept as an executable leg
    // rather than a claim: the hosted picker is asserted to be exactly what the
    // reachable one is not.
    const hostedBox = await hostedPicker.boundingBox();
    expect(hostedBox, 'the hosted picker exists to compare against').not.toBeNull();
    expect(
      hostedBox!.x,
      `the host's copy must be OFF-canvas — if this ever goes >= 0 the two mounts ` +
        `are no longer distinguishable by position and the checks above go blind; ` +
        `saw x=${Math.round(hostedBox!.x)}`,
    ).toBeLessThan(0);

    // CAPABILITY GATE (ci-capability discipline): only assert "lists a real
    // device" where a videoinput actually exists. CI's default project has no
    // camera and no permission — there the picker correctly shows "no cameras"
    // and the reachability asserts above are the whole contract.
    const cameraCount = await page.evaluate(async () => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return 0;
      try {
        return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput').length;
      } catch {
        return 0;
      }
    });
    // ⚠ A BRANCH, NOT `test.skip` — deliberately, and it is the difference
    // between this case reporting a result on CI and reporting nothing. CI has
    // no videoinput, so a mid-test `test.skip` marks the WHOLE test skipped
    // there: the reachability assertions above would still fail if broken, but
    // a green run reports as "skipped", and a reader counting results sees a
    // case that never ran. The reachability half is the parity-critical claim
    // and it is capability-INDEPENDENT, so it must show up as a real pass.
    // Only the device-list half is conditional, and it says so.
    if (cameraCount > 0) {
      await expect
        .poll(async () => picker.locator('option').count(), {
          message: 'the picker lists at least one real camera',
          timeout: 15_000,
        })
        .toBeGreaterThanOrEqual(1);
      await expect(picker, 'a picker with real devices is enabled').toBeEnabled();
    } else {
      // The zero-device state is a real, reachable state and is asserted rather
      // than waved past: the control still renders, still says why, and is
      // correctly disabled. That is what CI actually exercises.
      await expect(picker, 'with no cameras the picker is correctly disabled').toBeDisabled();
      await expect(picker, 'and it says why').toContainText(/no cameras|unavailable/i);
    }
  });
});
