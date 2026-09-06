// e2e/tests/workflow-shell-video.spec.ts
//
// The VIDEO VISIBILITY fix, end to end (owner regression: video modules
// rendered the generic placeholder tile with a FAKE dashed-wave glyph, so there
// was NO user-viewable video output anywhere; and the dock full-view mounted
// videoOut's body DEAD — its bare useStore() threw outside the SvelteFlow
// provider, while DOOM, which never calls useStore, worked).
//
//   1. videoOut renders a FACE TILE carrying a live picture in the video zone,
//      and the freely resizable screen is the DETACHED DISPLAY (#1821). videoOut
//      has a `face`, so its lane tile is a ModuleShell with a live
//      VideoTileThumb rather than the placeholder that caused the original
//      regression.
//   2. Video-domain tiles carry a LIVE ANIMATED THUMBNAIL of the module's
//      actual output (the legacy blitOutputToDrawingBuffer preview seam) in
//      the glyph slot — the fake wave is GONE for video modules — and the
//      thumbnail's blit DRIVES the real chain (engine draw counters advance)
//      and its pixels actually change.
//   3. The dock full-view shows LIVE video for expanded video modules, holding
//      a hard render lease while open. ⚠ videoOut reaches it through its own
//      EXPAND pill now (it has a tile); the dev seam it used to need is kept
//      here only for the modules that still have no tile.
//
// DETERMINISM: chain liveness is asserted via ENGINE PROBES (framesDrawnFor —
// SwiftShader-tolerant); pixel-change asserts poll toDataURL inequality on a
// 2D canvas (renderer-tolerant: any two DIFFERENT frames of the auto-scrolling
// LINES pattern differ, no absolute pixel values are pinned).

import { test, expect, type Page } from '@playwright/test';
import { VIDEO_THUMB_FPS, SHELL_TILE_W } from '../../packages/web/src/lib/ui/workflow/module-shell-model';
import { SHELL_COLUMN_W } from '../../packages/web/src/lib/graph/channel-columns';
import {
  VIDEO_SINK_FIXTURE,
  contractDomain,
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

/** Nodes currently holding a HARD render lease (engine `pullStats().leased`).
 *  One round trip, read where the DOM has already proven the state it mirrors —
 *  see the dock full-view case for why this is a read and not a poll. */
async function leasedNodes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = globalThis as unknown as {
      __engine: () => { getDomain: (d: string) => { pullStats: () => { leased: string[] } } };
    };
    return w.__engine().getDomain('video').pullStats().leased;
  });
}
const RECORDERBOX = 'workflow-recorderbox';
const SYNESTHESIA = 'workflow-synesthesia';

/**
 * A node's RACKLINE lane tile.
 *
 * ⚠ IT MATCHED TWO TESTIDS AND NOW MATCHES ONE, and the reason it ever matched
 * two is worth keeping: two cases in this file had encoded a distinction they
 * did not depend on (#2295). What the callers actually assert is that a tile
 * PAINTED before geometry is measured — never anything about its contents — so
 * naming a narrower subject than the assertion needs is what made a PACKING
 * test and a HEADLESS-HOST test depend on the promotion queue. There is one
 * tile kind now, so the generality is free; the lesson is not.
 */
const laneTileSelector = (id: string) =>
  `.svelte-flow__node[data-id="${id}"] [data-testid="module-shell"]`;

