// e2e/tests/backdraft-clocked-delay.spec.ts
//
// A PATCHED DELAY CLOCK MAKES THE DELAY FADER INERT — owner ruling, verbatim:
// *"how does the delay fader interact with a clocked delay? i think if delay
// clock is patched this is a case where we should ignore the fader entirely."*
//
// The chain is REAL end to end: an audio LFO's phase output — a CV cable, the
// patch a user actually makes — crosses the cross-domain bridge into
// backdraft's delay_clock, the module measures the pulse period on the
// bridge's own write clock, and the faceplate's delay fader dims + badges
// through the SAME shared predicate the legacy card's CLK badge uses
// (backdraft-clocked-delay.ts). The engine-side observable is
// read('effectiveDelayMs') — the delay draw() actually used — because the
// picture cannot show which ring slot it tapped.
//
// ⚠ THE RENDERER IS STOPPED FOR THIS WHOLE FILE (installRenderSmokeHooks), and
// that is the POSITIVE CONTROL, not a speed-up. backdraft.ts promises the
// delay_clock edge is detected "as the value arrives from the patch bridge
// rather than sampled once per rendered frame, so … the lock does not depend
// on how fast the renderer is running". Until the 2026-09-09 widen of
// PatchEngine.installGateDispatch that was true only for a `gate` cable: a
// `cv` cable fell to the per-frame analyser sampler (VideoEngine.
// tickCvBridges), so with the rAF loop idle NO edge could arrive at all, and
// with it running at SwiftShader's ~8 fps a 4 Hz swing sat on the 2:1 Nyquist
// singularity (measured periods 253 ms one moment, 4430 ms the next; at a
// steady 8.00 fps it never locked). Now the edges are counted on the audio
// thread and replayed on the ~25 ms scheduler tick — a Worker, immune to rAF —
// so this spec waits for edges WITH THE LOOP PAUSED and asserts the period
// POSITIVELY: 250 ms ± one bridge tick. On the pre-widen engine this file
// fails at the first lock wait, deterministically (zero edges without a
// frame), which is what tells "the product is right" apart from "the beat
// phase was lucky".
//
// Frames are then only the OBSERVABLE: `heldEffectiveMs` and `clockPatched`
// are written inside draw(), so each leg drives `vid.step()` itself (the #2345
// pattern) instead of paying the live compositor for every Playwright round
// trip — the cost half of the 2026-09 red runs (a 50 s click, a 14 s
// waitFrames, 103 s against a 120 s cap on the attempt that "passed").
//
// The hold/lock/re-patch state machine is pinned at unit level
// (backdraft-delay-ring.test.ts); the dispatch's per-sample counting and its
// one-tick period accuracy at engine-gate-dispatch.test.ts. This spec proves
// the live wiring: badge on patch, the draw uses the clock's period, fader
// writes ignored while patched, control returned on unpatch.

import { test, expect, type Page } from '@playwright/test';
import { waitFrames } from '../_helpers/frames';
import { installRenderSmokeHooks } from './_render-smoke';
import { SCHEDULER_TICK_MS } from '../../packages/web/src/lib/audio/scheduler-clock';

const NODE = 'bd';
const LFO = 'clk-lfo';
/** 4 Hz LFO → one rising edge per 250 ms cycle. */
const LFO_RATE_HZ = 4;
const CLOCK_PERIOD_MS = 1000 / LFO_RATE_HZ;
/** The fader's position before the clock lands, and where it is parked while
 *  clocked. Neither can be reached by a 4 Hz clock read to one tick. */
const FADER_MS = 120;
const PARKED_MS = 900;
/** BACKDRAFT_MAX_DELAY_MS — the cap the module applies to a measured period. */
const MAX_DELAY_MS = 1000;
/** BACKDRAFT_CLOCK_PATCH_GRACE_MS = 20 × SCHEDULER_TICK_MS (backdraft.ts): how
 *  stale the bridge's last write may be before the input reads UNPATCHED. */
