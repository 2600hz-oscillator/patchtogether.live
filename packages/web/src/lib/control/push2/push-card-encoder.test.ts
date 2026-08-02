// packages/web/src/lib/control/push2/push-card-encoder.test.ts
//
// Turning a push-card encoder: value in, value out. The three movement modes
// exist because ONE rule is provably wrong for real shipped params, so each
// mode's test is written to fail if the code fell back to fraction stepping.
import { describe, it, expect } from 'vitest';

import type { ParamDef } from '$lib/graph/types';
import { knobValueToFrac, knobFracToValue } from '$lib/ui/controls/knob-conic-model';
import {
  nudgeParamValue,
  clampEncoderDelta,
  ENCODER_FRAC_STEP,
  ENCODER_FRAC_STEP_FINE,
  MAX_ENCODER_STEP,
} from './push-card-encoder';

function param(over: Partial<ParamDef> = {}): ParamDef {
  return { id: 'p', label: 'p', defaultValue: 0, min: 0, max: 1, curve: 'linear', ...over };
}

describe('clampEncoderDelta', () => {
  it('clamps a hard flick and rejects garbage', () => {
    expect(clampEncoderDelta(63)).toBe(MAX_ENCODER_STEP);
    expect(clampEncoderDelta(-63)).toBe(-MAX_ENCODER_STEP);
    expect(clampEncoderDelta(3)).toBe(3);
    expect(clampEncoderDelta(Number.NaN)).toBe(0);
  });
});

describe('continuous params move in FRACTION space', () => {
  it('one detent is 1 % of the arc on a linear 0..1 param', () => {
    expect(nudgeParamValue(param(), 0.5, 1)).toBeCloseTo(0.5 + ENCODER_FRAC_STEP, 6);
    expect(nudgeParamValue(param(), 0.5, -1)).toBeCloseTo(0.5 - ENCODER_FRAC_STEP, 6);
  });

  it('SHIFT is a 5× finer step', () => {
    expect(nudgeParamValue(param(), 0.5, 1, true)).toBeCloseTo(0.5 + ENCODER_FRAC_STEP_FINE, 6);
  });

  it('clamps at both end stops (and reports the end stop, not beyond it)', () => {
    expect(nudgeParamValue(param(), 1, 4)).toBe(1);
    expect(nudgeParamValue(param(), 0, -4)).toBe(0);
  });

  it('a zero delta is exactly the current value (so the caller can skip the write)', () => {
    expect(nudgeParamValue(param(), 0.37, 0)).toBe(0.37);
  });

  it('CURVE NEGATIVE CONTROL: a detent at the BOTTOM of a log range stays usable', () => {
    // filter.cutoff is log 20..20000. A LINEAR 1% step would be 200 Hz per
    // detent, so the entire bass range would be unreachable — the first detent
    // off the minimum would land at 220 Hz. In fraction space it lands at ~21 Hz.
    const log = param({ min: 20, max: 20000, curve: 'log' });
    const stepped = nudgeParamValue(log, 20, 1);
    expect(stepped).toBeGreaterThan(20);
    expect(stepped, 'a log detent near the minimum is a few Hz, not 200').toBeLessThan(25);
    // And the SAME detent high up moves by hundreds of Hz — proving the step
    // tracks the curve rather than being a constant.
    expect(nudgeParamValue(log, 10000, 1) - 10000).toBeGreaterThan(50);
  });

  it('an out-of-range or NaN current value recovers from the default', () => {
    const p = param({ defaultValue: 0.5 });
    expect(nudgeParamValue(p, Number.NaN, 1)).toBeCloseTo(0.51, 6);
  });
});

describe('discrete params move ONE INTEGER per detent', () => {
  it("dx7's algorithm (1..32) advances by exactly 1", () => {
    // THE case this mode exists for: 0.01 of the arc is 0.31 of an algorithm,
    // which Math.round sends straight back to where it started — the encoder
    // would appear DEAD. Four detents must be four algorithms.
    const p = param({ curve: 'discrete', min: 1, max: 32, defaultValue: 1 });
    expect(nudgeParamValue(p, 5, 1)).toBe(6);
    expect(nudgeParamValue(p, 5, 4)).toBe(9);
    expect(nudgeParamValue(p, 5, -1)).toBe(4);
  });

  it('proves it is NOT fraction stepping (which would return the same value)', () => {
    const p = param({ curve: 'discrete', min: 1, max: 32, defaultValue: 1 });
    // The wrong answer, computed here with the REAL frac helpers rather than
    // asserted from memory — so this stays honest if those helpers ever change.
    const asFraction = knobFracToValue(
      knobValueToFrac(5, p.min, p.max, p.curve) + ENCODER_FRAC_STEP,
      p.min,
      p.max,
      p.curve,
    );
    expect(asFraction, 'a fraction step rounds straight back — the encoder looks DEAD').toBe(5);
    expect(nudgeParamValue(p, 5, 1)).not.toBe(asFraction);
    expect(nudgeParamValue(p, 5, 1)).toBe(6);
  });

  it("voiceCount (1..5) advances one voice, not a twenty-fifth of one", () => {
    const p = param({ curve: 'discrete', min: 1, max: 5, defaultValue: 4 });
    expect(nudgeParamValue(p, 4, 1)).toBe(5);
    expect(nudgeParamValue(p, 5, 1)).toBe(5); // end stop
  });

  it('a bipolar discrete param (tidyVco oct2, −1..1) steps through its 3 states', () => {
    const p = param({ curve: 'discrete', min: -1, max: 1, defaultValue: 0 });
    expect(nudgeParamValue(p, -1, 1)).toBe(0);
    expect(nudgeParamValue(p, 0, 1)).toBe(1);
    expect(nudgeParamValue(p, 1, 1)).toBe(1);
    expect(nudgeParamValue(p, 0, -1)).toBe(-1);
  });
});

describe('a declared option roster moves by INDEX', () => {
  const sparse = param({
    curve: 'discrete',
    min: 0,
    max: 9,
    options: [
      { value: 0, label: 'a' },
      { value: 4, label: 'b' },
      { value: 9, label: 'c' },
    ],
  });

  it('one detent = the NEXT state, however far apart the values are', () => {
    // The point of the mode: value-space stepping would stall for three detents
    // between 'a' and 'b' and then jump five.
    expect(nudgeParamValue(sparse, 0, 1)).toBe(4);
    expect(nudgeParamValue(sparse, 4, 1)).toBe(9);
    expect(nudgeParamValue(sparse, 9, 1)).toBe(9); // end stop, no wrap
    expect(nudgeParamValue(sparse, 4, -1)).toBe(0);
  });

  it('starts from the NEAREST state when the stored value is between two', () => {
    expect(nudgeParamValue(sparse, 3, 1)).toBe(9); // 3 is nearest 4 → next is 9
    expect(nudgeParamValue(sparse, 1, 1)).toBe(4); // 1 is nearest 0 → next is 4
  });

  it('a multi-detent flick crosses several states at once', () => {
    expect(nudgeParamValue(sparse, 0, 2)).toBe(9);
    expect(nudgeParamValue(sparse, 0, 4)).toBe(9); // clamped at the roster end
  });

  it('the roster wins over the curve — a LINEAR param with options still indexes', () => {
    const p = param({
      curve: 'linear',
      min: 0,
      max: 1,
      options: [
        { value: 0, label: 'off' },
        { value: 1, label: 'on' },
      ],
    });
    expect(nudgeParamValue(p, 0, 1)).toBe(1); // one detent flips it, not 0.01
  });
});
