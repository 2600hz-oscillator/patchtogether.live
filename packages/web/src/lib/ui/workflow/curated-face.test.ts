// packages/web/src/lib/ui/workflow/curated-face.test.ts
//
// Unit tests for the pure curatedFace(def, tier) top-N selector. No registry,
// no fs — hand-built face fixtures exercise the ladder + key resolution.

import { describe, it, expect } from 'vitest';
import {
  curatedFace,
  dockFacePlan,
  dockPlanControls,
  faceTierCap,
  laneOrder,
  resolveFaceControl,
  FACE_TIER_CAPS,
  LANE_PLATE_MAX_CELLS,
  type FaceDefLike,
  type FaceTier,
} from './curated-face';
import {
  laneBodyPlan,
  laneGlyphFor,
  PLATE_COLS,
  PLATE_MAX_ROWS,
  type LaneGlyph,
} from './module-shell-model';

// A def with 10 ranked controls: a mix of params, one family template, and one
// static button — enough to prove the top-N slice at every tier.
const DEF: FaceDefLike = {
  params: [
    { id: 'pitch', label: 'Pitch' },
    { id: 'wave', label: 'Wave' },
    { id: 'cutoff', label: 'Cutoff' },
    { id: 'res', label: 'Resonance' },
    { id: 'attack', label: 'Attack' },
    { id: 'decay', label: 'Decay' },
    { id: 'sustain', label: 'Sustain' },
    { id: 'release', label: 'Release' },
    { id: 'level', label: 'Level' },
  ],
  controlFamilies: [{ id: 'seq-gate' }],
  face: {
    order: [
      'pitch', 'wave', 'cutoff', 'res', 'attack',
      'decay', 'sustain', 'release', 'seq-gate-{n}', 'sh-toggle',
    ],
    glyph: 'scope',
    pages: [
      { id: 'osc', label: 'OSC', controls: ['pitch', 'wave'] },
      { id: 'filter', label: 'FILTER', controls: ['cutoff', 'res'] },
      { id: 'env', label: 'ENV', controls: ['attack', 'decay', 'sustain', 'release'] },
    ],
  },
};

describe('curatedFace — top-N per tier', () => {
  it('mini returns exactly 1 (the hero control)', () => {
    const f = curatedFace(DEF, 'mini')!;
    expect(f.controls).toHaveLength(1);
    expect(f.controls[0].key).toBe('pitch');
  });

  it('compact returns TWO for a glyph-bearing face (the fit-reconciled cap)', () => {
    // DEF declares glyph 'scope', so the compact tile is two whole knob
    // columns + the glyph — laneBodyPlan's LANE_ROW_MAX_CELLS_WITH_GLYPH.
    const f = curatedFace(DEF, 'compact')!;
    expect(f.controls.map((c) => c.key)).toEqual(['pitch', 'wave']);
  });

  it('compact returns THREE when the face has no glyph', () => {
    const noGlyph: FaceDefLike = { ...DEF, face: { ...DEF.face!, glyph: 'none' } };
    expect(curatedFace(noGlyph, 'compact')!.controls.map((c) => c.key)).toEqual([
      'pitch', 'wave', 'cutoff',
    ]);
  });

  it('full returns the first 6 — the 3×2 plate, laneBodyPlan’s no-clip cap', () => {
    // Ranks 7+ are DOCK-ONLY: the full-in-lane plate is 3 columns × 2 whole
    // rows inside the fixed 192×180 tile, so the 8 the ladder used to promise
    // was two cells the shell truncated without telling the face author.
    const f = curatedFace(DEF, 'full')!;
    expect(f.controls).toHaveLength(6);
    expect(f.controls.map((c) => c.key)).toEqual([
      'pitch', 'wave', 'cutoff', 'res', 'attack', 'decay',
    ]);
  });

  it('dock returns ALL controls (order preserved) + resolved pages', () => {
    const f = curatedFace(DEF, 'dock')!;
    expect(f.controls).toHaveLength(DEF.face!.order.length);
    expect(f.controls.map((c) => c.key)).toEqual(DEF.face!.order);
    // pages resolved to descriptors
    expect(f.pages).toBeDefined();
    expect(f.pages!.map((p) => p.id)).toEqual(['osc', 'filter', 'env']);
    expect(f.pages![2].controls.map((c) => c.key)).toEqual([
      'attack', 'decay', 'sustain', 'release',
    ]);
    expect(f.pages![0].controls[0].label).toBe('Pitch');
  });

  it('non-dock tiers do NOT include pages', () => {
    for (const t of ['mini', 'compact', 'full'] as FaceTier[]) {
      expect(curatedFace(DEF, t)!.pages).toBeUndefined();
    }
  });

  it('a face with fewer controls than the cap returns all of them', () => {
    const small: FaceDefLike = {
      params: [{ id: 'gain', label: 'Gain' }],
      face: { order: ['gain'] },
    };
    expect(curatedFace(small, 'full')!.controls.map((c) => c.key)).toEqual(['gain']);
    expect(curatedFace(small, 'compact')!.controls).toHaveLength(1);
  });
});

