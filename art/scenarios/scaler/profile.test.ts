// art/scenarios/scaler/profile.test.ts
//
// AUDIO PROFILE for SCALER (×0.1..×10 gain trim) (backfill batch 5 —
// spec §4.1/§4.3, .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md),
// through the shared capture harness (capture.ts + drivers.ts + offline.ts).
//
// Category: UTILITY / PROCESSOR — one multiply. The module's DISTINCT
// character (vs the cut-only attenuators) is that it can BOOST past unity,
// so the profile drives a deliberately QUIET canonical tone and dials a
// ×2.5 boost: in = C4 saw at 0.3, out = the same saw at 0.75 — louder than
// its own driver ever was (asserted: the output peak exceeds the input
// peak, the thing a 0..1 attenuator can never do).
//
// Rendering path: the REAL def factory (scaler is a single GainNode — no
// worklet) under node-web-audio-api's OfflineAudioContext via the shared
// renderOfflineDef helper (plan §1.3 path #3). Byte-determinism probed
// in-process (below) and across processes before pinning.
//
// SIGNATURE output (owner decision §6b.2): the single `out`.
//
// The .sha pins the def file with its co-located docs stripped
// (docs-hash-ignore markers — docs edits must never invalidate audio pins;
// the ports/params/factory graph DO invalidate, as they should).

import { describe, expect, it } from 'vitest';
import { scalerDef } from '$lib/audio/modules/scaler';
import { docsStrippedRepoSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal } from '../../setup/drivers';
import { renderOfflineDef } from '../../setup/offline';

const SR = SAMPLE_RATE;
const DURATION_S = 0.5; // steady tone through a static gain (spec §4.1)
const AMOUNT = 2.5; // a clear BOOST — the scaler-not-attenuator signature
const IN_AMP = 0.3;

const input = vcoTestSignal({ totalS: DURATION_S, shape: 'saw', amp: IN_AMP });

async function renderProfile(): Promise<Record<string, Float32Array>> {
  return renderOfflineDef(scalerDef, {
    durationS: DURATION_S,
    params: { amount: AMOUNT },
    inputs: { in: input },
    outputs: ['out'],
  });
}

describe('ART scaler / audio profile (quiet C4 saw boosted ×2.5 past its own peak)', () => {
  it('multiplies sample-for-sample and boosts beyond the input peak', async () => {
    const out = (await renderProfile()).out!;
    const n = Math.round(SR * DURATION_S);
    expect(out.length).toBe(n);
    expect(out.every(Number.isFinite)).toBe(true);

    // The law: out = in × amount, sample-accurate (one GainNode; f32 math).
    for (let i = 0; i < n; i++) {
      if (Math.abs(out[i]! - input[i]! * AMOUNT) > 1e-6) {
        throw new Error(`out sample ${i}: ${out[i]} != ${input[i]! * AMOUNT}`);
      }
    }

    // The signature: the output is LOUDER than the driver's own peak — a
    // boost no 0..1 attenuator can produce.
    let inPeak = 0;
    let outPeak = 0;
    for (let i = 0; i < n; i++) {
      inPeak = Math.max(inPeak, Math.abs(input[i]!));
      outPeak = Math.max(outPeak, Math.abs(out[i]!));
    }
    expect(inPeak).toBeLessThanOrEqual(IN_AMP + 1e-6); // f32 rounding of 0.3
    expect(outPeak).toBeGreaterThan(inPeak * 2);
    expect(outPeak).toBeLessThanOrEqual(IN_AMP * AMOUNT + 1e-6);

    // Deterministic re-render is bit-identical (fresh offline graph).
    const again = (await renderProfile()).out!;
    let diff = 0;
    for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(out[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the out profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await docsStrippedRepoSourceSha('packages/web/src/lib/audio/modules/scaler.ts');
    await pinAll('scaler', srcSha, await renderProfile());
  });
});
