// packages/web/src/lib/audio/modules/noise.test.ts
//
// Unit tests for NOISE: module-def shape + spectral characteristics of
// the three noise generators.
//
// Spectral assertions are coarse: we run a small DFT on the generator
// output, bin the magnitude into octaves, and check the slope across
// adjacent octaves. White ≈ 0 dB/oct, pink ≈ -3 dB/oct, brown ≈
// -6 dB/oct. We allow ±2 dB tolerance per octave because (a) PRNG
// realisations vary, (b) Voss-McCartney is an approximation, and (c)
// the leaky integrator brown noise has a small DC pole offset.

import { describe, expect, it } from 'vitest';
import { noiseDef, noiseGenerators } from './noise';

// N kept small (1024) because we do an O(N²) naive DFT — the spectral
// shape is statistical and a 1024-point window already gives stable
// per-octave averages. For longer-running statistical assertions
// (mean / std-dev) we use a separate larger N.
const N = 1024;
const N_STAT = 16384; // bigger N for mean/std-dev (cheap O(N) loops)
const SEED = 42;     // deterministic across runs

/** Compute the magnitude spectrum (one-sided) of a real signal via a
 *  naive O(N²) DFT. Slow but correct; only used in the test suite at
 *  N ≤ ~2048 to stay under the per-test timeout. */
function magnitudeSpectrum(x: Float32Array): Float32Array {
  const n = x.length;
  const half = n >> 1;
  const out = new Float32Array(half);
  for (let k = 0; k < half; k++) {
    let re = 0, im = 0;
    const w = (-2 * Math.PI * k) / n;
    for (let i = 0; i < n; i++) {
      re += x[i]! * Math.cos(w * i);
      im += x[i]! * Math.sin(w * i);
    }
    out[k] = Math.sqrt(re * re + im * im);
  }
  return out;
}

/** Average magnitude in an octave-wide bin around the centre frequency
 *  bin. Bin spans [centre × 2^(-1/2), centre × 2^(+1/2)]. */
