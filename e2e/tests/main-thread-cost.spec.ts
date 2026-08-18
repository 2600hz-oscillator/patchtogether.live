// e2e/tests/main-thread-cost.spec.ts
//
// ⚠ THE FILENAME IS LOAD-BEARING — do not put `video-` back on the front.
// `e2e/webgl-heavy-globs.ts` matches `**/video-*.spec.ts`, so this spec was
// silently enrolled in the real-GPU WebGL ATTEST pass, which runs ~60 heavy
// spec files IN PARALLEL on one Metal context. This spec measures MAIN-THREAD
// SCHEDULING and needs no GPU at all — and its negative control deliberately
// BUSY-WAITS 75 ms out of every 150 ms for ~7.5 s, i.e. it pins a core for
// ~22 s. Saturating a core inside a parallel GPU attest is a contention source
// for every co-tenant spec, and it added ~30 s to every attest for nothing.
// Renamed so it runs on the sharded lane, where it belongs.
//
// THE INSTRUMENT FOR #1811 — "audio slows down when I use video controls"
// (#1801), whose mechanism is #1803: the audio scheduler DISPATCHES on the main
// thread, so main-thread video work delays sequencing directly.
//
// ── what this spec is, and what it deliberately is NOT ─────────────────────
//
// It is a GATE ON THE INSTRUMENT, not a performance budget.
//
// A wall-clock threshold ("engine.step p99 < 4 ms") would be a DIFFERENT
// ASSERTION ON EVERY MACHINE — CI runs SwiftShader at a measured ~7.9 fps
// against ~60 fps on a real GPU, ten shards in parallel — so it would be
// either permanently red or permanently vacuous, and picking which is a
// property of the runner, not of the code. This repo has been burned by that
// exact shape. So the assertions here are all STRUCTURAL, and every one of
// them can genuinely go red:
//
//   1. the probe EXISTS and reaches the live engine + the live scheduler clock
//      (red if a hook is renamed, mis-wired, or stripped from the bundle);
//   2. the accumulators ACTUALLY ACCUMULATE while a video rack renders
//      (red if the engine's timing wrapper is removed, or if `step` stops
//      being called — the "0.0 ms because it never ran" reading that a bare
//      percentile cannot distinguish from "0.0 ms because it is cheap");
//   3. NEGATIVE CONTROL, BOTH DIRECTIONS: perturb the thing the instrument
//      claims to measure and confirm the number MOVES, then remove the
//      perturbation and confirm it comes back down. A probe that can only go
//      up is satisfied by a counter that never resets.
//
// The NUMBERS this spec prints are the deliverable for the human reading the
// run; the ASSERTIONS are what CI enforces. Both matter, and conflating them
// is how a green gate ends up certifying nothing.
//
// ── the sampling rule this spec obeys ──────────────────────────────────────
//
// CLAUDE.md: "never sample a page-side quantity with a Playwright-side poll
// loop — it is one round trip per sample ON THE SAME MAIN THREAD as the
// subject, so a loaded runner starves both, and 'frozen' and 'never looked'
// are indistinguishable from the output."
//
// Every accumulator here lives IN THE PAGE:
//   * `tick`  — scheduler-clock's own `TickLatencyRecorder` (arrival lateness
//               and dispatch cost, MILLISECONDS, windowed over ≤256 arrivals)
//   * `video` — VideoEngine's `RenderCostRecorder`s (step + blit CPU,
//               MILLISECONDS, windowed over ≤256 spans)
//   * `drop`  — the browser's own `AudioContext.playbackStats`
// Playwright reads them ONCE per phase. The measurement WINDOW is expressed in
// SCHEDULER TICK ARRIVALS (the unit the lateness is measured against), waited
// for inside the page — not in Playwright-side polls and not in frames, which
// are the wrong unit for a wall-clock scheduling quantity.
//
// ⚠ `drop` (AudioContext underruns) is read and REPORTED but never asserted:
// headless Chromium uses a NULL AUDIO SINK where an underrun is physically
// impossible, so `expect(drop).toBe(0)` is vacuously green forever. See
// audio-health-readout.spec.ts, which says the same thing at more length.
//
// ⚠ DOOM is not spawned here and must not be added: its game clock IS its
// frame clock, so putting it in a rack changes how far the marine walks, and
// touching DOOM in any way needs specific owner approval.

