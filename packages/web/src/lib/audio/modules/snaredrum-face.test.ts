// packages/web/src/lib/audio/modules/snaredrum-face.test.ts
//
// The PIN for SNARE DRUM's curated face — the design decisions, projected
// through the same PURE selectors the shell renders from (`curatedFace`,
// `dockFacePlan`, `laneBodyPlan`, `paramCellKind`, `shellCellFor`,
// `rearFieldPlan`), so a later edit that undoes one of them fails HERE rather
// than in a screenshot.
//
// The registry-wide gates (module-face-lint, shell-cells, faces-parity) prove
// the face is WELL-FORMED — every param ranked, every cell operable, nothing
// rendered twice. They are structurally blind to whether it is the RIGHT shape.
// This module's face rests on four claims none of them can see:
//   1. the lane is SIX cells and the ROLL ENGINE is inside it (the old face
//      ranked `roll_speed` 6th and `bounce` 7th, so you could set a roll's rate
//      and not its character on the rack's only module with a roll engine);
//   2. `roll_speed` outranks the timbre knobs, and the DEF ITSELF says so — it
//      is the only param with a dedicated audio-rate node input;
//   3. the scope glyph is ALREADY dead at the `full` tier and this face costs
//      it nothing (a claim it is very easy to assume the other way);
//   4. the two auditions are TWO cells with DIFFERENT press semantics, because
//      the two strike inputs have different declared `edge`s.
//
// ⚠ NOT a restatement of the def. Every assertion runs the def through a
// SELECTOR and checks the result, so it fails on a change to the face OR to the
// selector semantics. `expect(order).toEqual([…])` would only prove the file
// parses. Where a claim is about the DSP or another module's source, the source
// is READ rather than restated.

import { describe, it, expect } from 'vitest';

import { snaredrumDef } from './snaredrum';
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
import { rearFieldPlan, rearSectionHoles } from '$lib/ui/workflow/rear-card-model';

const def = snaredrumDef as unknown as FaceDefLike;
const momentary = momentaryParamIds(snaredrumDef as { face?: { momentary?: readonly string[] } });

/** The control KEYS a tier surfaces, in rank order. */
function keysAt(tier: 'mini' | 'compact' | 'full' | 'dock'): string[] {
  return (curatedFace(def, tier)?.controls ?? []).map((c) => c.key);
}

function faceOrder(): readonly string[] {
  return snaredrumDef.face!.order;
}

