// art/scenarios/attenumix/profile.test.ts
//
// AUDIO PROFILE for ATTENUMIX (4-channel attenuating mixer) (backfill
// batch 4 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (capture.ts + drivers.ts + worklet.ts).
//
// Category: MIXER / PROCESSOR — driven by three spectrally distinct
// canonical test tones plus the module's OTHER defining input class, a CV
// on an attenuator:
//   in1 = C4 saw   (att1 0.8)             — the harmonic comb
//   in2 = 660 Hz sine (att2 0.5) + cv2 = 2 Hz sine ±0.5 — the attenuator-CV
//         passthrough semantic: knob+CV sweeps att2 across the FULL 0..1
//         clamp range → a full-depth 2 Hz tremolo on channel 2
//   in3 = 1 kHz sine (att3 0.4)           — the off-grid treble probe
//   in4 unpatched (att4 at its 0 default)
//   master 1.5 — pushed past unity so the mix's tanh soft-clip (the module's
//   "musical, not digital" saturation signature) is audibly recruited.
//
// Rendering path: the REAL worklet processor class via the shared shim
// loader — attenumix.ts is fully self-contained pure math (clamp + multiply
// + tanh), no RNG, no smoothing state.
//
// SIGNATURE outputs (owner decision §6b.2): `mix` (the tanh-saturated
// master bus) and `out2` (the CV-swept channel — a genuinely different
// signal: the tremolo documents the knob+CV clamp law). out1/out3 are plain
// static-gain copies of their drivers (proven exactly below, not pinned);
// out4 is silence.
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

const in1 = vcoTestSignal({ totalS: DURATION_S, shape: 'saw', amp: 0.5 });
const in2 = vcoTestSignal({ totalS: DURATION_S, shape: 'sine', freqHz: IN2_HZ, amp: 0.5 });
const in3 = vcoTestSignal({ totalS: DURATION_S, shape: 'sine', freqHz: IN3_HZ, amp: 0.5 });
const cv2 = vcoTestSignal({ totalS: DURATION_S, shape: 'sine', freqHz: TREM_HZ, amp: 0.5 });

const ATT1 = 0.8;
const ATT2 = 0.5;
const ATT3 = 0.4;
const MASTER = 1.5;

async function renderProfile(): Promise<Record<string, Float32Array>> {
  const Proc = await captureWorkletProcessor(
    'attenumix',
    () => import('../../../packages/dsp/src/attenumix'),
    SR,
  );
  const proc = new Proc();
  const n = Math.round(SR * DURATION_S);
  return renderWorklet(proc, {
    totalSamples: n,
    // inputs[0..3] = in1..in4, inputs[4..7] = cv1..cv4.
    inputs: [in1, in2, in3, null, null, cv2, null, null],
    params: { att1: ATT1, att2: ATT2, att3: ATT3, att4: 0, master: MASTER },
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

describe('ART attenumix / audio profile (saw + tremolo sine + 1 kHz into a tanh-saturated master)', () => {
  it('attenuates per channel, sweeps ch2 with CV, and soft-clips the hot mix', async () => {
    const bufs = await renderProfile();
    const n = Math.round(SR * DURATION_S);
    const mix = bufs.mix!;
    expect(mix.length).toBe(n);
    expect(mix.every(Number.isFinite)).toBe(true);

    // out1/out3: EXACTLY the driver × the (float32) attenuator — the direct
    // outs are static-gain copies, which is why they are not pinned.
    for (const [name, src, att] of [
      ['out1', in1, ATT1],
      ['out3', in3, ATT3],
    ] as const) {
      const out = bufs[name]!;
      for (let i = 0; i < n; i++) {
        const expected = Math.fround(src[i]! * Math.fround(att));
        if (out[i]! !== expected) {
          throw new Error(`${name} sample ${i}: ${out[i]} != ${expected}`);
        }
      }
    }
    // out4: unpatched channel at att 0 → exact silence.
    expect(bufs.out4!.every((v) => v === 0)).toBe(true);

    // out2 is a FULL-DEPTH 2 Hz tremolo: att2 = clamp(0.5 + cv2) touches 1
    // at t = 0.125 s and 0 at t = 0.375 s (sin phase of the 2 Hz CV).
    const out2 = bufs.out2!;
    const loud = rms(out2, Math.round(0.1 * SR), Math.round(0.15 * SR));
    const quiet = rms(out2, Math.round(0.35 * SR), Math.round(0.4 * SR));
    expect(loud).toBeGreaterThan(0.25);
    expect(quiet).toBeLessThan(loud / 10);

    // The mix carries all three tones…
    expect(goertzel(mix, 0, n, C4_HZ)).toBeGreaterThan(0.1); // saw fundamental
    expect(goertzel(mix, 0, n, IN2_HZ)).toBeGreaterThan(0.05);
    expect(goertzel(mix, 0, n, IN3_HZ)).toBeGreaterThan(0.05);

    // …and the tanh keeps it inside ±1 even though the pre-tanh drive
    // (sum × master) clearly exceeds 1 — the saturation IS engaged.
    let peak = 0;
    let drive = 0;
    for (let i = 0; i < n; i++) {
      peak = Math.max(peak, Math.abs(mix[i]!));
      drive = Math.max(
        drive,
        Math.abs((bufs.out1![i]! + out2[i]! + bufs.out3![i]! + bufs.out4![i]!) * MASTER),
      );
    }
    expect(drive).toBeGreaterThan(1.1);
    expect(peak).toBeLessThan(1);
    expect(peak).toBeGreaterThan(0.7);

    // Deterministic re-render is bit-identical (stateless per-sample math).
    const again = (await renderProfile()).mix!;
    let diff = 0;
    for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(mix[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the mix + out2 profile baselines (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('attenumix.ts');
    const bufs = await renderProfile();
    await pinAll('attenumix', srcSha, { mix: bufs.mix!, out2: bufs.out2! });
  });
});
