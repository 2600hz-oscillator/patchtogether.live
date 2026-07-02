// art/scenarios/ringback/profile.test.ts
//
// AUDIO PROFILE for RINGBACK (backfill batch 1 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (art/setup/capture.ts + drivers.ts).
//
// Category: FX / PROCESSOR — the twotracks record-time crush packaged as a
// deliberate effect (integer-cell varispeed write vs fractional interp
// read-back over a tiny feedback ring). Driver: the canonical VCO test
// signal (spec §4.2: C4 saw, phase pinned to 0). Patch: the worklet's
// SHIPPING DEFAULTS (rate 0.5 — the hardest stair-step decimation, size 64,
// feedback 0.3, mix 1) so the profile is the module's out-of-the-box
// metallic ring.
//
// SIGNATURE output (owner decision §6b.2): ONE baseline `out`. The worklet
// runs one RingChannel per side with identical params; a mono driver feeds
// both the same signal (inputs[1] ?? inL), so out_l/out_r are provably
// identical — one profile covers both (bus-duplicate rule, spec §4.1).
//
// Rendering path: the pure-TS core (packages/dsp/src/lib/ringback-core.ts
// RingChannel.step) — the EXACT per-sample code the worklet runs
// (../ringback.ts). No mirror, no drift, no RNG.
//
// The .sha pins BOTH the worklet entry and the core lib (combinedSourceSha
// discipline) so a change in either forces an intentional `task art:update`.

import { describe, expect, it } from 'vitest';
import { RingChannel, RINGBACK_MAX_SIZE } from '../../../packages/dsp/src/lib/ringback-core';
import { captureOutputs, dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal } from '../../setup/drivers';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;

// Worklet shipping defaults (ringback.ts parameterDescriptors).
const RATE = 0.5;
const SIZE = 64;
const FEEDBACK = 0.3;
const MIX = 1;

function renderProfile(): Record<string, Float32Array> {
  const input = vcoTestSignal({ totalS: DURATION_S }); // C4 saw, amp 0.5
  const ch = new RingChannel(RINGBACK_MAX_SIZE);
  return captureOutputs({ durationS: DURATION_S, outputs: ['out'] }, (i) => ({
    out: ch.step(input[i]!, RATE, SIZE, FEEDBACK, MIX),
  }));
}

function rms(b: Float32Array, s = 0, e = b.length): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

describe('ART ringback / audio profile (default crush over C4 saw)', () => {
  it('renders a finite, audible, genuinely-crushed signal (wet ≠ dry)', () => {
    const out = renderProfile().out!;
    const input = vcoTestSignal({ totalS: DURATION_S });
    expect(out.length).toBe(Math.round(SR * DURATION_S));
    expect(out.every(Number.isFinite)).toBe(true);
    // Audible + bounded (feedback clamp keeps the ring from blowing up).
    expect(rms(out)).toBeGreaterThan(0.05);
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThan(4);
    // The crush actually crushes: full-wet output differs substantially from
    // the dry saw (decimated/aliased read-back, not a pass-through).
    let maxDev = 0;
    for (let i = 0; i < out.length; i++) maxDev = Math.max(maxDev, Math.abs(out[i]! - input[i]!));
    expect(maxDev).toBeGreaterThan(0.1);
    // Deterministic re-render is bit-identical.
    const again = renderProfile().out!;
    let diff = 0;
    for (let i = 0; i < out.length; i++) diff = Math.max(diff, Math.abs(out[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the out profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('ringback.ts', 'lib/ringback-core.ts');
    await pinAll('ringback', srcSha, renderProfile());
  });
});
