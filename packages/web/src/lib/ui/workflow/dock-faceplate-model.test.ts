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
import type { FaceSidebarBlock, ParamDef } from '$lib/graph/types';
import { dockFacePlan, dockPlanControls, type DockFaceBand, type FaceDefLike } from './curated-face';
import {
  activePresetId,
  bandHeaderPlan,
  faceAnnotationProse,
  faceAnnotationTally,
  faceAnnotations,
  faceHasAnnotations,
  facePageHeader,
  heroFacePlan,
  heroFacePlanIsTotal,
  isUsableReadout,
  presetNote,
  presetRowStates,
  presetValueMatches,
  presetWrites,
  readoutText,
  recalledPresetId,
  sidebarPlan,
  FACE_PRESET_DATA_KEY,
  PRESET_MATCH_REL,
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

  it('a hero of READOUTS ALONE still renders, and moves no control', () => {
    const def = fixture({ hero: { readouts: [{ label: 'tail', paramId: 'decay' }] } } as never);
    const before = bandsOf(def);
    const after = heroFacePlan(def, before);
    expect(after.hero?.control).toBeNull();
    expect(after.hero?.readouts).toHaveLength(1);
    expect(dockPlanControls(after.bands).length).toBe(dockPlanControls(before).length);
    expect(heroFacePlanIsTotal(before, after)).toBe(true);
  });

  it('drops MALFORMED readouts rather than painting a caption over a blank', () => {
    const def = fixture({
      hero: {
        readouts: [
          { label: 'ok', paramId: 'tune' },
          { label: 'both', paramId: 'tune', text: '5' },
          { label: 'neither' },
        ],
      },
    } as never);
    expect(heroFacePlan(def, bandsOf(def)).hero?.readouts.map((r) => r.label)).toEqual(['ok']);
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

describe('readoutText — one ladder for the panel and the dial', () => {
  const read = (pid: string) => ({ tune: 50, decay: 450, mix: 0.5, mode: 2 })[pid];

  it('prints a literal `text` readout verbatim', () => {
    expect(readoutText({ label: 't', text: '≈ 480 ms' }, PARAMS, read)).toBe('≈ 480 ms');
  });

  it('prints a param through the SAME ladder the dial prints (units included)', () => {
    expect(readoutText({ label: 't', paramId: 'tune' }, PARAMS, read)).toBe('50.0 Hz');
    expect(readoutText({ label: 't', paramId: 'decay' }, PARAMS, read)).toBe('450 ms');
  });

  it('prints the option NAME for a param that declared one, never the number', () => {
    expect(readoutText({ label: 'm', paramId: 'mode' }, PARAMS, read)).toBe('BP');
  });

  it('prints an em dash rather than `undefined` for an unresolvable source', () => {
    expect(readoutText({ label: 'x', paramId: 'gone' }, PARAMS, read)).toBe('—');
    expect(readoutText({ label: 'x' }, PARAMS, read)).toBe('—');
    expect(readoutText({ label: 'x', paramId: 'tune' }, PARAMS, () => NaN)).toBe('—');
  });

  it('isUsableReadout demands EXACTLY one of the THREE sources', () => {
    expect(isUsableReadout({ label: 'a', paramId: 'tune' })).toBe(true);
    expect(isUsableReadout({ label: 'a', text: 'x' })).toBe(true);
    expect(isUsableReadout({ label: 'a', valueId: 'kickdrum-tail' })).toBe(true);
    expect(isUsableReadout({ label: 'a', paramId: 'tune', text: 'x' })).toBe(false);
    expect(isUsableReadout({ label: 'a', paramId: 'tune', valueId: 'kickdrum-tail' })).toBe(false);
    expect(isUsableReadout({ label: 'a', valueId: 'kickdrum-tail', text: 'x' })).toBe(false);
    expect(isUsableReadout({ label: 'a' })).toBe(false);
  });

  // ── the DERIVED source, and why it exists ────────────────────────────────
  //
  // A readout is not always a knob relabelled. `valueId` is what lets a face
  // print a quantity that no single param carries, and the registry keeps the
  // def declaring a STRING rather than importing a function.

  it('resolves a registered valueId through the SAME param reader', () => {
    // kickdrum's tail at the def defaults is 398 ms — NOT the 450 ms `sub_decay`
    // knob. Reading defaults (the reader returns undefined for everything) is
    // the case a faceplate actually renders on a freshly spawned node.
    expect(readoutText({ label: 'tail', valueId: 'kickdrum-tail' }, PARAMS, () => undefined)).toBe(
      '398 ms',
    );
  });

  it('NEGATIVE CONTROL: the derived tail moves on a LEVEL change — a knob readback would not', () => {
    // This is the assertion that distinguishes a derived readout from
    // `{ paramId: 'sub_decay' }`. A time-only perturbation cannot: BOTH models
    // move when SUB DEC moves. Halving SUB LEVEL is the input the blind model
    // is structurally invariant to.
    const at = (over: Record<string, number>): string =>
      readoutText({ label: 'tail', valueId: 'kickdrum-tail' }, PARAMS, (pid) => over[pid]);
    const base = at({});
    expect(at({ sub_level: 0.2 }), `LEVEL must move the tail (base ${base})`).not.toBe(base);
    expect(at({ sub_decay: 800 }), 'and so must TIME, obviously').not.toBe(base);
  });

  it('an UNREGISTERED valueId prints an em dash — the lint is what reddens', () => {
    expect(readoutText({ label: 'x', valueId: 'no-such-value' }, PARAMS, () => undefined)).toBe('—');
  });
});

// ── 4. THE SIDEBAR PLAN ─────────────────────────────────────────────────────

describe('sidebarPlan — an EMPTY block is worse than no block', () => {
  const withSidebar = (sidebar: FaceSidebarBlock[]) => fixture({ sidebar } as never);

  it('is null for a face with no sidebar, so the editor keeps its full width', () => {
    expect(sidebarPlan(fixture())).toBeNull();
  });

  it('drops every kind of empty block, and returns null when NONE survive', () => {
    const def = withSidebar([
      { kind: 'presets', label: 'p', entries: [] },
      { kind: 'readouts', label: 'r', entries: [{ label: 'bad' }] },
      { kind: 'custom', label: 'c', panelId: '  ' },
    ]);
    expect(sidebarPlan(def)).toBeNull();
  });

  it('keeps the blocks that will actually paint, in declaration order', () => {
    const def = withSidebar([
      { kind: 'presets', label: 'p', entries: [] },
      { kind: 'readouts', label: 'r', entries: [{ label: 'bad' }, { label: 'good', paramId: 'tune' }] },
      { kind: 'custom', label: 'c', panelId: 'stereo-crossover' },
      { kind: 'presets', label: 'p2', entries: [{ id: 'a', label: 'A', values: { tune: 50 } }] },
    ]);
    expect(sidebarPlan(def)!.map((b) => b.kind)).toEqual(['readouts', 'custom', 'presets']);
  });
});

// ── 5. PRESETS ──────────────────────────────────────────────────────────────

describe('preset selection', () => {
  const ENTRIES: { id: string; values: Readonly<Record<string, number>> }[] = [
    { id: 'deep', values: { tune: 50, decay: 620 } },
    { id: 'punch', values: { tune: 55, decay: 320 } },
    { id: 'empty', values: {} },
  ];

  it('lights the entry the module is actually sitting on', () => {
    expect(activePresetId(ENTRIES, (p) => ({ tune: 50, decay: 620 })[p])).toBe('deep');
    expect(activePresetId(ENTRIES, (p) => ({ tune: 55, decay: 320 })[p])).toBe('punch');
  });

  it('lights NOTHING once a knob moves off the preset (no stale lit row)', () => {
    expect(activePresetId(ENTRIES, (p) => ({ tune: 50, decay: 610 })[p])).toBeNull();
  });

  it('never lights an entry that declares no values', () => {
    expect(activePresetId([{ id: 'empty', values: {} }], () => 0)).toBeNull();
  });

  it('an unreadable param never matches', () => {
    expect(activePresetId(ENTRIES, () => undefined)).toBeNull();
  });

  it('tolerance is RELATIVE, so one entry can span Hz and a 0..1 mix', () => {
    // Same relative slack at both magnitudes: inside passes, outside fails.
    expect(presetValueMatches(50 * (1 + PRESET_MATCH_REL * 0.5), 50)).toBe(true);
    expect(presetValueMatches(50 * (1 + PRESET_MATCH_REL * 3), 50)).toBe(false);
    expect(presetValueMatches(0.42 * (1 + PRESET_MATCH_REL * 0.5), 0.42)).toBe(true);
    expect(presetValueMatches(0.42 * (1 + PRESET_MATCH_REL * 3), 0.42)).toBe(false);
    // …and an exact-zero target stays comparable via the floor.
    expect(presetValueMatches(0, 0)).toBe(true);
    expect(presetValueMatches(0.01, 0)).toBe(false);
  });

  it('presetWrites CLAMPS to the declared range and DROPS unknown params', () => {
    expect(presetWrites({ tune: 999, mix: -3, ghost: 1 }, PARAMS)).toEqual([
      { paramId: 'tune', value: 120 },
      { paramId: 'mix', value: 0 },
    ]);
  });

  it('presetWrites drops a non-finite value rather than writing NaN into the model', () => {
    expect(presetWrites({ tune: Number.NaN }, PARAMS)).toEqual([]);
  });

  it('presetNote prints the declared note, trimmed, else nothing', () => {
    expect(presetNote({ note: ' 50 Hz ' })).toBe('50 Hz');
    expect(presetNote({})).toBe('');
  });
});

// ── 6. PRESET ROW STATE — lit AND modified, because one fact is not enough ──
//
// The owner arbitrated this: the row STAYS LIT after a knob move and carries a
// MODIFIED marker. Both alternatives are wrong in one direction — un-lighting
// throws away where the sound came from, staying silently lit asserts a voice
// the patch no longer is — so the model returns both facts and the tests pin
// both. A test that only checked `lit` would pass on the "stays lit forever"
// bug this design exists to avoid.

describe('presetRowStates — provenance AND honesty', () => {
  const ENTRIES: { id: string; values: Readonly<Record<string, number>> }[] = [
    { id: 'deep', values: { tune: 50, decay: 620 } },
    { id: 'punch', values: { tune: 55, decay: 320 } },
  ];
  const at = (v: Record<string, number>) => (p: string) => v[p];

  it('with nothing recalled, an exact VALUE match lights (a patch loaded onto a preset)', () => {
    const rows = presetRowStates(ENTRIES, null, at({ tune: 50, decay: 620 }));
    expect(rows).toEqual([
      { id: 'deep', lit: true, modified: false },
      { id: 'punch', lit: false, modified: false },
    ]);
  });

  it('with nothing recalled and no match, NOTHING is lit', () => {
    const rows = presetRowStates(ENTRIES, null, at({ tune: 44, decay: 620 }));
    expect(rows.every((r) => !r.lit && !r.modified)).toBe(true);
  });

  it('a RECALLED row whose values still match is lit and NOT modified', () => {
    expect(presetRowStates(ENTRIES, 'punch', at({ tune: 55, decay: 320 }))[1]).toEqual({
      id: 'punch',
      lit: true,
      modified: false,
    });
  });

  it('THE DECISION: editing off a recalled preset keeps it LIT and marks it MODIFIED', () => {
    const rows = presetRowStates(ENTRIES, 'punch', at({ tune: 44, decay: 320 }));
    expect(rows[1], 'the row that was recalled').toEqual({
      id: 'punch',
      lit: true,
      modified: true,
    });
    expect(rows[0]!.lit, 'and no other row lights up in its place').toBe(false);
  });

  it('exactly ONE row is ever lit, in every combination above', () => {
    for (const [recalled, vals] of [
      [null, { tune: 50, decay: 620 }],
      ['punch', { tune: 55, decay: 320 }],
      ['punch', { tune: 44, decay: 320 }],
      ['deep', { tune: 55, decay: 320 }],
    ] as const) {
      const lit = presetRowStates(ENTRIES, recalled, at(vals as Record<string, number>)).filter(
        (r) => r.lit,
      );
      expect(lit.length, `recalled=${recalled} values=${JSON.stringify(vals)}`).toBeLessThanOrEqual(1);
    }
  });

  it('NEGATIVE CONTROL: a row is never modified while it is not lit', () => {
    // The failure this rules out is a marker that tracks "has anything been
    // edited" globally rather than "this row's values have moved" — which would
    // paint MODIFIED beside four presets nobody recalled.
    const rows = presetRowStates(ENTRIES, 'punch', at({ tune: 44, decay: 320 }));
    for (const r of rows) if (!r.lit) expect(r.modified).toBe(false);
  });

  it('recalledPresetId rejects a STALE id — a removed preset must not light a ghost row', () => {
    expect(recalledPresetId(ENTRIES, { [FACE_PRESET_DATA_KEY]: 'punch' })).toBe('punch');
    expect(recalledPresetId(ENTRIES, { [FACE_PRESET_DATA_KEY]: 'deleted-in-a-later-build' })).toBeNull();
    expect(recalledPresetId(ENTRIES, { [FACE_PRESET_DATA_KEY]: 7 })).toBeNull();
    expect(recalledPresetId(ENTRIES, undefined)).toBeNull();
  });
});
