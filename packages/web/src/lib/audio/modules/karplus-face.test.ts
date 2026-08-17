// packages/web/src/lib/audio/modules/karplus-face.test.ts
//
// The PIN for KARPLUS's curated face — the design decisions, projected through
// the same PURE selectors the shell renders from (`curatedFace`, `dockFacePlan`,
// `shellCellFor`, `rearFieldPlan`), so a later edit that undoes one of them
// fails HERE rather than in a screenshot.
//
// The registry-wide gates (module-face-lint, faces-parity) prove the face is
// WELL-FORMED — every param ranked, every cell operable, nothing rendered
// twice. They are structurally blind to whether it is the RIGHT shape: which
// six controls the lane budget buys, that the PLUCK is reachable at all, and
// that `order` and `pages` disagree ON PURPOSE. That is what this file holds.
//
// ⚠ NOT a restatement of the def. Every assertion runs the def through a
// selector and checks the RESULT, so it fails on a change to the face OR to the
// selector semantics — the two-sided contract. `expect(order).toEqual([…])`
// would only have proved the file parses.
//
// ⚠ AND EVERY CLAIM CARRIES A NEGATIVE CONTROL, in-test, permanently. A pin
// that says "the plate holds six cells" is equally green against a selector
// that returns a constant, so each block also perturbs the def and asserts the
// SAME selector call moves. That is the instrument being negative-controlled on
// every run rather than once at authoring time (CLAUDE.md: validate the
// instrument).

import { describe, it, expect } from 'vitest';

import { karplusDef } from './karplus';
import {
  curatedFace,
  dockFacePlan,
  dockPlanControls,
  faceTierCap,
  LANE_PLATE_MAX_CELLS,
  type FaceDefLike,
} from '$lib/ui/workflow/curated-face';
import { shellCellFor } from '$lib/ui/workflow/shell-cells';
import { laneBodyPlan } from '$lib/ui/workflow/module-shell-model';
import { rearFieldPlan } from '$lib/ui/workflow/rear-card-model';

const def = karplusDef as unknown as FaceDefLike;

/** The control KEYS a tier surfaces, in rank order. */
function keysAt(tier: 'mini' | 'compact' | 'full' | 'dock', d: FaceDefLike = def): string[] {
  return (curatedFace(d, tier)?.controls ?? []).map((c) => c.key);
}

/** A shallow clone of the def with a REPLACED `face.order` — the perturbation
 *  every negative control below drives, so the instrument is proven to be
 *  reading the def rather than returning a constant. */
function withOrder(order: readonly string[]): FaceDefLike {
  return { ...karplusDef, face: { ...karplusDef.face!, order } } as unknown as FaceDefLike;
}

