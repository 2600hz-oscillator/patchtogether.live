// e2e/tests/tempolock.spec.ts
//
// TEMPOLOCK end-to-end — the owner's chain through the REAL patch seams:
//
//   deterministic onset source → TEMPOLOCK.in → TEMPOLOCK.clock →
//   TIMELORDE.clock (CLOCK IN) → the rack's measured BPM settles at the
//   TRACKED (folded) tempo, not at the raw inter-onset rate.
//
// The onset source is MOOG 960's free-running internal clock at 3.6 Hz —
// eighth-note pulses of the owner's 108 BPM case, 216 edges per minute, on a
// rate that is INDEPENDENT of the rack transport. A last-interval follower
// fed those edges reads 216 — which is precisely what TIMELORDE's CLOCK IN
// would do if TEMPOLOCK passed its input through. The assertion that
// TIMELORDE settles STEADY near 108 therefore proves all three claims at
// once through the live engine seams: the tracker locked, the octave fold
// chose 108 over the raw 216, and the CLOCK jack carries GENERATED
// quarter-note pulses rather than the input edges. (A 108 BPM quarter is
// 555.6 ms — the unit contract pinned in tempolock-tracker.test.ts fixture 1;
// TIMELORDE measuring ~108 from the wire is that same 555.6 ms period
// observed through a second, independent instrument.)
//
// ⚠ THE SOURCE MUST NOT FOLLOW THE RACK TRANSPORT, and two earlier drafts of
// this spec are why that is stated: (1) an LFO square's shared-clock epoch
// RESYNC phase-jumps the train every few seconds and TIMELORDE's follower
// averaged the resulting re-anchors into ~111; (2) KRIA steps at the RACK's
// tempo — which this very chain writes via TIMELORDE's CLOCK-IN follower —
// so kria→tempolock→timelorde is a closed loop in which EVERY in-band tempo
// is a fixed point (measured: it settled wherever it first landed, 120).
// MOOG 960's internal RATE is its own param, so the loop is open.
//
// The tracker math itself (owner pattern verbatim, the real recorded onset
// train, ramps, jitter, dropouts, the 216-vs-108 hysteresis) is exhaustively
// unit-tested in packages/web/src/lib/audio/tempolock/tempolock-tracker.test.ts.
// This spec proves the SEAMS: analyser tap → shared edge counter → scheduler
// tick → ConstantSource pulses → TIMELORDE's worklet measurement.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
// The module's own numbers, imported rather than restated (the tap-tempo
// spec's discipline). Pure file — no $lib imports, loads in the runner.
import {
  TEMPOLOCK_BANDS,
  TEMPOLOCK_DEFAULT_BAND_INDEX,
} from '../../packages/web/src/lib/audio/tempolock/tempolock-tracker';

const TPL = 'tpl';
const TL = 'tl';

/** The owner's tempo. */
const TRACKED_BPM = 108;
/** The source emits the owner case's EIGHTH-note pulse: 3.6 Hz. */
const SOURCE_HZ = 3.6;
/** What a last-interval follower reads from those edges. */
const RAW_FOLLOWER_BPM = SOURCE_HZ * 60; // 216

interface EngineRead {
  __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
  __patch?: { nodes: Record<string, { params?: Record<string, number> }> };
}

/** TEMPOLOCK's live tracker snapshot via the engine handle's read('state'). */
async function readTempolockState(
  page: Page,
  nodeId: string,
): Promise<{ locked: boolean; bpm: number | null } | null> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as EngineRead;
    const eng = w.__engine?.();
    const node = w.__patch?.nodes[id];
    if (!eng || !node) return null;
    const st = eng.read(node, 'state') as { locked?: boolean; bpm?: number | null } | undefined;
    if (!st || typeof st.locked !== 'boolean') return null;
    return { locked: st.locked, bpm: typeof st.bpm === 'number' ? st.bpm : null };
  }, nodeId);
}

/**
 * How many inter-edge periods TIMELORDE's follower averages before it reports
 * a tempo — the length of the worklet's median window, not a tuning knob:
 * `packages/dsp/src/lib/timelorde-clock-core.ts` pushes each measured period
 * into `periodSamples`, caps it at FOUR (`if (…length > 4) shift()`), and
 * reports `60 / median(periodSamples)` — where `median()` of an even-length
 * window AVERAGES THE TWO MIDDLE VALUES.
 *
 * That is the whole reason this spec needs a settle WAIT rather than a read.
 * Until four quarter-notes of the SETTLED wire have entered that window, the
 * reported tempo is a blend of the settled period and the leftovers from
 * TEMPOLOCK's lock-in transient, and the blend lands strictly BETWEEN the two
 * tempos. It is a correct reading of a window that is still half-stale — not
 * a wrong tempo, and not something a longer timeout can prevent.
 */
