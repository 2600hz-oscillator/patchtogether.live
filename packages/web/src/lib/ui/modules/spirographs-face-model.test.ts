// packages/web/src/lib/ui/modules/spirographs-face-model.test.ts
//
// THE PERMANENT NEGATIVE CONTROLS under the SPIROGRAPHS faceplate, plus the
// three audit findings the face is built on.
//
// ⚠ THE CONTROL IS `count`, AND IT IS THE STRONGEST ONE IN THIS BATCH. `count`
// ships at 1, so spiro 2 and spiro 3 render NOTHING while carrying full,
// plausible-looking banks of ten dials each. Every readout here is computed
// over the LIVE spiros only — so perturbing any of spiro 3's ten dials at
// `count = 1` must move NONE of them, while spiro 3's own knob readback happily
// reports the new value. That is a blindness no per-knob readout can have, and
// the same perturbation must become visible the moment `count` rises, so the
// invariance cannot be a dead probe.

import { describe, expect, it } from 'vitest';
import {
  SPIRO_COUNT_MAX,
  SPIRO_INSIDE_OPTIONS,
  SPIRO_PAGE_GROUPS,
  SPIRO_PARAM_STEMS,
  spiroParamId,
  spirographsDef,
  spirographsOrder,
  spirographsPages,
} from '$lib/video/modules/spirographs';
import { curveMaxReach, REVS_MAX_DEFAULT } from '$lib/video/modules/spirographs-math';
import { glyphBinding, primaryAudioOutPortId } from '$lib/ui/workflow/shell-glyph-live';
import { hasVideoSurface } from '$lib/ui/workflow/module-shell-model';
import { noUserControlIds, noUserControlProblems } from '$lib/ui/workflow/no-user-control';
import { DOCK_TAB_MIN_BANDS } from '$lib/ui/workflow/dock-tabs-model';
import {
  spiroCanClip,
  spiroIsDense,
  spiroPetals,
  spiroReach,
  spiroRevolutions,
  spirographsFaceState,
} from './spirographs-face-model';

const DEFAULTS: Record<string, number> = Object.fromEntries(
  spirographsDef.params.map((p) => [p.id, p.defaultValue]),
);
const reader = (over: Record<string, number> = {}) => (id: string): number | undefined => {
  const merged: Record<string, number> = { ...DEFAULTS, ...over };
  return id in merged ? merged[id] : undefined;
};
const shown = (valueId: string, over: Record<string, number> = {}): string =>
  faceReadoutValueFor(valueId)!(reader(over));
/** Every `spirographs-` readout the registry holds. */
const IDS = (): string[] => faceReadoutValueIds().filter((k) => k.startsWith('spirographs-'));

describe('spirographs — the three audit findings', () => {
  it('FINDING 1: `count` ships at 1, so TWENTY of the thirty-one params are inert at spawn', () => {
    expect(DEFAULTS.count).toBe(1);
    const { spiros } = spirographsFaceState(reader());
    expect(spiros.filter((s) => s.live).map((s) => s.index)).toEqual([1]);
    // Derived, never hand-counted: the params belonging to a NON-live spiro.
    const inert = spirographsDef.params.filter((p) =>
      spiros.some((s) => !s.live && SPIRO_PARAM_STEMS.some((st) => spiroParamId(s.index, st) === p.id)),
    );
    expect(inert.length, 'params on a spiro that does not render at spawn').toBe(
      (SPIRO_COUNT_MAX - 1) * SPIRO_PARAM_STEMS.length,
    );
    expect(inert.length).toBeGreaterThan(spirographsDef.params.length / 2);
  });

  it('FINDING 2: `inside` declares a NAMED roster, so a promoted face can say which curve', () => {
    for (let i = 1; i <= SPIRO_COUNT_MAX; i++) {
      const p = spirographsDef.params.find((x) => x.id === spiroParamId(i, 'inside'))!;
      expect(p.curve, `${p.id} curve`).toBe('discrete');
      expect(p.options, `${p.id} has no option roster`).toBe(SPIRO_INSIDE_OPTIONS);
      for (const o of p.options!) {
        expect(o.value).toBeGreaterThanOrEqual(p.min);
        expect(o.value).toBeLessThanOrEqual(p.max);
      }
      expect((p as { format?: unknown }).format, 'a format would kill the painted name').toBeUndefined();
    }
    expect(SPIRO_INSIDE_OPTIONS.map((o) => o.label)).toEqual(['OUTSIDE', 'INSIDE']);
  });

  it('FINDING 3: whether a figure CLIPS is exactly SCALE-INVARIANT', () => {
    // Only the FIXED circle is bound-constrained (radius R*scale, bounced off an
    // inset of its own size); the pen reaches curveMaxReach*scale. So the test
    // is reach > R and `scale` multiplies BOTH sides away.
    const base = shown('spirographs-clip', { count: SPIRO_COUNT_MAX });
    for (const scale of [4, 12, 24, 47, 60]) {
      const over: Record<string, number> = { count: SPIRO_COUNT_MAX };
      for (let i = 1; i <= SPIRO_COUNT_MAX; i++) over[spiroParamId(i, 'scale')] = scale;
      expect(shown('spirographs-clip', over), `clip verdict at scale ${scale}`).toBe(base);
    }
    // …and it DOES move on a dial that genuinely changes the reach.
    expect(
      shown('spirographs-clip', { count: SPIRO_COUNT_MAX, s2_p: 0 }),
      'shrinking spiro 2 pen offset must change the verdict',
    ).not.toBe(base);

    // The shipped numbers, stated so a reviewer can check them by eye.
    const { spiros } = spirographsFaceState(reader({ count: SPIRO_COUNT_MAX }));
    expect(spiroReach(spiros[0]!)).toBeCloseTo(4.2, 6);
    expect(spiroReach(spiros[1]!)).toBeCloseTo(7.5, 6);
    expect(spiroReach(spiros[2]!)).toBeCloseTo(9.0, 6);
    expect(spiroCanClip(spiros[0]!), 'spiro 1 always fits (4.2 vs R 5)').toBe(false);
    expect(spiroCanClip(spiros[1]!), 'spiro 2 can clip (7.5 vs R 7)').toBe(true);
    expect(spiroCanClip(spiros[2]!), 'spiro 3 can clip (9.0 vs R 5)').toBe(true);
    // The model uses the MODULE's own function, not a copy.
    expect(spiroReach(spiros[1]!)).toBe(curveMaxReach('inside', 7, 3, 3.5));
  });
});

