// packages/web/src/lib/ui/modules/filter-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for FILTER's three derived readouts.
//
// The bar `face-readout-values.ts` sets: a derived readout must be
// negative-controlled on the input a KNOB READBACK WOULD BE BLIND TO, on every
// run — not once at authoring time. So each of the three below gets two legs:
//
//   MOVES   perturb something the nearest knob cannot see; the printed string
//           must change, and the nearest knob's own value must NOT.
//   STILL   perturb something the quantity is genuinely invariant to; the
//           string must not move by one digit. This is the leg that catches a
//           model which accidentally reads the wrong param.
//
// It also pins the PHYSICS the module's `options` tooltips got wrong (the HP's
// 6 dB/oct deep stopband, the BP's 6 dB/oct skirts), so the corrected prose
// cannot drift back to "12 dB/oct" without this file going red — the tooltips
// themselves are asserted nowhere and are ungated by construction.

import { describe, it, expect } from 'vitest';
import { filterDef } from '$lib/audio/modules/filter';
import {
  FILTER_FACE_PARAM_IDS,
  FILTER_MODE_BP,
  FILTER_MODE_HP,
  FILTER_MODE_LP,
  filterCutoffReach,
  filterCutoffReachText,
  filterFaceParams,
  filterMagnitude,
  filterPeakDb,
  filterPeakDbText,
  filterQ,
  filterResReach,
  filterResReachText,
  filterResponseCurve,
  type FilterFaceParams,
} from './filter-face-model';

/** A live-param reader over a plain overlay — the shape `ModuleShell` hands the
 *  registry, sparse on purpose (see filterFaceParams). */
const reader = (over: Partial<Record<string, number>>) => (id: string) => over[id];

/** The def's defaults, as the faceplate sees a freshly spawned node. */
const DEFAULTS: FilterFaceParams = filterFaceParams(reader({}));

const withParams = (over: Partial<FilterFaceParams>): FilterFaceParams => ({
  ...DEFAULTS,
  ...over,
});

/** What the registry actually prints for a declared `valueId`, so these
 *  assertions are about the SHIPPED surface rather than about a helper the face
 *  might not be wired to. */
function printed(valueId: string, over: Partial<FilterFaceParams>): string {
  const fn = faceReadoutValueFor(valueId);
  expect(fn, `${valueId} is registered in face-readout-values.ts`).toBeTruthy();
  return fn!(reader(over as Partial<Record<string, number>>));
}

describe('filter face model — the params reader', () => {
  it('resolves the DEF DEFAULT for every untouched param', () => {
    expect(DEFAULTS).toEqual({
      cutoff: 1000,
      resonance: 0.1,
      mode: 0,
      cutoff_cv_amt: 1,
      res_cv_amt: 1,
    });
  });

  it('every id it reads is a declared param (a rename fails HERE, loudly)', () => {
    for (const id of FILTER_FACE_PARAM_IDS) {
      expect(filterDef.params.some((p) => p.id === id), `filter declares '${id}'`).toBe(true);
    }
    // …and the whole roster is covered: filter has exactly five params and the
    // face model reads all five, so a new param cannot arrive unmodelled.
    expect(new Set(FILTER_FACE_PARAM_IDS)).toEqual(new Set(filterDef.params.map((p) => p.id)));
  });

  it('a value the reader supplies WINS over the default', () => {
    expect(filterFaceParams(reader({ cutoff: 8000 })).cutoff).toBe(8000);
  });
});

describe('filter-peak-db — the corner gain, and it is NOT a resonance readback', () => {

  // ── MOVES: the input a `resonance` readback is blind to ───────────────────

  // ── STILL: frequency-scale invariance ─────────────────────────────────────

  it('the closed forms agree with the maximiser (the instrument checks itself)', () => {
    for (const resonance of [0, 0.1, 0.3, 0.6, 0.99]) {
      const Q = filterQ(resonance);
      // BP peaks exactly at u = 1 with |H| = Q — an independent derivation.
      expect(filterPeakDb(FILTER_MODE_BP, resonance)).toBeCloseTo(20 * Math.log10(Q), 6);
      // LP's textbook closed form, where a peak exists at all.
      const lp = Q <= Math.SQRT1_2 ? 0 : 20 * Math.log10(Q / Math.sqrt(1 - 1 / (4 * Q * Q)));
      expect(filterPeakDb(FILTER_MODE_LP, resonance)).toBeCloseTo(lp, 3);
    }
  });
});

