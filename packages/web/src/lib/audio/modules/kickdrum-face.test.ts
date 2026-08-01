// packages/web/src/lib/audio/modules/kickdrum-face.test.ts
//
// The PIN for KICK DRUM's curated face — the design decisions, projected
// through the same PURE selectors the shell renders from (`curatedFace`,
// `dockFacePlan`, `paramCellKind`, `shellCellFor`), so a later edit that
// undoes one of them fails HERE rather than in a screenshot.
//
// The registry-wide gates (module-face-lint, faces-parity) prove the face is
// WELL-FORMED — every param ranked, every cell operable, nothing rendered
// twice. They are structurally blind to whether it is the RIGHT shape: the
// tier ladder, the band story, and the two rules this module's face is built
// on (ranks 7+ never reach a lane; `level` is a saturation lever, not a fader)
// are all invisible to them. That is what this file holds.
//
// ⚠ NOT a restatement of the def. Every assertion below runs the def through a
// selector and checks the RESULT, so it fails on a change to the face OR to
// the selector semantics — the two-sided contract. `expect(order).toEqual([…])`
// would only have proved the file parses.

import { describe, it, expect } from 'vitest';

import { kickdrumDef } from './kickdrum';
import {
  curatedFace,
  dockFacePlan,
  dockPlanControls,
  faceTierCap,
  LANE_PLATE_MAX_CELLS,
  type FaceDefLike,
} from '$lib/ui/workflow/curated-face';
import { paramCellKind, momentaryParamIds } from '$lib/ui/workflow/shell-control-kind';
import { shellCellFor } from '$lib/ui/workflow/shell-cells';
import { laneBodyPlan } from '$lib/ui/workflow/module-shell-model';

const def = kickdrumDef as unknown as FaceDefLike;

/** The control KEYS a tier surfaces, in rank order. */
function keysAt(tier: 'mini' | 'compact' | 'full' | 'dock'): string[] {
  return (curatedFace(def, tier)?.controls ?? []).map((c) => c.key);
}

describe('kickdrum face — the tier ladder (order = PRIORITY)', () => {
  it('mini shows TUNE alone: nothing about a kick is knowable before its pitch', () => {
    expect(keysAt('mini')).toEqual(['tune']);
  });

  it('compact adds SUB DEC beside the glyph — pitch, then pulse LENGTH', () => {
    const face = curatedFace(def, 'compact')!;
    expect(face.glyph, 'the compact tile keeps its live trace').toBe('scope');
    expect(faceTierCap('compact', true), 'a glyph-bearing compact tile fits two whole cells').toBe(2);
    expect(keysAt('compact')).toEqual(['tune', 'sub_decay']);
  });

  it('the plate is SIX cells and that is the WHOLE lane budget — rank 7+ reaches no lane tier', () => {
    const full = keysAt('full');
    expect(full).toEqual(['tune', 'sub_decay', 'drive', 'pitch_amt', 'body_level', 'click_level']);
    expect(full.length).toBe(LANE_PLATE_MAX_CELLS);

    // The claim that makes rank 7 dock-only, checked against the FIT PLAN
    // rather than restated: the plate renders exactly what the cap selects.
    const plan = laneBodyPlan(full.length, true, 'full');
    expect(plan.cellCount, 'the plate paints every selected cell (no silent truncation)').toBe(6);
    expect(plan.glyph, 'a ≥4-cell face needs both plate rows, so the glyph drops at this tier').toBe(false);

    // …and every rank past 6 is absent from EVERY lane tier.
    const tail = (kickdrumDef.face!.order as readonly string[]).slice(LANE_PLATE_MAX_CELLS);
    for (const tier of ['mini', 'compact', 'full'] as const) {
      const shown = new Set(keysAt(tier));
      for (const key of tail) {
        expect(shown.has(key), `${key} must not reach the '${tier}' lane tier`).toBe(false);
      }
    }
  });

  it('LEVEL is DOCK-ONLY on purpose — it is applied before the ceiling, so it is a saturation lever', () => {
    expect(keysAt('full')).not.toContain('level');
    expect(keysAt('dock')).toContain('level');
    // The reason is documented, not folklore — the doc gate keeps the prose
    // honest, so pin that the two agree.
    expect(kickdrumDef.docs!.controls!.level).toMatch(/applied BEFORE the ceiling/);
  });

  it('the audition ranks 7th: first rank that cannot reach a lane, and a BUTTON has no lane precedent', () => {
    const order = kickdrumDef.face!.order as readonly string[];
    expect(order[LANE_PLATE_MAX_CELLS]).toBe('kickdrum-strike-{n}');
  });
});

