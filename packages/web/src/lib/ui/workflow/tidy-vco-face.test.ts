// packages/web/src/lib/ui/workflow/tidy-vco-face.test.ts
//
// THE TIDY VCO FACE, PINNED THROUGH THE REAL PURE MODELS (batch F).
//
// `module-face-lint` proves a face is WELL-FORMED for every promoted module.
// It cannot prove a face is the face that was DESIGNED — a re-ranking that
// silently drops the tune cluster out of the plate, or a page rename that
// wrecks the rear band order, is well-formed and wrong. So this spec pins the
// authored DECISIONS, each next to the argument it rests on.
//
// The one that is NOT a taste assertion is section B. The `pw` demotion is
// justified by a claim about the DSP — "PW is provably inert at the SHAPE
// default" — and a claim about the DSP is checkable. So it is checked, against
// the def's own pure-math mirror (`tidyVcoMath`, the SAME source the worklet
// bundles), with its own negative control inline: the identity that holds at
// the spawn defaults must BREAK the moment SHAPE reaches the pulse leg. A
// sameness metric with no proof it can register difference is exactly the
// blind instrument CLAUDE.md's VALIDATE-THE-INSTRUMENT section is about — it
// would return a clean number for a render function that ignored `pw`
// entirely, or for one that ignored every param.

import { describe, expect, it } from 'vitest';

import { tidyVcoDef, tidyVcoMath, type TidyVcoBus, type TidyVcoParams } from '$lib/audio/modules/tidy-vco';
import type { ParamDef } from '$lib/graph/types';
import {
  curatedFace,
  dockFacePlan,
  dockPlanControls,
  LANE_PLATE_MAX_CELLS,
  type FaceTier,
} from './curated-face';
import { laneBodyPlan } from './module-shell-model';
import { rearFieldPlan, type RearDefLike } from './rear-card-model';
import { momentaryParamIds, paramCellKind } from './shell-control-kind';

const face = tidyVcoDef.face!;
const params = tidyVcoDef.params;

/** The control KEYS a tier surfaces, in rank order. */
function keysAt(tier: FaceTier): string[] {
  return (curatedFace(tidyVcoDef, tier)?.controls ?? []).map((c) => c.key);
}

function param(id: string): ParamDef {
  const p = params.find((q) => q.id === id);
  expect(p, `${id} is a declared param`).toBeDefined();
  return p!;
}

// ───────────────────────────── A. the lane ladder ─────────────────────────

describe('tidyVco face — the LANE ladder (what the player rides)', () => {
  it('mini surfaces CUTOFF alone — the one control hot in every patch state', () => {
    // Not SHAPE. SHAPE is a setting you pick; CUTOFF is a gesture you ride, and
    // on this diode ladder it is calibrated to the RESONANT pitch, so it is
    // also the self-oscillation tuning knob.
    expect(keysAt('mini')).toEqual(['cutoff']);
  });

  it('compact surfaces CUTOFF + SHAPE 1 beside the glyph the shape DRAWS', () => {
    // A glyph-bearing face fits two whole knob columns next to the wave screen
    // (faceTierCap). SHAPE 1 is the param the 'waveform' glyph renders, so the
    // knob and its picture are adjacent rather than a tier apart.
    expect(keysAt('compact')).toEqual(['cutoff', 'shape1']);
    expect(face.glyph).toBe('waveform');
  });

  it('full is the whole 6-cell plate, tune cluster INSIDE it', () => {
    const full = keysAt('full');
    expect(full).toEqual(['cutoff', 'shape1', 'res', 'detune', 'oct2', 'pw']);
    expect(full.length).toBe(LANE_PLATE_MAX_CELLS);
    // The owner control-loss report, pre-gated in the unit lane: faces-parity
    // asserts control-detune + control-oct2 VISIBLE in the lane full face.
    // Ranking either at 7+ would put it back where the regression block found
    // it, and this assertion is ~4 ms against that spec's ~1.6 s.
    expect(full, 'the TUNE CLUSTER must survive the 6-cell plate cap').toContain('detune');
    expect(full).toContain('oct2');
  });

  it('SIX cells means TWO plate rows means NO glyph at the full tier — priced in', () => {
    // laneBodyPlan: `glyph: hasGlyph && rows <= 1`. This is a consequence of
    // the 6-cell budget, not an accident of it, and it is why the wave screen
    // is a mini/compact affordance. Nothing about the ranking can buy it back:
    // at 3 columns, anything past 3 cells is already two rows.
    expect(laneBodyPlan(keysAt('full').length, true, 'full')).toEqual({
      layout: 'plate',
      cellCount: 6,
      glyph: false,
      knobSize: 'sm',
    });
    expect(laneBodyPlan(4, true, 'full').glyph, 'even 4 cells is two rows').toBe(false);
  });

  it('FOLD and ENV are rank 7-8 — dock-only, and that is deliberate', () => {
    // FOLD is the West-Coast hero but a TRUE BYPASS at its 0 default, so a lane
    // cell would be spent on a control doing nothing until touched — the exact
    // charge that demoted PW. ENV is the filter-EG depth, a patch decision.
    expect(face.order.slice(6, 8)).toEqual(['fold', 'env']);
    for (const tier of ['mini', 'compact', 'full'] as const) {
      expect(keysAt(tier), `${tier} must not reach rank 7+`).not.toContain('fold');
      expect(keysAt(tier)).not.toContain('env');
    }
  });

  it('the ranking is total and duplicate-free over the 25-param surface', () => {
    expect(face.order.length).toBe(params.length);
    expect(new Set(face.order).size).toBe(face.order.length);
    expect([...face.order].sort()).toEqual(params.map((p) => p.id).sort());
  });
});

