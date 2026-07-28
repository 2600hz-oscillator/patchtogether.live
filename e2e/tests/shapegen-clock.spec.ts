// e2e/tests/shapegen-clock.spec.ts
//
// SHAPEGEN — CLOCK gate input (sample-and-hold).
//
//   ACIDWARP (time-varying video source) → SHAPEGEN.raster_a
//   SEQUENCER → SHAPEGEN.clock_in
//
// The user spec mentioned ANALOGVCO→RASTERIZE→SHAPEGEN, but the shape
// generation pipeline only cares that the raster input MOVES — the
// regression here is the CLOCK gate's sample-and-hold behaviour, not
// the audio→video bridge. ACIDWARP is a self-animating video source
// that doesn't need an audio chain.
//
// Contract being pinned (via the deterministic `regenCount` engine-read,
// not pixel diffs — the source raster's frame-to-frame movement would
// make pixel-diff assertions flake under CI load):
//   1. With the clock SEQUENCER playing, the regen counter advances over
//      time. Across a multi-second window we should observe AT LEAST 2
//      regenerations (rising edges of the chain-out clock pulse).
//   2. Within a SINGLE hold window (a short interval ANCHORED immediately
//      after observing a regen, well under one clock period), the regen
//      counter MUST be unchanged.
//   3. Once we STOP the SEQUENCER (isPlaying=0 so no more rising edges
//      arrive), the regen counter SHOULD stay frozen across multiple
//      seconds — even though the source raster is still updating, the
//      held shape list is reused frame-after-frame.
//
// Clock-period note: the sequencer's `clock` output fires ON EVERY STEP
// ADVANCE, which is a 16TH-NOTE period (= 60 / bpm / 4). So 60 BPM →
// 250 ms clock period, NOT 1 s (a beat is a quarter note). We use
// BPM=30 → 500 ms period and ANCHOR the hold window immediately after a
// fresh regen so we know we're at the start of a period.
//
// CHRONIC-FLAKE ROOT CAUSE (fixed; this spec is now its regression test).
// This test died repeatedly with "the regen counter stopped advancing",
// and was three times misdiagnosed as a test-budget problem (60→30 BPM,
// runner-poll → in-page anchor, retries=2 with a comment blaming a
// page-visibility video-engine suspend). It was none of those: it was a
// REAL PRODUCT BUG in the cross-domain audio → video CV bridge.
//
// `VideoEngine.tickCvBridges` sampled ONE analyser sample per VIDEO
// FRAME. A gate pulse is an IMPULSE — the sequencer clock-out is HIGH for
// 10 ms — so a frame-rate sampler caught any given pulse with probability
// ≈ pulseWidth / framePeriod, and because both the pulse train and rAF
// are periodic they BEAT: a phase that dropped the pulse into the gap
// between two frame samples KEPT it there for many periods. Measured
// locally under CPU throttling (telemetry on steps / frames / regen):
//
//   120 fps → 23/24 edges     19 fps → 5/24 edges, incl. a 6.7 s STALL
//    36 fps →  9/24 edges     while the audio clock and the video render
//                             loop were BOTH provably healthy.
//
// The fix (PatchEngine.installGateDispatch) stops sampling and starts
// COUNTING — in the AUDIO THREAD. A gate source into a gate-style video cv
// input is tapped by a tiny AudioWorklet (`gate-edge-worklet.ts`) that does
// per-sample rising-edge detection and keeps a MONOTONIC total; the scheduler
// clock replays the DELTA into the target's setParam.
//
// WHY NOT A MAIN-THREAD COUNTER (the CI-only second half — this spec's first
// fix shipped red because of it). Reading edges off an AnalyserNode on the main
// thread is lossless only while the gap between polls stays under
// `fftSize / sampleRate`. On a loaded CI runner the main thread is preempted
// for hundreds of ms at a time. Instrumented on a FAITHFUL local repro
// (E2E_SWIFTSHADER=1 + injected 250 ms main-thread stalls — CPU throttling
// alone does NOT reproduce it, which is why the first fix measured 24/24
// locally and 7/11 on CI), the max poll gap was 1626 ms against an
// AnalyserNode MAXIMUM window of 683 ms (fftSize 32768 @ 48 kHz). Delivery
// under that repro: 13/24 edges at fftSize 4096, 20/24 at the 32768 maximum,
// and EXACT once the count moved into the audio thread.
//
// Hence assertion 0 below — regen must track the pulses the sequencer ACTUALLY
// EMITTED, ~1:1. Note the reference quantity: `totalAdvances - lateStepsDropped`,
// NOT raw `totalAdvances`. The sequencer's own #229 catch-up guard deliberately
// SKIPS the clock pulse for a past-due step (drop, don't pile up) while still
// advancing `totalAdvances`, so raw `totalAdvances` demands edges that were
// never in the signal — which is precisely what reddened CI run 30279173414
// (steps +11 / regen +7, of which 4 were guard-dropped). That is the canary
// that actually catches this bug class; a "did it move at all" assertion does
// not. There is deliberately NO retries override on this describe: a
// dropped-edge regression must go red, not be absorbed.
//
// We also assert the [CLOCKED] badge becomes visible when an edge is
// patched into clock_in (UI hint that the hold behaviour is active).

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

