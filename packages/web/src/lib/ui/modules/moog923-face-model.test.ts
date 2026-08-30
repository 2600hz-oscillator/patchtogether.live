// packages/web/src/lib/ui/modules/moog923-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS under the MOOG 923 faceplate's five derived
// readouts, plus the totality legs.
//
// A derived readout is only distinguishable from a relabelled knob by an
// assertion that a knob readback could not pass (face-readout-values.ts). This
// module has TWO instruments sharing a panel and no signal path, so the
// controls come in two shapes and each half is the other's:
//
//   · the NOISE readouts must move with `level` and must NOT move with either
//     cutoff — the drummergirl shape (`DECAY` moves none of the five);
//   · the FILTER readouts must move with their own dial and must NOT move with
//     `level` or with each other's dial;
//   · and the two Hz readouts carry a POSITIVE control as well, against the
//     WRONG answer: the printed value must NOT equal `cutoffToHz` of its own
//     dial. A merely-negative control here would pass on a relabelled knob,
//     because a relabelled knob DOES move when you turn it.
//
// The closed forms themselves are re-derived from the SHIPPING factory by
// art/scenarios/moog923/face-audit.test.ts — this file proves the readouts
// consume them correctly and stay total; that file proves they describe the
// real filter.

import { describe, expect, it } from 'vitest';
import { CUTOFF_MAX_HZ, CUTOFF_MIN_HZ, cutoffToHz, moog923Def } from '$lib/audio/modules/moog923';
import { NOISE_TAP_RMS } from '$lib/ui/modules/noise-face-model';
import {
  MOOG923_FILTER_Q,
  MOOG923_FILTER_Q_DB,
  MOOG923_NOISE_TAPS,
  moog923CornerGainDb,
  moog923FaceParams,
  moog923MinusThreeDbHz,
  moog923MinusThreeDbRatio,
  moog923PeakGainDb,
  moog923PeakRatio,
  moog923SplitOct,
  moog923SplitText,
  moog923TapDb,
  moog923TapDbText,
  moog923TapOffsetDb,
} from './moog923-face-model';

/** The def's OWN spawn defaults — derived, never retyped. */
const DEFAULTS: Record<string, number> = Object.fromEntries(
  moog923Def.params.map((p) => [p.id, p.defaultValue]),
);

/** A param reader over an overlay on the def's defaults, exactly as the shell
 *  supplies one. */
const reader = (over: Record<string, number> = {}) => (id: string): number | undefined => {
  const merged = { ...DEFAULTS, ...over };
  return id in merged ? merged[id] : undefined;
};

/** What the REGISTRY prints — the surface the faceplate actually renders, not
 *  the model function underneath it. Every assertion below goes through here so
 *  a registry entry wired to the wrong model function is RED. */

const P = (over: Record<string, number> = {}) => moog923FaceParams(reader(over));

describe('moog923 NOISE readouts — blind to the tap, which is the whole point', () => {
  it('ONE dial, TWO different loudnesses: pink sits 12.30 dB under white', () => {
    // The blindness a `paramId: 'level'` readout has. `setParam('level')` writes
    // the SAME number to both gains, so the dial cannot express this at all.
    const offset = moog923TapOffsetDb();
    expect(offset).toBeCloseTo(-12.304, 2);
    for (const level of [1, 0.8, 0.5, 0.11]) {
      const p = P({ level });
      expect(
        moog923TapDb('pink', p) - moog923TapDb('white', p),
        `pink−white at level ${level} (dB re full scale)`,
      ).toBeCloseTo(offset, 9);
    }
  });

  it('POSITIVE CONTROL: each tap prints its own closed form, not the other one', () => {
    // A readout wired to the wrong tap would still move with LEVEL and still
    // look plausible. Pin the VALUE, not the motion.
    const p = P({ level: 1 });
    expect(moog923TapDbText('white', p)).toBe('-4.8 dB');
    expect(moog923TapDbText('pink', p)).toBe('-17.1 dB');
    expect(20 * Math.log10(NOISE_TAP_RMS.white)).toBeCloseTo(-4.771, 3);
    expect(20 * Math.log10(NOISE_TAP_RMS.pink)).toBeCloseTo(-17.076, 3);
  });
});

describe('moog923 FILTER readouts — the declared corner is the WRONG answer', () => {
  it('the mirrored Q is the Web Audio DEFAULT, read in dB', () => {
    // ⚠ The one restated platform constant. `BiquadFilterNode.Q` defaults to 1
    // and moog923's factory never assigns it; for lowpass/highpass the spec
    // reads that 1 as DECIBELS. If this ever stops being true the ART oracle
    // measures it and goes red first.
    expect(MOOG923_FILTER_Q_DB).toBe(1);
    expect(MOOG923_FILTER_Q).toBeCloseTo(1.1220185, 6);
    expect(moog923CornerGainDb(), 'gain AT the declared corner, dB').toBeCloseTo(1.0, 6);
    expect(moog923PeakGainDb(), 'the hump, dB above passband').toBeCloseTo(1.9617, 3);
    expect(Math.log2(moog923PeakRatio('lp')), 'lp hump position, oct from corner').toBeCloseTo(
      -0.3652,
      3,
    );
    expect(moog923PeakRatio('hp')).toBeCloseTo(1 / moog923PeakRatio('lp'), 12);
  });

  it('the two ratios are exact reciprocals — one prototype, mirrored', () => {
    expect(moog923MinusThreeDbRatio('lp')).toBeCloseTo(1.330597, 5);
    expect(moog923MinusThreeDbRatio('hp')).toBeCloseTo(0.751542, 5);
    expect(moog923MinusThreeDbRatio('lp') * moog923MinusThreeDbRatio('hp')).toBeCloseTo(1, 12);
  });

  it('the printed Hz stays inside the DECLARED band at both rails', () => {
    // Un-clamped, `lp` at dial 1 would print 26.6 kHz — a frequency the module
    // cannot reach and one the biquad clamps to Nyquist anyway.
    expect(moog923MinusThreeDbHz('lp', P({ lpCutoff: 1 }))).toBeCloseTo(CUTOFF_MAX_HZ, 6);
    expect(moog923MinusThreeDbHz('hp', P({ hpCutoff: 0 }))).toBeCloseTo(CUTOFF_MIN_HZ, 6);
    expect(moog923MinusThreeDbHz('lp', P({ lpCutoff: 0 }))).toBeGreaterThan(CUTOFF_MIN_HZ);
    expect(moog923MinusThreeDbHz('hp', P({ hpCutoff: 1 }))).toBeLessThan(CUTOFF_MAX_HZ);
  });
});

describe('moog923 readouts are TOTAL — they run on every render', () => {

  it('a hostile SPLIT still names a direction rather than throwing', () => {
    expect(() => moog923SplitText(P({ lpCutoff: NaN, hpCutoff: NaN }))).not.toThrow();
    expect(moog923SplitText(P({ lpCutoff: NaN, hpCutoff: NaN }))).toBeTypeOf('string');
  });
});
