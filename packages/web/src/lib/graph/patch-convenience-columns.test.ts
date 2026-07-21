// packages/web/src/lib/graph/patch-convenience-columns.test.ts
//
// Coverage for the WORKFLOW CHANNEL-COLUMNS wiring planners (net-new on top of
// the assign-to-channel patch-convenience seam):
//   * resolveMainAudioIn + MAIN_IN_IDS      — the input-side mirror of the out.
//   * sendPorts                             — the mixmstrs aux-send/return ports.
//   * chainWiring override                  — the per-module "fixable in code"
//                                             insert-in / chain-out declaration.
//   * planPairLink                          — the 4 stereo↔mono link cases.
//   * planColumnWiring / planSendWiring     — the DETERMINISTIC, pure column /
//                                             send-loop edge planners the
//                                             reconciler drives.
//
// These are the COLLAB-CRITICAL planners: two peers computing the same members
// array + channel must produce byte-identical WcolEdge[] (same ids) so the
// Y.Map converges. Every test below is a pure function call (no Svelte / Yjs).

import { describe, it, expect } from 'vitest';
import '$lib/audio/modules';
import '$lib/video/modules';
import type { PortDef } from './types';
import {
  resolveMainAudioIn,
  resolveMainAudioOut,
  chainRole,
  isChainAudioParticipant,
  sendPorts,
  SEND_SLOT_COUNT,
  planPairLink,
  planColumnWiring,
  planSendWiring,
  wcolEdgeId,
  type ConvenienceDef,
  type ColumnMember,
} from './patch-convenience';
import { listModuleDefs } from '$lib/audio/module-registry';

const port = (id: string, type: PortDef['type'], extra: Partial<PortDef> = {}): PortDef =>
  ({ id, type, ...extra });

const def = (
  inputs: PortDef[],
  outputs: PortDef[],
  stereoPairs?: readonly (readonly [string, string])[],
  chainWiring?: ConvenienceDef['chainWiring'],
): ConvenienceDef => ({ inputs, outputs, stereoPairs, chainWiring });

function liveDef(type: string): ConvenienceDef | undefined {
  return listModuleDefs().find((d) => (d as { type?: string }).type === type) as
    | ConvenienceDef
    | undefined;
}

// ================================================================
// resolveMainAudioIn — mirror of resolveMainAudioOut
// ================================================================

describe('resolveMainAudioIn (pure)', () => {
  it('a declared stereo input pair resolves (naming-agnostic)', () => {
    const d = def([port('odd', 'audio'), port('even', 'audio')], [], [['odd', 'even']]);
    expect(resolveMainAudioIn(d)).toEqual({ kind: 'stereo', left: 'odd', right: 'even' });
  });

  it('an L/R id-token input pair resolves when no stereoPairs declared', () => {
    const d = def([port('in_l', 'audio'), port('in_r', 'audio')], []);
    expect(resolveMainAudioIn(d)).toEqual({ kind: 'stereo', left: 'in_l', right: 'in_r' });
  });

  it('a single mono audio in resolves as mono', () => {
    const d = def([port('in', 'audio')], []);
    expect(resolveMainAudioIn(d)).toEqual({ kind: 'mono', in: 'in' });
  });

  it('one canonical main among several audio ins (audio + sidechain) resolves as mono', () => {
    const d = def([port('audio', 'audio'), port('sidechain', 'audio')], []);
    expect(resolveMainAudioIn(d)).toEqual({ kind: 'mono', in: 'audio' });
  });

  it('a bank of equal parallel ins with no identifiable main is null', () => {
    const d = def([port('in1', 'audio'), port('in2', 'audio'), port('in3', 'audio')], []);
    expect(resolveMainAudioIn(d)).toBeNull();
  });

  it('a module with no audio inputs (a pure source) has no main in', () => {
    const d = def([port('pitch', 'pitch'), port('gate', 'gate')], [port('out', 'audio')]);
    expect(resolveMainAudioIn(d)).toBeNull();
  });
});

// ================================================================
// chainWiring override — the "fixable in code" per-module declaration
// ================================================================

