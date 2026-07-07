// art/scenarios/snaredrum/profile.test.ts
//
// AUDIO PROFILE for SNARE DRUM (id `snaredrum` — the deep stereo snare voice +
// polyphonic two-hand drumroll, design .myrobots/snare-drum-module-design.md).
// Ships with the module per the audio-profile gate (#999): every new audio def
// lands with ≥1 committed baseline.
//
// TWO signatures are pinned (design §6.2):
//   - hit_l  — a 2-strike TRIGGER train (120 BPM, 1.0 s) → the single-hit
//     snare signature. L only (a single hit is centered → R mirrors it).
//   - roll_l / roll_r — a HELD gate (0.95 s) → the sustained two-hand drumroll.
//     BOTH channels are pinned: unlike a single hit, the two hands + the
//     decorrelated wire bed genuinely decorrelate L and R.
//
// Rendered from the PURE core (packages/dsp/src/lib/snaredrum-dsp.ts
// snaredrumStepStereo — the full chain: HEAD modal bank + BODY noise + CRACK
// pool voices → shared re-excitable wire bed → shared oversampled-drive/DC bus →
// M/S stereo/ceiling; the roll driven by snare-roll-dsp.ts) with the def's
// shipping defaults — deterministic by construction: every strike resets phases
// + reseeds its xorshift, the roll reseeds its PRNG on the gate rising edge, and
// both drivers are epoch-pinned to sample 0.
//
// The .sha pin covers the worklet entry AND every -dsp lib the per-sample math
// flows through, so a coefficient change in ANY of them forces an intentional
// `task art:update` re-capture. Re-pin the .sha LAST (memory
// `art-sha-pin-regenerate-last`).

import { describe, expect, it } from 'vitest';
import {
  SNAREDRUM_DEFAULTS,
  makeSnaredrumState,
  snaredrumStepStereo,
} from '../../../packages/dsp/src/lib/snaredrum-dsp';
import { captureOutputs, dspSourceSha, pinAll, SAMPLE_RATE } from '../../setup/capture';
import { triggerTrain, heldGate } from '../../setup/drivers';

const SR = SAMPLE_RATE;
const DURATION_S = 1.0;

/** Default-patch 2-strike TRIGGER train (rising edges at 0 and 500 ms). */
function renderHit(): Record<string, Float32Array> {
  const trig = triggerTrain({ totalS: DURATION_S, bpm: 120 });
  const p = { ...SNAREDRUM_DEFAULTS };
  const st = makeSnaredrumState();
  const lr = new Float32Array(2);
  return captureOutputs({ durationS: DURATION_S, outputs: ['hit_l'] }, (i) => {
    snaredrumStepStereo(trig[i]!, 0, 0, p, SR, st, lr);
    return { hit_l: lr[0]! };
  });
}

/** Default-patch HELD gate → sustained two-hand roll (high 0..0.95 s, then a
 *  short ring-out so the tail is visible in the gallery). */
function renderRoll(): Record<string, Float32Array> {
  const gate = heldGate({ totalS: DURATION_S, onS: 0.95 });
  const p = { ...SNAREDRUM_DEFAULTS };
  const st = makeSnaredrumState();
  const lr = new Float32Array(2);
  return captureOutputs({ durationS: DURATION_S, outputs: ['roll_l', 'roll_r'] }, (i) => {
    snaredrumStepStereo(0, gate[i]!, 0, p, SR, st, lr);
    return { roll_l: lr[0]!, roll_r: lr[1]! };
  });
}

function rms(b: Float32Array, s = 0, e = b.length): number {
  let x = 0;
  for (let i = s; i < e; i++) x += b[i]! * b[i]!;
  return Math.sqrt(x / Math.max(1, e - s));
}
function peak(b: Float32Array): number {
  let p = 0;
  for (const v of b) p = Math.max(p, Math.abs(v));
  return p;
}
function dc(b: Float32Array): number {
  let s = 0;
  for (const v of b) s += v;
  return s / b.length;
}

describe('ART snaredrum / audio profile (default patch)', () => {
  it('renders a finite, audible, deterministic 2-strike snare', () => {
    const buf = renderHit().hit_l!;
    expect(buf.length).toBe(Math.round(SR * DURATION_S));
    expect(buf.every(Number.isFinite)).toBe(true);
    expect(peak(buf)).toBeGreaterThan(0.1);
    expect(peak(buf)).toBeLessThanOrEqual(1); // ends in the ceiling tanh
    // BOTH strikes landed.
    expect(rms(buf, 0, Math.round(0.08 * SR))).toBeGreaterThan(0.01);
    expect(rms(buf, Math.round(0.5 * SR), Math.round(0.58 * SR))).toBeGreaterThan(0.01);
    expect(Math.abs(dc(buf))).toBeLessThan(0.01);
    // Deterministic: a second render is bit-identical.
    const again = renderHit().hit_l!;
    let diff = 0;
    for (let i = 0; i < buf.length; i++) diff = Math.max(diff, Math.abs(buf[i]! - again[i]!));
    expect(diff).toBe(0);
  });

  it('renders a CONTINUOUS, decorrelated, deterministic two-hand roll', () => {
    const { roll_l, roll_r } = renderRoll();
    const l = roll_l!;
    const r = roll_r!;
    expect(l.every(Number.isFinite) && r.every(Number.isFinite)).toBe(true);
    expect(peak(l)).toBeGreaterThan(0.2);
    expect(peak(r)).toBeGreaterThan(0.2);
    expect(peak(l)).toBeLessThanOrEqual(1);
    expect(peak(r)).toBeLessThanOrEqual(1);
    // Continuity: every 25 ms window across the held span carries energy.
    const win = Math.round(0.025 * SR);
    let minL = Infinity;
    for (let w = Math.round(0.2 * SR); w + win < Math.round(0.9 * SR); w += win) {
      minL = Math.min(minL, rms(l, w, w + win));
    }
    expect(minL).toBeGreaterThan(0.02); // no silent gaps — a real roll
    // Genuinely stereo (the two hands + wire bed decorrelate L/R).
    let diff = 0;
    for (let i = 0; i < l.length; i++) diff = Math.max(diff, Math.abs(l[i]! - r[i]!));
    expect(diff).toBeGreaterThan(1e-3);
    expect(Math.abs(dc(l))).toBeLessThan(0.01);
    // Deterministic across renders.
    const again = renderRoll();
    let d2 = 0;
    for (let i = 0; i < l.length; i++) d2 = Math.max(d2, Math.abs(l[i]! - again.roll_l![i]!));
    expect(d2).toBe(0);
  });

  it('pins the profile baselines (SHA-gated, RMS tier B)', async () => {
    const srcSha = await dspSourceSha(
      'snaredrum.ts',
      'lib/snaredrum-dsp.ts',
      'lib/snare-roll-dsp.ts',
      'lib/dsp-utils.ts',
      'lib/oversample.ts',
      'lib/rbj-biquad.ts',
    );
    const hit = renderHit();
    const roll = renderRoll();
    await pinAll('snaredrum', srcSha, { ...hit, ...roll });
  });
});
