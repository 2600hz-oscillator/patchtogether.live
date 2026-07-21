// packages/web/src/lib/audio/dx7-sideband.test.ts
//
// P0 BLIND-SPOT coverage for the DX7 FM voice renderer (renderDx7Note). The
// coarse per-module behavioral metric is RMS/centroid over the whole render;
// it cannot see the two FM properties that actually make DX7 a DX7:
//
//   (1) FM SIDEBAND GROWTH. Raising a modulator's output level (the modulation
//       index) must push energy OUT of the carrier into higher sidebands — the
//       whole point of FM synthesis. A bug that ignored the modulator (index
//       stuck at 0) would render a plain sine at the same RMS. We pin that the
//       spectral centroid of a single modulator→carrier pair rises MONOTONICALLY
//       with modulator level.
//
//   (2) PITCH MAPPING. note → Hz must be 1 V/oct correct: a note an octave up
//       is exactly 2× the fundamental. RMS/centroid is pitch-agnostic. We pin
//       f0(midi=72) / f0(midi=60) ≈ 2 from the rendered spectrum.
//
// Deterministic, pure array math, no worklet runtime. Uses a minimal hand-built
// 2-operator patch (op2 modulates op1; ops 3–6 silent) on algorithm 1.

import { describe, it, expect } from 'vitest';
import { renderDx7Note, goertzel } from './dx7-render';
import type { DX7Voice, DX7OpData } from './dx7-syx';

const SR = 48000;

/** A silent operator (level 0 → contributes nothing, modulates nothing). */
function silentOp(): DX7OpData {
  return {
    r: [99, 99, 99, 99],
    l: [0, 0, 0, 0],
    ratio: 1,
    level: 0,
    detune: 0,
    detuneFactor: 1,
    velocitySens: 0,
    fixedMode: false,
  };
}

/** A sustained operator: instant attack, all levels full → holds at unity. */
function sustainedOp(level: number, ratio = 1): DX7OpData {
  return {
    r: [99, 99, 99, 99], // fastest rates → snap to level
    l: [99, 99, 99, 99], // every segment target = full → stable sustain
    ratio,
    level, // OUTPUT level 0..99 → the FM modulation index when used as a modulator
    detune: 0,
    detuneFactor: 1,
    velocitySens: 0,
    fixedMode: false,
  };
}

/**
 * Minimal 2-op FM voice on ALGORITHM 1 (op1 carrier, modSrcs[op1]=[op2]).
 * op1 is a full-level carrier; op2 modulates it at `modLevel`; op3..6 silent.
 */
function twoOpVoice(modLevel: number): DX7Voice {
  return {
    name: 'FMTEST',
    algorithm: 1,
    feedback: 0,
    operators: [
      sustainedOp(99), // op1 carrier
      sustainedOp(modLevel), // op2 modulator (index knob)
      silentOp(),
      silentOp(),
      silentOp(),
      silentOp(),
    ],
    pitchEg: { r: [99, 99, 99, 99], l: [50, 50, 50, 50] },
    lfo: { speed: 0, delay: 0, pmd: 0, amd: 0, sync: false, waveform: 0, pitchModSens: 0 },
    transpose: 24, // SYX convention: 24 = no transpose
  };
}

const C4_HZ = 261.625565;

/** Energy-weighted spectral centroid over the harmonic bank n·f0, n=1..20.
 *  (carrier ratio = modulator ratio = 1 → FM sidebands land on harmonics of f0.) */
function harmonicCentroid(buf: Float32Array, f0: number): number {
  let num = 0;
  let den = 0;
  for (let n = 1; n <= 20; n++) {
    const f = n * f0;
    if (f >= SR / 2) break;
    const mag = Math.sqrt(Math.max(0, goertzel(buf, SR, f)));
    num += f * mag;
    den += mag;
  }
  return den > 0 ? num / den : 0;
}

/** Dominant frequency: argmax of the Goertzel magnitude over a coarse grid. */
function dominantHz(buf: Float32Array, lo: number, hi: number, step: number): number {
  let bestF = lo;
  let bestMag = -1;
  for (let f = lo; f <= hi; f += step) {
    const mag = goertzel(buf, SR, f);
    if (mag > bestMag) {
      bestMag = mag;
      bestF = f;
    }
  }
  return bestF;
}

describe('DX7 FM: sideband growth with modulation index', () => {
  it('spectral centroid rises MONOTONICALLY as the modulator level increases', () => {
    // Levels chosen across the DX7 op-level curve (levelToAmp is exponential):
    // ~indices 0.05 → 3.1 rad, a clean low→high FM spread.
    const levels = [55, 68, 80, 90, 99];
    const centroids = levels.map((lvl) => {
      const buf = renderDx7Note(twoOpVoice(lvl), { midi: 60, durationS: 0.25, sampleRate: SR });
      // Skip the (near-instant) attack; measure the sustained tone.
      return harmonicCentroid(buf.subarray(SR * 0.05), C4_HZ);
    });
    // Strictly increasing: each step must add higher sidebands.
    for (let i = 1; i < centroids.length; i++) {
      expect(centroids[i]!, `centroid[${i}] > centroid[${i - 1}]`).toBeGreaterThan(centroids[i - 1]!);
    }
    // And the span is real, not float jitter: the brightest is well above the darkest.
    expect(centroids[centroids.length - 1]!).toBeGreaterThan(centroids[0]! * 1.3);
  });

  it('a modulator at level 0 is a plain carrier (energy stays at f0)', () => {
    // Index 0 → no sidebands: essentially all energy in the fundamental.
    const buf = renderDx7Note(twoOpVoice(0), { midi: 60, durationS: 0.25, sampleRate: SR });
    const b = buf.subarray(SR * 0.05);
    const fund = Math.sqrt(goertzel(b, SR, C4_HZ));
    const h2 = Math.sqrt(goertzel(b, SR, 2 * C4_HZ));
    const h3 = Math.sqrt(goertzel(b, SR, 3 * C4_HZ));
    expect(fund).toBeGreaterThan(20 * (h2 + h3 + 1e-9)); // carrier dominates
  });
});

describe('DX7 pitch mapping: octave = 2× f0', () => {
  it('note +12 semitones renders exactly one octave up', () => {
    // Low modulation index → an essentially pure carrier, so the dominant bin
    // IS the fundamental and the octave ratio is unambiguous.
    const v = twoOpVoice(30);
    const lo = renderDx7Note(v, { midi: 60, durationS: 0.2, sampleRate: SR }); // C4
    const hi = renderDx7Note(v, { midi: 72, durationS: 0.2, sampleRate: SR }); // C5

    const f0Lo = dominantHz(lo.subarray(SR * 0.05), 180, 360, 1); // around 261.6
    const f0Hi = dominantHz(hi.subarray(SR * 0.05), 380, 680, 1); // around 523.3

    expect(f0Lo).toBeGreaterThan(255);
    expect(f0Lo).toBeLessThan(268);
    expect(f0Hi / f0Lo).toBeCloseTo(2, 1); // one octave = 2×, within grid resolution
  });
});
