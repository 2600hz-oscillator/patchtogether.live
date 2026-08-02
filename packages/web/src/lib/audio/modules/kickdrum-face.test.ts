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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

/** The declared ranking. */
function faceOrder(): readonly string[] {
  return kickdrumDef.face!.order;
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
    expect(dyn.clusters.map((c) => c.label)).toEqual(['transient · glue', 'level · width · ceiling']);
    expect(dyn.clusters[0]!.controls.map((c) => c.key)).toEqual(['attack', 'sustain', 'glue']);
    expect(dyn.clusters[1]!.controls.map((c) => c.key)).toEqual(['level', 'width', 'ceiling']);
  });

  it('…and that split is the DSP’s ACTUAL chain order, read from the worklet source', () => {
    // ⚠ THE ASSERTION ABOVE, ALONE, PINS WHATEVER THE DEF SAYS. It shipped
    // pinning `[attack, sustain, glue, CEILING]` + `[width, LEVEL]` against a
    // def comment claiming the chain is "transient → glue → ceiling → stereo →
    // level". The DSP does the opposite at both ends, so the faceplate taught a
    // producer that raising LEVEL escapes the clipper — it feeds it
    // (`tanh(g · 10^(level/20) · …)`, i.e. more saturation, the exact misuse
    // the ranking exists to prevent). A restatement of the def cannot catch a
    // wrong def; reading the other side of the contract can.
    const dspSrc = readFileSync(
      fileURLToPath(new URL('../../../../../dsp/src/lib/kickdrum-dsp.ts', import.meta.url)),
      'utf8',
    );
    // LEVEL: the last line of the voice step. CEILING: the tanh in the stereo
    // wrapper, applied to the level-scaled mid AND side.
    const levelAt = dspSrc.indexOf('const lin = Math.pow(10, clamp(p.level');
    const ceilAt = dspSrc.indexOf('out[0] = Math.tanh(g * (m + sd))');
    expect(levelAt, 'the level line moved — re-anchor this gate on the real expression').toBeGreaterThan(0);
    expect(ceilAt, 'the ceiling line moved — re-anchor this gate').toBeGreaterThan(0);
    expect(levelAt, 'LEVEL is applied BEFORE the ceiling in the worklet').toBeLessThan(ceilAt);
    expect(
      dspSrc.slice(ceilAt - 200, ceilAt),
      'the side term is scaled by the LEVEL linear gain, so width sits between them',
    ).toContain('s.sideOut * lin * clamp(p.width');

    // …and the faceplate's out-cluster teaches exactly that order.
    const out = plan[4]!.clusters[1]!.controls.map((c) => c.key);
    expect(out.indexOf('level')).toBeLessThan(out.indexOf('width'));
    expect(out.indexOf('width')).toBeLessThan(out.indexOf('ceiling'));
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

  it('the REAR renders every band exactly once, and no page claims the LEADING slot', async () => {
    // ⚠ THIS USED TO FORBID *ANY* page id matching a curated rear group id,
    // which is the opposite of the mechanism. `rear-card-model`'s page loop
    // does `curatedGroups.find(gr => gr.id === page.id)` and lets that group
    // CLAIM the page's slot — its label wins, `usedGroupIds` stops the
    // extra-curated loop re-adding it, and exactly one band renders. That is
    // how a page band gets a rear-specific heading at all, and this module now
    // relies on it (`sub` → `sub · the layer`, so the rear does not show two
    // bands both headed STRIKE). tidyVco shares `oscillator` the same way.
    //
    // The real double-render trap is a page id equal to the LEADING derived
    // band — 'voice'/'signal' — which is pushed BEFORE the page loop and is not
    // in `curatedGroups`, so nothing claims it. So: assert the property that
    // actually matters (each band id once) and forbid only the leading ids.
    const { rearFieldPlan } = await import('$lib/ui/workflow/rear-card-model');
    const bands = rearFieldPlan(kickdrumDef as never).bands;
    const ids = bands.map((b) => b.id);
    expect(new Set(ids).size, `a band rendered twice: ${ids.join(', ')}`).toBe(ids.length);
    for (const b of plan) {
      expect(['voice', 'signal'], `page '${b.id}' would claim the leading derived band`).not.toContain(b.id);
    }
  });

  it('the REAR re-heads the sub band so two bands are not both read as STRIKE', async () => {
    // The mispatch this closes, on the module it was found on (the
    // registry-wide version lives in module-face-lint). The front page is
    // `strike · the pulse` because it holds the strike BUTTON; the rear band
    // with the same id holds five sub-layer CVs whose first hole is `tune_cv`,
    // sitting directly under the band that IS the strike. A gate patched into
    // the wrong one detunes the drum instead of hitting it.
    const { rearFieldPlan } = await import('$lib/ui/workflow/rear-card-model');
    const bands = rearFieldPlan(kickdrumDef as never).bands;
    const byId = new Map(bands.map((b) => [b.id, b]));
    expect(byId.get('voice')!.label).toBe('strike');
    expect(byId.get('sub')!.label).toBe('sub · the layer');
    expect(byId.get('sub')!.holes[0]!.portId, 'the hole a mis-read STRIKE would hit').toBe('tune_cv');
    const labels = bands.map((b) => (b.label ?? '').toLowerCase());
    for (const a of labels) {
      for (const b of labels) {
        if (a !== b) expect(b.startsWith(a), `'${a}' heads '${b}'`).toBe(false);
      }
    }
  });
});

describe('kickdrum face — the primitives each cell resolves to', () => {
  const momentary = momentaryParamIds(kickdrumDef);

  it('HARD paints a <Toggle>, not a rotary printing 0.00', () => {
    const hard = kickdrumDef.params.find((p) => p.id === 'hard')!;
    expect(paramCellKind(hard, momentary, 'dock')).toBe('toggle');
    // ⚠ THE `'lane'` HALF USED TO BE ASSERTED HERE AS "at BOTH tiers", and it
    // was VACUOUS FOR THIS MODULE: `hard` is rank ~20 and this same file proves
    // (below) that rank 7+ reaches no lane tier, so the lane path it exercised
    // is one kickdrum never takes. It pinned the primitive registry, not this
    // face. The registry-wide claim belongs to shell-control-kind's own test;
    // what THIS file can honestly say is that the cell kickdrum actually
    // renders is a toggle, and that the lane never has to render it at all.
    expect(faceOrder().indexOf('hard')).toBeGreaterThanOrEqual(faceTierCap('full', true));
    expect(keysAt('full')).not.toContain('hard');
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
