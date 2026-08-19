// packages/web/src/lib/ui/modules/moog904a-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for moog904a's two derived readouts.
//
// A derived readout earns its place only if it is checked against the input a
// KNOB READBACK WOULD BE BLIND TO — permanently, not once at authoring time
// (CLAUDE.md, "a wrong metric reads exactly like a finding"). Two measured
// facts carry this face:
//
//   1. THE CUTOFF DIAL DECLARES `units: 'Hz'` AND DOES NOT DELIVER THEM. RANGE
//      multiplies it by ×1 / ×4 / ×16 before the ladder sees it, so a dial
//      pinned at 1000 Hz places the filter at 1000 / 4000 / 16000 Hz. A
//      readback of either control alone is blind to the product.
//   2. THE 20 kHz CLAMP LANDS ON THAT PRODUCT, so the top of the dial is
//      BIT-EXACTLY DEAD at the higher ranges — measured on the shipping worklet
//      by bit-comparing SETTLED TAILS, from 5000 Hz up at RANGE 2 (the top
//      20.07 % of the log taper) and from 1250 Hz up at RANGE 3 (40.14 %), with
//      the boundaries landing exactly on 20000 ÷ ×4 and 20000 ÷ ×16, and a
//      negative control 2 % below each correctly differing.
//
// So `moog904a-cutoff-hz` MUST move on RANGE with the dial untouched, and MUST
// STOP moving across the dead span — the second is the leg that makes it a
// report of the DSP rather than a restatement of the knob. `moog904a-state`
// must move on REGENERATION and on nothing else, which makes the two each
// other's control on every render.
//
// ⚠ WHAT THIS FILE DOES NOT NEED TO DO, unlike its moog902 sibling. That model
// had to RE-STATE its gain law (its worklet top-level-exports nothing) and so
// carries a worklet-agreement leg to stop it drifting. This one IMPORTS
// `rangeMultiplier` from the shipping ladder lib — the same function the
// worklet calls — so there is no second copy to drift. The assertions below
// pin the DELIVERED numbers, and `moog904a.test.ts` drives the real processor.

import { describe, expect, it } from 'vitest';
import { moog904aDef } from '$lib/audio/modules/moog904a';
import {
  MOOG904A_CUTOFF_MAX_HZ,
  MOOG904A_CUTOFF_MIN_HZ,
  MOOG904A_SELF_OSC_REGEN,
  moog904aCutoffHz,
  moog904aCutoffText,
  moog904aFaceParams,
  moog904aStateText,
} from './moog904a-face-model';

function reader(params: Record<string, number | undefined>) {
  return (id: string) => params[id];
}

describe('moog904a readouts — TOTALITY (they run on every render)', () => {
  const hostile: Array<[string, Record<string, number | undefined>]> = [
    ['a fresh node (nothing touched)', {}],
    ['undefined everywhere', { cutoff: undefined, range: undefined, regeneration: undefined }],
    ['NaN', { cutoff: NaN, range: NaN, regeneration: NaN }],
    ['+Infinity', { cutoff: Infinity, range: Infinity, regeneration: Infinity }],
    ['-Infinity', { cutoff: -Infinity, range: -Infinity, regeneration: -Infinity }],
    ['out of range low', { cutoff: -5, range: -3, regeneration: -9 }],
    ['out of range high', { cutoff: 1e9, range: 99, regeneration: 99 }],
    ['a fractional RANGE the switch cannot produce', { cutoff: 1000, range: 2.5 }],
  ];

  it('never prints outside the worklet\'s own clamp, for ANY input', () => {
    // The clamp is the DSP's, so the readout must not be able to promise a
    // frequency the filter cannot be placed at.
    for (const cutoff of [-1e9, -1, 0, 19, 20, 1000, 20000, 1e9, NaN, Infinity]) {
      for (const range of [0, 1, 2, 3, 4, NaN]) {
        const hz = moog904aCutoffHz({ cutoff, range, regeneration: 0 });
        expect(hz).toBeGreaterThanOrEqual(MOOG904A_CUTOFF_MIN_HZ);
        expect(hz).toBeLessThanOrEqual(MOOG904A_CUTOFF_MAX_HZ);
        expect(Number.isFinite(hz)).toBe(true);
      }
    }
  });
});
