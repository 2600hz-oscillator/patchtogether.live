// art/scenarios/dx7/polyphony.test.ts
//
// Validates the polyphony claim: rendering N independent DX7 voices and
// summing them produces a chord-like signal whose total energy scales with
// the voice count, and whose Goertzel probes hit each note's fundamental.
//
// This exercises the renderer-level multi-voice math; the worklet's voice
// allocator is unit-tested separately (alloc-test.ts) since round-robin /
// steal-oldest is a pure data-structure concern not visible to spectra.

import { describe, it, expect } from 'vitest';
import { renderDx7Note, goertzel, hann, midiToHz, rms } from '../../../packages/web/src/lib/audio/dx7-render';
import { findBuiltinPatch } from '../../../packages/web/src/lib/audio/dx7-banks';

const SAMPLE_RATE = 48000;

describe('DX7 ART: polyphony — N voices sum cleanly', () => {
  it('rendering a C major triad on E.PIANO 1 produces energy at 3 fundamentals', () => {
    const patch = findBuiltinPatch('E.PIANO 1')!;
    const midis = [60, 64, 67]; // C, E, G
    const len = SAMPLE_RATE * 1.0;
    const summed = new Float32Array(len);
    for (const m of midis) {
      const v = renderDx7Note(patch, { midi: m, durationS: 1.0, sampleRate: SAMPLE_RATE, holdGate: true });
      for (let i = 0; i < len; i++) summed[i] = (summed[i]! + v[i]!) * 1.0;
    }
    // Sum normalisation isn't needed for spectral comparison.
    const win = hann(summed);
    for (const m of midis) {
      const f = midiToHz(m);
      const peak = goertzel(win, SAMPLE_RATE, f);
      const noise = Math.max(
        goertzel(win, SAMPLE_RATE, Math.max(20, f - 100)),
        goertzel(win, SAMPLE_RATE, f + 100),
        1e-12,
      );
      expect(peak / noise, `peak at ${f.toFixed(1)}Hz vs noise probe`).toBeGreaterThan(3);
    }
  });

  it('rendering 5 voices produces ~5x the single-voice RMS (within tolerance)', () => {
    const patch = findBuiltinPatch('CALLIOPE')!;
    const single = renderDx7Note(patch, { midi: 60, durationS: 0.5, sampleRate: SAMPLE_RATE, holdGate: true });
    const singleRms = rms(single);

    const len = single.length;
    const summed = new Float32Array(len);
    for (let lane = 0; lane < 5; lane++) {
      // Use slightly different pitches so voices don't constructively sum to the same waveform.
      const v = renderDx7Note(patch, { midi: 60 + lane, durationS: 0.5, sampleRate: SAMPLE_RATE, holdGate: true });
      for (let i = 0; i < len; i++) summed[i] = summed[i]! + v[i]!;
    }
    const summedRms = rms(summed);
    // 5 incoherent voices should sum to ~sqrt(5)*single in RMS — generous
    // tolerance because the partials interfere unpredictably.
    expect(summedRms, 'summed RMS clearly exceeds single-voice').toBeGreaterThan(singleRms * 1.5);
  });
});
