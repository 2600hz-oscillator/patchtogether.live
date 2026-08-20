// packages/web/src/lib/ui/modules/grains-of-vision-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS for grains-of-vision's three derived
// quantities, plus the face's own declaration legs.
//
// ⚠ NONE OF THE THREE PAINTS ANYWHERE, WHICH IS WHY THIS FILE MATTERS MORE, NOT
// LESS. They were authored as a `hero.readouts` row; the 2026-08-19 owner ruling
// (#1957) deleted that strip from the platform, so this unit lane is the ONLY
// thing holding the arithmetic — exactly as `moog984-face-model.test.ts` is for
// its column sums.
//
// The bar (module-faceplates.md): a derived quantity is negative-controlled on
// the input a knob readback would be BLIND to, PERMANENTLY — not once at
// authoring time.

import { describe, it, expect } from 'vitest';
import {
  GOV_SMEAR_DEAD_BAND,
  govFeedbackGain,
  govReverbTail,
  govSmearFrames,
} from './grains-of-vision-face-model';
import {
  GOV_COMPOSITE_MODES,
  GOV_HISTORY_FRAMES,
  GRAINS_OF_VISION_DEFAULTS,
  grainsOfVisionDef,
} from '$lib/video/modules/grainsOfVision';

/** A param reader over an explicit override map, defaulting to the def.
 *
 *  ⚠ The defaults are read through a KEYED lookup rather than a cast to
 *  `Record<string, number>`: `GrainsOfVisionParams` has no index signature, so
 *  the cast is one svelte-check rejects (vitest is lenient here and the gate is
 *  not). Keying it also means a param id that is not on the defaults object is
 *  a TYPE error rather than a silent `undefined` at runtime. */
type GovParamKey = keyof typeof GRAINS_OF_VISION_DEFAULTS;

function govDefault(id: string): number | undefined {
  return Object.hasOwn(GRAINS_OF_VISION_DEFAULTS, id)
    ? GRAINS_OF_VISION_DEFAULTS[id as GovParamKey]
    : undefined;
}

function reader(over: Record<string, number> = {}) {
  return (id: string): number | undefined => (id in over ? over[id] : govDefault(id));
}

/** A reader for a FRESH node — nothing written yet. */
const emptyReader = (): number | undefined => undefined;

const NON_FINITE = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

describe('SMEAR — the step function under a dial that looks continuous', () => {
  it('the shipped default is ONE frame, one step above the dead band', () => {
    expect(govSmearFrames(reader())).toBe(1);
  });

  it('⚠ the bottom of the RATE dial is BIT-EXACTLY ZERO frames — the headline gesture, off', () => {
    // The finding that lost its painted surface. A player who nudges RATE down
    // from the default finds the module stops graining time, with nothing on
    // screen to say a boundary was crossed.
    expect(govSmearFrames(reader({ rate: 0 }))).toBe(0);
    expect(govSmearFrames(reader({ rate: GOV_SMEAR_DEAD_BAND * 0.999 }))).toBe(0);
    // …and it really is a boundary, not a slope: one step past it is a WHOLE
    // frame. If this ever reads a fraction the model has stopped describing
    // `govDelayFrames`.
    expect(govSmearFrames(reader({ rate: GOV_SMEAR_DEAD_BAND * 1.001 }))).toBe(1);
  });

  it('reaches the ring floor at RATE 1, and never exceeds it', () => {
    expect(govSmearFrames(reader({ rate: 1 }))).toBe(GOV_HISTORY_FRAMES - 1);
    expect(govSmearFrames(reader({ rate: 99 }))).toBe(GOV_HISTORY_FRAMES - 1);
  });

  it('is INVARIANT to every other param on the module', () => {
    // ⚠ THE CONTROL THAT MATTERS: `time_spray` is the OTHER control on the same
    // page and reads like a partner. It scatters grains ACROSS the depth this
    // returns; it does not change the depth. A reviewer perturbing "the nearest
    // knob" would get a green from it either way.
    const base = govSmearFrames(reader());
    const moved: string[] = [];
    for (const p of grainsOfVisionDef.params) {
      if (p.id === 'rate') continue;
      const lo = govSmearFrames(reader({ [p.id]: p.min }));
      const hi = govSmearFrames(reader({ [p.id]: p.max }));
      if (lo !== base || hi !== base) moved.push(p.id);
    }
    expect(moved, 'params that moved a depth derived from `rate` alone').toEqual([]);
  });
});

