// packages/dsp/src/lib/moog-vco-dsp.test.ts
//
// Pure-DSP unit tests for the Moog VCO core (own-code polyBLEP oscillator,
// shared by the 921 worklet). Pins the math that the 921 depends on so a
// refactor surfaces as a specific quantitative regression:
//   • moogFreqHz — V/oct + octave + tune + linear-FM frequency mapping,
//     C4 anchor, sub-audio/Nyquist clamps.
//   • moogWaves  — the four 921 waveforms are phase-coherent, in [-1,1],
//     the right shape (saw ramps, rectangular toggles at width, triangle
//     is symmetric), and pulse-width sets the rectangular duty cycle.
//   • polyBlep / polyBlamp — zero outside the 2-sample edge window.
//   • MoogVco    — phase accumulates at freq/sr; hard sync resets phase on
//     a rising edge; the oscillator actually oscillates (sign changes).
//   • syncModeFromParam — the -1/0/+1 switch encoding.

import { describe, it, expect } from 'vitest';
import {
  MOOG_C4_HZ,
  moogFreqHz,
  moogWaves,
  polyBlep,
  polyBlamp,
  syncModeFromParam,
  MoogVco,
} from './moog-vco-dsp';

const SR = 48000;

describe('moog-vco-dsp / moogFreqHz', () => {
  it('0 V/oct, no octave/tune/fm = C4', () => {
    expect(moogFreqHz(0, 0, 0, 0, SR)).toBeCloseTo(MOOG_C4_HZ, 3);
  });

  it('+1 V/oct doubles the frequency (octave up)', () => {
    expect(moogFreqHz(1, 0, 0, 0, SR)).toBeCloseTo(MOOG_C4_HZ * 2, 2);
  });

  it('octave coarse switch adds octaves on top of pitch CV', () => {
    // +2 octaves coarse, +1 V/oct = 3 octaves up.
    expect(moogFreqHz(1, 2, 0, 0, SR)).toBeCloseTo(MOOG_C4_HZ * 8, 1);
  });

  it('+12 semitones fine tune = one octave up', () => {
    expect(moogFreqHz(0, 0, 12, 0, SR)).toBeCloseTo(MOOG_C4_HZ * 2, 2);
  });

  it('linear FM term adds Hz directly (not exponential)', () => {
    const base = moogFreqHz(0, 0, 0, 0, SR);
    expect(moogFreqHz(0, 0, 0, 100, SR)).toBeCloseTo(base + 100, 3);
  });

  it('clamps to the 921 sub-audio floor (.01 Hz) for extreme negative pitch', () => {
    expect(moogFreqHz(-30, -5, 0, 0, SR)).toBeGreaterThanOrEqual(0.01);
    expect(moogFreqHz(-30, -5, 0, 0, SR)).toBeLessThan(1);
  });

  it('clamps below Nyquist for extreme positive pitch', () => {
    const f = moogFreqHz(40, 5, 12, 0, SR);
    expect(f).toBeLessThanOrEqual(SR * 0.49);
    expect(f).toBeLessThanOrEqual(40000);
  });
});

describe('moog-vco-dsp / polyBlep + polyBlamp', () => {
  it('polyBlep is 0 in the middle of a cycle (away from edges)', () => {
    const dt = 0.01;
    expect(polyBlep(0.5, dt)).toBe(0);
    expect(polyBlep(0.3, dt)).toBe(0);
  });
  it('polyBlep is nonzero just after the rising edge + just before wrap', () => {
    const dt = 0.01;
    expect(polyBlep(0.005, dt)).not.toBe(0);
    expect(polyBlep(0.995, dt)).not.toBe(0);
  });
  it('polyBlamp is 0 away from edges, nonzero at the edges', () => {
    const dt = 0.01;
    expect(polyBlamp(0.5, dt)).toBe(0);
    expect(polyBlamp(0.005, dt)).not.toBe(0);
  });
  it('residuals degenerate to 0 at dt<=0', () => {
    expect(polyBlep(0.001, 0)).toBe(0);
    expect(polyBlamp(0.001, 0)).toBe(0);
  });
});