const TIMELORDE_MEDIAN_WINDOW = 4;

interface TimelordeSettle {
  settled: boolean;
  run: number;
  samples: number;
  min: number;
  max: number;
  trail: number[];
}

/**
 * Wait until TIMELORDE's followed bpm HOLDS inside [lo, hi] for
 * `TIMELORDE_MEDIAN_WINDOW` consecutive tracked beats — the settled state this
 * leg claims — ACCUMULATED IN THE PAGE (AGENTS.md: never sample a page-side
 * quantity with a Playwright-side poll loop).
 *
 * Convergence, not wall time, is the wait: a sample outside the band RESETS
 * the run, so a value passing through the band on its way somewhere else can
 * no longer satisfy it, and a transient excursion delays the wait instead of
 * failing it. `capMs` only BOUNDS the failure — it is not the thing being
 * waited on — and the trail comes back either way so a failure names the
 * trajectory it saw. A run that never read a number resolves with samples: 0,
 * which the caller asserts on: a zero-sample accumulator is not a pass.
 */
async function waitForTimelordeSettle(
  page: Page,
  nodeId: string,
  opts: { lo: number; hi: number; need: number; capMs: number },
): Promise<TimelordeSettle> {
  return page.evaluate(
    ({ id, lo, hi, need, capMs, trackedBpm }) => {
      return new Promise<TimelordeSettle>((resolve) => {
        const w = globalThis as unknown as {
          __patch?: { nodes: Record<string, { params?: Record<string, number> }> };
        };
        // pacing: one sample per tracked quarter-note — the same product-defined
        // beat the median window is measured in, so `need` consecutive samples
        // is `need` beats of settled wire.
        const periodMs = 60000 / trackedBpm;
        let samples = 0;
        let run = 0;
        let min = Infinity;
        let max = -Infinity;
        const trail: number[] = [];
        const startedAt = performance.now();
        const timer = setInterval(() => {
          const v = w.__patch?.nodes[id]?.params?.bpm;
          if (typeof v === 'number') {
            samples++;
            min = Math.min(min, v);
            max = Math.max(max, v);
            if (trail.length < 240) trail.push(Math.round(v * 100) / 100);
            run = v > lo && v < hi ? run + 1 : 0;
            if (run >= need) {
              clearInterval(timer);
              resolve({ settled: true, run, samples, min, max, trail });
              return;
            }
          }
          if (performance.now() - startedAt >= capMs) {
            clearInterval(timer);
            resolve({ settled: false, run, samples, min, max, trail });
          }
        }, periodMs);
      });
    },
    { id: nodeId, lo: opts.lo, hi: opts.hi, need: opts.need, capMs: opts.capMs, trackedBpm: TRACKED_BPM },
  );
}

/**
 * TIMELORDE's bpm min/max over a bounded window, ACCUMULATED IN THE PAGE
 * (CLAUDE.md: never sample a page-side quantity with a Playwright-side poll
 * loop). The window is expressed in observed clock beats, not wall time:
 * it resolves after `beats` quarter-notes at the tracked tempo have elapsed
 * by the page's own performance clock, with a wall-clock cap only to bound
 * the failure.
 */
async function timelordeBpmEnvelope(
  page: Page,
  nodeId: string,
  beats: number,
): Promise<{ min: number; max: number; samples: number }> {
  return page.evaluate(
    ({ id, beats, trackedBpm }) => {
      return new Promise<{ min: number; max: number; samples: number }>((resolve) => {
        const w = globalThis as unknown as {
          __patch?: { nodes: Record<string, { params?: Record<string, number> }> };
        };
        // pacing: one sample per tracked quarter-note (60000/trackedBpm ms) —
        // the product-defined beat interval this spec measures stability over.
        const periodMs = 60000 / trackedBpm;
        let min = Infinity;
        let max = -Infinity;
        let samples = 0;
        const timer = setInterval(() => {
          const v = w.__patch?.nodes[id]?.params?.bpm;
          if (typeof v === 'number') {
            min = Math.min(min, v);
            max = Math.max(max, v);
            samples++;
          }
          if (samples >= beats) {
            clearInterval(timer);
            resolve({ min, max, samples });
          }
        }, periodMs);
      });
    },
    { id: nodeId, beats, trackedBpm: TRACKED_BPM },
  );
}