// DERIVED, never re-typed (#2239): the gap is whatever the shell pitch leaves
// over a uniform tile. It was hardcoded 24 for the old 216 pitch, so the pitch
// change to 225 (an exact 10 HP) silently falsified it — a literal that names
// its own derivation in a comment is a literal that goes stale.
const VIDEO_ZONE_GAP = SHELL_COLUMN_W - SHELL_TILE_W;

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
 * It is a SHELL TILE (#1821): videoOut carries a real `face`, so its lane node
 * is a `ModuleShell` painting the LIVE `VideoTileThumb`, and the big picture
 * lives behind right-click → DETACH DISPLAY. Most call sites below use this
 * purely as a "the video zone has mounted" gate.
 */
function videoOutLane(page: Page) {
  return page.locator(`.svelte-flow__node[data-id="${VIDEO_OUT}"] [data-testid="module-shell"]`);
}

/** The videoOut surface that paints: the face tile's live thumb. */
function videoOutSurfaceSel(): string {
  return `.svelte-flow__node[data-id="${VIDEO_OUT}"] [data-testid="module-shell"] canvas`;
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
  //
  // ⚠ AND IT NO LONGER HAS TO COVER A `toDataURL()` — see `sampleCanvasChange`.
  // The change window's baseline used to be a separate Playwright→page round
  // trip charged to THIS term, and on run 33637747841's shard 2 that one call
  // cost 81.2 s against a 45 000 ms allowance. It is now the window's own first
  // sample, inside `CHANGE_MAX_MS`. Nothing here was raised to accommodate it;
  // the spend was moved to where a budget can see it.
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

/**
 * Wait for the canvas's pixels to CHANGE (a live picture), BASELINE AND ALL,
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
 * ⚠ AND #1993 LEFT THE BASELINE OUTSIDE, WHICH IS THE LAST COPY OF THE SAME
 * DEFECT AND IT WENT RED ON ITS OWN. The window's `before` used to come from a
 * separate `canvasData()` helper — one more Playwright→page round trip
 * shipping one more whole `toDataURL()` PNG, taken while the same starved main
 * thread was blitting every video tile on the page. MEASURED, from the blob
 * report of the run that failed (feat/peertube-face, run 33637747841, e2e shard
 * 2/12, `video-domain tiles show LIVE ANIMATED thumbnails`), FIRST attempt vs
 * the retry that passed:
 *
 *     step                              failing attempt      passing retry
 *     setup → g1 thumb visible                 24.0 s              21.6 s
 *     sampleDrawAdvance (60 s ceiling)         49.7 s               7.7 s
 *     canvasData  ← ONE toDataURL()            81.2 s               5.6 s
 *     sampleCanvasChange                 22.1 s, KILLED            13.4 s
 *
 * ONE `toDataURL()` cost 81.2 s of a 165 s envelope — 1.8× the whole 45 s
 * `SETUP_MS` term that is supposed to cover it — and it is spent OUTSIDE every
 * budget `videoCaseTimeout` accounts for, so the change window it precedes was
 * guillotined by the envelope at 22.1 s instead of returning its own diagnosis.
 * That is exactly the failure `videoCaseTimeout`'s header describes ("a run
 * that was still legitimately inside every budget it was given would be killed
 * by the envelope around them"), one layer further out.
 *
 * So the baseline is the window's FIRST encoded sample, taken on the same rAF
 * tick loop as the comparisons: one round trip instead of two, and the capture
 * is now INSIDE the frame budget and the ms ceiling, where a starved runner
 * makes it report rather than hang. No budget number changed.
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
  /** The BASELINE was encoded at all. False means the selector matched no
   *  canvas — a different failure from a frozen one, and the assertion the
   *  caller-side `expect(first).not.toBe('')` used to make. */
  captured: boolean;
  rafSamples: number;
  /** How many times the canvas was actually encoded (baseline included). */
  samples: number;
  elapsedMs: number;
}

async function sampleCanvasChange(
  page: Page,
  selector: string,
  frameBudget: number,
  maxMs: number,
): Promise<CanvasChangeSample> {
  return page.evaluate(
    async ({ selector, frameBudget, maxMs, minGapMs }) => {
      const encode = (): string => {
        const c = document.querySelector(selector) as HTMLCanvasElement | null;
        return c ? c.toDataURL() : '';
      };
      const t0 = performance.now();
      let rafSamples = 0;
      let samples = 0;
      let changed = false;
      let lastSampleAt = -Infinity;
      let before = '';
      await new Promise<void>((resolve) => {
        const tick = (): void => {
          rafSamples++;
          const now = performance.now();
          if (now - lastSampleAt >= minGapMs) {
            lastSampleAt = now;
            samples++;
            const data = encode();
            if (before === '') {
              // ⚠ NO CANVAS ⇒ RESOLVE NOW rather than spend the whole budget on
              // a selector that matches nothing. Every call site asserts the
              // surface is visible immediately before, so this is a hard error,
              // not a race worth waiting out — and it keeps the fast fail the
              // caller-side `not.toBe('')` had.
              if (data === '') {
                resolve();
                return;
              }
              before = data;
            } else if (data !== '' && data !== before) {
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
      return { changed, captured: before !== '', rafSamples, samples, elapsedMs: performance.now() - t0 };
    },
    { selector, frameBudget, maxMs, minGapMs: 1000 / VIDEO_THUMB_FPS },
  );
}

async function expectCanvasChanges(page: Page, selector: string, what: string): Promise<void> {
  const s = await sampleCanvasChange(page, selector, CHANGE_FRAME_BUDGET, CHANGE_MAX_MS);
  expect(
    s.captured,
    `${what}: canvas snapshot captured — '${selector}' matched no canvas to encode, so the ` +
      'change window below has nothing to compare and would report a frozen picture for a ' +
      'MISSING one.',
  ).toBe(true);
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
    // point. The earlier version accepted a corner-resize handle on the lane
    // surface as the answer to a PLACEHOLDER tile having removed the only
    // user-viewable video output (the owner regression). #1821 removes the
    // cause instead of the symptom: videoOut carries a real `face`, so the lane
    // tile is a ModuleShell painting a LIVE picture — and the freely resizable
    // screen moved to where the owner asked for it, right-click → DETACH
    // DISPLAY, rather than being an arbitrary resize on the tile itself.
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

    // 1) A REAL FACE TILE.
    await expect(videoOutLane(page)).toBeVisible({ timeout: 15_000 });
    const laneNode = page.locator(`.svelte-flow__node[data-id="${VIDEO_OUT}"]`);
    // …carrying a LIVE surface. #1785 evicts a video face's thumbnail when its
    // ranked cells outgrow a plate row; videoOut ranks NOTHING, so the strip
    // survives at every tier (pinned purely in `videoout-face-model.test.ts`).
    await expect(videoOutLane(page).locator('canvas')).toHaveCount(1);
    // ⚠ A `video-out-resize-handle` ABSENCE GATE STOOD HERE AND IS DELETED. No
    // file in the tree emits that testid any more, so `toHaveCount(0)` was
    // satisfied by a page that rendered nothing at all — it could not fail, and
    // an assertion that cannot fail is worse than none. The affordance it was
    // about (the owner's "no arbitrary resize on the tile") is now stated by
    // the DETACH DISPLAY case below, which asserts the resizable screen exists
    // somewhere positive rather than that a name is absent.

    // 2) PACKED zone: recorderbox clears videoOut by exactly one gutter. The
    //    packing derives from each occupant's real width.
    // READINESS WAIT for the packing measurement below, which derives from the
    // occupant's WIDTH.
    await expect(page.locator(laneTileSelector(RECORDERBOX))).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => {
        const vo = await nodeRect(page, VIDEO_OUT);
        const rb = await nodeRect(page, RECORDERBOX);
        if (!vo || !rb || vo.w === 0) return NaN;
        return rb.x - (vo.x + vo.w);
      }, { message: `recorderbox sits one ${VIDEO_ZONE_GAP}px gutter right of the videoOut tile`, timeout: 10_000 })
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
    // The wirability half is a property OF A RESOLVED PICK: a subject with no
    // video input port would fail at injectPatch with an edge to a port that
    // does not exist. It stays gated on `kind === 'ok'` so a pool with no pick
    // reds once, in `fixtureProblems` above, rather than twice.
    if (VIDEO_SINK_FIXTURE.kind === 'ok') {
      expect(
        SINK_IN_PORT,
        `the derived sink '${SINK_TYPE}' exposes a video input port`,
      ).not.toBeNull();
    }
  });

  test('video-domain tiles show LIVE ANIMATED thumbnails via the real chain; the fake wave glyph is GONE for them', async ({ page }) => {
    // ⚠ DERIVED, and the stale comment it replaces is why. It read "the
    // frames-drawn + pixel-change polls (20s budgets each) don't fit a flat 30s"
    // — but #1993 raised those ceilings to 60 s under SLOW_RENDER and this
    // literal stayed at 90 000, so the envelope stopped containing the two
    // budgets it spends (60 + 60 = 120). This case spends ONE
    // `sampleDrawAdvance` and ONE `expectCanvasChanges`.
    test.setTimeout(videoCaseTimeout(1, 1));
    // A pool with no pick reds once, in the health test above; skipping here
    // keeps the failure in one place instead of two.
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

    // ⚠ THE SUBJECT MUST ACTUALLY HAVE MOUNTED A TILE, ASSERTED ON THE PAGE.
    // The fixture derives the type from the committed golden; this is the leg
    // that checks the golden and the running app still agree about it, so a
    // subject that silently failed to render cannot make the thumb assertions
    // below vacuous.
    await expect(
      page.locator(`.svelte-flow__node[data-id="g1"] [data-testid="module-shell"]`),
      `the derived subject '${SINK_TYPE}' must render a lane tile — without one there is no ` +
        'glyph slot for the live thumb, and every assertion below would pass on an empty node',
    ).toHaveCount(1);

    // Each tile's glyph slot is the LIVE THUMB, and the fake dashed-wave SVG is
    // GONE for video modules.
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
    // assertions actually need (video domain, not a NON_SHELL_LANE_TYPES
    // snowflake, video in AND out), so a registry change moves the subject
    // automatically instead of reddening this line.
    //
    // ⚠ AND THE SECOND MEMBER USED TO BE THE LITERAL `RECORDERBOX`, WHICH THE
    // PARAGRAPH ABOVE ARGUES AGAINST IN ITS OWN LOOP (#2295). `recorderbox` is
    // un-promoted TODAY and is queued like everything else; the day it is faced
    // this leg would have read
    // "workflow-recorderbox renders a placeholder tile … Received: 0" — a hard
    // RED, on someone else's promotion, in the exact wording of a product
    // regression. There is no spare: it was the only literal here.
    //
    // So the WHOLE population is derived, from the rack the shell actually
    // rendered: every lane node currently painting a `module-shell-placeholder`
    // whose module is VIDEO-domain in the contract golden. That is strictly
    // more than the two names — it covers whatever the default rack seeds, not
    // a hand-picked pair — and a promotion removes a member automatically,
    // exactly as it already does for `g1`.
    //
    // ⚠ THE DOMAIN FILTER IS PART OF THE ASSERTION, NOT AN OPTIMISATION.
    // `synesthesia` is an AUDIO-domain placeholder on this very page and must
    // NOT carry a video thumb (asserted directly a few lines below); sweeping
    // every placeholder without asking the golden would demand one of it and
    // fail for a reason that is the OPPOSITE of the rule.
    const videoTileHosts = (
      await page.evaluate(() =>
        Array.from(
          document.querySelectorAll('.svelte-flow__node [data-testid="module-shell"]'),
        ).map((tile) => ({
          id: tile.closest('.svelte-flow__node')?.getAttribute('data-id') ?? '',
          type: tile.getAttribute('data-shell-type') ?? '',
        })),
      )
    ).filter((h) => h.id !== '' && contractDomain(h.type) === 'video');

    // ⚠ MINIMUM-POPULATION GUARD. A derived loop over an empty set passes
    // vacuously, and this one derives from the DOM — so it must contain the
    // subject this case spawned for exactly this purpose before any of it
    // means anything. (`g1` mounting a tile is asserted above; this asserts the
    // DERIVATION found it, which is a different claim.)
    expect(
      videoTileHosts.map((h) => h.id),
      `the derived video-tile population must include the spawned sink 'g1' (${SINK_TYPE}) — ` +
        'without it this loop proves nothing about the thumb host',
    ).toContain('g1');

    for (const { id, type } of videoTileHosts) {
      const tile = page.locator(`.svelte-flow__node[data-id="${id}"] [data-testid="module-shell"]`);
      await expect(tile, `${id} (${type}) renders a lane tile`).toHaveCount(1);
      await expect(tile.locator('[data-testid="video-tile-thumb"]'), `${id} (${type}) has the live thumb canvas`).toHaveCount(1);
      await expect(tile.locator('.tile-wave'), `${id} (${type}) fake wave glyph gone`).toHaveCount(0);
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
    // declaring the module's faders the tile painted 3 cells and 0 thumbs; with
    // those declarations REMOVED, 6 cells and still 0 thumbs. Face SIZE removed
    // the picture, not the fader kind.
    //
    // The fix inverts the precedence for the VIDEO DOMAIN only (`laneGlyphFor`
    // → 'picture'): the strip is reserved first and the cells take what is
    // left. backdraft's fader rows do not fit under it, so the plan falls back
    // to the ROW layout — the picture beside two cells, which is exactly what
    // its own `compact` tile has painted all along. The trade is one lane cell
    // (`mix`), and the dock renders every ranked control regardless.
    // ⚠ b1 IS NOW ALSO A MEMBER OF THE LOOP ABOVE, and this stays anyway: the
    // loop proves the population holds, this names the module the #1785 defect
    // was reported on, so a regression says "backdraft lost its thumbnail"
    // instead of "one of N tiles did".
    const b1Tile = page.locator('.svelte-flow__node[data-id="b1"] [data-testid="module-shell"]');
    await expect(b1Tile, 'b1 renders its lane tile').toHaveCount(1);
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
    await expectCanvasChanges(page, thumbSel, 'g1 tile thumbnail');
  });

  test('the RESTORED lane thumbnail is still GATED: off-screen costs nothing, on-screen is capped (#1785 / #1802)', async ({
    page,
  }) => {
    // ⚠ THIS IS THE BILL #1785 COULD HAVE RE-OPENED. #1802/#1836 gated the
    // per-module preview blits (measured: off-screen blits 5061 → 0, main-thread
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
    // ⚠ This is a "the video zone has mounted" gate on videoOut's FACE TILE.
    // The gate is incidental; the subject is `bcost` below.
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

    // LINES feeds BOTH modules under test so their pictures animate: → FEEDBACK
    // in, and → the seeded videoOut's in (its idle pattern is static).
    //
    // WHY FEEDBACK AND NOT BACKDRAFT (which this case used to expand): the
    // EXPAND half of this test needs a shell-lane video module that owns a LIVE
    // PREVIEW CANVAS, and BACKDRAFT no longer has one. Its in-lane display was
    // removed for good; it keeps a <canvas> only as the OUTPUT SURFACE for Full
    // Frame / Full Screen / Present, and that surface is 0×0 and unpainted
    // while the node sits in the rack — so a dock full-view of BACKDRAFT would
    // show controls, not a picture. FEEDBACK is the same shape (video-domain,
    // shell-lane so it gets a tile + EXPAND, one video in / one video out) and
    // DOES own a blitOutputToDrawingBuffer preview. The ORIGINAL regression
    // this case guards — a dock body whose bare useStore() threw outside the
    // SvelteFlow provider and mounted DEAD — is the videoOut half below
    // (videoOut is where it was found and still calls into the flow store);
    // the `providerErrors` sink covers both halves regardless.
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
    // BEHAVIOUR change, not a skin: the lane renders a real `module-shell` TILE
    // and the dock renders `<ModuleShell view="dock-full">`. Both locators
    // below moved for that reason and only that reason — the SUBJECT changed,
    // so the assertions follow it.
    //
    // ⚠ THIS IS STRICTLY STRONGER THAN WHAT IT REPLACED, which is why the leg was
    // re-pointed rather than re-homed on another module. The canvas it now polls
    // is `FeedbackOutputBody`'s — the module's own `fullViewBody` extension —
    // so the same three assertions (mounts / paints / ANIMATES) prove the
    // faced dock surface end-to-end, including that the extension's rAF loop
    // survives the dock mount.
    //
    // ⚠ AND THE REGRESSION THIS CASE EXISTS FOR IS UNAFFECTED. The original
    // defect was a dock body whose bare `useStore()` threw outside the
    // SvelteFlow provider and mounted DEAD; the videoOut leg below is the one
    // it was found on, and videoOut still calls into the flow store. The
    // `providerErrors` sink covers both halves.
    const b1Tile = page.locator(`.svelte-flow__node[data-id="b1"] [data-testid="module-shell"]`);
    await expect(b1Tile, 'the faced feedback shell tile').toBeVisible();
    await b1Tile.getByTestId('shell-open-dock').click();
    const faceplate = page.getByTestId('dock-full-view');
    await expect(faceplate).toBeVisible();
    const FEEDBACK_FACE_CANVAS = '[data-testid="dock-full-view"] [data-testid="feedback-face-canvas"]';
    const dockPreview = faceplate.locator('[data-testid="feedback-face-canvas"]');
    await expect(dockPreview, 'feedback video surface mounts in the dock').toBeVisible();
    await expectCanvasChanges(page, FEEDBACK_FACE_CANVAS, 'docked feedback');
    // Plain-mount contract holds: no xyflow handles/nodes inside the faceplate.
    await expect(faceplate.locator('.svelte-flow__handle')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(faceplate).toHaveCount(0);

    // (b) VIDEOOUT through its OWN EXPAND PILL — the user path, which it did
    // not have until #1821. ⚠ This leg used to go through the `__openDockFullView`
    // dev seam because videoOut had no lane tile to expand from. It has one now,
    // so the seam is no longer the only route and driving it would be testing a
    // hook instead of the product.
    await centerOnNode(page, VIDEO_OUT, 0.9);
    await videoOutLane(page).getByTestId('shell-open-dock').click();
    await expect(faceplate).toBeVisible();
    // ⚠ AND THE SURFACE IS THE FACEPLATE'S OWN: DockFullView's body is
    // <ModuleShell>, whose `fullViewBody` extension mounts videoOut's picture.
    const dockOutSel = '[data-testid="videoout-face-canvas"]';
    await expect(faceplate.locator(dockOutSel), 'videoOut video surface mounts in the dock').toBeVisible();
    // The full-view holds a HARD render lease on the video node (the lane copy
    // may be off-screen; pull-eval must not decay the dock's live picture).
    //
    // ⚠ READ ONCE, NOT POLLED. The lease is taken by Canvas's `$effect` over
    // `fullViewCards` — the SAME `$derived` whose `{#if}` mounts the faceplate —
    // so it is held in the flush that produced the canvas the line above just
    // waited for; there is no later moment for it to arrive. This used to be an
    // `expect.poll` on Playwright's flat 5 000 ms default, and on run
    // 34030547898 (shard 2) its FIRST sample — one `page.evaluate` round trip —
    // took 5.40 s on a main thread this case itself starves (LINES → FEEDBACK
    // and LINES → VIDEOOUT live under SwiftShader; the footer read `tick 782ms`
    // with 3 405 dropped buffers), so the poll expired with zero completed
    // samples and the lease unread. The #1993 class again: a Playwright-side
    // poll of a page-side value is a round trip per sample on the subject's own
    // main thread. A single read has no budget of its own to lose; the case
    // envelope (`videoCaseTimeout`) bounds it like every other read here, and
    // the assertion is exactly as strict — a missing lease still reds.
    expect(await leasedNodes(page), 'videoOut holds a render lease while its full-view is open')
      .toContain(VIDEO_OUT);
    await expectCanvasChanges(page, dockOutSel, 'docked videoOut (lines patched in)');
    await page.keyboard.press('Escape');
    await expect(faceplate).toHaveCount(0);
    // Lease released with the view — the effect's cleanup runs in the flush
    // that unmounted the faceplate (same derived, see above), so the count-0
    // wait above is this read's readiness signal too.
    expect(await leasedNodes(page), 'lease released when the full-view closes')
      .not.toContain(VIDEO_OUT);

    expect(providerErrors, `no useStore/provider throws: ${providerErrors.join(' | ')}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE CHAIN ITSELF (owner P0 follow-up: "no video AT ALL under ?shell=1 —
// camera → output and acidwarp → output render nothing").
//
// The earlier describe proves the SURFACES exist (videoOut's faceplate, live
// tile thumbs, the dock full-view). This one proves the ENGINE CHAIN behind
// them is identical to preview-off — the part that was still dead:
//
//   1. A pure-GPU chain (ACIDWARP → OUTPUT) is LIVE, and the engine's
//      materialized node set is EXACTLY the preview-off set for the same rack
//      (the parity invariant: which UI renders a module must not change what
//      the engine has).
//   2. A DOM-SOURCE module — one whose pixels come from a <video>/<img> handed
//      over with `attachExternalSource` — keeps that source attached from the
//      NODE, with no surface owning it. That attach is the whole reason camera
//      / videobox / archivist / … → OUTPUT was patched-but-black.
//   3. cameraInput's DEVICE PICKER is reachable on the faceplate. The
//      "lists real devices" half is
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
  test('ACIDWARP → OUTPUT is LIVE, and the engine materializes the whole chain', async ({ page }) => {
    // Software-renderer scale: a full rack boot with a live acidwarp→videoOut
    // chain and a pixel-change poll.
    //
    // ⚠ THE ENVELOPE IS ARITHMETIC, NOT A LITERAL: `buildAndProbe` spends a
    // `sampleDrawAdvance` AND an `expectCanvasChanges`, so its ceiling under
    // SLOW_RENDER is 60 000 + 60 000. A flat literal here was once HALF the
    // budget the case was allowed to spend, which made part of it unreachable.
    //
    // ⚠ COVERAGE THAT RETIRED WITH THE SECOND RENDERER, stated rather than
    // dropped: this used to build the SAME rack twice and assert the engine
    // node sets were equal — "which UI renders a module must not change what
    // the engine materialized". With one renderer that comparison has no
    // second side and cannot fail. What it was really protecting is that the
    // chain is GRAPH-driven rather than render-driven, and that is what the
    // per-node assertions below still say directly.
    test.setTimeout(videoCaseTimeout(1, 1));

    /** Build the rack and report what the engine has + whether the OUTPUT
     *  surface is actually painting moving pixels. */
    async function buildAndProbe(url: string): Promise<{ nodes: string[] }> {
      await page.goto(url);
      await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 15_000 });
      await expect(videoOutLane(page), `${url}: videoOut lane surface mounts`).toBeVisible({ timeout: 15_000 });

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
      await expectCanvasChanges(page, videoOutSurfaceSel(), `${url}: OUTPUT surface`);

      return { nodes: await engineNodeIds(page) };
    }

    const built = await buildAndProbe('/rack');
    expect(
      built.nodes,
      'the engine materialized both ends of the chain the graph describes',
    ).toEqual(expect.arrayContaining(['aw1', VIDEO_OUT]));
  });

  test('a video module with a DOM-backed source owns its renderer from the NODE, with no off-screen host anywhere', async ({ page }) => {
    test.setTimeout(SLOW_RENDER ? 90_000 : 30_000);
    await gotoShell(page);
    await expect(videoOutLane(page)).toBeVisible({ timeout: 15_000 });

    // ⚠ THE TITLE IS THE INVERSE OF THE ONE THIS TEST CARRIED FOR FIVE
    // RE-POINTINGS, and the rename is the honest end of that sequence rather
    // than a tidy-up. The old claim was "a module whose engine-visible source
    // lives off the lane keeps that source alive in an off-screen host"; it was
    // re-aimed at four different subjects as each one converted, and the fifth
    // conversion removed the MECHANISM: `<HeadlessSourceHost>` is deleted and
    // every renderer is mounted by `NodeVizSurfaceHost`, keyed on the NODE.
    // There is no module left that could satisfy the old title, so keeping it
    // while asserting the opposite is exactly the "kept the NAME, inverted the
    // CLAIM" trap the earlier prose warned about.
    //
    // The surviving claim is asserted per-module below: the lane shows a tile,
    // NO off-screen host exists, and the node's own surface host is what
    // mounts the renderer.
    //
    // ⚠ THE LESSON FROM THOSE RE-POINTINGS IS STILL LIVE and is why this is
    // written down: converting a module means re-running every spec that NAMES
    // it, found by grep, not by filename. One of the moves went RED ON CI
    // because the phase's local runs were scoped to the module's OWN specs.
    await injectPatch(page, [{ id: 'cube1', type: 'cube', position: { x: -1200, y: 5100 } }]);

    // The LANE shows the uniform tile — the rackline look is the point, and no
    // per-module surface is restored to it…
    await expect(
      page.locator(laneTileSelector('cube1')),
      'cube renders the uniform RACKLINE tile in its lane',
    ).toHaveCount(1);

    // …with the NODE-OWNED surface host where the headless mount used to be.
    // `card-producer-lifetime.spec.ts` owns the pixels; this leg owns the
    // ownership.
    await expect(
      page.locator('[data-testid="node-viz-surface"][data-node-id="cube1"]'),
      "cube's renderer is mounted by the NODE (NodeVizSurfaceHost), not by a separate host",
    ).toHaveCount(1);
    await expect(
      page.locator('[data-testid="headless-source-host"]'),
      'a headless source host exists — the component was deleted in S1.5, so ANY match means it came back',
    ).toHaveCount(0);

    // ── THE CONVERTED MODULE, asserted as its own claim ──────────────────────
    //
    // A node-owned source gets NO host, and that absence is the whole payoff of
    // #1511: the off-screen mount was a tax every rack paid. Asserted here, in
    // the test that owns the host's behaviour, so the two answers live side by
    // side and a future edit cannot give videobox a host back unnoticed.
    // Whether its SOURCE is actually live without one is
    // `node-source-videobox.spec.ts`'s job — this leg only owns the host.
    //
    // ⚠ TWO ABSENCE LEGS RAN HERE AND ARE DELETED — READ THIS BEFORE ADDING ONE
    // BACK. Each row used to carry a per-module selector and assert
    // `toHaveCount(0)` for it, plus `toHaveCount(0)` for an off-screen
    // `headless-source-host`. Both subjects are now DELETED SOURCE: no file in
    // the tree renders either, so both matchers were satisfied by a page that
    // rendered nothing at all. That is the precise vacuity this loop's own
    // prose warned about twice ("a selector that matches nothing would pass
    // vacuously, certifying exactly the state this loop refuses") — and once
    // the component is gone, the warning applies to the assertion itself.
    //
    // ⚠ NAMED COVERAGE LOSS. What those legs bought was "a conversion did not
    // leave a second, hidden mount behind". That question is now answered by
    // CONSTRUCTION rather than at runtime — there is no component to mount —
    // and re-arming it would mean a new source-level gate, which is an owner
    // decision, not this branch's.
    //
    // ONE tombstone is kept, above: the unscoped `headless-source-host` count.
    // It is the same kind of claim, deliberately stated ONCE as "if this ever
    // matches, the deleted component came back" rather than repeated per row,
    // where ten copies of an unfailable matcher would read as ten assertions.
    //
    // What SURVIVES here is the positive leg, and it is the one with content:
    // every one of these modules mounts a real RACKLINE lane tile. That is the
    // claim a regression can actually break.
    const converted = [
      ['vb1', 'videobox'],
      ['vv1', 'videovarispeed'],
      ['pt1', 'peertube'],
      ['tv1', 'tvLibrarian'],
      ['lb1', 'loopback'],
      ['arc1', 'archivist'],
      ['syn1', 'synesthesia'],
      ['tl1', 'timelorde'],
      ['ras1', 'rasterize'],
      ['cube2', 'cube'],
    ] as const;
    for (const [nodeId, type] of converted) {
      await injectPatch(page, [{ id: nodeId, type, position: { x: -1600, y: 5100 } }]);
      await expect(
        page.locator(laneTileSelector(nodeId)),
        `${type} mounted no RACKLINE lane tile`,
      ).toHaveCount(1);
    }

    // ⚠ A THIRD ABSENCE LEG STOOD HERE (cameraInput must not get an off-screen
    // host) AND IS DELETED FOR THE SAME REASON as the two above: nothing in the
    // tree mounts that host any more, so the matcher could not fail.
    //
    // WHAT IT GUARDED IS NOT WAIVED. The hazard was a SECOND OWNER of one
    // camera device — the lane surface and an off-screen mount both calling
    // getUserMedia. getUserMedia, the device roster, the rebind and the
    // permission machine live in `$lib/ui/media/node-camera-source-registry` on
    // graph lifetime, so there is exactly one owner of the stream and it is not
    // a surface at all. `camerainput-shell-source.spec.ts` asserts that owner
    // POSITIVELY, which is the shape this claim should have had from the start.
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
    //   1. The off-screen host mounted a SECOND copy of the module inside its
    //      OWN single-node `<SvelteFlow>`, passing `type`/`id` through — so
    //      `.svelte-flow__node[data-id="cam1"]` matched TWO elements, the lane
    //      tile AND the hosted copy. `laneNode.locator(...)` resolved through
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
    // placeholder) rather than the one it was written for.
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

    // ⚠ LEG (a) IS DELETED: a document-wide `camera-device-select`
    // `toHaveCount(0)`. That testid is emitted by NOTHING in the tree, so the
    // matcher was satisfied by a page that rendered nothing at all and could
    // not fail. It was a real claim when the off-screen mount existed — a bare
    // count on the LANE could not tell an off-screen copy from no copy, so the
    // leg was scoped to the host — but the host and the surface are both gone
    // and `$lib/ui/media/node-camera-source-registry` owns the stream, the
    // roster and the permission machine on graph lifetime.
    //
    // The blindness it guarded is defended in the leg below, which is where it
    // has to live now: the FACEPLATE picker is asserted OPERABLE — scrolled to,
    // on-canvas, hit-testable — rather than some other control being absent.

    // THE FACEPLATE CARRIES ONE, and it is genuinely operable. `[data-testid=
    // "module-shell"]` exists only on the lane tile, so this locator cannot
    // resolve through an off-screen copy the way the old one did.
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
    // blindness. It used to compare against the HOSTED copy of this very picker:
    // pointing `picker` at
    // `[data-testid="headless-source-host"][data-node-id="cam1"] [data-testid="camera-device-select"]`
    // failed at the scroll leg with `viewport ratio 0`, where the OLD predicate
    // (`toBeVisible`) passed on that same element.
    //
    // ⚠ THAT SUBJECT NO LONGER EXISTS (legacy-removal S1) — nothing mounts a
    // second copy of the camera, so there is no off-screen one to compare. The
    // control is therefore re-anchored on the INSTRUMENT rather than deleted
    // with its population: a SYNTHETIC element parked exactly where the host
    // used to park one, which the predicate must still refuse. A control over a
    // population that reaches zero stops controlling anything; a control over
    // the matcher does not.
    const syntheticOffCanvas = await page.evaluateHandle(() => {
      const el = document.createElement('div');
      el.setAttribute('data-testid', 'offscreen-probe');
      el.style.cssText =
        'position:fixed;left:-9999px;top:0;width:120px;height:24px;pointer-events:none;';
      document.body.appendChild(el);
      return el;
    });
    const probeBox = await page
      .locator('[data-testid="offscreen-probe"]')
      .boundingBox();
    expect(probeBox, 'the synthetic off-canvas probe exists to compare against').not.toBeNull();
    expect(
      probeBox!.x,
      `an element parked where the headless host used to park one must read OFF-canvas — if ` +
        `this ever goes >= 0 the position predicate the checks above rely on has stopped ` +
        `discriminating; saw x=${Math.round(probeBox!.x)}`,
    ).toBeLessThan(0);
    const probeReachable = await page
      .locator('[data-testid="offscreen-probe"]')
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
      });
    expect(
      probeReachable,
      'the hit-test predicate accepted an off-canvas element — it is exactly the blindness the ' +
        'reachability leg above exists to avoid',
    ).toBe(false);
    await syntheticOffCanvas.dispose();
    await page.evaluate(() => {
      document.querySelector('[data-testid="offscreen-probe"]')?.remove();
    });

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
