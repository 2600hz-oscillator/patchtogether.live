// packages/dsp/src/lib/resofilter-dsp.test.ts
//
// Pure-DSP unit tests for the RESOFILTER core (Zavalishin/Cytomic TPT
// state-variable filter, ported from Resonarium). Extracted but untested — so
// a regression in the SVF coefficient math or the mode pick would pass every
// ART/behavioral sweep silently. These pin the FREQUENCY RESPONSE directly
// (the only assertion that actually proves a filter filters):
//   • resToK / cutoffToG coefficient maps (+ clamps).
//   • svfStep DC behavior (LP passes DC, HP/BP block it).
//   • pickModeOutput tap algebra (notch = lp+hp, allpass = lp+hp−k·bp).
//   • renderResofilter response: LP attenuates highs, HP attenuates lows,
//     BP/notch peak/null at cutoff, ALLPASS stays magnitude-flat.
//   • RfSmoother de-zipper + ResofilterChannel dry/wet mix.

import { describe, it, expect } from 'vitest';
import {
  RESOFILTER_MODE_NAMES,
  RESOFILTER_MODE_SHORT,
  RESOFILTER_MODE_COUNT,
  RESOFILTER_MAX_MODE,
  makeSvfState,
  resToK,
  cutoffToG,
  svfStep,
  pickModeOutput,
  RfSmoother,
  ResofilterChannel,
  renderResofilter,
  type ResofilterMode,
} from './resofilter-dsp';

const SR = 48000;

// ── helpers ──────────────────────────────────────────────────────────────────
function sine(freqHz: number, n: number, sr = SR, amp = 1): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / sr);
  return out;
}
/** RMS of the steady-state tail (skip the filter warm-up transient). */
function rms(buf: Float32Array, skip = 2000): number {
  let s = 0;
  let c = 0;
  for (let i = skip; i < buf.length; i++) {
    s += buf[i]! * buf[i]!;
    c++;
  }
  return Math.sqrt(s / Math.max(1, c));
}
const N = 9600; // 0.2 s — enough for several cycles of 100 Hz + warm-up skip

describe('mode tables', () => {
  it('has exactly 5 modes in both name lists', () => {
    expect(RESOFILTER_MODE_COUNT).toBe(5);
    expect(RESOFILTER_MAX_MODE).toBe(4);
    expect(RESOFILTER_MODE_NAMES).toHaveLength(5);
    expect(RESOFILTER_MODE_SHORT).toHaveLength(5);
    expect(RESOFILTER_MODE_SHORT).toEqual(['LP', 'HP', 'BP', 'NT', 'AP']);
  });
});

describe('resToK', () => {
  it('maps resonance → damping with the 0.003 self-osc floor', () => {
    expect(resToK(0)).toBe(2); // no resonance → max damping
    expect(resToK(0.5)).toBe(1);
    expect(resToK(1)).toBe(0.003); // full resonance → floor (edge of self-osc)
  });
  it('clamps resonance to [0,1]', () => {
    expect(resToK(-5)).toBe(2);
    expect(resToK(9)).toBe(0.003);
  });
});

describe('cutoffToG', () => {
  it('is positive, finite, and monotonic in cutoff', () => {
    const g1 = cutoffToG(1000, SR);
    const g5 = cutoffToG(5000, SR);
    expect(g1).toBeGreaterThan(0);
    expect(Number.isFinite(g5)).toBe(true);
    expect(g5).toBeGreaterThan(g1); // higher cutoff → larger g
  });
  it('clamps cutoff to [10, sr*0.49]', () => {
    expect(cutoffToG(1, SR)).toBeCloseTo(cutoffToG(10, SR), 12); // floored to 10
    expect(cutoffToG(99999, SR)).toBeCloseTo(cutoffToG(SR * 0.49, SR), 6); // capped
    expect(Number.isFinite(cutoffToG(99999, SR))).toBe(true);
  });
});

describe('svfStep DC behavior', () => {
  it('LP passes DC, HP and BP block it', () => {
    const st = makeSvfState();
    const g = cutoffToG(1000, SR);
    const k = resToK(0.2);
    let taps = { lp: 0, bp: 0, hp: 0 };
    for (let i = 0; i < 8000; i++) taps = svfStep(1.0, g, k, st); // constant (DC) input
    expect(taps.lp).toBeCloseTo(1.0, 2); // DC passes the low-pass
    expect(taps.hp).toBeCloseTo(0.0, 2); // DC blocked by the high-pass
    expect(taps.bp).toBeCloseTo(0.0, 2); // DC blocked by the band-pass
  });
});

