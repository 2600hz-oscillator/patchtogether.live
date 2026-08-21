// packages/web/src/lib/ui/workflow/band-focus-model.test.ts
//
// The pure half of BAND FOCUS: which bands a param value reveals, and whether a
// declaration covers everything the param can hold.
//
// ⚠ THE TOTALITY CHECK IS THE LOAD-BEARING ONE. `visibleBandIds` fails OPEN — an
// unclaimed value shows every band — which is the right runtime behaviour (it
// cannot lose a control) and exactly why a gap is invisible on screen. So the
// declaration is only trustworthy while something asserts it is total, and that
// something is here.

import { describe, expect, it } from 'vitest';
import {
  bandFocusIsInert,
  bandFocusIsTotal,
  visibleBandIds,
  type FaceBandFocus,
} from './band-focus-model';

/** The colourofmagic shape, which is the case this model was built for. */
const FOCUS: FaceBandFocus = {
  param: 'preview',
  why: 'five colorspace blocks run in parallel; showing all thirty-five knobs while you look at one block is noise',
  showAllOn: [0],
  bands: {
    rgb: [1, 4, 5, 6, 7],
    ydbdr: [2, 8, 9, 10],
    hsv: [3, 11, 12, 13],
    yiq: [14, 15, 16, 17],
    ycc: [18, 19, 20, 21],
  },
};
const LEGAL = Array.from({ length: 22 }, (_, i) => i);
const PAGES = ['output', 'rgb', 'ydbdr', 'hsv', 'yiq', 'ycc'];

describe('visibleBandIds — a value focuses exactly one band', () => {
  it('the SHOW-ALL value returns null, not a set of everything', () => {
    // `null` and "a set containing every band" are different statements and the
    // caller renders them differently; an empty set would be a blank plate.
    expect(visibleBandIds(FOCUS, 0)).toBeNull();
  });

  it('a family value focuses that family', () => {
    expect([...visibleBandIds(FOCUS, 1)!]).toEqual(['rgb']);
    expect([...visibleBandIds(FOCUS, 2)!]).toEqual(['ydbdr']);
    expect([...visibleBandIds(FOCUS, 3)!]).toEqual(['hsv']);
    expect([...visibleBandIds(FOCUS, 14)!]).toEqual(['yiq']);
    expect([...visibleBandIds(FOCUS, 18)!]).toEqual(['ycc']);
  });

  it('a CHANNEL value focuses its family — including the two that needed deciding', () => {
    // ⚠ LUMA (7) and the YCC channels were the two the mapping had to resolve
    // rather than assume. LUMA is the RGB block's luminance tap — the same
    // grouping the rear card's output sections already use — and the YCC
    // channels belong to the `ycc` block, which is a declared band.
    expect([...visibleBandIds(FOCUS, 7)!], 'LUMA is an RGB-block tap').toEqual(['rgb']);
    expect([...visibleBandIds(FOCUS, 4)!]).toEqual(['rgb']);
    expect([...visibleBandIds(FOCUS, 10)!]).toEqual(['ydbdr']);
    expect([...visibleBandIds(FOCUS, 19)!]).toEqual(['ycc']);
    expect([...visibleBandIds(FOCUS, 21)!]).toEqual(['ycc']);
  });

  it('rounds a non-integer and survives undefined / NaN by showing everything', () => {
    // CV, automation and a legacy save can all hand over something odd. Failing
    // OPEN keeps every control reachable; failing closed would hide the plate.
    expect([...visibleBandIds(FOCUS, 7.4)!]).toEqual(['rgb']);
    expect(visibleBandIds(FOCUS, undefined)).toBeNull();
    expect(visibleBandIds(FOCUS, NaN)).toBeNull();
    expect(visibleBandIds(FOCUS, 999)).toBeNull();
  });

  it('NO declaration means today’s behaviour — every band', () => {
    // The degradation path: a face that declares nothing must be unaffected.
    expect(visibleBandIds(undefined, 3)).toBeNull();
  });
});

describe('bandFocusIsTotal — the check that makes a hand-written map safe', () => {
  it('the colourofmagic declaration is TOTAL', () => {
    const p = bandFocusIsTotal(FOCUS, LEGAL, PAGES);
    expect(p.unclaimed, 'every preview value must have a home').toEqual([]);
    expect(p.duplicated, 'a value claimed twice is two answers to one question').toEqual([]);
    expect(p.unknownBands, 'a band id that is not a page renders nothing').toEqual([]);
    expect(p.outOfRange).toEqual([]);
    // NON-VACUITY: the sweep must actually have walked 22 values, or "no
    // problems" would mean "nothing was checked".
    expect(LEGAL.length).toBe(22);
    expect(Object.values(FOCUS.bands).flat().length + FOCUS.showAllOn.length).toBe(22);
  });

  it('NEGATIVE CONTROL — an UNCLAIMED value is caught', () => {
    // The failure that matters, because `visibleBandIds` fails open: the value
    // would silently show every band and look fine.
    const gap: FaceBandFocus = { ...FOCUS, bands: { ...FOCUS.bands, ycc: [18, 19, 20] } };
    expect(bandFocusIsTotal(gap, LEGAL, PAGES).unclaimed).toEqual([21]);
  });

  it('NEGATIVE CONTROL — a DUPLICATED value is caught', () => {
    const dupe: FaceBandFocus = { ...FOCUS, bands: { ...FOCUS.bands, hsv: [3, 11, 12, 13, 7] } };
    expect(bandFocusIsTotal(dupe, LEGAL, PAGES).duplicated).toEqual([7]);
  });

  it('NEGATIVE CONTROL — a band id that is not a declared page is caught', () => {
    const typo: FaceBandFocus = {
      ...FOCUS,
      bands: { ...FOCUS.bands, rbg: FOCUS.bands.rgb!, rgb: [] },
    };
    expect(bandFocusIsTotal(typo, LEGAL, PAGES).unknownBands).toEqual(['rbg']);
  });

  it('NEGATIVE CONTROL — a value outside the param’s roster is caught', () => {
    const wide: FaceBandFocus = { ...FOCUS, showAllOn: [0, 99] };
    expect(bandFocusIsTotal(wide, LEGAL, PAGES).outOfRange).toEqual([99]);
  });

  it('an INERT declaration (no bands) is recognisable', () => {
    // Declaring the feature and hiding nothing is a face that ignores its own
    // declaration — refused loudly rather than rendered.
    expect(bandFocusIsInert({ ...FOCUS, bands: {} })).toBe(true);
    expect(bandFocusIsInert(FOCUS)).toBe(false);
  });
});
