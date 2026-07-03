// art/scenarios/filter/profile.test.ts
//
// AUDIO PROFILE for FILTER (multi-mode resonant SVF) — backfill batch 6,
// Faust-in-Node harness (spec §5). FILTER is Faust
// (packages/dsp/src/filter.dsp): LP/HP/BP resonant modes, cutoff CV mapped
// -1..+1 → ±5 octaves around the knob by the DSP itself. Faust input order =
// the def's ChannelMerger wiring [audio, cutoffCv, resCv]; output 0 = `audio`.
//
// Category: FILTER, driven so the DEFINING behavior shows — a resonant
// LOWPASS SWEEP. A harmonically-rich C4 saw is filtered while cutoffCv ramps
// -1 → +1 across the render, so the cutoff climbs ~5 octaves around a 400 Hz
// knob: high harmonics start heavily attenuated (cutoff below them) and open
// up as the sweep rises — the iconic diagonal filter-sweep spectrogram.
// resonance high (0.7) so the sweeping resonant peak is prominent.
//
// SIGNATURE output (owner §6b.2): the single `audio` output.

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal, C4_HZ } from '../../setup/drivers';
import { renderFaustOffline } from '../../setup/faust-offline';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;

const audio = vcoTestSignal({ totalS: DURATION_S, shape: 'saw', freqHz: C4_HZ, amp: 0.5 });
// Linear cutoff CV ramp -1 → +1 over the whole render (the sweep).
const cutoffCv = (() => {
  const n = Math.round(SR * DURATION_S);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = -1 + (2 * i) / (n - 1);
  return b;
})();

async function renderProfile(): Promise<Record<string, Float32Array>> {
  return renderFaustOffline({
    name: 'filter',
    totalSamples: Math.round(SR * DURATION_S),
    inputs: [audio, cutoffCv, null], // [audio, cutoffCv, resCv]
    params: { cutoff: 400, resonance: 0.7, mode: 0 }, // LP
    outputs: ['audio'],
  });
}

/** Goertzel magnitude (2/N-normalized) of freqHz over buf[s, e). */
function goertzel(buf: Float32Array, s: number, e: number, freqHz: number): number {
  const N = e - s;
  const w = (2 * Math.PI * freqHz) / SR;
  const coeff = 2 * Math.cos(w);
  let q1 = 0;
  let q2 = 0;
  for (let i = s; i < e; i++) {
    const q0 = coeff * q1 - q2 + buf[i]!;
    q2 = q1;
    q1 = q0;
  }
  const re = q1 - q2 * Math.cos(w);
  const im = q2 * Math.sin(w);
  return (2 / N) * Math.sqrt(re * re + im * im);
}

describe('ART filter / audio profile (resonant lowpass sweep via the Faust-in-Node harness)', () => {
  it('opens a high harmonic as the cutoff CV sweeps up', async () => {
    const n = Math.round(SR * DURATION_S);
    const out = (await renderProfile()).audio!;
    expect(out.length).toBe(n);
    expect(out.every(Number.isFinite)).toBe(true);

    // Pick the 8th harmonic of C4 (~2093 Hz). Early in the sweep the cutoff is
    // FAR below it (heavy attenuation); late in the sweep the cutoff has
    // climbed past it (it passes). So its energy in the last fifth must be
    // dramatically higher than in the first fifth — the lowpass-sweep signature.
    const h8 = 8 * C4_HZ;
    const early = goertzel(out, 0, Math.round(0.2 * SR), h8);
    const late = goertzel(out, Math.round(0.8 * SR), n, h8);
    expect(late).toBeGreaterThan(early * 5);

    // The fundamental survives throughout (it's always below the cutoff after
    // the first moments) — the filter is a LOWpass, not a notch.
    expect(goertzel(out, Math.round(0.3 * SR), n, C4_HZ)).toBeGreaterThan(0.05);

    // Byte-deterministic re-render.
    const again = (await renderProfile()).audio!;
    let diff = 0;
    for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(out[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the audio profile baseline (SHA-gated on filter.dsp, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('filter.dsp');
    const bufs = await renderProfile();
    await pinAll('filter', srcSha, { audio: bufs.audio! });
  });
});