describe('snaredrum face — the tier ladder (order = PRIORITY)', () => {
  it('mini shows TUNE alone — the modal bank and the body noise both track it', () => {
    expect(keysAt('mini')).toEqual(['tune']);
  });

  it('compact is TUNE + WIRES beside the live trace: which drum, and is it a snare', () => {
    const face = curatedFace(def, 'compact')!;
    expect(face.glyph, 'the compact tile keeps its scope trace').toBe('scope');
    expect(faceTierCap('compact', 'trace'), 'a glyph-bearing compact tile fits two whole cells').toBe(2);
    expect(keysAt('compact')).toEqual(['tune', 'wire']);
  });

  it('the full lane is SIX cells and it ENDS there — rank 7 reaches no lane tier', () => {
    // The stale-comment bug this face was rebuilt for. The def used to promise
    // "ranks 4–8 complete the full-in-lane face"; the plate is 3 cols × 2 whole
    // rows, so ranks 7 and 8 rendered NOWHERE.
    expect(faceTierCap('full', 'trace')).toBe(LANE_PLATE_MAX_CELLS);
    expect(LANE_PLATE_MAX_CELLS).toBe(6);
    const full = keysAt('full');
    expect(full).toHaveLength(6);
    // Whatever is ranked 7th, no lane tier shows it.
    const rank7 = faceOrder()[6]!;
    for (const tier of ['mini', 'compact', 'full'] as const) {
      expect(keysAt(tier), `${tier} must not surface rank 7 ('${rank7}')`).not.toContain(rank7);
    }
  });

  it('THE ROLL ENGINE IS IN THE LANE — rate AND character, not rate alone', () => {
    const full = keysAt('full');
    expect(full, 'the roll rate').toContain('roll_speed');
    expect(full, "the roll's CHARACTER — the half the old face left at rank 7").toContain('bounce');
    expect(
      full.indexOf('bounce'),
      'BOUNCE reads immediately after ROLL SPEED: rate, then type',
    ).toBe(full.indexOf('roll_speed') + 1);
  });

  it('ROLL SPEED outranks the timbre knobs, and the DEF is the evidence', () => {
    // The argument is not taste. `roll_speed` is the ONLY param in this module
    // with its own dedicated audio-rate node input — the def spent a whole
    // worklet input on it (read per sample, 1 V/oct) while all twenty-one other
    // knobs get an 80 Hz-smoothed AudioParam. That is the def stating which
    // control is expected to MOVE.
    // A jack whose `_cv` stem NAMES A DECLARED PARAM but which carries no
    // `paramTarget` bypasses the smoothed-AudioParam path entirely and lands on
    // a raw worklet node input. (`pitch_cv` is excluded by construction, not by
    // hand: its stem 'pitch' is not a param — it transposes the whole voice.)
    const paramIds = new Set(snaredrumDef.params.map((p) => p.id));
    const dedicated = snaredrumDef.inputs
      .filter((p) => p.type === 'cv' && !p.paramTarget && paramIds.has(p.id.replace(/_cv$/, '')))
      .map((p) => p.id);
    expect(dedicated, 'exactly one param owns a node-rate CV jack').toEqual(['roll_speed_cv']);
    // …and it really is a worklet NODE input, not an AudioParam destination.
    expect(snaredrumDef.face!.rear!.audioRate, 'and the rear ticks it as audio-rate').toContain('roll_speed_cv');

    const order = faceOrder();
    expect(order.indexOf('roll_speed')).toBeLessThan(order.indexOf('tone'));
    expect(order.indexOf('roll_speed')).toBeLessThan(order.indexOf('head_decay'));
    expect(order.indexOf('roll_speed')).toBeLessThan(order.indexOf('crack'));
  });

  it('G DAMP is in the lane and HEAD DEC is not — one cell moving three tails', () => {
    // `damp` scales the head, body AND wire-bed decays together; `head_decay`
    // moves one. That is the whole demotion argument, and the def's own docs
    // are where it comes from.
    const full = keysAt('full');
    expect(full).toContain('damp');
    expect(full).not.toContain('head_decay');
    expect(snaredrumDef.docs!.controls!['damp']).toMatch(/head, body and wire-bed decays/i);
  });

  it('LEVEL stays out of the lane — it is applied BEFORE the ceiling', () => {
    // The drum-family rule (the KICK DRUM precedent): level runs into the clip
    // rather than escaping it, so promoting it into the lane would invite the
    // exact misuse the ranking exists to prevent.
    expect(keysAt('full')).not.toContain('level');
    expect(snaredrumDef.docs!.controls!['level']).toMatch(/BEFORE the ceiling/i);
  });
});

describe('snaredrum face — the GLYPH accounting (easy to assume backwards)', () => {
  it('the scope survives mini + compact and is ALREADY dead at full', () => {
    expect(laneBodyPlan(keysAt('mini').length, 'trace', 'mini').glyph).toBe(true);
    expect(laneBodyPlan(keysAt('compact').length, 'trace', 'compact').glyph).toBe(true);

    const plan = laneBodyPlan(keysAt('full').length, 'trace', 'full');
    expect(plan.layout).toBe('plate');
    expect(plan.cellCount).toBe(6);
    expect(
      plan.glyph,
      'a ≥4-cell face needs both plate rows, and the glyph only survives a single row',
    ).toBe(false);
  });

  it('and it was ALREADY false before this re-cut — the face costs the trace nothing', () => {
    // The previous face also selected 6 cells at `full` (its cap was the same
    // 6). Re-deriving from the cap rather than from a remembered number.
    expect(laneBodyPlan(faceTierCap('full', 'trace'), 'trace', 'full').glyph).toBe(false);
  });
});