describe('curatedFace — key resolution + glyph', () => {
  it('resolves a param key to kind=param with its label', () => {
    const c = resolveFaceControl('cutoff', DEF);
    expect(c).toMatchObject({ kind: 'param', paramId: 'cutoff', label: 'Cutoff' });
  });

  it('resolves a `<family>-{n}` template to kind=family, humanizing an unlabeled family', () => {
    const c = resolveFaceControl('seq-gate-{n}', DEF);
    expect(c).toMatchObject({ kind: 'family', familyId: 'seq-gate' });
    expect(c.label).toBe('Seq gate');
  });

  it('prefers the DECLARED ControlFamily label over the humanized id', () => {
    // The label-quality fix: a family cell read "Dx7 preset select" (the raw
    // key echoed back) instead of the authored "Preset / voice selector".
    const labeled: FaceDefLike = {
      controlFamilies: [{ id: 'dx7-preset-select', label: 'Preset / voice selector' }],
      face: { order: ['dx7-preset-select-{n}'] },
    };
    expect(resolveFaceControl('dx7-preset-select-{n}', labeled).label).toBe(
      'Preset / voice selector',
    );
  });

  it('falls back to humanize when the declared label is blank', () => {
    const blank: FaceDefLike = {
      controlFamilies: [{ id: 'step-gate', label: '  ' }],
      face: { order: ['step-gate-{n}'] },
    };
    expect(resolveFaceControl('step-gate-{n}', blank).label).toBe('Step gate');
  });

  it('resolves an unknown key to kind=static with a humanized label', () => {
    const c = resolveFaceControl('sh-toggle', DEF);
    expect(c).toMatchObject({ kind: 'static' });
    expect(c.label).toBe('Sh toggle');
    expect(c.paramId).toBeUndefined();
    expect(c.familyId).toBeUndefined();
  });

  it('a `-{n}` template whose prefix is NOT a declared family falls back to static', () => {
    const c = resolveFaceControl('ghost-{n}', DEF);
    expect(c.kind).toBe('static');
  });

  it('resolves glyph, defaulting to none when unset', () => {
    expect(curatedFace(DEF, 'compact')!.glyph).toBe('scope');
    const noGlyph: FaceDefLike = { params: [{ id: 'x', label: 'X' }], face: { order: ['x'] } };
    expect(curatedFace(noGlyph, 'mini')!.glyph).toBe('none');
  });
});

describe('ModuleFacePage.clusters — the front-side mirror of the rear card’s', () => {
  // A cluster costs a ~14px sub-header where a second page band costs ~81px
  // (rule + header + row + the .dock-pages gap). It GROUPS keys the page
  // already claims — membership never moves out of page.controls, which is
  // what keeps face.order completeness + the dock parity gate reading one list.
  const CLUSTERED: FaceDefLike = {
    params: [
      { id: 'fatk', label: 'F.A' }, { id: 'fdec', label: 'F.D' },
      { id: 'atk', label: 'A' }, { id: 'dec', label: 'D' },
      { id: 'level', label: 'Level' },
    ],
    face: {
      order: ['fatk', 'fdec', 'atk', 'dec', 'level'],
      pages: [
        {
          id: 'envelopes',
          label: 'envelopes',
          controls: ['level', 'fatk', 'fdec', 'atk', 'dec'],
          clusters: [
            { label: 'filter eg', controls: ['fatk', 'fdec'] },
            { label: 'amp eg', controls: ['atk', 'dec'] },
          ],
        },
      ],
    },
  };

  it('PULLS the clustered cells out of the flat row, leaving the rest first', () => {
    const page = curatedFace(CLUSTERED, 'dock')!.pages![0];
    expect(page.controls.map((c) => c.key), 'un-clustered cells render first').toEqual(['level']);
    expect(page.clusters.map((c) => c.label)).toEqual(['filter eg', 'amp eg']);
    expect(page.clusters[0].controls.map((c) => c.key)).toEqual(['fatk', 'fdec']);
    expect(page.clusters[1].controls.map((c) => c.key)).toEqual(['atk', 'dec']);
  });

  it('dockPlanControls still yields EVERY control exactly once', () => {
    // The invariant the render-parity gate reads: clustering is a layout move,
    // never a membership change. A flattening that forgot band.clusters would
    // report `fatk` as dropped from the dock.
    const flat = dockPlanControls(dockFacePlan(CLUSTERED)!).map((c) => c.key);
    expect(flat.slice().sort()).toEqual(['atk', 'dec', 'fatk', 'fdec', 'level']);
    expect(new Set(flat).size).toBe(flat.length);
  });

  it('ignores a cluster key the page does not claim (it cannot ADD a control)', () => {
    const bad: FaceDefLike = {
      params: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      face: {
        order: ['a', 'b'],
        pages: [{ id: 'p', label: 'P', controls: ['a'], clusters: [{ label: 'x', controls: ['a', 'b'] }] }],
      },
    };
    const band = dockFacePlan(bad)!.find((x) => x.id === 'p')!;
    expect(band.clusters[0].controls.map((c) => c.key), 'only the claimed key').toEqual(['a']);
    // `b` is ranked but unpaged, so the defensive tail still sweeps it up.
    expect(dockPlanControls(dockFacePlan(bad)!).map((c) => c.key).sort()).toEqual(['a', 'b']);
  });

  it('a page-less / cluster-less face keeps an empty clusters array (no undefined)', () => {
    const plain = dockFacePlan(DEF)!;
    for (const band of plain) expect(band.clusters).toEqual([]);
  });
});

