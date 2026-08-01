// packages/web/src/lib/audio/vca-gain-model.test.ts
//
// The VCA gain law, its two knob readouts, and the face that consumes them —
// the model and its ONLY consumer are pinned together on purpose: a formatter
// nothing imports proves nothing, and a rank nothing pins is one careless
// "tidy-up" away from silently reverting.
//
// Three things are under test and they are deliberately different KINDS of
// assertion:
//
//   (a) the ranges the def and the card BOTH import are the ones the contract
//       declares — the cross-check that makes the single-source-of-truth claim
//       checkable rather than aspirational;
//   (b) `vcaCvSense` agrees with what raising `cv` actually does to `vcaGain`
//       — the readout is pinned to the LAW, not to its own lookup table;
//   (c) the exact strings the face paints, including the boundary cases a
//       nearest-waypoint lookup would get wrong.
//
// (b) is the one that matters. A readout tested only against a table of
// expected strings passes just as happily when the table and the code are
// wrong in the same direction.

import { describe, expect, it } from 'vitest';
import { curatedFace } from '$lib/ui/workflow/curated-face';
import { laneBodyPlan } from '$lib/ui/workflow/module-shell-model';
import { vcaDef } from './modules/vca';
import {
  VCA_BASE,
  VCA_CV_AMOUNT,
  VCA_CV_AMOUNT_LANDMARKS,
  VCA_DISPLAY_EPS,
  formatVcaBase,
  formatVcaCvAmount,
  linearToDb,
  vcaCvSense,
  vcaGain,
} from './vca-gain-model';

const param = (id: string) => vcaDef.params.find((p) => p.id === id)!;

describe('vca gain model — the ranges are ONE truth', () => {
  it('the def declares exactly the model ranges (no re-typed numbers)', () => {
    expect({
      min: param('base').min,
      max: param('base').max,
      default: param('base').defaultValue,
    }).toEqual(VCA_BASE);
    expect({
      min: param('cvAmount').min,
      max: param('cvAmount').max,
      default: param('cvAmount').defaultValue,
    }).toEqual(VCA_CV_AMOUNT);
  });

  it('the ranges match the pinned contract (0..1 default 0 / -1..1 default 1)', () => {
    // Restated as literals ON PURPOSE: this is the ONE place the numbers are
    // allowed to appear twice, because its whole job is to notice a change.
    // contract-lock.txt:
    //   vca param base 0..1 linear default=0
    //   vca param cvAmount -1..1 linear default=1
    expect(VCA_BASE).toEqual({ min: 0, max: 1, default: 0 });
    expect(VCA_CV_AMOUNT).toEqual({ min: -1, max: 1, default: 1 });
  });
});

describe('vca gain law', () => {
  it('is base + cvAmount × cv, unclamped in BOTH directions', () => {
    expect(vcaGain(0, 1, 1)).toBe(1);
    expect(vcaGain(0, 1, 0)).toBe(0);
    expect(vcaGain(0.5, 0.5, 1)).toBe(1);
    // above unity: the DSP boosts, so the model must too
    expect(vcaGain(1, 1, 1)).toBe(2);
    // below zero: the DSP phase-inverts rather than muting
    expect(vcaGain(0, -1, 1)).toBe(-1);
    expect(vcaGain(0.2, -1, 1)).toBeCloseTo(-0.8, 10);
  });

  it('cvAmount 0 makes the cv input inert at every cv level', () => {
    for (const cv of [-1, -0.3, 0, 0.3, 1]) expect(vcaGain(0.4, 0, cv)).toBe(0.4);
  });
});

