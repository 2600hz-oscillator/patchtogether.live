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
import { noiseGenerators } from './noise';

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
  // ⚠ WHAT THIS REPLACED, because the replacement is the whole point.
  //
  // The shipped assertion counted samples with `|x| > 1.2` and required fewer
  // than 0.1 % of them, over a comment reading *"Voss-McCartney sums 16 rows
  // each ±1, normalised by 17 — peaks can briefly exceed ±1"*. That sentence
  // is false, and its own arithmetic says so: 16 rows plus one fresh white
  // sample, each in [−1, +1], divided by ROWS + 1 = 17, is bounded by 17/17 =
  // **exactly 1**. `|x| > 1.2` is therefore not merely unlikely, it is
  // UNREACHABLE — the count is 0 by construction, on every seed, for every
  // length, and the assertion **cannot fail for the reason it states**. It was
  // a decorative gate: green forever, blind to any change to the generator's
  // level, its row count or its normaliser.
  //
  // The three tests below say the things that are actually true and actually
  // checkable, and the third is a NEGATIVE CONTROL on the other two: it builds
  // the unnormalised sum and shows it DOES break the bound, so "pink stays
  // inside ±1" is a measurement of pink rather than a property of the number 1.

  it('is HARD-BOUNDED by ±1 — the normaliser, not luck', () => {
    // Fails if ROWS, the extra white sample, or the ROWS+1 divisor ever drift
    // apart — the exact class of change the old assertion could not see.
    for (const seed of [SEED, 1, 7, 12345]) {
      const x = noiseGenerators.pink(N_STAT, seed);
      let peak = 0;
      let peakAt = -1;
      for (let i = 0; i < N_STAT; i++) {
        const a = Math.abs(x[i]!);
        if (a > peak) { peak = a; peakAt = i; }
      }
      expect(
        peak,
        `pink seed=${seed} peak=${peak.toFixed(6)} at sample ${peakAt} — the sum of ` +
          `ROWS(16) rows + 1 white sample over ROWS+1(17) cannot exceed 1`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it('the STATISTICAL peak sits near 0.62 — far below the bound', () => {
    // The bound above is structural, so it would also pass on a generator that
    // had collapsed to silence or been scaled to a tenth. This pins the level
    // it actually reaches: 16 near-independent rows summed and divided by 17
    // concentrate hard, and a 16 384-sample window peaks around 0.6, not 1.
    // (Measured over 1e6 samples, four seeds: 0.615 / 0.621 / 0.621 / 0.639.)
    for (const seed of [SEED, 1, 7, 12345]) {
      const x = noiseGenerators.pink(N_STAT, seed);
      let peak = 0;
      for (let i = 0; i < N_STAT; i++) peak = Math.max(peak, Math.abs(x[i]!));
      expect(peak, `pink seed=${seed} peak=${peak.toFixed(4)}`).toBeGreaterThan(0.35);
      expect(peak, `pink seed=${seed} peak=${peak.toFixed(4)}`).toBeLessThan(0.85);
    }
  });

  it('NEGATIVE CONTROL: the un-normalised sum DOES break ±1', () => {
    // Reconstruct the generator without its ROWS+1 divisor. If this did not
    // exceed 1 the bound assertion above would be proving nothing about the
    // normaliser — it would just be reporting that the numbers happen to be
    // small, which is precisely the failure the old test made.
    const x = noiseGenerators.pink(N_STAT, SEED);
    let unnormalisedPeak = 0;
    for (let i = 0; i < N_STAT; i++) unnormalisedPeak = Math.max(unnormalisedPeak, Math.abs(x[i]! * 17));
    expect(
      unnormalisedPeak,
      `un-normalised peak=${unnormalisedPeak.toFixed(3)} — must exceed 1, or the bound test is vacuous`,
    ).toBeGreaterThan(1);
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
    //
    // ⚠ Brown, unlike pink, has NO structural bound: a leaky integrator's
    // excursion is statistical and GROWS with buffer length. Measured at
    // seed 42: 1.194 over 1e6 samples, against ~0.9 over the 65 536 this test
    // runs. So the "peaks should stay well under 1.0" this comment used to
    // claim was true only of the short window it happened to measure, and the
    // generator's own header ("peak excursions stay comfortably under ±1 …
    // verified to ~64k samples") is honest only because of that qualifier.
    // The 1.5 ceiling is the real assertion — it is what separates "bounded by
    // the leak" from "wandering", which is the property under test.
    const x = noiseGenerators.brown(N_STAT * 4, SEED);
    let peak = 0;
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i]!);
      if (a > peak) peak = a;
    }
    expect(peak, `brown peak=${peak}`).toBeLessThan(1.5);
    // NEGATIVE CONTROL on that ceiling: without the leak the walk is
    // unbounded, so the same buffer with LEAK=1 must blow straight past it.
    // (Reconstructed rather than parameterised — the generator does not expose
    // LEAK, and a ceiling nothing can breach is the vacuous-gate pattern this
    // file was just cleaned of.)
    let walk = 0;
    let walkPeak = 0;
    let s = SEED >>> 0;
    for (let i = 0; i < x.length; i++) {
      // mulberry32, the same PRNG noise-dsp uses.
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      walk += 0.5 * (r * 2 - 1);           // no LEAK term
      walkPeak = Math.max(walkPeak, Math.abs(walk / 8));
    }
    expect(
      walkPeak,
      `leak-free walk peak=${walkPeak.toFixed(2)} — must exceed the 1.5 ceiling, ` +
        `or that ceiling is not testing the leak`,
    ).toBeGreaterThan(1.5);
  });
});