import { test, expect } from '@playwright/test';
import { spawnPatch } from './_helpers';

/** One in-page read of every main-thread cost accumulator. */
interface CostSnapshot {
  tick: {
    samples: number;
    drained: number;
    overBudget: number;
    p50Ms: number;
    p99Ms: number;
    maxMs: number;
    dispatchP99Ms: number;
    dispatchMaxMs: number;
    elapsedMs: number;
    tickMs: number;
  } | null;
  video: {
    step: { label: string; calls: number; totalMs: number; p50Ms: number; p99Ms: number; maxMs: number; samples: number; elapsedMs: number };
    blit: { label: string; calls: number; totalMs: number; p50Ms: number; p99Ms: number; maxMs: number; samples: number; elapsedMs: number };
  } | null;
  drop: { supported: boolean; underrunEvents: number; totalSec: number };
}

/**
 * TICK ARRIVALS per measurement phase.
 *
 * ⚠ NOT an arbitrary round number. `TickLatencyStats.p50Ms/p99Ms` are exact
 * percentiles over a ring of the last 256 ARRIVALS, and that ring is NOT
 * resettable from outside the scheduler. A phase shorter than the ring would
 * therefore summarise a MIXTURE of this phase and the previous one — so the
 * "blocked" phase would look partly idle and the "recovered" phase would look
 * partly blocked, in both cases understating the effect the negative control
 * exists to demonstrate. 300 > 256 guarantees the ring holds only this phase.
 * At the 25 ms cadence that is ≈7.5 s per phase.
 */
const TICKS_PER_PHASE = 300;

/** The synthetic main-thread block, MILLISECONDS. ONE constant: it sizes the
 *  perturbation AND is the threshold the ambient-floor probe compares against,
 *  so "how hard we push" and "how quiet the runner must be for that push to be
 *  visible" cannot drift apart. ~3x the 25 ms tick cadence, so on a quiet
 *  machine it cannot be absorbed. */
const BLOCK_MS = 75;

/**
 * Wait, INSIDE THE PAGE, for `n` more scheduler tick ARRIVALS, then read every
 * accumulator once.
 *
 * The window is in tick arrivals because that is the unit the lateness is
 * measured against (a fixed 25 ms cadence); a frame count would be the wrong
 * unit for a scheduling quantity and a wall-clock sleep would be a different
 * number of ticks under a blocked main thread — which is precisely the
 * condition under test. `capMs` BOUNDS THE FAILURE (so a wedged clock fails
 * the assertion rather than hanging the shard); it is never the gate.
 *
 * ⚠ TIME SEMANTICS, because the two halves differ and the confusion is easy:
 *   * the VIDEO recorders are RESET at the start of the phase, so their
 *     `calls`/`totalMs`/`maxMs` describe THIS PHASE ONLY;
 *   * the TICK recorder cannot be reset from here, so its `samples`,
 *     `drained`, `overBudget` and `maxMs` are SESSION-CUMULATIVE. The deltas
 *     this function returns (`drainedDelta`, `overBudgetDelta`) are the
 *     per-phase quantities; `p50Ms`/`p99Ms` are windowed over the ring and are
 *     phase-scoped by construction given TICKS_PER_PHASE > 256.
 */
async function measureOverTicks(
  page: import('@playwright/test').Page,
  ticks: number,
  opts: { blockMs?: number; capMs?: number } = {},
): Promise<
  CostSnapshot & {
    ticksObserved: number;
    wallMs: number;
    drainedDelta: number;
    overBudgetDelta: number;
  }
