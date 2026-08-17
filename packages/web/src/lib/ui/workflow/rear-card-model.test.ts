// rear-card-model.test.ts — the PURE rear-card derivation, pinned against the
// six P1 prototype defs (real defs, not fixtures — the grouping IS the design)
// plus synthetic fixtures for the edge rules (orphan section, pitch tag,
// density step, derived + authored output sectioning, compatibility predicate).

import { describe, it, expect } from 'vitest';

import {
  rearFieldPlan,
  rearHoleAcceptsCarry,
  rearSectionColumns,
  rearSectionHoles,
  rearTargetParamId,
  REAR_DENSE_ROWS,
  REAR_MAX_SECTION_COLUMNS,
  REAR_OUTPUT_SPLIT_ROWS,
  REAR_ROWS_PER_COLUMN,
  type RearDefLike,
} from './rear-card-model';
import { canConnectToPort, type CableType } from '$lib/graph/types';

import { tidyVcoDef } from '$lib/audio/modules/tidy-vco';
import { kickdrumDef } from '$lib/audio/modules/kickdrum';
import { adsrDef } from '$lib/audio/modules/adsr';
import { vcaDef } from '$lib/audio/modules/vca';
import { lfoDef } from '$lib/audio/modules/lfo';
import { cloudseedDef } from '$lib/audio/modules/cloudseed';
import { delayDef } from '$lib/audio/modules/delay';
// The three modules whose outputs-rail tie MOVES under the pairing
// unification, plus rings (derived-but-exempt) — see the last describe block.
import { gamepadDef } from '$lib/audio/modules/gamepad';
import { sidecarDef } from '$lib/audio/modules/sidecar';
import { audioInDef } from '$lib/audio/modules/audioin';
import { ringsDef } from '$lib/audio/modules/rings';
// The registry's biggest fields — the pathological-port-count block at the end.
import { mixmstrsDef } from '$lib/audio/modules/mixmstrs';
import { es9Def } from '$lib/audio/modules/es9';
import { synesthesiaDef } from '$lib/audio/modules/synesthesia';

const canConnect = (s: string, d: { type: string; accepts?: readonly string[] }) =>
  canConnectToPort(s as CableType, d as { type: CableType; accepts?: readonly CableType[] });

function bandIds(def: RearDefLike): string[] {
  return rearFieldPlan(def).inputs.map((b) => b.id);
}

function bandPorts(def: RearDefLike, bandId: string): string[] {
  const band = rearFieldPlan(def).inputs.find((b) => b.id === bandId);
  if (!band) return [];
  return [...band.holes.map((h) => h.portId), ...band.clusters.flatMap((c) => c.holes.map((h) => h.portId))];
}

/** The output rail's holes, flattened across its sections (#1800: the rail is a
 *  list of SECTIONS now, the same type the input side has always used). */
function outHoles(def: RearDefLike) {
  return rearSectionHoles(rearFieldPlan(def).outputs);
}

/** TOTALITY: every declared port is ADDRESSED by exactly one hole — the
 *  no-orphan-holes guarantee behind "exposes ALL patch points".
 *
 *  ⚠ PR-4: a hole is no longer 1:1 with a port. A derived stereo pair renders
 *  as ONE hole addressing TWO ports (`stereoSiblingPortId`), so the invariant
 *  is stated over the addressed-port set, and `holeCount` (rendered holes) is
 *  cross-checked against `portCount` (ports covered). Comparing holes to ports
 *  directly would have silently become an assertion about nothing.
 *
 *  ⚠ #1800: `direction` is read off the HOLE and cross-checked against the
 *  SECTION that holds it. Both rails are the same type now, so "an input hole
 *  filed into an output section" is expressible for the first time — and it
 *  would leave totality perfectly green while putting a jack on the wrong side
 *  of the card. */
function expectTotal(def: RearDefLike): void {
  const plan = rearFieldPlan(def);
  const sections = [...plan.inputs, ...plan.outputs];
  for (const sec of sections) {
    for (const h of [...sec.holes, ...sec.clusters.flatMap((c) => c.holes)]) {
      expect(h.direction, `hole '${h.portId}' sits in ${sec.direction} section '${sec.id}'`).toBe(
        sec.direction,
      );
    }
  }
  const holes = rearSectionHoles(sections);
  const declared = [
    ...(def.inputs ?? []).map((p) => `input:${p.id}`),
    ...(def.outputs ?? []).map((p) => `output:${p.id}`),
  ];
  const rendered = holes.flatMap((h) =>
    h.stereoSiblingPortId
      ? [`${h.direction}:${h.portId}`, `${h.direction}:${h.stereoSiblingPortId}`]
      : [`${h.direction}:${h.portId}`],
  );
  expect(rendered.sort()).toEqual(declared.sort());
  expect(plan.portCount).toBe(declared.length);
  expect(plan.holeCount).toBe(holes.length);
  // A collapsed pair costs exactly one hole; nothing else may.
  const collapsed = holes.filter((h) => h.stereoSiblingPortId).length;
  expect(plan.holeCount).toBe(plan.portCount - collapsed);
}