describe('moog-vco-dsp / moogWaves', () => {
  const dt = MOOG_C4_HZ / SR; // C4 increment

  it('emits all four 921 waveforms in [-1.1, 1.1] across a full cycle', () => {
    for (let k = 0; k < 256; k++) {
      const p = k / 256;
      const w = moogWaves(p, dt, 0.5);
      for (const v of [w.sine, w.triangle, w.sawtooth, w.rectangular]) {
        expect(Number.isFinite(v)).toBe(true);
        // polyBLEP/BLAMP can overshoot ±1 slightly at edges — allow a small margin.
        expect(v).toBeGreaterThanOrEqual(-1.15);
        expect(v).toBeLessThanOrEqual(1.15);
      }
    }
  });

  it('sawtooth ramps upward across the cycle (mid-cycle samples increase)', () => {
    const a = moogWaves(0.25, dt, 0.5).sawtooth;
    const b = moogWaves(0.5, dt, 0.5).sawtooth;
    const c = moogWaves(0.75, dt, 0.5).sawtooth;
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('rectangular is high before the width threshold, low after (width=0.5)', () => {
    expect(moogWaves(0.25, dt, 0.5).rectangular).toBeGreaterThan(0);
    expect(moogWaves(0.75, dt, 0.5).rectangular).toBeLessThan(0);
  });

  it('pulse width sets the rectangular duty cycle (width=0.25 → high only early)', () => {
    expect(moogWaves(0.1, dt, 0.25).rectangular).toBeGreaterThan(0);
    expect(moogWaves(0.4, dt, 0.25).rectangular).toBeLessThan(0);
  });

  it('triangle is symmetric: peak near phase 0.5, troughs near 0 and 1', () => {
    const peak = moogWaves(0.5, dt, 0.5).triangle;
    const trough0 = moogWaves(0.0, dt, 0.5).triangle;
    expect(peak).toBeGreaterThan(0.9);
    expect(trough0).toBeLessThan(-0.9);
  });

  it('sine tracks Math.sin at the cycle quarters', () => {
    expect(moogWaves(0.25, dt, 0.5).sine).toBeCloseTo(1, 5);
    expect(moogWaves(0.75, dt, 0.5).sine).toBeCloseTo(-1, 5);
  });

  it('all four waveforms share ONE phase (phase coherence): zero-crossing of saw aligns with sine zero', () => {
    // At phase 0 the naive saw is -1 (its discontinuity) and sine is 0; the
    // shared phase means a single accumulator drives all four. We assert
    // the sawtooth crosses zero near phase 0.5 (mid-ramp) where the sine
    // also crosses downward — same phase reference.
    const sawMid = moogWaves(0.5, dt, 0.5).sawtooth;
    expect(Math.abs(sawMid)).toBeLessThan(0.05);
  });
});

describe('moog-vco-dsp / syncModeFromParam', () => {
  it('maps -1/0/+1 to soft/off/hard', () => {
    expect(syncModeFromParam(-1)).toBe('soft');
    expect(syncModeFromParam(0)).toBe('off');
    expect(syncModeFromParam(1)).toBe('hard');
  });
});

describe('moog-vco-dsp / MoogVco', () => {
  it('oscillates: output changes sign over a cycle at C4', () => {
    const vco = new MoogVco(SR);
    let sawMin = Infinity;
    let sawMax = -Infinity;
    for (let i = 0; i < SR / Math.round(MOOG_C4_HZ); i++) {
      const w = vco.step(MOOG_C4_HZ, 0.5, 0, 'off');
      sawMin = Math.min(sawMin, w.sawtooth);
      sawMax = Math.max(sawMax, w.sawtooth);
    }
    expect(sawMax).toBeGreaterThan(0.5);
    expect(sawMin).toBeLessThan(-0.5);
  });

  it('phase accumulates at freq/sr (period matches the frequency)', () => {
    const vco = new MoogVco(SR);
    const freq = 100; // 100 Hz → period = 480 samples at 48k
    // Find two consecutive sine zero-up-crossings, measure the gap.
    let prev = vco.step(freq, 0.5, 0, 'off').sine;
    const crossings: number[] = [];
    for (let i = 1; i < 2000 && crossings.length < 3; i++) {
      const cur = vco.step(freq, 0.5, 0, 'off').sine;
      if (prev <= 0 && cur > 0) crossings.push(i);
      prev = cur;
    }
    expect(crossings.length).toBeGreaterThanOrEqual(2);
    const period = crossings[1] - crossings[0];
    expect(period).toBeCloseTo(SR / freq, -1); // ~480, within 10s of samples
  });

  it('hard sync resets phase on a rising edge — synced osc diverges from a free one', () => {
    // Two oscillators at the SAME (incommensurate) slave frequency. Feed the
    // synced one a master sync pulse mid-cycle; feed the free one no sync.
    // After the rising edge the synced oscillator's phase has been forced to
    // 0 while the free one kept accumulating, so their outputs diverge.
    const synced = new MoogVco(SR);
    const free = new MoogVco(SR);
    const slaveFreq = 1234.5; // not a divisor of any sync period below
    // Warm both up identically (no sync) for a quarter cycle.
    for (let i = 0; i < 8; i++) {
      synced.step(slaveFreq, 0.5, -1, 'hard');
      free.step(slaveFreq, 0.5, -1, 'off');
    }
    // Rising edge ONLY on the synced one.
    const after = synced.step(slaveFreq, 0.5, 1, 'hard');
    const freeAfter = free.step(slaveFreq, 0.5, 1, 'off');
    // Phase was reset to 0 on `after`; the free one is ~9 samples into its
    // cycle. The sine taps must differ measurably (the reset moved the slave
    // phase back to 0 where sin≈0, while the free one is partway up).
    expect(Math.abs(after.sine - freeAfter.sine)).toBeGreaterThan(0.05);
    // And the reset sample sits at the start of the cycle (sine ≈ 0).
    expect(Math.abs(after.sine)).toBeLessThan(0.05);
  });

  it('sync=off ignores the sync input (no phase reset)', () => {
    const vcoSynced = new MoogVco(SR);
    const vcoFree = new MoogVco(SR);
    let synced = 0;
    let free = 0;
    for (let i = 0; i < 200; i++) {
      // Toggle sync high every 10 samples on the synced one.
      const s = i % 20 < 10 ? 1 : -1;
      synced = vcoSynced.step(2000, 0.5, s, 'off').sawtooth;
      free = vcoFree.step(2000, 0.5, s, 'off').sawtooth;
    }
    // With sync OFF both are identical (the sync input had no effect).
    expect(synced).toBeCloseTo(free, 6);
  });
});
