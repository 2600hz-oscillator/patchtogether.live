// packages/web/src/lib/audio/modules/buggles.test.ts
//
// Unit tests for BUGGLES: module-def shape + pure helpers
// (rate mapping, stepped walk, period jitter, burst probability).
// Live AudioContext behavior is covered by the ART scenario.

import { describe, expect, it } from 'vitest';
import { bugglesMath, bugglesPrng } from './buggles';

describe('bugglesMath: rate knob → Hz', () => {
  it('knob=0 → 0.1 Hz (lowest rate)', () => {
    expect(bugglesMath.rateKnobToHz(0)).toBeCloseTo(0.1, 6);
  });

  it('knob=1 → 50 Hz (highest rate)', () => {
    expect(bugglesMath.rateKnobToHz(1)).toBeCloseTo(50, 6);
  });

  it('knob=0.5 sits at the log midpoint (≈ sqrt(0.1 × 50) = 2.236 Hz)', () => {
    expect(bugglesMath.rateKnobToHz(0.5)).toBeCloseTo(Math.sqrt(0.1 * 50), 4);
  });

  it('clamps out-of-range inputs', () => {
    expect(bugglesMath.rateKnobToHz(-0.5)).toBeCloseTo(0.1, 6);
    expect(bugglesMath.rateKnobToHz(1.5)).toBeCloseTo(50, 6);
  });
});

describe('bugglesMath: nextStepped (chaos-controlled walk)', () => {
  // Deterministic PRNG so the walk is reproducible.
  const makeRand = () => bugglesPrng(123);

  it('chaos=0 produces a small perturbation of previous (correlated walk)', () => {
    const rand = makeRand();
    let prev = 0.5;
    let maxStep = 0;
    for (let i = 0; i < 200; i++) {
      const next = bugglesMath.nextStepped(prev, 0, rand);
      const step = Math.abs(next - prev);
      if (step > maxStep) maxStep = step;
      prev = next;
    }
    // walk = prev + 0.2 * fresh; fresh ∈ [-1, +1]; max step ≤ 0.2.
    expect(maxStep, `max step (chaos=0) = ${maxStep}`).toBeLessThan(0.21);
  });

  it('chaos=1 produces large jumps (independent uniform pulls)', () => {
    const rand = makeRand();
    let prev = 0;
    let bigJumps = 0;
    for (let i = 0; i < 200; i++) {
      const next = bugglesMath.nextStepped(prev, 1, rand);
      if (Math.abs(next - prev) > 0.5) bigJumps++;
      prev = next;
    }
    // With independent uniform pulls in [-1, +1], expect roughly 50%
    // of consecutive pairs to differ by more than 0.5.
    expect(bigJumps, `chaos=1 big jumps = ${bigJumps}/200`).toBeGreaterThan(50);
  });

  it('output stays within [-1, +1]', () => {
    const rand = makeRand();
    let prev = 0;
    for (let i = 0; i < 1000; i++) {
      prev = bugglesMath.nextStepped(prev, 0.5, rand);
      expect(prev).toBeGreaterThanOrEqual(-1);
      expect(prev).toBeLessThanOrEqual(1);
    }
  });
});

describe('bugglesMath: nextPeriodS (chaos-controlled jitter)', () => {
  it('chaos=0 gives exact 1/rate period', () => {
    const rand = bugglesPrng(7);
    for (let i = 0; i < 10; i++) {
      const p = bugglesMath.nextPeriodS(2, 0, rand);
      expect(p).toBeCloseTo(0.5, 6);
    }
  });

  it('chaos=1 jitters within ±50% of base period', () => {
    const rand = bugglesPrng(7);
    let minP = Infinity, maxP = -Infinity;
    for (let i = 0; i < 200; i++) {
      const p = bugglesMath.nextPeriodS(2, 1, rand);
      if (p < minP) minP = p;
      if (p > maxP) maxP = p;
    }
    // Base = 0.5s; jitter ±50% → range [0.25, 0.75].
    expect(minP).toBeGreaterThanOrEqual(0.25);
    expect(maxP).toBeLessThanOrEqual(0.75);
    // Sanity: with 200 samples we should see a wide spread.
    expect(maxP - minP, `period range = ${(maxP - minP).toFixed(3)}`).toBeGreaterThan(0.2);
  });
});

describe('bugglesMath: rollBurst', () => {
  it('probability=0 never fires', () => {
    const rand = bugglesPrng(3);
    for (let i = 0; i < 100; i++) {
      expect(bugglesMath.rollBurst(0, rand)).toBe(0);
    }
  });

  it('probability=1 always fires (burst length 3..7)', () => {
    const rand = bugglesPrng(3);
    for (let i = 0; i < 100; i++) {
      const len = bugglesMath.rollBurst(1, rand);
      expect(len).toBeGreaterThanOrEqual(3);
      expect(len).toBeLessThanOrEqual(7);
    }
  });

  it('probability=0.5 fires roughly half the time', () => {
    const rand = bugglesPrng(11);
    let fired = 0;
    for (let i = 0; i < 1000; i++) {
      if (bugglesMath.rollBurst(0.5, rand) > 0) fired++;
    }
    // Wide tolerance — PRNG variance at 1000 trials.
    expect(fired, `fired ${fired}/1000 at p=0.5`).toBeGreaterThan(420);
    expect(fired, `fired ${fired}/1000 at p=0.5`).toBeLessThan(580);
  });
});
