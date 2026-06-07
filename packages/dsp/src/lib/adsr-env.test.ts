// packages/dsp/src/lib/adsr-env.test.ts
//
// Unit tests for the shared ADSR Envelope (per-voice-ADSR feature). Pins:
//   1. The state machine: attack reaches 1, decay→sustain, release→0→Idle.
//   2. SOFT-retrigger regression: triggerSoft(true) mid-release produces no
//      sample-to-sample discontinuity, AND the attack RATE is 1/(sr·attack) from
//      any start value (rate is preserved, only duration is value-dependent —
//      CRITIQUE C5).
//   3. triggerHard resets to 0 (helm-parity path stays covered).
//   4. Continuous-read: sweeping sustain during a held note tracks live (NOT
//      latched).

import { describe, it, expect } from 'vitest';
import { Envelope, EnvState } from './adsr-env';

const SR = 48000;

describe('adsr-env / Envelope state machine', () => {
  it('attack reaches 1, decay settles to sustain, release decays to 0 / Idle', () => {
    const e = new Envelope();
    e.triggerSoft(true);
    // Peak (≈1) is reached during the 5 ms attack.
    let peak = 0;
    for (let i = 0; i < SR * 0.02; i++) peak = Math.max(peak, e.tick(0.005, 0.1, 0.7, 0.2, SR));
    expect(peak).toBeCloseTo(1, 2);
    // Held → settles to sustain 0.7.
    let v = 0;
    for (let i = 0; i < SR; i++) v = e.tick(0.005, 0.1, 0.7, 0.2, SR);
    expect(e.state).toBe(EnvState.Sustain);
    expect(v).toBeCloseTo(0.7, 2);
    // Release → 0 / Idle (run past the 0.2 s time constant).
    e.triggerSoft(false);
    expect(e.state).toBe(EnvState.Release);
    for (let i = 0; i < SR * 3; i++) v = e.tick(0.005, 0.1, 0.7, 0.2, SR);
    expect(v).toBe(0);
    expect(e.state).toBe(EnvState.Idle);
  });

  it('attack time is roughly the attack param (seconds → samples)', () => {
    const e = new Envelope();
    e.triggerSoft(true);
    const attack = 0.05; // 50 ms
    let samples = 0;
    // Count samples until it leaves Attack (reaches ~1.0 and flips to Decay).
    while (e.state === EnvState.Attack && samples < SR) {
      e.tick(attack, 0.1, 0.7, 0.2, SR);
      samples++;
    }
    // Linear ramp at 1/(sr·a) reaches 0.999 in ≈ 0.999·sr·a samples.
    expect(samples).toBeGreaterThan(SR * attack * 0.95);
    expect(samples).toBeLessThan(SR * attack * 1.05);
  });

  it('an Idle envelope ignores a release with no prior attack', () => {
    const e = new Envelope();
    e.triggerSoft(false);
    expect(e.state).toBe(EnvState.Idle);
    expect(e.tick(0.005, 0.1, 0.7, 0.2, SR)).toBe(0);
  });
});

describe('adsr-env / soft retrigger (CRITIQUE C5)', () => {
  it('triggerSoft(true) mid-release produces no sample-to-sample discontinuity', () => {
    const e = new Envelope();
    e.triggerSoft(true);
    // Drive to sustain.
    for (let i = 0; i < SR * 0.5; i++) e.tick(0.005, 0.1, 0.7, 0.2, SR);
    // Release halfway.
    e.triggerSoft(false);
    for (let i = 0; i < SR * 0.1; i++) e.tick(0.005, 0.1, 0.7, 0.2, SR);
    const beforeRetrig = e.value;
    expect(beforeRetrig).toBeGreaterThan(0.05); // genuinely mid-release
    expect(beforeRetrig).toBeLessThan(0.7);
    // Soft retrigger — value must NOT jump (no value=0 reset).
    e.triggerSoft(true);
    const firstSample = e.tick(0.005, 0.1, 0.7, 0.2, SR);
    // The next sample is beforeRetrig + 1/(sr·a) — a tiny attack increment, not a
    // discontinuity to 0 or 1.
    const inc = 1 / (SR * 0.005);
    expect(firstSample - beforeRetrig).toBeCloseTo(inc, 6);
    expect(Math.abs(firstSample - beforeRetrig)).toBeLessThan(0.01);
  });

  it('attack RATE is 1/(sr·attack) regardless of the start value (rate preserved)', () => {
    const attack = 0.01;
    const inc = 1 / (SR * attack);
    // From 0:
    const e0 = new Envelope();
    e0.triggerSoft(true);
    const a0 = e0.tick(attack, 0.1, 0.7, attack, SR);
    expect(a0).toBeCloseTo(inc, 9);
    // From a mid value (drive to ~0.4 in release, then soft-retrigger):
    const e1 = new Envelope();
    e1.triggerSoft(true);
    for (let i = 0; i < SR * 0.5; i++) e1.tick(attack, 0.1, 0.7, 0.2, SR);
    e1.triggerSoft(false);
    while (e1.value > 0.4) e1.tick(attack, 0.1, 0.7, 0.2, SR);
    const start = e1.value;
    e1.triggerSoft(true);
    const next = e1.tick(attack, 0.1, 0.7, attack, SR);
    // SAME per-sample increment as from 0 → rate is value-independent.
    expect(next - start).toBeCloseTo(inc, 9);
  });
});

describe('adsr-env / triggerHard (helm-parity)', () => {
  it('triggerHard(true) resets value to 0', () => {
    const e = new Envelope();
    e.triggerSoft(true);
    for (let i = 0; i < SR * 0.5; i++) e.tick(0.005, 0.1, 0.7, 0.2, SR);
    expect(e.value).toBeGreaterThan(0.5);
    e.triggerHard(true);
    // Hard trigger zeroes the value (verbatim helm behavior).
    expect(e.value).toBe(0);
    expect(e.state).toBe(EnvState.Attack);
  });

  it('triggerHard(false) on a non-idle env → Release', () => {
    const e = new Envelope();
    e.triggerHard(true);
    for (let i = 0; i < SR * 0.1; i++) e.tick(0.005, 0.1, 0.7, 0.2, SR);
    e.triggerHard(false);
    expect(e.state).toBe(EnvState.Release);
  });
});

describe('adsr-env / continuous read (NOT latched)', () => {
  it('sustain swept during a held note tracks live', () => {
    const e = new Envelope();
    e.triggerSoft(true);
    // Settle to an initial sustain of 0.2.
    let v = 0;
    for (let i = 0; i < SR; i++) v = e.tick(0.005, 0.05, 0.2, 0.2, SR);
    expect(v).toBeCloseTo(0.2, 2);
    // Now hold the gate (no new trigger) but RAISE sustain to 0.9. The value must
    // glide toward the new sustain (proving the param is read live, not latched
    // at note-on).
    for (let i = 0; i < SR; i++) v = e.tick(0.005, 0.05, 0.9, 0.2, SR);
    expect(v).toBeCloseTo(0.9, 2);
  });
});