describe('curatedFace — un-faced module', () => {
  it('returns null when the def has no face (un-migrated → placeholder)', () => {
    expect(curatedFace({ params: [{ id: 'x', label: 'X' }] }, 'compact')).toBeNull();
  });
});

describe('PF-22 — a HERO PICTURE takes no LANE rank', () => {
  // The floor this removes: a PF-14 panel cannot render in a 46px lane knob
  // column, so `module-face-lint` refuses one SELECTED at a lane tier — and the
  // 'full' lane cap is six, so a panel's first legal rank was SEVEN. A module
  // with fewer than six other rankable keys could therefore never have a
  // picture at all (kria: three keys; meowbox: five), and one that could ranked
  // its HERO dead last to satisfy the arithmetic (bluebox: thirteenth of
  // thirteen). Ranking said "priority" and meant "lane budget".
  //
  // `hero` is DOCK-ONLY by declaration, so the picture is simply not offered to
  // a lane. The 46px protection is untouched — it is asserted, against this same
  // exclusion, in module-face-lint's panel negative control.

  const PANEL = 'pic-{n}';
  const withHeroPicture: FaceDefLike = {
    params: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ],
    controlFamilies: [{ id: 'pic', label: 'Picture' }],
    face: { order: [PANEL, 'a', 'b'], glyph: 'none', hero: { cell: PANEL } },
  };

  it('laneOrder drops the hero cell and nothing else, order preserved', () => {
    expect(laneOrder(withHeroPicture.face!)).toEqual(['a', 'b']);
  });

  it('a face with no hero, or a hero with no `cell`, is passed through UNCHANGED', () => {
    // The clause that would rot first: if `laneOrder` filtered on anything
    // broader than `hero.cell`, every face in the registry would quietly lose a
    // lane control. `hero.control` PROMOTES a knob and that knob still paints
    // in the lane, so it must survive.
    const noHero: FaceDefLike = { ...withHeroPicture, face: { order: [PANEL, 'a', 'b'] } };
    expect(laneOrder(noHero.face!)).toEqual([PANEL, 'a', 'b']);
    const controlOnly: FaceDefLike = {
      ...withHeroPicture,
      face: { order: ['a', 'b'], hero: { control: 'a' } },
    };
    expect(laneOrder(controlOnly.face!)).toEqual(['a', 'b']);
  });

  it('the picture ranks FIRST and the lane still paints the real controls', () => {
    // Rank 1 — the honest priority for a module whose picture IS the module —
    // and mini (cap 1) shows 'a', not the panel.
    expect(curatedFace(withHeroPicture, 'mini')!.controls.map((c) => c.key)).toEqual(['a']);
    expect(curatedFace(withHeroPicture, 'compact')!.controls.map((c) => c.key)).toEqual(['a', 'b']);
    expect(curatedFace(withHeroPicture, 'full')!.controls.map((c) => c.key)).toEqual(['a', 'b']);
  });

  it('…and the DOCK still gets it — the dock is where the picture renders', () => {
    expect(curatedFace(withHeroPicture, 'dock')!.controls.map((c) => c.key)).toEqual([
      PANEL,
      'a',
      'b',
    ]);
    // The dock PLAN must keep it too, or `heroFacePlan` has nothing to promote
    // and the hero rail renders empty.
    expect(dockPlanControls(dockFacePlan(withHeroPicture) ?? []).map((c) => c.key)).toContain(PANEL);
  });

  it('a hero picture ranked LATE changes the lane by nothing (the shipped case)', () => {
    // Every `hero.cell` on `main` already ranks at 7+ — it had to, or it would
    // be failing the lint — and dropping an item at index >= the cap cannot
    // change the prefix. This is the property that makes the change a no-op for
    // every face that exists, asserted rather than asserted-about.
    const late: FaceDefLike = {
      ...DEF,
      face: { ...DEF.face!, order: [...DEF.face!.order, PANEL], hero: { cell: PANEL } },
    };
    for (const tier of ['mini', 'compact', 'full'] as FaceTier[]) {
      expect(
        curatedFace(late, tier)!.controls.map((c) => c.key),
        `${tier}: a rank-11 hero picture must not move the lane's first cells`,
      ).toEqual(curatedFace(DEF, tier)!.controls.map((c) => c.key));
    }
  });
});

