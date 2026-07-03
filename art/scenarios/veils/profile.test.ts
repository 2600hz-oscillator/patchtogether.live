// art/scenarios/veils/profile.test.ts
//
// AUDIO PROFILE for VEILS (quad VCA + summing mix, Mutable-Veils-style)
// (backfill batch 5 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared REAL-WORKLET capture harness (capture.ts + drivers.ts + worklet.ts).
//
// The 8th module of the batch, and the batch's one WORKLET-class profile
// (pattern §1.3 #2 — the attenumix precedent): veils.ts is self-contained
// pure math (max/square/tanh, no RNG, no state), so the SHIPPING
// AudioWorkletProcessor is pumped directly through process() in 128-sample
// blocks. Zero mirror, zero drift.
//
// Category: QUAD VCA + MIXER, driven so BOTH defining behaviors show:
//   ch1: C4 saw, gain 2 (max) + a ±1 CV tremolo, LINEAR response → a direct
//        out that both SWEEPS with the CV and pushes ABOVE unity (out1 peaks
//        ~1.5): "Veils is useful because gain isn't clipped at 1.0" — the
//        direct outs are PRE-clip, so a >1 VCA gain is audible on out1.
//   ch2: 660 Hz sine, gain 1, linear — a plain unity VCA.
//   ch3: 1 kHz sine, gain 1.4, EXPONENTIAL response → s = 1.4² = 1.96, so
//        out3 is louder than a linear 1.4 would give (the expo-curve signature).
//   ch4: unpatched, gain 0 → silence.
//   mix = tanh(out1+out2+out3+out4): the summed bus is driven hot (pre-tanh
//        sum > 1), so the tanh soft-clip is genuinely engaged yet mix stays
//        inside ±1 — the "musical when pushed" overdrive.
//
// SIGNATURE outputs (owner decision §6b.2): `mix` (the tanh-saturated master)
// and `out1` (the >unity, CV-swept direct VCA out — a genuinely different
// signal). out2/out3 are proven inline; out4 is silence.
//
// The .sha pins the (self-contained) worklet entry.

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { C4_HZ, vcoTestSignal } from '../../setup/drivers';
import { captureWorkletProcessor, renderWorklet } from '../../setup/worklet';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;
const IN2_HZ = 660;
const IN3_HZ = 1000;
const TREM_HZ = 2;

const GAIN1 = 2; // channel-1 knob at max…
const GAIN3 = 1.4; // …channel-3 knob (squared by the expo curve → 1.96)

const in1 = vcoTestSignal({ totalS: DURATION_S, shape: 'saw', amp: 0.5 });
const in2 = vcoTestSignal({ totalS: DURATION_S, shape: 'sine', freqHz: IN2_HZ, amp: 0.5 });
const in3 = vcoTestSignal({ totalS: DURATION_S, shape: 'sine', freqHz: IN3_HZ, amp: 0.5 });
// A ±1 CV tremolo on channel 1: raw gain sweeps 2±1 = [1, 3] (never ≤ 0).
const cv1 = vcoTestSignal({ totalS: DURATION_S, shape: 'sine', freqHz: TREM_HZ, amp: 1.0 });

async function renderProfile(): Promise<Record<string, Float32Array>> {
  const Proc = await captureWorkletProcessor('veils', () => import('../../../packages/dsp/src/veils'), SR);
  const proc = new Proc();
  const n = Math.round(SR * DURATION_S);
  return renderWorklet(proc, {
    totalSamples: n,
    // inputs[0..3] = in1..in4, inputs[4..7] = cv1..cv4.
    inputs: [in1, in2, in3, null, cv1, null, null, null],
    params: {
      gain1: GAIN1, gain2: 1, gain3: GAIN3, gain4: 0,
      resp1: 0, resp2: 0, resp3: 1, resp4: 0, // ch3 exponential, rest linear
    },
    outputs: ['out1', 'out2', 'out3', 'out4', 'mix'],
  });
}

