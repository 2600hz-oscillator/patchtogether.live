// packages/web/src/lib/ui/workflow/dock-faceplate-model.test.ts
//
// PF-20 — the unit pin for the dock faceplate's LAYOUT ARITHMETIC.
//
// The one genuinely dangerous operation in the platform is the HERO PROMOTION:
// it MOVES a control out of its band, and both failure modes are silent in a
// screenshot. Drop one and the dock has lost a control; copy one and the dock
// emits `control-<paramId>` twice, which faces-parity reports as "an unbacked
// extra control". Neither is visible to `dockFacePlan`'s own parity gate,
// because that gate runs BEFORE the split.
//
// So the split is pure, and its totality is a property here rather than a
// browser assertion: every test below that touches heroFacePlan also asserts
// heroFacePlanIsTotal, and module-face-lint asserts it over the whole registry.

import { describe, it, expect } from 'vitest';
import type { ParamDef } from '$lib/graph/types';
import { dockFacePlan, dockPlanControls, type DockFaceBand, type FaceDefLike } from './curated-face';
import {
  bandHeaderPlan,
  faceAnnotationProse,
  faceAnnotationTally,
  faceAnnotations,
  faceHasAnnotations,
  facePageHeader,
  heroFacePlan,
  heroFacePlanIsTotal,
  type FaceplateDefLike,
} from './dock-faceplate-model';

