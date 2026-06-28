// packages/dsp/src/lib/moog911-eg-dsp.test.ts
//
// Pure-DSP unit tests for the MOOG 911 contour-generator core — the SHIPPED
// envelope math (the moog911 worklet wires audio I/O straight to Moog911Eg).
// Pins the three-time-constant contour so a refactor surfaces as a specific
// quantitative regression:
//   • egCoeff — near-zero time snaps (→1); longer time → smaller per-sample step.
//   • ATTACK rises 0 → 1 within ~T1 then hands off to DECAY.
//   • DECAY falls 1 → Esus within ~T2 then holds at SUSTAIN.
//   • SUSTAIN tracks Esus (knob/CV moves under it).
//   • RELEASE (gate low) falls current → 0 within ~T3.
//   • trigger-close mid-attack forces T3 from the CURRENT level (not the peak).
//   • Esus clamps to 0..1; env_inv = 1 − env; no NaN/blowup.

import { describe, it, expect } from 'vitest';
import {
  Moog911Eg,
  egCoeff,
  MOOG911_STAGE,
  MIN_TIME_S,
} from './moog911-eg-dsp';

const SR = 48000;

/** Run `n` samples at a fixed gate + params, return the level trace. */
function run(eg: Moog911Eg, gate: boolean, n: number, t1: number, t2: number, esus: number, t3: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(eg.step(gate, t1, t2, esus, t3));
  return out;
}

describe('egCoeff', () => {
  it('snaps instantly (→1) at/below MIN_TIME_S', () => {
    expect(egCoeff(0, SR)).toBe(1);
    expect(egCoeff(MIN_TIME_S, SR)).toBe(1);
    expect(egCoeff(-1, SR)).toBe(1);
  });
  it('is in (0,1) for a real time + shrinks as the time grows', () => {
    const fast = egCoeff(0.005, SR);
    const slow = egCoeff(0.5, SR);
    expect(fast).toBeGreaterThan(0);
    expect(fast).toBeLessThan(1);
    expect(slow).toBeGreaterThan(0);
    expect(slow).toBeLessThan(fast); // longer time = gentler per-sample approach
  });
});

describe('Moog911Eg contour', () => {
  const t1 = 0.005, t2 = 0.05, esus = 0.5, t3 = 0.08;

  it('ATTACK rises 0 → 1.0 within ~T1 and is monotonic', () => {
    const eg = new Moog911Eg(SR);
    // Capture ONLY the attack phase: step until it hands off to DECAY (cap guards
    // against a stuck rise). The last sample is the peak snap (1.0).
    const trace: number[] = [];
    let guard = 0;
    const cap = Math.ceil(5 * t1 * SR);
    do {
      trace.push(eg.step(true, t1, t2, esus, t3));
    } while (eg.stage === MOOG911_STAGE.ATTACK && ++guard < cap);
    // monotonic non-decreasing during the rise
    for (let i = 1; i < trace.length; i++) expect(trace[i]).toBeGreaterThanOrEqual(trace[i - 1] - 1e-9);
    expect(trace[trace.length - 1]).toBe(1.0); // reached the peak (snap at >=0.999)
    expect(trace[0]).toBeLessThan(0.2); // genuinely started near 0
    expect(trace.length).toBeLessThan(3 * t1 * SR); // reached peak within ~T1 (generous)
  });

  it('DECAY falls 1 → Esus within ~T2 then SUSTAIN holds exactly at Esus', () => {
    const eg = new Moog911Eg(SR);
    // attack to peak + decay + a little sustain
    run(eg, true, Math.ceil((3 * t1 + 4 * t2) * SR), t1, t2, esus, t3);
    expect(eg.stage).toBe(MOOG911_STAGE.SUSTAIN);
    expect(eg.level).toBeCloseTo(esus, 3);
    // hold: more gated samples keep it pinned at Esus
    const held = run(eg, true, 500, t1, t2, esus, t3);
    for (const v of held) expect(v).toBeCloseTo(esus, 6);
  });

  it('SUSTAIN tracks a moving Esus', () => {
    const eg = new Moog911Eg(SR);
    run(eg, true, Math.ceil((3 * t1 + 4 * t2) * SR), t1, t2, esus, t3);
    expect(eg.stage).toBe(MOOG911_STAGE.SUSTAIN);
    const v = eg.step(true, t1, t2, 0.3, t3); // Esus moved to 0.3
    expect(v).toBeCloseTo(0.3, 6);
  });

  it('RELEASE (gate low) falls current → 0 within ~T3 and lands at IDLE', () => {
    const eg = new Moog911Eg(SR);
    run(eg, true, Math.ceil((3 * t1 + 4 * t2) * SR), t1, t2, esus, t3); // to sustain
    const rel = run(eg, false, Math.ceil(4 * t3 * SR), t1, t2, esus, t3);
    for (let i = 1; i < rel.length; i++) expect(rel[i]).toBeLessThanOrEqual(rel[i - 1] + 1e-9); // non-increasing
    expect(eg.level).toBe(0);
    expect(eg.stage).toBe(MOOG911_STAGE.IDLE);
  });

  it('trigger-close MID-ATTACK forces T3 decay from the CURRENT level (not the peak)', () => {
    const eg = new Moog911Eg(SR);
    // a few attack samples — still rising, below the peak
    run(eg, true, 40, t1, t2, esus, t3);
    const mid = eg.level;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1.0);
    // gate drops → RELEASE from `mid`, never having reached the peak
    eg.step(false, t1, t2, esus, t3);
    expect(eg.stage).toBe(MOOG911_STAGE.RELEASE);
    const rel = run(eg, false, Math.ceil(4 * t3 * SR), t1, t2, esus, t3);
    expect(Math.max(...rel)).toBeLessThanOrEqual(mid + 1e-6); // never rose past where it was
    expect(eg.level).toBe(0);
  });

  it('clamps Esus to 0..1', () => {
    const lo = new Moog911Eg(SR);
    run(lo, true, Math.ceil((3 * t1 + 6 * t2) * SR), t1, t2, -5, t3);
    expect(lo.level).toBeGreaterThanOrEqual(0);
    const hi = new Moog911Eg(SR);
    run(hi, true, Math.ceil((3 * t1) * SR), t1, t2, 9, t3);
    expect(hi.level).toBeLessThanOrEqual(1.0 + 1e-9);
  });

  it('never produces NaN/Inf across a full gate cycle + audio-rate stress', () => {
    const eg = new Moog911Eg(SR);
    const all = [
      ...run(eg, true, 5000, t1, t2, esus, t3),
      ...run(eg, false, 5000, t1, t2, esus, t3),
      ...run(eg, true, 200, MIN_TIME_S, MIN_TIME_S, 0.5, MIN_TIME_S), // near-instant times
    ];
    for (const v of all) expect(Number.isFinite(v)).toBe(true);
  });
});
