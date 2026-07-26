// rear-card-model.test.ts — the PURE rear-card derivation, pinned against the
// six P1 prototype defs (real defs, not fixtures — the grouping IS the spec's
// §4 tables) plus synthetic fixtures for the edge rules (orphan band, pitch
// tag, band-collapse threshold, dense rail, compatibility predicate).

import { describe, it, expect } from 'vitest';

import {
  rearFieldPlan,
  rearHoleAcceptsCarry,
  rearTargetParamId,
  REAR_COLLAPSE_THRESHOLD,
  type RearDefLike,
} from './rear-card-model';
import { canConnectToPort, type CableType } from '$lib/graph/types';

import { tidyVcoDef } from '$lib/audio/modules/tidy-vco';
import { kickdrumDef } from '$lib/audio/modules/kickdrum';
import { adsrDef } from '$lib/audio/modules/adsr';
import { vcaDef } from '$lib/audio/modules/vca';
import { lfoDef } from '$lib/audio/modules/lfo';
import { cloudseedDef } from '$lib/audio/modules/cloudseed';

const canConnect = (s: string, d: { type: string; accepts?: readonly string[] }) =>
  canConnectToPort(s as CableType, d as { type: CableType; accepts?: readonly CableType[] });

function bandIds(def: RearDefLike): string[] {
  return rearFieldPlan(def).bands.map((b) => b.id);
}

function bandPorts(def: RearDefLike, bandId: string): string[] {
  const band = rearFieldPlan(def).bands.find((b) => b.id === bandId);
  if (!band) return [];
  return [...band.holes.map((h) => h.portId), ...band.clusters.flatMap((c) => c.holes.map((h) => h.portId))];
}

/** TOTALITY: every declared port lands in exactly one band/rail slot — the
 *  no-orphan-holes guarantee behind "exposes ALL patch points". */
function expectTotal(def: RearDefLike): void {
  const plan = rearFieldPlan(def);
  const holes = [
    ...plan.bands.flatMap((b) => [...b.holes, ...b.clusters.flatMap((c) => c.holes)]),
    ...plan.outputs,
  ];
  const declared = [
    ...(def.inputs ?? []).map((p) => `input:${p.id}`),
    ...(def.outputs ?? []).map((p) => `output:${p.id}`),
  ];
  const rendered = holes.map((h) => `${h.direction}:${h.portId}`);
  expect(rendered.sort()).toEqual(declared.sort());
  expect(plan.holeCount).toBe(declared.length);
}

