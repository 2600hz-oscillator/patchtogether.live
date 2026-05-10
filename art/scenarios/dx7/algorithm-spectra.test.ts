// art/scenarios/dx7/algorithm-spectra.test.ts
//
// Regression test for "algorithm switching is a no-op" — when the user
// changes the DX7 algorithm knob from e.g. 1 → 32 the rendered audio MUST
// have a different spectral signature. Prior to the fix in this PR, the
// host's `setParam('algorithm')` path was wired but the algo override
// never made it through the renderer at the right time / the same patch
// produced effectively-identical spectra under different algorithms.
//
// What we assert:
//   1. Rendering the SAME patch (same envelope, same ratios, same gate
//      timing) under two different algorithms produces audibly different
//      audio (sample-wise + spectrally).
//   2. Algorithm 32 (six independent carriers — additive organ) has a
//      richer harmonic spectrum than algorithm 1 (deep stack: only ops 1
//      and 3 are carriers, ops 2/4/5/6 are modulators) for a patch whose
//      operators are tuned to integer ratios 1..6.
//   3. The renderer's `algorithmOverride` path actually overrides the
//      patch's stored algorithm — i.e. asking for algo N produces what
//      algo N would, not what the patch's baked-in algo would.

import { describe, it, expect } from 'vitest';
import {
  renderDx7Note,
  goertzel,
  hann,
  midiToHz,
  rms,
} from '../../../packages/web/src/lib/audio/dx7-render';
import { findBuiltinPatch } from '../../../packages/web/src/lib/audio/dx7-banks';
import type { DX7Voice } from '../../../packages/web/src/lib/audio/dx7-syx';

const SAMPLE_RATE = 48000;
const DURATION_S = 0.5;

/** Sample-wise L1 distance between two equally-sized buffers, normalized
 *  by length so it's comparable across different durations. */
function l1Distance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error('length mismatch');
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
  return s / a.length;
}

/** Sweep harmonics 1..16 of `fund` and return the count whose Goertzel
 *  energy exceeds `threshold * fundamentalEnergy`. Higher count == richer
 *  spectrum. */
function harmonicRichness(buf: Float32Array, fund: number, threshold = 0.001): number {
  const win = hann(buf);
  const fundMag = goertzel(win, SAMPLE_RATE, fund);
  let count = 0;
  for (let h = 2; h <= 16; h++) {
    const f = fund * h;
    if (f > SAMPLE_RATE / 2) break;
    if (goertzel(win, SAMPLE_RATE, f) > threshold * fundMag) count++;
  }
  return count;
}

/** Build a synthetic test patch where every op has a non-zero output level
 *  and integer ratios 1..6. This makes algorithm differences maximally
 *  audible: in algo 32 all six ratios sum directly to the audio output (a
 *  rich additive spectrum); in algo 1 only ops 1 + 3 are carriers (ratios
 *  1 + 3) and the rest become modulators producing FM sidebands. The two
 *  spectra are unmistakably different. */
function makeAllOpsActivePatch(): DX7Voice {
  const op = (ratio: number) => ({
    r: [99, 50, 50, 60] as [number, number, number, number],
    l: [99, 90, 80, 0] as [number, number, number, number],
    ratio,
    detune: 0,
    detuneFactor: 1,
    level: 80,
    fixedMode: false,
    velocitySens: 0,
  });
  return {
    name: 'TEST_ALL_ACTIVE',
    algorithm: 1,
    feedback: 0,
    operators: [op(1), op(2), op(3), op(4), op(5), op(6)],
    pitchEg: { r: [99, 99, 99, 99], l: [50, 50, 50, 50] },
    lfo: { speed: 0, delay: 0, pmd: 0, amd: 0, sync: false, waveform: 0, pitchModSens: 0 },
    transpose: 24,
  };
}

describe('DX7 ART: algorithm switching changes the rendered audio', () => {
  const fund = midiToHz(60); // C4

  it('algo 1 vs algo 32 on the same patch produce sample-wise distinct buffers', () => {
    const patch = makeAllOpsActivePatch();
    const a1 = renderDx7Note(patch, {
      midi: 60, durationS: DURATION_S, sampleRate: SAMPLE_RATE, holdGate: true,
      algorithmOverride: 1,
    });
    const a32 = renderDx7Note(patch, {
      midi: 60, durationS: DURATION_S, sampleRate: SAMPLE_RATE, holdGate: true,
      algorithmOverride: 32,
    });
    expect(a1.length).toBe(a32.length);
    const d = l1Distance(a1, a32);
    // For the additive vs FM-stack pair the per-sample L1 distance is
    // dominated by their differing waveform shape; the threshold here is
    // generous (well above any numerical noise floor).
    expect(d, 'algo 1 vs 32 mean |a1[i]-a32[i]|').toBeGreaterThan(0.05);
  });

  it('algo 32 (six carriers) is spectrally richer than algo 1 (one stack)', () => {
    const patch = makeAllOpsActivePatch();
    const a1 = renderDx7Note(patch, {
      midi: 60, durationS: DURATION_S, sampleRate: SAMPLE_RATE, holdGate: true,
      algorithmOverride: 1,
    });
    const a32 = renderDx7Note(patch, {
      midi: 60, durationS: DURATION_S, sampleRate: SAMPLE_RATE, holdGate: true,
      algorithmOverride: 32,
    });
    const r1 = harmonicRichness(a1, fund);
    const r32 = harmonicRichness(a32, fund);
    // Algo 32 lets ops 1..6 (ratios 1..6) all reach the output → at least
    // 5 of the 16 sweep targets have meaningful energy. Algo 1 hides
    // ratios 2/4/5/6 inside modulator chains so only sidebands emerge,
    // and many harmonic-grid bins are far weaker.
    expect(r32, 'algo 32 harmonic count').toBeGreaterThanOrEqual(5);
    expect(r32, 'algo 32 should be richer than algo 1').toBeGreaterThan(r1);
  });

  it('all 4 sweep algorithms (1, 5, 16, 32) produce mutually distinct audio', () => {
    const patch = makeAllOpsActivePatch();
    const algos = [1, 5, 16, 32];
    const renders = algos.map((a) =>
      renderDx7Note(patch, {
        midi: 60, durationS: DURATION_S, sampleRate: SAMPLE_RATE, holdGate: true,
        algorithmOverride: a,
      }),
    );
    for (let i = 0; i < algos.length; i++) {
      for (let j = i + 1; j < algos.length; j++) {
        const d = l1Distance(renders[i]!, renders[j]!);
        expect(d, `algo ${algos[i]} vs ${algos[j]} L1 distance`).toBeGreaterThan(0.01);
      }
    }
    // Sanity: each render is non-silent.
    for (let i = 0; i < algos.length; i++) {
      expect(rms(renders[i]!), `algo ${algos[i]} non-silent`).toBeGreaterThan(0.001);
    }
  });

  it('algorithmOverride trumps the patch.algorithm field', () => {
    // E.PIANO 1 has patch.algorithm = 5. Render once at the patch's own
    // algorithm and once at 32 — the buffers must differ.
    const patch = findBuiltinPatch('E.PIANO 1')!;
    const baseline = renderDx7Note(patch, {
      midi: 60, durationS: DURATION_S, sampleRate: SAMPLE_RATE, holdGate: true,
    });
    const override = renderDx7Note(patch, {
      midi: 60, durationS: DURATION_S, sampleRate: SAMPLE_RATE, holdGate: true,
      algorithmOverride: 32,
    });
    const d = l1Distance(baseline, override);
    expect(d, 'E.PIANO 1 algo 5 vs 32 differ').toBeGreaterThan(0.001);
  });
});
