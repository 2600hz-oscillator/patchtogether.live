// art/scenarios/resofilter/profile.test.ts
//
// AUDIO PROFILE for RESOFILTER (backfill batch 1 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (art/setup/capture.ts + drivers.ts).
//
// Category: FX / PROCESSOR — driven by the canonical VCO test signal
// (spec §4.2: C4 saw, phase pinned to 0). Patch: the worklet's SHIPPING
// DEFAULTS (mode LP, resonance 0.3, mix 1) with a deterministic exponential
// cutoff sweep 120 Hz → 8 kHz across the render standing in for the CV a
// real patch would send — a static cutoff on a static saw would profile a
// fixed EQ, not the filter's signature (the sweep is what the spectrogram
// shows; it also exercises the in-worklet RfSmoother path).
//
// SIGNATURE output (owner decision §6b.2): ONE baseline `out`. The module's
// out_l/out_r are processed by two ResofilterChannel instances with
// identical state given identical input — for this mono driver the two
// ports are provably the same signal, so one profile covers both (bus-
// duplicate rule, spec §4.1).
//
// Rendering path: the pure-TS core (packages/dsp/src/lib/resofilter-dsp.ts
// ResofilterChannel.step) — the EXACT per-sample code the worklet inner
// loop runs (../resofilter.ts). No mirror, no drift, no RNG.
//
// The .sha pins BOTH the worklet entry and the -dsp lib (combinedSourceSha
// discipline) so a change in either forces an intentional `task art:update`.

import { describe, expect, it } from 'vitest';
import {
  ResofilterChannel,
  type ResofilterMode,
} from '../../../packages/dsp/src/lib/resofilter-dsp';
import { captureOutputs, dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal } from '../../setup/drivers';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;

// Worklet shipping defaults (resofilter.ts parameterDescriptors).
const RES = 0.3;
const MODE: ResofilterMode = 0; // LP
const MIX = 1;

// Deterministic exponential cutoff sweep (the "CV" of this patch).
const SWEEP_FROM_HZ = 120;
const SWEEP_TO_HZ = 8000;

function renderProfile(): Record<string, Float32Array> {
  const input = vcoTestSignal({ totalS: DURATION_S }); // C4 saw, amp 0.5
  const n = input.length;
  const ratio = SWEEP_TO_HZ / SWEEP_FROM_HZ;
  const ch = new ResofilterChannel(SR);
  return captureOutputs({ durationS: DURATION_S, outputs: ['out'] }, (i) => {
    const cutoff = SWEEP_FROM_HZ * Math.pow(ratio, i / (n - 1));
    return { out: ch.step(input[i]!, cutoff, RES, MODE, MIX, SR) };
  });
}

function rms(b: Float32Array, s = 0, e = b.length): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

describe('ART resofilter / audio profile (LP cutoff sweep over C4 saw, default patch)', () => {
  it('renders a finite, audible low-pass sweep that opens up over time', () => {
    const out = renderProfile().out!;
    expect(out.length).toBe(Math.round(SR * DURATION_S));
    expect(out.every(Number.isFinite)).toBe(true);
    // Audible + bounded (LP of a 0.5-amp saw; resonance 0.3 adds no blowup).
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThan(2);
    // The sweep OPENS: closed-filter start passes less saw energy than the
    // wide-open end (cutoff 120 Hz < C4 fundamental vs 8 kHz ≫ it).
    const early = rms(out, Math.round(0.05 * SR), Math.round(0.25 * SR));
    const late = rms(out, Math.round(0.75 * SR), Math.round(0.95 * SR));
    expect(late).toBeGreaterThan(early * 1.2);
    // Deterministic re-render is bit-identical.
    const again = renderProfile().out!;
    let diff = 0;
    for (let i = 0; i < out.length; i++) diff = Math.max(diff, Math.abs(out[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the out profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('resofilter.ts', 'lib/resofilter-dsp.ts');
    await pinAll('resofilter', srcSha, renderProfile());
  });
});