/** Read the SHAPEGEN factory's regenCount via the engine read API. The
 *  counter increments exactly once per shape-list regeneration; held
 *  frames don't bump it. */
async function readRegenCount(page: Page, nodeId: string): Promise<number> {
  return await page.evaluate((nodeId) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain?: (d: string) => {
          read?: (n: string, k: string) => unknown;
        } | null;
      } | null;
    };
    const ve = w.__engine?.()?.getDomain?.('video');
    const v = ve?.read?.(nodeId, 'regenCount');
    return typeof v === 'number' ? v : Number.NaN;
  }, nodeId);
}

/** Poll until pred is satisfied or timeout. Mirrors scoreboard.spec.ts. */
async function waitForRegen(
  page: Page,
  nodeId: string,
  pred: (n: number) => boolean,
  timeout = 6000,
): Promise<{ ok: boolean; last: number }> {
  const deadline = Date.now() + timeout;
  let last = await readRegenCount(page, nodeId);
  if (pred(last)) return { ok: true, last };
  while (Date.now() < deadline) {
    await page.waitForTimeout(80);
    last = await readRegenCount(page, nodeId);
    if (pred(last)) return { ok: true, last };
  }
  return { ok: false, last };
}

/** Read the number of clock pulses the sequencer ACTUALLY PUT INTO THE SIGNAL.
 *
 *  This is deliberately NOT `totalAdvances` alone. `totalAdvances` counts steps
 *  the sequencer ADVANCED THROUGH, which is a strictly larger quantity than the
 *  pulses it emitted: the #229 catch-up guard (`sequencer.ts`) intentionally
 *  SKIPS `emitClockPulse` for any step whose scheduled time already fell into
 *  the past — "drop, don't pile up", so a stalled main thread resumes in-tempo
 *  instead of bunching a backlog into an audible double-hit — while still
 *  advancing `stepIndex` and `totalAdvances`. Those skipped pulses are counted
 *  in `lateStepsDropped`.
 *
 *  Comparing regen against raw `totalAdvances` therefore demands edges that were
 *  never in the audio graph at all, and goes red on a loaded runner even with a
 *  perfect bridge. That is exactly what happened on CI run 30279173414 (steps
 *  +11 / regen +7). `totalAdvances - lateStepsDropped` is the honest reference:
 *  every pulse that really existed must arrive. */
async function readEmittedPulses(page: Page, nodeId: string): Promise<number> {
  return await page.evaluate((nodeId) => {
    const w = globalThis as unknown as {
      __engine?: () => {
        getDomain?: (d: string) => { read?: (n: string, k: string) => unknown } | null;
      } | null;
    };
    const rd = (k: string): number => {
      const v = w.__engine?.()?.getDomain?.('audio')?.read?.(nodeId, k);
      return typeof v === 'number' ? v : Number.NaN;
    };
    return rd('totalAdvances') - rd('lateStepsDropped');
  }, nodeId);
}

