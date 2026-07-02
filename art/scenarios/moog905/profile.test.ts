// art/scenarios/moog905/profile.test.ts
//
// AUDIO PROFILE for MOOG905 (spring reverberation) (backfill batch 1 —
// spec §4.1/§4.3, .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md),
// through the shared capture harness (art/setup/capture.ts + drivers.ts).
//
// Category: FX / PROCESSOR with a DECAY TAIL — so per spec §4.1 the render
// is ≥1.0 s (1.5 s here) and the driver is a short transient, not a steady
// tone: a 60 ms C4 saw burst at t=0, then silence, so the spring's
// signature dispersive "boing" chirp + metallic feedback tail is what the
// gallery waveform/spectrogram actually shows. Patch: the worklet's
// SHIPPING DEFAULTS (mix 0.35, decay 0.6, size 0.5); the dry/wet mix is
// applied exactly as ../moog905.ts does (out = x·(1−mix) + wet·mix — the
// lib returns pure WET by design).
//
// SIGNATURE output (owner decision §6b.2): the single mono `audio` out.
//
// Rendering path: the pure-TS core (packages/dsp/src/lib/spring-reverb-dsp.ts
// SpringReverb) — the EXACT per-sample tank the worklet steps. NOTE: the
// backfill plan's Appendix A tags spring-reverb-dsp as `reverb`'s core, but
// the lib header + the import chain are unambiguous: it is MOOG905's core
// (`reverb` is the Faust reverb.dsp with no TS core — left on the backlog).
// Deterministic: no RNG; the shimmer LFO phase starts at 0 and all time
// constants derive from the passed sample rate.
//
// The .sha pins BOTH the worklet entry and the -dsp lib (combinedSourceSha
// discipline) so a change in either forces an intentional `task art:update`.

import { describe, expect, it } from 'vitest';
import { SpringReverb } from '../../../packages/dsp/src/lib/spring-reverb-dsp';
import { captureOutputs, dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal } from '../../setup/drivers';

const SR = SAMPLE_RATE;
const DURATION_S = 1.5;
const BURST_S = 0.06;

// Worklet shipping defaults (moog905.ts parameterDescriptors).
const MIX = 0.35;
const DECAY = 0.6;
const SIZE = 0.5;

function renderProfile(): Record<string, Float32Array> {
  // 60 ms C4 saw burst, then silence — the spring rings out on its own.
  const burst = vcoTestSignal({ totalS: BURST_S, amp: 0.6 });
  const spring = new SpringReverb(SR);
  spring.setParams({ decay: DECAY, size: SIZE });
  const dryGain = 1 - MIX;
  return captureOutputs({ durationS: DURATION_S, outputs: ['audio'] }, (i) => {
    const x = i < burst.length ? burst[i]! : 0;
    const wet = spring.step(x);
    return { audio: x * dryGain + wet * MIX };
  });
}

function rms(b: Float32Array, s = 0, e = b.length): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

describe('ART moog905 / audio profile (60 ms saw burst → spring tail, default patch)', () => {
  it('renders a finite burst + audible decaying spring tail', () => {
    const out = renderProfile().audio!;
    expect(out.length).toBe(Math.round(SR * DURATION_S));
    expect(out.every(Number.isFinite)).toBe(true);
    // The dry burst dominates the first 60 ms.
    expect(rms(out, 0, Math.round(BURST_S * SR))).toBeGreaterThan(0.05);
    // A REAL tail: wet energy persists well after the input has stopped…
    const earlyTail = rms(out, Math.round(0.1 * SR), Math.round(0.3 * SR));
    expect(earlyTail).toBeGreaterThan(1e-4);
    // …and it DECAYS (feedback is clamped < 1 — stability invariant).
    const lateTail = rms(out, Math.round(1.2 * SR), Math.round(1.5 * SR));
    expect(lateTail).toBeLessThan(earlyTail);
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThan(2);
    // Deterministic re-render is bit-identical (LFO phase pinned at 0).
    const again = renderProfile().audio!;
    let diff = 0;
    for (let i = 0; i < out.length; i++) diff = Math.max(diff, Math.abs(out[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the audio profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('moog905.ts', 'lib/spring-reverb-dsp.ts');
    await pinAll('moog905', srcSha, renderProfile());
  });
});
