// art/scenarios/reverb/profile.test.ts
//
// AUDIO PROFILE for REVERB (algorithmic mono freeverb) — backfill batch 6,
// Faust-in-Node harness (spec §5). REVERB is Faust
// (packages/dsp/src/reverb.dsp): re.mono_freeverb with size/damp macros and a
// dry/wet mix. Single audio input; output 0 = `audio`.
//
// Category: TIME-DOMAIN FX WITH A TAIL, driven by the canonical TRANSIENT
// stimulus (drivers.toneBurst — the tape-echo FX precedent): a short C4-saw hit
// (0.1 s) then SILENCE out to 1.5 s. During the hit the dry+wet output rings
// up; after the input goes silent the reverb TAIL is the whole story — decaying
// energy while the input is zero, the defining property of a reverb.
//
// SIGNATURE output (owner §6b.2): the single `audio` output (its decay tail).

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { toneBurst, C4_HZ } from '../../setup/drivers';
import { renderFaustOffline } from '../../setup/faust-offline';

const SR = SAMPLE_RATE;
const DURATION_S = 1.5;
const BURST_S = 0.1;

const audio = toneBurst({ totalS: DURATION_S, burstS: BURST_S, shape: 'saw', freqHz: C4_HZ, amp: 0.5 });

async function renderProfile(): Promise<Record<string, Float32Array>> {
  return renderFaustOffline({
    name: 'reverb',
    totalSamples: Math.round(SR * DURATION_S),
    inputs: [audio],
    params: { size: 0.85, damp: 0.3, mix: 0.5 },
    outputs: ['audio'],
  });
}

function rms(b: Float32Array, s: number, e: number): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

describe('ART reverb / audio profile (freeverb decay tail via the Faust-in-Node harness)', () => {
  it('rings a decaying tail after the input goes silent', async () => {
    const n = Math.round(SR * DURATION_S);
    const out = (await renderProfile()).audio!;
    expect(out.length).toBe(n);
    expect(out.every(Number.isFinite)).toBe(true);

    // The input is silent after 0.1 s, yet the wet tail keeps sounding: there
    // is real energy well past the burst (this is the reverb, not passthrough).
    const tailEarly = rms(out, Math.round(0.3 * SR), Math.round(0.5 * SR));
    const tailLate = rms(out, Math.round(1.2 * SR), Math.round(1.4 * SR));
    expect(tailEarly).toBeGreaterThan(0.01);
    // …and it DECAYS: later in the tail it is quieter than earlier.
    expect(tailEarly).toBeGreaterThan(tailLate * 2);

    const again = (await renderProfile()).audio!;
    let diff = 0;
    for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(out[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the audio profile baseline (SHA-gated on reverb.dsp, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('reverb.dsp');
    const bufs = await renderProfile();
    await pinAll('reverb', srcSha, { audio: bufs.audio! });
  });
});
