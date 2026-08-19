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
  it('prints the shipped default', () => {
    expect(printed('filter-peak-db', {})).toBe('+8.8 dB');
  });

  // ── MOVES: the input a `resonance` readback is blind to ───────────────────
  it('MODE moves the peak by 5.2 dB at resonance 0, while resonance reads 0.00', () => {
    const at = (mode: number) => printed('filter-peak-db', { resonance: 0, mode });
    expect(at(FILTER_MODE_LP), 'LP at Q 0.7 has no peak at all — Q < 1/√2').toBe('0.0 dB');
    expect(at(FILTER_MODE_HP)).toBe('+2.1 dB');
    expect(at(FILTER_MODE_BP), 'BP is 3.1 dB DOWN at its own centre when Q < 1').toBe('-3.1 dB');
    // The knob a reviewer would check reads the same in all three.
    expect(new Set([0, 1, 2].map((mode) => withParams({ resonance: 0, mode }).resonance))).toEqual(
      new Set([0]),
    );
  });

  it('⚠ THE PERTURBATION POINT IS LOAD-BEARING: the three modes CONVERGE above ≈ Q 5', () => {
    // Run the control at max resonance and it passes on a `resonance`-only
    // model, because all three modes genuinely agree there. That convergence is
    // the fact the readout teaches, and it is why the leg above pins
    // resonance = 0 rather than "some resonance".
    const at = (mode: number) => printed('filter-peak-db', { resonance: 0.99, mode });
    expect(at(FILTER_MODE_LP)).toBe('+26.2 dB');
    expect(at(FILTER_MODE_HP)).toBe('+26.2 dB');
    expect(at(FILTER_MODE_BP)).toBe('+26.2 dB');
    // THE COLLAPSE, MEASURED rather than asserted qualitatively — this is the
    // curve that decides where the negative control above is allowed to stand.
    const spreadAt = (resonance: number) =>
      Math.max(...[0, 1, 2].map((m) => filterPeakDb(m, resonance))) -
      Math.min(...[0, 1, 2].map((m) => filterPeakDb(m, resonance)));
    expect(spreadAt(0), 'Q 0.70 — 5.16 dB apart, the widest the modes ever are').toBeCloseTo(5.158, 2);
    expect(spreadAt(0.215), 'Q 5.00 — already a 24× collapse').toBeCloseTo(0.211, 2);
    expect(spreadAt(0.4), 'Q 8.70 — inside ONE printed digit (0.1 dB)').toBeLessThan(0.1);
    expect(spreadAt(0.99), 'Q 20.50 — indistinguishable').toBeLessThan(0.02);
    // Monotone, so "above ≈ Q 5" is a real threshold and not one lucky sample.
    const ladder = [0, 0.1, 0.215, 0.4, 0.7, 0.99].map(spreadAt);
    for (let i = 1; i < ladder.length; i++) expect(ladder[i]!).toBeLessThan(ladder[i - 1]!);
  });

  // ── STILL: frequency-scale invariance ─────────────────────────────────────
  it('CUTOFF and CV DEPTH do not change the peak by one digit (scale invariance)', () => {
    const base = printed('filter-peak-db', {});
    expect(printed('filter-peak-db', { cutoff: 8000 })).toBe(base);
    expect(printed('filter-peak-db', { cutoff: 20 })).toBe(base);
    expect(printed('filter-peak-db', { cutoff_cv_amt: 0.2 })).toBe(base);
    expect(printed('filter-peak-db', { res_cv_amt: 0 })).toBe(base);
  });

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

describe('filter-cutoff-reach — the ±5-octave window, CLAMPED', () => {
  it('prints the shipped default: five octaves down, only 4.32 up', () => {
    expect(printed('filter-cutoff-reach', {})).toBe('31 Hz – 20.0 kHz');
    const r = filterCutoffReach(DEFAULTS);
    expect(r.lo).toBeCloseTo(31.25, 6);
    expect(r.hi, 'the +5-octave 32 kHz endpoint is eaten by the 20 kHz clamp').toBe(20000);
    expect(Math.log2(20000 / 1000), 'up').toBeCloseTo(4.322, 3);
  });

  // ── MOVES leg 1: the input a `cutoff` readback is blind to ────────────────
  it('CV DEPTH moves the window while CUTOFF still reads 1000 Hz', () => {
    expect(printed('filter-cutoff-reach', { cutoff_cv_amt: 0.2 })).toBe('500 Hz – 2.0 kHz');
    expect(printed('filter-cutoff-reach', { cutoff_cv_amt: -0.2 }), 'sign inverts the DIRECTION, not the endpoints').toBe(
      '500 Hz – 2.0 kHz',
    );
    expect(withParams({ cutoff_cv_amt: 0.2 }).cutoff, 'the nearest knob is unmoved').toBe(1000);
  });

  // ── MOVES leg 2: the CLAMP, which a naive cutoff×2^±5 model has no idea about
  it('THE CLAMP: moving CUTOFF collapses the reachable SPAN from 9.32 to 6.32 octaves', () => {
    expect(printed('filter-cutoff-reach', {})).toBe('31 Hz – 20.0 kHz');
    expect(printed('filter-cutoff-reach', { cutoff: 8000 })).toBe('250 Hz – 20.0 kHz');
    expect(filterCutoffReach(DEFAULTS).octaves).toBeCloseTo(9.322, 3);
    expect(filterCutoffReach(withParams({ cutoff: 8000 })).octaves).toBeCloseTo(6.322, 3);
    // An UNCLAMPED model is invariant here: 2^10 = 1024 at both cutoffs. This
    // is the assertion that separates "models the DSP" from "multiplies a knob".
    expect(
      withParams({ cutoff: 8000 }).cutoff_cv_amt,
      'and the depth knob reads 1.00 throughout',
    ).toBe(1);
  });

  it('at depth 0 the window degenerates to the knob and SAYS SO', () => {
    // The strongest single sentence on this faceplate: `cutoff_cv_amt` is an
    // engine-graph gain on the jack itself, so with nothing patched the knob is
    // structurally inert. `muted` is what makes that visible.
    expect(printed('filter-cutoff-reach', { cutoff_cv_amt: 0 })).toBe('1.0 kHz · muted');
    expect(printed('filter-cutoff-reach', { cutoff: 120, cutoff_cv_amt: 0 })).toBe('120 Hz · muted');
    expect(filterCutoffReach(withParams({ cutoff_cv_amt: 0 })).muted).toBe(true);
  });

  // ── STILL ─────────────────────────────────────────────────────────────────
  it('RESONANCE and MODE do not touch the window', () => {
    const base = printed('filter-cutoff-reach', {});
    expect(printed('filter-cutoff-reach', { resonance: 0.99 })).toBe(base);
    expect(printed('filter-cutoff-reach', { mode: FILTER_MODE_BP })).toBe(base);
    expect(printed('filter-cutoff-reach', { res_cv_amt: 0 })).toBe(base);
  });
});