describe('pickModeOutput tap algebra', () => {
  const taps = { lp: 1, bp: 2, hp: 3 };
  const k = 0.5;
  it('routes each mode to the right tap combination', () => {
    expect(pickModeOutput(taps, 0 as ResofilterMode, k)).toBe(1); // LP
    expect(pickModeOutput(taps, 1 as ResofilterMode, k)).toBe(3); // HP
    expect(pickModeOutput(taps, 2 as ResofilterMode, k)).toBe(2); // BP
    expect(pickModeOutput(taps, 3 as ResofilterMode, k)).toBe(4); // NT = lp+hp
    expect(pickModeOutput(taps, 4 as ResofilterMode, k)).toBe(3); // AP = lp+hp-k*bp = 4-1
  });
});

describe('renderResofilter — actual frequency response', () => {
  const low = sine(100, N);
  const high = sine(8000, N);
  const mid = sine(1000, N); // == cutoff
  const inRms = rms(low); // ≈ 0.707 for a unit sine

  it('LOW-PASS attenuates highs and passes lows', () => {
    const lowOut = renderResofilter(low, { cutoffHz: 1000, res: 0.2, mode: 0, sr: SR });
    const highOut = renderResofilter(high, { cutoffHz: 1000, res: 0.2, mode: 0, sr: SR });
    expect(rms(lowOut)).toBeGreaterThan(0.6 * inRms); // passband ~ unity
    expect(rms(highOut)).toBeLessThan(0.2 * rms(lowOut)); // stopband well down
  });

  it('HIGH-PASS attenuates lows and passes highs', () => {
    const lowOut = renderResofilter(low, { cutoffHz: 1000, res: 0.2, mode: 1, sr: SR });
    const highOut = renderResofilter(high, { cutoffHz: 1000, res: 0.2, mode: 1, sr: SR });
    expect(rms(highOut)).toBeGreaterThan(0.6 * inRms);
    expect(rms(lowOut)).toBeLessThan(0.2 * rms(highOut));
  });

  it('BAND-PASS peaks at the cutoff', () => {
    const r = { res: 0.7, mode: 2 as ResofilterMode, sr: SR, cutoffHz: 1000 };
    const midOut = rms(renderResofilter(mid, r));
    const lowOut = rms(renderResofilter(low, r));
    const highOut = rms(renderResofilter(high, r));
    expect(midOut).toBeGreaterThan(lowOut);
    expect(midOut).toBeGreaterThan(highOut);
  });

  it('NOTCH nulls at the cutoff, passes away from it', () => {
    const r = { res: 0.7, mode: 3 as ResofilterMode, sr: SR, cutoffHz: 1000 };
    const midOut = rms(renderResofilter(mid, r));
    const lowOut = rms(renderResofilter(low, r));
    const highOut = rms(renderResofilter(high, r));
    expect(midOut).toBeLessThan(lowOut);
    expect(midOut).toBeLessThan(highOut);
  });

  it('ALLPASS stays magnitude-flat across the band', () => {
    const r = { res: 0.5, mode: 4 as ResofilterMode, sr: SR, cutoffHz: 1000 };
    const lowOut = rms(renderResofilter(low, r));
    const highOut = rms(renderResofilter(high, r));
    // |H| ≈ 1 everywhere → output RMS ≈ input RMS at both ends of the band.
    expect(lowOut).toBeCloseTo(inRms, 1);
    expect(highOut).toBeCloseTo(inRms, 1);
  });

  it('never produces NaN/Inf even at full resonance + audio-rate cutoff sweep', () => {
    const sweep = new Float32Array(N);
    for (let i = 0; i < N; i++) sweep[i] = 50 + (i / N) * 12000; // 50 → 12 kHz ramp
    const out = renderResofilter(sine(440, N), {
      cutoffHz: 1000,
      cutoffArr: sweep,
      res: 1, // self-osc edge
      mode: 0,
      sr: SR,
    });
    for (let i = 0; i < out.length; i++) expect(Number.isFinite(out[i]!)).toBe(true);
  });
});

describe('RfSmoother', () => {
  it('alpha in (0,1): a step moves part-way toward the target', () => {
    const s = new RfSmoother(SR);
    s.prime(0);
    const v = s.step(1000);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1000);
  });
  it('prime + same-target step is a no-op; converges over time', () => {
    const s = new RfSmoother(SR);
    s.prime(500);
    expect(s.step(500)).toBeCloseTo(500, 9);
    let v = 500;
    for (let i = 0; i < SR; i++) v = s.step(2000);
    expect(v).toBeCloseTo(2000, 0);
  });
});

describe('ResofilterChannel dry/wet mix', () => {
  it('mix=0 is fully dry (output === input)', () => {
    const ch = new ResofilterChannel(SR);
    const x = 0.42;
    expect(ch.step(x, 1000, 0.5, 0, 0, SR)).toBeCloseTo(x, 12);
  });
  it('primes the cutoff smoother to 1000 Hz', () => {
    const ch = new ResofilterChannel(SR);
    expect(ch.smoothedCutoff()).toBeCloseTo(1000, 6);
  });
});
