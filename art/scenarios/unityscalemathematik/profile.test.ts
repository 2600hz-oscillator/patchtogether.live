// art/scenarios/unityscalemathematik/profile.test.ts
//
// AUDIO PROFILE for UNITYSCALEMATHEMATIK (triple CV shaper) (backfill
// batch 4 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (capture.ts + drivers.ts + worklet.ts).
//
// Category: CV UTILITY (waveshaper). All three sections are fed the SAME
// canonical bipolar test ramp (a 2 Hz ±1 saw — a slow full-range sweep, so
// each output IS its section's transfer curve drawn twice across the
// window), making the three response laws directly comparable in the
// gallery:
//   UNITY: ×0.7 linear            (u_out = 0.7·x — a plain attenuator)
//   A:     curve 0.5 → k = 2      (a_out = sign(x)·x² — soft expo bend)
//   B:     curve 1.0 → k = 3, atten −1 (b_out = −sign(x)·|x|³ — steepest
//          expo, INVERTED: the attenuverter half of the panel)
//
// Rendering path: the REAL worklet processor class via the shared shim
// loader — unityscalemathematik.ts is fully self-contained pure math
// (sign-preserving |x|^k power law + attenuverter), no RNG, no state.
//
// SIGNATURE outputs (owner decision §6b.2): all three — u_out / a_out /
// b_out are three genuinely different transfer laws over the same input.
//
// The .sha pins the (self-contained) worklet entry.

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal } from '../../setup/drivers';
import { captureWorkletProcessor, renderWorklet } from '../../setup/worklet';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;
const RAMP_HZ = 2;

const ramp = vcoTestSignal({ totalS: DURATION_S, shape: 'saw', freqHz: RAMP_HZ, amp: 1 });

const U_ATTEN = 0.7;
const A_CURVE = 0.5; // k = 1 + 2·0.5 = 2
const B_CURVE = 1.0; // k = 3
const B_ATTEN = -1.0; // inverted (attenuverter)

async function renderProfile(): Promise<Record<string, Float32Array>> {
  const Proc = await captureWorkletProcessor(
    'unityscalemathematik',
    () => import('../../../packages/dsp/src/unityscalemathematik'),
    SR,
  );
  const proc = new Proc();
  const n = Math.round(SR * DURATION_S);
  return renderWorklet(proc, {
    totalSamples: n,
    // inputs[0] = u_in, inputs[1] = a_in, inputs[2] = b_in — the same ramp.
    inputs: [ramp, ramp, ramp],
    params: {
      unityAtten: U_ATTEN,
      aAtten: 1.0,
      aCurve: A_CURVE,
      bAtten: B_ATTEN,
      bCurve: B_CURVE,
    },
    outputs: ['u_out', 'a_out', 'b_out'],
  });
}

describe('ART unityscalemathematik / audio profile (±1 ramp through ×0.7 linear, x², −x³)', () => {
  it('applies the three transfer laws exactly, sign-preserved and bounded', async () => {
    const bufs = await renderProfile();
    const n = Math.round(SR * DURATION_S);
    const u = bufs.u_out!;
    const a = bufs.a_out!;
    const b = bufs.b_out!;
    for (const buf of [u, a, b]) {
      expect(buf.length).toBe(n);
      expect(buf.every(Number.isFinite)).toBe(true);
    }

    // Exact per-sample laws (same float ops as the worklet: float32 params,
    // f64 math, float32 store). This is the I/O-wiring proof; the shape
    // checks below are the behavioral ones.
    const uAtt = Math.fround(U_ATTEN);
    const bAtt = Math.fround(B_ATTEN);
    for (let i = 0; i < n; i++) {
      const x = ramp[i]!;
      const ax = Math.abs(x);
      const s = x < 0 ? -1 : x > 0 ? 1 : 0;
      if (u[i]! !== Math.fround(x * uAtt)) throw new Error(`u_out sample ${i}`);
      if (a[i]! !== Math.fround(s * Math.pow(ax, 2) * 1)) throw new Error(`a_out sample ${i}`);
      if (b[i]! !== Math.fround(s * Math.pow(ax, 3) * bAtt)) throw new Error(`b_out sample ${i}`);
    }

    // Shape: the expo curves hug zero harder than the linear pass (|x|^k ≤ |x|
    // for |x| ≤ 1), so mean magnitude ranks u (0.7·mean|x| = 0.35) > a
    // (mean x² = ⅓) > b (mean |x|³ = ¼) over the full-range ramp.
    const meanAbs = (buf: Float32Array) => {
      let m = 0;
      for (const v of buf) m += Math.abs(v);
      return m / buf.length;
    };
    expect(meanAbs(u)).toBeGreaterThan(meanAbs(a));
    expect(meanAbs(a)).toBeGreaterThan(meanAbs(b));
    // B is INVERTED: where the ramp is clearly positive, b_out is negative.
    // The saw rises −1 → +1 across its 0.5 s period, so probe just before
    // the wrap: t = 0.49 s → phase 0.98 → ramp ≈ +0.96.
    const probe = Math.round(0.49 * SR);
    expect(ramp[probe]!).toBeGreaterThan(0.5);
    expect(b[probe]!).toBeLessThan(-0.1);
    expect(a[probe]!).toBeGreaterThan(0.1);

    // Deterministic re-render is bit-identical (stateless per-sample math).
    const again = await renderProfile();
    for (const name of ['u_out', 'a_out', 'b_out'] as const) {
      let diff = 0;
      for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(bufs[name]![i]! - again[name]![i]!));
      expect(diff, name).toBe(0);
    }
  });

  it('pins the u_out/a_out/b_out profile baselines (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('unityscalemathematik.ts');
    await pinAll('unityscalemathematik', srcSha, await renderProfile());
  });
});
