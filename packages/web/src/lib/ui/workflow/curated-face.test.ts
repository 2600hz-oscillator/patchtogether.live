// packages/web/src/lib/ui/workflow/curated-face.test.ts
//
// Unit tests for the pure curatedFace(def, tier) top-N selector. No registry,
// no fs — hand-built face fixtures exercise the ladder + key resolution.

import { describe, it, expect } from 'vitest';
import {
  curatedFace,
  faceTierCap,
  resolveFaceControl,
  FACE_TIER_CAPS,
  type FaceDefLike,
  type FaceTier,
} from './curated-face';
import { laneBodyPlan } from './module-shell-model';

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

  it('full returns the first 8', () => {
    const f = curatedFace(DEF, 'full')!;
    expect(f.controls).toHaveLength(8);
    expect(f.controls.map((c) => c.key)).toEqual([
      'pitch', 'wave', 'cutoff', 'res', 'attack', 'decay', 'sustain', 'release',
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

describe('curatedFace — un-faced module', () => {
  it('returns null when the def has no face (un-migrated → placeholder)', () => {
    expect(curatedFace({ params: [{ id: 'x', label: 'X' }] }, 'compact')).toBeNull();
  });
});

describe('FACE_TIER_CAPS ladder', () => {
  it('is mini=1 / compact=3 (the glyph-less ceiling) / full=8 / dock=all', () => {
    expect(FACE_TIER_CAPS.mini).toBe(1);
    expect(FACE_TIER_CAPS.compact).toBe(3);
    expect(FACE_TIER_CAPS.full).toBe(8);
    expect(FACE_TIER_CAPS.dock).toBe(Infinity);
  });
});

describe('faceTierCap — the cap RECONCILED with the lane fit plan', () => {
  // The authored-intent mismatch this closes: FACE_TIER_CAPS.compact = 3 while
  // laneBodyPlan renders only 2 next to a glyph, so six faces documented a
  // 3-control compact tile the shell could never render. The cap now FOLLOWS
  // the plan, and this test pins them together.
  it('compact = 2 with a glyph, 3 without; every other tier is the plain ladder', () => {
    expect(faceTierCap('compact', true)).toBe(2);
    expect(faceTierCap('compact', false)).toBe(3);
    for (const t of ['mini', 'full', 'dock'] as FaceTier[]) {
      for (const g of [true, false]) expect(faceTierCap(t, g)).toBe(FACE_TIER_CAPS[t]);
    }
  });

  it('SELECTED count === RENDERED count at compact, for both glyph cases', () => {
    for (const hasGlyph of [true, false]) {
      const def: FaceDefLike = {
        ...DEF,
        face: { ...DEF.face!, glyph: hasGlyph ? 'scope' : 'none' },
      };
      const selected = curatedFace(def, 'compact')!.controls.length;
      expect(laneBodyPlan(selected, hasGlyph, 'compact').cellCount).toBe(selected);
    }
  });
});