describe('vcaCvSense — pinned to the LAW, not to a table', () => {
  // The oracle: raise cv from 0 to 1 and ask what happened to the gain.
  const effectOfRaisingCv = (cvAmount: number): 'up' | 'flat' | 'down' => {
    const before = vcaGain(0.5, cvAmount, 0);
    const after = vcaGain(0.5, cvAmount, 1);
    if (after > before) return 'up';
    if (after < before) return 'down';
    return 'flat';
  };

  it('says OPEN exactly when raising cv RAISES the gain', () => {
    for (const v of [0.005, 0.1, 0.4, 0.75, 1]) {
      expect(effectOfRaisingCv(v), `cvAmount=${v}`).toBe('up');
      expect(vcaCvSense(v), `cvAmount=${v}`).toBe('open');
    }
  });

  it('says DUCK exactly when raising cv LOWERS the gain', () => {
    for (const v of [-0.005, -0.1, -0.4, -0.75, -1]) {
      expect(effectOfRaisingCv(v), `cvAmount=${v}`).toBe('down');
      expect(vcaCvSense(v), `cvAmount=${v}`).toBe('duck');
    }
  });

  it('says CV OFF only inside the band that DISPLAYS as zero', () => {
    expect(vcaCvSense(0)).toBe('off');
    expect(vcaCvSense(VCA_DISPLAY_EPS / 2)).toBe('off');
    expect(vcaCvSense(-VCA_DISPLAY_EPS / 2)).toBe('off');
    // …and NOT one step outside it.
    expect(vcaCvSense(VCA_DISPLAY_EPS)).toBe('open');
    expect(vcaCvSense(-VCA_DISPLAY_EPS)).toBe('duck');
  });

  it('THE ATTENUVERTER CASE: −0.4 is DUCK, not the nearest landmark', () => {
    // This is the assertion that rejects `landmarks` as the readout source for
    // this param. `knobReadout` resolves a landmark roster by NEAREST value, so
    // a roster at −1/0/+1 answers `CV OFF` for −0.4 (|−0.4 − 0| = 0.4 beats
    // |−0.4 − −1| = 0.6) — while the module is unambiguously ducking.
    const nearestOfRoster = (v: number) =>
      [
        { value: -1, label: 'DUCK' },
        { value: 0, label: 'CV OFF' },
        { value: 1, label: 'OPEN' },
      ].reduce((a, b) => (Math.abs(b.value - v) < Math.abs(a.value - v) ? b : a)).label;

    expect(nearestOfRoster(-0.4)).toBe('CV OFF'); // what landmarks WOULD say
    expect(formatVcaCvAmount(-0.4)).toBe('DUCK'); // what the face DOES say
    expect(effectOfRaisingCv(-0.4)).toBe('down'); // and what the DSP does
  });
});

describe('linearToDb', () => {
  it('is the 20·log10 voltage law, not the 10·log10 power one', () => {
    expect(linearToDb(1)).toBe(0);
    expect(linearToDb(0.5)).toBeCloseTo(-6.0206, 3);
    expect(linearToDb(0.25)).toBeCloseTo(-12.041, 3);
    expect(linearToDb(2)).toBeCloseTo(6.0206, 3);
  });

  it('is −Infinity at silence and magnitude-only below zero', () => {
    expect(linearToDb(0)).toBe(-Infinity);
    expect(linearToDb(-0.5)).toBe(linearToDb(0.5));
  });
});

describe('the readouts the face actually paints', () => {
  it('base names its two landmarks and prints dB in between', () => {
    expect(formatVcaBase(0)).toBe('CLOSED');
    expect(formatVcaBase(VCA_BASE.default)).toBe('CLOSED'); // the spawn state
    expect(formatVcaBase(1)).toBe('UNITY');
    expect(formatVcaBase(0.5)).toBe('-6.0 dB');
    expect(formatVcaBase(0.25)).toBe('-12.0 dB');
  });

  it('base never prints "-0.0 dB", "-Infinity" or "NaN" anywhere in its range', () => {
    // The two ends are exactly where a bare dB conversion is ugliest, which is
    // why they are named instead — and `toFixed` keeps the sign of a value that
    // rounds to zero, so the band just under UNITY needs its own guard. Sweep
    // the whole range at 1/10000 rather than spot-checking: the `-0.0` band is
    // only ~0.07 % wide (linear 0.99426…0.995) and a coarse sweep steps over it.
    for (let i = 0; i <= 10000; i++) {
      const v = i / 10000;
      const out = formatVcaBase(v);
      expect(out, `base=${v}`).not.toContain('Infinity');
      expect(out, `base=${v}`).not.toContain('NaN');
      expect(out, `base=${v}`).not.toContain('-0.0');
    }
  });

  it('cvAmount prints the SENSE, at every value the dial can reach', () => {
    expect(formatVcaCvAmount(VCA_CV_AMOUNT.default)).toBe('OPEN'); // the spawn state
    expect(formatVcaCvAmount(1)).toBe('OPEN');
    expect(formatVcaCvAmount(0)).toBe('CV OFF');
    expect(formatVcaCvAmount(-1)).toBe('DUCK');
    for (let i = 0; i <= 200; i++) {
      const v = -1 + i / 100;
      expect(['OPEN', 'CV OFF', 'DUCK'], `cvAmount=${v}`).toContain(formatVcaCvAmount(v));
    }
  });

  it('every readout fits the 46px lane knob column (≤8 mono chars)', () => {
    // `--kcol-max` is 46px and `.readout` is 9px mono, so a longer string
    // ellipsizes in-lane — the readout would then say less than the number it
    // replaced. Sweep both params rather than spot-checking.
    const widest = (fmt: (v: number) => string, min: number, max: number) => {
      let w = 0;
      for (let i = 0; i <= 400; i++) w = Math.max(w, fmt(min + ((max - min) * i) / 400).length);
      return w;
    };
    expect(widest(formatVcaBase, VCA_BASE.min, VCA_BASE.max)).toBeLessThanOrEqual(8);
    expect(widest(formatVcaCvAmount, VCA_CV_AMOUNT.min, VCA_CV_AMOUNT.max)).toBeLessThanOrEqual(8);
  });
});