// ─────────── B. the PW demotion, checked against the DSP not taste ─────────

const SR = 48_000;
const N = 2048;

/** A silent bus with the mono gate held open (the spawn-audition state). */
function gatedBus(): TidyVcoBus {
  return {
    poly: new Float32Array(10),
    monoPitch: 0,
    monoGate: 1,
    resCv: 0,
    driveCv: 0,
  };
}

/** Render N samples of the L channel for a param set, from a fresh state. */
function renderL(over: Partial<TidyVcoParams>): Float32Array {
  const l = new Float32Array(N);
  const r = new Float32Array(N);
  tidyVcoMath.render(
    { ...tidyVcoMath.defaults(), ...over },
    gatedBus(),
    l,
    r,
    0,
    N,
    SR,
    tidyVcoMath.makeState(),
  );
  return l;
}

/** Peak absolute difference between two renders — the sameness metric. */
function maxDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

describe('tidyVco face — PW is rank 6 because the DSP says so, not because we prefer it', () => {
  const pwMin = param('pw').min;
  const pwMax = param('pw').max;

  it('PW is INERT at the spawn defaults — the whole travel changes nothing', () => {
    // `tidyOscSample` gates the pulse leg on the SHAPE morph, and BOTH shape
    // defaults are 0, so at spawn the pulse leg is out of the mix entirely.
    // A rank-2 PW therefore shipped the compact tile a knob that does nothing
    // until you move the knob beside it. Ranges come from the DEF (pwMin /
    // pwMax read off the ParamDef) — never re-typed here.
    const wide = renderL({ pw: pwMax });
    const thin = renderL({ pw: pwMin });
    expect(maxDiff(wide, thin), `PW ${pwMin}→${pwMax} at the SHAPE default`).toBe(0);
  });

  it('NEGATIVE CONTROL: the same metric MOVES once SHAPE reaches the pulse leg', () => {
    // Without this the assertion above is worthless: a render that ignored `pw`
    // (or every param) would satisfy it. Same params, same metric, one thing
    // perturbed — SHAPE — and the number must leave zero by a wide margin.
    const wide = renderL({ shape1: 1, shape2: 1, pw: pwMax });
    const thin = renderL({ shape1: 1, shape2: 1, pw: pwMin });
    expect(maxDiff(wide, thin), 'PW must be audible at the pulse end').toBeGreaterThan(0.01);
  });

  it('NEGATIVE CONTROL: CUTOFF — the rank-1 promotion — is live AT the defaults', () => {
    // The mirror of the PW finding, and the positive half of the ranking
    // argument: the control we put on the MINI tile must do something on a
    // freshly spawned module, with nothing patched and no other knob touched.
    const dark = renderL({ cutoff: param('cutoff').min });
    const bright = renderL({ cutoff: param('cutoff').max });
    expect(maxDiff(dark, bright), 'CUTOFF at the spawn defaults').toBeGreaterThan(0.01);
  });
});

// ───────────────────── C. oct2 — the named-state control ───────────────────

describe('tidyVco face — OCT 2 reads as its three states (PF-1)', () => {
  const oct2 = param('oct2');
  const momentary = momentaryParamIds(tidyVcoDef);

  it('the roster names every reachable state and boots into one', () => {
    // -1..1 discrete = three reachable values. A roster that skipped one would
    // leave a state the dial reaches and the picker cannot name.
    expect(oct2.options?.map((o) => o.value)).toEqual([-1, 0, 1]);
    expect(oct2.options?.map((o) => o.label)).toEqual(['-1', '0', '+1']);
    expect(oct2.options?.some((o) => o.value === oct2.defaultValue)).toBe(true);
    // The roster VALUES come from the def's own range — assert the span rather
    // than re-typing the numbers as a second source of truth.
    for (const o of oct2.options ?? []) {
      expect(o.value).toBeGreaterThanOrEqual(oct2.min);
      expect(o.value).toBeLessThanOrEqual(oct2.max);
    }
  });

  it('renders as a NAMED ROW in the dock and keeps the dial in the lane', () => {
    expect(paramCellKind(oct2, momentary, 'dock')).toBe('segmented');
    expect(paramCellKind(oct2, momentary, 'lane')).toBe('knob');
    // ...and it is a lane control, so the lane half is not hypothetical.
    expect(keysAt('full')).toContain('oct2');
  });

  it('HOLD stays a momentary pad, roster or not', () => {
    expect(face.momentary).toEqual(['hold']);
    expect(paramCellKind(param('hold'), momentary, 'dock')).toBe('momentary');
  });
});

