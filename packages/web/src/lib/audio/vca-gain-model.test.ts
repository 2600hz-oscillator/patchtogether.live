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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { curatedFace } from '$lib/ui/workflow/curated-face';
import { type FaceplateDefLike } from '$lib/ui/workflow/dock-faceplate-model';
import { faceReadoutValueFor } from '$lib/ui/workflow/face-readout-values';
import {
  LANE_KCOL_MAX_PX,
  READOUT_MAX_CHARS,
  readoutFitsLane,
  readoutWidthPx,
} from '$lib/ui/workflow/lane-readout-fit';
import { laneBodyPlan, PLATE_ROW_H } from '$lib/ui/workflow/module-shell-model';
import { vcaDef } from './modules/vca';
import {
  VCA_BASE,
  VCA_CV_AMOUNT,
  VCA_CV_AMOUNT_LANDMARKS,
  VCA_DISPLAY_EPS,
  formatVcaBase,
  formatVcaCvAmount,
  formatVcaGainAtFullCv,
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
    // Whole dB from −10 down — a FIT constraint, not a taste call. See the
    // `|dB| ≥ 10` case below and formatVcaBase's header.
    expect(formatVcaBase(0.25)).toBe('-12 dB');
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

  it('every readout FITS the 46 CSS-px lane column — in PIXELS, not glyphs', () => {
    // THE UNIT IS THE WHOLE ASSERTION. The first draft of this test bounded the
    // GLYPH COUNT at 8 and called that "fits the 46px column", never converting
    // between the two: at the measured `READOUT_CHAR_PX` (5.97) eight glyphs is
    // 47.8 px against a 46 px cap, so the test PASSED on `-12.0 dB` — which
    // lays out at 48 px in the real lane and escapes its column (measured; see
    // lane-readout-fit.ts for what the overflow actually does, which is NOT the
    // ellipsis the CSS looks like it promises). A budget stated in one unit and
    // checked in another is not a loose bound, it is a different assertion
    // (CLAUDE.md: "state the units in the assertion message").
    //
    // Sweep at a fine step: the widest string is not at an endpoint (both ends
    // are the short NAMED landmarks) and the dB text changes precision at
    // −10 dB, so a coarse sweep can step straight over the worst case.
    const widest = (fmt: (v: number) => string, min: number, max: number) => {
      let worst = '';
      for (let i = 0; i <= 20000; i++) {
        const s = fmt(min + ((max - min) * i) / 20000);
        if (s.length > worst.length) worst = s;
      }
      return worst;
    };

    for (const [id, fmt, range] of [
      ['base', formatVcaBase, VCA_BASE],
      ['cvAmount', formatVcaCvAmount, VCA_CV_AMOUNT],
    ] as const) {
      const worst = widest(fmt, range.min, range.max);
      expect(
        readoutWidthPx(worst),
        `${id}: widest readout ${JSON.stringify(worst)} is ${worst.length} glyphs = ` +
          `${readoutWidthPx(worst).toFixed(2)} CSS px, and the lane knob column caps at ` +
          `${LANE_KCOL_MAX_PX} CSS px (--kcol-max). This string ESCAPES that column in the ` +
          `lane (it does not ellipsize — see lane-readout-fit.ts) — shorten the format.`,
      ).toBeLessThanOrEqual(LANE_KCOL_MAX_PX);
      expect(readoutFitsLane(worst), `${id}: ${JSON.stringify(worst)}`).toBe(true);
    }
  });

  it('NEGATIVE CONTROL: the px budget rejects the string it used to pass', () => {
    // Without this, a fit check is indistinguishable from `expect(true)`. The
    // exact string the 8-glyph budget waved through must now be REFUSED, and
    // the 7-glyph one it would also have waved through must still pass — so the
    // gate is proven to bite at the right place rather than merely to bite.
    expect(readoutFitsLane('-12.0 dB'), '8 glyphs = 47.76 px > 46 px').toBe(false);
    expect(readoutFitsLane('-9.9 dB'), '7 glyphs = 41.79 px ≤ 46 px').toBe(true);
    expect(READOUT_MAX_CHARS, 'the column holds 7 glyphs, not 8').toBe(7);
  });

  it('THE BAND THAT OVERFLOWED: |dB| ≥ 10 prints whole dB and stays 7 glyphs', () => {
    // ~31 % of this linear knob (base ∈ [0.005, 0.3162]) lands at |dB| ≥ 10,
    // and every value in it used to be an 8-glyph `-NN.N dB`. Spot the two the
    // review named plus the two rounding boundaries: −9.96 dB is `< 10` raw but
    // rounds to `-10.0` at one decimal, which is the 8th glyph coming back.
    expect(formatVcaBase(0.25)).toBe('-12 dB');
    expect(formatVcaBase(VCA_DISPLAY_EPS)).toBe('-46 dB');
    expect(formatVcaBase(0.5)).toBe('-6.0 dB'); // fine precision survives near unity
    expect(formatVcaBase(10 ** (-9.94 / 20))).toBe('-9.9 dB'); // just inside the fine band
    expect(formatVcaBase(10 ** (-9.96 / 20))).toBe('-10 dB'); // rounds ACROSS the boundary
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

  it('THE RANK: the ONE mini cell is base, beside the meter', () => {
    // This is the entire consequence of `face.order` on this module — with 2
    // params and a glyph, compact/full/dock all show both — so it is the one
    // thing worth pinning. WHY `base` is the next test's job; this one only
    // pins that the ladder is what the def says.
    expect(Object.fromEntries(tiers)).toEqual({
      mini: ['base'],
      compact: ['base', 'cvAmount'],
      full: ['base', 'cvAmount'],
      dock: ['base', 'cvAmount'],
    });
  });

  it('THE MINI CELL IS NOT INERT: it can make a freshly-spawned VCA pass audio', () => {
    // THE PROPERTY, not the choice. The mini cell is read OFF THE FACE rather
    // than named, so this survives a re-rank and forces the re-rank to re-argue
    // the property instead of editing a literal.
    //
    // The failure it exists to catch: `order: ['cvAmount','base']` put the
    // ATTENUVERTER on the tile. At the spawn state — base 0, cvAmount 1,
    // NOTHING PATCHED so cv = 0 — the whole `cvAmount × cv` term is zero, so
    // sweeping that cell end to end leaves the gain at 0 for its entire travel.
    // The tile then offers one control that provably cannot do anything AND a
    // `meter` glyph that is dark (gain 0 ⇒ silence ⇒ no RMS to draw), i.e. no
    // reachable way at that tier to make the module audible at all.
    const RANGES = { base: VCA_BASE, cvAmount: VCA_CV_AMOUNT } as const;
    const miniCells = face('mini').controls.map((c) => c.key);
    expect(miniCells, 'the mini tier shows exactly one cell').toHaveLength(1);
    const key = miniCells[0] as keyof typeof RANGES;
    expect(RANGES, `mini cell '${key}' is one of the two params`).toHaveProperty(key);

    // THE SPAWN STATE, verbatim: def defaults, and cv = 0 because an unpatched
    // input contributes nothing.
    const UNPATCHED_CV = 0;
    const gainWithCellAt = (v: number) =>
      vcaGain(
        key === 'base' ? v : VCA_BASE.default,
        key === 'cvAmount' ? v : VCA_CV_AMOUNT.default,
        UNPATCHED_CV,
      );

    // Sweep the cell's ENTIRE declared travel and collect the gains it reaches.
    const range = RANGES[key];
    const reached = new Set<number>();
    for (let i = 0; i <= 200; i++) reached.add(gainWithCellAt(range.min + ((range.max - range.min) * i) / 200));

    expect(
      reached.size,
      `the mini tile's one cell is '${key}', and on a bare spawn (base=${VCA_BASE.default}, ` +
        `cvAmount=${VCA_CV_AMOUNT.default}, cv unpatched) its whole travel produces exactly ` +
        `${reached.size} distinct gain value(s). A single value means the cell is INERT — the ` +
        `tier's only control cannot change the module, and the meter glyph beside it is dark ` +
        `for the same reason. Rank a control that is reachable from the spawn state.`,
    ).toBeGreaterThan(1);

    expect(
      Math.max(...reached),
      `and '${key}' must be able to make the VCA AUDIBLE from spawn, not merely to move a number`,
    ).toBeGreaterThan(0);
  });

  it('the lane never has to truncate this face (2 cells ≤ every cap)', () => {
    // laneBodyPlan keeps the ROW at `full` for a 2-cell glyph face, so the
    // glyph survives at every tier — the ≥4-cell glyph cliff never applies here.
    for (const tier of ['compact', 'full'] as const) {
      const plan = laneBodyPlan(face(tier).controls.length, 'trace', tier);
      expect(plan, tier).toEqual({
        layout: 'row',
        cellCount: 2,
        glyph: true,
        knobSize: 'md',
        // EMPTY — the ROW layout has no grid tracks at all. It is a flex line
        // with `align-items: center` and no fixed track, which is why a tall
        // cell there is simply a tall line and vca's two 69 px readout dials
        // have never overlapped anything. Only the PLATE reports tracks.
        rowTracks: [],
      });
    }
  });

  it('ONE page, and its header is the gain law rather than a house word', () => {
    const pages = face('dock').pages ?? [];
    expect(pages.map((p) => [p.id, p.label])).toEqual([['gain', 'gain = base + cv × amount']]);
    // `order` is PRIORITY, `pages` is FUNCTION order. They AGREE here — the
    // band reads left-to-right in the same order as the law printed above it,
    // and the ranking leads with the same knob for an independent reason (the
    // not-inert property above). They are still two different fields with two
    // different jobs; do not collapse one into the other.
    expect(pages[0].controls.map((c) => c.key)).toEqual(['base', 'cvAmount']);
    expect(vcaDef.face?.order).toEqual(['base', 'cvAmount']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PF-20 — THE DERIVED HERO READOUT, and the negative controls that are the only
// thing separating it from a knob relabelled.
//
// `at cv 1` prints `vcaGain(base, cvAmount, 1)` = `base + cvAmount`. The reason
// it is a `valueId` and not a `paramId` is that BOTH dials are individually
// correct about their own knob and blind to the other, while the number that
// decides whether this VCA clips is their SUM. Legs 1 and 2 below perturb each
// input in turn and assert (a) the knob readback a lazy author would have
// reached for does NOT move, and (b) the derived string DOES. Leg 3 re-derives
// the printed dB from `vcaGain` over a grid, so the string is pinned to the
// DSP's law rather than to its own table.
//
// These are PERMANENT legs, exactly like kickdrum's SUB LEVEL perturbation —
// the instrument is negative-controlled on every run, not once at authoring
// time (CLAUDE.md, "VALIDATE THE INSTRUMENT").
// ─────────────────────────────────────────────────────────────────────────────

describe('the derived hero readout — `at cv 1`', () => {
  /** The declared id, read OFF THE FACE rather than named, so a rename has to
   *  keep the whole chain consistent instead of leaving this file green. */
  const declaredId = () => {
    const ro = vcaDef.face?.hero?.readouts ?? [];
    expect(ro, 'the hero declares exactly one readout').toHaveLength(1);
    const id = ro[0]?.valueId;
    expect(id, 'the one hero readout resolves through valueId, not paramId/text').toBeTruthy();
    return id!;
  };

  /** The readout as the FACEPLATE resolves it: through the registry, with a
   *  reader shaped like the shell's. Going through the registry rather than
   *  calling the formatter directly is what stops an unregistered id from
   *  passing here while printing `—` in the dock. */
  const painted = (base: number, cvAmount: number) => {
    const id = declaredId();
    const fn = faceReadoutValueFor(id);
    expect(fn, `'${id}' is registered in face-readout-values.ts`).not.toBeNull();
    return fn!((pid) => ({ base, cvAmount })[pid as 'base' | 'cvAmount']);
  };

  it('LEG 1 — blind to cvAmount: the base dial does NOT move, the strip DOES', () => {
    // Hold `base` at 0.5 and halve the attenuverter. The gain at the top of the
    // sweep falls from 1.5 to 1.0 — the difference between clipping 3.5 dB past
    // unity on every envelope peak and landing exactly on unity — and nothing
    // else on the panel says so.
    expect(formatVcaBase(0.5), 'the base dial, before AND after — INVARIANT').toBe('-6.0 dB');

    const before = painted(0.5, 1);
    const after = painted(0.5, 0.5);
    expect(before).toBe('+3.5 dB');
    expect(after).toBe('UNITY');
    expect(
      after,
      'the derived readout must MOVE when cvAmount moves — if it does not, it is `base` ' +
        'wearing a formula and the whole valueId is unearned',
    ).not.toBe(before);
  });

  it('LEG 2 — blind to base: the cvAmount dial does NOT move, the strip DOES', () => {
    // The mirror. `cvAmount` prints its SENSE, which is `OPEN` at +1 whatever
    // `base` is doing, so the attenuverter's own readout cannot see this either.
    expect(formatVcaCvAmount(1), 'the cvAmount dial, before AND after — INVARIANT').toBe('OPEN');

    const before = painted(0, 1);
    const after = painted(0.5, 1);
    expect(before).toBe('UNITY');
    expect(after).toBe('+3.5 dB');
    expect(after, 'the derived readout must MOVE when base moves').not.toBe(before);
  });

  it('LEG 3 — THE ORACLE: the printed dB is re-derived from vcaGain, not from a table', () => {
    // Sweep a grid and read the NUMBER BACK OUT of the rendered string. A
    // formatter checked only against a list of expected strings passes just as
    // happily when the list and the code are wrong in the same direction; this
    // leg fails unless the glyphs on the faceplate agree with the law in
    // `vcaGain`, which is itself the mirror of vca.dsp.
    let dbForms = 0;
    for (let b = 0; b <= 1.0001; b += 0.1) {
      for (let a = -1; a <= 1.0001; a += 0.1) {
        const base = Number(b.toFixed(4));
        const cvAmount = Number(a.toFixed(4));
        const g = vcaGain(base, cvAmount, 1);
        const text = painted(base, cvAmount);
        const where = `base=${base} cvAmount=${cvAmount} g=${g.toFixed(4)}`;

        if (Math.abs(g) < VCA_DISPLAY_EPS) {
          expect(text, `${where}: a sweep peak that displays as zero reads CLOSED`).toBe('CLOSED');
          continue;
        }
        if (Math.abs(g - 1) < VCA_DISPLAY_EPS) {
          expect(text, `${where}: a sweep peak at 1.0 reads UNITY`).toBe('UNITY');
          continue;
        }

        // THE INVERSION IS THE ASSERTION: parse the printed dB back out and
        // compare it to the law. Units are dB; tolerance is one rounding step.
        dbForms++;
        const m = /^([+-]?\d+\.\d) dB( INV)?$/.exec(text);
        expect(m, `${where}: unparseable readout '${text}'`).not.toBeNull();
        expect(Number(m![1]), `${where}: printed dB vs 20·log10|base + cvAmount| (dB)`).toBeCloseTo(
          linearToDb(g),
          1,
        );
        // The ` INV` suffix is the face's ONLY statement that the output has
        // flipped phase, so it must track the sign of the sum exactly — which
        // is also why the strip needs no separate PHASE entry.
        expect(!!m![2], `${where}: ' INV' must appear iff the summed gain is negative`).toBe(g < 0);
      }
    }
    expect(dbForms, 'the grid must actually exercise the dB branch').toBeGreaterThan(100);
  });

  it('the strip does NOT repeat a dial: `at cv 0` would be `base`, and it is refused', () => {
    // `base` IS the gain at cv 0, so a second entry printing it would be the
    // same string twice in one full-width row (correction 1 makes that read as
    // an independent second measurement that happens to agree). The guard is
    // structural: no hero readout on this module may resolve through `paramId`.
    const ro = vcaDef.face?.hero?.readouts ?? [];
    expect(
      ro.filter((r) => r.paramId).map((r) => r.label),
      'a paramId readout on a 2-param module is a dial printed twice',
    ).toEqual([]);
    // And the refusal is arithmetic rather than taste: the gain at cv 0 is
    // exactly `base`, at every setting.
    for (const base of [0, 0.25, 0.5, 1]) {
      expect(vcaGain(base, VCA_CV_AMOUNT.default, 0)).toBe(base);
    }
  });

  it('the formatter is NOT squeezed by the lane knob-column budget', () => {
    // `formatVcaBase` drops its decimal at 10 dB because LANE_KCOL_MAX_PX gives
    // it 7 glyphs. The hero strip is dock-only and full-width, so the derived
    // readout keeps its decimal — and a future "tidy-up" that copies the lane
    // branch down here would silently coarsen a number measured against a
    // different box.
    expect(formatVcaGainAtFullCv(1, 1)).toBe('+6.0 dB');
    expect(formatVcaGainAtFullCv(0, -1)).toBe('0.0 dB INV');
    expect(formatVcaGainAtFullCv(0.5, -1)).toBe('-6.0 dB INV');
    expect(formatVcaGainAtFullCv(0, 0)).toBe('CLOSED');
  });
});

describe('the face states what the DSP does — anchored to vca.dsp, not to a comment', () => {
  const dspSource = readFileSync(
    fileURLToPath(new URL('../../../../dsp/src/vca.dsp', import.meta.url)),
    'utf8',
  );

  it('the rear `~` tick on `cv` tracks WHERE si.smoo sits in the .dsp', () => {
    // ⚠ THE PREMISE THIS PINS ALREADY REVERSED ONCE, SILENTLY. The rear card
    // shipped with NO tick on `cv` and an audit comment justifying it: the gain
    // SUM ran through si.smoo, so the CV was a 7 Hz one-pole away from the
    // multiply and a `~` would have been a lie. #1313 moved the de-zip onto the
    // two sliders — the CV path became full-bandwidth — and nothing noticed,
    // because the tick is declared in a def and its reason lived in a .dsp.
    //
    // So this asserts the LINK rather than either end: find the gain expression
    // in the real source, decide FROM IT whether cv is filtered, and require
    // `face.rear.audioRate` to agree. Move the smoothing back onto the sum and
    // this goes red until the tick comes off.
    const gainLine = dspSource.split('\n').find((l) => /^\s*gain\s*=/.test(l));
    expect(gainLine, 'vca.dsp declares a `gain = …` line').toBeTruthy();

    // The CV is filtered IFF the smoothing applies to an expression that still
    // contains `cv` — a trailing `: si.smoo` over the whole sum, or a
    // parenthesised group holding `cv`. Per-slider smoothing
    // (`(base : si.smoo) + (cvAmount : si.smoo) * cv`) leaves `cv` outside
    // every smoothed group.
    const smoothedGroups = [...gainLine!.matchAll(/\(([^()]*):\s*si\.smoo\s*\)/g)].map((m) => m[1]);
    const bareTail = /:\s*si\.smoo\s*;?\s*$/.test(gainLine!);
    const cvIsFiltered = bareTail || smoothedGroups.some((g) => /\bcv\b/.test(g));

    expect(
      cvIsFiltered,
      `vca.dsp gain line: ${gainLine!.trim()} — expected the de-zip on the two SLIDERS, ` +
        `leaving cv unfiltered. If this flipped, the DSP changed and the face must follow.`,
    ).toBe(false);

    expect(
      [...(vcaDef.face?.rear?.audioRate ?? [])],
      'cv is read at full bandwidth, so the rear card must tick it `~` (audio-rate). ' +
        'filter.ts states the same doctrine in its mirror form: a tick on an si.smoo-filtered ' +
        'CV would be "a lie about the one thing the tick exists to say".',
    ).toEqual(['cv']);

    // The AUDIO hole stays untouched — the tick marks the SURPRISING case, and
    // "audio-rate" on an audio input is noise (the mixer.ts precedent).
    expect(vcaDef.face?.rear?.audioRate).not.toContain('audio');
  });

  it('no surface still claims the CV path is band-limited', () => {
    // The statements #1313 falsified and left behind. This is a TEXT gate on
    // purpose: every one of them was prose, none was reachable by any type or
    // contract check, and all of them read as authoritative for months.
    const surfaces: [string, string][] = [
      ['docs.explanation', vcaDef.docs?.explanation ?? ''],
      ['docs.inputs.cv', vcaDef.docs?.inputs?.cv ?? ''],
      ['docs.outputs.audio', vcaDef.docs?.outputs?.audio ?? ''],
      ['face.pages[gain].hint', vcaDef.face?.pages?.[0]?.hint ?? ''],
      ['face.hint', vcaDef.face?.hint ?? ''],
    ];
    const falsified = [
      /cv path (?:responds|tracks) at envelope/i,
      /not audio.rate/i,
      /largely filtered out rather than ring.modulated/i,
      /summed gain is smoothed/i,
      /-?3\s*dB at 7\s*Hz/i,
    ];
    for (const [where, text] of surfaces) {
      for (const re of falsified) {
        expect(
          re.test(text),
          `${where} still asserts a band-limited CV path (/${re.source}/). The de-zip is on ` +
            `the two sliders as of #1313; cv reaches the multiply at full bandwidth.`,
        ).toBe(false);
      }
    }
  });
});

describe('PF-20 faceplate structure — the declarations, and the ones refused', () => {
  it('declares title + hint + a band hint, and NONE of them carries a load-bearing fact', () => {
    // `facePageHeader` returns null before it reads either field unless the
    // annotate toggle is on, so a fact stated ONLY here is invisible at rest.
    expect(vcaDef.face?.title).toBe('Amplifier');
    expect(vcaDef.face?.hint ?? '').not.toBe('');
    expect(vcaDef.face?.pages?.[0]?.hint ?? '').not.toBe('');

    // The clip risk → the readout strip (a live number; asserted above). This
    // is now the ONLY load-bearing fact the FRONT carries: the signal-flow
    // block that stated the other two was removed with the whole kind, and the
    // rear card carries both in a form the build can check (the `~` tick is
    // pinned against vca.dsp above; OUT INV is a real port on the rail).
    expect(vcaDef.face?.hero?.readouts?.[0]?.valueId).toBe('vca-gain-at-full-cv');
  });

  it('nothing on the face implies OUT INV is a stereo partner (dual-mono GROUP D)', () => {
    // `audio` and `audio_inv` are VARIANTS of one mono signal, so nothing on
    // the face may imply an L/R relationship the module does not have. The
    // signal-flow stage that used to say "tap" in those words is gone; this
    // half — the prohibition — is the half that still has a surface to guard.
    expect(JSON.stringify(vcaDef.face), 'no stereo-pair language on the face').not.toMatch(
      /stereo|\bwiden/i,
    );
    expect(
      vcaDef.outputs?.map((o) => o.id),
      'OUT INV is a real port, which is what makes the rear card able to state it',
    ).toContain('audio_inv');
  });

  it('the hero promotes NOTHING, so the meter survives and the band keeps both knobs', () => {
    // A hero `cell` suppresses the dock glyph (`heroGlyph = hasGlyph &&
    // !(view === 'dock-full' && hero?.cell)`), and on the module whose entire
    // job is "how loud right now" that trades a live RMS trace for a static
    // picture of two knob values. A hero `control` MOVES the key out of its
    // band, which on a 2-param face leaves a one-knob band.
    const hero = vcaDef.face?.hero;
    expect(
      hero?.cell,
      'no hero picture — every candidate graph here is a straight line',
    ).toBeUndefined();
    expect(hero?.control, 'no promoted control — it would empty half the band').toBeUndefined();
    expect(hero?.action, 'no audition — a VCA makes no sound of its own').toBeUndefined();
    expect(vcaDef.face?.glyph, 'so the live meter is still the dock hero').toBe('meter');
    expect(vcaDef.face?.pages?.[0]?.controls).toEqual(['base', 'cvAmount']);
  });
});