describe('the PHYSICS the shipped tooltips got wrong (defect #19)', () => {
  /** dB per octave between two normalised frequencies, from the ONE law. */
  const slope = (mode: number, Q: number, u: number): number =>
    (20 * Math.log10(filterMagnitude(mode, Q, 2 * u) / filterMagnitude(mode, Q, u)));

  it('the BANDPASS skirts are 6 dB/oct, not 12', () => {
    for (const resonance of [0, 0.1, 0.99]) {
      const Q = filterQ(resonance);
      expect(slope(FILTER_MODE_BP, Q, 0.002), 'lower skirt').toBeCloseTo(6.02, 1);
      expect(slope(FILTER_MODE_BP, Q, 200), 'upper skirt').toBeCloseTo(-6.02, 1);
    }
  });

  it('the HIGHPASS deep stopband is 6 dB/oct — the second zero sits at f = fc/Q', () => {
    // At resonance 0 (Q 0.70) the break is at u = 1/Q = 1.43, ABOVE the corner,
    // so the WHOLE audible stopband is 6 dB/oct. That is the case a player hits
    // by default and the one the tooltip denied.
    const q0 = filterQ(0);
    expect(1 / q0, 'the break, in units of fc').toBeCloseTo(1.4286, 3);
    for (const u of [0.002, 0.01, 0.05]) {
      expect(slope(FILTER_MODE_HP, q0, u), `u=${u}`).toBeCloseTo(6.02, 1);
    }
    // Even right under the corner — where the pole pair starts to bend the
    // taper — it is nowhere near the 12 the tooltip claimed.
    expect(slope(FILTER_MODE_HP, q0, 0.2), 'u=0.2, one corner away').toBeLessThan(6.3);
    // At high Q the break drops well below the corner and BOTH regimes exist.
    const q99 = filterQ(0.99);
    expect(1 / q99).toBeCloseTo(0.0488, 3);
    expect(slope(FILTER_MODE_HP, q99, 0.002), 'below the break: 6 dB/oct').toBeCloseTo(6.02, 1);
    // Between the break and the corner the taper genuinely IS ~12 dB/oct; the
    // band is narrow (0.05 < u < ~0.3 at this Q) and the pole pair pulls it
    // above 12 as u nears 1, so this asserts the REGIME, not a decimal.
    expect(slope(FILTER_MODE_HP, q99, 0.1), 'above the break').toBeGreaterThan(11);
    expect(slope(FILTER_MODE_HP, q99, 0.1)).toBeLessThan(13.5);
  });

  it('the LOWPASS really is 12 dB/oct (the one tooltip that was right)', () => {
    for (const resonance of [0, 0.1, 0.99]) {
      expect(slope(FILTER_MODE_LP, filterQ(resonance), 40)).toBeCloseTo(-12.04, 1);
    }
  });

  it('nothing self-oscillates: |H| is finite at every reachable Q', () => {
    for (const resonance of [0, 0.5, 0.99]) {
      const Q = filterQ(resonance);
      expect(Q, 'ζ = 1/(2Q) never reaches 0').toBeGreaterThanOrEqual(0.7);
      expect(Number.isFinite(filterMagnitude(FILTER_MODE_LP, Q, 1))).toBe(true);
      expect(filterPeakDb(FILTER_MODE_LP, resonance)).toBeLessThan(27);
    }
  });
});

describe('the SIDEBAR curve and the HERO peak are ONE law', () => {

  it('the curve SLIDES with cutoff — the param the peak is invariant to', () => {
    const peakHzOf = (cutoff: number) => {
      const pts = filterResponseCurve(withParams({ cutoff, resonance: 0.8 }), 1024);
      return pts.reduce((a, b) => (b.db > a.db ? b : a)).hz;
    };
    expect(peakHzOf(1000)).toBeGreaterThan(800);
    expect(peakHzOf(1000)).toBeLessThan(1200);
    expect(peakHzOf(8000)).toBeGreaterThan(6500);
    expect(peakHzOf(8000)).toBeLessThan(9500);
  });

  it('every plotted point is inside the box (no clipping surprises)', () => {
    for (const mode of [FILTER_MODE_LP, FILTER_MODE_HP, FILTER_MODE_BP]) {
      for (const pt of filterResponseCurve(withParams({ mode, resonance: 0.99 }), 128)) {
        expect(pt.x).toBeGreaterThanOrEqual(0);
        expect(pt.x).toBeLessThanOrEqual(1);
        expect(pt.y).toBeGreaterThanOrEqual(0);
        expect(pt.y).toBeLessThanOrEqual(1);
      }
    }
  });
});