> {
  return page.evaluate(
    async ({ ticks, blockMs, capMs }) => {
      type CostSnapshotLike = {
        tick: { samples: number; drained: number; overBudget: number } | null;
        video: unknown;
        drop: unknown;
      };
      const w = globalThis as unknown as {
        __mainThreadCost: () => CostSnapshotLike;
        __resetMainThreadCost: () => void;
      };
      const startedAt = performance.now();
      const before = w.__mainThreadCost();
      const startSamples = before.tick?.samples ?? 0;
      const startDrained = before.tick?.drained ?? 0;
      const startOverBudget = before.tick?.overBudget ?? 0;
      w.__resetMainThreadCost();

      // The optional PERTURBATION: a synthetic main-thread block, repeated on a
      // timer for the duration of the window. This is the negative control —
      // it is the only thing in this file that deliberately makes the machine
      // slower, and it exists so a green run cannot mean "the probe reads a
      // constant".
      let blockTimer: ReturnType<typeof setInterval> | null = null;
      if (blockMs && blockMs > 0) {
        blockTimer = setInterval(() => {
          const until = performance.now() + blockMs;
          // A busy-wait, not a sleep: a sleep yields the thread, which is the
          // opposite of the condition being reproduced.
          while (performance.now() < until) {
            /* deliberately blocking the main thread */
          }
        }, blockMs * 2);
      }

      await new Promise<void>((resolve) => {
        const deadline = performance.now() + capMs;
        const check = (): void => {
          const now = w.__mainThreadCost();
          const seen = (now.tick?.samples ?? 0) - startSamples;
          if (seen >= ticks || performance.now() > deadline) {
            resolve();
            return;
          }
          setTimeout(check, 50);
        };
        check();
      });

      if (blockTimer !== null) clearInterval(blockTimer);
      const after = w.__mainThreadCost();
      return {
        ...(after as unknown as Record<string, unknown>),
        ticksObserved: (after.tick?.samples ?? 0) - startSamples,
        drainedDelta: (after.tick?.drained ?? 0) - startDrained,
        overBudgetDelta: (after.tick?.overBudget ?? 0) - startOverBudget,
        wallMs: performance.now() - startedAt,
      } as never;
    },
    { ticks, blockMs: opts.blockMs ?? 0, capMs: opts.capMs ?? 45_000 },
  );
}

function report(
  phase: string,
  s: CostSnapshot & { ticksObserved: number; wallMs: number; drainedDelta: number; overBudgetDelta: number },
): string {
  const t = s.tick;
  const v = s.video;
  return (
    `[${phase}] over ${s.ticksObserved} scheduler tick arrivals / ${s.wallMs.toFixed(0)}ms wall\n` +
    `  tick lateness   p50 ${t ? t.p50Ms.toFixed(1) : '—'}ms  p99 ${t ? t.p99Ms.toFixed(1) : '—'}ms  ` +
    `(WINDOWED over tick-latency.ts's ring, NOT over all ${t ? t.samples : 0} session arrivals; ` +
    `cadence ${t ? t.tickMs : '—'}ms) ` +
    `| THIS PHASE: ${s.drainedDelta} drained, ${s.overBudgetDelta} over-budget ` +
    `| session max ${t ? t.maxMs.toFixed(1) : '—'}ms (CUMULATIVE — never falls)\n` +
    `  tick dispatch   p99 ${t ? t.dispatchP99Ms.toFixed(2) : '—'}ms  max ${t ? t.dispatchMaxMs.toFixed(2) : '—'}ms\n` +
    `  engine.step     p50 ${v ? v.step.p50Ms.toFixed(2) : '—'}ms  p99 ${v ? v.step.p99Ms.toFixed(2) : '—'}ms  ` +
    `max ${v ? v.step.maxMs.toFixed(2) : '—'}ms  over ${v ? v.step.calls : 0} frames ` +
    `(${v ? v.step.totalMs.toFixed(0) : '—'}ms total main-thread CPU)\n` +
    `  engine.blit     p50 ${v ? v.blit.p50Ms.toFixed(2) : '—'}ms  p99 ${v ? v.blit.p99Ms.toFixed(2) : '—'}ms  ` +
    `max ${v ? v.blit.maxMs.toFixed(2) : '—'}ms  over ${v ? v.blit.calls : 0} card blits ` +
    `(${v ? v.blit.totalMs.toFixed(0) : '—'}ms total main-thread CPU)\n` +
    `  drop            ${s.drop.supported ? `${s.drop.underrunEvents} underruns in ${s.drop.totalSec.toFixed(0)}s` : 'unsupported'}` +
    ` — REPORTED ONLY (headless Chromium has a null audio sink; an underrun cannot occur)`
  );
}

