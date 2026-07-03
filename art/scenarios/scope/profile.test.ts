// art/scenarios/scope/profile.test.ts
//
// AUDIO PROFILE for SCOPE (2-channel passthrough oscilloscope) — backfill
// batch 6. SCOPE is a pure Web Audio node graph (GainNode passthrough +
// AnalyserNode tap, packages/web/src/lib/audio/modules/scope.ts) with NO
// worklet, so the shipping factory renders directly under node-web-audio-api's
// OfflineAudioContext (§1.3 #3 — art/setup/offline.ts renderOfflineDef).
//
// SCOPE is a VISUALIZER: it has a video output (VRT/WebGL scope, out of ART
// scope) AND two AUDIO outputs — ch1_out / ch2_out — which are CLEAN
// passthroughs of the probe inputs ("the scope adds no processing, so you can
// chain it inline"). It is therefore NOT output-less, so per the batch-6 brief
// it is profiled (not excluded): the profile pins that the passthrough is
// bit-transparent — a regression guard against any processing sneaking into
// the inline probe path.
//
// Category: PASSTHROUGH PROBE. ch1 = C4 saw, ch2 = G4 sine — two DIFFERENT
// signals so the two pinned baselines are distinct.
//
// SIGNATURE outputs (owner §6b.2 — distinct): ch1_out (saw) and ch2_out (sine).

import { describe, expect, it } from 'vitest';
import { pinAll, repoSourceSha, SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal, C4_HZ } from '../../setup/drivers';
import { renderOfflineDef } from '../../setup/offline';
import { scopeDef } from '$lib/audio/modules/scope';

const SR = SAMPLE_RATE;
const DURATION_S = 0.5;
const CH2_HZ = 392;
const SCOPE_SRC = 'packages/web/src/lib/audio/modules/scope.ts';

const ch1 = vcoTestSignal({ totalS: DURATION_S, shape: 'saw', freqHz: C4_HZ, amp: 0.5 });
const ch2 = vcoTestSignal({ totalS: DURATION_S, shape: 'sine', freqHz: CH2_HZ, amp: 0.5 });

async function renderProfile(): Promise<Record<string, Float32Array>> {
  return renderOfflineDef(scopeDef, {
    durationS: DURATION_S,
    inputs: { ch1, ch2 },
    outputs: ['ch1_out', 'ch2_out'],
  });
}

describe('ART scope / audio profile (bit-transparent inline probe passthrough)', () => {
  it('passes each probe input through to its OUT unchanged', async () => {
    const n = Math.round(SR * DURATION_S);
    const { ch1_out: c1, ch2_out: c2 } = await renderProfile();
    expect(c1.length).toBe(n);
    expect(c2.length).toBe(n);
    expect(c1.every(Number.isFinite)).toBe(true);
    expect(c2.every(Number.isFinite)).toBe(true);

    // The scope is an identity passthrough (gain=1) — the outputs track the
    // driver inputs sample-for-sample (tiny FP tolerance for the buffer-source
    // → gain path). If a future change adds processing to the probe path this
    // breaks loudly.
    let d1 = 0, d2 = 0;
    for (let i = 0; i < n; i++) {
      d1 = Math.max(d1, Math.abs(c1[i]! - ch1[i]!));
      d2 = Math.max(d2, Math.abs(c2[i]! - ch2[i]!));
    }
    expect(d1).toBeLessThan(1e-6);
    expect(d2).toBeLessThan(1e-6);

    // The two baselines are genuinely different (saw vs sine).
    let sameCount = 0;
    for (let i = 0; i < n; i++) if (c1[i] === c2[i]) sameCount++;
    expect(sameCount).toBeLessThan(n / 2);

    // Deterministic re-render.
    const again = await renderProfile();
    let dd = 0;
    for (let i = 0; i < n; i++) dd = Math.max(dd, Math.abs(c1[i]! - again.ch1_out![i]!));
    expect(dd).toBe(0);
  });

  it('pins ch1_out + ch2_out passthrough baselines (SHA-gated on scope.ts)', async () => {
    // scope has no packages/dsp source — the render path IS the web-package
    // factory, so pin that file.
    const srcSha = await repoSourceSha(SCOPE_SRC);
    const b = await renderProfile();
    await pinAll('scope', srcSha, { ch1_out: b.ch1_out!, ch2_out: b.ch2_out! });
  });
});