describe('snaredrum face — the dock bands (pages = FUNCTION order)', () => {
  it('renders every param + both families exactly once, with no __unpaged tail', () => {
    const plan = dockFacePlan(def)!;
    const flat = dockPlanControls(plan);
    expect(plan.map((b) => b.id)).toEqual(['drum', 'snap', 'roll', 'whole', 'bus']);
    expect(flat).toHaveLength(snaredrumDef.params.length + snaredrumDef.controlFamilies!.length);
    expect(
      flat.map((c) => c.key).sort(),
      'the pages claim exactly the ranking — nothing swept into a "more" band',
    ).toEqual([...faceOrder()].sort());
  });

  it('THE AUDITIONS LEAD BAND 1 — this voice is silent until something strikes it', () => {
    const plan = dockFacePlan(def)!;
    const first = plan[0]!;
    expect(first.controls.slice(0, 2).map((c) => c.key)).toEqual([
      'snaredrum-hit-{n}',
      'snaredrum-roll-{n}',
    ]);
    // …and they are UN-clustered, which is load-bearing: clusters always render
    // AFTER the band's flat row, so a clustered pad could not lead anything.
    for (const cl of first.clusters) {
      expect(cl.controls.map((c) => c.key)).not.toContain('snaredrum-hit-{n}');
      expect(cl.controls.map((c) => c.key)).not.toContain('snaredrum-roll-{n}');
    }
  });

  it('the PITCH DROP cluster carries the one two-knob envelope, and only it', () => {
    const drum = dockFacePlan(def)!.find((b) => b.id === 'drum')!;
    expect(drum.clusters.map((c) => c.label)).toEqual(['pitch drop']);
    expect(drum.clusters[0]!.controls.map((c) => c.key)).toEqual(['pitch_amt', 'pitch_time']);
  });

  it('TONE + DAMP get their OWN band, not a sub-header under the output bus', () => {
    // They are the only two controls that touch EVERY layer. Filing them inside
    // a band called `bus` would teach that they are part of the output chain —
    // the shape of the mis-teaching KICK DRUM's face had to be fixed for.
    const plan = dockFacePlan(def)!;
    const whole = plan.find((b) => b.id === 'whole')!;
    expect(whole.controls.map((c) => c.key)).toEqual(['tone', 'damp']);
    const bus = plan.find((b) => b.id === 'bus')!;
    expect(bus.controls.map((c) => c.key)).not.toContain('tone');
    expect(bus.controls.map((c) => c.key)).not.toContain('damp');
    // The bus band IS the output chain and nothing else.
    expect(bus.controls.map((c) => c.key)).toEqual(['drive', 'hard', 'ceiling', 'width', 'level']);
  });

  it('SPREAD rides the ROLL band — a single trigger hit is always centred', () => {
    const roll = dockFacePlan(def)!.find((b) => b.id === 'roll')!;
    expect(roll.controls.map((c) => c.key)).toContain('spread');
    expect(snaredrumDef.docs!.controls!['spread']).toMatch(/a single trigger hit is always dead-centre/i);
  });

  it('order and pages DISAGREE on the auditions, deliberately', () => {
    // `order` is priority (you press a pad once and then ride the knobs);
    // `pages` is function order (the strike CAUSES everything else). A future
    // reader "fixing" one to match the other would break the ranking.
    const order = faceOrder();
    expect(order.indexOf('snaredrum-hit-{n}')).toBeGreaterThanOrEqual(LANE_PLATE_MAX_CELLS);
    expect(dockFacePlan(def)![0]!.controls[0]!.key).toBe('snaredrum-hit-{n}');
  });
});

describe('snaredrum face — the two auditions are TWO cells with DIFFERENT press semantics', () => {
  it('both families resolve to live ACTION cells — never the inert placeholder', () => {
    const dock = curatedFace(def, 'dock')!;
    for (const key of ['snaredrum-hit-{n}', 'snaredrum-roll-{n}']) {
      const ctl = dock.controls.find((c) => c.key === key)!;
      expect(ctl, `${key} is ranked`).toBeTruthy();
      const cell = shellCellFor('snaredrum', ctl);
      expect(cell, `${key}: an unregistered family key renders INERT and fails both gates`).not.toBeNull();
      expect(cell!.kind).toBe('action');
    }
  });

  it('HIT is a one-shot and ROLL is a HELD gate — matching their ports’ declared edges', () => {
    // THE claim of this face. `trigger_in` is edge:'trigger' (fire once per
    // rising edge) and `gate_in` is edge:'gate' (act WHILE high). A single
    // audition button, or two buttons of the same kind, would be the face
    // contradicting the def about the thing this module exists for.
    const dock = curatedFace(def, 'dock')!;
    const cellFor = (key: string) =>
      shellCellFor('snaredrum', dock.controls.find((c) => c.key === key)!)!;

    const hit = cellFor('snaredrum-hit-{n}');
    const roll = cellFor('snaredrum-roll-{n}');
    expect(hit.kind === 'action' && (hit.mode ?? 'trigger')).toBe('trigger');
    expect(roll.kind === 'action' && roll.mode).toBe('gate');

    const edgeOf = (id: string) => snaredrumDef.inputs.find((p) => p.id === id)!.edge;
    expect(edgeOf('trigger_in')).toBe('trigger');
    expect(edgeOf('gate_in')).toBe('gate');
  });

  it('neither audition is a PARAM, and the face declares no momentary param', () => {
    // `face.momentary` ids must be declared PARAMS; the pads are not params, so
    // the field stays absent. (A `strike` param would also force an ART
    // re-capture — the profile's sha covers the DSP sources.)
    const ids = new Set(snaredrumDef.params.map((p) => p.id));
    expect(ids.has('snaredrum-hit')).toBe(false);
    expect(ids.has('snaredrum-roll')).toBe(false);
    expect(snaredrumDef.face!.momentary ?? []).toEqual([]);
  });

  it('HARD is the only non-knob param cell, and the lane never has to render it', () => {
    expect(snaredrumDef.face!.paramCells ?? {}).toEqual({});
    for (const p of snaredrumDef.params) {
      const want = p.id === 'hard' ? 'toggle' : 'knob';
      expect(paramCellKind(p, momentary, 'dock'), `${p.id} renders as a ${want}`).toBe(want);
    }
    expect(keysAt('full')).not.toContain('hard');
  });
});