describe('FACE_TIER_CAPS ladder', () => {
  it('is mini=1 / compact=3 (the glyph-less ceiling) / full=6 (the plate) / dock=all', () => {
    expect(FACE_TIER_CAPS.mini).toBe(1);
    expect(FACE_TIER_CAPS.compact).toBe(3);
    expect(FACE_TIER_CAPS.full).toBe(6);
    expect(FACE_TIER_CAPS.dock).toBe(Infinity);
  });

  it('full is DERIVED from the plate geometry, never a hand-typed number', () => {
    // If PLATE_COLS/PLATE_MAX_ROWS ever move, the cap must move with them —
    // that is the whole point of reconciling the ladder with the fit plan.
    expect(LANE_PLATE_MAX_CELLS).toBe(PLATE_COLS * PLATE_MAX_ROWS);
    expect(FACE_TIER_CAPS.full).toBe(LANE_PLATE_MAX_CELLS);
  });
});

describe('faceTierCap — the cap RECONCILED with the lane fit plan', () => {
  // The authored-intent mismatch this closes, in both lane tiers:
  // FACE_TIER_CAPS.compact = 3 while laneBodyPlan renders only 2 next to a
  // glyph (six faces documented a 3-control compact tile the shell could never
  // render), and FACE_TIER_CAPS.full = 8 while the 3×2 plate renders 6 (every
  // face's ranks 7-8 were authored as in-lane and silently truncated). The caps
  // now FOLLOW the plan, and this test pins them together.
  it('compact = 2 with a glyph, 3 without; full = 6 either way; others are the ladder', () => {
    expect(faceTierCap('compact', 'trace')).toBe(2);
    expect(faceTierCap('compact', 'none')).toBe(3);
    expect(faceTierCap('full', 'trace')).toBe(6);
    expect(faceTierCap('full', 'none')).toBe(6);
    for (const t of ['mini', 'full', 'dock'] as FaceTier[]) {
      for (const g of ['trace', 'none'] as LaneGlyph[]) {
        expect(faceTierCap(t, g)).toBe(FACE_TIER_CAPS[t]);
      }
    }
  });

  it('SELECTED count === RENDERED count at EVERY lane tier, for EVERY glyph kind', () => {
    // ⚠ THE THIRD CASE IS THE ONE THAT WAS MISSING (#1785). While this loop ran
    // only the two DECLARED glyph states it could not reach a video def at all,
    // and a video def is precisely where the selector's predicate and the
    // shell's disagreed — `domain: 'video'` + `glyph: 'none'` renders a live
    // picture the declaration cannot mention. The case is driven off the SAME
    // `laneGlyphFor` the shell reads, so a def can only be in one of them.
    const cases: Array<{ label: string; def: FaceDefLike }> = [
      { label: 'trace', def: { ...DEF, face: { ...DEF.face!, glyph: 'scope' } } },
      { label: 'none', def: { ...DEF, face: { ...DEF.face!, glyph: 'none' } } },
      {
        label: 'picture',
        def: { ...DEF, domain: 'video', face: { ...DEF.face!, glyph: 'none' } },
      },
    ];
    for (const { label, def } of cases) {
      expect(laneGlyphFor(def), `${label}: the case is what it says it is`).toBe(label);
      for (const tier of ['mini', 'compact', 'full'] as FaceTier[]) {
        const face = curatedFace(def, tier)!;
        const selected = face.controls.length;
        expect(
          laneBodyPlan(face.cellHeights, laneGlyphFor(def), tier).cellCount,
          `${tier} (glyph=${label}): selected ${selected}`,
        ).toBe(selected);
      }
    }
  });
});
