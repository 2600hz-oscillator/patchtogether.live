// packages/web/src/lib/video/toybox-cv-math.test.ts
//
// PURE coverage for the TOYBOX modulation-section math (attenuverter + offset +
// no-cable + clamp + param-range map). Deterministic — no Yjs / GL / DOM.

import { describe, it, expect } from 'vitest';
import {
  effectiveNorm,
  effectiveCvValue,
  foldCvToUnipolar,
  followEnvelope,
  makeEnvelopeFollower,
  DEFAULT_INPUT_SCALE,
  DEFAULT_INPUT_OFFSET,
} from './toybox-cv-math';

describe('defaults — a fresh cable modulates immediately', () => {
  it('SCALE default = +1 (full positive depth), OFFSET default = 0', () => {
    expect(DEFAULT_INPUT_SCALE).toBe(1);
    expect(DEFAULT_INPUT_OFFSET).toBe(0);
  });
  it('with the defaults a rising 0..1 signal sweeps the param min→max', () => {
    // signal 0 → norm 0 → min; signal 1 → norm 1 → max.
    expect(effectiveCvValue(0, 1, 0, 10, 20)).toBe(10);
    expect(effectiveCvValue(1, 1, 0, 10, 20)).toBe(20);
    expect(effectiveCvValue(0.5, 1, 0, 10, 20)).toBe(15);
  });
});

describe('effectiveNorm — attenuverter semantics', () => {
  it('SCALE 0 = off: the input is ignored, norm parks at OFFSET', () => {
    expect(effectiveNorm(1, 0, 0.3)).toBeCloseTo(0.3, 6);
    expect(effectiveNorm(-1, 0, 0.7)).toBeCloseTo(0.7, 6);
    expect(effectiveNorm(0.42, 0, 0.5)).toBeCloseTo(0.5, 6);
  });
  it('SCALE +1 passes the signal through, offset shifts it', () => {
    expect(effectiveNorm(0.4, 1, 0)).toBeCloseTo(0.4, 6);
    expect(effectiveNorm(0.4, 1, 0.2)).toBeCloseTo(0.6, 6);
  });
  it('SCALE < 0 INVERTS (left of center): a rising signal lowers norm', () => {
    // signal 1, scale -1, offset 1 → norm 0 (full invert from the top).
    expect(effectiveNorm(1, -1, 1)).toBeCloseTo(0, 6);
    expect(effectiveNorm(0, -1, 1)).toBeCloseTo(1, 6);
    expect(effectiveNorm(0.25, -1, 1)).toBeCloseTo(0.75, 6);
    // half-depth invert.
    expect(effectiveNorm(1, -0.5, 0.5)).toBeCloseTo(0, 6);
    expect(effectiveNorm(0, -0.5, 0.5)).toBeCloseTo(0.5, 6);
  });
  it('OFFSET centred at 0.5 gives a bipolar wiggle around the param midpoint', () => {
    // signal folded cv: -1→0, 0→0.5, +1→1 (the caller folds bipolar cv to 0..1).
    expect(effectiveNorm(0.5, 0.5, 0.25)).toBeCloseTo(0.5, 6); // signal 0.5, half depth, offset .25
    expect(effectiveNorm(0, 1, 0.5)).toBeCloseTo(0.5, 6); // no input → centre
    expect(effectiveNorm(0.5, 1, 0.5)).toBeCloseTo(1, 6); // up swing → top
  });
});

describe('no-cable → OFFSET is the manual control value', () => {
  it('signal 0 yields exactly OFFSET in norm (and OFFSET-mapped in the range)', () => {
    expect(effectiveNorm(0, 1, 0.0)).toBe(0);
    expect(effectiveNorm(0, 1, 0.5)).toBe(0.5);
    expect(effectiveNorm(0, -1, 0.75)).toBe(0.75);
    // mapped to a range: offset 0.5 over 0..3 = 1.5.
    expect(effectiveCvValue(0, 1, 0.5, 0, 3)).toBeCloseTo(1.5, 6);
  });
});

