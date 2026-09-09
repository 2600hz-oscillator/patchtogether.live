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
// thread — by a worklet the AudioEngine pre-registers, connected the instant
// the cable lands — and replayed on the ~25 ms scheduler tick, a Worker,
// immune to rAF. So this spec waits for edges WITH THE LOOP PAUSED and asserts
// POSITIVELY that the clock arrives at the LFO's rate: rises over a window of
// the AUDIO clock against 4 Hz. On the pre-widen engine this file fails at the
// first lock, deterministically (zero rises without a frame), which is what
// tells "the product is right" apart from "the beat phase was lucky".
//
// WHAT THIS INSTRUMENT CAN SEE, AND WHAT IT DERIVES. The module stamps a rise
// when the bridge REPLAYS it, on the MAIN thread. On a shared CI runner that
// thread is starved by the other workers' SwiftShader pages — measured on run
// 34372134124 (job 102537234761): an in-page setTimeout(25) resolving every
// ~250 ms for the WHOLE wait, longest gap 530 ms — and pausing THIS page's
// render loop cannot buy it a quiet thread (the earlier version of this file
// required one, and was red on CI for that reason alone while the rise count
// in its own log showed the edges arriving at 4 Hz). So no assertion below
// presumes a quiet thread. Every bound is DERIVED from what the sampler itself
// measured — its longest interval is the longest the main thread was away, and
// a replay can be late by at most that plus a tick — so on a quiet machine the
// bounds are tight enough to see ONE manufactured or dropped edge, and on a
// starved one they widen to exactly what the instrument can vouch for instead
// of failing for the runner. The one-tick period precision backdraft.ts
// promises is pinned where tick delivery is deterministic:
// engine-gate-dispatch.test.ts (THE PROMISE cases), which also pins the count
// across a post-patch stall and the analyser→worklet handoff race.
//
// Frames are then only the OBSERVABLE: `heldEffectiveMs` and `clockPatched`
// are written inside draw(), so each leg drives `vid.step()` itself (the #2345
// pattern) instead of paying the live compositor for every Playwright round
// trip — the cost half of the 2026-09 red runs (a 50 s click, a 14 s
// waitFrames, 103 s against a 120 s cap on the attempt that "passed").
//
// The hold/lock/re-patch state machine is pinned at unit level
// (backdraft-delay-ring.test.ts). This spec proves the live wiring: badge on
// patch, the draw uses the clock's period, fader writes ignored while patched,
// control returned on unpatch.

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
 * How long each lock is measured, in LFO CYCLES of the AUDIO clock (the thing
 * that drives its cost, never a flat ms). The rate assertion compares the rises
 * the module counted across this window with LFO_RATE_HZ × the audio time it
 * spanned; its tolerance is derived per run (see `countToleranceFor`) and the
 * window has to be long enough that the tolerance a starved runner earns
 * stays well under the count — at 16 cycles a 0.55 s stall (the worst CI has
 * shown) earns ±5.4 against 16 due, and the check keeps its power up to a
 * ~1.8 s stall.
 */
const LOCK_CYCLES = 16;

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;
const CASE_MS = SLOW_RENDER ? 120_000 : 45_000;
/** Local reproduction of a starved CI main thread: `E2E_CPU_THROTTLE=8` applies
 *  CDP CPU throttling to the page (the zz-diag-gate-edge-load.spec.ts method).
 *  A real-GPU Mac cannot otherwise see the failure mode this file is written
 *  for. Never set on CI. */
const CPU_THROTTLE = Number(process.env.E2E_CPU_THROTTLE ?? '1');

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
  /** Rises the module counted between the window's first and last sample —
   *  with the renderer STOPPED, so every one of them arrived off the frame
   *  clock. */
  risesSeen: number;
  /** AudioContext time the window spanned (s) — the audio thread's own clock,
   *  which a starved main thread does not slow down. */
  audioSpanSec: number;
  /** The longest interval the in-page sampler itself observed (ms): the
   *  longest the main thread was away during the window. */
  maxGapMs: number;
  /**
   * Every period the module measured for a rise whose PREVIOUS rise was also
   * detected inside the window (ms, in order). The first rise detected has its
   * previous one before the window — possibly the "patched while HIGH → fires
   * once" rise, whose partial first period is a documented product behaviour
   * and not a clock measurement — so its period is not one of these. When
   * several rises are replayed in one sample only the last one's period is
   * readable; `bursts` counts the others.
   */
  periodsMs: number[];
  bursts: number;
  samples: number;
  elapsedMs: number;
  /** The module's period at the instant of the ONE draw below, ms. */
  periodAtDrawMs: number;
  /** What that draw actually used, ms. */
  effectiveMs: number;
  driving: boolean;
  drawsDelta: number;
}

