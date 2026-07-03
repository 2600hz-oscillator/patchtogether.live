// art/scenarios/noise/profile.test.ts
//
// AUDIO PROFILE for NOISE (basic noise source) (backfill batch 5 —
// spec §4.1/§4.3, .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md),
// through the shared capture harness (art/setup/capture.ts + drivers.ts).
//
// Category: self-driving SOURCE with a seedable PRNG (the batch-4 verified
// lead: the generators take an explicit `seed`, so the profile never touches
// Math.random — DETERMINISM.md "Random seed (ART audio profiles)"). Each of
// the three flavor outputs is a genuinely different spectrum — the module's
// whole point — so ALL THREE are signature outputs (owner decision §6b.2):
//   white — flat        (≈ 0 dB/oct)
//   pink  — 1/f         (≈ −3 dB/oct, Voss-McCartney)
//   brown — 1/f²        (≈ −6 dB/oct, leaky-integrated white)
// Distinct per-flavor seeds (PROFILE_NOISE_SEED + flavor index) mirror the
// live module's three INDEPENDENT Math.random streams.
//
// Patch: LEVEL at its 0.5 shipping default — applied explicitly in the
// render (the factory's per-output GainNode is a plain multiply).
//
// Rendering path: the pure-TS core (packages/dsp/src/lib/noise-dsp.ts —
// extracted from the def in this batch per the plan's §5 "extract a core
// instead" rule; the factory pre-generates its looping AudioBuffers from
// EXACTLY these functions). The factory-side wiring (2 s loop + LEVEL gain)
// lives in noise.ts's def — deliberately NOT pinned: that file co-locates
// the module docs, and docs edits must never invalidate audio pins (the
// moog907a/moog960 def-file precedent). The wiring itself is covered by the
// existing spectral-shape.test.ts factory scenario.
//
// The .sha pins the extracted generator lib.

import { describe, expect, it } from 'vitest';
import { noiseGenerators } from '../../../packages/dsp/src/lib/noise-dsp';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { PROFILE_NOISE_SEED } from '../../setup/drivers';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;
const N = Math.round(SR * DURATION_S);
/** The LEVEL knob's shipping default (noiseDef params: level 0.5). */
const LEVEL = 0.5;
/** Per-flavor seeds — three independent deterministic streams. */
const SEEDS = { white: PROFILE_NOISE_SEED, pink: PROFILE_NOISE_SEED + 1, brown: PROFILE_NOISE_SEED + 2 } as const;

const FLAVORS = ['white', 'pink', 'brown'] as const;

function renderProfile(): Record<string, Float32Array> {
  const bufs: Record<string, Float32Array> = {};
  for (const flavor of FLAVORS) {
    const raw = noiseGenerators[flavor](N, SEEDS[flavor]);
    const scaled = new Float32Array(N);
    for (let i = 0; i < N; i++) scaled[i] = Math.fround(raw[i]! * LEVEL);
    bufs[flavor] = scaled;
  }
  return bufs;
}

// ── Spectral-slope probe (the same octave-band method the factory-wiring
// scenario spectral-shape.test.ts uses, over a mid-buffer DFT window) ──────
const N_DFT = 4096;

function magnitudeSpectrum(x: Float32Array, n = N_DFT, offset = 4096): Float32Array {
  const half = n >> 1;
  const out = new Float32Array(half);
  for (let k = 0; k < half; k++) {
    let re = 0;
    let im = 0;
    const w = (-2 * Math.PI * k) / n;
    for (let i = 0; i < n; i++) {
      const s = x[offset + i] ?? 0;
      re += s * Math.cos(w * i);
      im += s * Math.sin(w * i);
    }
    out[k] = Math.sqrt(re * re + im * im);
  }
  return out;
}

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

function octaveSlopeDb(spec: Float32Array, lowBin: number, highBin: number): number {
  const octaves = Math.log2(highBin / lowBin);
  return (10 * Math.log10(octaveBandPower(spec, highBin) / octaveBandPower(spec, lowBin))) / octaves;
}

function rms(b: Float32Array): number {
  let x = 0;
  for (const v of b) x += v * v;
  return Math.sqrt(x / b.length);
}

describe('ART noise / audio profile (seeded white / pink / brown at LEVEL 0.5)', () => {
  it('renders three bounded flavors with their characteristic spectral slopes', () => {
    const bufs = renderProfile();
    const slopes: Record<string, [number, number]> = {
      white: [-2, 2], //  ≈ 0 dB/oct (flat)
      pink: [-5, -1], //  ≈ −3 dB/oct
      brown: [-8, -4], // ≈ −6 dB/oct
    };
    for (const flavor of FLAVORS) {
      const buf = bufs[flavor]!;
      expect(buf.length).toBe(N);
      expect(buf.every(Number.isFinite)).toBe(true);
      // Bounded: generators stay in ±1, LEVEL halves that.
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      expect(peak, `${flavor} peak`).toBeLessThanOrEqual(LEVEL);
      expect(peak, `${flavor} peak`).toBeGreaterThan(0.01);
      expect(rms(buf), `${flavor} rms`).toBeGreaterThan(0.005);
      // The flavor's fingerprint: the octave slope across the mid spectrum.
      const slope = octaveSlopeDb(magnitudeSpectrum(buf), N_DFT / 32, N_DFT / 4);
      const [lo, hi] = slopes[flavor]!;
      expect(slope, `${flavor} slope=${slope.toFixed(2)} dB/oct`).toBeGreaterThan(lo);
      expect(slope, `${flavor} slope=${slope.toFixed(2)} dB/oct`).toBeLessThan(hi);
    }

    // The three streams are genuinely independent captures (uniqueness-guard
    // honesty): pairwise different buffers.
    expect(bufs.white).not.toEqual(bufs.pink);
    expect(bufs.pink).not.toEqual(bufs.brown);

    // Deterministic re-render is bit-identical (pure fn of the pinned seeds).
    const again = renderProfile();
    for (const flavor of FLAVORS) {
      let diff = 0;
      for (let i = 0; i < N; i++) diff = Math.max(diff, Math.abs(bufs[flavor]![i]! - again[flavor]![i]!));
      expect(diff, flavor).toBe(0);
    }
  });

  it('pins the white + pink + brown profile baselines (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('lib/noise-dsp.ts');
    await pinAll('noise', srcSha, renderProfile());
  });
});