function octaveBandPower(spec: Float32Array, centreBin: number): number {
  const lo = Math.max(1, Math.floor(centreBin / Math.SQRT2));
  const hi = Math.min(spec.length - 1, Math.floor(centreBin * Math.SQRT2));
  let sum = 0;
  let count = 0;
  for (let k = lo; k <= hi; k++) {
    sum += spec[k]! * spec[k]!;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

/** Slope of power-vs-octave in dB across two octave centres. */
function octaveSlopeDb(spec: Float32Array, lowBin: number, highBin: number): number {
  const lowPower = octaveBandPower(spec, lowBin);
  const highPower = octaveBandPower(spec, highBin);
  // Power ratio in dB. Octaves apart = log2(highBin/lowBin).
  const octaves = Math.log2(highBin / lowBin);
  return (10 * Math.log10(highPower / lowPower)) / octaves;
}

describe('noiseGenerators: white noise', () => {
  it('mean is approximately 0 (long-run statistical property)', () => {
    const x = noiseGenerators.white(N_STAT, SEED);
    let sum = 0;
    for (let i = 0; i < N_STAT; i++) sum += x[i]!;
    const mean = sum / N_STAT;
    expect(Math.abs(mean), `white mean=${mean}`).toBeLessThan(0.05);
  });

  it('std-dev is approximately 0.577 (uniform [-1,+1] → variance 1/3)', () => {
    const x = noiseGenerators.white(N_STAT, SEED);
    let sum = 0;
    for (let i = 0; i < N_STAT; i++) sum += x[i]!;
    const mean = sum / N_STAT;
    let varSum = 0;
    for (let i = 0; i < N_STAT; i++) {
      const d = x[i]! - mean;
      varSum += d * d;
    }
    const std = Math.sqrt(varSum / N_STAT);
    // Theoretical 1/sqrt(3) ≈ 0.577; allow ±0.03 tolerance.
    expect(std, `white std=${std}`).toBeGreaterThan(0.55);
    expect(std, `white std=${std}`).toBeLessThan(0.61);
  });

  it('every sample stays within [-1, +1]', () => {
    const x = noiseGenerators.white(N_STAT, SEED);
    let outOfRange = 0;
    for (let i = 0; i < N_STAT; i++) {
      if (x[i]! < -1 || x[i]! > 1) outOfRange++;
    }
    expect(outOfRange).toBe(0);
  });

  it('spectrum is approximately flat (≈ 0 dB/oct slope)', () => {
    const x = noiseGenerators.white(N, SEED);
    const spec = magnitudeSpectrum(x);
    // Compare power at ~freq/8 vs ~freq/2. White should be flat.
    const slope = octaveSlopeDb(spec, N / 16, N / 4);
    expect(Math.abs(slope), `white slope=${slope.toFixed(2)} dB/oct`).toBeLessThan(2);
  });
});

describe('noiseGenerators: pink noise', () => {
  it('every sample stays roughly within [-1, +1] (mostly — Voss-McCartney can excursion)', () => {
    const x = noiseGenerators.pink(N_STAT, SEED);
    let outOfRange = 0;
    for (let i = 0; i < N_STAT; i++) {
      if (Math.abs(x[i]!) > 1.2) outOfRange++;
    }
    // Allow occasional small excursions (Voss-McCartney sums 16 rows
    // each ±1, normalised by 17 — peaks can briefly exceed ±1).
    // Require less than 0.1% of samples are out-of-bounds.
    expect(outOfRange / N_STAT, `${outOfRange} pink out-of-range`).toBeLessThan(0.001);
  });

  it('spectrum slopes ≈ -3 dB/oct', () => {
    const x = noiseGenerators.pink(N, SEED);
    const spec = magnitudeSpectrum(x);
    const slope = octaveSlopeDb(spec, N / 32, N / 4);
    // Pink target -3; allow ±2 dB/oct tolerance.
    expect(slope, `pink slope=${slope.toFixed(2)} dB/oct`).toBeGreaterThan(-5);
    expect(slope, `pink slope=${slope.toFixed(2)} dB/oct`).toBeLessThan(-1);
  });
});

describe('noiseGenerators: brown noise', () => {
  it('spectrum slopes ≈ -6 dB/oct', () => {
    const x = noiseGenerators.brown(N, SEED);
    const spec = magnitudeSpectrum(x);
    const slope = octaveSlopeDb(spec, N / 32, N / 4);
    // Brown target -6; allow ±2 dB/oct.
    expect(slope, `brown slope=${slope.toFixed(2)} dB/oct`).toBeGreaterThan(-8);
    expect(slope, `brown slope=${slope.toFixed(2)} dB/oct`).toBeLessThan(-4);
  });

  it('leaky integrator prevents unbounded DC drift', () => {
    // Run a long buffer and check the absolute maximum stays bounded —
    // without the leak coefficient, brown noise wanders unboundedly.
    // With LEAK=0.99 + NORM=1/8 the steady-state RMS is ~0.4 and
    // peaks should stay well under 1.0.
    const x = noiseGenerators.brown(N_STAT * 4, SEED);
    let peak = 0;
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, `brown peak=${peak}`).toBeLessThan(1.5);
  });
});

describe('noiseDef: module-def shape', () => {
  it('declares type=noise, label=NOISE, category=sources', () => {
    expect(noiseDef.type).toBe('noise');
    expect(noiseDef.label).toBe('noise');
    expect(noiseDef.category).toBe('sources');
    expect(noiseDef.domain).toBe('audio');
  });

  it('exposes 0 inputs (it is a source)', () => {
    expect(noiseDef.inputs).toEqual([]);
  });

  it('exposes 3 audio outputs: white, pink, brown', () => {
    const ids = noiseDef.outputs.map((p) => p.id).sort();
    expect(ids).toEqual(['brown', 'pink', 'white']);
    for (const p of noiseDef.outputs) {
      expect(p.type).toBe('audio');
    }
  });

  it('exposes a single LEVEL param (0..1, defaults to 0.5)', () => {
    expect(noiseDef.params).toHaveLength(1);
    const level = noiseDef.params[0]!;
    expect(level.id).toBe('level');
    expect(level.label).toBe('Level');
    expect(level.min).toBe(0);
    expect(level.max).toBe(1);
    expect(level.defaultValue).toBe(0.5);
    expect(level.curve).toBe('linear');
  });
});