test.describe('SHAPEGEN — CLOCK gate sample-and-hold', () => {
  test('rising edges regenerate; within-hold window holds; stopped clock freezes regen count', async ({ page, rack, errorWatch }) => {
    // ACIDWARP (time-varying) → SHAPEGEN.raster_a.
    // SEQUENCER → SHAPEGEN.clock_in.
    //
    // SEQUENCER at 30 BPM → 16th-note step = 60 / 30 / 4 = 500 ms clock
    // period (see header comment for why this is NOT 2 s — the clock-out
    // fires per step, which is a 16th note, not per beat). length 8 so
    // the clock keeps firing past the observation window. The 500 ms
    // period gives us a generous within-hold window where a SHORT
    // ANCHORED read (80 ms, starting immediately after a fresh regen) has
    // ~6× safety margin against straddling the next rising edge.
    await spawnPatch(
      page,
      [
        { id: 'src',  type: 'acidwarp', position: { x: 100, y: 100 }, domain: 'video',
          params: { speed: 1 } },
        { id: 'sg',   type: 'shapegen', position: { x: 500, y: 100 }, domain: 'video' },
        { id: 'clkSeq', type: 'sequencer', position: { x: 100, y: 320 }, domain: 'audio',
          params: { bpm: 30, length: 8, isPlaying: 1 } },
      ],
      [
        // Time-varying video source → SHAPEGEN.raster_a.
        { id: 'e_a',    from: { nodeId: 'src',   portId: 'out' },   to: { nodeId: 'sg', portId: 'raster_a' },
          sourceType: 'video',     targetType: 'video' },
        // SEQUENCER clock-out → SHAPEGEN.clock_in (gate→cv via CV bridge).
        { id: 'e_clk',  from: { nodeId: 'clkSeq', portId: 'clock' }, to: { nodeId: 'sg', portId: 'clock_in' },
          sourceType: 'gate',      targetType: 'cv' },
      ],
    );

    await expect(page.locator('[data-testid="shapegen-card"]')).toHaveCount(1);

    // The [CLOCKED] badge should show once the clock_in edge is wired.
    await expect(
      page.locator('[data-testid="shapegen-clocked-badge"]'),
      '[CLOCKED] badge appears when clock_in is patched',
    ).toBeVisible();

    // ---- 1. Wait for at least 2 regenerations (each rising edge fires
    //         exactly one + the first-draw regen seeds count to 1, so
    //         "≥ 3" means we've definitely seen at least 2 gate edges).
    //         At 30 BPM (500 ms step period) this needs ~1 s; the 15 s
    //         budget tolerates CI scheduler jitter + audio-context cold
    //         start (observed: 8 s budget starved on loaded runners).
    const advanced = await waitForRegen(page, 'sg', (n) => n >= 3, 15000);
    expect(
      advanced.ok,
      `regen advanced to ≥ 3 within 15 s (saw ${advanced.last})`,
    ).toBe(true);
    expect(
      advanced.last,
      `regen count plausible for a 30 BPM clock over ~few s (saw ${advanced.last})`,
    ).toBeLessThan(50);

    // ---- 0. THE DROPPED-EDGE CANARY (see header). Every clock pulse the
    //         sequencer emits must produce a regeneration. We compare the
    //         DELTAS of two independent engine counters over the same window:
    //         the sequencer's `totalAdvances` (pulses emitted by the audio
    //         graph) and SHAPEGEN's `regenCount` (pulses actually received
    //         through the cross-domain bridge).
    //
    //         Tolerance of 2 covers only ordering/boundary effects: a regen
    //         lands on the first video FRAME after its edge, so an edge near
    //         either end of the window can fall just outside it. It does NOT
    //         cover the bug — the pre-fix bridge dropped 60-80 % of edges under
    //         load (5 of 24), which blows past any small tolerance.
    const emitted0 = await readEmittedPulses(page, 'clkSeq');
    const regen0 = await readRegenCount(page, 'sg');
    await page.waitForTimeout(4000); // ~8 clock pulses at 30 BPM (500 ms period)
    const emitted1 = await readEmittedPulses(page, 'clkSeq');
    const regen1 = await readRegenCount(page, 'sg');
    const dEmitted = emitted1 - emitted0;
    const dRegen = regen1 - regen0;
    expect(
      dEmitted,
      `the sequencer actually emitted clock pulses in the window (emitted ${emitted0}→${emitted1})`,
    ).toBeGreaterThanOrEqual(4);
    expect(
      dRegen,
      `every EMITTED clock pulse regenerates: the cross-domain gate bridge must `
      + `not DROP edges (emitted +${dEmitted}, regen +${dRegen} — a big shortfall `
      + `means the bridge is back to sampling instead of counting in the audio `
      + `thread; see the header)`,
    ).toBeGreaterThanOrEqual(dEmitted - 2);

    // ---- 2. Within-hold window: ANCHOR to a fresh regen so we KNOW we
    //         are at the start of a hold period (not somewhere random in
    //         the middle, where a 120 ms wait could straddle the next
    //         rising edge — that was the chronic shard-7 flake). Steps:
    //
    //           a. snapshot current count
    //           b. poll fast (15 ms cadence) for up to 1.5 s until count
    //              advances by ≥1 → we just observed an edge
    //           c. IMMEDIATELY re-snapshot (this is our anchor: t=0 of a
    //              fresh 500 ms-period window)
    //           d. wait 80 ms — only 16 % of the 500 ms period → ≥6×
    //              safety margin against straddling the next edge even
    //              with CI timer jitter
    //           e. assert the count is unchanged
    //
    //         This is ROBUST to all of: scheduler-clock jitter, the
    //         audio-context warm-up delay, CI runner load, and the
    //         60-BPM-but-actually-250-ms-period gotcha that originally
    //         flaked this test (see header comment).
    // IN-PAGE anchor + hold (ONE evaluate, zero runner round-trips): the
    // prior loop polled from the RUNNER every 15 ms — under shard
    // contention a single stalled round-trip meant the edge we "just"
    // observed had actually fired hundreds of ms earlier, so the 80 ms
    // hold window started deep into the 500 ms period and straddled the
    // NEXT edge (the shard-reshuffle failure: a=4, b=5, 3/3 retries).
    // Anchoring inside the page's own event loop is tick-accurate BY
    // CONSTRUCTION: the regen counter advances via main-thread edge
    // detection on this same loop, so if the page stalls the detector
    // stalls with it and the anchor→hold relative phase is preserved.
    // Anchor budget stays 10 s = 20× the 500 ms period (only a real
    // "regen stopped" regression can exhaust it).
    const hold = await page.evaluate(async (nodeId) => {
      const w = globalThis as unknown as {
        __engine?: () => {
          getDomain?: (d: string) => { read?: (n: string, k: string) => unknown } | null;
        } | null;
      };
      const read = (): number => {
        const v = w.__engine?.()?.getDomain?.('video')?.read?.(nodeId, 'regenCount');
        return typeof v === 'number' ? v : -1;
      };
      const t0 = performance.now();
      const start = read();
      let anchoredAt = -1;
      let a = start;
      while (performance.now() - t0 < 10_000) {
        await new Promise((r) => setTimeout(r, 5));
        const n = read();
        if (n > start) { a = n; anchoredAt = performance.now(); break; }
      }
      if (anchoredAt < 0) return { ok: false as const, start, a, b: -1, holdMs: -1 };
      // Hold 80 ms on THIS clock (16 % of the 500 ms period).
      while (performance.now() - anchoredAt < 80) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return { ok: true as const, start, a, b: read(), holdMs: performance.now() - anchoredAt };
    }, 'sg');
    expect(
      hold.ok,
      `observed a fresh regen edge to anchor the hold window (start=${hold.start}, budget=10s, period=500ms)`,
    ).toBe(true);
    expect(
      hold.b,
      `80 ms in-page anchored hold window has no regen (a=${hold.a}, b=${hold.b}, holdMs=${Math.round(hold.holdMs)}, period=500ms)`,
    ).toBe(hold.a);

    // ---- 3. STOP the sequencer → no more rising edges. After draining
    //         any in-flight edge (give it 2 s — 4× one 500 ms period),
    //         the regen count should stay constant across multiple
    //         seconds even though the SOURCE RASTER keeps animating.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const seq = w.__patch.nodes['clkSeq'];
        if (seq) seq.params.isPlaying = 0;
      });
    });
    // Let any pending edge land + the next "would-be" pulse window pass.
    await page.waitForTimeout(2000);
    const stopped1 = await readRegenCount(page, 'sg');
    await page.waitForTimeout(1500);
    const stopped2 = await readRegenCount(page, 'sg');
    await page.waitForTimeout(1500);
    const stopped3 = await readRegenCount(page, 'sg');
    expect(
      stopped2,
      `stopped clock holds regen count (s1=${stopped1}, s2=${stopped2}, s3=${stopped3})`,
    ).toBe(stopped1);
    expect(stopped3, `still held after another 1.5 s`).toBe(stopped1);

  });
});