describe('karplus face — the tier ladder (order = PRIORITY)', () => {
  it('mini shows DECAY alone: the ring-out IS the envelope, there is no other', () => {
    expect(keysAt('mini')).toEqual(['decay']);
    // NEGATIVE CONTROL: the tier really reads rank 1.
    expect(keysAt('mini', withOrder(['tune', ...karplusDef.face!.order.filter((k) => k !== 'tune')])))
      .toEqual(['tune']);
  });

  it('compact adds BRIGHT beside the live trace — how long it rings, then what it is made of', () => {
    const face = curatedFace(def, 'compact')!;
    expect(face.glyph, 'the compact tile keeps its live scope').toBe('scope');
    expect(faceTierCap('compact', true), 'a glyph-bearing compact tile fits two whole cells').toBe(2);
    expect(keysAt('compact')).toEqual(['decay', 'brightness']);
  });

  it('the plate is SIX cells and that is the WHOLE lane budget — rank 7+ reaches no lane tier', () => {
    const full = keysAt('full');
    expect(full).toEqual(['decay', 'brightness', 'tune', 'color', 'burst', 'level']);
    expect(full.length).toBe(LANE_PLATE_MAX_CELLS);

    // The claim that makes rank 7 dock-only, checked against the FIT PLAN
    // rather than restated: the plate paints exactly what the cap selects.
    const plan = laneBodyPlan(full.length, true, 'full');
    expect(plan.cellCount, 'the plate paints every selected cell (no silent truncation)').toBe(6);

    // …and every rank past 6 is absent from EVERY lane tier.
    const tail = (karplusDef.face!.order as readonly string[]).slice(LANE_PLATE_MAX_CELLS);
    expect(tail).toEqual(['karplus-strike-{n}', 'position', 'stiffness']);
    for (const tier of ['mini', 'compact', 'full'] as const) {
      const shown = new Set(keysAt(tier));
      for (const key of tail) {
        expect(shown.has(key), `${key} must not reach the '${tier}' lane tier`).toBe(false);
      }
    }
  });

  it('the GLYPH is NOT painted at the `full` tier — six cells need both plate rows', () => {
    // The def comment used to promise the trace was "the single most
    // informative pixel budget on the tile", full stop. It is true at mini,
    // compact and as the dock hero; at 'full' `glyph = hasGlyph && rows <= 1`
    // is false and the scope simply does not render. Pinned so the prose and
    // the geometry cannot drift apart again.
    expect(laneBodyPlan(keysAt('full').length, true, 'full').glyph).toBe(false);
    expect(laneBodyPlan(keysAt('compact').length, true, 'compact').glyph).toBe(true);
    expect(laneBodyPlan(keysAt('mini').length, true, 'mini').glyph).toBe(true);

    // NEGATIVE CONTROL for the instrument: a 3-cell face DOES keep the strip,
    // so `glyph: false` above is a fact about this face, not about laneBodyPlan
    // always saying no.
    expect(laneBodyPlan(3, true, 'full').glyph).toBe(true);
  });

  it('LEVEL is IN the lane and POS is OUT — the one rank that moved, and why', () => {
    const lane = keysAt('full');
    expect(lane, 'the trim for a voice nothing else normalises').toContain('level');
    expect(lane, 'a per-hit exciter comb is a sound-design choice, not a ride knob').not.toContain('position');
    expect(keysAt('dock'), 'POS is dock-only, not dropped').toContain('position');

    // The reasons are DOCUMENTED, not folklore — the docs gate keeps the prose
    // honest, so pin that the ranking and the prose still agree.
    expect(karplusDef.docs!.controls!.level).toMatch(/nothing normalizes the voice's loudness/);
    expect(karplusDef.docs!.controls!.position).toMatch(/shapes the EXCITER, not the loop/);
    expect(karplusDef.docs!.inputs!.position_cv).toMatch(/Sample-and-hold it per step/);

    // …and the two knobs that CAUSE the loudness swing sit in the same tile,
    // which is the whole argument for spending a lane cell on a trim.
    expect(lane.indexOf('decay')).toBeLessThan(lane.indexOf('level'));
    expect(lane.indexOf('brightness')).toBeLessThan(lane.indexOf('level'));
  });

  it('STIFF ranks LAST: it ships at 0, so at spawn the knob is inert by default', () => {
    const order = karplusDef.face!.order as readonly string[];
    expect(order[order.length - 1]).toBe('stiffness');
    expect(karplusDef.params.find((p) => p.id === 'stiffness')!.defaultValue).toBe(0);
  });
});

describe('karplus face — the PLUCK (the audition this face exists to recover)', () => {
  it('ranks 7th: the first rank that cannot reach a lane, deliberately', () => {
    const order = karplusDef.face!.order as readonly string[];
    expect(order[LANE_PLATE_MAX_CELLS]).toBe('karplus-strike-{n}');
  });

  it('resolves to a real ACTION cell — an unregistered key renders INERT and fails both gates', () => {
    const ctl = (curatedFace(def, 'dock')!.controls).find((c) => c.key === 'karplus-strike-{n}')!;
    expect(ctl.kind, 'a declared control family, not an unrecognised static').toBe('family');
    expect(ctl.familyId).toBe('karplus-strike');
    expect(ctl.label, 'the DECLARED family label, not a humanised id').toBe('Pluck');

    const cell = shellCellFor('karplus', ctl)!;
    expect(cell, 'shell-cells.ts must register this key or the shell paints an INERT cell').toBeTruthy();
    expect(cell.kind).toBe('action');
    expect(cell.kind === 'action' && cell.label).toBe('pluck');

    // NEGATIVE CONTROL: the registry lookup is keyed on the FACE KEY, so a
    // renamed family really does fall off it (this is the failure mode the
    // assertion above claims to guard).
    expect(shellCellFor('karplus', { ...ctl, key: 'karplus-pluck-{n}' })).toBeNull();
    expect(shellCellFor('kickdrum', ctl), 'and it is scoped per module type').toBeNull();
  });

  it('is NOT a param — it must never persist a one-shot into the Y.Doc', () => {
    expect(karplusDef.params.map((p) => p.id)).not.toContain('strike');
    expect(karplusDef.face!.momentary ?? []).toEqual([]);
    // The worklet exposes exactly the eight declared params; a `strike` param
    // would add a ninth parameterDescriptor and redden karplus.test.ts.
    expect(karplusDef.params).toHaveLength(8);
  });
});

describe('karplus face — the dock bands (pages = FUNCTION)', () => {
  const plan = dockFacePlan(def)!;

  it('renders TWO bands — the one-knob `output` band is gone', () => {
    expect(plan.map((b) => b.id)).toEqual(['string', 'pick']);
    expect(plan.map((b) => b.label)).toEqual(['string · ring', 'pick · strike · out']);
    // The band it replaced spent a whole section on a single knob.
    expect(plan.map((b) => b.id)).not.toContain('out');
  });

  it('`order` and `pages` DISAGREE on the PLUCK, on purpose', () => {
    // rank 7 of 9 (priority: the lane cannot usefully paint an uncaptioned ▸)
    // …but FIRST in its band (function: it is what you reach for).
    const order = karplusDef.face!.order as readonly string[];
    expect(order.indexOf('karplus-strike-{n}')).toBe(6);
    expect(plan[1]!.controls[0]!.key).toBe('karplus-strike-{n}');
    expect(plan[1]!.controls[0]!.kind).toBe('family');
    expect(plan[1]!.controls.slice(1).map((c) => c.key)).toEqual([
      'color', 'burst', 'position', 'level',
    ]);
  });

  it('page 1 is THE STRING; page 2 is everything that is not the string', () => {
    expect(plan[0]!.controls.map((c) => c.key)).toEqual(['tune', 'decay', 'brightness', 'stiffness']);
    // No clusters on either band: a one-control cluster buys the same nothing
    // a one-control band did.
    expect(plan.flatMap((b) => b.clusters)).toEqual([]);
  });

  it('the dock paints all NINE cells: 8 params + the audition, each exactly once', () => {
    const flat = dockPlanControls(plan);
    expect(flat).toHaveLength(karplusDef.params.length + 1);
    expect(new Set(flat.map((c) => c.key)).size).toBe(flat.length);
    expect(flat.filter((c) => c.kind === 'param')).toHaveLength(karplusDef.params.length);
    expect(flat.filter((c) => c.kind === 'family')).toHaveLength(1);
    expect(flat.filter((c) => c.kind === 'static'), 'an unresolved key would land here').toHaveLength(0);
  });
});

describe('karplus face — the REAR card the pages project onto', () => {
  const bands = rearFieldPlan(karplusDef as never).inputs;

  it('is TOTAL: every declared port lands in exactly one hole, no `cv` tail section', () => {
    const holes = bands.flatMap((b) => [...b.holes, ...b.clusters.flatMap((c) => c.holes)]);
    const ids = holes.map((h) => h.portId);
    expect(new Set(ids).size, `a port rendered TWICE: ${ids.join(', ')}`).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(karplusDef.inputs!.map((p) => p.id)));
    expect(ids).toHaveLength(12);
    expect(bands.map((b) => b.id), 'no derived `cv` orphan section').toEqual(['voice', 'string', 'pick']);
  });

  it('LEVEL_CV followed LEVEL out of the retired `output` band into `pick`', () => {
    const pick = bands.find((b) => b.id === 'pick')!;
    expect(pick.holes.map((h) => h.portId)).toEqual([
      'color_cv', 'burst_cv', 'position_cv', 'level_cv',
    ]);
    expect(bands.map((b) => b.id)).not.toContain('out');
  });

  it('no page id collides with the LEADING derived band — the dx7 double-render scar', () => {
    // rear-card-model pushes a 'voice'/'signal' band BEFORE the page loop and
    // nothing claims it, so a page called either would build the band twice.
    for (const p of karplusDef.face!.pages!) {
      expect(['voice', 'signal'], `page '${p.id}' would claim the leading band`).not.toContain(p.id);
    }
    const ids = bands.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the two HANDS of playing a string survive the page merge', () => {
    const voice = bands.find((b) => b.id === 'voice')!;
    expect(voice.label).toBe('play');
    expect(voice.clusters.map((c) => c.label)).toEqual(['striking hand', 'fretting hand']);
    expect(voice.clusters[0]!.holes.map((h) => h.portId)).toEqual(['trigger_in', 'accent_in']);
    expect(voice.clusters[1]!.holes.map((h) => h.portId)).toEqual(['pitch', 'damp_in']);
  });

  it('audioRate ticks PITCH ALONE — the knob CVs are 80 Hz-smoothed, a-rate only on paper', () => {
    expect(karplusDef.face!.rear!.audioRate).toEqual(['pitch']);
    const audioRateHoles = bands
      .flatMap((b) => [...b.holes, ...b.clusters.flatMap((c) => c.holes)])
      .filter((h) => h.audioRate)
      .map((h) => h.portId);
    expect(audioRateHoles).toEqual(['pitch']);
  });
});
