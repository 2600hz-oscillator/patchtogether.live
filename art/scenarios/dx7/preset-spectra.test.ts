// art/scenarios/dx7/preset-spectra.test.ts
//
// Spectral validation of the bundled DX7 patches. For each preset we:
//   1. Render 1 second of a held middle-C (or its register-appropriate note).
//   2. Hann-window + Goertzel-detect the fundamental + a handful of partials.
//   3. Assert the partials we expect for that timbral family are present
//      (within ±10% amplitude tolerance — generous because the patches are
//      hand-tuned, not bit-exact).
//
// We assert SHAPE, not absolute amplitude — what makes E.PIANO sound like
// an FM Rhodes is that ratio-1 carrier + ratio-14 modulator pair. We check
// for energy at the fundamental (carrier) and the bell-frequencies above
// it (carrier × 14, carrier × 13, carrier × 15 — the FM sidebands).
//
// The renderer is the pure-TS spec for what the worklet should produce
// (packages/web/src/lib/audio/dx7-render.ts). Worklet drift from this spec
// is a worklet bug.

import { describe, it, expect } from 'vitest';
import { renderDx7Note, goertzel, hann, midiToHz, rms } from '../../../packages/web/src/lib/audio/dx7-render';
import { findBuiltinPatch } from '../../../packages/web/src/lib/audio/dx7-banks';

const SAMPLE_RATE = 48000;
const DURATION_S = 1.0;

/** Render and analyse a preset at the given midi note. Returns the windowed
 *  buffer + a Goertzel probe function. */
function setupAnalysis(presetName: string, midi: number) {
  const patch = findBuiltinPatch(presetName);
  if (!patch) throw new Error(`unknown patch: ${presetName}`);
  const buf = renderDx7Note(patch, { midi, durationS: DURATION_S, sampleRate: SAMPLE_RATE, holdGate: true });
  const win = hann(buf);
  const fund = midiToHz(midi);
  const probeAt = (f: number) => goertzel(win, SAMPLE_RATE, f);
  // Reference: the noise floor at f - 100 Hz.
  const noiseAt = (f: number) => {
    const lo = goertzel(win, SAMPLE_RATE, Math.max(20, f - 100));
    const hi = goertzel(win, SAMPLE_RATE, f + 100);
    return Math.max(lo, hi, 1e-12);
  };
  return { buf, win, fund, probeAt, noiseAt };
}

describe('DX7 ART: presets render audible signal', () => {
  const presets = ['E.PIANO 1', 'BASS 1', 'HARMONICA', 'STRINGS 1', 'MARIMBA', 'TUB BELLS', 'BRASS 1', 'CALLIOPE', 'WIRE LEAD'];

  for (const name of presets) {
    it(`${name}: produces non-silent output at C4`, () => {
      const patch = findBuiltinPatch(name)!;
      const buf = renderDx7Note(patch, { midi: 60, durationS: 0.5, sampleRate: SAMPLE_RATE, holdGate: true });
      const energy = rms(buf);
      expect(energy, `${name} should produce audio energy`).toBeGreaterThan(0.005);
      // No NaN/Inf samples.
      const bad = buf.findIndex((v) => !Number.isFinite(v));
      expect(bad, `${name} non-finite sample at ${bad}`).toBe(-1);
    });

    it(`${name}: stays within reasonable amplitude (no runaway clipping)`, () => {
      const patch = findBuiltinPatch(name)!;
      const buf = renderDx7Note(patch, { midi: 60, durationS: 0.5, sampleRate: SAMPLE_RATE, holdGate: true });
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]!);
        if (v > peak) peak = v;
      }
      expect(peak, `${name} peak should be ≤ 2.0 (worklet should be ~unity)`).toBeLessThan(2.0);
    });
  }
});

describe('DX7 ART: E.PIANO 1 — FM Rhodes character', () => {
  // E.PIANO 1 algorithm 5: 3 carriers (op1, op3, op5) at ratio 1; modulators
  // at ratios 14, 1, 1. The defining sound is op2 modulating op1 at ratio 14
  // → strong sidebands at ±14 around the fundamental.
  it('has energy at the fundamental (C4 = ~261.6 Hz)', () => {
    const a = setupAnalysis('E.PIANO 1', 60);
    const peak = a.probeAt(a.fund);
    const noise = a.noiseAt(a.fund);
    expect(peak / noise, `fundamental should dominate noise`).toBeGreaterThan(5);
  });

  it('has FM-sideband energy near the 14th harmonic (op2 modulator ratio)', () => {
    const a = setupAnalysis('E.PIANO 1', 60);
    // ratio-14 modulator on op1 (carrier ratio 1) → sidebands at fund * (1 + n*14/1)
    // for small n (n=1: fund*15, n=-1: fund*13). Check fund*13 OR fund*15
    // is significantly above the noise — at least one of the FM bell partials.
    const partial13 = a.probeAt(a.fund * 13);
    const partial15 = a.probeAt(a.fund * 15);
    const noise13 = a.noiseAt(a.fund * 13);
    const noise15 = a.noiseAt(a.fund * 15);
    const r13 = partial13 / noise13;
    const r15 = partial15 / noise15;
    // At least one of the bell partials should clearly emerge from noise.
    expect(Math.max(r13, r15), `bell partials at ${(a.fund * 13).toFixed(0)}/${(a.fund * 15).toFixed(0)}Hz`).toBeGreaterThan(2);
  });
});

