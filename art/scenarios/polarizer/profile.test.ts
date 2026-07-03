// art/scenarios/polarizer/profile.test.ts
//
// AUDIO PROFILE for POLARIZER (unipolar → bipolar, out = (2·in − 1)·depth)
// (backfill batch 5 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (capture.ts + drivers.ts + offline.ts).
//
// Category: CV UTILITY / PROCESSOR — an affine map (scale·in + offset). The
// module's DEFINING act is turning a 0..1 signal into a ±1 one, so the profile
// drives a strictly UNIPOLAR source (a 0.5-centered sine that never leaves
// [0,1]) and asserts the output is genuinely BIPOLAR and re-centered on 0:
// the DC pedestal that a 0..1 envelope/LFO carries is removed, leaving a
// modulation that can both RAISE and LOWER a destination. DEPTH is dialed to
// 0.8 (off default) so the scale term is exercised, not just the offset.
//
// Rendering path: the REAL def factory (polarizer is a GainNode +
// ConstantSourceNode affine graph — no worklet) under node-web-audio-api's
// OfflineAudioContext via the shared renderOfflineDef helper (plan §1.3
// path #3). Byte-determinism probed in-process below.
//
// SIGNATURE output (owner decision §6b.2): the single `out`.
//
// The .sha pins the def file with its co-located docs stripped
// (docs-hash-ignore markers — docs edits must never invalidate audio pins).

import { describe, expect, it } from 'vitest';
import { polarizerDef } from '$lib/audio/modules/polarizer';
import { docsStrippedRepoSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { renderOfflineDef } from '../../setup/offline';

const SR = SAMPLE_RATE;
const DURATION_S = 0.5;
const DEPTH = 0.8; // off default (1.0) so the 2·depth scale term is exercised
const LFO_HZ = 4; // 2 whole cycles over 0.5 s → clean zero-mean output

/** A strictly UNIPOLAR control voltage: a 0.5-centered sine bounded in [0,1],
 *  the shape a 0..1 envelope-follower / unipolar LFO emits (pure fn of the
 *  scenario — phase pinned to 0 at sample 0). */
function unipolarLfo(): Float32Array {
  const n = Math.round(SR * DURATION_S);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = 0.5 + 0.5 * Math.sin((2 * Math.PI * LFO_HZ * i) / SR);
  return buf;
}

const input = unipolarLfo();

async function renderProfile(): Promise<Record<string, Float32Array>> {
  return renderOfflineDef(polarizerDef, {
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

describe('ART polarizer / audio profile (a 0..1 unipolar LFO stretched to a ±0.8 bipolar swing)', () => {
  it('recenters a unipolar input on 0 and follows out = (2·in − 1)·depth', async () => {
    const out = (await renderProfile()).out!;
    const n = Math.round(SR * DURATION_S);
    expect(out.length).toBe(n);
    expect(out.every(Number.isFinite)).toBe(true);

    // The input is UNIPOLAR: every sample in [0,1], mean at the 0.5 pedestal.
    let inMin = Infinity;
    let inMax = -Infinity;
    for (let i = 0; i < n; i++) {
      inMin = Math.min(inMin, input[i]!);
      inMax = Math.max(inMax, input[i]!);
    }
    expect(inMin).toBeGreaterThanOrEqual(0);
    expect(inMax).toBeLessThanOrEqual(1 + 1e-6);
    expect(mean(input)).toBeCloseTo(0.5, 2);

    // The law: out = (2·in − 1)·depth, within f32 tolerance (two staged f32
    // ops: in·2depth on one node, −depth on the other, summed).
    for (let i = 0; i < n; i++) {
      const expected = (2 * input[i]! - 1) * DEPTH;
      if (Math.abs(out[i]! - expected) > 1e-5) {
        throw new Error(`out sample ${i}: ${out[i]} != ${expected}`);
      }
    }

    // The SIGNATURE: the output is genuinely BIPOLAR and re-centered on 0 —
    // the 0.5 DC pedestal is gone, the swing reaches ±depth on both sides.
    let outMin = Infinity;
    let outMax = -Infinity;
    for (let i = 0; i < n; i++) {
      outMin = Math.min(outMin, out[i]!);
      outMax = Math.max(outMax, out[i]!);
    }
    expect(mean(out)).toBeCloseTo(0, 2); // pedestal removed
    expect(outMin).toBeLessThan(-0.7); // swings clearly negative (≈ −depth)…
    expect(outMax).toBeGreaterThan(0.7); // …and clearly positive (≈ +depth)
    expect(Math.max(Math.abs(outMin), outMax)).toBeLessThanOrEqual(DEPTH + 1e-6);

    // Deterministic re-render is bit-identical (fresh offline graph).
    const again = (await renderProfile()).out!;
    let diff = 0;
    for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(out[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the out profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await docsStrippedRepoSourceSha('packages/web/src/lib/audio/modules/polarizer.ts');
    await pinAll('polarizer', srcSha, await renderProfile());
  });
});