/**
 * Sample IN THE PAGE, once per bridge tick, for `cycles` LFO cycles of the
 * AUDIO clock; then drive ONE draw synchronously and read what it used.
 *
 * ONE evaluate: the accumulator lives in the page (never a Playwright poll
 * loop — one round trip per sample on the same main thread as the subject).
 * Nothing here waits for a condition on the main thread's punctuality: the
 * window closes on the audio clock, and what the sampler measured about its
 * own lateness is returned so the assertions can derive their bounds from it.
 * The draw is the LAST thing before the read and nothing can interleave, so
 * `effectiveMs` is exactly the function of `periodAtDrawMs` the module
 * computes. Bounded in LFO cycles (a wall bound of twice the window guards a
 * stalled audio clock, i.e. a suspended context — never the expected path).
 */
function lockOnClock(page: Page, opts: { cycles: number }): Promise<LockSample> {
  return page.evaluate(
    async ({ id, cycles, hz, tickMs }) => {
      const w = globalThis as unknown as {
        __engine: () => { getDomain: (d: string) => unknown };
      };
      const eng = w.__engine();
      const vid = eng.getDomain('video') as VideoSeam;
      const audio = eng.getDomain('audio') as { ctx: { currentTime: number } };
      const spanSec = cycles / hz;
      const wallBudgetMs = 2 * spanSec * 1000;
      const t0 = performance.now();
      let samples = 0;
      let maxGapMs = 0;
      let last = performance.now();
      let startCount = -1;
      let startAudio = 0;
      let seen = -1;
      let audioNow = audio.ctx.currentTime;
      /** Rises detected inside the window so far — the second one on is the
       *  first whose period is a measurement between two windowed rises. */
      let detected = 0;
      const periodsMs: number[] = [];
      let bursts = 0;
      for (;;) {
        await new Promise((r) => setTimeout(r, tickMs));
        samples++;
        const now = performance.now();
        const gap = now - last;
        last = now;
        if (gap > maxGapMs) maxGapMs = gap;
        const n = vid.read(id, 'clockRiseCount') as number;
        audioNow = audio.ctx.currentTime;
        if (startCount < 0) {
          // The window OPENS at the first sample, not at the evaluate's start:
          // its gap is measured like every other one.
          startCount = n;
          startAudio = audioNow;
          seen = n;
          continue;
        }
        if (n > seen) {
          const d = n - seen;
          seen = n;
          detected += d;
          const p = vid.read(id, 'clockPeriodSec') as number;
          if (detected > d && p > 0) periodsMs.push(p * 1000);
          bursts += d - 1;
        }
        if (audioNow - startAudio >= spanSec || now - t0 >= wallBudgetMs) break;
      }
      // Synchronous from here: no scheduler tick can land between this read
      // and the draw that consumes it.
      const periodAtDrawMs = (vid.read(id, 'clockPeriodSec') as number) * 1000;
      const before = vid.framesDrawnFor(id);
      vid.step();
      return {
        risesSeen: seen - startCount,
        audioSpanSec: audioNow - startAudio,
        maxGapMs,
        periodsMs,
        bursts,
        samples,
        elapsedMs: performance.now() - t0,
        periodAtDrawMs,
        effectiveMs: vid.read(id, 'effectiveDelayMs') as number,
        driving: vid.read(id, 'clockDriving') === true,
        drawsDelta: vid.framesDrawnFor(id) - before,
      };
    },
    { id: NODE, cycles: opts.cycles, hz: LFO_RATE_HZ, tickMs: SCHEDULER_TICK_MS },
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

/**
 * How late a replay can be, derived from the sampler's own worst interval: the
 * scheduler tick period, one more tick for port latency, plus however long
 * the main thread was away beyond the sampler's own interval. A quiet machine
 * earns ~2-3 ticks here; the starved CI runner above earns ~0.55 s.
 */
function replayLatenessBoundMs(lock: LockSample): number {
  const stallMs = Math.max(0, lock.maxGapMs - SCHEDULER_TICK_MS);
  return 2 * SCHEDULER_TICK_MS + stallMs;
}

/**
 * The rate assertion's tolerance: a rise can be in flight at each end of the
 * window for at most `replayLatenessBoundMs`, so the count the module shows
 * can differ from the true count inside the audio window by the rises that fit
 * in twice that, plus one for the window's fractional cycle. Quiet: ±1.
 */
function countToleranceFor(lock: LockSample): number {
  return 1 + LFO_RATE_HZ * 2 * (replayLatenessBoundMs(lock) / 1000);
}

/** The positive control: over a window of the AUDIO clock the module counts
 *  the LFO's rises at the LFO's rate, with the renderer stopped, and every
 *  period it measured between two windowed rises is the clock's to within the
 *  lateness the instrument can vouch for. One line of evidence is printed
 *  either way, so a CI report carries the measurement and not just the
 *  verdict. */
function expectLockedOnClock(lock: LockSample, what: string): void {
  const expected = LFO_RATE_HZ * lock.audioSpanSec;
  const tolerance = countToleranceFor(lock);
  const band = 2 * replayLatenessBoundMs(lock);
  console.log(
    `[backdraft-clocked-delay] ${what}: rises=${lock.risesSeen} expected=${expected.toFixed(2)} ` +
      `(±${tolerance.toFixed(2)}) over ${lock.audioSpanSec.toFixed(3)} s audio / ${lock.elapsedMs.toFixed(0)} ms wall, ` +
      `${lock.samples} samples, maxGap=${lock.maxGapMs.toFixed(0)} ms, band=±${band.toFixed(0)} ms, ` +
      `bursts=${lock.bursts}, periods=[${fmt(lock.periodsMs)}] ms`,
  );
  expect(
    lock.risesSeen,
    `${what}: with the renderer STOPPED at least one rise must arrive — the pre-widen per-frame ` +
      `bridge delivers no edge at all without a frame (${lock.samples} samples over ${lock.elapsedMs.toFixed(0)} ms)`,
  ).toBeGreaterThan(0);
  // Non-vacuity: the derived tolerance must be able to fail the total-loss
  // case. If the main thread was away for so long that every expected rise
  // could be "in flight", the rate check has no power and says so, rather
  // than passing on nothing.
  expect(
    tolerance,
    `${what}: the instrument has power — the main thread was away for up to ${lock.maxGapMs.toFixed(0)} ms, ` +
      `so the rate check could not tell a total loss of the clock from latency`,
  ).toBeLessThan(expected);
  expect(
    Math.abs(lock.risesSeen - expected),
    `${what}: ${lock.risesSeen} rises counted across ${lock.audioSpanSec.toFixed(3)} s of AUDIO time — the ` +
      `${LFO_RATE_HZ} Hz clock owes ${expected.toFixed(2)}, and at most ${tolerance.toFixed(2)} can be ` +
      `in flight at the window's ends (longest main-thread gap ${lock.maxGapMs.toFixed(0)} ms); ` +
      `fewer is a dropped edge, more a manufactured one`,
  ).toBeLessThanOrEqual(tolerance);
  // Each measured period, bounded by what the instrument can vouch for: a
  // period is the difference of two replay times, each late by at most the
  // derived bound, so it can sit no further than twice that from the clock's.
  // On a quiet machine that is ~60-70 ms — a manufactured (~25 ms) or dropped
  // (~500 ms) edge cannot hide in it. The one-tick precision of a single
  // period is pinned at unit level, where tick delivery is deterministic.
  for (const p of lock.periodsMs) {
    expect(
      Math.abs(p - CLOCK_PERIOD_MS),
      `${what}: every period measured between two windowed rises is one clock pulse — within ` +
        `±${band.toFixed(0)} ms (twice the derived replay lateness) of ${CLOCK_PERIOD_MS} ms ` +
        `(periods: ${fmt(lock.periodsMs)} ms; longest main-thread gap ${lock.maxGapMs.toFixed(0)} ms)`,
    ).toBeLessThanOrEqual(band);
  }
  expect(lock.drawsDelta, `${what}: the one explicit draw really ran`).toBe(1);
  expect(lock.driving, `${what}: the module reports the clock is driving the delay`).toBe(true);
}

test.describe('backdraft — clocked delay makes the fader inert', () => {
  test('badge on patch, fader ignored while patched, control returned on unpatch', async ({ page }) => {
    test.setTimeout(CASE_MS);
    // Pause the engine's rAF loop BEFORE boot (see the header): every draw in
    // this test is one this test asked for, and the lock waits below run with
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

    if (CPU_THROTTLE > 1) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
    }

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
    // The cable landing re-renders the flow and the face — under SwiftShader
    // a 0.4-0.9 s main-thread task (measured). Two ANIMATION FRAMES after the
    // badge means the main thread has yielded twice, so the window below opens
    // after the patch's own work rather than inside it; that keeps the derived
    // bounds tight where they can be, and costs frames, not milliseconds. The
    // engine's loop is paused (see the header) — rAF itself is not. The edges
    // counted during that work are not lost either way (the worklet is
    // connected the instant the cable lands; pinned at unit level).
    await waitFrames(page, 2);

    // THE LOCK — and the POSITIVE CONTROL. The renderer is stopped, so every
    // edge counted here arrived through the audio-thread counter and the
    // scheduler tick, exactly as the module's docs promise; the per-frame
    // sampler this cable used to fall to delivers NOTHING without a frame.
    const lock = await lockOnClock(page, { cycles: LOCK_CYCLES });
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
    const clocked = await lockOnClock(page, { cycles: LOCK_CYCLES });
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
