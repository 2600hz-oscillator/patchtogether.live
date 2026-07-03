// art/scenarios/analog-logic-maths/profile.test.ts
//
// AUDIO PROFILE for ANALOGLOGICMATHS (analog logic mixer) (backfill
// batch 4 — spec §4.1/§4.3,
// .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md), through the
// shared capture harness (capture.ts + drivers.ts + worklet.ts).
//
// Category: CV UTILITY / dual-input algebra. The classic ANA demo patch —
// one AUDIO-rate and one SLOW input, so each output's character is legible
// in the gallery:
//   a = C4 sine (±0.5, audio rate)
//   b = 2 Hz saw (±1, a slow full-range ramp)
//   attA = attB = 1 (shipping defaults)
//
// The five simultaneous combinations each read differently against that
// pair: MIN/MAX chop the sine against the rising ramp (analog "logic"),
// DIFF rides the sine on the inverted ramp (unclamped, spans ±1.5), SUM is
// the tanh-soft-clipped drift, PRODUCT is the ramp amplitude-modulating the
// sine through the tanh.
//
// Rendering path: the REAL worklet processor class via the shared shim
// loader — analog-logic-maths.ts is fully self-contained stateless pure
// math (min/max/diff + tanh soft-clips), no RNG.
//
// SIGNATURE outputs (owner decision §6b.2): ALL FIVE — min / max / diff /
// sum / product are genuinely different algebraic taps of the same pair.
//
// The .sha pins the (self-contained) worklet entry.

import { describe, expect, it } from 'vitest';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { vcoTestSignal } from '../../setup/drivers';
import { captureWorkletProcessor, renderWorklet } from '../../setup/worklet';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;
const RAMP_HZ = 2;

const a = vcoTestSignal({ totalS: DURATION_S, shape: 'sine', amp: 0.5 });
const b = vcoTestSignal({ totalS: DURATION_S, shape: 'saw', freqHz: RAMP_HZ, amp: 1 });

const OUTPUTS = ['min', 'max', 'diff', 'sum', 'product'] as const;

async function renderProfile(): Promise<Record<string, Float32Array>> {
  const Proc = await captureWorkletProcessor(
    'analog-logic-maths',
    () => import('../../../packages/dsp/src/analog-logic-maths'),
    SR,
  );
  const proc = new Proc();
  const n = Math.round(SR * DURATION_S);
  return renderWorklet(proc, {
    totalSamples: n,
    // inputs[0] = a, inputs[1] = b (the att CVs are AudioParams, not inputs).
    inputs: [a, b],
    params: { attA: 1.0, attB: 1.0 },
    outputs: [...OUTPUTS],
  });
}

describe('ART analog-logic-maths / audio profile (C4 sine vs 2 Hz ramp through all five ops)', () => {
  it('emits the five exact algebraic combinations of the pair', async () => {
    const bufs = await renderProfile();
    const n = Math.round(SR * DURATION_S);
    for (const name of OUTPUTS) {
      expect(bufs[name]!.length).toBe(n);
      expect(bufs[name]!.every(Number.isFinite)).toBe(true);
    }

    // Exact per-sample laws (attA = attB = 1, so a' = a, b' = b; f64 math,
    // float32 store — the I/O-wiring proof).
    for (let i = 0; i < n; i++) {
      const ap = a[i]!;
      const bp = b[i]!;
      if (bufs.min![i]! !== (ap < bp ? ap : bp)) throw new Error(`min sample ${i}`);
      if (bufs.max![i]! !== (ap > bp ? ap : bp)) throw new Error(`max sample ${i}`);
      if (bufs.diff![i]! !== Math.fround(ap - bp)) throw new Error(`diff sample ${i}`);
      if (bufs.sum![i]! !== Math.fround(Math.tanh(ap + bp))) throw new Error(`sum sample ${i}`);
      if (bufs.product![i]! !== Math.fround(Math.tanh(ap * bp))) throw new Error(`product sample ${i}`);
    }

    // Character checks: MIN ≤ MAX everywhere; when the ramp sits below the
    // sine's whole range (b < −0.5), MIN follows the ramp and MAX the sine.
    for (let i = 0; i < n; i++) {
      if (bufs.min![i]! > bufs.max![i]!) throw new Error(`min > max at ${i}`);
    }
    const probe = Math.round(0.05 * SR); // early in the ramp: b ≈ −0.8
    expect(b[probe]!).toBeLessThan(-0.5);
    expect(bufs.min![probe]!).toBe(b[probe]!);
    expect(bufs.max![probe]!).toBe(a[probe]!);

    // DIFF is the only unclamped tap — it exceeds ±1 (sine minus ramp spans
    // ±1.5); SUM and PRODUCT stay strictly inside the tanh's (−1, 1).
    let diffPeak = 0;
    let sumPeak = 0;
    let prodPeak = 0;
    for (let i = 0; i < n; i++) {
      diffPeak = Math.max(diffPeak, Math.abs(bufs.diff![i]!));
      sumPeak = Math.max(sumPeak, Math.abs(bufs.sum![i]!));
      prodPeak = Math.max(prodPeak, Math.abs(bufs.product![i]!));
    }
    expect(diffPeak).toBeGreaterThan(1.2);
    expect(sumPeak).toBeLessThan(1);
    expect(prodPeak).toBeLessThan(1);
    expect(prodPeak).toBeGreaterThan(0.2);

    // Deterministic re-render is bit-identical (stateless per-sample math).
    const again = await renderProfile();
    for (const name of OUTPUTS) {
      let diff = 0;
      for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(bufs[name]![i]! - again[name]![i]!));
      expect(diff, name).toBe(0);
    }
  });

  it('pins the five profile baselines (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha('analog-logic-maths.ts');
    await pinAll('analog-logic-maths', srcSha, await renderProfile());
  });
});
