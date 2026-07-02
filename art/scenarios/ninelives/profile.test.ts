// art/scenarios/ninelives/profile.test.ts
//
// AUDIO PROFILE for NINE LIVES (9-output ⅓-ladder LFO) (backfill batch 3 —
// spec §4.1/§4.3, .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md),
// through the shared capture harness (capture.ts + worklet.ts).
//
// Category: self-driving MODULATION source — params only (spec §4.2), phase
// pinned to 0 at sample 0 by construction (fresh core, no reset needed).
//
// Patch: rate 8 Hz, shape 0 (sine — the shipping default waveform). Over
// the 1.5 s render the geometric ⅓ ladder is the module's whole signature:
//   out1 = 8 Hz      → 12 cycles      out2 = 8/3 Hz → 4 cycles
//   out3 = 8/9 Hz    → 1⅓ cycles      …every later tap ⅓ slower again,
//   down to out9 = 8/6561 Hz (a 13.7-minute cycle — over this window it is
//   still CLIMBING its first quarter-cycle, asserted structurally below).
//
// SIGNATURE outputs (owner decision §6b.2): out1, out2, out3 — the three
// taps whose rates genuinely read inside a gallery-scale window. out4..out9
// are the SAME waveform at (1/3)^n rates (near-DC here); they are rendered
// and asserted structurally (ladder ordering + the out9 quarter-cycle
// climb), not pinned as 6 more near-identical/near-DC dumps (the
// multi-out "independent information only" rule, spec §4.1/§5).
//
// Rendering path: the REAL worklet processor class via the shared shim
// loader — ninelives.ts is a thin self-contained wrapper around
// NineLivesCore (lib/ninelives-dsp.ts), pure math, no RNG.
//
// The .sha pins BOTH the worklet entry and the ladder core.

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { captureWorkletProcessor, renderWorklet } from '../../setup/worklet';

const SR = SAMPLE_RATE;
const DURATION_S = 1.5;
const RATE_HZ = 8;
const SHAPE = 0; // sine (shipping default)

const ALL_OUTS = ['out1', 'out2', 'out3', 'out4', 'out5', 'out6', 'out7', 'out8', 'out9'] as const;

async function renderProfile(): Promise<Record<string, Float32Array>> {
  const Proc = await captureWorkletProcessor(
    'ninelives',
    () => import('../../../packages/dsp/src/ninelives'),
    SR,
  );
  const proc = new Proc();
  const n = Math.round(SR * DURATION_S);
  return renderWorklet(proc, {
    totalSamples: n,
    // inputs[0] = reset (trigger) — unpatched: the ladder free-runs from
    // phase 0 (a fresh core starts all nine accumulators at 0).
    inputs: [null],
    params: { rate: RATE_HZ, shape: SHAPE },
    outputs: [...ALL_OUTS],
  });
}

/** Goertzel magnitude (normalized 2/N) of freqHz over the whole buffer. */
function goertzel(buf: Float32Array, freqHz: number): number {
  const N = buf.length;
  const w = (2 * Math.PI * freqHz) / SR;
  const coeff = 2 * Math.cos(w);
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < N; i++) {
    const q0 = coeff * q1 - q2 + buf[i]!;
    q2 = q1;
    q1 = q0;
  }
  const re = q1 - q2 * Math.cos(w);
  const im = q2 * Math.sin(w);
  return (2 / N) * Math.sqrt(re * re + im * im);
}

const peakAbs = (buf: Float32Array) => {
  let p = 0;
  for (const v of buf) p = Math.max(p, Math.abs(v));
  return p;
};

describe('ART ninelives / audio profile (8 Hz sine ladder, each tap ⅓ the rate of the last)', () => {
  it('renders the geometric ladder: each tap at its own ⅓-scaled rate, out9 near-DC', async () => {
    const bufs = await renderProfile();
    const out1 = bufs.out1!;
    const out2 = bufs.out2!;
    const out3 = bufs.out3!;
    expect(out1.length).toBe(Math.round(SR * DURATION_S));
    for (const k of ALL_OUTS) expect(bufs[k]!.every(Number.isFinite)).toBe(true);

    // Each captured tap's spectrum peaks at ITS rung of the ladder, not its
    // neighbours' (8, 8/3, 8/9 Hz are >1.5 bins apart over the 1.5 s window).
    const F1 = RATE_HZ;
    const F2 = RATE_HZ / 3;
    const F3 = RATE_HZ / 9;
    expect(goertzel(out1, F1)).toBeGreaterThan(goertzel(out1, F2) * 5);
    expect(goertzel(out2, F2)).toBeGreaterThan(goertzel(out2, F1) * 5);
    expect(goertzel(out2, F2)).toBeGreaterThan(goertzel(out2, F3) * 5);
    expect(goertzel(out3, F3)).toBeGreaterThan(goertzel(out3, F1) * 5);

    // Full bipolar ±1 swing on the taps that complete ≥¼ cycle.
    expect(peakAbs(out1)).toBeGreaterThan(0.95);
    expect(peakAbs(out2)).toBeGreaterThan(0.95);
    expect(peakAbs(out3)).toBeGreaterThan(0.95);
    for (const k of ALL_OUTS) expect(peakAbs(bufs[k]!)).toBeLessThanOrEqual(1);

    // Structural ladder assert on the uncaptured slow taps: each successive
    // tap has climbed LESS of its first cycle (strictly slower), and out9
    // (8/6561 Hz) is still inside its first quarter-cycle: tiny, positive,
    // and monotonically climbing across the whole render.
    for (let k = 3; k < ALL_OUTS.length - 1; k++) {
      expect(peakAbs(bufs[ALL_OUTS[k + 1]!]!)).toBeLessThan(peakAbs(bufs[ALL_OUTS[k]!]!) + 1e-9);
    }
    const out9 = bufs.out9!;
    expect(peakAbs(out9)).toBeLessThan(0.02);
    let monotone = true;
    for (let i = 1; i < out9.length; i++) {
      if (out9[i]! < out9[i - 1]!) {
        monotone = false;
        break;
      }
    }
    expect(monotone).toBe(true);
    expect(out9[out9.length - 1]!).toBeGreaterThan(0);

    // Deterministic re-render is bit-identical (fresh processor instance).
    const again = await renderProfile();
    for (const k of ['out1', 'out2', 'out3'] as const) {
      let diff = 0;
      for (let i = 0; i < out1.length; i++) diff = Math.max(diff, Math.abs(bufs[k]![i]! - again[k]![i]!));
      expect(diff).toBe(0);
    }
  });

  it('pins the out1/out2/out3 profile baselines (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('ninelives.ts', 'lib/ninelives-dsp.ts');
    const bufs = await renderProfile();
    await pinAll('ninelives', srcSha, { out1: bufs.out1!, out2: bufs.out2!, out3: bufs.out3! });
  });
});