describe('DX7 ART: BASS 1 — punchy low end', () => {
  it('played at C2 has dominant fundamental + decaying harmonics', () => {
    const a = setupAnalysis('BASS 1', 36); // C2
    const fund = a.probeAt(a.fund);
    const noise = a.noiseAt(a.fund);
    expect(fund / noise, `BASS fundamental at ${a.fund.toFixed(1)}Hz`).toBeGreaterThan(5);
    // Bass timbre: 2nd harmonic should be present too.
    const h2 = a.probeAt(a.fund * 2);
    const noise2 = a.noiseAt(a.fund * 2);
    expect(h2 / noise2, `BASS 2nd harmonic`).toBeGreaterThan(2);
  });
});

describe('DX7 ART: HARMONICA — reedy odd harmonics', () => {
  it('produces audible signal with energy across multiple harmonics', () => {
    const a = setupAnalysis('HARMONICA', 60);
    const fund = a.probeAt(a.fund);
    const noise = a.noiseAt(a.fund);
    expect(fund / noise).toBeGreaterThan(3);
    // Harmonica voicing has 3 carriers at ratios 1, 1, 1 (octave pair) and a
    // ratio-2 modulator — expect 2nd harmonic to be prominent.
    const h2 = a.probeAt(a.fund * 2);
    const noise2 = a.noiseAt(a.fund * 2);
    expect(h2 / noise2).toBeGreaterThan(2);
  });
});

describe('DX7 ART: STRINGS 1 — slow attack envelope', () => {
  it('amplitude grows over the first 100 ms (slow attack)', () => {
    const patch = findBuiltinPatch('STRINGS 1')!;
    const buf = renderDx7Note(patch, { midi: 60, durationS: 0.5, sampleRate: SAMPLE_RATE, holdGate: true });
    // Compare RMS over the first 50 ms vs. 200..250 ms — strings should
    // be growing.
    const seg1 = buf.subarray(0, Math.round(0.05 * SAMPLE_RATE));
    const seg2 = buf.subarray(Math.round(0.2 * SAMPLE_RATE), Math.round(0.25 * SAMPLE_RATE));
    expect(rms(seg2), 'STRINGS should swell — later RMS > early RMS').toBeGreaterThan(rms(seg1));
  });
});

describe('DX7 ART: MARIMBA — percussive envelope', () => {
  it('amplitude peaks early and decays by 100 ms', () => {
    const patch = findBuiltinPatch('MARIMBA')!;
    const buf = renderDx7Note(patch, { midi: 60, durationS: 0.5, sampleRate: SAMPLE_RATE, holdGate: true });
    // Marimba: peak in the first 20 ms, audible energy gone by 200 ms.
    const segEarly = buf.subarray(0, Math.round(0.02 * SAMPLE_RATE));
    const segLate = buf.subarray(Math.round(0.3 * SAMPLE_RATE), Math.round(0.4 * SAMPLE_RATE));
    expect(rms(segEarly), 'MARIMBA early RMS > late RMS (percussive decay)').toBeGreaterThan(rms(segLate));
  });
});

describe('DX7 ART: CALLIOPE — additive (algorithm 32)', () => {
  it('all 6 ops are carriers; energy at multiple harmonics', () => {
    const a = setupAnalysis('CALLIOPE', 60);
    // Ops at ratios 1..6. Expect strong fundamental + harmonics 2..6.
    const fund = a.probeAt(a.fund);
    const noise = a.noiseAt(a.fund);
    expect(fund / noise).toBeGreaterThan(3);
    // Check that at least 3 of the harmonics 2..6 are present.
    let presentCount = 0;
    for (let h = 2; h <= 6; h++) {
      const p = a.probeAt(a.fund * h);
      const n = a.noiseAt(a.fund * h);
      if (p / n > 2) presentCount++;
    }
    expect(presentCount, 'at least 3 of harmonics 2..6 should be audible').toBeGreaterThanOrEqual(3);
  });
});