describe('filter-res-reach — the additive resonance window, CLAMPED at 0.99', () => {
  // ── MOVES: the clamp eats the UPWARD travel while the depth knob is still 0.20
  it('RESONANCE moves the window and the clamp silently halves the upward travel', () => {
    expect(printed('filter-res-reach', { resonance: 0.1, res_cv_amt: 0.2 })).toBe('0.00 – 0.30');
    expect(printed('filter-res-reach', { resonance: 0.9, res_cv_amt: 0.2 })).toBe('0.70 – 0.99');
    const up = (resonance: number) => {
      const r = filterResReach(withParams({ resonance, res_cv_amt: 0.2 }));
      return r.hi - resonance;
    };
    expect(up(0.1), 'the full 0.20 is available').toBeCloseTo(0.2, 6);
    expect(up(0.9), 'the ceiling has eaten more than half of it').toBeCloseTo(0.09, 6);
    expect(withParams({ resonance: 0.9, res_cv_amt: 0.2 }).res_cv_amt, 'depth reads 0.20 in both').toBe(0.2);
  });

  it('⚠ THE CONTROL MUST NOT RUN AT THE SHIPPED DEPTH DEFAULT of 1.0', () => {
    // At depth 1 both ends saturate, so the string is genuinely CONSTANT for
    // every resonance — a negative control run at the default would fail a
    // CORRECT model. Pinned here so the reason survives the next reader.
    for (const resonance of [0, 0.1, 0.5, 0.99]) {
      expect(printed('filter-res-reach', { resonance })).toBe('0.00 – 0.99');
    }
  });

  it('at depth 0 the window degenerates to the knob and SAYS SO', () => {
    expect(printed('filter-res-reach', { res_cv_amt: 0 })).toBe('0.10 · muted');
    expect(printed('filter-res-reach', { resonance: 0.45, res_cv_amt: 0 })).toBe('0.45 · muted');
  });

  // ── STILL ─────────────────────────────────────────────────────────────────
  it('CUTOFF and MODE do not touch the resonance window', () => {
    const base = printed('filter-res-reach', { res_cv_amt: 0.2 });
    expect(printed('filter-res-reach', { res_cv_amt: 0.2, cutoff: 20 })).toBe(base);
    expect(printed('filter-res-reach', { res_cv_amt: 0.2, mode: FILTER_MODE_HP })).toBe(base);
    expect(printed('filter-res-reach', { res_cv_amt: 0.2, cutoff_cv_amt: 0 })).toBe(base);
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
  it('the curve never exceeds the printed peak, and reaches it at high Q', () => {
    for (const mode of [FILTER_MODE_LP, FILTER_MODE_HP, FILTER_MODE_BP]) {
      for (const resonance of [0, 0.1, 0.6, 0.99]) {
        const p = withParams({ mode, resonance, cutoff: 1000 });
        const peak = filterPeakDb(mode, resonance);
        // ⚠ SAMPLED, so the curve can only APPROACH the maximiser's answer —
        // at Q 20.5 the peak is 4.9 % wide and a 512-point log sweep over ten
        // octaves steps 1.35 %, which is enough to miss the apex by ~0.05 dB.
        // 4096 points step 0.17 % and land inside 0.05 dB. That gap is the
        // sampling resolution, not a disagreement between the two surfaces.
        const curveMax = Math.max(...filterResponseCurve(p, 4096).map((q) => q.db));
        expect(curveMax, `${mode}/${resonance}: the drawing cannot beat the number`).toBeLessThanOrEqual(
          peak + 1e-9,
        );
        if (resonance >= 0.6) {
          expect(curveMax, `${mode}/${resonance}: …and it gets there`).toBeGreaterThan(peak - 0.05);
        }
      }
    }
  });

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

describe('the three ids are the ones the FACE declares', () => {

  it('the helpers and the registry print the SAME string (no second formatter)', () => {
    const over = { cutoff: 400, resonance: 0.85, mode: FILTER_MODE_BP, cutoff_cv_amt: 0.4, res_cv_amt: 0.3 };
    const p = withParams(over);
    expect(printed('filter-peak-db', over)).toBe(filterPeakDbText(p));
    expect(printed('filter-cutoff-reach', over)).toBe(filterCutoffReachText(p));
    expect(printed('filter-res-reach', over)).toBe(filterResReachText(p));
  });
});
