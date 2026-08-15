// packages/web/src/lib/ui/modules/unityscalemathematik-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for the four UNITYSCALEMATHEMATIK hero
// readouts, plus the face's own structural claims.
//
// A derived readout earns its place only if it is negative-controlled on the
// input a KNOB readback would be blind to — permanently, not once at authoring
// time (module-faceplates.md, the kickdrum TAIL trap). This module's readouts
// carry THREE independent controls and each is asserted in both directions:
//
//   1. ACROSS DIALS — `half` and `over` are each a JOIN over ATT and CRV. An
//      ATT readback is blind to CRV and a CRV readback is blind to ATT.
//   2. ACROSS PROBES — `half` moves DOWN as CRV rises while `over` moves UP.
//      Publishing both is what makes the pivot at |x| = 1 visible rather than
//      merely assertable, and it is the claim the shipped docs got wrong
//      (#1715). Each is the other's negative control on every render.
//   3. ACROSS SECTIONS — the three channels do not cross-talk (measured
//      bit-exactly in art/scenarios/unityscalemathematik/cv-path.test.ts), so
//      moving A's dials must leave B's two numbers alone, and vice versa.
//
// Plus a TOTALITY leg: the generator runs on every render, so a throw takes the
// faceplate down mid-drag.

import { describe, expect, it } from 'vitest';
import { unityscalemathematikDef } from '$lib/audio/modules/unityscalemathematik';
import { faceReadoutValueFor } from '$lib/ui/workflow/face-readout-values';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { STRICT_FACES } from '$lib/ui/workflow/strict-faces';
import {
  UNITYSCALE_PROBE_HALF,
  UNITYSCALE_PROBE_OVER,
  UNITYSCALE_SHAPED_SECTIONS,
  fmtUnityscaleResponse,
  unityscaleFaceParams,
  unityscaleHalfText,
  unityscaleOverText,
  unityscaleResponse,
} from './unityscalemathematik-face-model';

/** A `read` over an explicit param map — the shape `FaceReadoutValue` takes. */
const reader = (over: Record<string, number> = {}) => (id: string) => over[id];

const base = () => unityscaleFaceParams(reader());

describe('unityscalemathematik face model — the shipped defaults', () => {
  it('resolves the def defaults for anything untouched', () => {
    expect(base()).toEqual({ unityAtten: 1, aAtten: 1, aCurve: 0, bAtten: 1, bCurve: 0 });
  });

  it('at the defaults the module is a WIRE — both probes pass unchanged', () => {
    // curve 0 ⇒ k = 1 ⇒ y = x · atten, and atten is +1, so both readouts print
    // their own probe magnitude. That is the honest resting state and it is
    // what makes any later movement attributable.
    const p = base();
    expect(unityscaleHalfText('a', p)).toBe(fmtUnityscaleResponse(UNITYSCALE_PROBE_HALF));
    expect(unityscaleOverText('a', p)).toBe(fmtUnityscaleResponse(UNITYSCALE_PROBE_OVER));
  });
});

describe('CONTROL 1 — the readouts are a JOIN over ATT and CRV, so each dial is blind to the other', () => {
  it('CURVE moves the response while ATT does not budge', () => {
    const flat = unityscaleResponse('a', UNITYSCALE_PROBE_HALF, unityscaleFaceParams(reader()));
    const bent = unityscaleResponse('a', UNITYSCALE_PROBE_HALF, unityscaleFaceParams(reader({ aCurve: 1 })));
    // 0.5 → 0.125: a 12 dB attenuation the ATT dial still reads `1.00` through.
    expect(flat).toBeCloseTo(0.5, 9);
    expect(bent).toBeCloseTo(0.125, 9);
    expect(bent).toBeLessThan(flat);
  });

  it('ATT moves the response while CURVE does not budge', () => {
    const at1 = unityscaleResponse('a', UNITYSCALE_PROBE_HALF, unityscaleFaceParams(reader({ aCurve: 1 })));
    const half = unityscaleResponse(
      'a',
      UNITYSCALE_PROBE_HALF,
      unityscaleFaceParams(reader({ aCurve: 1, aAtten: 0.5 })),
    );
    expect(half).toBeCloseTo(at1 / 2, 9);
  });

  it('a NEGATIVE atten INVERTS, and the readout prints the sign', () => {
    // The one state a player most needs to notice, and the shaping law keeps
    // the sign exactly (`sign(x)·|x|^k·atten`).
    const p = unityscaleFaceParams(reader({ aAtten: -1 }));
    expect(unityscaleResponse('a', UNITYSCALE_PROBE_HALF, p)).toBeCloseTo(-0.5, 9);
    expect(unityscaleHalfText('a', p).startsWith('-')).toBe(true);
  });
});

