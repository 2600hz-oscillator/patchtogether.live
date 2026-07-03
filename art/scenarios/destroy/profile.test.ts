// art/scenarios/destroy/profile.test.ts
//
// AUDIO PROFILE for DESTROY (bitcrusher) — backfill batch 6, Faust-in-Node
// harness (spec §5). DESTROY is Faust (packages/dsp/src/destroy.dsp):
// sample-rate reduction (decimation — ba.sAndH holds the input for `decimate`
// samples) + bit-depth reduction (quantize to 2^bits levels), dry/wet. Single
// audio input; output 0 = `audio`. Its `decimate`/`bits`/`wet` params are each
// si.smoo-smoothed with a ~sub-second time constant, so the render is 1.5 s and
// the destruction is asserted over the SETTLED tail (t ≥ 1.0 s), where the
// knobs have reached their crush values.
//
// Category: DESTRUCTIVE FX, driven by a CLEAN C4 sine so the destruction is
// unambiguous: a pure sine carries thousands of distinct sample values and no
// harmonics; the crushed tail (decimate=8, bits=3, wet=1) collapses to a
// COARSE quantization grid (~a dozen distinct levels) and grows strong odd
// harmonics — the bitcrush signature.
//
// SIGNATURE output (owner §6b.2): the single `audio` output.

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal, C4_HZ } from '../../setup/drivers';
import { renderFaustOffline } from '../../setup/faust-offline';

const SR = SAMPLE_RATE;
const DURATION_S = 1.5;

const audio = vcoTestSignal({ totalS: DURATION_S, shape: 'sine', freqHz: C4_HZ, amp: 0.5 });

async function renderProfile(): Promise<Record<string, Float32Array>> {
  return renderFaustOffline({
    name: 'destroy',
    totalSamples: Math.round(SR * DURATION_S),
    inputs: [audio],
    params: { decimate: 8, bits: 3, wet: 1 },
    outputs: ['audio'],
  });
}

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

describe('ART destroy / audio profile (decimation + bitcrush via the Faust-in-Node harness)', () => {
  it('collapses a clean sine onto a coarse quantization grid and adds harmonics', async () => {
    const n = Math.round(SR * DURATION_S);
    const out = (await renderProfile()).audio!;
    expect(out.length).toBe(n);
    expect(out.every(Number.isFinite)).toBe(true);

    // Settled crush window (params have smoothed in by ~1 s).
    const s = Math.round(1.0 * SR);
    // Coarse quantization: the crushed tail takes only a HANDFUL of distinct
    // sample values, where the pure input sine over the same window has
    // thousands. (Rounded to 5 dp to fold FP noise.)
    const levels = new Set<string>();
    for (let i = s; i < n; i++) levels.add(out[i]!.toFixed(5));
    expect(levels.size).toBeLessThan(40);

    // Real destruction: the output differs substantially from the input sine.
    let dsum = 0;
    let peak = 0;
    for (let i = s; i < n; i++) {
      dsum += (out[i]! - audio[i]!) ** 2;
      peak = Math.max(peak, Math.abs(out[i]!));
    }
    expect(Math.sqrt(dsum / (n - s))).toBeGreaterThan(0.03);
    expect(peak).toBeGreaterThan(0.3);
    expect(peak).toBeLessThan(0.55);

    // Quantization/decimation inject odd harmonics the pure sine never had.
    expect(goertzel(out, s, n, 3 * C4_HZ)).toBeGreaterThan(0.005);

    // Byte-deterministic re-render.
    const again = (await renderProfile()).audio!;
    let diff = 0;
    for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(out[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the audio profile baseline (SHA-gated on destroy.dsp, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('destroy.dsp');
    const bufs = await renderProfile();
    await pinAll('destroy', srcSha, { audio: bufs.audio! });
  });
});