describe('snaredrum face — the REAR field', () => {
  it('is TOTAL: every declared port is addressed by exactly one hole, in six input sections', () => {
    const plan = rearFieldPlan(snaredrumDef);
    // PR-4: a derived stereo pair is ONE hole addressing TWO ports, so the
    // totality claim is over the ADDRESSED ports. snaredrum's `audio_l` /
    // `audio_r` outputs are that pair — one hole, two ports.
    const holes = rearSectionHoles([...plan.inputs, ...plan.outputs]);
    const addressed = holes.flatMap((h) =>
      h.stereoSiblingPortId ? [h.portId, h.stereoSiblingPortId] : [h.portId],
    );
    const declared = [
      ...snaredrumDef.inputs.map((p) => p.id),
      ...snaredrumDef.outputs.map((p) => p.id),
    ];
    expect([...addressed].sort(), 'no orphan, no duplicate').toEqual([...declared].sort());
    expect(plan.portCount).toBe(declared.length);
    expect(plan.holeCount).toBe(declared.length - 1); // the one collapsed pair
    expect(rearSectionHoles(plan.outputs).map((h) => h.portId)).toEqual(['audio_l']);
    expect(rearSectionHoles(plan.outputs)[0]!.stereoSiblingPortId).toBe('audio_r');
    expect(plan.inputs.map((b) => b.id)).toEqual(['voice', 'drum', 'snap', 'roll', 'whole', 'bus']);
  });

  it('no page id collides with the LEADING rear group id (the dx7 double-band scar)', () => {
    const leading = rearFieldPlan(snaredrumDef).inputs[0]!.id;
    expect(leading).toBe('voice');
    expect(snaredrumDef.face!.pages!.map((p) => p.id)).not.toContain(leading);
  });

  it('no rear input-section label PREFIXES another, and no page claims the word STRIKE', () => {
    // The KICK DRUM finding: two adjacent bands both headed STRIKE, the second
    // one's first hole being `tune_cv`, so patching a gate into the wrong one
    // silently detunes the drum. The REAR owns 'strike' on this module (it is
    // where trigger_in and gate_in are patched) and no front page takes it.
    const labels = rearFieldPlan(snaredrumDef).inputs.map((b) => b.label);
    for (const a of labels) {
      for (const b of labels) {
        if (a === b) continue;
        expect(b.startsWith(a), `rear section '${b}' is prefixed by '${a}'`).toBe(false);
      }
    }
    expect(labels[0]).toMatch(/^strike/);
    for (const p of snaredrumDef.face!.pages!) {
      expect(p.label.toLowerCase(), `page '${p.id}' must not claim the rear's word`).not.toContain('strike');
    }
  });

  it('the strike cluster TEACHES the trigger/gate split rather than restating the header', () => {
    const voice = rearFieldPlan(snaredrumDef).inputs[0]!;
    const strike = voice.clusters.find((c) => c.holes.some((h) => h.portId === 'trigger_in'))!;
    expect(strike.holes.map((h) => h.portId)).toEqual(['trigger_in', 'gate_in']);
    expect(
      strike.label,
      'the two jacks carry the same cable and the same voltage — the split is in how the ' +
        'module READS them, which is the one fact the holes cannot show',
    ).toBe('strike · hit or hold');
  });

  it('the SIX dedicated node inputs are the only audio-rate ticks', () => {
    // Every per-param CV lands on an 80 Hz-smoothed AudioParam; only the six
    // real worklet node inputs are read raw per sample.
    expect([...(snaredrumDef.face!.rear!.audioRate ?? [])].sort()).toEqual(
      ['accent_in', 'choke_in', 'gate_in', 'pitch_cv', 'roll_speed_cv', 'trigger_in'].sort(),
    );
    for (const id of snaredrumDef.face!.rear!.audioRate ?? []) {
      expect(
        snaredrumDef.inputs.find((p) => p.id === id)!.paramTarget,
        `${id} is a node input, not a per-param CV`,
      ).toBeUndefined();
    }
  });
});