describe('chainWiring override (owner "fixable in code")', () => {
  it('inPorts stereo override wins over the default resolution', () => {
    // 4 audio inputs with no clear main → default would be null; the override
    // pins the true stereo insert input.
    const d = def(
      [port('a_l', 'audio'), port('a_r', 'audio'), port('b_l', 'audio'), port('b_r', 'audio')],
      [port('out_l', 'audio'), port('out_r', 'audio')],
      undefined,
      { inPorts: ['a_l', 'a_r'], outPorts: ['out_l', 'out_r'] },
    );
    expect(resolveMainAudioIn(d)).toEqual({ kind: 'stereo', left: 'a_l', right: 'a_r' });
    expect(resolveMainAudioOut(d)).toEqual({ kind: 'stereo', left: 'out_l', right: 'out_r' });
  });

  it('mono inPorts/outPorts override resolves as mono', () => {
    const d = def([port('in1', 'audio'), port('in2', 'audio')], [port('o1', 'audio'), port('o2', 'audio')],
      undefined, { inPorts: ['in2'], outPorts: ['o1'] });
    expect(resolveMainAudioIn(d)).toEqual({ kind: 'mono', in: 'in2' });
    expect(resolveMainAudioOut(d)).toEqual({ kind: 'mono', out: 'o1' });
  });

  it('role override is reported by chainRole', () => {
    const d = def([port('in', 'audio')], [port('out', 'audio')], undefined, { role: 'source' });
    expect(chainRole(d)).toBe('source');
  });

  it('no override → chainRole inferred from main-in/out shape', () => {
    expect(chainRole(def([port('in', 'audio')], [port('out', 'audio')]))).toBe('both');
    expect(chainRole(def([], [port('out', 'audio')]))).toBe('source');
    expect(chainRole(def([port('in', 'audio')], [port('cv', 'cv')]))).toBe('dsp');
    expect(chainRole(def([port('cv_in', 'cv')], [port('cv_out', 'cv')]))).toBeNull();
  });

  it('the LIVE twotracks def declares its chainWiring: reel-A in, A/B out', () => {
    const tt = liveDef('twotracks');
    expect(tt, 'twotracks not found').toBeDefined();
    expect(tt!.chainWiring).toEqual({
      role: 'both',
      inPorts: ['audio_l_in_a', 'audio_r_in_a'],
      outPorts: ['out_l', 'out_r'],
    });
    // And it resolves through the override, not the naive 4-input guess.
    expect(resolveMainAudioIn(tt!)).toEqual({ kind: 'stereo', left: 'audio_l_in_a', right: 'audio_r_in_a' });
    expect(resolveMainAudioOut(tt!)).toEqual({ kind: 'stereo', left: 'out_l', right: 'out_r' });
    // Declared ports actually exist on the def.
    const inIds = new Set(tt!.inputs.map((p) => p.id));
    const outIds = new Set(tt!.outputs.map((p) => p.id));
    for (const p of tt!.chainWiring!.inPorts!) expect(inIds.has(p)).toBe(true);
    for (const p of tt!.chainWiring!.outPorts!) expect(outIds.has(p)).toBe(true);
  });
});

// ================================================================
// sendPorts — against the live mixmstrs def
// ================================================================

describe('sendPorts matches the live mixmstrs def', () => {
  it('has 2 send slots', () => {
    expect(SEND_SLOT_COUNT).toBe(2);
  });
  it('sendPorts(n) resolve to real mixmstrs send OUTPUTS + return INPUTS', () => {
    const mx = liveDef('mixmstrs');
    expect(mx, 'mixmstrs not found').toBeDefined();
    const outIds = new Set(mx!.outputs.map((p) => p.id));
    const inIds = new Set(mx!.inputs.map((p) => p.id));
    for (let n = 1; n <= SEND_SLOT_COUNT; n++) {
      const { sendL, sendR, retL, retR } = sendPorts(n);
      expect(outIds.has(sendL), `${sendL} missing`).toBe(true);
      expect(outIds.has(sendR), `${sendR} missing`).toBe(true);
      expect(inIds.has(retL), `${retL} missing`).toBe(true);
      expect(inIds.has(retR), `${retR} missing`).toBe(true);
    }
  });
});

// ================================================================
// planPairLink — the 4 stereo↔mono cases, explicit L+R
// ================================================================

