// art/scenarios/moog-cp3/profile.test.ts
//
// AUDIO PROFILE for MOOG CP3 (console panel mixer) (backfill batch 4 —
// spec §4.1/§4.3, .myrobots/plans/art-backfill-audio-profiles-2026-07-01.md),
// through the shared capture harness (capture.ts + drivers.ts + worklet.ts).
//
// Category: MIXER — the CP3's signature is (a) per-channel gain UP TO ×2
// (a console that can BOOST, not just trim) and (b) mixing AC and/or DC on
// the same bus. The patch exercises both:
//   in1  = C4 sine (ch1 at 1.0 → the full ×2 BOOST)
//   in2  = C4 saw  (ch2 0.25 → ×0.5 — the harmonic comb, trimmed)
//   in3  = 1 kHz sine (ch3 0.15 → ×0.3 — the off-grid treble probe)
//   ext4 = 2 Hz sine "CV" on the external 4th-input jack (attenuator4 0.8,
//          ch4 0.5 → ×1) — a slow bipolar drift riding the audio bus, the
//          CP3's AC+DC console character. in4 (the panel jack) is unpatched.
//
// Rendering path: the REAL worklet processor class via the shared shim
// loader — moog-cp3.ts wraps the pure cp3Mix core (lib/moog-cp3-dsp.ts)
// plus 80 Hz one-pole knob smoothers (lib/wavetable-osc.ts WtParamSmoother,
// primed at 1), pure math, no RNG. The smoothers mean knobs ≠ 1 settle over
// the first few ms (a deterministic spawn-transient — part of the shipping
// sound, kept in the profile).
//
// SIGNATURE output (owner decision §6b.2): ONE baseline `out_positive`.
// The other six outs are proven derivative in-scenario, not pinned:
//   out_negative   ≡ −out_positive (exact phase inverse, affine dup)
//   multiple_1..3  ≡ in1 (unaltered passthrough of the driver)
//   plus_twelve / minus_six ≡ the constant reference rails (+2.4 / −1.2)
//
// The .sha pins the worklet entry + the mix core + the smoother lib.

import { describe, expect, it } from 'vitest';
import {
  CP3_MINUS_6V,
  CP3_PLUS_12V,
} from '../../../packages/dsp/src/lib/moog-cp3-dsp';
import { dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { C4_HZ, vcoTestSignal } from '../../setup/drivers';
import { captureWorkletProcessor, renderWorklet } from '../../setup/worklet';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;
const IN3_HZ = 1000;
const DRIFT_HZ = 2;

// Drivers (built once — the multiple/passthrough assertions compare against
// these exact buffers).
const in1 = vcoTestSignal({ totalS: DURATION_S, shape: 'sine', amp: 0.4 });
const in2 = vcoTestSignal({ totalS: DURATION_S, shape: 'saw', amp: 0.5 });
const in3 = vcoTestSignal({ totalS: DURATION_S, shape: 'sine', freqHz: IN3_HZ, amp: 0.5 });
const ext4 = vcoTestSignal({ totalS: DURATION_S, shape: 'sine', freqHz: DRIFT_HZ, amp: 0.75 });

async function renderProfile(): Promise<Record<string, Float32Array>> {
  const Proc = await captureWorkletProcessor(
    'moog-cp3',
    () => import('../../../packages/dsp/src/moog-cp3'),
    SR,
  );
  const proc = new Proc();
  const n = Math.round(SR * DURATION_S);
  return renderWorklet(proc, {
    totalSamples: n,
    // inputs[0..3] = in1..in4 (in4 unpatched), inputs[4] = ext4.
    inputs: [in1, in2, in3, null, ext4],
    params: { ch1: 1.0, ch2: 0.25, ch3: 0.15, ch4: 0.5, attenuator4: 0.8 },
    outputs: [
      'out_positive',
      'out_negative',
      'multiple_one',
      'multiple_two',
      'multiple_three',
      'plus_twelve',
      'minus_six',
    ],
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

describe('ART moog-cp3 / audio profile (×2-boosted sine + trimmed saw + 1 kHz + 2 Hz drift on one bus)', () => {
  it('mixes all four sources onto (+), with (−)/multiples/rails exactly derivative', async () => {
    const bufs = await renderProfile();
    const pos = bufs.out_positive!;
    const n = Math.round(SR * DURATION_S);
    expect(pos.length).toBe(n);
    expect(pos.every(Number.isFinite)).toBe(true);

    // Every source is audible on the (+) bus. Probe past the first 100 ms so
    // the 80 Hz knob smoothers have settled. Expected steady levels:
    // C4 sine 0.4×2=0.8, saw fundamental ~0.25·(2/π)·… (just assert presence),
    // 1 kHz 0.5×0.3=0.15, 2 Hz drift 0.75×0.8×1=0.6.
    const s = Math.round(0.1 * SR);
    expect(goertzel(pos, s, n, C4_HZ)).toBeGreaterThan(0.5); // boosted sine dominates
    expect(goertzel(pos, s, n, C4_HZ * 2)).toBeGreaterThan(0.02); // saw's 2nd harmonic
    expect(goertzel(pos, s, n, IN3_HZ)).toBeGreaterThan(0.1);
    // The slow drift: 2 Hz over the full second (two cycles).
    expect(goertzel(pos, 0, n, DRIFT_HZ)).toBeGreaterThan(0.3);

    // Linear console — hot but bounded (no clip stage on the CP3 bus).
    let peak = 0;
    for (const v of pos) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.9);
    expect(peak).toBeLessThan(2);

    // (−) is the EXACT phase inverse of (+).
    const neg = bufs.out_negative!;
    let invDiff = 0;
    for (let i = 0; i < n; i++) invDiff = Math.max(invDiff, Math.abs(neg[i]! + pos[i]!));
    expect(invDiff).toBe(0);

    // The MULTIPLE: all three outs are the in1 driver, unaltered.
    for (const name of ['multiple_one', 'multiple_two', 'multiple_three'] as const) {
      const m = bufs[name]!;
      let d = 0;
      for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(m[i]! - in1[i]!));
      expect(d, `${name} must be the unaltered in1 passthrough`).toBe(0);
    }

    // Trunk rails: constant +2.4 / −1.2 (float32-stored), −6 V = −(+12 V)/2.
    const p12 = Math.fround(CP3_PLUS_12V);
    const m6 = Math.fround(CP3_MINUS_6V);
    expect(bufs.plus_twelve!.every((v) => v === p12)).toBe(true);
    expect(bufs.minus_six!.every((v) => v === m6)).toBe(true);
    expect(CP3_MINUS_6V).toBe(-CP3_PLUS_12V / 2);

    // Deterministic re-render is bit-identical (fresh processor instance).
    const again = (await renderProfile()).out_positive!;
    let diff = 0;
    for (let i = 0; i < n; i++) diff = Math.max(diff, Math.abs(pos[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('pins the out_positive profile baseline (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha(
      'moog-cp3.ts',
      'lib/moog-cp3-dsp.ts',
      'lib/wavetable-osc.ts',
    );
    const bufs = await renderProfile();
    await pinAll('moog-cp3', srcSha, { out_positive: bufs.out_positive! });
  });
});
