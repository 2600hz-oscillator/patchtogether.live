// packages/dsp/src/lib/ninelives-dsp.test.ts
//
// Deterministic unit tests for the NINE LIVES pure DSP core. No AudioContext —
// we drive NineLivesCore.step() directly and assert the load-bearing contract:
//   * the geometric ⅓ rate ladder (out2 = out1/3, … out9 = out1/6561),
//     measured EMPIRICALLY from each output's accumulated phase,
//   * all nine taps share ONE waveform shape,
//   * the RESET trigger re-zeroes every phase (and re-syncs the outputs), is
//     EDGE-triggered (fires once per rising edge, not level-held), and
//   * no NaN / non-finite output across a param sweep.

import { describe, it, expect } from 'vitest';
import {
  NineLivesCore,
  NINE_LIVES_OUTPUT_COUNT,
  NINE_LIVES_RATIO,
  NINE_LIVES_RATE_MULTIPLIERS,
  RESET_THRESHOLD,
  morph,
} from './ninelives-dsp';

const SR = 48_000;

/** Run the core for `seconds` of audio at a fixed rate/shape with no reset,
 *  then return each output's MEASURED frequency (Hz) from accumulated phase. */
function measureFrequencies(rateHz: number, shape: number, seconds: number): number[] {
  const core = new NineLivesCore();
  const out = new Float32Array(NINE_LIVES_OUTPUT_COUNT);
  const samples = Math.round(seconds * SR);
  for (let i = 0; i < samples; i++) {
    core.step(rateHz, shape, 0, SR, out);
  }
  const elapsed = samples / SR;
  return Array.from({ length: NINE_LIVES_OUTPUT_COUNT }, (_, n) => core.totalPhase(n) / elapsed);
}

describe('NINE LIVES — rate ladder constants', () => {
  it('has exactly 9 outputs', () => {
    expect(NINE_LIVES_OUTPUT_COUNT).toBe(9);
    expect(NINE_LIVES_RATE_MULTIPLIERS).toHaveLength(9);
  });

  it('out1 multiplier is 1 (runs at the rate knob, like a normal LFO)', () => {
    expect(NINE_LIVES_RATE_MULTIPLIERS[0]).toBe(1);
  });

  it('each output is exactly 1/3 the rate of the previous (geometric ladder)', () => {
    for (let n = 1; n < NINE_LIVES_OUTPUT_COUNT; n++) {
      const ratio = NINE_LIVES_RATE_MULTIPLIERS[n]! / NINE_LIVES_RATE_MULTIPLIERS[n - 1]!;
      expect(ratio).toBeCloseTo(NINE_LIVES_RATIO, 12);
      expect(ratio).toBeCloseTo(1 / 3, 12);
    }
  });

  it('out9 is (1/3)^8 = 1/6561 of out1 (NOT 1/19683 — that would be a 10th tap)', () => {
    expect(NINE_LIVES_RATE_MULTIPLIERS[8]).toBeCloseTo((1 / 3) ** 8, 15);
    expect(NINE_LIVES_RATE_MULTIPLIERS[8]).toBeCloseTo(1 / 6561, 15);
    // Sanity on the magnitude the spec calls out (~0.0001524×).
    expect(NINE_LIVES_RATE_MULTIPLIERS[8]).toBeCloseTo(0.0001524157903, 9);
    // Explicitly NOT (1/3)^9.
    expect(NINE_LIVES_RATE_MULTIPLIERS[8]).not.toBeCloseTo(1 / 19683, 9);
  });
});

describe('NINE LIVES — measured frequency ladder', () => {
  it('out1 runs at the rate knob frequency', () => {
    // totalPhase() accumulates continuously, so 1 s of audio gives an exact
    // frequency measurement even for the very slow taps — no need for a long run.
    const freqs = measureFrequencies(8, 0, 1);
    expect(freqs[0]).toBeCloseTo(8, 6);
  });

  it('each measured output is 1/3 the measured rate of the previous', () => {
    const rate = 12;
    const freqs = measureFrequencies(rate, 0, 1);
    for (let n = 1; n < NINE_LIVES_OUTPUT_COUNT; n++) {
      expect(freqs[n]! / freqs[n - 1]!).toBeCloseTo(1 / 3, 9);
    }
  });

  it('measured out9 frequency is rate/6561', () => {
    const rate = 90;
    const freqs = measureFrequencies(rate, 0, 1);
    expect(freqs[8]!).toBeCloseTo(rate / 6561, 9);
    // And out8 = rate/2187, out2 = rate/3 — spot-check the chain endpoints.
    expect(freqs[1]!).toBeCloseTo(rate / 3, 6);
    expect(freqs[7]!).toBeCloseTo(rate / 2187, 9);
  });
});

describe('NINE LIVES — shared waveform shape', () => {
  it('every output uses the SAME morph(phase, shape) — one shared waveform', () => {
    const core = new NineLivesCore();
    const out = new Float32Array(NINE_LIVES_OUTPUT_COUNT);
    const shape = 1.37; // an arbitrary morph between saw and square
    // Advance a while so the phases spread across the ladder.
    for (let i = 0; i < 5000; i++) core.step(7, shape, 0, SR, out);
    for (let n = 0; n < NINE_LIVES_OUTPUT_COUNT; n++) {
      // The emitted value must equal morph() of THIS tap's phase at the SAME
      // shared shape — proving the single shared waveform. `out` is a
      // Float32Array, so the core stored Math.fround(morph(p, shape)); compare
      // against the same float32 rounding for an EXACT match.
      expect(out[n]!).toBe(Math.fround(morph(core.phases[n]!, shape)));
    }
  });

  it('morph matches the canonical sine / saw / square endpoints', () => {
    // sine at quarter phase = +1.
    expect(morph(0.25, 0)).toBeCloseTo(1, 12);
    expect(morph(0.75, 0)).toBeCloseTo(-1, 12);
    // saw is the linear ramp -1..+1.
    expect(morph(0, 1)).toBeCloseTo(-1, 12);
    expect(morph(0.5, 1)).toBeCloseTo(0, 12);
    // square is ±1 split at half phase.
    expect(morph(0.25, 2)).toBe(1);
    expect(morph(0.75, 2)).toBe(-1);
  });

  it('at shape=2 (square) every output is exactly ±1', () => {
    const core = new NineLivesCore();
    const out = new Float32Array(NINE_LIVES_OUTPUT_COUNT);
    for (let i = 0; i < 2000; i++) {
      core.step(11, 2, 0, SR, out);
      for (let n = 0; n < NINE_LIVES_OUTPUT_COUNT; n++) {
        expect(Math.abs(out[n]!)).toBe(1);
      }
    }
  });
});