describe('planPairLink (adjacent pair, explicit L+R)', () => {
  const stereoSrc = def([], [port('outL', 'audio'), port('outR', 'audio')], [['outL', 'outR']]);
  const stereoDst = def([port('inL', 'audio'), port('inR', 'audio')], [port('o', 'audio')], [['inL', 'inR']]);
  const monoSrc = def([], [port('out', 'audio')]);
  const monoDst = def([port('in', 'audio')], [port('o', 'audio')]);

  it('stereo → stereo: L→L, R→R', () => {
    expect(planPairLink('a', stereoSrc, 'b', stereoDst)).toEqual([
      { fromNodeId: 'a', fromPortId: 'outL', toNodeId: 'b', toPortId: 'inL', sourceType: 'audio', targetType: 'audio' },
      { fromNodeId: 'a', fromPortId: 'outR', toNodeId: 'b', toPortId: 'inR', sourceType: 'audio', targetType: 'audio' },
    ]);
  });

  it('mono → stereo: the single out fills BOTH L and R (two edges)', () => {
    expect(planPairLink('a', monoSrc, 'b', stereoDst)).toEqual([
      { fromNodeId: 'a', fromPortId: 'out', toNodeId: 'b', toPortId: 'inL', sourceType: 'audio', targetType: 'audio' },
      { fromNodeId: 'a', fromPortId: 'out', toNodeId: 'b', toPortId: 'inR', sourceType: 'audio', targetType: 'audio' },
    ]);
  });

  it('stereo → mono: L and R BOTH into the mono in (two edges → engine sums)', () => {
    expect(planPairLink('a', stereoSrc, 'b', monoDst)).toEqual([
      { fromNodeId: 'a', fromPortId: 'outL', toNodeId: 'b', toPortId: 'in', sourceType: 'audio', targetType: 'audio' },
      { fromNodeId: 'a', fromPortId: 'outR', toNodeId: 'b', toPortId: 'in', sourceType: 'audio', targetType: 'audio' },
    ]);
  });

  it('mono → mono: ONE de-duped edge', () => {
    expect(planPairLink('a', monoSrc, 'b', monoDst)).toEqual([
      { fromNodeId: 'a', fromPortId: 'out', toNodeId: 'b', toPortId: 'in', sourceType: 'audio', targetType: 'audio' },
    ]);
  });

  it('no link when the upstream has no main out or downstream has no main in', () => {
    const noOut = def([port('in', 'audio')], [port('cv', 'cv')]);
    const noIn = def([], [port('out', 'audio')]);
    expect(planPairLink('a', noOut, 'b', monoDst)).toEqual([]);
    expect(planPairLink('a', monoSrc, 'b', noIn)).toEqual([]);
  });
});

// ================================================================
// planColumnWiring — the deterministic full-column planner
// ================================================================

// Synthetic members for a source → filter → reverb → mixer column.
const VCO: ConvenienceDef = def([port('pitch', 'pitch'), port('gate', 'gate', { edge: 'gate' })], [port('out', 'audio')]);
const FILTER: ConvenienceDef = def([port('in', 'audio')], [port('out', 'audio')]);
const REVERB_ST: ConvenienceDef = def([port('inL', 'audio'), port('inR', 'audio')], [port('outL', 'audio'), port('outR', 'audio')], [['inL', 'inR'], ['outL', 'outR']]);
const VIDEO_ONLY: ConvenienceDef = def([port('cv_in', 'cv')], [port('video', 'video')]);

const member = (nodeId: string, d: ConvenienceDef): ColumnMember => ({ nodeId, def: d });

