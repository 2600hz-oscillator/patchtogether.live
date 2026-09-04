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
// ⚠ EVERY assertion here is anchored on the CONTEXT clock (the worklet's own
// `renderedS`, snapshotted in the same health message as its counters), NEVER
// on wall time. The first version compared `pulses` to wall-elapsed × rate and
// CI shard 11 failed it in BOTH directions on back-to-back attempts — 71
// where wall said ≤69.3 (headless Chromium's null audio sink rendered AHEAD
// of wall time: 71 pulses ≈ 1.46 s of audio in 1.32 wall-seconds, no hardware
// buffer to pace it), then 56 where wall said ~99.3 (the render thread LAGGED
// a contended shard). Neither reading was a wrong pulse: per CONTEXT time the
// emitted count is bounded by the grid BY CONSTRUCTION (cv-clock-core.ts —
// one emission per grid crossing, welded by its unit suite), so a wall-clock
// window can read high only by under-measuring the audio it covers. Against
// `renderedS` the count is exact within ±1, and that is what is asserted.
//
// So this spec asserts, in order:
//   1. the worklet DRIVER is active (read('clockHealth').driver === 'worklet')
//      — i.e. the dist bundle loaded and the processor constructed;
//   2. the processor is EMITTING: its self-reported cumulative pulse counter
//      rises past a second's worth of pulses;
//   3. ⚠ THE FIX: an ~800 ms main-thread busy-block (the SPEEDERR stall, made
//      worse) costs nothing on the context clock — pulsesΔ == renderedSΔ×rate
//      (±1) across the block, and the GAP LAW holds at sample resolution over
//      the whole run: no inter-pulse gap above one period + ε (no hole =
//      nothing dropped) and none below one period − ε (no bunching, the burst
//      #2324 forbids) — both measured IN CONTEXT TIME at the emitting sample;
//   4. the SHADOW main-thread scheduler's `skips` counter RISES over the same
//      block — the in-vivo positive control that the stall was real and the
//      old path WOULD have dropped (~29 pulses at this tempo under 800 ms).
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
const PERIOD_S = 1 / RATE; // ≈ 20.83 ms
/** Gap-law tolerance: emission is quantized to the context sample grid
 *  (±1 sample ≈ 23 µs at 44.1/48 kHz) — 1 ms is generous headroom and still
 *  20× smaller than the one-period hole a single dropped pulse would open. */
const GAP_EPS_S = 0.001;

interface ClockHealth {
  driver: 'worklet' | 'main';
  skips: number;
  workletPulses: number;
  workletSkips: number;
  workletRenderedS: number;
  workletMinGapS: number | null;
  workletMaxGapS: number | null;
}

/** One atomic engine read from the page. `workletPulses`/`workletRenderedS`
 *  arrive in the SAME worklet health message, so each snapshot is internally
 *  consistent on the context clock; `atMs` (wall) rides along for diagnostics
 *  only and is load-bearing for nothing. */
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