describe('clamp — never escapes 0..1 / [min,max]', () => {
  it('clamps norm to 0..1 on overshoot/undershoot', () => {
    expect(effectiveNorm(1, 1, 0.5)).toBe(1); // 1.5 → 1
    expect(effectiveNorm(1, -1, 0)).toBe(0); // -1 → 0
    expect(effectiveNorm(2, 1, 0)).toBe(1); // out-of-convention high signal
  });
  it('effectiveCvValue stays within [min, max]', () => {
    expect(effectiveCvValue(1, 1, 0.9, 0, 3)).toBeLessThanOrEqual(3);
    expect(effectiveCvValue(1, 1, 0.9, 0, 3)).toBeCloseTo(3, 6);
    expect(effectiveCvValue(-1, 1, 0, 0, 3)).toBeCloseTo(0, 6);
  });
  it('handles inverted ranges + negative mins', () => {
    // a param spanning -PI..PI: offset 0.5, no signal → 0 (the midpoint).
    const PI = Math.PI;
    expect(effectiveCvValue(0, 1, 0.5, -PI, PI)).toBeCloseTo(0, 6);
    expect(effectiveCvValue(1, 1, 0.5, -PI, PI)).toBeCloseTo(PI, 6);
    expect(effectiveCvValue(0, 1, 0, -PI, PI)).toBeCloseTo(-PI, 6);
  });
});

describe('robustness — non-finite inputs degrade to safe values', () => {
  it('NaN / Infinity signal/scale/offset never produce NaN', () => {
    expect(Number.isFinite(effectiveNorm(NaN, 1, 0.5))).toBe(true);
    expect(effectiveNorm(NaN, 1, 0.5)).toBe(0.5); // signal→0 → offset
    expect(effectiveNorm(1, NaN, 0.5)).toBe(1); // scale→default(+1) → 1.5 clamp 1
    expect(effectiveNorm(0.4, 1, NaN)).toBeCloseTo(0.4, 6); // offset→default 0
    expect(Number.isFinite(effectiveCvValue(Infinity, 1, 0, 0, 3))).toBe(true);
  });
});

describe('foldCvToUnipolar — bipolar cv/gate → 0..1', () => {
  it('folds −1→0, 0→0.5, +1→1 and clamps out-of-range', () => {
    expect(foldCvToUnipolar(-1)).toBeCloseTo(0, 6);
    expect(foldCvToUnipolar(0)).toBeCloseTo(0.5, 6);
    expect(foldCvToUnipolar(1)).toBeCloseTo(1, 6);
    expect(foldCvToUnipolar(-2)).toBe(0); // clamp
    expect(foldCvToUnipolar(2)).toBe(1); // clamp
    expect(foldCvToUnipolar(NaN)).toBe(0.5); // non-finite → 0 → 0.5
  });
});

describe('followEnvelope — audio RMS → 0..1 with fast attack / slow release', () => {
  const sine = (amp: number, n = 1024) => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * i * 8) / n);
    return a;
  };

  it('silence (all-zero window) yields 0', () => {
    const env = makeEnvelopeFollower();
    expect(followEnvelope(env, new Float32Array(512))).toBe(0);
  });

  it('a full-scale sine rises toward its RMS (~0.707)', () => {
    const env = makeEnvelopeFollower(1, 1); // instant coefs to read steady-state in one step
    const v = followEnvelope(env, sine(1));
    expect(v).toBeCloseTo(Math.SQRT1_2, 2); // RMS of a unit sine = 1/√2
  });

  it('stays unipolar (≥0) for a bipolar audio window', () => {
    const env = makeEnvelopeFollower();
    const v = followEnvelope(env, sine(0.8));
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });

  it('attack is FASTER than release (rises quicker than it falls)', () => {
    // Rise: from 0 toward a loud window — one step of attack.
    const up = makeEnvelopeFollower();
    const loud = sine(1);
    const afterAttack = followEnvelope(up, loud);

    // Now decay from that same value into silence — one step of release.
    const down = makeEnvelopeFollower();
    down.value = afterAttack;
    const beforeRelease = down.value;
    const afterRelease = followEnvelope(down, new Float32Array(loud.length)); // silence

    const rose = afterAttack - 0; // climbed from 0
    const fell = beforeRelease - afterRelease; // dropped toward 0
    // With default fast-attack(0.5)/slow-release(0.05), one attack step climbs
    // far more than one release step falls from the same level.
    expect(rose).toBeGreaterThan(fell);
  });

  it('clamps to 1 for an over-unity window', () => {
    const env = makeEnvelopeFollower(1, 1);
    const hot = new Float32Array(256).fill(4); // RMS 4 → clamp 1
    expect(followEnvelope(env, hot)).toBe(1);
  });
});