const CLOCK_PATCH_GRACE_MS = 20 * SCHEDULER_TICK_MS;
/**
 * How many consecutive periods the lock is measured over, and why the MEAN of
 * them is the right observable. The module stamps each rise when the bridge
 * REPLAYS it — the first ~25 ms tick after the true edge, plus whatever that
 * tick was late by — so a single period carries the difference of two replay
 * delays: with a 250 ms clock on a 25 ms grid every rise sits at the same
 * phase and can land a tick early or late, and consecutive periods honestly
 * read 225 / 275 (measured). Those delays TELESCOPE: N consecutive periods sum
 * to `t_last − t_first`, so their mean is the clock's period to within
 * `(one tick + tick lateness) / N`, whatever the per-rise jitter — while a
 * manufactured or dropped edge inside the window (the defect class this file
 * exists for) shifts it by a whole period / N. With N = 8 that is ≤ ~16 ms of
 * jitter against a ≥ 31 ms defect signature, both against the one-tick
 * tolerance backdraft.ts states for delay_clock.
 */
const LOCK_PERIODS = 8;
/**
 * The window is only measured while the main thread was RESPONSIVE: right
 * after a cable lands the flow and the face re-render (measured under
 * SwiftShader: ~0.6 s with no tick delivered, then the backlog replayed at
 * queue-drain pace), and a replay delay that large is not "jitter". The
 * in-page sampler measures its own interval, and a window is admitted only if
 * no interval inside it exceeded this many ticks — an instrument condition the
 * instrument checks, not a product tolerance. It also bounds the tick
 * lateness in the derivation above.
 */
const QUIET_GAP_TICKS = 4;
/** Bound on the lock wait, in LFO CYCLES (the thing that drives its cost),
 *  never a flat ms. 40 cycles of a 4 Hz clock is 10 s. */
const LOCK_MAX_CYCLES = 40;

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;
const CASE_MS = SLOW_RENDER ? 120_000 : 45_000;

/** ADD to the live patch (never spawnPatch — it clears the seeded video zone);
 *  per-node domain because this spec needs an AUDIO clock source. Same shape
 *  as backdraft-panic.spec.ts / workflow-shell-video.spec.ts. */
async function injectPatch(
  page: Page,
  nodes: { id: string; type: string; domain: string; position: { x: number; y: number }; params?: Record<string, number> }[],
  edges: {
    id: string;
    from: { nodeId: string; portId: string };
    to: { nodeId: string; portId: string };
    sourceType: string;
    targetType: string;
  }[] = [],
): Promise<void> {
  await page.waitForFunction(() => {
    const w = globalThis as unknown as { __ensureEngine?: () => Promise<unknown> };
    return typeof w.__ensureEngine === 'function';
  });
  await page.evaluate(async () => {
    const w = globalThis as unknown as { __ensureEngine: () => Promise<unknown> };
    await w.__ensureEngine();
  });
  await page.evaluate(
    ({ nodes, edges }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, unknown>; edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        for (const n of nodes) {
          w.__patch.nodes[n.id] = {
            id: n.id, type: n.type, domain: n.domain, position: n.position, params: n.params ?? {},
          };
        }
        for (const e of edges) {
          w.__patch.edges[e.id] = {
            id: e.id, source: e.from, target: e.to,
            sourceType: e.sourceType, targetType: e.targetType,
          };
        }
      });
    },
    { nodes, edges },
  );
  await page.waitForFunction(
    (ids) => ids.every((id) => document.querySelector(`.svelte-flow__node[data-id="${id}"]`) !== null),
    nodes.map((n) => n.id),
    { timeout: 15_000 },
  );
}

async function gotoShell(page: Page): Promise<void> {
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });
}

async function centerOnNode(page: Page, nodeId: string, zoom = 0.9): Promise<void> {
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
      const cx = x + (n.measured?.width ?? 192) / 2;
      const cy = y + (n.measured?.height ?? 180) / 2;
      const pane = document.querySelector('.svelte-flow') as HTMLElement;
      const r = pane.getBoundingClientRect();
      w.__flow.setViewport({ x: r.width / 2 - cx * zoom, y: r.height / 4 - cy * zoom, zoom }, { duration: 0 });
    },
    { nodeId, zoom },
  );
  await waitFrames(page, 4);
}