describe('CONTROL 2 — the two probes move in OPPOSITE directions (#1715)', () => {
  it('turning CURVE up pushes `half` DOWN and lifts `over` UP', () => {
    const rows = [0, 0.25, 0.5, 0.75, 1].map((aCurve) => {
      const p = unityscaleFaceParams(reader({ aCurve }));
      return {
        aCurve,
        half: unityscaleResponse('a', UNITYSCALE_PROBE_HALF, p),
        over: unityscaleResponse('a', UNITYSCALE_PROBE_OVER, p),
      };
    });
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.half, `half must fall as curve rises: ${JSON.stringify(rows)}`)
        .toBeLessThan(rows[i - 1]!.half);
      expect(rows[i]!.over, `over must rise as curve rises: ${JSON.stringify(rows)}`)
        .toBeGreaterThan(rows[i - 1]!.over);
    }
  });

  it('|x| = 1 is the ONLY fixed point — the property the docs asserted only half of', () => {
    // A single readout below unity would make the curve look like a pure
    // attenuator, which is exactly what `docs.explanation` used to claim
    // ("leaving larger excursions intact"). Both probes together are the fix.
    for (const aCurve of [0, 0.25, 0.5, 0.75, 1]) {
      const p = unityscaleFaceParams(reader({ aCurve }));
      expect(unityscaleResponse('a', 1, p), `unity must be fixed at curve ${aCurve}`).toBeCloseTo(1, 9);
    }
    expect(UNITYSCALE_PROBE_HALF, 'the probes must straddle the fixed point').toBeLessThan(1);
    expect(UNITYSCALE_PROBE_OVER, 'the probes must straddle the fixed point').toBeGreaterThan(1);
  });
});

describe('CONTROL 3 — the sections are independent, in both directions', () => {
  it("moving A's dials leaves B's readouts exactly where they were, and vice versa", () => {
    const b0 = { half: unityscaleHalfText('b', base()), over: unityscaleOverText('b', base()) };
    const a0 = { half: unityscaleHalfText('a', base()), over: unityscaleOverText('a', base()) };

    const aMoved = unityscaleFaceParams(reader({ aCurve: 1, aAtten: -0.3 }));
    expect(unityscaleHalfText('b', aMoved)).toBe(b0.half);
    expect(unityscaleOverText('b', aMoved)).toBe(b0.over);

    const bMoved = unityscaleFaceParams(reader({ bCurve: 1, bAtten: -0.3 }));
    expect(unityscaleHalfText('a', bMoved)).toBe(a0.half);
    expect(unityscaleOverText('a', bMoved)).toBe(a0.over);
  });

  it('UNITY moves NONE of the four — it is the table\'s own negative control', () => {
    // The reason `unityAtten` carries no readout at all: its output is one dial
    // relabelled. Asserting it moves nothing is what keeps that decision honest
    // rather than merely stated.
    const before = UNITYSCALE_SHAPED_SECTIONS.flatMap((s) => [
      unityscaleHalfText(s, base()),
      unityscaleOverText(s, base()),
    ]);
    for (const unityAtten of [-1, 0, 0.5, 1]) {
      const p = unityscaleFaceParams(reader({ unityAtten }));
      const after = UNITYSCALE_SHAPED_SECTIONS.flatMap((s) => [
        unityscaleHalfText(s, p),
        unityscaleOverText(s, p),
      ]);
      expect(after, `UNITY at ${unityAtten} moved a shaped-section readout`).toEqual(before);
    }
  });

  it('every SHAPED section moves at least one readout — deny-by-default over the roster', () => {
    // The other half of the pair above: UNITY moves nothing AND everything else
    // moves something, so the table is not merely inert.
    const before = (s: string) => [unityscaleHalfText(s, base()), unityscaleOverText(s, base())];
    for (const s of UNITYSCALE_SHAPED_SECTIONS) {
      for (const suffix of ['Atten', 'Curve']) {
        const id = `${s}${suffix}`;
        const to = suffix === 'Atten' ? -1 : 1;
        const after = [
          unityscaleHalfText(s, unityscaleFaceParams(reader({ [id]: to }))),
          unityscaleOverText(s, unityscaleFaceParams(reader({ [id]: to }))),
        ];
        expect(after, `${id} moved neither of section '${s}'s readouts`).not.toEqual(before(s));
      }
    }
  });
});