describe('spirographs readouts — `count` is the permanent negative control', () => {
  it('at count = 1, perturbing ANY of spiro 3\'s dials moves NOTHING', () => {
    const before = IDS().map((id) => shown(id));
    for (const stem of SPIRO_PARAM_STEMS) {
      const id = spiroParamId(3, stem);
      // A value that would visibly change every readout if spiro 3 were live:
      // an irrational-ish r (never closes) and a huge pen offset (clips).
      const over: Record<string, number> = { [id]: stem === 'r' ? 2.4142 : stem === 'p' ? 8 : 0.7 };
      const after = IDS().map((x) => shown(x, over));
      expect(after, `spiro 3 ${stem} moved a readout while count = 1`).toEqual(before);
    }
  });

  it('…and the SAME perturbations DO move them once count reaches 3', () => {
    // Without this leg the invariance above would pass on a dead probe.
    const live = { count: SPIRO_COUNT_MAX };
    expect(shown('spirographs-closes', { ...live, s3_r: 2.4142 })).not.toBe(
      shown('spirographs-closes', live),
    );
    expect(shown('spirographs-clip', { ...live, s3_p: 0, s3_inside: 1, s3_r: 3 })).not.toBe(
      shown('spirographs-clip', live),
    );
    expect(shown('spirographs-figure-3', live)).not.toBe(shown('spirographs-figure-3', {}));
  });

  it('`live` states how many spiros draw, and moves only with count', () => {
    expect(shown('spirographs-live')).toBe(`1 of ${SPIRO_COUNT_MAX}`);
    expect(shown('spirographs-live', { count: 2 })).toBe(`2 of ${SPIRO_COUNT_MAX}`);
    expect(shown('spirographs-live', { count: 3 })).toBe(`3 of ${SPIRO_COUNT_MAX}`);
    expect(shown('spirographs-live', { s1_R: 11, s2_r: 9 }), 'live must ignore every dial').toBe(
      `1 of ${SPIRO_COUNT_MAX}`,
    );
  });

  it('`closes` distinguishes a rational ratio from one a millimetre away', () => {
    // THE FINDING: R and r are CONTINUOUS, so almost nothing closes.
    expect(shown('spirographs-closes')).toBe('all close');
    expect(shown('spirographs-closes', { s1_r: 2.4142 })).toBe('1 dense');
    expect(shown('spirographs-closes', { count: 3, s2_r: 3.1416, s3_r: 1.618 })).toBe('2, 3 dense');
    // and the module's own cap is what "dense" means.
    const { spiros } = spirographsFaceState(reader({ s1_r: 2.4142 }));
    expect(spiroRevolutions(spiros[0]!)).toBe(REVS_MAX_DEFAULT);
    expect(spiroIsDense(spiros[0]!)).toBe(true);
  });

  it('the sidebar prints `off` for a spiro that is not drawing — never a figure', () => {
    expect(shown('spirographs-figure-1')).toBe('5 petals · 3 rev');
    expect(shown('spirographs-figure-2'), 'spiro 2 is off at spawn').toBe('off');
    expect(shown('spirographs-figure-3'), 'spiro 3 is off at spawn').toBe('off');
    expect(shown('spirographs-figure-2', { count: 3 })).toBe('7 petals · 3 rev');
    expect(shown('spirographs-figure-3', { count: 3 })).toBe('5 petals · 2 rev');
    // A dense figure prints `dense`, NOT a fabricated petal count — the
    // rationalisation yields 2500 there, which is an artifact of REVS_PRECISION
    // and not a thing anyone could see.
    expect(shown('spirographs-figure-1', { s1_r: 2.4142 })).toBe('dense');
    const { spiros } = spirographsFaceState(reader({ s1_r: 2.4142 }));
    expect(spiroPetals(spiros[0]!), 'the artifact the readout refuses to print').toBeGreaterThan(100);
  });
});

