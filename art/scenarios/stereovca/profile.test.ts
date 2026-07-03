// art/scenarios/stereovca/profile.test.ts
//
// AUDIO PROFILE for STEREOVCA (stereo VCA + ring modulator) — backfill batch 6.
// STEREOVCA is a SELF-CONTAINED pure-math TS worklet
// (packages/dsp/src/stereovca.ts: out = in * (strength + offset) * level, no
// WASM / RNG / state), so the highest-fidelity render is the SHIPPING
// AudioWorkletProcessor pumped through process() (the veils/attenumix pattern,
// §1.3 #2 — art/setup/worklet.ts). Worklet input order: [in_l, in_r,
// strength_l, strength_r]; outputs [out_l, out_r].
//
// Category: STEREO VCA + RING MOD, driven so BOTH defining behaviors show on
// the two channels at once (the module has no mode toggle — the difference is
// purely the strength signal's frequency content):
//   out_l = in_l × a SLOW 3 Hz strength  → a VCA TREMOLO (amplitude modulation)
//   out_r = in_r × a 300 Hz AUDIO-RATE strength → a RING MODULATOR (the input
//           fundamental is replaced by sum/difference sidebands)
// Same C4 saw into both audio inputs; only the strength content differs.
//
// SIGNATURE outputs (owner §6b.2 — distinct): out_l (VCA) and out_r (ring mod)
// are genuinely different signals, both pinned.

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal, C4_HZ } from '../../setup/drivers';
import { captureWorkletProcessor, renderWorklet } from '../../setup/worklet';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;
const TREM_HZ = 3;
const RING_HZ = 300;

const inSaw = vcoTestSignal({ totalS: DURATION_S, shape: 'saw', freqHz: C4_HZ, amp: 0.5 });
const strengthSlow = vcoTestSignal({ totalS: DURATION_S, shape: 'sine', freqHz: TREM_HZ, amp: 1.0 });
const strengthAudio = vcoTestSignal({ totalS: DURATION_S, shape: 'sine', freqHz: RING_HZ, amp: 1.0 });

async function renderProfile(): Promise<Record<string, Float32Array>> {
  const Proc = await captureWorkletProcessor('stereovca', () => import('../../../packages/dsp/src/stereovca'), SR);
  const proc = new Proc();
  return renderWorklet(proc, {
    totalSamples: Math.round(SR * DURATION_S),
    inputs: [inSaw, inSaw, strengthSlow, strengthAudio], // in_l,in_r,strength_l,strength_r
    params: { level: 1, offset: 0 },
    outputs: ['out_l', 'out_r'],
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

function rms(b: Float32Array, s: number, e: number): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

describe('ART stereovca / audio profile (VCA tremolo + ring mod on the two channels)', () => {
  it('amplitude-modulates the left channel and ring-modulates the right', async () => {
    const n = Math.round(SR * DURATION_S);
    const { out_l: outL, out_r: outR } = await renderProfile();
    expect(outL.length).toBe(n);

    // out_l = saw × slow 3 Hz strength: a full-depth VCA tremolo. Loud when the
    // 3 Hz strength is near ±1, quiet when it crosses zero. The first strength
    // peak is at t≈1/12 s (~0.083 s), the first zero after that at t≈1/6 s.
    const loud = rms(outL, Math.round(0.07 * SR), Math.round(0.095 * SR));
    const quiet = rms(outL, Math.round(0.16 * SR), Math.round(0.175 * SR));
    expect(loud).toBeGreaterThan(quiet * 3);

    // out_r = saw × 300 Hz carrier: RING MOD. The C4 fundamental (261.6 Hz) is
    // multiplied away and reappears as sum/difference sidebands (|261.6 ± 300| =
    // 38.4 and 561.6 Hz). So the fundamental is SUPPRESSED and a sum sideband
    // APPEARS — both signatures at once.
    expect(goertzel(outR, 0, n, C4_HZ)).toBeLessThan(0.02);           // fundamental gone
    expect(goertzel(outR, 0, n, C4_HZ + RING_HZ)).toBeGreaterThan(0.05); // 561.6 sideband

    // The two outputs are genuinely different (VCA vs ring mod).
    let sameCount = 0;
    for (let i = 0; i < n; i++) if (outL[i] === outR[i]) sameCount++;
    expect(sameCount).toBeLessThan(n / 2);

    // Deterministic (stateless per-sample math).
    const again = await renderProfile();
    let d = 0;
    for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(outL[i]! - again.out_l![i]!));
    expect(d).toBe(0);
  });

  it('pins out_l + out_r profile baselines (SHA-gated on stereovca.ts, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('stereovca.ts');
    const b = await renderProfile();
    await pinAll('stereovca', srcSha, { out_l: b.out_l!, out_r: b.out_r! });
  });
});