describe('TOTALITY — the generator runs on every render', () => {
  it('survives a fresh node, NaN and ±Infinity', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      for (const id of ['aAtten', 'aCurve', 'bAtten', 'bCurve', 'unityAtten']) {
        const p = unityscaleFaceParams(reader({ [id]: bad }));
        for (const s of UNITYSCALE_SHAPED_SECTIONS) {
          expect(typeof unityscaleHalfText(s, p)).toBe('string');
          expect(typeof unityscaleOverText(s, p)).toBe('string');
        }
      }
    }
  });

  it('an unknown param id throws rather than silently defaulting', () => {
    // `unityscaleFaceParams` resolves the DEF DEFAULT for anything untouched;
    // that must not extend to a param the def does not declare, or a renamed
    // param would read as "untouched" forever.
    expect(() => unityscaleResponse('zzz', 0.5, base())).not.toThrow();
    expect(Number.isNaN(unityscaleResponse('zzz', 0.5, base()))).toBe(true);
  });
});

describe('the FACE itself', () => {
  const face = unityscalemathematikDef.face!;

  it('is promoted, and every readout it declares is registered', () => {
    expect(STRICT_FACES.has('unityscalemathematik')).toBe(true);
    const declared = (face.hero?.readouts ?? []).map((r) => r.valueId!).filter(Boolean);
    expect(declared.length).toBeGreaterThan(0);
    for (const id of declared) {
      expect(faceReadoutValueFor(id), `readout '${id}' is not registered`).toBeTruthy();
    }
  });

  it('the registered generators produce the SAME strings the model does', () => {
    // Joins the registry to the model, so a mis-wired id (a `-half` bound to
    // the `-over` generator) is red rather than plausible.
    const read = reader({ aCurve: 1, aAtten: 0.5, bCurve: 0.5, bAtten: -1 });
    const p = unityscaleFaceParams(read);
    for (const s of UNITYSCALE_SHAPED_SECTIONS) {
      expect(faceReadoutValueFor(`unityscale-${s}-half`)!(read)).toBe(unityscaleHalfText(s, p));
      expect(faceReadoutValueFor(`unityscale-${s}-over`)!(read)).toBe(unityscaleOverText(s, p));
    }
  });

  it('the readout roster is DERIVED from the def, not typed', () => {
    // A third shaped channel would register its two ids without a list to
    // update, and a readout can never name a section the module does not have.
    const shaped = unityscalemathematikDef.params
      .filter((q) => q.id.endsWith('Curve'))
      .map((q) => q.id.slice(0, -'Curve'.length));
    expect([...UNITYSCALE_SHAPED_SECTIONS].sort()).toEqual(shaped.sort());
    expect(UNITYSCALE_SHAPED_SECTIONS).not.toContain('unity');
  });

  it("declares glyph 'none' BECAUSE the module publishes no audio output", () => {
    // ⚠ THE MARBLES DEFECT (#1692), asserted at its cause rather than at its
    // symptom. `primaryAudioOutPortId` matches `type === 'audio'`; this module
    // declares three `cv` outputs, so any other glyph would resolve to
    // `{ kind: 'static' }` — a live-looking readout of nothing that a VRT
    // baseline captures perfectly deterministically and therefore cannot see.
    expect(primaryAudioOutPortId(unityscalemathematikDef)).toBeNull();
    expect(face.glyph).toBe('none');
    expect(glyphBinding(unityscalemathematikDef).kind).toBe('none');
    // NEGATIVE CONTROL, both directions, against the REAL resolver: the same
    // def with any other glyph really would be dead.
    const withMeter = { ...unityscalemathematikDef, face: { ...face, glyph: 'meter' as const } };
    expect(glyphBinding(withMeter).kind).toBe('static');
    const withAudio = {
      ...withMeter,
      outputs: [...unityscalemathematikDef.outputs, { id: 'audio', type: 'audio' as const }],
    };
    expect(glyphBinding(withAudio).kind).toBe('live-audio');
  });

  it('ranks the identity first and the plain channel last', () => {
    // The ranking argument, asserted rather than left in a comment: A CRV is
    // the only control that bends anything (it is the only key whose param has
    // a `Curve` sibling relationship), and `unityAtten` is the only one that
    // cannot.
    expect(face.order[0]).toBe('aCurve');
    expect(face.order[face.order.length - 1]).toBe('unityAtten');
  });

  it('pages partition the params by SECTION, which is what the rear card projects', () => {
    // `rearFieldPlan` derives one rear band per page and files each page's CV
    // holes under it, so this partition is what puts each section's jacks under
    // its own header. Derived from the def both ways so a renamed param cannot
    // leave a page silently empty.
    const paged = (face.pages ?? []).flatMap((pg) => pg.controls);
    expect([...paged].sort()).toEqual(unityscalemathematikDef.params.map((p) => p.id).sort());
    for (const pg of face.pages ?? []) {
      for (const key of pg.controls) {
        // every control on page `<x>` belongs to section `<x>` (unity's param is
        // `unityAtten`, a's are `a*`), read off the id rather than listed.
        expect(key.toLowerCase().startsWith(pg.id.toLowerCase()), `'${key}' is not on page '${pg.id}'`)
          .toBe(true);
      }
    }
  });
});