describe('FEEDBACK GAIN — a product of two dials and a toggle, and none of the three can print it', () => {
  it('MOVES on fb_decay while feedback is HELD — the half an FB readback is blind to', () => {
    const held = 0.9;
    const a = govFeedbackGain(reader({ feedback: held, fb_decay: 1 }));
    const b = govFeedbackGain(reader({ feedback: held, fb_decay: 0.25 }));
    expect(a).toBeGreaterThan(b);
    // And at decay 0 the FB dial can sit near its maximum while BIT-EXACTLY
    // nothing returns — the case a single-dial readout reports as "loads".
    expect(govFeedbackGain(reader({ feedback: 0.98, fb_decay: 0 }))).toBe(0);
  });

  it('MOVES on feedback while fb_decay is HELD — the mirror leg', () => {
    const a = govFeedbackGain(reader({ feedback: 0.98, fb_decay: 0.9 }));
    const b = govFeedbackGain(reader({ feedback: 0.1, fb_decay: 0.9 }));
    expect(a).toBeGreaterThan(b);
  });

  it('⚠ fb_dry ZEROES it outright while BOTH dials stay put — a third control, of a different kind', () => {
    const both = { feedback: 0.98, fb_decay: 1 };
    expect(govFeedbackGain(reader(both))).toBeGreaterThan(0);
    expect(govFeedbackGain(reader({ ...both, fb_dry: 1 }))).toBe(0);
    // The consumer's own threshold, not a rounded one: this is why the def now
    // declares `curve: 'discrete'` rather than `linear`.
    expect(govFeedbackGain(reader({ ...both, fb_dry: 0.5 }))).toBe(0);
    expect(govFeedbackGain(reader({ ...both, fb_dry: 0.499 }))).toBeGreaterThan(0);
  });
});

describe('REVERB TAIL — two independent bypasses, either of which is the whole answer', () => {
  it('MOVES on rev_decay with the block engaged', () => {
    const a = govReverbTail(reader({ rev_mix: 1, rev_decay: 0.99 }));
    const b = govReverbTail(reader({ rev_mix: 1, rev_decay: 0.2 }));
    expect(a).toBeGreaterThan(b);
  });

  it('⚠ rev_mix 0 and rev_dry are INDEPENDENT bypasses — either alone is enough', () => {
    // A readout of `rev_decay` would report a long tail in both of these, and
    // be wrong in two different ways.
    expect(govReverbTail(reader({ rev_mix: 0, rev_decay: 0.99 }))).toBe(0);
    expect(govReverbTail(reader({ rev_mix: 1, rev_decay: 0.99, rev_dry: 1 }))).toBe(0);
    // POSITIVE CONTROL: with neither engaged the same settings are non-zero, so
    // the two legs above cannot be passing because the function always returns 0.
    expect(govReverbTail(reader({ rev_mix: 1, rev_decay: 0.99, rev_dry: 0 }))).toBeGreaterThan(0);
  });
});

describe('TOTALITY — these run on every render, so a throw takes the faceplate down mid-drag', () => {
  it('a FRESH node produces every value from the def defaults, never a throw', () => {
    expect(govSmearFrames(emptyReader)).toBe(govSmearFrames(reader()));
    expect(govFeedbackGain(emptyReader)).toBe(govFeedbackGain(reader()));
    expect(govReverbTail(emptyReader)).toBe(govReverbTail(reader()));
  });

  it('NaN and ±Infinity on ANY param produce a finite value, never a throw', () => {
    for (const p of grainsOfVisionDef.params) {
      for (const bad of NON_FINITE) {
        const r = reader({ [p.id]: bad });
        for (const [name, fn] of [
          ['smear', govSmearFrames],
          ['fbGain', govFeedbackGain],
          ['revTail', govReverbTail],
        ] as const) {
          const v = fn(r);
          expect(Number.isFinite(v), `${name} on ${p.id}=${bad}`).toBe(true);
        }
      }
    }
  });
});