describe('spirographs face — the declaration is sound', () => {
  it('is TABBED: ten pages, past the rail threshold, with no padding', () => {
    const pages = spirographsDef.face!.pages!;
    expect(pages.length).toBe(1 + SPIRO_COUNT_MAX * SPIRO_PAGE_GROUPS.length);
    expect(pages.length).toBeGreaterThanOrEqual(DOCK_TAB_MIN_BANDS);
    // No page is empty, and only `count` is a single-control page.
    for (const p of pages) expect(p.controls.length, `page ${p.id}`).toBeGreaterThan(0);
    expect(pages.filter((p) => p.controls.length === 1).map((p) => p.id)).toEqual(['count']);
  });

  it('every param except `freeze` is ranked exactly once, and `freeze` never is', () => {
    const order = spirographsOrder();
    expect(new Set(order).size, 'no key ranked twice').toBe(order.length);
    const noControl = noUserControlIds(spirographsDef);
    const rankable = spirographsDef.params.filter((p) => !noControl.has(p.id)).map((p) => p.id);
    expect([...order].sort()).toEqual([...rankable].sort());
    expect(order).not.toContain('freeze');
    // pages and order carry the SAME keys, in the same order.
    expect(spirographsPages().flatMap((p) => p.controls)).toEqual([...order]);
  });

  it('the page grouping covers every stem exactly once', () => {
    const grouped = SPIRO_PAGE_GROUPS.flatMap((g) => g.stems);
    expect([...grouped].sort()).toEqual([...SPIRO_PARAM_STEMS].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('`freeze` is a SOUND noUserControl declaration', () => {
    expect(noUserControlProblems(spirographsDef), 'unsound declaration').toEqual([]);
    expect([...noUserControlIds(spirographsDef)]).toEqual(['freeze']);
    // `writer: 'internal'` is a claim about this def's OWN ports — assert it.
    expect(
      spirographsDef.inputs.some((i) => i.paramTarget === 'freeze'),
      'a CV port targets freeze, so writer:internal is now false',
    ).toBe(false);
  });

  it('⚠ the glyph is `none` and the PICTURE comes from a different seam', () => {
    // A video def has no audio output, so every other glyph resolves to a dead
    // static binding. `'none' + blank tile` and `'none' + live picture` are
    // indistinguishable from the declaration — so assert the SEAM.
    expect(primaryAudioOutPortId(spirographsDef as never)).toBeNull();
    expect(spirographsDef.face!.glyph).toBe('none');
    expect(glyphBinding(spirographsDef as never)).toEqual({ kind: 'none' });
    expect(hasVideoSurface(spirographsDef as never), 'the face would be a blank tile').toBe(true);

    // NEGATIVE CONTROL, overriding the glyph in BOTH mutants — `glyphBinding`
    // short-circuits on the `'none'` literal before it inspects a port, so a
    // mutant that only adds an output would measure the literal instead.
    const asMeter = { ...spirographsDef, face: { ...spirographsDef.face!, glyph: 'meter' as const } };
    expect(glyphBinding(asMeter as never).kind, 'any other glyph here is DEAD').toBe('static');
  });
});

describe('spirographs readouts are TOTAL — they run on every render', () => {

  it('a hostile `count` still resolves to a real spiro set', () => {
    for (const v of [NaN, Infinity, -Infinity, -5, 99]) {
      const { count, spiros } = spirographsFaceState(reader({ count: v }));
      expect(count, `count=${v}`).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(SPIRO_COUNT_MAX);
      expect(spiros.length).toBe(SPIRO_COUNT_MAX);
    }
  });
});