describe('rear-card derivation — the six P1 prototypes (spec §4)', () => {
  it('tidyVco: voice + 5 face-page bands, oscillator curated (pwm_cv), EG clusters, audio-rate ticks', () => {
    const plan = rearFieldPlan(tidyVcoDef as unknown as RearDefLike);
    expectTotal(tidyVcoDef as unknown as RearDefLike);
    expect(plan.holeCount).toBe(29); // 27 in + 2 out
    expect(bandIds(tidyVcoDef as unknown as RearDefLike)).toEqual([
      'voice',
      'oscillator',
      'wavefolder',
      'filter',
      'envelopes',
      'output',
    ]);

    // voice: poly · pitch · gate (▬), domains poly/cv/gate.
    const voice = plan.bands[0];
    expect(voice.holes.map((h) => [h.portId, h.domain])).toEqual([
      ['poly', 'poly'],
      ['pitch', 'cv'],
      ['gate', 'gate'],
    ]);
    expect(voice.holes[2].edge).toBe('gate');

    // oscillator: the CURATED band carries pwm_cv (its stem 'pwm' matches no
    // param — derivation alone would misfile it) labeled by FUNCTION.
    expect(bandPorts(tidyVcoDef as unknown as RearDefLike, 'oscillator')).toEqual([
      'shape1_cv',
      'shape2_cv',
      'pwm_cv',
      'detune_cv',
      'oct2_cv',
      'mix_cv',
      'sub_cv',
    ]);
    const pwm = plan.bands[1].holes.find((h) => h.portId === 'pwm_cv')!;
    expect(pwm.label).toBe('PWM');
    expect(pwm.audioRate).toBe(true);
    const shape1 = plan.bands[1].holes[0];
    expect(shape1.label).toBe('SHAPE 1'); // the target param's label, not SHAPE1_CV

    // envelopes: two curated clusters, filter eg then amp eg, nothing loose.
    const env = plan.bands[4];
    expect(env.holes).toEqual([]);
    expect(env.clusters.map((c) => c.label)).toEqual(['filter eg', 'amp eg']);
    expect(env.clusters[0].holes.map((h) => h.portId)).toEqual(['fatk_cv', 'fdec_cv', 'fsus_cv', 'frel_cv']);
    expect(env.clusters[1].holes.map((h) => h.portId)).toEqual(['atk_cv', 'dec_cv', 'sus_cv', 'rel_cv']);

    // the six worklet audio-rate CVs tick; a block-rate CV does not.
    const filter = plan.bands[3];
    expect(filter.holes.find((h) => h.portId === 'cutoff_cv')!.audioRate).toBe(true);
    expect(filter.holes.find((h) => h.portId === 'track_cv')!.audioRate).toBe(false);

    // OUTPUTS rail: stereo pair tie on out_r; audio domain; no pathology.
    expect(plan.outputs.map((h) => h.portId)).toEqual(['out_l', 'out_r']);
    expect(plan.outputs[1].pairWithPrev).toBe(true);
    expect(plan.outputs.every((h) => h.domain === 'audio')).toBe(true);
    expect(plan.collapse).toBe(false);
    expect(plan.denseRail).toBe(false);
  });

  it('kickdrum: pure derivation — voice band (trigger/accent/pitch/choke) + the 6 face pages', () => {
    const def = kickdrumDef as unknown as RearDefLike;
    expectTotal(def);
    expect(bandIds(def)).toEqual(['voice', 'sub', 'body', 'click', 'drive', 'dynamics', 'output']);
    const plan = rearFieldPlan(def);
    // pitch_cv's stem ('pitch') matches NO param → a VOICE port, not a CV.
    expect(plan.bands[0].holes.map((h) => h.portId)).toEqual([
      'trigger_in',
      'accent_in',
      'pitch_cv',
      'choke_in',
    ]);
    expect(plan.bands[0].holes[0].edge).toBe('trigger');
    expect(plan.bands[0].holes[3].edge).toBe('gate');
    // page bands hold the paramTarget CVs in page-control order.
    expect(bandPorts(def, 'sub')).toEqual(['tune_cv', 'sub_decay_cv', 'sub_level_cv', 'sub_eq_cv', 'translate_cv']);
    expect(bandPorts(def, 'dynamics')).toEqual(['attack_cv', 'sustain_cv', 'glue_cv', 'ceiling_cv']);
    // FUNCTION labels: the target param's label, uppercased.
    expect(plan.bands[1].holes[0].label).toBe(kickdrumDef.params!.find((p) => p.id === 'tune')!.label!.toUpperCase());
  });

  it('adsr: voice(gate) + stages; env/env_inv rail without a stereo tie', () => {
    const def = adsrDef as unknown as RearDefLike;
    expectTotal(def);
    expect(bandIds(def)).toEqual(['voice', 'stages']);
    expect(bandPorts(def, 'stages')).toEqual(['attack', 'decay', 'sustain', 'release']);
    const plan = rearFieldPlan(def);
    expect(plan.outputs.map((h) => [h.portId, h.domain])).toEqual([
      ['env', 'cv'],
      ['env_inv', 'cv'],
    ]);
    expect(plan.outputs[1].pairWithPrev).toBeUndefined();
  });

  it('vca: curated signal → gain stage split (neither input is a per-param CV)', () => {
    const def = vcaDef as unknown as RearDefLike;
    expectTotal(def);
    const plan = rearFieldPlan(def);
    expect(plan.bands.map((b) => [b.id, b.label])).toEqual([
      ['signal', 'signal'],
      ['gain', 'gain stage'],
    ]);
    expect(bandPorts(def, 'signal')).toEqual(['audio']);
    expect(bandPorts(def, 'gain')).toEqual(['cv']);
    expect(plan.outputs.map((h) => h.label)).toEqual(['AUDIO', 'AUDIO INV']);
  });

  it('lfo: voice(clock) + shape/engine page bands; 4-phase cv rail', () => {
    const def = lfoDef as unknown as RearDefLike;
    expectTotal(def);
    expect(bandIds(def)).toEqual(['voice', 'shape', 'engine']);
    expect(bandPorts(def, 'engine')).toEqual(['rate', 'depth_cv']);
    const plan = rearFieldPlan(def);
    expect(plan.outputs.map((h) => h.portId)).toEqual(['phase0', 'phase90', 'phase180', 'phase270']);
    expect(plan.denseRail).toBe(false); // 4 ≤ 8 — single-column rail
  });

  it('cloudseed: SPARSE CV coverage — pages with no CV holes do not render as bands', () => {
    const def = cloudseedDef as unknown as RearDefLike;
    expectTotal(def);
    // 8 declared pages, but only blend/input/output have CV targets; the
    // signal band leads with the stereo audio ins.
    expect(bandIds(def)).toEqual(['signal', 'blend', 'input', 'output']);
    expect(bandPorts(def, 'signal')).toEqual(['in_l', 'in_r']);
    expect(bandPorts(def, 'blend')).toEqual(['dry_cv', 'early_cv', 'late_cv']);
    expect(bandPorts(def, 'input')).toEqual(['input_mix_cv', 'low_cut_cv']);
    expect(bandPorts(def, 'output')).toEqual(['high_cut_cv', 'cross_seed_cv']);
  });
});

