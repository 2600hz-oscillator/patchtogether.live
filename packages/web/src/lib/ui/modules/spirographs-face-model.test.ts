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
  it('is THREE TABS — one per spiro — and the rail is an OWNER OPT-IN, not a threshold win', () => {
    // ⚠ THIS ASSERTED "ten pages, past the rail threshold" UNTIL 2026-08-19.
    // The owner replaced the layout by name — *"this should just be 3 tabs, one
    // per spiro"* — so the page count is now BELOW the threshold and the rail
    // comes from `face.tabbed`. Both halves are asserted, because either one
    // alone would be satisfied by a face that is not railed at all.
    const pages = spirographsDef.face!.pages!;
    expect(pages.length, 'one page per spiro, and nothing else').toBe(SPIRO_COUNT_MAX);
    expect(
      pages.length,
      'the point of the opt-in: this face is UNDER the threshold and railed anyway',
    ).toBeLessThan(DOCK_TAB_MIN_BANDS);
    expect(spirographsDef.face!.tabbed, 'the rail is declared, not derived').toBe(true);

    // Each page carries its spiro's WHOLE bank, and the three ideas survive as
    // CLUSTERS rather than as pages of their own.
    for (const [i, page] of pages.entries()) {
      expect(page.id, 'pages are per-spiro, in spiro order').toBe(`s${i + 1}`);
      expect(page.controls.length, `page ${page.id} carries the whole bank`).toBe(
        SPIRO_PARAM_STEMS.length,
      );
      const clusters = (page as { clusters?: { label: string; controls: string[] }[] }).clusters;
      expect(clusters?.map((c) => c.label), `page ${page.id} keeps figure/place/look`).toEqual(
        SPIRO_PAGE_GROUPS.map((g) => g.label),
      );
      // …and the clusters partition the page: every control, exactly once.
      expect([...(clusters ?? []).flatMap((c) => c.controls)].sort()).toEqual(
        [...page.controls].sort(),
      );
    }
  });

  it('COUNT is the shared chrome — hero, not a tab of its own', () => {
    // The owner's instruction was three tabs, one per spiro. `count` is the
    // module's only true global and decides how many of those tabs mean
    // anything, so it sits above the rail in every view instead of holding a
    // rail chip by itself.
    expect(spirographsDef.face!.hero?.control).toBe('count');
    const pages = spirographsDef.face!.pages!;
    expect(
      pages.flatMap((p) => p.controls),
      'count is on NO page — it is promoted out of the defensive unpaged band',
    ).not.toContain('count');
  });

  it('each spiro HUE is the colour WHEEL, not a dial', () => {
    // The owner, on the card as the reference layout: *"this is all it needs and
    // it needs all this including the color picker"*. Asserted per spiro so a
    // partial declaration (one wheel, two dials) is red.
    const cells = spirographsDef.face!.paramCells ?? {};
    for (let i = 1; i <= SPIRO_COUNT_MAX; i++) {
      expect(cells[spiroParamId(i, 'chroma')], `spiro ${i} hue`).toBe('hue');
    }
    // …and the param really is the shape that primitive requires — a
    // CONTINUOUS single turn. module-face-lint refuses 'hue' on anything else,
    // so this is the module-side half of that two-sided contract.
    for (let i = 1; i <= SPIRO_COUNT_MAX; i++) {
      const pd = spirographsDef.params.find((p) => p.id === spiroParamId(i, 'chroma'))!;
      expect(pd.min, `spiro ${i} hue min`).toBe(0);
      expect(pd.max, `spiro ${i} hue max`).toBe(1);
      expect(pd.curve, `spiro ${i} hue is continuous`).not.toBe('discrete');
    }
  });

  it('every param except `freeze` is ranked exactly once, and `freeze` never is', () => {
    const order = spirographsOrder();
    expect(new Set(order).size, 'no key ranked twice').toBe(order.length);
    const noControl = noUserControlIds(spirographsDef);
    const rankable = spirographsDef.params.filter((p) => !noControl.has(p.id)).map((p) => p.id);
    expect([...order].sort()).toEqual([...rankable].sort());
    expect(order).not.toContain('freeze');
    // `order` is `count` + every page's controls: the hero key must be RANKED
    // (heroFacePlan resolves it out of the plan) even though it is on no page.
    expect(['count', ...spirographsPages().flatMap((p) => p.controls)]).toEqual([...order]);
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