describe('grainsOfVision face declaration', () => {
  const face = grainsOfVisionDef.face!;

  it('is UNTABBED: six honest bands, under the rail threshold, with none padded', () => {
    // ⚠ ANCHORED TO THE BANDS, NOT TO A NUMBER: every page must carry ≥2
    // controls, which is what makes "six" honest rather than six-by-splitting.
    // The seventh page was available (fb_zoom/fb_rotate) and refused.
    expect((face.pages ?? []).map((p) => p.id)).toEqual([
      'grain', 'scatter', 'time', 'feedback', 'reverb', 'composite',
    ]);
    const thin = (face.pages ?? []).filter((p) => p.controls.length < 2).map((p) => p.id);
    expect(thin, 'pages carrying fewer than two controls').toEqual([]);
  });

  it('pages cover EXACTLY the player-facing params — no orphan, no duplicate', () => {
    const paged = (face.pages ?? []).flatMap((p) => p.controls);
    expect(paged.length, 'a control appears on exactly one page').toBe(new Set(paged).size);
    const internal = new Set((grainsOfVisionDef.noUserControl ?? []).map((n) => n.param));
    const playerFacing = grainsOfVisionDef.params.map((p) => p.id).filter((id) => !internal.has(id));
    expect([...paged].sort()).toEqual([...playerFacing].sort());
  });

  it('the VRT freeze toggle is a real PARAM, SEEDED, and a control NOWHERE', () => {
    // ⚠ THE #1941 SHAPE. `freezeFaceVideo` writes `params.freeze = 1` into the
    // node's param map; three things must hold together and each one alone is
    // satisfiable while the pin is dead — the param exists, it is SEEDED in the
    // defaults the map is built from, and it is a control nowhere.
    const def = grainsOfVisionDef.params.find((p) => p.id === 'freeze');
    expect(def, 'a `freeze` ParamDef').toBeTruthy();
    expect(def!.defaultValue).toBe(0);
    expect(GRAINS_OF_VISION_DEFAULTS.freeze, 'seeded in the defaults map').toBe(0);
    expect(
      (grainsOfVisionDef.noUserControl ?? []).find((n) => n.param === 'freeze')?.writer,
    ).toBe('internal');
    expect(face.order, 'freeze must not be ranked').not.toContain('freeze');
    // …and nothing may CV it, or it stops being internal.
    expect(
      grainsOfVisionDef.inputs.filter((i) => i.paramTarget === 'freeze').map((i) => i.id),
    ).toEqual([]);
  });

  it('the two DRY bypasses are declared the way their consumer reads them', () => {
    // The defect this promotion fixed: consumed as `>= 0.5`, declared `linear`,
    // so `looksLikeToggle` was false and the face would have painted continuous
    // rotaries over two-state values.
    for (const id of ['fb_dry', 'rev_dry']) {
      const p = grainsOfVisionDef.params.find((q) => q.id === id)!;
      expect(p.curve, `${id} curve`).toBe('discrete');
      expect([p.min, p.max], `${id} range`).toEqual([0, 1]);
      expect(face.paramCells?.[id], `${id} must not be forced to a fader`).toBeUndefined();
    }
  });

  it('composite carries a NAMED roster derived from the shader\'s own mode list', () => {
    const p = grainsOfVisionDef.params.find((q) => q.id === 'composite')!;
    expect(p.options?.map((o) => o.label)).toEqual([...GOV_COMPOSITE_MODES]);
    // Values must be the indices the shader rounds to, and inside the range.
    expect(p.options?.map((o) => o.value)).toEqual(GOV_COMPOSITE_MODES.map((_, i) => i));
    expect(p.max).toBe(GOV_COMPOSITE_MODES.length - 1);
    expect(face.paramCells?.composite, 'must not be forced to a fader').toBeUndefined();
  });

  it('routes its SCREEN toggle through the extension slot, not the card', () => {
    // The #1928 class: promotion deletes the card, so a toggle that lives only
    // there is deleted by the promotion meant to keep it.
    expect(face.extension).toBe('grainsOfVision');
  });
});