/** Goertzel magnitude (normalized 2/N) of freqHz over buf[s, e). */
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

describe('ART veils / audio profile (>unity CV-swept VCA + expo channel into a tanh-saturated mix)', () => {
  it('drives a direct out above unity, squares the expo channel, and soft-clips the hot mix', async () => {
    const bufs = await renderProfile();
    const n = Math.round(SR * DURATION_S);
    const out1 = bufs.out1!;
    const mix = bufs.mix!;
    expect(mix.length).toBe(n);
    expect(mix.every(Number.isFinite)).toBe(true);

    // out1 = in1 × max(0, gain1 + cv1), sample-accurate (linear response).
    for (let i = 0; i < n; i++) {
      const s = Math.max(0, Math.fround(GAIN1 + cv1[i]!));
      const expected = Math.fround(in1[i]! * s);
      if (Math.abs(out1[i]! - expected) > 1e-6) {
        throw new Error(`out1 sample ${i}: ${out1[i]} != ${expected}`);
      }
    }

    // The direct out is PRE-clip: with gain+CV up to 3× a 0.5 saw, out1 peaks
    // well ABOVE unity (a plain 0..1 VCA could never) — the Veils signature.
    let out1Peak = 0;
    for (let i = 0; i < n; i++) out1Peak = Math.max(out1Peak, Math.abs(out1[i]!));
    expect(out1Peak).toBeGreaterThan(1.0);

    // …and it's a full-depth 2 Hz tremolo: loud when cv1 ≈ +1 (t≈0.125 s,
    // gain ≈ 3), quiet when cv1 ≈ −1 (t≈0.375 s, gain ≈ 1).
    const loud = rms(out1, Math.round(0.1 * SR), Math.round(0.15 * SR));
    const quiet = rms(out1, Math.round(0.35 * SR), Math.round(0.4 * SR));
    expect(loud).toBeGreaterThan(quiet * 2);

    // The expo channel (ch3) squares its 1.4 knob → 1.96, so out3 peaks near
    // 0.5 × 1.96 ≈ 0.98 — clearly hotter than a LINEAR 1.4 (which would give
    // ≈ 0.70). This is the exponential-response signature.
    let out3Peak = 0;
    for (let i = 0; i < n; i++) out3Peak = Math.max(out3Peak, Math.abs(bufs.out3![i]!));
    expect(out3Peak).toBeGreaterThan(0.9);
    expect(out3Peak).toBeLessThan(GAIN3 * GAIN3 * 0.5 + 1e-3);

    // ch4 is unpatched at gain 0 → exact silence.
    expect(bufs.out4!.every((v) => v === 0)).toBe(true);

    // The mix carries the two sine tones…
    expect(goertzel(mix, 0, n, IN2_HZ)).toBeGreaterThan(0.05);
    expect(goertzel(mix, 0, n, IN3_HZ)).toBeGreaterThan(0.05);

    // …the pre-tanh sum clearly exceeds 1 (soft-clip engaged), yet tanh keeps
    // the mix strictly inside ±1 and audibly hot.
    let mixPeak = 0;
    let drive = 0;
    for (let i = 0; i < n; i++) {
      mixPeak = Math.max(mixPeak, Math.abs(mix[i]!));
      drive = Math.max(drive, Math.abs(out1[i]! + bufs.out2![i]! + bufs.out3![i]! + bufs.out4![i]!));
    }
    expect(drive).toBeGreaterThan(1.1);
    expect(mixPeak).toBeLessThan(1);
    expect(mixPeak).toBeGreaterThan(0.7);

    // Deterministic re-render is bit-identical (stateless per-sample math).
    const again = (await renderProfile()).mix!;
    let diff = 0;
    for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(mix[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the mix + out1 profile baselines (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('veils.ts');
    const bufs = await renderProfile();
    await pinAll('veils', srcSha, { mix: bufs.mix!, out1: bufs.out1! });
  });
});