async function openFace(page: Page) {
  await centerOnNode(page, NODE);
  const shell = page.locator(`.svelte-flow__node[data-id="${NODE}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const fv = page.getByTestId('dock-full-view');
  await expect(fv).toBeVisible();
  return fv;
}

function writeDelayParam(page: Page, ms: number): Promise<void> {
  return page.evaluate(
    ({ id, ms }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> } | undefined> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => { w.__patch.nodes[id]!.params.delay = ms; });
    },
    { id: NODE, ms },
  );
}

/** The video-domain seams this spec drives, as the page exposes them. */
interface VideoSeam {
  step: () => void;
  read: (id: string, key: string) => unknown;
  readParam: (id: string, paramId: string) => number | undefined;
  framesDrawnFor: (id: string) => number;
}

/** Drive ONE explicit draw and read the delay it used. `drawsDelta` is the
 *  instrument check: `effectiveDelayMs` is only written inside draw(), so a
 *  step that did not draw this node would return a stale value that reads
 *  exactly like a correct one. */
function drawOnce(page: Page): Promise<{ effectiveMs: number; drawsDelta: number }> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as { __engine: () => { getDomain: (d: string) => VideoSeam } };
    const vid = w.__engine().getDomain('video');
    const before = vid.framesDrawnFor(id);
    vid.step();
    return {
      effectiveMs: vid.read(id, 'effectiveDelayMs') as number,
      drawsDelta: vid.framesDrawnFor(id) - before,
    };
  }, NODE);
}

interface LockSample {
  /** Rising edges the module counted while this wait ran — with the renderer
   *  STOPPED, so every one of them arrived off the frame clock. */
  risesSeen: number;
  /** Every period the module measured while this wait ran, ms, in order. */
  periodsMs: number[];
  /** The last `LOCK_PERIODS` of them, once a window passed the quiet check;
   *  empty if none did inside the bound. */
  windowMs: number[];
  /** The longest interval the in-page sampler itself observed inside that
   *  window (ms) — how late the main thread ran while it was measured. */
  windowMaxGapMs: number;
  /** The longest sampler interval over the whole wait — a stall reads as a
   *  stall, never as "the clock never fired". */
  maxGapMs: number;
  settled: boolean;
  /** The module's period at the instant of the ONE draw below, ms. */
  periodAtDrawMs: number;
  /** What that draw actually used, ms. */
  effectiveMs: number;
  driving: boolean;
  drawsDelta: number;
  samples: number;
  elapsedMs: number;
}

/**
 * Wait IN THE PAGE until the DELAY CLOCK has been measured over `periods`
 * consecutive rises during which the main thread stayed responsive (no
 * sampler interval over `quietGapMs`), then drive ONE draw synchronously and
 * read what it used.
 *
 * ONE evaluate: the accumulator lives in the page (never a Playwright poll
 * loop — one round trip per sample on the same main thread as the subject).
 * The rAF loop is paused for this file, so once the post-patch re-render has
 * drained the main thread is QUIET and the bridge's 25 ms ticks land on time;
 * the draw is the LAST thing before the read and nothing can interleave, so
 * `effectiveMs` is exactly the function of `periodAtDrawMs` the module
 * computes. Bounded in LFO cycles.
 */
function lockOnClock(
  page: Page,
  opts: { periods: number; quietGapMs: number; maxCycles: number },
): Promise<LockSample> {
  return page.evaluate(
    async ({ id, periods, quietGapMs, maxCycles, periodMs, tickMs }) => {
      const w = globalThis as unknown as { __engine: () => { getDomain: (d: string) => VideoSeam } };
      const vid = w.__engine().getDomain('video');
      const t0 = performance.now();
      const budgetMs = maxCycles * periodMs;
      const rise0 = vid.read(id, 'clockRiseCount') as number;
      let seen = rise0;
      let samples = 0;
      let maxGapMs = 0;
      /** Max sampler interval seen since the previous rise was detected. */
      let gapSinceRise = 0;
      const periodsMs: number[] = [];
      /**
       * EVERY rise detected in this loop, in order: the period the module
       * measured at it (null for the first ever rise, and for all but the last
       * of a burst), and the longest sampler interval since the previous
       * detected rise — i.e. how late the main thread may have replayed it.
       * A burst (two or more rises in one sample) is a backlog being drained
       * and is never quiet, whatever the sampler saw.
       */
      const log: Array<{ periodMs: number | null; gap: number }> = [];
      let windowMs: number[] = [];
      let windowMaxGapMs = 0;
      let settled = false;
      let last = performance.now();
      while (!settled && performance.now() - t0 < budgetMs) {
        await new Promise((r) => setTimeout(r, tickMs));
        samples++;
        const now = performance.now();
        const gap = now - last;
        last = now;
        if (gap > maxGapMs) maxGapMs = gap;
        if (gap > gapSinceRise) gapSinceRise = gap;
        const n = vid.read(id, 'clockRiseCount') as number;
        if (n <= seen) continue;
        const d = n - seen;
        seen = n;
        const p = vid.read(id, 'clockPeriodSec') as number;
        for (let i = 0; i < d; i++) {
          const periodMs = i === d - 1 && p > 0 ? p * 1000 : null;
          if (periodMs !== null) periodsMs.push(periodMs);
          log.push({ periodMs, gap: d > 1 ? Infinity : gapSinceRise });
        }
        gapSinceRise = 0;
        // A window is `periods` consecutive periods bounded by `periods + 1`
        // rises ALL detected in this loop — so the opening rise's lateness is
        // measured too, not inherited from whatever happened before the loop.
        if (log.length < periods + 1) continue;
        const win = log.slice(-(periods + 1));
        const body = win.slice(1);
        const tailGap = Math.max(...win.map((r) => r.gap));
        if (tailGap <= quietGapMs && body.every((r) => r.periodMs !== null)) {
          windowMs = body.map((r) => r.periodMs as number);
          windowMaxGapMs = tailGap;
          settled = true;
        }
      }
      // Synchronous from here: no scheduler tick can land between this read
      // and the draw that consumes it.
      const periodAtDrawMs = (vid.read(id, 'clockPeriodSec') as number) * 1000;
      const before = vid.framesDrawnFor(id);
      vid.step();
      return {
        risesSeen: seen - rise0,
        periodsMs,
        windowMs,
        windowMaxGapMs,
        maxGapMs,
        settled,
        periodAtDrawMs,
        effectiveMs: vid.read(id, 'effectiveDelayMs') as number,
        driving: vid.read(id, 'clockDriving') === true,
        drawsDelta: vid.framesDrawnFor(id) - before,
        samples,
        elapsedMs: performance.now() - t0,
      };
    },
    {
      id: NODE,
      periods: opts.periods,
      quietGapMs: opts.quietGapMs,
      maxCycles: opts.maxCycles,
      periodMs: CLOCK_PERIOD_MS,
      tickMs: SCHEDULER_TICK_MS,
    },
  );
}

/**
 * After the cable is gone: drive draws IN THE PAGE until the module hands the
 * delay back to the fader. `backdraftClockPatched` is
 * `(now - lastWrite <= GRACE_MS) || (frame - lastWriteFrame <= 3)`, so the
 * return needs both the wall-clock grace to elapse AND a few draws — this
 * steps on the bridge's own cadence and stops the moment the observable flips.
 * Bounded by a multiple of the product's grace window, never a flat ms.
 */
function returnToFader(page: Page, opts: { expectMs: number }): Promise<{
  value: number; driving: boolean; steps: number; elapsedMs: number;
}> {
  return page.evaluate(
    async ({ id, expectMs, budgetMs, tickMs }) => {
      const w = globalThis as unknown as { __engine: () => { getDomain: (d: string) => VideoSeam } };
      const vid = w.__engine().getDomain('video');
      const t0 = performance.now();
      let steps = 0;
      let value = NaN;
      for (;;) {
        vid.step();
        steps++;
        value = vid.read(id, 'effectiveDelayMs') as number;
        if (value === expectMs || performance.now() - t0 >= budgetMs) break;
        await new Promise((r) => setTimeout(r, tickMs));
      }
      return {
        value,
        driving: vid.read(id, 'clockDriving') === true,
        steps,
        elapsedMs: performance.now() - t0,
      };
    },
    { id: NODE, expectMs: opts.expectMs, budgetMs: 4 * CLOCK_PATCH_GRACE_MS, tickMs: SCHEDULER_TICK_MS },
  );
}

const fmt = (xs: number[]): string => xs.map((x) => x.toFixed(1)).join(', ');
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** The positive control: over a responsive window, the clock measures as the
 *  clock — its mean period within one bridge tick of the LFO's, the precision
 *  backdraft.ts states for delay_clock (see LOCK_PERIODS for why the mean is
 *  exact where a single period is not). One line of evidence is printed
 *  either way, so a CI report carries the measurement and not just the
 *  verdict. */
function expectLockedOnClock(lock: LockSample, what: string): void {
  console.log(
    `[backdraft-clocked-delay] ${what}: settled=${lock.settled} window=[${fmt(lock.windowMs)}] ms ` +
      `mean=${lock.windowMs.length ? mean(lock.windowMs).toFixed(1) : 'n/a'} ` +
      `windowMaxGap=${lock.windowMaxGapMs.toFixed(0)} ms all=[${fmt(lock.periodsMs)}] ms ` +
      `rises=${lock.risesSeen} maxGap=${lock.maxGapMs.toFixed(0)} ms in ${lock.elapsedMs.toFixed(0)} ms`,
  );
  expect(
    lock.settled,
    `${what}: the clock is measured over ${LOCK_PERIODS} rises on a responsive main thread, with the ` +
      `renderer STOPPED — ${lock.risesSeen} rises, ${lock.periodsMs.length} periods in ` +
      `${lock.elapsedMs.toFixed(0)} ms over ${lock.samples} in-page samples, longest sampler gap ` +
      `${lock.maxGapMs.toFixed(0)} ms (periods: ${fmt(lock.periodsMs)} ms; the pre-widen per-frame ` +
      `bridge delivers no edge at all without a frame)`,
  ).toBe(true);
  expect(
    Math.abs(mean(lock.windowMs) - CLOCK_PERIOD_MS),
    `${what}: the measured period is the ${LFO_RATE_HZ} Hz clock's ${CLOCK_PERIOD_MS} ms to within ONE ` +
      `${SCHEDULER_TICK_MS} ms bridge tick — mean of ${LOCK_PERIODS} consecutive periods ` +
      `${mean(lock.windowMs).toFixed(1)} ms (window: ${fmt(lock.windowMs)} ms, longest main-thread gap ` +
      `inside it ${lock.windowMaxGapMs.toFixed(0)} ms; a manufactured or dropped edge would move this by ` +
      `${(CLOCK_PERIOD_MS / LOCK_PERIODS).toFixed(0)} ms)`,
  ).toBeLessThanOrEqual(SCHEDULER_TICK_MS);
  // Each single period, derived rather than tolerated: on an admitted window
  // no replay was later than one tick plus the longest gap the sampler saw, so
  // no period can sit further than that from the clock's. A manufactured edge
  // (a ~25 ms period) or a dropped one (~500 ms) cannot hide inside the band
  // the way it could inside a mean.
  const band = SCHEDULER_TICK_MS + QUIET_GAP_TICKS * SCHEDULER_TICK_MS;
  for (const p of lock.windowMs) {
    expect(
      Math.abs(p - CLOCK_PERIOD_MS),
      `${what}: every period in the window is one real clock pulse — within one tick plus the ` +
        `${QUIET_GAP_TICKS}-tick quiet bound (±${band} ms) of ${CLOCK_PERIOD_MS} ms (window: ` +
        `${fmt(lock.windowMs)} ms); a shorter one is a manufactured edge, a longer one a dropped edge`,
    ).toBeLessThanOrEqual(band);
  }
  expect(lock.drawsDelta, `${what}: the one explicit draw really ran`).toBe(1);
  expect(lock.driving, `${what}: the module reports the clock is driving the delay`).toBe(true);
}

