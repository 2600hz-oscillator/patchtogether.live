// art/scenarios/negativity/profile.test.ts
//
// AUDIO PROFILE for NEGATIVITY (a pure inverter, out = −in) (backfill
// batch 5 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (capture.ts + drivers.ts + offline.ts).
//
// Category: UTILITY / PROCESSOR — a single fixed −1 gain, no params, no knob.
// The module's WHOLE character is the sign flip, so the profile drives an
// ASYMMETRIC, unmistakably-signed source — a C4 saw ramp — and asserts the
// output is its exact point-wise negative: a rising ramp becomes a falling
// one (the phase-flip a ducking / complementary-CV patch relies on).
//
// Rendering path: the REAL def factory (negativity is a single GainNode −1 —
// no worklet) under node-web-audio-api's OfflineAudioContext via the shared
// renderOfflineDef helper (plan §1.3 path #3). Byte-determinism probed
// in-process below (and across processes before pinning).
//
// SIGNATURE output (owner decision §6b.2): the single `out`.
//
// The .sha pins the def file (no co-located docs block to strip; the strip is
// a no-op, and the ports/params/factory graph DO invalidate, as they should).

import { describe, expect, it } from 'vitest';
import { negativityDef } from '$lib/audio/modules/negativity';
import { docsStrippedRepoSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal } from '../../setup/drivers';
import { renderOfflineDef } from '../../setup/offline';

const SR = SAMPLE_RATE;
const DURATION_S = 0.5; // steady tone through a static gain (spec §4.1)
const IN_AMP = 0.7;

const input = vcoTestSignal({ totalS: DURATION_S, shape: 'saw', amp: IN_AMP });

async function renderProfile(): Promise<Record<string, Float32Array>> {
  return renderOfflineDef(negativityDef, {
    durationS: DURATION_S,
    inputs: { in: input },
    outputs: ['out'],
  });
}

describe('ART negativity / audio profile (a C4 saw ramp sign-flipped point-for-point)', () => {
  it('inverts sample-for-sample: out = −in, a rising ramp becomes a falling one', async () => {
    const out = (await renderProfile()).out!;
    const n = Math.round(SR * DURATION_S);
    expect(out.length).toBe(n);
    expect(out.every(Number.isFinite)).toBe(true);

    // The law: out = −in, sample-accurate (one GainNode at gain −1; f32 math).
    for (let i = 0; i < n; i++) {
      if (out[i]! !== Math.fround(-input[i]!)) {
        throw new Error(`out sample ${i}: ${out[i]} != ${-input[i]!}`);
      }
    }

    // The signature: the two are perfect anti-phase — their sum is silence and
    // the input's positive-going slope is the output's negative-going slope.
    let maxSum = 0;
    let rising = 0;
    let falling = 0;
    for (let i = 1; i < n; i++) {
      maxSum = Math.max(maxSum, Math.abs(out[i]! + input[i]!));
      if (input[i]! > input[i - 1]!) rising++;
      if (out[i]! < out[i - 1]!) falling++;
    }
    expect(maxSum).toBe(0); // in + out cancels to exact zero everywhere
    // Wherever the input ramps UP, the output ramps DOWN by construction.
    expect(falling).toBe(rising);
    expect(rising).toBeGreaterThan(n / 4); // the saw actually ramps

    // Deterministic re-render is bit-identical (fresh offline graph).
    const again = (await renderProfile()).out!;
    let diff = 0;
    for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(out[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the out profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await docsStrippedRepoSourceSha('packages/web/src/lib/audio/modules/negativity.ts');
    await pinAll('negativity', srcSha, await renderProfile());
  });
});