describe('the def wires the model in (a model nothing imports proves nothing)', () => {
  it('both params carry the model formatter', () => {
    expect(param('base').format?.(0)).toBe('CLOSED');
    expect(param('cvAmount').format?.(-0.4)).toBe('DUCK');
  });

  it('cvAmount ticks its null detent, and the tick LIGHTS on that readout', () => {
    // KnobConic lights `.tick.at` when `mark.label === readout`, so the two
    // strings must be the same one — which is why the roster reads its label
    // out of the same table the formatter does.
    expect(param('cvAmount').landmarks).toEqual(VCA_CV_AMOUNT_LANDMARKS);
    const tick = VCA_CV_AMOUNT_LANDMARKS[0];
    expect(formatVcaCvAmount(tick.value)).toBe(tick.label);
  });

  it('base declares NO landmarks (its waypoints are the arc endpoints)', () => {
    expect(param('base').landmarks).toBeUndefined();
  });
});

describe('the curated face — what each tier actually surfaces', () => {
  /** `curatedFace` returns null for an UN-FACED module, so resolving it here
   *  doubles as the "vca is still migrated" assertion every case below rests on. */
  const face = (tier: Parameters<typeof curatedFace>[1]) => {
    const f = curatedFace(vcaDef, tier);
    if (!f) throw new Error(`vca has no curated face at tier '${tier}' — it was un-migrated`);
    return f;
  };

  const tiers = (['mini', 'compact', 'full', 'dock'] as const).map((t) => [
    t,
    face(t).controls.map((c) => c.key),
  ]);

  it('THE RANK: the ONE mini cell is cvAmount, beside the meter', () => {
    // This is the entire consequence of `face.order` on this module — with 2
    // params and a glyph, compact/full/dock all show both — so it is the one
    // thing worth pinning. The argument is in the def: the `meter` glyph
    // already reports output level (most of what `base` sets unpatched), so the
    // tile's single cell goes to the control the meter CANNOT show, the sense
    // and depth of the CV.
    expect(Object.fromEntries(tiers)).toEqual({
      mini: ['cvAmount'],
      compact: ['cvAmount', 'base'],
      full: ['cvAmount', 'base'],
      dock: ['cvAmount', 'base'],
    });
  });

  it('the lane never has to truncate this face (2 cells ≤ every cap)', () => {
    // laneBodyPlan keeps the ROW at `full` for a 2-cell glyph face, so the
    // glyph survives at every tier — the ≥4-cell glyph cliff never applies here.
    for (const tier of ['compact', 'full'] as const) {
      const plan = laneBodyPlan(face(tier).controls.length, true, tier);
      expect(plan, tier).toEqual({ layout: 'row', cellCount: 2, glyph: true, knobSize: 'md' });
    }
  });

  it('ONE page, and its header is the gain law rather than a house word', () => {
    const pages = face('dock').pages ?? [];
    expect(pages.map((p) => [p.id, p.label])).toEqual([['gain', 'gain = base + cv × amount']]);
    // `order` is PRIORITY, `pages` is FUNCTION order — they disagree here on
    // purpose: the band reads left-to-right in the same order as the law above
    // it, while the ranking leads with the attenuverter.
    expect(pages[0].controls.map((c) => c.key)).toEqual(['base', 'cvAmount']);
    expect(vcaDef.face?.order).toEqual(['cvAmount', 'base']);
  });
});