describe('planColumnWiring (deterministic full-column planner)', () => {
  const ctx = (members: ColumnMember[]) => ({
    channel: 3,
    members,
    clipPlayerId: 'clip',
    mixerId: 'mix',
  });

  it('a single VCO: clip control (source) + tail send-to-mixer', () => {
    const edges = planColumnWiring(ctx([member('vco', VCO)]));
    // clip: pitch3 → vco.pitch, gate3 → vco.gate
    expect(edges).toContainEqual({
      id: wcolEdgeId('clip', 'pitch3', 'vco', 'pitch'),
      source: { nodeId: 'clip', portId: 'pitch3' }, target: { nodeId: 'vco', portId: 'pitch' },
      sourceType: 'polyPitchGate', targetType: 'pitch',
    });
    expect(edges).toContainEqual({
      id: wcolEdgeId('clip', 'gate3', 'vco', 'gate'),
      source: { nodeId: 'clip', portId: 'gate3' }, target: { nodeId: 'vco', portId: 'gate' },
      sourceType: 'gate', targetType: 'gate',
    });
    // tail send: vco.out → mix.ch3L + ch3R (mono fills both)
    expect(edges).toContainEqual({
      id: wcolEdgeId('vco', 'out', 'mix', 'ch3L'),
      source: { nodeId: 'vco', portId: 'out' }, target: { nodeId: 'mix', portId: 'ch3L' },
      sourceType: 'audio', targetType: 'audio',
    });
    expect(edges).toContainEqual({
      id: wcolEdgeId('vco', 'out', 'mix', 'ch3R'),
      source: { nodeId: 'vco', portId: 'out' }, target: { nodeId: 'mix', portId: 'ch3R' },
      sourceType: 'audio', targetType: 'audio',
    });
  });

  it('VCO → FILTER → REVERB: internal links, ONLY the reverb (tail) sends', () => {
    const edges = planColumnWiring(ctx([member('vco', VCO), member('flt', FILTER), member('rev', REVERB_ST)]));
    const ids = new Set(edges.map((e) => e.id));
    // internal: vco.out → flt.in ; flt.out → rev.inL + rev.inR (mono→stereo)
    expect(ids.has(wcolEdgeId('vco', 'out', 'flt', 'in'))).toBe(true);
    expect(ids.has(wcolEdgeId('flt', 'out', 'rev', 'inL'))).toBe(true);
    expect(ids.has(wcolEdgeId('flt', 'out', 'rev', 'inR'))).toBe(true);
    // tail send: rev.outL → ch3L, rev.outR → ch3R
    expect(ids.has(wcolEdgeId('rev', 'outL', 'mix', 'ch3L'))).toBe(true);
    expect(ids.has(wcolEdgeId('rev', 'outR', 'mix', 'ch3R'))).toBe(true);
    // NON-tail members must NOT send to the mixer.
    expect(ids.has(wcolEdgeId('vco', 'out', 'mix', 'ch3L'))).toBe(false);
    expect(ids.has(wcolEdgeId('flt', 'out', 'mix', 'ch3L'))).toBe(false);
  });

  it('a pure-VIDEO member is skipped from the audio chain (automation-only)', () => {
    const edges = planColumnWiring(ctx([member('vco', VCO), member('vid', VIDEO_ONLY), member('flt', FILTER)]));
    const ids = new Set(edges.map((e) => e.id));
    // The video node is not linked; the chain jumps vco → flt directly.
    expect(ids.has(wcolEdgeId('vco', 'out', 'flt', 'in'))).toBe(true);
    for (const e of edges) {
      expect(e.source.nodeId).not.toBe('vid');
      expect(e.target.nodeId).not.toBe('vid');
    }
    // Tail is the filter (bottom-most with a main out).
    expect(ids.has(wcolEdgeId('flt', 'out', 'mix', 'ch3L'))).toBe(true);
  });

  it('multi-source (two VCOs stacked): only the bottom-most (tail) sends', () => {
    const edges = planColumnWiring(ctx([member('vco1', VCO), member('vco2', VCO)]));
    const ids = new Set(edges.map((e) => e.id));
    // No link between two source-only modules (neither has a main IN).
    expect(ids.has(wcolEdgeId('vco1', 'out', 'vco2', 'pitch'))).toBe(false);
    // Only the bottom source sends.
    expect(ids.has(wcolEdgeId('vco2', 'out', 'mix', 'ch3L'))).toBe(true);
    expect(ids.has(wcolEdgeId('vco1', 'out', 'mix', 'ch3L'))).toBe(false);
    // Clip control goes to the TOP-most clip-eligible member.
    expect(ids.has(wcolEdgeId('clip', 'pitch3', 'vco1', 'pitch'))).toBe(true);
    expect(ids.has(wcolEdgeId('clip', 'pitch3', 'vco2', 'pitch'))).toBe(false);
  });

  it('empty column → no edges', () => {
    expect(planColumnWiring(ctx([]))).toEqual([]);
  });

  it('no clip player → no clip control, but chain + send still plan', () => {
    const edges = planColumnWiring({ channel: 3, members: [member('vco', VCO)], clipPlayerId: null, mixerId: 'mix' });
    expect(edges.some((e) => e.source.nodeId === 'clip')).toBe(false);
    expect(edges.some((e) => e.target.nodeId === 'mix')).toBe(true);
  });

  it('no mixer → no tail send, but clip + chain still plan', () => {
    const edges = planColumnWiring({ channel: 3, members: [member('vco', VCO), member('flt', FILTER)], clipPlayerId: 'clip', mixerId: null });
    expect(edges.some((e) => e.target.nodeId === 'mix')).toBe(false);
    expect(edges.some((e) => e.source.nodeId === 'clip')).toBe(true);
    expect(edges.some((e) => e.id === wcolEdgeId('vco', 'out', 'flt', 'in'))).toBe(true);
  });

  it('DETERMINISM: two calls with the same inputs produce byte-identical edge sets', () => {
    const members = [member('vco', VCO), member('flt', FILTER), member('rev', REVERB_ST)];
    const a = planColumnWiring(ctx(members));
    const b = planColumnWiring(ctx(members));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Every id is namespaced wcol- (structurally uneligible to delete hand cables).
    for (const e of a) expect(e.id.startsWith('wcol-e-')).toBe(true);
  });

  it('HEAL: dropping the tail member re-derives the previous member as the new tail', () => {
    const full = planColumnWiring(ctx([member('vco', VCO), member('flt', FILTER), member('rev', REVERB_ST)]));
    const healed = planColumnWiring(ctx([member('vco', VCO), member('flt', FILTER)]));
    const fullIds = new Set(full.map((e) => e.id));
    const healedIds = new Set(healed.map((e) => e.id));
    // The reverb's edges are gone; the filter now sends to the mixer.
    expect(healedIds.has(wcolEdgeId('rev', 'outL', 'mix', 'ch3L'))).toBe(false);
    expect(healedIds.has(wcolEdgeId('flt', 'out', 'mix', 'ch3L'))).toBe(true);
    expect(fullIds.has(wcolEdgeId('flt', 'out', 'mix', 'ch3L'))).toBe(false);
  });
});