describe('rear-card derivation — edge rules (synthetic)', () => {
  it('per-param CVs whose target is in NO page fall to the trailing cv band', () => {
    const def: RearDefLike = {
      inputs: [
        { id: 'gate', type: 'gate' },
        { id: 'wild_cv', type: 'cv', paramTarget: 'wild' },
      ],
      outputs: [{ id: 'out', type: 'audio' }],
      params: [{ id: 'wild', label: 'Wild' }],
      face: { order: ['wild'], pages: [{ id: 'p1', label: 'page 1', controls: [] }] },
    };
    const plan = rearFieldPlan(def);
    expect(plan.bands.map((b) => b.id)).toEqual(['voice', 'cv']);
    expect(plan.bands[1].holes[0].label).toBe('WILD');
  });

  it('a def with no face still derives (voice/signal + rail) — buildable for ANY module', () => {
    const def: RearDefLike = {
      inputs: [
        { id: 'in_l', type: 'audio' },
        { id: 'in_r', type: 'audio' },
      ],
      outputs: [{ id: 'out', type: 'audio' }],
    };
    const plan = rearFieldPlan(def);
    expect(plan.bands.map((b) => b.id)).toEqual(['signal']); // no gate/poly → signal
    expect(plan.holeCount).toBe(3);
  });

  it('pitch-cable holes read cv-green + the 1v/oct tag (spec §1.4 Q2)', () => {
    const def: RearDefLike = {
      inputs: [{ id: 'pitch', type: 'pitch' }],
      outputs: [],
    };
    const hole = rearFieldPlan(def).bands[0].holes[0];
    expect(hole.domain).toBe('cv');
    expect(hole.pitch).toBe(true);
  });

  it(`band-collapse arms only past ${REAR_COLLAPSE_THRESHOLD} holes; dense rail past 8 outs`, () => {
    const many = (n: number, mk: (i: number) => { id: string; type: string }) =>
      Array.from({ length: n }, (_, i) => mk(i));
    const under: RearDefLike = {
      inputs: many(40, (i) => ({ id: `a${i}`, type: 'cv' })),
      outputs: many(8, (i) => ({ id: `o${i}`, type: 'cv' })),
    };
    expect(rearFieldPlan(under).collapse).toBe(false);
    expect(rearFieldPlan(under).denseRail).toBe(false);
    const over: RearDefLike = {
      inputs: many(52, (i) => ({ id: `a${i}`, type: 'cv' })),
      outputs: many(9, (i) => ({ id: `o${i}`, type: 'cv' })),
    };
    expect(rearFieldPlan(over).collapse).toBe(true); // 61 holes
    expect(rearFieldPlan(over).denseRail).toBe(true);
  });

  it('rearTargetParamId: paramTarget wins, then the _cv stem, else undefined', () => {
    expect(rearTargetParamId({ id: 'x_cv', type: 'cv', paramTarget: 'y' })).toBe('y');
    expect(rearTargetParamId({ id: 'x_cv', type: 'cv' })).toBe('x');
    expect(rearTargetParamId({ id: 'gate', type: 'gate' })).toBeUndefined();
  });
});

describe('compatibility dim predicate (spec §2.2) — mirrors the commit gate', () => {
  it('carried OUTPUT lights only inputs its cable can feed', () => {
    const carried = { handleType: 'source' as const, cableType: 'cv' };
    expect(
      rearHoleAcceptsCarry({ direction: 'input', cable: 'cv' }, undefined, carried, canConnect),
    ).toBe(true);
    expect(
      rearHoleAcceptsCarry({ direction: 'input', cable: 'gate' }, undefined, carried, canConnect),
    ).toBe(true); // CV family interchange
    expect(
      rearHoleAcceptsCarry({ direction: 'input', cable: 'audio' }, undefined, carried, canConnect),
    ).toBe(false); // cv → audio rejected
    expect(
      rearHoleAcceptsCarry({ direction: 'output', cable: 'cv' }, undefined, carried, canConnect),
    ).toBe(false); // outputs never terminate a carried output
  });

  it('carried INPUT (rewire) lights only outputs whose cable it accepts', () => {
    const carried = { handleType: 'target' as const, cableType: 'audio' };
    expect(
      rearHoleAcceptsCarry({ direction: 'output', cable: 'audio' }, undefined, carried, canConnect),
    ).toBe(true);
    expect(
      rearHoleAcceptsCarry({ direction: 'output', cable: 'cv' }, undefined, carried, canConnect),
    ).toBe(false);
    expect(
      rearHoleAcceptsCarry({ direction: 'input', cable: 'audio' }, undefined, carried, canConnect),
    ).toBe(false);
  });

  it('per-port accepts widening is honoured (SCOPE-style audio input taking cv)', () => {
    const carried = { handleType: 'source' as const, cableType: 'cv' };
    expect(
      rearHoleAcceptsCarry({ direction: 'input', cable: 'audio' }, ['cv'], carried, canConnect),
    ).toBe(true);
  });
});