describe('rear-card derivation — the six P1 prototypes (spec §4)', () => {
  it('tidyVco: play + 5 face-page bands, oscillator curated (pwm_cv), EG clusters, audio-rate ticks', () => {
    const plan = rearFieldPlan(tidyVcoDef as unknown as RearDefLike);
    // `expectTotal` already asserts holeCount/portCount against the DEF's own
    // port lists, and against the collapsed pairs it measured — the literal
    // `28 HOLES for 29 declared ports` that used to sit here was a hand-typed
    // population count of tidyVco's ports (CLAUDE.md P0) and was strictly
    // weaker than the derived check beside it.
    expectTotal(tidyVcoDef as unknown as RearDefLike);
    // ONE collapsed pair on this def: `out_l`+`out_r`.
    expect(plan.portCount - plan.holeCount, 'exactly one collapsed stereo pair').toBe(1);
    expect(bandIds(tidyVcoDef as unknown as RearDefLike)).toEqual([
      'voice',
      'oscillator',
      'wavefolder',
      'filter',
      'envelopes',
      'output',
    ]);

    // The leading band is PINNED + renamed `play` (batch F) and split into the
    // two MUTUALLY EXCLUSIVE sources: poly wins the moment any lane is gated
    // and the mono pair goes dead. Derivation would head it `voice`, which
    // names the band without teaching the arbitration.
    const play = plan.inputs[0];
    expect(play.id, 'the leading-slot claim key is still `voice`').toBe('voice');
    expect(play.label).toBe('play');
    expect(play.holes, 'both sources are clustered — nothing loose').toEqual([]);
    expect(play.clusters.map((c) => c.label)).toEqual(['poly bus', 'mono (fallback)']);
    expect(
      play.clusters.flatMap((c) => c.holes.map((h) => [h.portId, h.domain])),
      'poly · pitch · gate (▬), domains poly/cv/gate',
    ).toEqual([
      ['poly', 'poly'],
      ['pitch', 'cv'],
      ['gate', 'gate'],
    ]);
    expect(play.clusters[1].holes[1].edge).toBe('gate');

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
    const pwm = plan.inputs[1].holes.find((h) => h.portId === 'pwm_cv')!;
    expect(pwm.label).toBe('PWM');
    expect(pwm.audioRate).toBe(true);
    const shape1 = plan.inputs[1].holes[0];
    expect(shape1.label).toBe('SHAPE 1'); // the target param's label, not SHAPE1_CV

    // envelopes: two curated clusters, filter eg then amp eg, nothing loose.
    const env = plan.inputs[4];
    expect(env.holes).toEqual([]);
    expect(env.clusters.map((c) => c.label)).toEqual(['filter eg', 'amp eg']);
    expect(env.clusters[0].holes.map((h) => h.portId)).toEqual(['fatk_cv', 'fdec_cv', 'fsus_cv', 'frel_cv']);
    expect(env.clusters[1].holes.map((h) => h.portId)).toEqual(['atk_cv', 'dec_cv', 'sus_cv', 'rel_cv']);

    // the four worklet audio-rate CVs tick; a block-rate CV does not. RES and
    // DRIVE are deliberately NOT ticked: the worklet reads them once per block
    // (`inputs[i]?.[0]?.[0]` — they re-derive solver coefficients), unlike
    // cutoff/pwm/fold/sym which it reads over the whole block.
    const filter = plan.inputs[3];
    expect(filter.holes.find((h) => h.portId === 'cutoff_cv')!.audioRate).toBe(true);
    expect(filter.holes.find((h) => h.portId === 'res_cv')!.audioRate).toBe(false);
    expect(filter.holes.find((h) => h.portId === 'drive_cv')!.audioRate).toBe(false);
    expect(filter.holes.find((h) => h.portId === 'track_cv')!.audioRate).toBe(false);
    expect(plan.inputs[2].holes.every((h) => h.audioRate)).toBe(true); // wavefolder: fold + sym

    // OUTPUTS rail: ONE stereo hole (PR-4, owner Q5 — the pair-tie retired).
    // `out_l`+`out_r` render as a single OUT jack addressed to the LEFT leg,
    // and the hole names its sibling so a click patches the whole image.
    const outs = outHoles(tidyVcoDef as unknown as RearDefLike);
    expect(outs.map((h) => h.portId)).toEqual(['out_l']);
    expect(outs[0].stereoSiblingPortId).toBe('out_r');
    expect(outs[0].label).toBe('OUT');
    expect(outs.every((h) => h.domain === 'audio')).toBe(true);
    // #1800: a homogeneous rail derives ONE section, and it is an OUTPUT
    // section — the same type the input side uses, carrying its own direction.
    expect(plan.outputs.map((s) => [s.id, s.direction])).toEqual([['out', 'output']]);
    expect(plan.dense).toBe(false);
  });

  it('kickdrum: curated STRIKE band + the 5 face pages, body + dynamics each split into two clusters', () => {
    const def = kickdrumDef as unknown as RearDefLike;
    expectTotal(def);
    // FIVE page bands, not six: `dynamics` and `output` merged on the front
    // (one mastering chain — shaper → glue → ceiling → stereo → level), and
    // the rear follows because rear bands are a PROJECTION of face.pages.
    expect(bandIds(def)).toEqual(['voice', 'sub', 'body', 'click', 'drive', 'dynamics']);
    const plan = rearFieldPlan(def);
    // the four performance inputs are PINNED (pitch_cv's `_cv` stem would
    // otherwise follow any future `pitch` param into a page band) and the band
    // is headed by FUNCTION — 'strike', not the derived 'voice'.
    expect(plan.inputs[0].label).toBe('strike');
    expect(plan.inputs[0].holes.map((h) => h.portId)).toEqual([
      'trigger_in',
      'accent_in',
      'pitch_cv',
      'choke_in',
    ]);
    expect(plan.inputs[0].holes[0].edge).toBe('trigger');
    expect(plan.inputs[0].holes[3].edge).toBe('gate');
    // `~` on PITCH alone: the worklet reads it raw per sample (1 V/oct FM),
    // while every per-param CV lands on an 80 Hz-smoothed AudioParam.
    expect(plan.inputs[0].holes.filter((h) => h.audioRate).map((h) => h.portId)).toEqual(['pitch_cv']);
    // page bands hold the paramTarget CVs in page-control order. The 'sub'
    // page leads with the `kickdrum-strike-{n}` FAMILY key (the audition), and
    // a family key targets no port — so it contributes nothing here and the
    // hole order is unchanged. That is the property this line pins.
    expect(bandPorts(def, 'sub')).toEqual(['tune_cv', 'sub_decay_cv', 'sub_level_cv', 'sub_eq_cv', 'translate_cv']);
    // …and that band is RE-HEADED on the rear. The front page is 'strike · the
    // pulse' because it holds the strike BUTTON; here the same id resolves to
    // five sub-layer CVs sitting directly under the band that IS the strike,
    // and its first hole is `tune_cv` — a gate patched into the wrong STRIKE
    // detunes the drum instead of hitting it. A curated group whose id matches
    // the page id claims the slot and its label wins.
    expect(plan.inputs.find((b) => b.id === 'sub')!.label).toBe('sub · the layer');
    // the merged band's SIX holes split the same way the front's PF-9 clusters
    // do, so both faces of the card teach the same chain — and that chain is
    // the DSP's real one: transient → glue → LEVEL → width → CEILING.
    const dyn = plan.inputs.find((b) => b.id === 'dynamics')!;
    expect(dyn.holes).toEqual([]);
    expect(dyn.clusters.map((c) => c.label)).toEqual(['transient · glue', 'level · width · ceiling']);
    expect(dyn.clusters[0].holes.map((h) => h.portId)).toEqual(['attack_cv', 'sustain_cv', 'glue_cv']);
    expect(dyn.clusters[1].holes.map((h) => h.portId)).toEqual(['level_cv', 'width_cv', 'ceiling_cv']);
    // the widest band (7 holes) splits into the pitch envelope + the tone.
    const body = plan.inputs.find((b) => b.id === 'body')!;
    expect(body.holes).toEqual([]);
    expect(body.clusters.map((c) => c.label)).toEqual(['pitch envelope', 'tone']);
    expect(body.clusters[0].holes.map((h) => h.portId)).toEqual(['pitch_amt_cv', 'pitch_time_cv', 'tension_cv']);
    expect(body.clusters[1].holes.map((h) => h.portId)).toEqual([
      'body_decay_cv',
      'body_level_cv',
      'body_shape_cv',
      'body_eq_cv',
    ]);
    // FUNCTION labels: the target param's label, uppercased.
    expect(plan.inputs[1].holes[0].label).toBe(kickdrumDef.params!.find((p) => p.id === 'tune')!.label!.toUpperCase());
  });

  it('adsr: curated GATE band + stages clustered by CV law; env/env_inv rail without a stereo tie', () => {
    const def = adsrDef as unknown as RearDefLike;
    expectTotal(def);
    expect(bandIds(def)).toEqual(['voice', 'stages']);
    const plan = rearFieldPlan(def);
    // an envelope is driven, not voiced — the leading band says 'gate'.
    expect(plan.inputs[0].label).toBe('gate');
    expect(plan.inputs[0].holes.map((h) => h.portId)).toEqual(['gate']);
    // stages mirrors the dock page but clusters the log TIME jacks apart from
    // the linear SUSTAIN level (the param labels are bare letters A/D/S/R).
    expect(bandPorts(def, 'stages')).toEqual(['attack', 'decay', 'release', 'sustain']);
    const stages = plan.inputs[1];
    // …and it is PINNED, so the band does NOT inherit the dock page's label.
    // The front page reads 'gate → attack · decay · sustain · release' (the
    // gate is a real control-surface input there); on the rear that would head
    // a band of four CV holes and no gate at all.
    expect(stages.label).toBe('stage cv');
    expect(stages.holes).toEqual([]);
    expect(stages.clusters.map((c) => c.label)).toEqual(['times', 'level']);
    expect(stages.clusters[1].holes.map((h) => h.portId)).toEqual(['sustain']);
    // nothing on an ADSR is an audio-rate destination.
    expect(plan.inputs.flatMap((b) => [...b.holes, ...b.clusters.flatMap((c) => c.holes)]).some((h) => h.audioRate)).toBe(false);
    expect(outHoles(def).map((h) => [h.portId, h.domain])).toEqual([
      ['env', 'cv'],
      ['env_inv', 'cv'],
    ]);
    // cv-typed, so not a derived pair at all — two holes, no collapse.
    expect(outHoles(def)[1].stereoSiblingPortId).toBeUndefined();
  });

  it('vca: curated signal → gain cv split (neither input is a per-param CV)', () => {
    const def = vcaDef as unknown as RearDefLike;
    expectTotal(def);
    const plan = rearFieldPlan(def);
    expect(plan.inputs.map((b) => [b.id, b.label])).toEqual([
      ['signal', 'signal'],
      ['gain', 'gain cv'],
    ]);
    expect(bandPorts(def, 'signal')).toEqual(['audio']);
    expect(bandPorts(def, 'gain')).toEqual(['cv']);
    // PF-4: the def authors these, so the rear stops printing `AUDIO` on BOTH
    // rails (the input hole is `AUDIO`) and the pair shares a stem.
    expect(outHoles(def).map((h) => h.label)).toEqual(['OUT', 'OUT INV']);
    expect(outHoles(def)[1].stereoSiblingPortId).toBeUndefined(); // not an L/R pair
  });

  it('vca: the page id `gain` COLLIDING with the rear group id `gain` is intentional', () => {
    // The curated group claims the page's rear slot and its LABEL wins, which
    // is the whole reason the rear reads `gain cv` while the dock band header
    // reads the gain law. It is NOT the dx7 `voice` double-render bug: that one
    // fires because the voice/signal slot claim pushes a band BEFORE the page
    // loop can also match it. Pin both halves so a rename of either desyncs
    // loudly instead of silently.
    const def = vcaDef as unknown as RearDefLike;
    const pageIds = (def.face?.pages ?? []).map((p) => p.id);
    const groupIds = (def.face?.rear?.groups ?? []).map((g) => g.id);
    expect(pageIds).toEqual(['gain']);
    expect(groupIds).toEqual(['signal', 'gain']);
    // The colliding id renders ONCE, and every declared port still lands.
    const plan = rearFieldPlan(def);
    expect(plan.inputs.filter((b) => b.id === 'gain')).toHaveLength(1);
    expect(plan.holeCount).toBe(4);
  });

  it('lfo: curated SYNC band + ONE engine page band, signal-ordered; 4-phase cv rail', () => {
    const def = lfoDef as unknown as RearDefLike;
    expectTotal(def);
    // The face collapsed its two pages into one (a single oscillator has no
    // second stage to separate), and rear CV bands DERIVE from face.pages — so
    // the rear followed. Ports run in the page's control order, which is the
    // SIGNAL CHAIN (rate → shape → depth), not face.order's ranking.
    expect(bandIds(def)).toEqual(['voice', 'engine']);
    expect(bandPorts(def, 'engine')).toEqual(['rate', 'shape', 'depth_cv']);
    const plan = rearFieldPlan(def);
    // a modulation source, not a voice: the clock hole's band says 'sync'.
    expect(plan.inputs[0].label).toBe('sync');
    expect(plan.inputs[0].holes.map((h) => h.portId)).toEqual(['clock']);
    // …and the hole now declares its consumer semantic: one reset per RISING
    // edge, nothing on the fall, nothing while held.
    expect(plan.inputs[0].holes[0].edge).toBe('trigger');
    // `~` ticks track the WORKLET, not a blanket claim about the module: RATE
    // is hoisted out of the sample loop (`rateHeld`) to keep clients phase-
    // aligned, while SHAPE and DEPTH are read per-sample. The face used to say
    // none of them was audio-rate; two of them are.
    const byPort = new Map(plan.inputs.flatMap((b) => b.holes).map((h) => [h.portId, h]));
    expect(byPort.get('rate')!.audioRate).toBeFalsy();
    expect(byPort.get('shape')!.audioRate).toBe(true);
    expect(byPort.get('depth_cv')!.audioRate).toBe(true);
    expect(outHoles(def).map((h) => h.portId)).toEqual(['phase0', 'phase90', 'phase180', 'phase270']);
    // PF-4: the taps are named on the DEF, so the rail reads the angle rather
    // than `PHASE0` (id derivation) — and the card cannot disagree with it.
    expect(outHoles(def).map((h) => h.label)).toEqual(['0°', '90°', '180° (ANTI)', '270°']);
    // FOUR cv taps, one domain: the derived grouping gives them ONE section.
    expect(plan.outputs.map((s) => s.id)).toEqual(['out']);
  });

  it('cloudseed: SPARSE CV coverage — pages with no CV holes do not render as bands', () => {
    const def = cloudseedDef as unknown as RearDefLike;
    expectTotal(def);
    // 8 declared pages, but only space/input/seeds have CV targets; the
    // curated stereo-insert band leads with the two audio ins.
    expect(bandIds(def)).toEqual(['signal', 'space', 'input', 'seeds']);
    expect(rearFieldPlan(def).inputs[0].label).toBe('stereo in');
    // ONE stereo hole (PR-4): the curated 'stereo in' band leads with the
    // collapsed pair, addressed to the LEFT leg.
    expect(bandPorts(def, 'signal')).toEqual(['in_l']);
    // Band membership derives in PAGE-CONTROL order, so the re-ranked face
    // shows LATE first — the fader that means "how much reverb" now leads the
    // rear the same way it leads the lane.
    expect(bandPorts(def, 'space')).toEqual(['late_cv', 'dry_cv', 'early_cv']);
    // The re-paging put BOTH wet-path cut corners on the input page (the docs
    // always described them as one pair; the old face split them across
    // 'input stage' and 'output stage'), and the curated cluster pulls the two
    // of them into a `wet tone cuts` sub-header, leaving IN MIX un-clustered.
    expect(bandPorts(def, 'input')).toEqual(['input_mix_cv', 'low_cut_cv', 'high_cut_cv']);
    const input = rearFieldPlan(def).inputs.find((b) => b.id === 'input')!;
    expect(input.holes.map((h) => h.portId)).toEqual(['input_mix_cv']);
    expect(input.clusters.map((c) => c.label)).toEqual(['wet tone cuts']);
    expect(input.clusters[0].holes.map((h) => h.portId)).toEqual(['low_cut_cv', 'high_cut_cv']);
    expect(bandPorts(def, 'seeds')).toEqual(['cross_seed_cv']);
  });

  it('delay: the page collapse forces the TIME CV out of derivation into its own band', () => {
    // THE CASE THE COLLAPSE CREATES. `time` is a per-param CV, so derivation
    // files it under the band named after its param's PAGE. With two pages that
    // was `delay line` — a fine jack label. With one page it would have become
    // the collapsed page's whole topology sentence ('one line, fed back · mix
    // is outside the loop'), which heads a dock band and not a rear one. The
    // curated group RE-HEADS that page slot (the vca `gain` / kickdrum `sub`
    // mechanism), which is why its id is the PAGE id rather than a fresh one:
    // a non-page id would append as a stray band, which module-face-lint
    // refuses precisely because the totality gate counts holes, not order.
    const def = delayDef as unknown as RearDefLike;
    expectTotal(def);
    const plan = rearFieldPlan(def);
    expect(plan.inputs.map((b) => [b.id, b.label])).toEqual([
      ['signal', 'mono in'],
      ['echo', 'time cv · varispeeds the line'],
    ]);
    expect(bandPorts(def, 'signal')).toEqual(['audio']);
    expect(bandPorts(def, 'echo')).toEqual(['time']);
    // The curated LABEL wins over the page's own — that is the whole point of
    // re-heading, and it is what keeps a dock band header off the rear card.
    expect((def.face?.pages ?? [])[0]?.label).not.toBe(plan.inputs[1].label);
    // 3 declared ports → 3 holes. `expectTotal` proves nothing is lost; this
    // proves nothing is DOUBLED, which is the failure mode the LEADING-slot
    // collision produces (the dx7 scar) — `signal` here is not a page id.
    expect(plan.inputs.filter((b) => b.id === 'echo')).toHaveLength(1);
    expect(plan.holeCount).toBe(3);
    // The `~` tick is the module's one genuinely audio-rate destination:
    // DelayNode.delayTime is an a-rate AudioParam and the CV reaches it through
    // a plain WaveShaper with no de-zipping.
    const timeHole = plan.inputs[1].holes[0];
    expect(timeHole.audioRate).toBe(true);
    expect(outHoles(def).map((h) => [h.portId, h.domain])).toEqual([['audio', 'audio']]);
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
    expect(plan.inputs.map((b) => b.id)).toEqual(['voice', 'cv']);
    expect(plan.inputs[1].holes[0].label).toBe('WILD');
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
    expect(plan.inputs.map((b) => b.id)).toEqual(['signal']); // no gate/poly → signal
    // 2 holes for 3 ports: the token-derived `in_l`/`in_r` pair collapses even
    // with no `stereoPairs` declaration and no `face` at all.
    expect(plan.holeCount).toBe(2);
    expect(plan.portCount).toBe(3);
    expect(plan.inputs[0].holes[0].stereoSiblingPortId).toBe('in_r');
  });

  it('pitch-cable holes read cv-green + the 1v/oct tag (spec §1.4 Q2)', () => {
    const def: RearDefLike = {
      inputs: [{ id: 'pitch', type: 'pitch' }],
      outputs: [],
    };
    const hole = rearFieldPlan(def).inputs[0].holes[0];
    expect(hole.domain).toBe('cv');
    expect(hole.pitch).toBe(true);
  });

  it(`the DENSITY step arms past ${REAR_DENSE_ROWS} rendered rows — and hides nothing`, () => {
    // ⚠ THE REPLACEMENT FOR BAND-COLLAPSE, and the point of the second half of
    // this test. Band-collapse kept a band's holes OUT of the plan until the
    // user expanded it; `dense` is a pure RENDERING step, so the plan it
    // reports is identical either side of the threshold. Assert that
    // explicitly — "the fallback no longer hides patch points" is the whole
    // behavioural claim and it is invisible in the boolean alone.
    const many = (n: number, mk: (i: number) => { id: string; type: string }) =>
      Array.from({ length: n }, (_, i) => mk(i));
    const rows = (d: RearDefLike) => rearSectionHoles([...rearFieldPlan(d).inputs, ...rearFieldPlan(d).outputs]);

    const under: RearDefLike = {
      inputs: many(REAR_DENSE_ROWS - 4, (i) => ({ id: `a${i}`, type: 'cv' })),
      outputs: many(2, (i) => ({ id: `o${i}`, type: 'cv' })),
    };
    expect(rearFieldPlan(under).dense).toBe(false);
    expect(rows(under)).toHaveLength(rearFieldPlan(under).holeCount);

    const over: RearDefLike = {
      inputs: many(REAR_DENSE_ROWS, (i) => ({ id: `a${i}`, type: 'cv' })),
      outputs: many(4, (i) => ({ id: `o${i}`, type: 'cv' })),
    };
    const overPlan = rearFieldPlan(over);
    expect(overPlan.dense).toBe(true);
    // EVERY declared port still has its hole past the threshold.
    expect(rows(over)).toHaveLength(overPlan.holeCount);
    expect(overPlan.portCount).toBe((over.inputs?.length ?? 0) + (over.outputs?.length ?? 0));
    expectTotal(over);
  });

  it('rearTargetParamId: paramTarget wins, then the _cv stem, else undefined', () => {
    expect(rearTargetParamId({ id: 'x_cv', type: 'cv', paramTarget: 'y' })).toBe('y');
    expect(rearTargetParamId({ id: 'x_cv', type: 'cv' })).toBe('x');
    expect(rearTargetParamId({ id: 'gate', type: 'gate' })).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// #1800 — OUTPUT SECTIONS: the authored surface and the derived default.
//
// The rail used to be a bare hole list with no grouping at all. It is now the
// same `RearSection` shape the input side uses, which is what lets both rails
// render one row grammar into columns.
// ────────────────────────────────────────────────────────────────────────────
describe('rear-card output sections (#1800)', () => {
  const outs = (n: number, type: string, prefix = 'o') =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, type }));

  it('DERIVED DEFAULT: a homogeneous rail is ONE `out` section, whatever its length', () => {
    // The 190-modules-author-nothing case. A heading per one-row group would be
    // chrome, not grouping, so the default stays one section even well past the
    // split threshold when there is only one domain to split on.
    for (const n of [1, 4, REAR_OUTPUT_SPLIT_ROWS + 8]) {
      const plan = rearFieldPlan({ inputs: [], outputs: outs(n, 'cv') });
      expect(plan.outputs.map((s) => s.id), `${n} cv outs`).toEqual(['out']);
      expect(plan.outputs[0].label).toBe('out');
      expect(plan.outputs[0].holes).toHaveLength(n);
    }
  });

  it('DERIVED DEFAULT: a MIXED rail stays one section until it out-runs a column', () => {
    // Two taps of different domains do not earn two headings.
    const small = rearFieldPlan({
      inputs: [],
      outputs: [
        { id: 'audio', type: 'audio' },
        { id: 'eoc', type: 'gate' },
      ],
    });
    expect(small.outputs.map((s) => s.id)).toEqual(['out']);
    expect(small.dense).toBe(false);
  });

  it('DERIVED DEFAULT: past the column, a mixed rail splits BY CABLE DOMAIN, declared order', () => {
    // Contract-DERIVED, not guessed: the split key is `PortDef.type`, the same
    // declaration the hole's colour already reads, so the two channels agree
    // instead of competing. This is what makes a 30-tap interface scannable
    // with nothing hand-authored.
    const def: RearDefLike = {
      inputs: [],
      outputs: [
        ...outs(REAR_OUTPUT_SPLIT_ROWS, 'gate', 'g'),
        ...outs(3, 'cv', 'c'),
        { id: 'mix', type: 'audio' },
      ],
    };
    const plan = rearFieldPlan(def);
    expect(plan.outputs.map((s) => s.id)).toEqual(['out-gate', 'out-cv', 'out-audio']);
    expect(plan.outputs.map((s) => s.label)).toEqual(['gate out', 'cv out', 'audio out']);
    expect(plan.outputs.every((s) => s.direction === 'output')).toBe(true);
    expectTotal(def);
  });

  it('AUTHORED beats derived: a `direction: output` group claims its ports and heads them', () => {
    const def: RearDefLike = {
      inputs: [{ id: 'in', type: 'audio' }],
      outputs: [
        { id: 'main', type: 'audio' },
        { id: 'send', type: 'audio' },
        { id: 'eoc', type: 'gate' },
      ],
      face: {
        order: [],
        rear: {
          groups: [
            { id: 'taps', label: 'sends', ports: ['send'], direction: 'output' },
          ],
        },
      } as RearDefLike['face'],
    };
    const plan = rearFieldPlan(def);
    // The authored section leads, the derived remainder follows.
    expect(plan.outputs.map((s) => [s.id, s.label])).toEqual([
      ['taps', 'sends'],
      ['out', 'out'],
    ]);
    expect(plan.outputs[0].holes.map((h) => h.portId)).toEqual(['send']);
    expect(plan.outputs[1].holes.map((h) => h.portId)).toEqual(['main', 'eoc']);
    expectTotal(def);
  });

  it('an authored group whose ports are all on the OTHER rail claims nothing', () => {
    // The silent-disappearance case module-face-lint refuses. The model must
    // still be TOTAL when it happens, so a lint failure is a lint failure and
    // not also a dropped jack.
    const def: RearDefLike = {
      inputs: [{ id: 'audio', type: 'audio' }],
      outputs: [{ id: 'audio', type: 'audio' }],
      face: {
        order: [],
        rear: { groups: [{ id: 'wrong', label: 'wrong', ports: ['audio'], direction: 'output' }] },
      } as RearDefLike['face'],
    };
    const plan = rearFieldPlan(def);
    expect(plan.outputs.map((s) => s.id)).toEqual(['wrong']);
    expectTotal(def);
  });

  it('A PORT ID ON BOTH RAILS IS NOT ONE PORT — the `delay` shape', () => {
    // ⚠ `delay` really does declare an `audio` INPUT and an `audio` OUTPUT.
    // Before #1800 the group→port claim map was keyed by port id alone, so an
    // INPUT group naming `audio` also marked the OUTPUT claimed. That was
    // harmless while outputs had no grouping and is a dropped jack the moment
    // they do. Pinned on the real def AND on the synthetic worst case: an
    // input group named 'signal' claiming `audio`.
    const def = delayDef as unknown as RearDefLike;
    expect(
      (def.inputs ?? []).some((p) => p.id === 'audio') && (def.outputs ?? []).some((p) => p.id === 'audio'),
      'delay is still the two-rails-one-id fixture',
    ).toBe(true);
    expectTotal(def);
    expect(outHoles(def).map((h) => h.portId)).toEqual(['audio']);
    expect(outHoles(def)[0].direction).toBe('output');
    expect(rearSectionHoles(rearFieldPlan(def).inputs).some((h) => h.portId === 'audio')).toBe(true);
  });

  it('COLOUR IS INVARIANT TO DIRECTION — the same cable type derives the same domain', () => {
    // The positive control for `rear-direction.ts`'s central claim, at the
    // MODEL level: hue is a pure function of `PortDef.type`, so no amount of
    // direction handling can make an audio input a different colour from an
    // audio output. (The CSS half is asserted in rear-direction.test.ts.)
    const types = ['audio', 'cv', 'gate', 'pitch', 'polyPitchGate', 'video'];
    const plan = rearFieldPlan({
      inputs: types.map((t, i) => ({ id: `i${i}`, type: t })),
      outputs: types.map((t, i) => ({ id: `o${i}`, type: t })),
    });
    const ins = rearSectionHoles(plan.inputs);
    const outsH = rearSectionHoles(plan.outputs);
    for (const t of types) {
      const a = ins.find((h) => h.cable === t)!;
      const b = outsH.find((h) => h.cable === t)!;
      expect(b.domain, `${t}: same domain on both rails`).toBe(a.domain);
    }
    // NEGATIVE CONTROL for the probe itself: it CAN report a difference — two
    // different cable types do land on different domains, so a green run above
    // is not the probe being blind.
    expect(ins.find((h) => h.cable === 'audio')!.domain).not.toBe(
      ins.find((h) => h.cable === 'gate')!.domain,
    );
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

// ────────────────────────────────────────────────────────────────────────────
// THE OUTPUTS-RAIL STEREO HOLE, after the fifth-heuristic unification (PR-2b)
// and the pair-tie retirement (PR-4, owner Q5).
//
// `markStereoPairs` used to be its own stem regex (`/^(.*?)_?([lr])$/`) over
// ADJACENT outputs — blind to `stereoPairs` declarations AND to the port's
// cable type. PR-2b pointed it at $lib/graph/stereo-pairs, the one derivation,
// which changed the verdict on EXACTLY three registry modules, all of them
// corrections. PR-4 then turned the verdict from a TIE MARK between two holes
// into ONE hole, which also removes the tie's adjacency precondition.
//
// The three corrections are re-pinned here in their new form so they cannot
// regress, and so the blast radius stays a measured number rather than a claim.
// ────────────────────────────────────────────────────────────────────────────
describe('outputs-rail stereo pairs: one hole, derived from stereo-pairs', () => {
  /** `left→right` for every COLLAPSED output hole. Empty ⇒ no pair on the rail. */
  const stereoOuts = (def: RearDefLike): string[] =>
    outHoles(def)
      .filter((h) => h.stereoSiblingPortId)
      .map((h) => `${h.portId}+${h.stereoSiblingPortId}`);

  it('FALSE POSITIVE fixed: gamepad d-pad left/right are GATE buttons, not a stereo pair', () => {
    // `dl` / `dr` end in l / r, so the old regex tied them on the outputs rail
    // of a joypad. Token-based side detection does not read `dl` as a left,
    // and the audio-only rule would exclude them anyway — two reasons, and
    // the old heuristic had neither.
    const outs = gamepadDef.outputs as unknown as { id: string; type: string }[];
    expect(outs.filter((p) => p.id === 'dl' || p.id === 'dr').map((p) => p.type)).toEqual([
      'gate',
      'gate',
    ]);
    expect(stereoOuts(gamepadDef as unknown as RearDefLike)).toEqual([]);
    // …and the two buttons still render as their own holes.
    const ids = outHoles(gamepadDef as unknown as RearDefLike).map((h) => h.portId);
    expect(ids).toContain('dl');
    expect(ids).toContain('dr');
  });

  it('FALSE NEGATIVE fixed: sidecar audio_l_out/audio_r_out is a DECLARED pair', () => {
    // The ids do not END in l/r, so the old regex could never see the pair —
    // not even though the def declares it outright.
    expect(sidecarDef.stereoPairs).toContainEqual(['audio_l_out', 'audio_r_out']);
    expect(stereoOuts(sidecarDef as unknown as RearDefLike)).toEqual([
      'audio_l_out+audio_r_out',
    ]);
  });

  it('FALSE NEGATIVE fixed: audioIn audio_l_out/audio_r_out collapses from its id tokens', () => {
    expect(stereoOuts(audioInDef as unknown as RearDefLike)).toEqual([
      'audio_l_out+audio_r_out',
    ]);
    // The stem-derived collapsed label: `audio_l_out` → stem `audio_out` →
    // the redundant direction suffix drops → AUDIO.
    expect(
      outHoles(audioInDef as unknown as RearDefLike).find((h) => h.portId === 'audio_l_out')!.label,
    ).toBe('AUDIO');
  });

  it('rings odd/even is COLLAPSE_EXEMPT: two timbre taps, TWO holes', () => {
    // Derived (declared tuple, both audio, adjacent) but deliberately exempt.
    // The DECLARATION is untouched, so its shipped autowire is unaffected —
    // collapse and autowire read different lists, on purpose. This is THE
    // regression guard for reading the wrong list in the rear card.
    expect(ringsDef.stereoPairs).toEqual([['odd', 'even']]);
    expect(stereoOuts(ringsDef as unknown as RearDefLike)).toEqual([]);
    const ids = outHoles(ringsDef as unknown as RearDefLike).map((h) => h.portId);
    expect(ids).toContain('odd');
    expect(ids).toContain('even');
  });

  it('UNCHANGED shape: a declared L/R pair collapses (tidyVco); a non-pair does not (vca)', () => {
    expect(stereoOuts(tidyVcoDef as unknown as RearDefLike)).toEqual(['out_l+out_r']);
    expect(stereoOuts(vcaDef as unknown as RearDefLike)).toEqual([]);
  });

  it('INPUT rails collapse too — the tie only ever existed on outputs', () => {
    // cloudseed declares `in_l`/`in_r`. Under the tie that pair rendered as two
    // input holes on a card whose FRONT panel now shows one jack: two surfaces
    // disagreeing about the same def.
    const plan = rearFieldPlan(cloudseedDef as unknown as RearDefLike);
    const inputs = plan.inputs.flatMap((b) => [...b.holes, ...b.clusters.flatMap((c) => c.holes)]);
    const stereoIns = inputs
      .filter((h) => h.stereoSiblingPortId)
      .map((h) => `${h.portId}+${h.stereoSiblingPortId}`);
    expect(stereoIns).toEqual(['in_l+in_r']);
    expect(inputs.some((h) => h.portId === 'in_r')).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// #1800 — THE PATHOLOGICAL PORT COUNTS, on the real registry's worst cases.
//
// This is the answer to "what replaces band-collapse?", proved rather than
// asserted. The old fallback armed past ~60 holes and rendered each band as a
// header + a jack-count pill, with its holes NOT IN THE DOM until clicked open.
// The replacement is three derived layout steps, none of which hides a hole:
//
//   COLUMNS  a section's width is earned by its row count (rearSectionColumns)
//   SPLIT    a long mixed-domain OUTPUT rail sections itself by cable domain
//   DENSE    past REAR_DENSE_ROWS the row metrics tighten
//
// ⚠ DOOM IS DELIBERATELY NOT HERE, and is excluded BY NAME rather than by
// omission. It is the registry's second-largest field, and the owner ruling is
// that DOOM is not touched — code, specs or timing — without specific approval.
// Nothing in this file sweeps the registry, so no DOOM anything is read or
// asserted by the rear-card work; mixmstrs is the LARGER field and covers the
// same shape.
// ────────────────────────────────────────────────────────────────────────────
describe('rear-card high port counts — columns, split, dense (nothing hidden)', () => {
  /** Every hole the plan would render, both rails. */
  const allHoles = (def: RearDefLike) => {
    const plan = rearFieldPlan(def);
    return rearSectionHoles([...plan.inputs, ...plan.outputs]);
  };

  it('mixmstrs — the LARGEST field in the registry stays total, and no group is a tower', () => {
    const def = mixmstrsDef as unknown as RearDefLike;
    expectTotal(def);
    const plan = rearFieldPlan(def);
    // The field is big enough to arm every step.
    expect(plan.dense, 'a field this size takes the dense row metrics').toBe(true);
    // EVERY declared port is in the plan — the property band-collapse gave up.
    expect(allHoles(def)).toHaveLength(plan.holeCount);
    expect(plan.portCount).toBe((def.inputs ?? []).length + (def.outputs ?? []).length);
    // …and no section is a single column of more rows than a column may hold.
    for (const sec of [...plan.inputs, ...plan.outputs]) {
      const rows = sec.holes.length + sec.clusters.reduce((n, c) => n + c.holes.length, 0);
      expect(sec.columns, `${sec.id}: ${rows} rows`).toBe(rearSectionColumns(rows));
      expect(
        Math.ceil(rows / sec.columns),
        `${sec.id}: ${rows} rows over ${sec.columns} column(s) — taller than a column may be`,
      ).toBeLessThanOrEqual(REAR_ROWS_PER_COLUMN);
    }
    // NEGATIVE CONTROL for that loop: this def really does have a section big
    // enough to need more than one column, so the check is not vacuous.
    expect(
      plan.inputs.some((s) => s.columns > 1),
      'mixmstrs is still the multi-column-section fixture',
    ).toBe(true);
  });

  it('es9 + synesthesia — a long MIXED output rail sections itself by cable domain', () => {
    for (const def of [es9Def, synesthesiaDef] as unknown as RearDefLike[]) {
      expectTotal(def);
      const plan = rearFieldPlan(def);
      const ids = plan.outputs.map((s) => s.id);
      expect(ids.length, `${def.type}: a long mixed rail splits`).toBeGreaterThan(1);
      expect(
        ids.filter((id) => !id.startsWith('out-')),
        `${def.type}: every derived output section is domain-keyed`,
      ).toEqual([]);
      // The split is a PARTITION: each hole in exactly one domain section, and
      // the section's key is that hole's own declared domain.
      for (const sec of plan.outputs) {
        const domain = sec.id.slice('out-'.length);
        expect(
          sec.holes.filter((h) => h.domain !== domain).map((h) => h.portId),
          `${def.type}/${sec.id}: a hole of another domain`,
        ).toEqual([]);
      }
    }
  });

  it('rearSectionColumns is monotonic and capped — the one place the width rule lives', () => {
    expect(rearSectionColumns(0)).toBe(1);
    expect(rearSectionColumns(1)).toBe(1);
    expect(rearSectionColumns(REAR_ROWS_PER_COLUMN)).toBe(1);
    expect(rearSectionColumns(REAR_ROWS_PER_COLUMN + 1)).toBe(2);
    expect(rearSectionColumns(REAR_ROWS_PER_COLUMN * REAR_MAX_SECTION_COLUMNS)).toBe(
      REAR_MAX_SECTION_COLUMNS,
    );
    // Capped, not unbounded: one heading never owns half the card.
    expect(rearSectionColumns(REAR_ROWS_PER_COLUMN * 40)).toBe(REAR_MAX_SECTION_COLUMNS);
    // Monotonic across the whole run, so a row added can never NARROW a group.
    let prev = 1;
    for (let n = 0; n <= REAR_ROWS_PER_COLUMN * (REAR_MAX_SECTION_COLUMNS + 2); n++) {
      const c = rearSectionColumns(n);
      expect(c, `columns went down at ${n} rows`).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });
});
