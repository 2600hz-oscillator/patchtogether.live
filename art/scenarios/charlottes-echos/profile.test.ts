// art/scenarios/charlottes-echos/profile.test.ts
//
// AUDIO PROFILE for CHARLOTTE'S ECHOS (4-stage cascaded tape echo)
// (backfill batch 4 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (capture.ts + drivers.ts + worklet.ts).
//
// Category: FX with an ECHO TAIL — so per spec §4.1 the render is 2.0 s and
// the driver is the canonical TRANSIENT (toneBurst: a 60 ms C4 saw hit,
// then silence — the cocoadelay batch-2 precedent), so the compounding
// multi-stage tail IS the profile.
//
// Patch: delay 0.15 s (a 2 s window can't show the default 0.4 s × 4-stage
// cascade), pitchUp 0.08 — the module's SIGNATURE ascending-shimmer: each
// of the four chained Cocoa stages reads its tape at (1.08)^k varispeed, so
// EVERYTHING reaching the output is pitched up by at least
// 1.08·1.08²·1.08³ ≈ ×1.587 (stages 1–3 in series; stage 0 reads at unity)
// and later repeats climb further. feedback 0.5 / decay 0.2 / mix 0.5 stay
// at shipping defaults.
//
// Rendering path: the REAL worklet processor class via the shared shim
// loader — charlottes-echos.ts chains four CocoaDelayCore engines
// (cocoadelay-core.ts) with FIXED per-stage seeds (1..4) and drift/LFO
// wobble disabled in this build, so the render is deterministic by
// construction (the cocoadelay batch-2 finding, ×4).
//
// SIGNATURE output (owner decision §6b.2): ONE baseline `L`. With the mono
// driver and this patch (stereoOffset 0, pan 0) the chain is left/right
// symmetric — L ≡ R is asserted below, so one profile covers both ports
// (bus-duplicate rule, spec §4.1).
//
// The .sha pins BOTH the worklet entry and the shared Cocoa core.

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { C4_HZ, toneBurst } from '../../setup/drivers';
import { captureWorkletProcessor, renderWorklet } from '../../setup/worklet';

const SR = SAMPLE_RATE;
const DURATION_S = 2.0;
const BURST_S = 0.06;

const DELAY_S = 0.15;
const PITCH_UP = 0.08;
// The minimum cumulative varispeed ratio of ANY output content: stages 1–3
// in series read at (1+p), (1+p)², (1+p)³.
const MIN_SHIFT = Math.pow(1 + PITCH_UP, 1 + 2 + 3);

const input = toneBurst({ totalS: DURATION_S, burstS: BURST_S, amp: 0.6 });

async function renderProfile(): Promise<Record<string, Float32Array>> {
  const Proc = await captureWorkletProcessor(
    'charlottes-echos',
    () => import('../../../packages/dsp/src/charlottes-echos'),
    SR,
  );
  const proc = new Proc();
  const n = Math.round(SR * DURATION_S);
  return renderWorklet(proc, {
    totalSamples: n,
    // inputs[0] = L (the worklet mirrors it onto R when R is unpatched);
    // inputs[2] = the delay CV port's AudioParam fast-path is param-side.
    inputs: [input, null],
    params: { delay: DELAY_S, feedback: 0.5, decay: 0.2, pitchUp: PITCH_UP, mix: 0.5 },
    outputs: ['L', 'R'],
  });
}

/** Goertzel magnitude (normalized 2/N) of freqHz over buf[s, e). */
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

function rms(b: Float32Array, s: number, e: number): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}

describe("ART charlottes-echos / audio profile (60 ms saw burst → ascending 4-stage echo tail)", () => {
  it('rings an audible decaying tail whose content is pitched ABOVE the dry burst', async () => {
    const bufs = await renderProfile();
    const out = bufs.L!;
    const n = Math.round(SR * DURATION_S);
    expect(out.length).toBe(n);
    expect(out.every(Number.isFinite)).toBe(true);

    // Stereo symmetry (why only L is pinned): mono driver + centered patch.
    const r = bufs.R!;
    let lrDiff = 0;
    for (let i = 0; i < n; i++) lrDiff = Math.max(lrDiff, Math.abs(out[i]! - r[i]!));
    expect(lrDiff).toBe(0);

    // The dry burst dominates the first 60 ms (mix 0.5 passes half the dry).
    expect(rms(out, 0, Math.round(BURST_S * SR))).toBeGreaterThan(0.08);

    // An audible wet tail exists well after the burst…
    const tail = rms(out, Math.round(0.3 * SR), Math.round(1.5 * SR));
    expect(tail).toBeGreaterThan(0.004);
    // …and it decays (feedback 0.5 + decay taper): the last 0.4 s sits well
    // below the loudest early-tail stretch.
    const early = rms(out, Math.round(0.3 * SR), Math.round(0.9 * SR));
    const late = rms(out, Math.round(1.6 * SR), n);
    expect(late).toBeLessThan(early * 0.7);

    // The ascending-shimmer signature: everything post-burst passed stages
    // 1–3's varispeed at least once, so the wet tail's energy at the SHIFTED
    // fundamental (≈ C4 × 1.587 ≈ 415 Hz) clearly beats any residue at the
    // ORIGINAL C4 — the dry pitch is gone from the tail.
    const s = Math.round(0.3 * SR);
    const e = Math.round(1.5 * SR);
    const shifted = goertzel(out, s, e, C4_HZ * MIN_SHIFT);
    const original = goertzel(out, s, e, C4_HZ);
    expect(shifted).toBeGreaterThan(original * 2);

    // Bounded (the worklet hard-clamps wet at ±2, mixed 50/50).
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThan(1.5);

    // Deterministic re-render is bit-identical (fresh processor; all four
    // Cocoa stages run fixed seeds, no Math.random anywhere in the path).
    const again = (await renderProfile()).L!;
    let diff = 0;
    for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(out[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the L profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('charlottes-echos.ts', 'cocoadelay-core.ts');
    const bufs = await renderProfile();
    await pinAll('charlottes-echos', srcSha, { L: bufs.L! });
  });
});