test('cv-buddy clock: worklet-driven, emitting, and immune to an 800ms main-thread stall', async ({
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

  // 3. THE STALL. Snapshot, wedge the main thread ~800 ms, poll until the
  //    audio-thread counters have visibly moved past the block, snapshot again.
  const before = await readHealth(page);

  await page.evaluate(() => {
    const until = performance.now() + 800;
    // A hot loop, not a timer: nothing on the main thread runs — no scheduler
    // dispatch, no worklet config messages — exactly the incident's shape.
    while (performance.now() < until) {
      /* wedge */
    }
  });

  await expect
    .poll(async () => (await readHealth(page)).workletPulses, { timeout: 15_000 })
    .toBeGreaterThan(before.workletPulses + RATE);

  const after = await readHealth(page);

  // ZERO dropped pulses, judged on the clock the pulses live on: across the
  // block, emitted == context-seconds-rendered × rate, exact within ±1 (the
  // half-open window boundary; 1.5 dodges float). Wall time appears in the
  // message purely so a future failure names both clocks.
  const emitted = after.workletPulses - before.workletPulses;
  const renderedDelta = after.workletRenderedS - before.workletRenderedS;
  const wallDelta = (after.atMs - before.atMs) / 1000;
  expect(renderedDelta, 'the audio context must have rendered across the block').toBeGreaterThan(1);
  expect(
    Math.abs(emitted - renderedDelta * RATE),
    `emitted ${emitted} vs context-clock expected ${(renderedDelta * RATE).toFixed(2)} ` +
      `(renderedΔ ${renderedDelta.toFixed(3)}s, wallΔ ${wallDelta.toFixed(3)}s — a divergence ` +
      'between those two deltas is the shard-contention effect and is NOT a clock fault)',
  ).toBeLessThanOrEqual(1.5);

  // THE GAP LAW, in context time at sample resolution, over the WHOLE run
  // including the stall: no hole (nothing dropped) and no bunching (never two
  // closer than one period — the #2324 invariant, measured at the source).
  expect(after.workletMinGapS, 'gap extremes must exist after >1s of pulses').not.toBeNull();
  expect(after.workletMinGapS!, 'bunching: two pulses closer than one period')
    .toBeGreaterThanOrEqual(PERIOD_S - GAP_EPS_S);
  expect(after.workletMaxGapS!, 'a hole: an inter-pulse gap above one period = a dropped pulse')
    .toBeLessThanOrEqual(PERIOD_S + GAP_EPS_S);

  // The audio-thread clock itself dropped-and-counted nothing either.
  expect(after.workletSkips).toBe(0);

  // 4. POSITIVE CONTROL, in vivo: the SHADOW main-thread scheduler measured
  //    the same stall as late — proof the wedge really starved the old path
  //    (and therefore that the zero-loss above was the worklet's doing, not a
  //    stall that never happened). The wedge only has to make the CONTEXT
  //    clock advance past the 200 ms lookahead while ticks cannot dispatch;
  //    800 ms of wall wedge leaves 4× headroom even for a render thread
  //    crawling at quarter speed on a contended shard.
  expect(
    after.skips,
    'the main-thread shadow scheduler must have registered the stall',
  ).toBeGreaterThan(before.skips);
});

test('the LATE lamp paints DARK through a main-thread stall — the #2343 VRT flake, welded shut', async ({
  page,
}) => {
  // vrt-strict shard 10 captured `face-cvBuddy-dock` with LATE lit because
  // THAT boot stalled >200 ms while the shadow scheduler ran: the lamp was
  // painting the runner's load average. The fix routes the painted state
  // through `cvBuddyLateLampLit` — real jack losses only — so a resting face
  // is identical whatever the boot timing. This leg re-runs the failure's
  // mechanism on purpose: wedge the main thread, PROVE the stall registered
  // (shadow skips rose — without that this test is vacuous on a fast machine),
  // then read the pixel-driving attribute the VRT scene captures.
  await page.goto('/rack');
  await spawnPatch(page, [
    { id: CVB, type: 'cvBuddy', domain: 'audio', position: { x: 480, y: 80 }, params: { ppqn: PPQN, clockOffsetMs: 0 } },
  ]);
  // No timelorde: the transport free-runs — the exact VRT-scene condition.
  await expect
    .poll(async () => (await readHealth(page)).driver, { timeout: 15_000 })
    .toBe('worklet');

  // Open the dock so the status body (and its lamp) is mounted and polling —
  // the same locator discipline cv-buddy-face.spec.ts uses.
  const shell = page.locator(`.svelte-flow__node[data-id="${CVB}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const dock = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${CVB}"]`);
  await expect(dock).toBeVisible();
  const late = dock.getByTestId(`cv-buddy-led-late-${CVB}`);
  await expect(late).toBeVisible();
  await expect(late).toHaveAttribute('data-lit', '0');

  const before = await readHealth(page);
  await page.evaluate(() => {
    const until = performance.now() + 600;
    while (performance.now() < until) {
      /* wedge — the shard-10 boot, reproduced deliberately */
    }
  });
  // The stall REGISTERED on the shadow scheduler (positive control)…
  await expect
    .poll(async () => (await readHealth(page)).skips, { timeout: 15_000 })
    .toBeGreaterThan(before.skips);
  // …and the lamp's next poll cycles have run (the body polls at 1 Hz; wait on
  // observable pulses, not wall time, for two poll periods' worth of clock).
  await expect
    .poll(async () => (await readHealth(page)).workletPulses, { timeout: 15_000 })
    .toBeGreaterThan(before.workletPulses + 2 * RATE);

  // The painted state never moved: absorbed stalls do not light a warn lamp.
  await expect(late).toHaveAttribute('data-lit', '0');
  const health = await readHealth(page);
  expect(health.workletSkips, 'no real loss occurred either').toBe(0);
});