test.describe('backdraft — clocked delay makes the fader inert', () => {
  test('badge on patch, fader ignored while patched, control returned on unpatch', async ({ page }) => {
    test.setTimeout(CASE_MS);
    // Pause the engine's rAF loop BEFORE boot (see the header): every draw in
    // this test is one this test asked for, and the lock wait below runs with
    // no frame at all.
    await installRenderSmokeHooks(page);
    await gotoShell(page);
    await injectPatch(
      page,
      [
        { id: LFO, type: 'lfo', domain: 'audio', position: { x: -1200, y: 4500 }, params: { rate: LFO_RATE_HZ } },
        { id: NODE, type: 'backdraft', domain: 'video', position: { x: -700, y: 4500 }, params: { delay: FADER_MS } },
      ],
    );

    const fv = await openFace(page);
    await fv.getByTestId('faceplate-tab-loop').click();
    const delayCell = fv.locator('[data-cell-key="delay"]');
    await expect(delayCell).toBeVisible();
    await expect(
      fv.getByTestId('face-override-badge-delay'),
      'no badge while nothing is patched',
    ).toHaveCount(0);

    // BASELINE: with nothing patched the draw uses the fader. Also the
    // instrument check that an explicit step really draws this node.
    const unclocked = await drawOnce(page);
    expect(unclocked.drawsDelta, 'an explicit step draws the node (the observable is written in draw())').toBe(1);
    expect(unclocked.effectiveMs, 'unpatched, the draw uses the fader (ms)').toBe(FADER_MS);

    // Patch the clock — the badge and the dim must follow the CABLE, and the
    // engine must start ignoring the fader.
    await page.evaluate(
      ({ lfo, bd }) => {
        const w = globalThis as unknown as {
          __patch: { edges: Record<string, unknown> };
          __ydoc: { transact: (fn: () => void) => void };
        };
        w.__ydoc.transact(() => {
          w.__patch.edges['e-clk'] = {
            id: 'e-clk',
            source: { nodeId: lfo, portId: 'phase0' },
            target: { nodeId: bd, portId: 'delay_clock' },
            sourceType: 'cv',
            targetType: 'cv',
          };
        });
      },
      { lfo: LFO, bd: NODE },
    );

    await expect(
      fv.getByTestId('face-override-badge-delay'),
      'the CLK badge appears on the face the moment the cable lands',
    ).toBeVisible();
    await expect(delayCell, 'the cell dims (overridden class)').toHaveClass(/ms-cell-overridden/);

    // THE LOCK — and the POSITIVE CONTROL. The renderer is stopped, so every
    // edge counted here arrived through the audio-thread counter and the
    // scheduler tick, exactly as the module's docs promise; the per-frame
    // sampler this cable used to fall to delivers NOTHING without a frame.
    const lock = await lockOnClock(page, {
      periods: LOCK_PERIODS,
      quietGapMs: QUIET_GAP_TICKS * SCHEDULER_TICK_MS,
      maxCycles: LOCK_MAX_CYCLES,
    });
    expectLockedOnClock(lock, 'on patch');
    expect(
      lock.effectiveMs,
      `the draw used the clock's period, not the fader's ${FADER_MS} ms ` +
        `(period at draw: ${lock.periodAtDrawMs.toFixed(1)} ms)`,
    ).toBeCloseTo(Math.min(MAX_DELAY_MS, lock.periodAtDrawMs), 6);

    // FADER INERT: a delay write moves the PARAM, not the effective delay.
    await writeDelayParam(page, PARKED_MS);
    await page.waitForFunction(
      ({ id, ms }) => {
        const w = globalThis as unknown as { __engine: () => { getDomain: (d: string) => VideoSeam } };
        return w.__engine().getDomain('video').readParam(id, 'delay') === ms;
      },
      { id: NODE, ms: PARKED_MS },
    );
    const clocked = await lockOnClock(page, {
      periods: LOCK_PERIODS,
      quietGapMs: QUIET_GAP_TICKS * SCHEDULER_TICK_MS,
      maxCycles: LOCK_MAX_CYCLES,
    });
    expectLockedOnClock(clocked, 'across the fader write');
    expect(
      clocked.effectiveMs,
      `fader write ignored while clocked: the param reads ${PARKED_MS} ms, the draw used the ` +
        `clock's ${clocked.periodAtDrawMs.toFixed(1)} ms`,
    ).toBeCloseTo(Math.min(MAX_DELAY_MS, clocked.periodAtDrawMs), 6);

    // UNPATCH: control returns to the fader AT ITS CURRENT POSITION (900ms —
    // the value parked while clocked), and the badge goes away.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { edges: Record<string, unknown> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => { delete w.__patch.edges['e-clk']; });
    });
    await expect(
      fv.getByTestId('face-override-badge-delay'),
      'the badge follows the cable out',
    ).toHaveCount(0);
    const back = await returnToFader(page, { expectMs: PARKED_MS });
    expect(
      back.value,
      `the fader rules again at its parked ${PARKED_MS} ms — took ${back.steps} draws / ` +
        `${back.elapsedMs.toFixed(0)} ms against a ${CLOCK_PATCH_GRACE_MS} ms grace window`,
    ).toBe(PARKED_MS);
    expect(back.driving, 'the module reports the clock is no longer driving').toBe(false);
  });
});