// ================================================================
// planSendWiring — send loop (mixer send → head → tail → return)
// ================================================================

describe('planSendWiring (aux-send loop)', () => {
  it('mixer send1 → reverb.in ; reverb.out → mixer ret1 (stereo reverb)', () => {
    const edges = planSendWiring({ slot: 1, members: [member('rev', REVERB_ST)], mixerId: 'mix' });
    const ids = new Set(edges.map((e) => e.id));
    expect(ids.has(wcolEdgeId('mix', 'send1L', 'rev', 'inL'))).toBe(true);
    expect(ids.has(wcolEdgeId('mix', 'send1R', 'rev', 'inR'))).toBe(true);
    expect(ids.has(wcolEdgeId('rev', 'outL', 'mix', 'ret1L'))).toBe(true);
    expect(ids.has(wcolEdgeId('rev', 'outR', 'mix', 'ret1R'))).toBe(true);
    // No clip control on a send tenant.
    expect(edges.some((e) => e.source.portId.startsWith('pitch') || e.source.portId.startsWith('gate'))).toBe(false);
  });

  it('mono DSP in a send: send fills the mono in; mono out feeds both returns', () => {
    const monoFx = def([port('in', 'audio')], [port('out', 'audio')]);
    const edges = planSendWiring({ slot: 2, members: [member('fx', monoFx)], mixerId: 'mix' });
    const ids = new Set(edges.map((e) => e.id));
    expect(ids.has(wcolEdgeId('mix', 'send2L', 'fx', 'in'))).toBe(true); // only one head edge (mono in)
    expect(ids.has(wcolEdgeId('fx', 'out', 'mix', 'ret2L'))).toBe(true);
    expect(ids.has(wcolEdgeId('fx', 'out', 'mix', 'ret2R'))).toBe(true);
  });

  it('empty send / no mixer → no edges', () => {
    expect(planSendWiring({ slot: 1, members: [], mixerId: 'mix' })).toEqual([]);
    expect(planSendWiring({ slot: 1, members: [member('rev', REVERB_ST)], mixerId: null })).toEqual([]);
  });

  it('DETERMINISM: identical inputs → identical send edge set', () => {
    const a = planSendWiring({ slot: 1, members: [member('rev', REVERB_ST)], mixerId: 'mix' });
    const b = planSendWiring({ slot: 1, members: [member('rev', REVERB_ST)], mixerId: 'mix' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ================================================================
// isChainAudioParticipant — video/CV exclusion
// ================================================================

describe('isChainAudioParticipant', () => {
  it('an audio source / DSP participates; a pure-video / pure-CV module does not', () => {
    expect(isChainAudioParticipant(VCO)).toBe(true);
    expect(isChainAudioParticipant(FILTER)).toBe(true);
    expect(isChainAudioParticipant(VIDEO_ONLY)).toBe(false);
    expect(isChainAudioParticipant(def([port('cv_in', 'cv')], [port('cv_out', 'cv')]))).toBe(false);
  });
});