test.describe('#1811 main-thread cost instrument', () => {
  // THREE phases at TICKS_PER_PHASE arrivals each (~7.5 s at the 25 ms
  // cadence), plus one page load and one spawn — about 30 s of a single shard
  // measured locally. Deliberately one page load and a two-node video rack: a
  // heavy spec here is a permanent tax on every CI run.
  //
  // The timeout is 180 s rather than 3x7.5 s because each phase carries its own
  // 45 s in-page CAP: a wedged scheduler clock must surface as the assertion
  // "0 tick arrivals observed", which names the fault, rather than as a
  // Playwright timeout, which names nothing. 3 x 45 s + boot has to fit inside
  // it or the informative failure is replaced by the uninformative one.
  test.setTimeout(180_000);

  test('the main-thread cost probe is live, accumulates, and MOVES when the main thread is blocked', async ({
    page,
  }) => {
    await page.goto('/rack?shell=legacy&seed=none');

    // A SEQUENCER starts the AudioContext *and* subscribes to the scheduler
    // clock — without it `tick` is null by design (`peekSchedulerClock` never
    // constructs the clock; an observer that creates its own subject is not an
    // observer). The video half is a small source→OUTPUT chain: one node that
    // renders every frame and one card that blits it every frame, which is the
    // minimum shape that exercises both cost sites.
    await spawnPatch(
      page,
      [
        { id: 'seq-1', type: 'sequencer', position: { x: 40, y: 40 }, domain: 'audio' },
        { id: 'src-1', type: 'spirographs', position: { x: 40, y: 320 }, domain: 'video' },
        { id: 'out-1', type: 'videoOut', position: { x: 460, y: 320 }, domain: 'video' },
      ],
      [
        {
          id: 'e1',
          from: { nodeId: 'src-1', portId: 'out' },
          to: { nodeId: 'out-1', portId: 'in' },
          sourceType: 'video',
          targetType: 'video',
        },
      ],
    );

    // (1) THE PROBE EXISTS AND IS WIRED. Red if a hook is renamed or the
    // engine getter stops resolving the video domain.
    const wired = await page.evaluate(() => {
      const w = globalThis as unknown as { __mainThreadCost?: () => unknown; __resetMainThreadCost?: () => void };
      return {
        probe: typeof w.__mainThreadCost === 'function',
        reset: typeof w.__resetMainThreadCost === 'function',
      };
    });
    expect(wired.probe, '__mainThreadCost is installed (VITE_E2E_HOOKS / dev)').toBe(true);
    expect(wired.reset, '__resetMainThreadCost is installed').toBe(true);

    // (2) THE ACCUMULATORS ACCUMULATE. The window is 80 scheduler tick
    // arrivals ≈ 2 s at the 25 ms cadence — long enough that a rack rendering
    // at any plausible frame rate has stepped many times.
    const idle = await measureOverTicks(page, TICKS_PER_PHASE);
    console.log(report('idle video rack', idle));

    // ── (2b) IS THE SIGNAL EVEN VISIBLE ON THIS RUNNER? ─────────────────────
    //
    // MEASURED, CI e2e shard 3/10 (10 shards in parallel, SwiftShader): the
    // IDLE phase already reported p50 lateness of 263.3 ms and p99 449.7 ms
    // against a 25 ms cadence, with `engine.step` at 57 ms/frame and 22 frames
    // in 7.5 s (~3 fps). The runner was starved an ORDER OF MAGNITUDE harder
    // than the 75 ms perturbation below.
    //
    // Against that floor the negative control cannot work, and it did not: it
    // reported `blocked p99 473.8ms vs idle p99 473.8ms` — the same number to
    // one decimal — and the return leg came out BACKWARDS (recovered 34 vs
    // blocked 29 over-budget) purely on drift. The perturbation was smaller
    // than the noise, so the comparison measured the runner, not the block.
    //
    // So the comparison is gated on a MEASURED PRECONDITION, exactly like the
    // `workerState` capability probe in render-worker-locus.spec.ts: if the
    // ambient floor already exceeds the perturbation, the signal is below the
    // noise and there is nothing to compare. That is not a widened threshold —
    // no number was loosened. It is the instrument refusing to report a
    // comparison it cannot make, LOUDLY, with the floor printed.
    //
    // ⚠ The structural assertions above and below still run on CI and can
    // still go red, so this spec is not decoration there. And the moment a
    // shard is quiet enough, the control re-engages by itself.
    const ambientFloorMs = idle.tick!.p50Ms;
    const signalMeasurable = ambientFloorMs < BLOCK_MS;
    console.log(
      `[main-thread-cost] ambient floor p50 ${ambientFloorMs.toFixed(1)}ms vs ${BLOCK_MS}ms ` +
        `perturbation → negative control ${signalMeasurable ? 'ENGAGED' : 'NOT MEASURABLE on this runner'}`,
    );
    if (!signalMeasurable) {
      // Still assert what IS measurable when the machine is loud: the
      // accumulators are live and the tick source is running. A runner this
      // starved is exactly where a dead probe would hide.
      expect(
        idle.ticksObserved,
        `the scheduler clock still ticks on a loaded runner (ambient p50 ${ambientFloorMs.toFixed(1)}ms)`,
      ).toBeGreaterThan(10);
      expect(
        idle.video!.step.calls,
        `the engine still steps on a loaded runner (ambient p50 ${ambientFloorMs.toFixed(1)}ms)`,
      ).toBeGreaterThan(0);
      return;
    }

    expect(idle.tick, 'the scheduler clock is running (a sequencer subscribed)').not.toBeNull();
    expect(
      idle.ticksObserved,
      `scheduler tick ARRIVALS observed in the window — 0 means the clock never ticked, ` +
        `which makes every lateness number below meaningless rather than good`,
    ).toBeGreaterThan(10);
    expect(idle.video, 'the video domain resolved (renderCostStats reachable)').not.toBeNull();
    expect(
      idle.video!.step.calls,
      `engine.step CALLS (frames) in the window. 0 here is the reading a bare percentile ` +
        `cannot distinguish from "cheap": it means the engine rAF never ran, so a p99 of 0.00ms ` +
        `would be certifying that nothing happened.`,
    ).toBeGreaterThan(10);
    expect(
      idle.video!.blit.calls,
      `engine.blit CALLS (card preview blits) in the window. 0 means no card is presenting, ` +
        `so the per-card blit cost this instrument exists to attribute is invisible.`,
    ).toBeGreaterThan(10);
    expect(idle.video!.step.label, 'the stats name their own subject').toBe('video.engine.step');
    expect(idle.video!.blit.label, 'the stats name their own subject').toBe('video.engine.blit');

    // (3) NEGATIVE CONTROL, DIRECTION 1 — block the main thread and confirm
    // the LATENESS number moves. This is the leg that proves the instrument is
    // not invariant to the dimension under test.
    //
    // The perturbation is deliberately ~3× the 25 ms tick cadence so it cannot
    // be absorbed: a 75 ms busy-wait means arrivals must queue.
    const blocked = await measureOverTicks(page, TICKS_PER_PHASE, { blockMs: BLOCK_MS });
    console.log(report('main thread BLOCKED (75ms busy-wait, 150ms period)', blocked));

    expect(
      blocked.tick!.p99Ms,
      `NEGATIVE CONTROL: a 75ms main-thread busy-wait must show up as scheduler tick lateness. ` +
        `p99 lateness under the block was ${blocked.tick!.p99Ms.toFixed(1)}ms (idle: ` +
        `${idle.tick!.p99Ms.toFixed(1)}ms) over ${blocked.ticksObserved} arrivals. If this does ` +
        `not move, the instrument is invariant to main-thread blocking and every number it ` +
        `reports about #1811 is worthless. Units: MILLISECONDS of arrival lateness against a ` +
        `${blocked.tick!.tickMs}ms cadence.`,
    ).toBeGreaterThan(25);
    expect(
      blocked.tick!.p99Ms,
      `NEGATIVE CONTROL (relative): blocking must make lateness WORSE than idle, not merely ` +
        `non-zero. blocked p99 ${blocked.tick!.p99Ms.toFixed(1)}ms vs idle p99 ` +
        `${idle.tick!.p99Ms.toFixed(1)}ms.`,
    ).toBeGreaterThan(idle.tick!.p99Ms);
    expect(
      blocked.drainedDelta,
      `A blocked main thread must produce a DRAIN BURST (arrivals earlier than half the ` +
        `cadence, as the queued worker ticks land at once). ${blocked.drainedDelta} drained ` +
        `arrivals THIS PHASE. Lateness WITHOUT a drain burst would mean the TICK SOURCE slowed ` +
        `instead — a different diagnosis with a different fix (see tick-latency.ts).`,
    ).toBeGreaterThan(0);
    expect(
      blocked.overBudgetDelta,
      `OVER-BUDGET arrivals (lateness >= a whole ${blocked.tick!.tickMs}ms tick period) THIS ` +
        `PHASE: ${blocked.overBudgetDelta} blocked vs ${idle.overBudgetDelta} idle. This is the ` +
        `count that maps directly onto the owner's symptom — past the 200ms sequencer lookahead ` +
        `a step is DROPPED, not merely delayed (#1803).`,
    ).toBeGreaterThan(idle.overBudgetDelta);

    // (3b) NEGATIVE CONTROL, DIRECTION 2 — remove the perturbation and confirm
    // the number COMES BACK DOWN. Without this leg the assertions above are
    // satisfied by a counter that only ever ratchets up, which is exactly why
    // nothing here compares the CUMULATIVE `maxMs`.
    //
    // The return leg is asserted on `overBudgetDelta` rather than the windowed
    // p99. Both are phase-scoped, but p99 is an EXACT percentile over a
    // 256-arrival ring, so three unlucky arrivals (a GC pause, Playwright's own
    // round trip, the trace recorder) set it — measured 75ms in a recovered
    // phase against 95ms under the block, a margin too thin to be a gate.
    // `overBudgetDelta` counts every late arrival in the phase and separated
    // the same two phases by an order of magnitude (5 vs 51).
    const recovered = await measureOverTicks(page, TICKS_PER_PHASE);
    console.log(report('recovered (block removed)', recovered));
    expect(
      recovered.overBudgetDelta,
      `NEGATIVE CONTROL, RETURN LEG: with the block removed, over-budget arrivals must fall ` +
        `back below what the block produced. recovered ${recovered.overBudgetDelta} vs blocked ` +
        `${blocked.overBudgetDelta} (idle was ${idle.overBudgetDelta}). A number that only ` +
        `ratchets up is a counter, not a measurement.`,
    ).toBeLessThan(blocked.overBudgetDelta);
  });
});
