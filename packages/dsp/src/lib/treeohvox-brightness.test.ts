// packages/dsp/src/lib/treeohvox-brightness.test.ts
//
// P0 BLIND-SPOT coverage for the TREE.oh.VOX (TB-303) voice — the DIRECTION of
// its filter-envelope brightness sweep.
//
// The 303's signature is the filter env: on each note the cutoff snaps OPEN and
// closes as the decay envelope falls, so the tone sweeps from BRIGHT to DARK.
// The coarse per-module behavioral metric is a spectral centroid AVERAGED over
// the whole render — a single number. It cannot distinguish a downward sweep
// (correct) from an upward sweep, a static bright tone, or a static dark tone;
// they can all share the same mean centroid. If the env→cutoff mapping had its
// sign flipped (filter OPENS as the note decays), the average could be
// identical and the metric would pass while the instrument sounded backwards.
//
// This pins the sign + monotonicity: over successive time windows through the
// note, the spectral centroid decreases MONOTONICALLY (the filter closes).
// Uses the real TreeohvoxVoice core; pure + deterministic; < 1 s.

import { describe, it, expect } from 'vitest';
import { renderVoiceSequence, pitchCvToFreq, type VoiceParams } from './treeohvox-dsp';

const SR = 48000;

/** Exact single-bin magnitude (Goertzel, rectangular window). */
function goertzelMag(buf: Float32Array, freqHz: number): number {
  const w = (2 * Math.PI * freqHz) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const s0 = buf[i]! + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2));
}

/** Energy-weighted spectral centroid over the harmonic bank n·f0 (a saw is
 *  periodic at f0, so its energy lands on harmonics; the filter shapes their
 *  relative weights → the centroid tracks how open the filter is). */
function harmonicCentroid(buf: Float32Array, f0: number): number {
  let num = 0;
  let den = 0;
  for (let n = 1; n <= 30; n++) {
    const f = n * f0;
    if (f >= SR / 2) break;
    const mag = goertzelMag(buf, f);
    num += f * mag;
    den += mag;
  }
  return den > 0 ? num / den : 0;
}

describe('TREE.oh.VOX brightness sweep is DOWNWARD (filter closes as the env decays)', () => {
  // A wide filter-env sweep: the env opens the cutoff several-fold at the strike
  // (≈1600 Hz) and closes it over ~decayMs while staying ABOVE the filter's
  // 200 Hz floor at the dark end (≈360 Hz), so the sweep never flattens against
  // the clamp. Moderate resonance so the resonant peak follows the cutoff
  // without dominating the centroid.
  const params: VoiceParams = {
    tuneSemitones: 0,
    cutoffHz: 600,
    resonance: 0.35,
    envAmount01: 0.6,
    decayMs: 400,
    accentAmount01: 0,
    waveform: 0, // saw — strong harmonic content to shape
  };
  const f0 = pitchCvToFreq(0, params.tuneSemitones); // C4 ≈ 261.6 Hz

  it('spectral centroid decreases monotonically across the note', () => {
    const total = Math.round(SR * 0.4);
    const buf = renderVoiceSequence(params, SR, total, [
      { atSample: 0, pitchCv: 0, accented: false, gateDurationSamples: total },
    ]);

    // ~30 ms windows walking through the STEEP part of the decay (the env is
    // exponential, so the cutoff falls fastest early). The filter env
    // (decayMs 400) closes across this span while the amp env (~1230 ms) keeps
    // the note loud, so every window has real energy to measure.
    const winLen = Math.round(SR * 0.03);
    const starts = [0.015, 0.045, 0.09, 0.15].map((t) => Math.round(SR * t));
    const centroids = starts.map((s) => harmonicCentroid(buf.subarray(s, s + winLen), f0));

    // Every window must be strictly darker than the previous one.
    for (let i = 1; i < centroids.length; i++) {
      expect(
        centroids[i]!,
        `window ${i} (${centroids[i]!.toFixed(0)} Hz) should be darker than window ${i - 1} (${centroids[i - 1]!.toFixed(0)} Hz)`,
      ).toBeLessThan(centroids[i - 1]!);
    }
    // The total sweep is substantial, not float jitter: bright start ≥ 1.5× the dark end.
    expect(centroids[0]!).toBeGreaterThan(centroids[centroids.length - 1]! * 1.5);
  });

  it('a shorter decay closes the filter FASTER (earlier centroid collapse)', () => {
    const total = Math.round(SR * 0.4);
    const render = (decayMs: number) =>
      renderVoiceSequence({ ...params, decayMs }, SR, total, [
        { atSample: 0, pitchCv: 0, accented: false, gateDurationSamples: total },
      ]);
    const winLen = Math.round(SR * 0.03);
    const at = (buf: Float32Array, t: number) => harmonicCentroid(buf.subarray(Math.round(SR * t), Math.round(SR * t) + winLen), f0);

    const fast = render(150);
    const slow = render(800);
    // By 120 ms the fast-decay filter has closed much further than the slow one.
    expect(at(slow, 0.12)).toBeGreaterThan(at(fast, 0.12) * 1.2);
  });
});
