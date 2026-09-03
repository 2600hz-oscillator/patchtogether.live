// e2e/tests/cv-buddy-clock-worklet.spec.ts
//
// THE REAL-BROWSER LEG of the cv-clock worklet wiring (the SPEEDERR-001
// dropped-pulse fix). The unit suites prove the core and the wiring against
// fakes; only a browser has the actual AudioWorklet machinery — addModule of
// the dist bundle, the 'cv-clock' processor registration, port transport, and
// an audio thread that really is independent of the main thread. A regression
// in any of those is GREEN-AND-SILENT to every unit lane (the #969 lesson:
// engine-direct tests have shipped modules that were green and silent).
//
// So this spec asserts, in order:
//   1. the worklet DRIVER is active (read('clockHealth').driver === 'worklet')
//      — i.e. the dist bundle loaded and the processor constructed;
//   2. the processor is EMITTING: its self-reported cumulative pulse counter
//      rises at the configured PPQN×BPM rate (the "clock is actually running"
//      signal, reported from the audio thread itself);
//   3. ⚠ THE FIX: a ~600 ms main-thread busy-block (the SPEEDERR stall, made
//      worse) does not cost a single pulse — while the SHADOW main-thread
//      scheduler's `skips` counter RISES over the same block, which is the
//      in-vivo positive control that the stall was real and the old path
//      WOULD have dropped (~19 pulses at this tempo).
//
// No WebGL, no canvas reads — default e2e lane. All waits are expect.poll on
// observable engine state; the only fixed duration is the busy-block itself,
// which IS the stimulus, not a readiness wait.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';

const CVB = 'cvb-1';
const BPM = 120;
const PPQN = 24;
const RATE = (BPM * PPQN) / 60; // 48 pulses/s

interface ClockHealth {
  driver: 'worklet' | 'main';
  skips: number;
  workletPulses: number;
  workletSkips: number;
}

/** One atomic engine read from the page: health + a wall-clock stamp. */
async function readHealth(page: Page): Promise<ClockHealth & { atMs: number }> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (node: unknown, key: string) => unknown };
      __patch: { nodes: Record<string, unknown> };
    };
    const node = w.__patch.nodes[id];
    const h = w.__engine!().read(node, 'clockHealth') as ClockHealth;
    return { ...h, atMs: performance.now() };
  }, CVB);
}

test('cv-buddy clock: worklet-driven, emitting, and immune to a 600ms main-thread stall', async ({
  page,
}) => {
  await page.goto('/rack');
  await spawnPatch(page, [
    { id: 'tl-1', type: 'timelorde', domain: 'audio', position: { x: 80, y: 80 }, params: { bpm: BPM, running: 1 } },
    { id: CVB, type: 'cvBuddy', domain: 'audio', position: { x: 480, y: 80 }, params: { ppqn: PPQN, clockOffsetMs: 0 } },
  ]);

  // 1. The worklet driver owns the jacks — the dist bundle loaded and the
  //    'cv-clock' processor constructed in THIS browser.
  await expect
    .poll(async () => (await readHealth(page)).driver, { timeout: 15_000 })
    .toBe('worklet');

  // 2. The processor is emitting: its audio-thread counter rises past a full
  //    second of pulses. (Poll on state — no fixed sleep.)
  await expect
    .poll(async () => (await readHealth(page)).workletPulses, { timeout: 15_000 })
    .toBeGreaterThan(RATE);

  // 3. THE STALL. Sample, wedge the main thread ~600 ms, let the counter
  //    settle past the block, sample again.
  const before = await readHealth(page);

  await page.evaluate(() => {
    const until = performance.now() + 600;
    // A hot loop, not a timer: nothing on the main thread runs — no scheduler
    // dispatch, no worklet config messages — exactly the incident's shape.
    while (performance.now() < until) {
      /* wedge */
    }
  });

  // Wait (on observable state) until the audio-thread counter has visibly
  // moved past the block, so the second sample is not taken inside the
  // health-message latency window.
  await expect
    .poll(async () => (await readHealth(page)).workletPulses, { timeout: 15_000 })
    .toBeGreaterThan(before.workletPulses + RATE);

  const after = await readHealth(page);

  // ZERO dropped pulses: the emitted count matches wall-clock elapsed × rate.
  // Slack budget: health posts are throttled to ~50 ms + main-thread delivery
  // on each endpoint (±~5 pulses worst case combined) and the audio clock can
  // drift ~0.1% from performance.now(). The OLD path loses
  // (600−200 ms lookahead)/20.8 ms ≈ 19 pulses under this block — an order of
  // magnitude outside the slack, so the assertion separates the two cleanly.
  const elapsedS = (after.atMs - before.atMs) / 1000;
  const emitted = after.workletPulses - before.workletPulses;
  const expected = elapsedS * RATE;
  expect(
    Math.abs(emitted - expected),
    `emitted ${emitted} vs expected ~${expected.toFixed(1)} over ${elapsedS.toFixed(2)}s`,
  ).toBeLessThanOrEqual(6);

  // The audio-thread clock itself dropped nothing.
  expect(after.workletSkips).toBe(0);

  // POSITIVE CONTROL, in vivo: the SHADOW main-thread scheduler measured the
  // same stall as late — proof the wedge really starved the old path (and
  // therefore that the zero-loss above was the worklet's doing, not a stall
  // that never happened).
  expect(
    after.skips,
    'the main-thread shadow scheduler must have registered the stall',
  ).toBeGreaterThan(before.skips);
});
