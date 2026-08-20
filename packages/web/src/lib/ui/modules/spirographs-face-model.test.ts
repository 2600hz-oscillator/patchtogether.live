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
/** Every `spirographs-` readout the registry holds. */

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
