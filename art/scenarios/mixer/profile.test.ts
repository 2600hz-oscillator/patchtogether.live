// art/scenarios/mixer/profile.test.ts
//
// AUDIO PROFILE for MIXER (4-channel mono summing mixer) — backfill batch 6,
// Faust-in-Node harness (spec §5). MIXER is Faust
// (packages/dsp/src/mixer.dsp): out = (in1*ch1 + … + in4*ch4) * master, each
// gain one-pole-smoothed. Faust input order = the def's ChannelMerger wiring
// [in1, in2, in3, in4]; output 0 = the `audio` bus.
//
// Category: SUMMING MIXER, driven so the DEFINING behavior shows — two
// DIFFERENT tones summed at DIFFERENT channel levels then scaled by master.
// ch1 = C4 saw @ 0.8, ch2 = G4 (392 Hz) sine @ 0.5, ch3/ch4 silent, master
// 0.9. The bus must carry BOTH tones with the sine's amplitude pinned by its
// channel × master gain — the linear-sum signature.
//
// SIGNATURE output (owner §6b.2): the single `audio` bus.

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal, C4_HZ } from '../../setup/drivers';
import { renderFaustOffline } from '../../setup/faust-offline';

const SR = SAMPLE_RATE;
const DURATION_S = 0.5;
const IN2_HZ = 392; // G4 sine

const in1 = vcoTestSignal({ totalS: DURATION_S, shape: 'saw', freqHz: C4_HZ, amp: 0.5 });
const in2 = vcoTestSignal({ totalS: DURATION_S, shape: 'sine', freqHz: IN2_HZ, amp: 0.5 });

const CH1 = 0.8;
const CH2 = 0.5;
const MASTER = 0.9;

async function renderProfile(): Promise<Record<string, Float32Array>> {
  return renderFaustOffline({
    name: 'mixer',
    totalSamples: Math.round(SR * DURATION_S),
    inputs: [in1, in2, null, null],
    params: { ch1: CH1, ch2: CH2, ch3: 1, ch4: 1, master: MASTER },
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

describe('ART mixer / audio profile (linear 4-in sum via the Faust-in-Node harness)', () => {
  it('carries both channel tones with the sine amplitude set by its channel × master gain', async () => {
    const n = Math.round(SR * DURATION_S);
    const out = (await renderProfile()).audio!;
    expect(out.length).toBe(n);
    expect(out.every(Number.isFinite)).toBe(true);

    // Analyze past the smoother settle so the gains are steady.
    const s = Math.round(0.1 * SR);
    // Both tones are present on the bus.
    expect(goertzel(out, s, n, C4_HZ)).toBeGreaterThan(0.05); // saw fundamental
    const sineMag = goertzel(out, s, n, IN2_HZ);
    // The sine is a pure 0.5-amp tone → its bus magnitude is 0.5 × ch2 × master
    // = 0.5 × 0.5 × 0.9 = 0.225 (linear-sum signature, not a saturating mix).
    expect(sineMag).toBeGreaterThan(0.2);
    expect(sineMag).toBeLessThan(0.25);

    const again = (await renderProfile()).audio!;
    let diff = 0;
    for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(out[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the audio profile baseline (SHA-gated on mixer.dsp, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('mixer.dsp');
    const bufs = await renderProfile();
    await pinAll('mixer', srcSha, { audio: bufs.audio! });
  });
});
