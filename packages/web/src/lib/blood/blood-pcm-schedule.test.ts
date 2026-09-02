// packages/web/src/lib/blood/blood-pcm-schedule.test.ts
//
// The arithmetic that decides how much audio BLOOD's main-thread pump owes the
// blood-pcm worklet on each tick. The bug this replaced was a CONSTANT (735
// frames, i.e. 44100/60) spent against a 48 kHz drain at a cadence the pump does
// not control, so the tests that matter are the ones that vary the cadence and
// the rate — exactly the two things the constant could not see.

import { describe, it, expect } from 'vitest';
import {
  makePcmPumpState,
  planPcmPump,
  MIN_CUSHION_S,
  MAX_CUSHION_S,
  MAX_PER_TICK_S,
  CUSHION_HEADROOM,
  type PcmPumpState,
} from './blood-pcm-schedule';

const RATE = 48_000;

/** Run `ticks` ticks spaced `gapS` apart, returning frames produced per second
 *  of context time and the ring depth after each tick. */
function runPump(gapS: number, ticks: number, rate = RATE) {
  let state: PcmPumpState = makePcmPumpState();
  let now = 0;
  let total = 0;
  const depths: number[] = [];
  for (let i = 0; i < ticks; i++) {
    const plan = planPcmPump(state, now, rate);
    total += plan.frames;
    state = plan.next;
    // Ring depth the instant BEFORE the next tick, i.e. after draining the gap.
    depths.push(state.delivered - (now + gapS - state.anchor) * rate);
    now += gapS;
  }
  return { producedPerSec: total / Math.max(gapS, now), depths, state, elapsed: now };
}

describe('blood PCM pump scheduling', () => {
  it('produces at the CONTEXT rate, not 44100/60, at a healthy cadence', () => {
    // The measured healthy cadence: 24.8 ms per tick on an idle 10-core box.
    const { producedPerSec } = runPump(0.0248, 400);
    // The old pump produced 735/0.0248 = 29 637/s here — 62 % of demand.
    expect(producedPerSec).toBeGreaterThan(RATE * 0.98);
    expect(producedPerSec).toBeLessThan(RATE * 1.02);
  });

  it('tracks a 44.1 kHz context just as exactly — the rate is an input, not a constant', () => {
    const { producedPerSec } = runPump(0.0248, 400, 44_100);
    expect(producedPerSec).toBeGreaterThan(44_100 * 0.98);
    expect(producedPerSec).toBeLessThan(44_100 * 1.02);
  });

  it('never lets the ring run dry at the healthy cadence', () => {
    const { depths } = runPump(0.0248, 400);
    // Skip the first tick (the ring is primed from empty).
    expect(Math.min(...depths.slice(1))).toBeGreaterThan(0);
  });

  it('⚠ THE REGRESSION: a 900 ms starved cadence still keeps the ring fed', () => {
    // This is the forced case that reproduced CI's total silence with the old
    // pump: 735 frames per 924 ms tick = 795 frames/s against 48 000 drained,
    // 1.7 % of demand, and the SCOPE read 0.0000 on every sample.
    //
    // The ring is dry for exactly ONE tick — the first, which primes it to the
    // 80 ms floor before any stall has been observed — and is fed from then on,
    // because the cushion has by then grown to cover the gap it just saw.
    const { producedPerSec, depths } = runPump(0.9245, 40);
    expect(producedPerSec).toBeGreaterThan(RATE * 0.9);
    expect(Math.min(...depths.slice(1))).toBeGreaterThan(0);
  });

  it('an underrun re-anchors instead of banking a debt that would become latency', () => {
    let state = makePcmPumpState();
    state = planPcmPump(state, 0, RATE).next; // primes 80 ms
    // 900 ms later the ring has long since run dry.
    const plan = planPcmPump(state, 0.9, RATE);
    expect(plan.underran).toBe(true);
    // It asks for the cushion, NOT the cushion plus the ~820 ms it "missed".
    expect(plan.frames).toBeCloseTo(plan.next.cushion, 0);
    expect(plan.frames).toBeLessThanOrEqual(Math.ceil(MAX_CUSHION_S * RATE));
    expect(plan.next.anchor).toBe(0.9);
  });

  it('the cushion covers the observed gap and decays back to the floor', () => {
    let state = makePcmPumpState();
    let now = 0;
    // Healthy for a while → the cushion sits at the floor.
    for (let i = 0; i < 50; i++) { state = planPcmPump(state, now, RATE).next; now += 0.02; }
    expect(state.cushion).toBeCloseTo(MIN_CUSHION_S * RATE, 0);

    // One stall → the cushion grows to cover the gap SINCE THE LAST TICK with
    // headroom. The loop above left `now` one healthy tick past the last tick, so
    // the gap this tick observes is 0.02 + 0.4 = 0.42 s; at 1.75x that is 0.735 s,
    // still under the 1 s cap, so this measures the growth rule and not the cap.
    const stallGap = 0.02 + 0.4;
    now += 0.4;
    state = planPcmPump(state, now, RATE).next;
    expect(state.cushion).toBeCloseTo(stallGap * RATE * CUSHION_HEADROOM, 0);
    expect(state.cushion).toBeLessThan(MAX_CUSHION_S * RATE);

    // Then it decays back toward the floor rather than pinning latency high.
    for (let i = 0; i < 2000; i++) { state = planPcmPump(state, now, RATE).next; now += 0.02; }
    expect(state.cushion).toBeCloseTo(MIN_CUSHION_S * RATE, 0);
  });

  it('bounds the cushion and one tick s production', () => {
    let state = makePcmPumpState();
    state = planPcmPump(state, 0, RATE).next;
    // A 10 s stall: the cushion is capped and the tick cannot mix unbounded audio.
    const plan = planPcmPump(state, 10, RATE);
    expect(plan.next.cushion).toBeLessThanOrEqual(MAX_CUSHION_S * RATE);
    expect(plan.frames).toBeLessThanOrEqual(Math.ceil(MAX_PER_TICK_S * RATE));
  });

  it('a multi-second stall re-primes the cushion, not the missed minutes', () => {
    let state = makePcmPumpState();
    state = planPcmPump(state, 0, RATE).next;
    const plan = planPcmPump(state, 30, RATE); // tab backgrounded for 30 s
    expect(plan.underran).toBe(true);
    expect(plan.next.anchor).toBe(30);
    // Capped cushion, not 30 s of stale game audio.
    expect(plan.frames).toBeCloseTo(MAX_CUSHION_S * RATE, 0);
  });

  it('asks for nothing when the ring is already stocked', () => {
    let state = makePcmPumpState();
    state = planPcmPump(state, 0, RATE).next;
    // A tick that arrives with no context time elapsed owes nothing.
    expect(planPcmPump(state, 0, RATE).frames).toBe(0);
  });

  it('primes the ring on the first tick so playback does not start empty', () => {
    const plan = planPcmPump(makePcmPumpState(), 12.34, RATE);
    expect(plan.frames).toBe(Math.ceil(MIN_CUSHION_S * RATE));
    expect(plan.next.anchor).toBe(12.34);
  });

  it('NEGATIVE CONTROL: the OLD fixed-735 rule fails the same healthy check', () => {
    // Pinning what the replaced code did, so this file states the defect rather
    // than only the repair: 735 frames per 24.8 ms tick is 62 % of a 48 kHz
    // drain, and at the forced 924 ms cadence it is 1.7 %.
    expect((735 / 0.0248) / RATE).toBeCloseTo(0.617, 2);
    expect((735 / 0.9245) / RATE).toBeCloseTo(0.0166, 3);
  });
});
