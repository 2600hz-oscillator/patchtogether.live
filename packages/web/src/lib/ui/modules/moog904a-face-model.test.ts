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
function cutoffText(params: Record<string, number | undefined>): string {
  return faceReadoutValueFor('moog904a-cutoff-hz')!(reader(params));
}
function stateText(params: Record<string, number | undefined>): string {
  return faceReadoutValueFor('moog904a-state')!(reader(params));
}

describe('moog904a face readouts — registration', () => {

  it('each registry entry wires THIS module\'s function, not merely SOME function', () => {
    for (const p of [{}, { cutoff: 400, range: 3 }, { regeneration: 1 }]) {
      expect(cutoffText(p)).toBe(moog904aCutoffText(moog904aFaceParams(reader(p))));
      expect(stateText(p)).toBe(moog904aStateText(moog904aFaceParams(reader(p))));
    }
    expect(cutoffText({})).not.toBe(stateText({}));
  });
});

describe('moog904a-cutoff-hz — the RANGE switch a cutoff readback cannot see', () => {
  it('prints the DELIVERED frequency at the spawn defaults, not the dial', () => {
    // The dial reads 1000 Hz and the filter is at 4000 Hz. That gap is the
    // module's headline fact and it is what this readout exists to close.
    expect(moog904aFaceParams(reader({})).cutoff).toBe(1000);
    expect(cutoffText({})).toBe('4.0 kHz');
  });

  it('MOVES on RANGE alone — dial pinned at 1000, the delivered corner is not', () => {
    expect(cutoffText({ cutoff: 1000, range: 1 })).toBe('1.0 kHz');
    expect(cutoffText({ cutoff: 1000, range: 2 })).toBe('4.0 kHz');
    expect(cutoffText({ cutoff: 1000, range: 3 })).toBe('16.0 kHz');
    // ⚠ the dial is bit-identical across all three.
    const dials = [1, 2, 3].map((range) => moog904aFaceParams(reader({ cutoff: 1000, range })).cutoff);
    expect(new Set(dials).size).toBe(1);
  });

  it('also moves on CUTOFF — so it is not secretly a RANGE label', () => {
    expect(cutoffText({ cutoff: 100, range: 1 })).toBe('100 Hz');
    expect(cutoffText({ cutoff: 250, range: 1 })).toBe('250 Hz');
    expect(cutoffText({ cutoff: 2000, range: 1 })).toBe('2.0 kHz');
  });

  it('PINS at 20.0 kHz across the DEAD span, and the boundary is the clamp point', () => {
    // The measured fact: at RANGE 2 the dial is bit-exactly one filter from
    // 5000 Hz up, and at RANGE 3 from 1250 Hz up. The readout must go FLAT over
    // exactly that span — if it kept climbing it would be reporting the knob
    // instead of the filter.
    for (const [range, boundary] of [[2, 5000], [3, 1250]] as const) {
      expect(moog904aCutoffHz({ cutoff: boundary, range, regeneration: 0 })).toBe(MOOG904A_CUTOFF_MAX_HZ);
      expect(cutoffText({ cutoff: boundary, range })).toBe('20.0 kHz');
      // flat all the way to the top of the dial...
      for (const dial of [boundary, boundary * 1.5, 10000, 20000]) {
        expect(cutoffText({ cutoff: dial, range })).toBe('20.0 kHz');
      }
      // ...and NOT flat just below it — the negative control that stops this
      // from passing for a readout that always says 20 kHz.
      expect(cutoffText({ cutoff: boundary * 0.98, range })).not.toBe('20.0 kHz');
    }
    // RANGE 1 has NO dead span: the whole dial is live, right to the top —
    // measured, 19999 and 20000 render bit-DIFFERENTLY on the real worklet.
    //
    // ⚠ ASSERTED ON THE VALUE, NOT THE TEXT, AND THE DIFFERENCE IS THE POINT.
    // The readout prints one decimal of kHz, so `19999` and `20000` BOTH format
    // as `20.0 kHz` — the formatter's resolution is ~50 Hz up there, far coarser
    // than the DSP's. That is a real limit of the printed string and it is
    // recorded here rather than hidden: the dead-span legs above are still
    // sound because they turn on a 2 % gap (19.6 vs 20.0 kHz), which the
    // formatter resolves comfortably.
    expect(moog904aCutoffHz({ cutoff: 19999, range: 1, regeneration: 0 })).not.toBe(
      moog904aCutoffHz({ cutoff: 20000, range: 1, regeneration: 0 }),
    );
    // ...and RANGE 1 never clamps at all, which is what "no dead span" means.
    expect(moog904aCutoffHz({ cutoff: 20000, range: 1, regeneration: 0 })).toBe(MOOG904A_CUTOFF_MAX_HZ);
    expect(moog904aCutoffHz({ cutoff: 19999, range: 1, regeneration: 0 })).toBeLessThan(MOOG904A_CUTOFF_MAX_HZ);
  });

  it('is INVARIANT to REGENERATION — that is the other readout\'s job', () => {
    const base = cutoffText({ cutoff: 1000, range: 2, regeneration: 0 });
    for (let i = 0; i <= 20; i++) {
      expect(cutoffText({ cutoff: 1000, range: 2, regeneration: i / 20 })).toBe(base);
    }
  });

  it('honours the worklet\'s LOWER clamp too', () => {
    expect(moog904aCutoffHz({ cutoff: 20, range: 1, regeneration: 0 })).toBe(MOOG904A_CUTOFF_MIN_HZ);
    expect(cutoffText({ cutoff: 20, range: 1 })).toBe('20 Hz');
  });
});

describe('moog904a-state — the class change a REGEN readback cannot see', () => {
  it('names the side of the boundary, and the dial reads the same on both', () => {
    // Measured on an unpatched render: 4.9018e-7 just below, 1.6934e-1 just
    // above — five and a half orders of magnitude, at two dial positions that
    // both read "0.66".
    const below = MOOG904A_SELF_OSC_REGEN - 1e-4;
    const above = MOOG904A_SELF_OSC_REGEN + 1e-4;
    expect(stateText({ regeneration: below })).toBe('filter');
    expect(stateText({ regeneration: above })).toBe('osc');
    expect(below.toFixed(2)).toBe(above.toFixed(2)); // the dial cannot tell them apart
  });

  it('ships as `filter` — regeneration defaults to 0', () => {
    expect(moog904aFaceParams(reader({})).regeneration).toBe(0);
    expect(stateText({})).toBe('filter');
  });

  it('is INVARIANT to CUTOFF and RANGE — its reach is regeneration alone', () => {
    for (const range of [1, 2, 3]) {
      for (const cutoff of [20, 250, 1000, 5000, 20000]) {
        expect(stateText({ cutoff, range, regeneration: 0 })).toBe('filter');
        expect(stateText({ cutoff, range, regeneration: 1 })).toBe('osc');
      }
    }
  });
});

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
  for (const [name, params] of hostile) {
    it(`survives ${name} and prints a finite string`, () => {
      for (const s of [cutoffText(params), stateText(params)]) {
        expect(typeof s).toBe('string');
        expect(s.length).toBeGreaterThan(0);
        expect(s).not.toMatch(/NaN|Infinity|undefined/);
      }
    });
  }

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
