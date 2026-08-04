// packages/web/src/lib/audio/modules/swolevco.test.ts
//
// Unit tests for SWOLEVCO def shape + the pure helpers (symmetry crossfade,
// V/oct → Hz LUT, tune+fine → Hz). DSP rendering goes through the ART
// harness in art/scenarios/swolevco/.

import { describe, expect, it } from 'vitest';
import {
  symmetryGains,
  buildVoctCurve,
  tuneFineToHz,
} from './swolevco';
import { sampleCvCurve } from '$lib/audio/cv-scale';

/** V/oct volts → the WaveShaperNode's [-1,+1] input domain. The module scales
 *  the incoming CV by 1/VOCT_RANGE before the shaper (see swolevco.ts), so a
 *  test that wants "what does +1 V render as" must apply the same scaling. */
const VOCT_RANGE = 5;
const voltsToShaperInput = (v: number): number => v / VOCT_RANGE;

describe('SWOLEVCO helpers: symmetryGains', () => {
  it('symmetry=0 → saw only', () => {
    const g = symmetryGains(0);
    expect(g.saw).toBe(1);
    expect(g.triangle).toBe(0);
    expect(g.square).toBe(0);
  });

  it('symmetry=0.5 → triangle only', () => {
    const g = symmetryGains(0.5);
    expect(g.saw).toBe(0);
    expect(g.triangle).toBe(1);
    expect(g.square).toBe(0);
  });

  it('symmetry=1 → square only', () => {
    const g = symmetryGains(1);
    expect(g.saw).toBe(0);
    expect(g.triangle).toBe(0);
    expect(g.square).toBe(1);
  });

  it('saw + triangle blend at symmetry=0.25 (50/50)', () => {
    const g = symmetryGains(0.25);
    expect(g.saw).toBeCloseTo(0.5, 6);
    expect(g.triangle).toBeCloseTo(0.5, 6);
    expect(g.square).toBe(0);
  });

  it('triangle + square blend at symmetry=0.75 (50/50)', () => {
    const g = symmetryGains(0.75);
    expect(g.saw).toBe(0);
    expect(g.triangle).toBeCloseTo(0.5, 6);
    expect(g.square).toBeCloseTo(0.5, 6);
  });

  it('clamps inputs outside [0, 1] to nearest endpoint', () => {
    expect(symmetryGains(-0.5)).toEqual({ saw: 1, triangle: 0, square: 0 });
    expect(symmetryGains(1.5)).toEqual({ saw: 0, triangle: 0, square: 1 });
  });

  it('gains always sum to 1 across the sweep (energy preservation)', () => {
    for (let i = 0; i <= 20; i++) {
      const s = i / 20;
      const g = symmetryGains(s);
      expect(g.saw + g.triangle + g.square).toBeCloseTo(1, 6);
    }
  });
});

describe('SWOLEVCO helpers: tuneFineToHz', () => {
  it('tune=0, fine=0 → C4 = 261.626 Hz', () => {
    expect(tuneFineToHz(0, 0)).toBeCloseTo(261.626, 3);
  });

  it('tune=12 → C5 = 523.252 Hz (one octave up)', () => {
    expect(tuneFineToHz(12, 0)).toBeCloseTo(523.252, 3);
  });

  it('tune=-12 → C3 = 130.813 Hz (one octave down)', () => {
    expect(tuneFineToHz(-12, 0)).toBeCloseTo(130.813, 3);
  });

  it('fine=100 cents = 1 semitone shift', () => {
    expect(tuneFineToHz(0, 100)).toBeCloseTo(tuneFineToHz(1, 0), 3);
  });
});

describe('SWOLEVCO helpers: buildVoctCurve', () => {
  // These read the LUT through `sampleCvCurve` — the WaveShaperNode transfer
  // function — rather than by index arithmetic. Indexing by hand is what let
  // the 0 V case be asserted as "less than 0.5 Hz off" for so long: it never
  // measured the value a shaper actually emits at 0 V, which (on the old
  // even-length table) was the MEAN of the two samples straddling the centre.
  it('0 V renders EXACTLY 0 Hz of pitch contribution (an idle V/oct cable)', () => {
    const baseHz = 261.626;
    const curve = buildVoctCurve(baseHz);
    // The whole contract of this curve: baseHz is applied by the oscillator's
    // own .frequency, so the shaper must contribute nothing at 0 V or a merely
    // PATCHED (not moved) V/oct cable detunes the oscillator. On an even-length
    // table this was ~8e-5 Hz at C4 — inaudible, but nonzero, and the docstring
    // claimed it was zero.
    expect(sampleCvCurve(curve, voltsToShaperInput(0))).toBe(0);
    // Structural: an even-length table has no centre sample, so this can only
    // be exact for an odd length. Stated so a "tidy this back to 4096" edit
    // fails here with the reason attached.
    expect(curve.length % 2, 'VOCT_LUT_LEN must be ODD — see its comment').toBe(1);
  });

  it('+1 V renders +baseHz Hz delta (one octave up)', () => {
    const baseHz = 261.626;
    const curve = buildVoctCurve(baseHz);
    // At v=+1V, output = baseHz × (2^1 - 1) = baseHz.
    expect(sampleCvCurve(curve, voltsToShaperInput(1))).toBeCloseTo(baseHz, 0);
  });

  it('-1 V renders -baseHz/2 Hz delta (one octave down)', () => {
    const baseHz = 261.626;
    const curve = buildVoctCurve(baseHz);
    // baseHz × (2^-1 - 1) = baseHz × -0.5.
    expect(sampleCvCurve(curve, voltsToShaperInput(-1))).toBeCloseTo(-baseHz / 2, 0);
  });

  it('the ±5 V ENDS still land on the terminal samples', () => {
    // The off-by-one an odd length could plausibly introduce: moving the centre
    // onto a sample must not move the ends off theirs.
    const baseHz = 261.626;
    const curve = buildVoctCurve(baseHz);
    expect(sampleCvCurve(curve, voltsToShaperInput(-5))).toBe(curve[0]);
    expect(sampleCvCurve(curve, voltsToShaperInput(+5))).toBe(curve[curve.length - 1]);
    // ±5 octaves: 2^5 - 1 = 31× baseHz up, 2^-5 - 1 = -0.96875× down.
    expect(curve[curve.length - 1]!).toBeCloseTo(baseHz * 31, 0);
    expect(curve[0]!).toBeCloseTo(baseHz * (Math.pow(2, -5) - 1), 4);
  });
});
