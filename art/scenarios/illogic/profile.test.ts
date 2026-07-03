// art/scenarios/illogic/profile.test.ts
//
// AUDIO PROFILE for ILLOGIC (4-ch attenuverter + sum/diff mixer + digital
// logic) (backfill batch 5 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (capture.ts + drivers.ts + offline.ts).
//
// Category: CV UTILITY — a three-in-one module, so the profile drives all
// three halves at once with SIGNATURE-appropriate stimuli:
//   in1, in2 = two interleaved GATE trains (different rates) — the digital
//              logic inputs (thresholded at 0.5), so AND/OR/NOT come out as
//              distinct, time-varying clean 0/1 gate waveforms.
//   in3 = C4 saw, in4 = 660 Hz sine — continuous CV for the mix buses.
//   Attenuverters: att1=+1, att2=−1 (INVERT — the "verter" half), att3=+0.5,
//   att4=+1 — so SUM and DIFF carry a genuinely attenuverted, sign-mixed blend.
//
// SIGNATURE outputs (owner decision §6b.2) — one from each distinct behavior:
//   and  — the digital logic block (gate1 ∧ gate2)
//   or   — the digital logic block (gate1 ∨ gate2), a superset of AND
//   sum  — the attenuverted 4-input mix (att1..att4 added)
//   diff — the sign-aware difference (att1+att2) − (att3+att4)
// (att1..att4 are plain per-channel gains of their drivers; nand/not are
// 1−and / 1−gate1 — all derivable, so not separately pinned.)
//
// Rendering path: the REAL def factory (illogic is pure GainNodes +
// WaveShaperNodes + a ConstantSource — no worklet) under node-web-audio-api's
// OfflineAudioContext via the shared renderOfflineDef helper (the multi-output
// ChannelMerger path — plan §1.3 path #3; the same technique the existing
// illogic attenuverter-and-logic scenario uses).
//
// The .sha pins the def file with its co-located docs stripped
// (docs-hash-ignore markers — docs edits must never invalidate audio pins).

import { describe, expect, it } from 'vitest';
import { illogicDef } from '$lib/audio/modules/illogic';
import { docsStrippedRepoSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { gateTrain, vcoTestSignal } from '../../setup/drivers';
import { renderOfflineDef } from '../../setup/offline';

const SR = SAMPLE_RATE;
const DURATION_S = 0.5;

// Two interleaved gate trains → distinct AND/OR/NOT patterns.
//   in1 high [0, 0.25);            (period 0.5 s, on 0.25 s)
//   in2 high [0, 0.125), [0.25, 0.375);   (period 0.25 s, on 0.125 s)
const in1 = gateTrain({ totalS: DURATION_S, bpm: 120, gateS: 0.25 });
const in2 = gateTrain({ totalS: DURATION_S, bpm: 240, gateS: 0.125 });
const in3 = vcoTestSignal({ totalS: DURATION_S, shape: 'saw', amp: 0.5 });
const in4 = vcoTestSignal({ totalS: DURATION_S, shape: 'sine', freqHz: 660, amp: 0.5 });

const ATT2 = -1; // channel-2 INVERT — the attenuverter signature

async function renderProfile(): Promise<Record<string, Float32Array>> {
  return renderOfflineDef(illogicDef, {
    durationS: DURATION_S,
    params: { att1_amount: 1, att2_amount: ATT2, att3_amount: 0.5, att4_amount: 1 },
    inputs: { in1, in2, in3, in4 },
    outputs: ['and', 'or', 'sum', 'diff'],
  });
}

function windowMean(b: Float32Array, s: number, e: number): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]!;
  return x / Math.max(1, e - s);
}

function rms(b: Float32Array): number {
  let x = 0;
  for (const v of b) x += v * v;
  return Math.sqrt(x / b.length);
}

describe('ART illogic / audio profile (gate logic + attenuverted CV mix)', () => {
  it('derives clean 0/1 logic and a sign-mixed sum/diff from the four inputs', async () => {
    const bufs = await renderProfile();
    const n = Math.round(SR * DURATION_S);
    for (const id of ['and', 'or', 'sum', 'diff'] as const) {
      expect(bufs[id]!.length).toBe(n);
      expect(bufs[id]!.every(Number.isFinite), id).toBe(true);
    }
    const and = bufs.and!;
    const or = bufs.or!;
    const sum = bufs.sum!;
    const diff = bufs.diff!;

    // AND / OR are clean digital gates: every sample resolves to ~0 or ~1.
    for (const [id, buf] of [['and', and], ['or', or]] as const) {
      for (let i = 0; i < n; i++) {
        const v = buf[i]!;
        if (v > 0.05 && v < 0.95) throw new Error(`${id} sample ${i} not boolean: ${v}`);
        if (v < -0.05 || v > 1.05) throw new Error(`${id} sample ${i} out of range: ${v}`);
      }
    }

    // OR ⊇ AND everywhere (OR is high wherever AND is high, and more).
    for (let i = 0; i < n; i++) {
      if (or[i]! + 0.05 < and[i]!) throw new Error(`OR<AND at ${i}: or=${or[i]} and=${and[i]}`);
    }

    // Window truth: AND high only while BOTH gates high ([0,0.125)); low once
    // in1 falls ([0.25,0.5)). OR high through [0,0.375) (either gate); low in
    // its final quarter ([0.4,0.5)).
    expect(windowMean(and, Math.round(0.02 * SR), Math.round(0.1 * SR))).toBeGreaterThan(0.9);
    expect(windowMean(and, Math.round(0.3 * SR), Math.round(0.48 * SR))).toBeLessThan(0.1);
    expect(windowMean(or, Math.round(0.28 * SR), Math.round(0.36 * SR))).toBeGreaterThan(0.9);
    expect(windowMean(or, Math.round(0.42 * SR), Math.round(0.5 * SR))).toBeLessThan(0.1);

    // The math half is live and the two buses are genuinely different signals
    // (sum adds all four, diff flips the sign of ch3+ch4).
    expect(rms(sum)).toBeGreaterThan(0.05);
    expect(rms(diff)).toBeGreaterThan(0.05);
    let sumDiff = 0;
    for (let i = 0; i < n; i++) sumDiff = Math.max(sumDiff, Math.abs(sum[i]! - diff[i]!));
    expect(sumDiff).toBeGreaterThan(0.1); // sum ≠ diff (att3/att4 sign flip)

    // Deterministic re-render is bit-identical (stateless per-sample graph).
    const again = await renderProfile();
    for (const id of ['and', 'or', 'sum', 'diff'] as const) {
      let d = 0;
      for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(bufs[id]![i]! - again[id]![i]!));
      expect(d, id).toBe(0);
    }
  });

  it('pins the and + or + sum + diff profile baselines (SHA-gated, RMS tier B)', async () => {
    const srcSha = await docsStrippedRepoSourceSha('packages/web/src/lib/audio/modules/illogic.ts');
    await pinAll('illogic', srcSha, await renderProfile());
  });
});