test.describe('TEMPOLOCK — tracked clock through the real patch seams', () => {
  // UN-PARKED (#1847). This leg has had TWO distinct load-sensitive failure
  // modes, and only telling them apart makes it deterministic:
  //
  //   (a) TRUNCATION — a correct convergence cut off by a flat 25 s poll cap
  //       and by Playwright's 30 s default test cap (run 33277723925 shard 4).
  //       Closed by #2276's CI-aware budgets, kept below.
  //   (b) EARLY RELEASE — a one-sided wait releasing into a still-flushing
  //       measurement window, so the upper bound was asserted on a value
  //       nothing had waited for (run 33402250777 shard 3, 2026-08-31, and
  //       the park's own `toBeLessThan` observation on run 33290095701).
  //       Closed by the settle accumulator at step 3.
  //
  // (b) is why raising (a)'s budgets did not stop the flake: a poll that
  // finishes too EARLY cannot be fixed by giving it more time.
  test('folds a 216-edge/min onset train to 108 and TIMELORDE follows the tracked tempo', async ({ page }) => {
    // ⚠ Without this, the CI-aware caps below are DEAD CODE: the config sets
    // no per-test timeout, so Playwright's default 30s cap fires first.
    // Measured (run 33277723925 shard 4): both attempts died at 30.4s/29.9s —
    // the default cap racing the old flat 25s poll — while the tracker was
    // locked and converging (see the lock poll's comment). Budget = spawn +
    // the load-scaled lock poll + the settle wait + the 6-beat envelope,
    // with margin.
    test.setTimeout(process.env.CI ? 240_000 : 90_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto('/rack?seed=none');
    await page.waitForLoadState('networkidle');

    // MOOG 960 free-running at 3.6 Hz — eighth-note pulses on clock_out (the
    // tap-tempo spec's documented "chain a clock into TIMELORDE" source), a
    // rate independent of the rack transport. TIMELORDE spawns at bpm 60 so
    // "settled near 108" cannot be a stale default.
    const nodes: SpawnNode[] = [
      { id: 'src', type: 'moog960', position: { x: 40, y: 80 }, domain: 'audio', params: { rate: SOURCE_HZ } },
      { id: TPL, type: 'tempolock', position: { x: 320, y: 80 }, domain: 'audio' },
      { id: TL, type: 'timelorde', position: { x: 620, y: 80 }, domain: 'audio', params: { bpm: 60 } },
    ];
    const edges: SpawnEdge[] = [
      { id: 'e_src', from: { nodeId: 'src', portId: 'clock_out' }, to: { nodeId: TPL, portId: 'in' }, sourceType: 'gate', targetType: 'gate' },
      { id: 'e_clk', from: { nodeId: TPL, portId: 'clock' }, to: { nodeId: TL, portId: 'clock' }, sourceType: 'gate', targetType: 'gate' },
    ];
    await spawnPatch(page, nodes, edges);

    // 1+2. The tracker LOCKS at the FOLDED tempo: 108, not the raw 216 a
    //    follower would read. One poll owns the whole wait: the FIRST lock
    //    can seed off engine-spin-up jank (a stalled tick batches the first
    //    edges into distorted intervals — observed once in three local runs
    //    as a momentary 163), and the tempo follow then converges onto the
    //    real train within a bar or two. Confidence + convergence together
    //    are the settled state this leg claims.
    //    ⚠ The cap is CI-aware: how long the wash-out takes is a function of
    //    shard load, not of the subject. Measured (run 33277723925 shard 4,
    //    both attempts, from the traces): under a starved main thread (39ms
    //    scheduler tick vs ~25 nominal) the jank-distorted seed read 160.7 /
    //    164.6, locked=true throughout, bpm decaying monotonically toward
    //    108 — and the flat 25s cap expired mid-convergence at 119.3 / 135.
    //    Same signature as workflow-mode's pinned-trio wait (5db0dd8): a
    //    budget, not a subject fix. Locally 25s stays the bound.
    await expect
      .poll(
        async () => {
          const st = await readTempolockState(page, TPL);
          return (
            st?.locked === true &&
            st.bpm !== null &&
            st.bpm > TRACKED_BPM - 1.5 &&
            st.bpm < TRACKED_BPM + 1.5
          );
        },
        {
          timeout: process.env.CI ? 90_000 : 25000,
          message: `tempolock locks and settles at the folded ${TRACKED_BPM} (not the raw ${RAW_FOLLOWER_BPM})`,
        },
      )
      .toBe(true);
    // The default band is the def's declared one — anchor the fold's premise.
    const band = TEMPOLOCK_BANDS[TEMPOLOCK_DEFAULT_BAND_INDEX]!;
    expect(RAW_FOLLOWER_BPM).toBeGreaterThanOrEqual(band.max); // 216 needs folding
    expect(TRACKED_BPM).toBeGreaterThanOrEqual(band.min);
    expect(TRACKED_BPM).toBeLessThan(band.max);

    // 3. TIMELORDE's CLOCK-IN follower measures the GENERATED clock and its
    //    bpm SETTLES at the tracked tempo — held inside the band for a full
    //    median window, not merely observed inside it once.
    //
    //    ⚠ THE PREVIOUS SHAPE HERE WAS A ONE-SIDED WAIT FOLLOWED BY AN
    //    UNWAITED READ: `expect.poll(...).toBeGreaterThan(105)` and then a
    //    separate one-shot `expect(read()).toBeLessThan(111)`. Only the LOWER
    //    bound was ever waited for, and the follower approaches 108 FROM
    //    ABOVE (TEMPOLOCK's lock-in transient is faster than the settled
    //    tempo, and TIMELORDE's median window blends the two — see
    //    TIMELORDE_MEDIAN_WINDOW). So the poll was satisfied by the FIRST
    //    sample of a still-flushing window, and the upper bound was then
    //    asserted on a value nothing had waited for. Measured, PR #2266 run
    //    33402250777 e2e shard 3/12 (2026-08-31): attempt 1 failed with
    //    111.96 BPM — a median of two settled 555.6 ms quarters and two
    //    ~516 ms leftovers — and attempt 2 passed at the same SHA.
    //
    //    It is also the repo's SAMPLE-TWICE-ASSERT-ON-THE-SECOND class, which
    //    has taken `main` red twice in other specs: the poll validated one
    //    sample and the expect asserted on a DIFFERENT, later one, so neither
    //    bound was ever applied to a single reading. Both bounds are now one
    //    predicate on ONE in-page sample.
    //
    //    That mode is INVISIBLE to a timeout budget, which is why #2276's
    //    CI-aware caps (a real fix for a real, different failure: the polls
    //    being truncated mid-convergence) did not close it. The poll did not
    //    run out of time; it finished too early. The cap below therefore only
    //    bounds the failure — the WAIT is the convergence itself, and a
    //    sample outside the band resets the run rather than failing it.
    //
    //    Measured locally, this accumulator started at the instant the lock
    //    poll releases: 103.22, 110.21, 108.28, 106.61, 107.82, … — the early
    //    samples an unwaited read could land on straddle BOTH old bounds, one
    //    of them missing the old upper bound by 0.79. And the CI failure
    //    REPRODUCES under CPU contention: the pre-fix spec, 6 runs with
    //    retries off against 24 busy-loop hogs, failed once with
    //    `Expected < 111 / Received 112.43`. This version passed 6/6 under
    //    that same load, and 3/3 more under E2E_SWIFTSHADER=1.
    const settle = await waitForTimelordeSettle(page, TL, {
      lo: TRACKED_BPM - 3,
      hi: TRACKED_BPM + 3,
      need: TIMELORDE_MEDIAN_WINDOW,
      capMs: process.env.CI ? 90_000 : 25_000,
    });
    // A zero-sample accumulator is not a pass — it is an unreadable subject.
    expect(
      settle.samples,
      'the timelorde bpm param was never readable — the in-page accumulator took no samples',
    ).toBeGreaterThan(0);
    expect(
      settle.settled,
      `timelorde bpm never held ${TIMELORDE_MEDIAN_WINDOW} consecutive beats inside ` +
        `[${TRACKED_BPM - 3}, ${TRACKED_BPM + 3}] (555.6 ms quarters on the wire). ` +
        `${settle.samples} samples, span [${settle.min.toFixed(2)}, ${settle.max.toFixed(2)}], ` +
        `longest tail run ${settle.run}; trail: ${settle.trail.join(' ')}`,
    ).toBe(true);

    // 4. STABILITY: over the next 6 tracked beats the measured tempo stays
    //    inside the band around 108 — the follower is riding a STEADY clock,
    //    not flapping between 108 and 216 (the defect this module closes).
    //    Half of 216's flap (a single eighth-gap read) would show as ~216.
    //    This window now starts from a genuinely settled measurement (step 3
    //    waits out the median window), so it measures STEADINESS rather than
    //    the tail of a lock-in transient the way it could before.
    const env = await timelordeBpmEnvelope(page, TL, 6);
    expect(env.samples).toBeGreaterThanOrEqual(6);
    expect(
      env.min,
      `bpm envelope over ${env.samples} beats: [${env.min.toFixed(2)}, ${env.max.toFixed(2)}] BPM`,
    ).toBeGreaterThan(TRACKED_BPM - 5);
    expect(env.max).toBeLessThan(TRACKED_BPM + 5);

    expect(errors).toEqual([]);
  });
});