describe('NINE LIVES — RESET trigger', () => {
  it('a rising edge re-zeroes ALL nine phase accumulators (re-sync)', () => {
    const core = new NineLivesCore();
    const out = new Float32Array(NINE_LIVES_OUTPUT_COUNT);
    // Run so the phases diverge across the ladder.
    for (let i = 0; i < 9000; i++) core.step(30, 0, 0, SR, out);
    // Phases should NOT all be equal yet (the ladder has spread them out).
    const spread = Math.max(...core.phases) - Math.min(...core.phases);
    expect(spread).toBeGreaterThan(0);

    // Fire one rising edge (low → high) and step once.
    core.step(30, 0, 1, SR, out);

    // Every phase was re-zeroed THEN advanced one sample by its own rate, so
    // cycles are all back to 0 and the phases are within one sample-step of 0.
    for (let n = 0; n < NINE_LIVES_OUTPUT_COUNT; n++) {
      expect(core.cycles[n]!).toBe(0);
      const maxStep = (30 * NINE_LIVES_RATE_MULTIPLIERS[n]!) / SR;
      expect(core.phases[n]!).toBeGreaterThanOrEqual(0);
      expect(core.phases[n]!).toBeLessThanOrEqual(maxStep + 1e-12);
    }
    // Re-synced: all taps back at (≈) the zero crossing → outputs near 0.
    for (let n = 0; n < NINE_LIVES_OUTPUT_COUNT; n++) {
      expect(Math.abs(out[n]!)).toBeLessThan(0.02);
    }
  });

  it('is EDGE-triggered, not level-held: holding RESET high lets the ladder run', () => {
    const core = new NineLivesCore();
    const out = new Float32Array(NINE_LIVES_OUTPUT_COUNT);
    // Hold reset HIGH for many samples after the initial edge.
    core.step(40, 0, 1, SR, out); // rising edge → reset, then advance 1 sample
    for (let i = 0; i < 4000; i++) core.step(40, 0, 1, SR, out); // stays high
    // The fastest tap must have advanced well past 0 — proving the high level
    // did NOT keep pinning the phase (a gate would have frozen it at ~0).
    expect(core.totalPhase(0)).toBeGreaterThan(0.1);
  });

  it('a falling edge does nothing (no reset on high → low)', () => {
    const core = new NineLivesCore();
    const out = new Float32Array(NINE_LIVES_OUTPUT_COUNT);
    core.step(25, 0, 1, SR, out); // rising edge (reset)
    for (let i = 0; i < 3000; i++) core.step(25, 0, 1, SR, out); // hold high
    const before = core.totalPhase(0);
    core.step(25, 0, 0, SR, out); // falling edge — must NOT reset
    expect(core.totalPhase(0)).toBeGreaterThan(before);
  });

  it('RESET_THRESHOLD matches the canonical gate-hi level (0.5)', () => {
    expect(RESET_THRESHOLD).toBe(0.5);
  });
});

describe('NINE LIVES — robustness', () => {
  it('produces no NaN / non-finite output across a rate × shape × reset sweep', () => {
    // Accumulate finiteness into a flag (per-sample expect() over the full sweep
    // is ~300k assertions and times out) — one assert per config instead.
    for (const rate of [0.01, 0.5, 1, 7.3, 50, 100, -5, 0]) {
      for (const shape of [0, 0.5, 1, 1.5, 2, -1, 3]) {
        const core = new NineLivesCore();
        const out = new Float32Array(NINE_LIVES_OUTPUT_COUNT);
        let allFinite = true;
        for (let i = 0; i < 1000; i++) {
          // Inject a reset pulse periodically to exercise the edge path too.
          const reset = i % 137 === 0 ? 1 : 0;
          core.step(rate, shape, reset, SR, out);
          for (let n = 0; n < NINE_LIVES_OUTPUT_COUNT; n++) {
            if (!Number.isFinite(out[n]!)) allFinite = false;
          }
        }
        expect(allFinite, `rate=${rate} shape=${shape} produced a non-finite output`).toBe(true);
        for (let n = 0; n < NINE_LIVES_OUTPUT_COUNT; n++) {
          expect(Number.isFinite(core.phases[n]!)).toBe(true);
          expect(core.phases[n]!).toBeGreaterThanOrEqual(0);
          expect(core.phases[n]!).toBeLessThan(1);
        }
      }
    }
  });

  it('is deterministic: identical drives produce identical state', () => {
    const run = () => {
      const core = new NineLivesCore();
      const out = new Float32Array(NINE_LIVES_OUTPUT_COUNT);
      for (let i = 0; i < 1234; i++) core.step(9.5, 0.8, i % 300 === 0 ? 1 : 0, SR, out);
      return Array.from(out);
    };
    expect(run()).toEqual(run());
  });
});