const PARAMS: ParamDef[] = [
  { id: 'tune', label: 'Tune', defaultValue: 50, min: 20, max: 120, curve: 'log', units: 'Hz' },
  { id: 'decay', label: 'Decay', defaultValue: 450, min: 50, max: 800, curve: 'log', units: 'ms' },
  { id: 'mix', label: 'Mix', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
  {
    id: 'mode',
    label: 'Mode',
    defaultValue: 0,
    min: 0,
    max: 2,
    curve: 'discrete',
    options: [
      { value: 0, label: 'LP' },
      { value: 1, label: 'HP' },
      { value: 2, label: 'BP' },
    ],
  },
];

/** A three-band face: two flat bands and one carrying a PF-9 cluster, so the
 *  hero split is exercised against BOTH membership shapes. */
function fixture(extra: Partial<FaceplateDefLike['face']> = {}): FaceplateDefLike {
  return {
    params: PARAMS,
    controlFamilies: [{ id: 'fx-strike', label: 'Strike' }],
    face: {
      order: ['tune', 'decay', 'fx-strike-{n}', 'mix', 'mode'],
      pages: [
        { id: 'voice', label: 'voice', hint: 'the pulse', controls: ['fx-strike-{n}', 'tune', 'decay'] },
        {
          id: 'out',
          label: 'out',
          controls: ['mix', 'mode'],
          clusters: [{ label: 'shape', controls: ['mode'] }],
        },
      ],
      ...extra,
    },
  } as FaceplateDefLike;
}

function bandsOf(def: FaceplateDefLike): DockFaceBand[] {
  return dockFacePlan(def as FaceDefLike)!;
}

// ── 1. THE PAGE HEADER ──────────────────────────────────────────────────────

describe('facePageHeader — the title/hint rows', () => {
  it('is null for a face that declares neither, so pre-PF-20 faceplates do not move', () => {
    expect(facePageHeader(fixture())).toBeNull();
    expect(facePageHeader(fixture(), true)).toBeNull();
    expect(facePageHeader(undefined)).toBeNull();
    expect(facePageHeader(undefined, true)).toBeNull();
  });

  it('treats a BLANK declaration as absent — a typo must not paint an empty row', () => {
    expect(facePageHeader(fixture({ title: '   ', hint: '' } as never), true)).toBeNull();
  });

  it('renders either row alone', () => {
    expect(facePageHeader(fixture({ title: 'Voice' } as never), true)).toEqual({
      title: 'Voice',
      hint: '',
    });
    expect(facePageHeader(fixture({ hint: 'one bus' } as never), true)).toEqual({
      title: '',
      hint: 'one bus',
    });
  });

  it('trims, so authored whitespace never becomes layout', () => {
    expect(facePageHeader(fixture({ title: '  Voice \n', hint: ' one bus ' } as never), true)).toEqual({
      title: 'Voice',
      hint: 'one bus',
    });
  });

  // ── THE ANNOTATION GATE (owner 2026-08-02) ────────────────────────────────
  //
  // BOTH ROWS ARE ANNOTATION, title included. The first draft exempted the
  // title as "a name, not a note" and the owner overruled it: the module's name
  // is the dock TITLE BAR's, and `face.title` is a category word describing the
  // page. Both directions are asserted, because "hidden when off" alone would
  // pass just as happily against a header that never renders at all.
  it('SUPPRESSES THE WHOLE HEADER by default — title as well as hint', () => {
    const titled = fixture({ title: 'Voice', hint: 'one bus' } as never);
    expect(facePageHeader(titled), 'the default is OFF').toBeNull();
    expect(facePageHeader(titled, false), 'and explicitly off is the same').toBeNull();
  });

  it('a TITLE-ONLY face is also blank at rest — the resting card carries no section name', () => {
    expect(facePageHeader(fixture({ title: 'Voice' } as never))).toBeNull();
  });

  it('a HINT-ONLY face paints NOTHING at rest — no empty header row for prose nobody asked for', () => {
    expect(facePageHeader(fixture({ hint: 'one bus' } as never))).toBeNull();
  });

  it('…and prints BOTH with annotations ON (the negative control for the above)', () => {
    expect(facePageHeader(fixture({ title: 'Voice', hint: 'one bus' } as never), true)).toEqual({
      title: 'Voice',
      hint: 'one bus',
    });
  });
});

// ── 1a. THE BAND HEADER ─────────────────────────────────────────────────────

describe('bandHeaderPlan — TWO independent suppressions, asked separately', () => {
  const band = { label: 'strike', hint: 'the pulse' };

  // The whole point of the function, so the whole matrix is pinned. Before it,
  // the shell asked one question and the (tabbed, annotations=on) cell answered
  // '' for the hint — the prose rendered NOWHERE.
  it('covers all four tabbed × annotations combinations', () => {
    expect(bandHeaderPlan(band, { tabbed: false, annotations: false })).toEqual({
      label: 'strike',
      hint: '',
    });
    expect(bandHeaderPlan(band, { tabbed: false, annotations: true })).toEqual({
      label: 'strike',
      hint: 'the pulse',
    });
    expect(
      bandHeaderPlan(band, { tabbed: true, annotations: false }),
      'a rail suppresses the label — it already says the name ~14px above',
    ).toEqual({ label: '', hint: '' });
    expect(
      bandHeaderPlan(band, { tabbed: true, annotations: true }),
      'THE REGRESSION: a tabbed face still paints its hint. Coupled, this was ""',
    ).toEqual({ label: '', hint: 'the pulse' });
  });

  it('the LABEL is invariant to annotations, and the HINT is invariant to tabs', () => {
    // Stated as invariances because that is what "independent" means, and it is
    // the property a future edit is most likely to break by re-nesting them.
    for (const annotations of [false, true]) {
      expect(bandHeaderPlan(band, { tabbed: false, annotations }).label).toBe('strike');
      expect(bandHeaderPlan(band, { tabbed: true, annotations }).label).toBe('');
    }
    for (const tabbed of [false, true]) {
      expect(bandHeaderPlan(band, { tabbed, annotations: true }).hint).toBe('the pulse');
      expect(bandHeaderPlan(band, { tabbed, annotations: false }).hint).toBe('');
    }
  });

  it('is TOTAL: absent and whitespace-only fields are the empty string, never undefined', () => {
    expect(bandHeaderPlan({}, { tabbed: false, annotations: true })).toEqual({ label: '', hint: '' });
    expect(
      bandHeaderPlan({ label: '  ', hint: '\n ' }, { tabbed: false, annotations: true }),
      'blank is absent — the markup must not emit an empty <h4>',
    ).toEqual({ label: '', hint: '' });
  });

  it('trims, so authored whitespace never becomes layout', () => {
    expect(bandHeaderPlan({ label: ' out ', hint: '  wet  ' }, { tabbed: false, annotations: true })).toEqual({
      label: 'out',
      hint: 'wet',
    });
  });
});

// ── 1b. THE ANNOTATION ROSTER ───────────────────────────────────────────────

describe('faceAnnotations / faceAnnotationProse / faceHasAnnotations — what the toggle reveals', () => {
  it('collects the title, the page hint and every band hint, in declaration order', () => {
    // The base fixture already declares one band hint ('the pulse').
    expect(faceAnnotationProse(fixture({ title: 'Voice', hint: 'one bus' } as never))).toEqual([
      'Voice',
      'one bus',
      'the pulse',
    ]);
  });

  it('TAGS each string with the surface it paints on', () => {
    expect(faceAnnotations(fixture({ title: 'Voice', hint: 'one bus' } as never))).toEqual([
      { kind: 'title', text: 'Voice' },
      { kind: 'page-hint', text: 'one bus' },
      { kind: 'band-hint', text: 'the pulse' },
    ]);
  });

  it('a TITLE-ONLY face HAS annotations — otherwise its title is unreachable', () => {
    // The load-bearing consequence of the owner's 2026-08-02 direction: the
    // title now paints only behind the toggle, so a roster blind to it would
    // withhold the toggle and strand the title in no state of the UI at all.
    const titleOnly = {
      params: PARAMS,
      face: { order: ['tune'], title: 'Voice', pages: [{ id: 'a', label: 'a', controls: ['tune'] }] },
    } as unknown as FaceplateDefLike;
    expect(faceAnnotationProse(titleOnly)).toEqual(['Voice']);
    expect(faceHasAnnotations(titleOnly)).toBe(true);
  });

  it('a face with only band hints still has annotations (the toggle must appear)', () => {
    expect(faceAnnotationProse(fixture())).toEqual(['the pulse']);
    expect(faceHasAnnotations(fixture())).toBe(true);
  });

  it('drops blanks and trims — an authoring typo is not an annotation', () => {
    const def = {
      params: PARAMS,
      face: {
        order: ['tune'],
        title: '  ',
        hint: '   ',
        pages: [
          { id: 'a', label: 'a', hint: '  spaced  ', controls: ['tune'] },
          { id: 'b', label: 'b', hint: '', controls: [] },
        ],
      },
    } as unknown as FaceplateDefLike;
    expect(faceAnnotationProse(def)).toEqual(['spaced']);
  });

  it('is FALSE for a face with no prose at all — no toggle over an empty layer', () => {
    const bare = {
      params: PARAMS,
      face: { order: ['tune'], pages: [{ id: 'a', label: 'a', controls: ['tune'] }] },
    } as unknown as FaceplateDefLike;
    expect(faceAnnotationProse(bare)).toEqual([]);
    expect(faceHasAnnotations(bare)).toBe(false);
    expect(faceHasAnnotations(undefined)).toBe(false);
  });
});

describe('faceAnnotationTally — the per-SURFACE counts module-specs publishes', () => {
  it('counts each kind at the source, so no consumer recovers one by subtraction', () => {
    expect(faceAnnotationTally(fixture({ title: 'Voice', hint: 'one bus' } as never))).toEqual({
      title: 1,
      pageHint: 1,
      bandHints: 1,
      total: 3,
    });
  });

  it('THE ARITHMETIC THE OLD PROJECTION USED IS WRONG NOW — and this is why it is gone', () => {
    // `module-specs` published `bandHints: total - pageHint`. On a titled face
    // that over-counts band hints by exactly one, and the e2e sweep would have
    // failed against markup that was correct. Pinned as a REGRESSION so nobody
    // re-derives the cheaper-looking sum.
    const t = faceAnnotationTally(fixture({ title: 'Voice', hint: 'one bus' } as never));
    expect(t.total - t.pageHint, 'the naive sum').toBe(2);
    expect(t.bandHints, 'the truth').toBe(1);
  });

  it('is all zeroes for a face with no prose', () => {
    expect(faceAnnotationTally(undefined)).toEqual({ title: 0, pageHint: 0, bandHints: 0, total: 0 });
  });
});

// ── 2. THE HERO SPLIT (the dangerous operation) ─────────────────────────────

describe('heroFacePlan — PROMOTES a control, never copies it', () => {
  it('a face with no hero is a pass-through, and total', () => {
    const def = fixture();
    const before = bandsOf(def);
    const after = heroFacePlan(def, before);
    expect(after.hero).toBeNull();
    expect(dockPlanControls(after.bands).map((c) => c.key)).toEqual(
      dockPlanControls(before).map((c) => c.key),
    );
    expect(heroFacePlanIsTotal(before, after)).toBe(true);
  });

  it('REMOVES the promoted control from its band (the multiset is conserved)', () => {
    const def = fixture({ hero: { control: 'tune', action: 'fx-strike-{n}' } } as never);
    const before = bandsOf(def);
    const after = heroFacePlan(def, before);

    expect(after.hero?.control?.key).toBe('tune');
    expect(after.hero?.action?.key).toBe('fx-strike-{n}');
    // …and neither is still sitting in a band.
    const remaining = dockPlanControls(after.bands).map((c) => c.key);
    expect(remaining).not.toContain('tune');
    expect(remaining).not.toContain('fx-strike-{n}');
    // The count dropped by exactly the two promoted cells — nothing else moved.
    expect(remaining.length).toBe(dockPlanControls(before).length - 2);
    expect(heroFacePlanIsTotal(before, after)).toBe(true);
  });

  it('can promote a control out of a CLUSTER, and drops the emptied sub-header', () => {
    const def = fixture({ hero: { control: 'mode' } } as never);
    const before = bandsOf(def);
    const after = heroFacePlan(def, before);

    expect(after.hero?.control?.key).toBe('mode');
    const outBand = after.bands.find((b) => b.id === 'out')!;
    expect(outBand.clusters, 'a sub-header over zero cells is a caption for nothing').toEqual([]);
    expect(outBand.controls.map((c) => c.key)).toEqual(['mix']);
    expect(heroFacePlanIsTotal(before, after)).toBe(true);
  });

  it('promotes the module PICTURE (hero.cell) out of its band, and stays total', () => {
    // The picture is the one half of a faceplate that cannot be platform data,
    // so the platform makes room for it instead — same promotion, same
    // conservation. `fx-strike-{n}` stands in for a panel cell here: the split
    // is about KEYS, and a fixture with a real component would prove nothing
    // extra while dragging a Svelte import into a pure unit.
    const def = fixture({ hero: { cell: 'fx-strike-{n}', control: 'tune' } } as never);
    const before = bandsOf(def);
    const after = heroFacePlan(def, before);

    expect(after.hero?.cell?.key).toBe('fx-strike-{n}');
    expect(after.hero?.control?.key).toBe('tune');
    const remaining = dockPlanControls(after.bands).map((c) => c.key);
    expect(remaining).not.toContain('fx-strike-{n}');
    expect(remaining.length).toBe(dockPlanControls(before).length - 2);
    expect(heroFacePlanIsTotal(before, after)).toBe(true);
  });

  it('a key named as BOTH cell and action is promoted ONCE — the cell wins', () => {
    const def = fixture({ hero: { cell: 'fx-strike-{n}', action: 'fx-strike-{n}' } } as never);
    const before = bandsOf(def);
    const after = heroFacePlan(def, before);
    expect(after.hero?.cell?.key).toBe('fx-strike-{n}');
    expect(after.hero?.action, 'the second claim resolves null rather than duplicating').toBeNull();
    expect(heroFacePlanIsTotal(before, after)).toBe(true);
  });

  it('promotes a key named as BOTH control and action exactly ONCE', () => {
    // The duplicate-emit trap: promoting the same key twice would render two
    // `control-tune` testids and read as an unbacked extra control.
    const def = fixture({ hero: { control: 'tune', action: 'tune' } } as never);
    const before = bandsOf(def);
    const after = heroFacePlan(def, before);
    expect(after.hero?.control?.key).toBe('tune');
    expect(after.hero?.action).toBeNull();
    expect(heroFacePlanIsTotal(before, after)).toBe(true);
  });

  it('a STALE hero key resolves to null and changes nothing (the lint is what reddens)', () => {
    const def = fixture({ hero: { control: 'deleted_param' } } as never);
    const before = bandsOf(def);
    const after = heroFacePlan(def, before);
    expect(after.hero).toBeNull();
    expect(heroFacePlanIsTotal(before, after)).toBe(true);
  });

  it('a hero that PROMOTES NOTHING resolves to null — there is no readouts-only hero', () => {
    // ⚠ THIS IS THE INVERSION, AND IT IS WHY THIS TEST REPLACED TWO OTHERS.
    // A hero used to be able to consist of a READOUT STRIP alone — no picture,
    // no promoted control, just a row of labelled derived values. That shape is
    // deleted (owner, 2026-08-19; see ModuleFaceHero in graph/types.ts), so a
    // hero declaring anything other than `cell`/`control`/`action` now paints
    // NOTHING rather than an empty rail. The two tests this replaces asserted
    // the strip rendered and that malformed entries were dropped from it;
    // neither has a subject any more, and asserting the absence here is what
    // keeps a future `readouts`-shaped field from quietly rendering again.
    const def = fixture({ hero: {} } as never);
    const before = bandsOf(def);
    const after = heroFacePlan(def, before);
    expect(after.hero, 'a hero with no promotable key paints no rail').toBeNull();
    expect(dockPlanControls(after.bands).length).toBe(dockPlanControls(before).length);
    expect(heroFacePlanIsTotal(before, after)).toBe(true);
  });

  it('an UNKNOWN hero field is inert — it cannot resurrect the strip', () => {
    // The declaration surface is typed, so this shape is refused by `tsc`; the
    // cast is what a future mechanism would have to do to get past it. Even
    // then the plan must ignore it rather than paint it.
    const def = fixture({
      hero: { readouts: [{ label: 'tail', paramId: 'decay' }] },
    } as never);
    const after = heroFacePlan(def, bandsOf(def));
    expect(after.hero, 'an unrecognised hero field promotes nothing').toBeNull();
    expect(JSON.stringify(after)).not.toContain('tail');
  });

  it('NEGATIVE CONTROL: a split that DROPPED a control fails heroFacePlanIsTotal', () => {
    // Deliberately corrupt the result the way a buggy split would, and confirm
    // the totality check actually notices. Without this the check could be
    // vacuously true and every test above would still pass.
    const def = fixture({ hero: { control: 'tune' } } as never);
    const before = bandsOf(def);
    const after = heroFacePlan(def, before);
    expect(heroFacePlanIsTotal(before, after)).toBe(true);
    expect(heroFacePlanIsTotal(before, { ...after, hero: null })).toBe(false);
  });

  it('NEGATIVE CONTROL: a split that DUPLICATED a control fails it too', () => {
    const def = fixture();
    const before = bandsOf(def);
    const dup = {
      hero: { cell: null, control: before[0]!.controls[0]!, action: null, readouts: [] },
      bands: before,
    };
    expect(heroFacePlanIsTotal(before, dup)).toBe(false);
  });

  // ── THE EMPTIED BAND ──────────────────────────────────────────────────────
  //
  // `withoutKeys` already dropped an emptied CLUSTER — "a sub-header over zero
  // cells is a caption for nothing" — and left the identical defect one level
  // up. Promoting a whole band's contents into the hero left a LABELLED VOID
  // where they were, and on a tabbed face a tab that opens onto nothing. dx7
  // and mixer hit it independently.

  it('DROPS a band the hero emptied — a labelled void is worse than no band', () => {
    const def = {
      params: PARAMS,
      face: {
        order: ['tune', 'mix'],
        hero: { control: 'tune' },
        pages: [
          { id: 'lead', label: 'lead', hint: 'the promoted one', controls: ['tune'] },
          { id: 'out', label: 'out', controls: ['mix'] },
        ],
      },
    } as unknown as FaceplateDefLike;
    const before = bandsOf(def);
    expect(before.map((b) => b.id), 'both bands exist before the split').toEqual(['lead', 'out']);

    const after = heroFacePlan(def, before);
    expect(after.hero?.control?.key).toBe('tune');
    expect(after.bands.map((b) => b.id), "'lead' has nothing left to label").toEqual(['out']);
    expect(
      heroFacePlanIsTotal(before, after),
      'and it is still TOTAL: an empty band contributes zero keys, so dropping it ' +
        'cannot change the multiset',
    ).toBe(true);
  });

  it('KEEPS a band the hero only partly emptied, and one holding a surviving CLUSTER', () => {
    // The control that proves the filter is about EMPTINESS, not about being
    // touched by the hero at all.
    const partly = fixture({ hero: { control: 'tune' } } as never);
    expect(heroFacePlan(partly, bandsOf(partly)).bands.map((b) => b.id)).toEqual(['voice', 'out']);

    // 'out' holds `mix` flat plus a `shape` cluster over `mode`; promote the
    // flat control and the band survives on its cluster alone.
    const clusterOnly = fixture({ hero: { control: 'mix' } } as never);
    const after = heroFacePlan(clusterOnly, bandsOf(clusterOnly));
    const out = after.bands.find((b) => b.id === 'out')!;
    expect(out.controls, 'the flat control was promoted away').toHaveLength(0);
    expect(out.clusters.map((c) => c.label), 'but the cluster keeps the band alive').toEqual(['shape']);
  });

  it('a face with NO hero keeps every band, empty or not (the filter is hero-scoped)', () => {
    // `heroFacePlan` returns early for a face declaring no hero, so a band that
    // is empty for some OTHER reason is untouched — this change must not
    // silently start pruning the plan for faces that never asked for a hero.
    const def = {
      params: PARAMS,
      face: {
        order: ['tune'],
        pages: [
          { id: 'a', label: 'a', controls: ['tune'] },
          { id: 'empty', label: 'empty', controls: [] },
        ],
      },
    } as unknown as FaceplateDefLike;
    const before = bandsOf(def);
    expect(heroFacePlan(def, before).bands).toEqual(before);
  });
});

// ── 3. READOUTS ─────────────────────────────────────────────────────────────

