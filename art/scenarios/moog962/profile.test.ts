// art/scenarios/moog962/profile.test.ts
//
// AUDIO PROFILE for MOOG 962 (sequential switch) (backfill batch 3 —
// spec §4.1/§4.3, .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md),
// through the shared capture harness (capture.ts + drivers.ts + worklet.ts).
//
// Category: clocked SWITCH utility — SHIFT is driven by the canonical
// 240 BPM CLOCK (spec §4.2: clockTrain, epoch pinned to sample 0), and the
// three signal inputs carry three spectrally DISTINCT test tones so every
// selector hop is visible in the profile's spectrogram:
//   in1 = C4 sine (261.626 Hz)   in2 = C4 saw (harmonic comb)
//   in3 = 1 kHz sine (chosen OFF the C4 harmonic grid: 785/1046 Hz are the
//         nearest saw partials, so the probes can't alias across segments)
//
// The clock's FIRST rising edge lands on sample 0 and advances the selector
// immediately (hardware semantics: shift selects the NEXT stage, which is
// then heard), so the 1 s render walks in2 → in3 → in1 → in2 in four
// 250 ms segments — one full 1→2→3 cycle plus the wrap, with the worklet's
// ~4 ms anti-click crossfade at each hop.
//
// Patch: stages 3 (shipping default — cycle all three inputs).
//
// Rendering path: the REAL worklet processor class via the shared shim
// loader — moog962.ts is a thin self-contained wrapper around the
// Moog962Switch core (lib/moog962-dsp.ts) PLUS the worklet-side declick
// crossfade, pure math, no RNG. Capturing the class (not the bare core)
// keeps the declick in the profile — it IS part of the shipping sound.
//
// SIGNATURE output (owner decision §6b.2): the single `out`.
//
// The .sha pins BOTH the worklet entry and the selector core.

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { C4_HZ, clockTrain, vcoTestSignal } from '../../setup/drivers';
import { captureWorkletProcessor, renderWorklet } from '../../setup/worklet';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;
const SEGMENT_S = 0.25; // 240 BPM clock period
const IN3_HZ = 1000;

async function renderProfile(): Promise<Record<string, Float32Array>> {
  const Proc = await captureWorkletProcessor(
    'moog962',
    () => import('../../../packages/dsp/src/moog962'),
    SR,
  );
  const proc = new Proc();
  const n = Math.round(SR * DURATION_S);
  return renderWorklet(proc, {
    totalSamples: n,
    // inputs[0..2] = in1..in3 (signal), inputs[3] = shift (gate).
    inputs: [
      vcoTestSignal({ totalS: DURATION_S, shape: 'sine' }),
      vcoTestSignal({ totalS: DURATION_S, shape: 'saw' }),
      vcoTestSignal({ totalS: DURATION_S, shape: 'sine', freqHz: IN3_HZ }),
      clockTrain(DURATION_S),
    ],
    params: { stages: 3 },
    outputs: ['out'],
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

// Probe window inside segment k, trimmed 20 ms off each edge so the ~4 ms
// declick crossfades (and Goertzel edge leakage) stay out of the window.
const seg = (k: number): [number, number] => [
  Math.round((k * SEGMENT_S + 0.02) * SR),
  Math.round(((k + 1) * SEGMENT_S - 0.02) * SR),
];

describe('ART moog962 / audio profile (240 BPM shift walking sine C4 → saw C4 → 1 kHz sine)', () => {
  it('routes exactly one input per clock segment, wrapping 3 → 1', async () => {
    const out = (await renderProfile()).out!;
    expect(out.length).toBe(Math.round(SR * DURATION_S));
    expect(out.every(Number.isFinite)).toBe(true);

    const SAW_H2 = C4_HZ * 2; // the saw's 2nd harmonic — absent from both sines
    // Segment 0 (first edge at sample 0 advances 1→2): in2, the C4 saw.
    let [s, e] = seg(0);
    expect(goertzel(out, s, e, SAW_H2)).toBeGreaterThan(0.05);
    expect(goertzel(out, s, e, IN3_HZ)).toBeLessThan(0.01);
    // Segment 1: in3, the 1 kHz sine — no saw comb.
    [s, e] = seg(1);
    expect(goertzel(out, s, e, IN3_HZ)).toBeGreaterThan(0.3);
    expect(goertzel(out, s, e, SAW_H2)).toBeLessThan(0.01);
    // Segment 2 (wrap 3→1): in1, the pure C4 sine — fundamental only.
    [s, e] = seg(2);
    expect(goertzel(out, s, e, C4_HZ)).toBeGreaterThan(0.3);
    expect(goertzel(out, s, e, SAW_H2)).toBeLessThan(0.01);
    expect(goertzel(out, s, e, IN3_HZ)).toBeLessThan(0.01);
    // Segment 3: back to in2 — the saw comb returns.
    [s, e] = seg(3);
    expect(goertzel(out, s, e, SAW_H2)).toBeGreaterThan(0.05);

    // Bounded (unity pass-through of ±0.5 test tones).
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThan(0.75);
    expect(peak).toBeGreaterThan(0.4);

    // Deterministic re-render is bit-identical (fresh processor instance).
    const again = (await renderProfile()).out!;
    let diff = 0;
    for (let i = 0; i < out.length; i++) diff = Math.max(diff, Math.abs(out[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the out profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('moog962.ts', 'lib/moog962-dsp.ts');
    await pinAll('moog962', srcSha, await renderProfile());
  });
});