describe('kickdrum face — the dock bands (pages = FUNCTION)', () => {
  const plan = dockFacePlan(def)!;

  it('renders FIVE bands, in signal order, with no defensive __unpaged tail', () => {
    expect(plan.map((b) => b.id)).toEqual(['sub', 'body', 'click', 'drive', 'dynamics']);
    expect(plan.map((b) => b.label)).toEqual([
      'strike · the pulse',
      'body · the punch',
      'click · the edge',
      'drive · character',
      'dynamics · out',
    ]);
  });

  it('band 1 LEADS with the audition — the dock pane cuts off ~2 bands down, so it cannot be buried', () => {
    const first = plan[0]!;
    expect(first.controls[0]!.key).toBe('kickdrum-strike-{n}');
    expect(first.controls[0]!.kind).toBe('family');
    expect(first.controls.slice(1).map((c) => c.key)).toEqual([
      'tune', 'sub_decay', 'sub_level', 'sub_eq', 'translate',
    ]);
  });

  it('the merged dynamics·out band carries its split as CLUSTERS, not as a sixth band', () => {
    const dyn = plan[4]!;
    expect(dyn.controls, 'every cell is claimed by a cluster').toEqual([]);
    expect(dyn.clusters.map((c) => c.label)).toEqual(['transient · glue', 'stereo · out']);
    expect(dyn.clusters[0]!.controls.map((c) => c.key)).toEqual(['attack', 'sustain', 'glue', 'ceiling']);
    expect(dyn.clusters[1]!.controls.map((c) => c.key)).toEqual(['width', 'level']);
  });

  it('each band-EQ stays with the LAYER it shapes (the face’s best existing idea)', () => {
    const bandOf = (key: string) =>
      plan.find((b) => dockPlanControls([b]).some((c) => c.key === key))?.id;
    expect(bandOf('sub_eq')).toBe('sub');
    expect(bandOf('body_eq')).toBe('body');
    expect(bandOf('attack_eq')).toBe('click');
    // …and TRANSLATE is a SUB control: it taps a copy of the raw sub layer
    // pre-drive and reconstructs its harmonics.
    expect(bandOf('translate')).toBe('sub');
  });

  it('the dock paints all 26 cells: 25 params + the audition, each exactly once', () => {
    const flat = dockPlanControls(plan);
    expect(flat).toHaveLength(kickdrumDef.params.length + 1);
    expect(new Set(flat.map((c) => c.key)).size).toBe(flat.length);
    expect(flat.filter((c) => c.kind === 'param')).toHaveLength(kickdrumDef.params.length);
  });

  it('NO page id collides with the curated REAR group id (that band would render TWICE)', () => {
    const groupIds = new Set((kickdrumDef.face!.rear!.groups ?? []).map((g) => g.id));
    for (const b of plan) {
      expect(groupIds.has(b.id), `page '${b.id}' collides with a curated rear group id`).toBe(false);
    }
  });
});

describe('kickdrum face — the primitives each cell resolves to', () => {
  const momentary = momentaryParamIds(kickdrumDef);

  it('HARD paints a <Toggle>, not a rotary printing 0.00 — at BOTH the dock and the lane', () => {
    const hard = kickdrumDef.params.find((p) => p.id === 'hard')!;
    expect(paramCellKind(hard, momentary, 'dock')).toBe('toggle');
    expect(paramCellKind(hard, momentary, 'lane')).toBe('toggle');
  });

  it('every other param stays a knob — this voice declares no momentary pad and no grid', () => {
    expect(kickdrumDef.face!.momentary ?? []).toEqual([]);
    expect(kickdrumDef.face!.paramCells ?? {}).toEqual({});
    for (const p of kickdrumDef.params) {
      if (p.id === 'hard') continue;
      expect(paramCellKind(p, momentary, 'dock'), `${p.id} renders as a knob`).toBe('knob');
    }
  });

  it('the audition resolves to a live ACTION cell — never the inert placeholder', () => {
    const ctl = curatedFace(def, 'dock')!.controls.find((c) => c.key === 'kickdrum-strike-{n}')!;
    const cell = shellCellFor('kickdrum', ctl);
    expect(cell, 'an unregistered family key renders an INERT cell and fails both gates').not.toBeNull();
    expect(cell!.kind).toBe('action');
  });
});
