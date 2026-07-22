// packages/web/src/lib/ui/workflow/curated-face.test.ts
//
// Unit tests for the pure curatedFace(def, tier) top-N selector. No registry,
// no fs — hand-built face fixtures exercise the ladder + key resolution.

import { describe, it, expect } from 'vitest';
import {
  curatedFace,
  resolveFaceControl,
  FACE_TIER_CAPS,
  type FaceDefLike,
  type FaceTier,
} from './curated-face';

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

  it('compact returns exactly 3, in ranked order', () => {
    const f = curatedFace(DEF, 'compact')!;
    expect(f.controls.map((c) => c.key)).toEqual(['pitch', 'wave', 'cutoff']);
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

  it('resolves a `<family>-{n}` template to kind=family', () => {
    const c = resolveFaceControl('seq-gate-{n}', DEF);
    expect(c).toMatchObject({ kind: 'family', familyId: 'seq-gate' });
    expect(c.label).toBe('Seq gate');
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
  it('is mini=1 / compact=3 / full=8 / dock=all', () => {
    expect(FACE_TIER_CAPS.mini).toBe(1);
    expect(FACE_TIER_CAPS.compact).toBe(3);
    expect(FACE_TIER_CAPS.full).toBe(8);
    expect(FACE_TIER_CAPS.dock).toBe(Infinity);
  });
});