// ──────────────────────────── D. the dock plan ────────────────────────────

describe('tidyVco face — the DOCK faceplate', () => {
  const plan = dockFacePlan(tidyVcoDef)!;

  it('is exactly the five authored bands — no defensive `more` tail', () => {
    expect(plan.map((b) => b.id)).toEqual([
      'oscillator',
      'wavefolder',
      'filter',
      'envelopes',
      'output',
    ]);
    expect(plan.map((b) => b.label)).toEqual([
      'oscillator',
      'wavefolder',
      'diode filter',
      'envelopes',
      'output',
    ]);
  });

  it('the ENVELOPES band is one idea twice — two clusters, nothing loose (PF-9)', () => {
    // The rear has always taught this split; the front hid it behind eight
    // unlabeled A/D/S/R knobs. A cluster is ~14 px of sub-header against the
    // ~81 px a sixth page would have cost.
    const env = plan.find((b) => b.id === 'envelopes')!;
    expect(env.controls, 'every EG knob belongs to a cluster').toEqual([]);
    expect(env.clusters.map((c) => c.label)).toEqual(['filter eg', 'amp eg']);
    expect(env.clusters[0].controls.map((c) => c.key)).toEqual(['fatk', 'fdec', 'fsus', 'frel']);
    expect(env.clusters[1].controls.map((c) => c.key)).toEqual(['atk', 'dec', 'sus', 'rel']);
  });

  it('the OSCILLATOR band carries the tune cluster (the dock half of the regression)', () => {
    const osc = plan.find((b) => b.id === 'oscillator')!;
    const keys = [...osc.controls, ...osc.clusters.flatMap((c) => c.controls)].map((c) => c.key);
    expect(keys).toContain('detune');
    expect(keys).toContain('oct2');
  });

  it('renders every one of the 25 params exactly once, clustered cells included', () => {
    const flat = dockPlanControls(plan);
    expect(flat.every((c) => c.kind === 'param')).toBe(true);
    expect(flat.map((c) => c.paramId).sort()).toEqual(params.map((p) => p.id).sort());
  });
});

// ───────── E. the page-id ↔ rear-group-id LOCKSTEP (the invisible trap) ────

describe('tidyVco face — rear bands stay in lockstep with the pages', () => {
  // WHY THIS EXISTS AT ALL: `rearFieldPlan` lets a curated group whose id
  // matches a page id CLAIM that page's band slot, and appends any other
  // curated group AFTER the page bands. So renaming the `oscillator` page
  // without renaming the group (or vice versa) produces a derived band holding
  // only the leftovers plus a stray appended 7-hole band — and the totality
  // gate CANNOT SEE IT, because every port still renders exactly once, just in
  // a wrecked order. A gate that counts holes proves nothing about their order.
  const def = tidyVcoDef as unknown as RearDefLike;
  const plan = rearFieldPlan(def);

  it('every curated group either claims the leading slot or names a real page', () => {
    const pageIds = new Set((face.pages ?? []).map((p) => p.id));
    for (const g of face.rear?.groups ?? []) {
      const claimsLead = g.id === 'voice' || g.id === 'signal';
      expect(
        claimsLead || pageIds.has(g.id),
        `rear group '${g.id}' claims neither the leading slot nor a declared page — it would append as a stray band`,
      ).toBe(true);
    }
  });

  it('no page id collides with the LEADING group id (the dx7 double-band scar)', () => {
    const lead = (face.rear?.groups ?? []).find((g) => g.id === 'voice' || g.id === 'signal');
    expect(lead, 'tidyVco pins its leading band').toBeDefined();
    expect((face.pages ?? []).map((p) => p.id)).not.toContain(lead!.id);
  });

  it('the rear renders exactly leading + one band per page, ids unique', () => {
    const ids = plan.bands.map((b) => b.id);
    expect(ids).toEqual(['voice', 'oscillator', 'wavefolder', 'filter', 'envelopes', 'output']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(1 + (face.pages ?? []).length);
  });
});
