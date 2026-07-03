// art/scenarios/depolarizer/profile.test.ts
//
// AUDIO PROFILE for DEPOLARIZER (bipolar → unipolar, out = 0.5 + depth·(in/2))
// (backfill batch 5 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (capture.ts + drivers.ts + offline.ts).
//
// Category: CV UTILITY / PROCESSOR — the exact inverse of POLARIZER. Its
// DEFINING act is folding a ±1 signal into 0..1 centered on 0.5, so the
// profile drives a strictly BIPOLAR source (a zero-mean ±1 sine) and asserts
// the output is genuinely UNIPOLAR — it NEVER goes negative and rests on the
// 0.5 pedestal a level/depth/mix CV input expects. DEPTH is dialed to 0.8
// (off default) so the depth/2 slope is exercised while the fixed 0.5 center
// stays put (the module's "attenuate the deviation, never the center" law).
//
// Rendering path: the REAL def factory (a GainNode + ConstantSourceNode affine
// graph — no worklet) under node-web-audio-api's OfflineAudioContext via the
// shared renderOfflineDef helper (plan §1.3 path #3).
//
// SIGNATURE output (owner decision §6b.2): the single `out`.
//
// The .sha pins the def file with its co-located docs stripped
// (docs-hash-ignore markers — docs edits must never invalidate audio pins).

import { describe, expect, it } from 'vitest';
import { depolarizerDef } from '$lib/audio/modules/depolarizer';
import { docsStrippedRepoSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal } from '../../setup/drivers';
import { renderOfflineDef } from '../../setup/offline';

const SR = SAMPLE_RATE;
const DURATION_S = 0.5;
const DEPTH = 0.8; // off default (1.0) so the depth/2 slope term is exercised
const LFO_HZ = 4; // 2 whole cycles over 0.5 s → clean zero-mean input

// A strictly BIPOLAR ±1 control voltage (a zero-mean sine — the shape a
// bipolar LFO / sequencer emits), phase pinned to 0 at sample 0.
const input = vcoTestSignal({ totalS: DURATION_S, shape: 'sine', freqHz: LFO_HZ, amp: 1.0 });

async function renderProfile(): Promise<Record<string, Float32Array>> {
  return renderOfflineDef(depolarizerDef, {
    durationS: DURATION_S,
    params: { depth: DEPTH },
    inputs: { in: input },
    outputs: ['out'],
  });
}

function mean(b: Float32Array): number {
  let s = 0;
  for (const v of b) s += v;
  return s / b.length;
}

describe('ART depolarizer / audio profile (a ±1 bipolar LFO folded into a 0.5-centered unipolar CV)', () => {
  it('never goes negative and follows out = 0.5 + depth·(in/2)', async () => {
    const out = (await renderProfile()).out!;
    const n = Math.round(SR * DURATION_S);
    expect(out.length).toBe(n);
    expect(out.every(Number.isFinite)).toBe(true);

    // The input is BIPOLAR: it swings clearly negative AND positive, mean ≈ 0.
    let inMin = Infinity;
    let inMax = -Infinity;
    for (let i = 0; i < n; i++) {
      inMin = Math.min(inMin, input[i]!);
      inMax = Math.max(inMax, input[i]!);
    }
    expect(inMin).toBeLessThan(-0.9);
    expect(inMax).toBeGreaterThan(0.9);
    expect(mean(input)).toBeCloseTo(0, 2);

    // The law: out = 0.5 + depth·(in/2), within f32 tolerance.
    for (let i = 0; i < n; i++) {
      const expected = 0.5 + DEPTH * (input[i]! / 2);
      if (Math.abs(out[i]! - expected) > 1e-5) {
        throw new Error(`out sample ${i}: ${out[i]} != ${expected}`);
      }
    }

    // The SIGNATURE: the output is UNIPOLAR — it never goes below 0, rests on
    // the fixed 0.5 center, and its swing is depth/2 either side (0.1..0.9).
    let outMin = Infinity;
    let outMax = -Infinity;
    for (let i = 0; i < n; i++) {
      outMin = Math.min(outMin, out[i]!);
      outMax = Math.max(outMax, out[i]!);
    }
    expect(outMin).toBeGreaterThanOrEqual(0); // never negative — the whole point
    expect(mean(out)).toBeCloseTo(0.5, 2); // rests on the fixed center
    // Swing is DEPTH/2 either side of 0.5 → [0.1, 0.9] (depth 0.8).
    expect(outMin).toBeLessThan(0.5 - DEPTH / 2 + 0.05);
    expect(outMax).toBeGreaterThan(0.5 + DEPTH / 2 - 0.05);
    expect(outMax).toBeLessThanOrEqual(1 + 1e-6);

    // Deterministic re-render is bit-identical (fresh offline graph).
    const again = (await renderProfile()).out!;
    let diff = 0;
    for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(out[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the out profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await docsStrippedRepoSourceSha('packages/web/src/lib/audio/modules/depolarizer.ts');
    await pinAll('depolarizer', srcSha, await renderProfile());
  });
});
