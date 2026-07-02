// art/scenarios/moog904a/profile.test.ts
//
// AUDIO PROFILE for MOOG 904A (voltage controlled low pass filter)
// (backfill batch 2 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (art/setup/capture.ts + drivers.ts).
//
// Category: FILTER — driven by the canonical VCO test signal (spec §4.2:
// C4 saw, phase pinned to 0) with a deterministic exponential cutoff sweep
// 120 Hz → 8 kHz standing in for the CV a real patch would send (batch-1
// resofilter precedent — a static cutoff on a static saw would profile a
// fixed EQ, not the filter's signature).
//
// Patch: REGENERATION at noon (0.5). The worklet's shipping default is 0,
// but at 0 the 904A profiles as a plain 24 dB/oct LP — the module's
// SIGNATURE is the transistor-ladder resonant emphasis riding the sweep +
// the tanh feedback growl, so the profile documents the characterful
// mid-resonance patch. k and drive derive from the worklet's OWN mappings:
// k = regenToK(0.5) (the exported lib fn the worklet calls) and
// drive = 0.5 + regen·0.8 (moog904a.ts process(), the regen→drive line).
//
// SIGNATURE output (owner decision §6b.2): the single mono `audio` out
// (the ladder's 24 dB/oct lp4 tap).
//
// Rendering path: the pure-TS core (packages/dsp/src/lib/moog-ladder-dsp.ts
// MoogLadder.step) — the EXACT per-sample zero-delay-feedback ladder the
// worklet inner loop runs. Two worklet-side details are deliberately NOT in
// this render: the 80 Hz knob smoother (we sweep the effective cutoff
// directly, like resofilter) and the Math.random() thermal-noise dither
// (±6e-6·regen⁴ ≈ ±4e-7 at regen 0.5 — ~120 dB down, and RNG is banned in
// profile renders per DETERMINISM.md).
//
// The .sha pins BOTH the worklet entry and the -dsp lib (combinedSourceSha
// discipline) so a change in either forces an intentional `task art:update`.

import { describe, expect, it } from 'vitest';
import { MoogLadder, regenToK } from '../../../packages/dsp/src/lib/moog-ladder-dsp';
import { captureOutputs, dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal } from '../../setup/drivers';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;

// REGENERATION at noon — mapped exactly as the worklet maps it.
const REGEN = 0.5;
const K = regenToK(REGEN); // the worklet calls this same lib fn
const DRIVE = 0.5 + REGEN * 0.8; // moog904a.ts: drive = 0.5 + regen * 0.8

// Deterministic exponential cutoff sweep (the "CV" of this patch) — the
// same span as batch-1's resofilter so filter profiles stay comparable.
const SWEEP_FROM_HZ = 120;
const SWEEP_TO_HZ = 8000;

function renderProfile(): Record<string, Float32Array> {
  const input = vcoTestSignal({ totalS: DURATION_S }); // C4 saw, amp 0.5
  const n = input.length;
  const ratio = SWEEP_TO_HZ / SWEEP_FROM_HZ;
  const ladder = new MoogLadder(SR);
  return captureOutputs({ durationS: DURATION_S, outputs: ['audio'] }, (i) => {
    const cutoff = SWEEP_FROM_HZ * Math.pow(ratio, i / (n - 1));
    return { audio: ladder.step(input[i]!, cutoff, K, DRIVE).lp4 };
  });
}

/** Goertzel magnitude (normalized 2/N) of freqHz over out[s, e). */
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

describe('ART moog904a / audio profile (resonant ladder LP sweep over C4 saw, regen at noon)', () => {
  it('renders a finite, audible resonant low-pass sweep that opens up over time', () => {
    const out = renderProfile().audio!;
    expect(out.length).toBe(Math.round(SR * DURATION_S));
    expect(out.every(Number.isFinite)).toBe(true);
    // Audible + bounded (tanh feedback saturation self-limits the resonance).
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThan(2);
    // The sweep OPENS in the treble: the saw's 8th harmonic (C7 ≈ 2093 Hz)
    // is crushed 24 dB/oct while the cutoff sits far below it early on
    // (~150–350 Hz), and passes freely once the cutoff has swept above it
    // (~4.7–7.3 kHz late). (A plain total-RMS early/late compare would NOT
    // show this: with REGEN at noon the resonant peak rides the cutoff
    // straight across the fundamental early in the sweep, boosting early
    // energy — the resonance IS the patch.)
    const earlyHigh = goertzel(out, Math.round(0.05 * SR), Math.round(0.25 * SR), 2093);
    const lateHigh = goertzel(out, Math.round(0.75 * SR), Math.round(0.95 * SR), 2093);
    expect(lateHigh).toBeGreaterThan(earlyHigh * 5);
    // Deterministic re-render is bit-identical (no RNG in the core path).
    const again = renderProfile().audio!;
    let diff = 0;
    for (let i = 0; i < out.length; i++) diff = Math.max(diff, Math.abs(out[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the audio profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('moog904a.ts', 'lib/moog-ladder-dsp.ts');
    await pinAll('moog904a', srcSha, renderProfile());
  });
});
