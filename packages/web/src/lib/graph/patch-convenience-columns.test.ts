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
  resolveColumnHead,
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
  // The head-source (has a main out, no main in) that the ONE-HEAD model wires at
  // the chain root. Default = the FIRST source in column order (matches a single-
  // strip column); tests that exercise headless / explicit heads pass it in.
  const firstSource = (members: ColumnMember[]): string | null =>
    members.find((m) => resolveMainAudioOut(m.def) !== null && resolveMainAudioIn(m.def) === null)
      ?.nodeId ?? null;
  const ctx = (members: ColumnMember[], headNodeId: string | null = firstSource(members)) => ({
    channel: 3,
    members,
    clipPlayerId: 'clip',
    mixerId: 'mix',
    headNodeId,
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

  it('multi-source no-FX: ONLY the HEAD sends; the 2nd source is AUTOMATION-ONLY (no audio edge)', () => {
    // Owner rule: a 2nd source in a column is NOT auto-wired into the audio — it
    // only gets its clip/automation channel. head = vco1 (first in order).
    const edges = planColumnWiring(ctx([member('vco1', VCO), member('vco2', VCO)]));
    const ids = new Set(edges.map((e) => e.id));
    // No chain link between the two sources (a source has no audio-in anyway).
    expect(ids.has(wcolEdgeId('vco1', 'out', 'vco2', 'pitch'))).toBe(false);
    // ONLY the head (vco1) reaches the mixer — no summing at the ch bus.
    expect(ids.has(wcolEdgeId('vco1', 'out', 'mix', 'ch3L'))).toBe(true);
    expect(ids.has(wcolEdgeId('vco1', 'out', 'mix', 'ch3R'))).toBe(true);
    // The 2nd source has NO audio edge at all (not to the mixer, not anywhere).
    expect(ids.has(wcolEdgeId('vco2', 'out', 'mix', 'ch3L'))).toBe(false);
    expect(ids.has(wcolEdgeId('vco2', 'out', 'mix', 'ch3R'))).toBe(false);
    expect(edges.some((e) => e.source.nodeId === 'vco2' && e.sourceType === 'audio')).toBe(false);
    // BOTH sources still get their clip pitch3/gate3 (the non-head's automation channel).
    expect(ids.has(wcolEdgeId('clip', 'pitch3', 'vco1', 'pitch'))).toBe(true);
    expect(ids.has(wcolEdgeId('clip', 'pitch3', 'vco2', 'pitch'))).toBe(true);
    expect(ids.has(wcolEdgeId('clip', 'gate3', 'vco1', 'gate'))).toBe(true);
    expect(ids.has(wcolEdgeId('clip', 'gate3', 'vco2', 'gate'))).toBe(true);
  });

  it('multi-source with FX: [vco1,filter,vco2,reverb] → HEAD (vco1)→filter→reverb→mixer; vco2 is AUTOMATION-ONLY', () => {
    // ONE-HEAD model (owner rule): the column is ONE head source → FX chain →
    // mixer. vco1 (head, first source) → filter → reverb → ch3. vco2 (2nd source)
    // gets ONLY its clip control — NO audio edge (never summed into the FX, never
    // sent to the channel). The user manually patches it in if they want it.
    const edges = planColumnWiring(ctx([
      member('vco1', VCO), member('flt', FILTER), member('vco2', VCO), member('rev', REVERB_ST),
    ]));
    const ids = new Set(edges.map((e) => e.id));
    // FX chain: filter → reverb.
    expect(ids.has(wcolEdgeId('flt', 'out', 'rev', 'inL'))).toBe(true);
    expect(ids.has(wcolEdgeId('flt', 'out', 'rev', 'inR'))).toBe(true);
    // ONLY the HEAD (vco1) feeds the FX head (filter).
    expect(ids.has(wcolEdgeId('vco1', 'out', 'flt', 'in'))).toBe(true);
    // The 2nd source (vco2) is NOT wired into the audio at all.
    expect(ids.has(wcolEdgeId('vco2', 'out', 'flt', 'in'))).toBe(false);
    expect(edges.some((e) => e.source.nodeId === 'vco2' && e.sourceType === 'audio')).toBe(false);
    // The SINGLE tail (reverb) is the ONLY member that sends to the channel.
    expect(ids.has(wcolEdgeId('rev', 'outL', 'mix', 'ch3L'))).toBe(true);
    expect(ids.has(wcolEdgeId('rev', 'outR', 'mix', 'ch3R'))).toBe(true);
    // BOTH sources still clip-driven (vco2 keeps its automation channel).
    expect(ids.has(wcolEdgeId('clip', 'pitch3', 'vco1', 'pitch'))).toBe(true);
    expect(ids.has(wcolEdgeId('clip', 'pitch3', 'vco2', 'pitch'))).toBe(true);
    // NON-tail members never send to the mixer.
    expect(ids.has(wcolEdgeId('vco1', 'out', 'mix', 'ch3L'))).toBe(false);
    expect(ids.has(wcolEdgeId('vco2', 'out', 'mix', 'ch3L'))).toBe(false);
    expect(ids.has(wcolEdgeId('flt', 'out', 'mix', 'ch3L'))).toBe(false);
  });

  it('DELETE HEAD keeps the FX chain intact (headless): no source feeds fx, but fx→…→mixer stays; a present non-head source is NOT promoted', () => {
    // source→filter→reverb→mixer, then the head source is deleted. Passing
    // headNodeId=null models the headless column (the head flag was cleared and no
    // surviving source is auto-promoted). The FX chain STAYS; a still-present
    // non-head source (vco2) gets no audio edge.
    const edges = planColumnWiring(
      ctx([member('vco2', VCO), member('flt', FILTER), member('rev', REVERB_ST)], null),
    );
    const ids = new Set(edges.map((e) => e.id));
    // FX chain intact + tail still sends.
    expect(ids.has(wcolEdgeId('flt', 'out', 'rev', 'inL'))).toBe(true);
    expect(ids.has(wcolEdgeId('rev', 'outL', 'mix', 'ch3L'))).toBe(true);
    expect(ids.has(wcolEdgeId('rev', 'outR', 'mix', 'ch3R'))).toBe(true);
    // Nothing feeds the FX head (headless): the surviving source is NOT promoted.
    expect(edges.some((e) => e.source.nodeId === 'vco2' && e.sourceType === 'audio')).toBe(false);
    // The surviving non-head source keeps its clip control (automation-only).
    expect(ids.has(wcolEdgeId('clip', 'pitch3', 'vco2', 'pitch'))).toBe(true);
  });

  it('ADD source to a HEADLESS column wires it at the ROOT (source→fx1→…→mixer)', () => {
    // A headless FX chain, then a fresh source becomes the head (headNodeId=vcoNew)
    // → wired at the chain root.
    const edges = planColumnWiring(
      ctx([member('vcoNew', VCO), member('flt', FILTER), member('rev', REVERB_ST)], 'vcoNew'),
    );
    const ids = new Set(edges.map((e) => e.id));
    expect(ids.has(wcolEdgeId('vcoNew', 'out', 'flt', 'in'))).toBe(true); // root
    expect(ids.has(wcolEdgeId('flt', 'out', 'rev', 'inL'))).toBe(true);
    expect(ids.has(wcolEdgeId('rev', 'outL', 'mix', 'ch3L'))).toBe(true);
  });

  it('empty column → no edges', () => {
    expect(planColumnWiring(ctx([]))).toEqual([]);
  });

  it('no clip player → no clip control, but chain + send still plan', () => {
    const edges = planColumnWiring({ channel: 3, members: [member('vco', VCO)], clipPlayerId: null, mixerId: 'mix', headNodeId: 'vco' });
    expect(edges.some((e) => e.source.nodeId === 'clip')).toBe(false);
    expect(edges.some((e) => e.target.nodeId === 'mix')).toBe(true);
  });

  it('no mixer → no tail send, but clip + chain still plan', () => {
    const edges = planColumnWiring({ channel: 3, members: [member('vco', VCO), member('flt', FILTER)], clipPlayerId: 'clip', mixerId: null, headNodeId: 'vco' });
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
// PART B — additive NOTE TAP + ES-9 RETURN AUDIO (CV Buddy lanes)
// ================================================================

// Synthetic note-sink defs mirroring the real cvBuddy / midiOutBuddy shapes:
// cv/gate INPUTS, no audio, a noteSink laneTap. CV Buddy also declares
// returnsAudio (its ES-9 hardware return makes it a lane head source).
const CV_BUDDY: ConvenienceDef = def(
  [port('gate', 'gate', { edge: 'gate' }), port('pitch', 'cv'), port('velocity', 'cv')],
  [port('pitchCv', 'cv'), port('gate', 'gate'), port('velCv', 'cv'), port('run', 'gate'), port('clock', 'gate')],
  undefined,
  { role: 'noteSink', laneTap: { pitchIn: 'pitch', gateIn: 'gate', velIn: 'velocity' }, returnsAudio: true },
);
const MIDI_OUT: ConvenienceDef = def(
  [port('gate', 'gate', { edge: 'gate' }), port('pitch', 'cv'), port('velocity', 'cv')],
  [],
  undefined,
  { role: 'noteSink', laneTap: { pitchIn: 'pitch', gateIn: 'gate', velIn: 'velocity' } },
);

describe('planColumnWiring — PART B note tap + ES-9 return', () => {
  const RET = (nodeId: string, inA: number, inB: number, es9 = 'es9') =>
    new Map([[nodeId, { es9NodeId: es9, inPortL: `in${inA}`, inPortR: `in${inB}` }]]);
  const ctxB = (
    members: ColumnMember[],
    headNodeId: string | null,
    returns?: Map<string, { es9NodeId: string; inPortL: string; inPortR: string }>,
  ) => ({ channel: 3, members, clipPlayerId: 'clip', mixerId: 'mix', headNodeId, returns });

  it('NOTE TAP: clip pitch/gate/vel → the note sink laneTap inputs (additive), never the mixer', () => {
    const edges = planColumnWiring(ctxB([member('cvb', CV_BUDDY)], 'cvb'));
    const ids = new Set(edges.map((e) => e.id));
    // pitch3 (polyPitchGate) → cvb.pitch (cv); gate3 → cvb.gate; vel3 → cvb.velocity
    expect(edges).toContainEqual({
      id: wcolEdgeId('clip', 'pitch3', 'cvb', 'pitch'),
      source: { nodeId: 'clip', portId: 'pitch3' }, target: { nodeId: 'cvb', portId: 'pitch' },
      sourceType: 'polyPitchGate', targetType: 'cv',
    });
    expect(ids.has(wcolEdgeId('clip', 'gate3', 'cvb', 'gate'))).toBe(true);
    expect(edges).toContainEqual({
      id: wcolEdgeId('clip', 'vel3', 'cvb', 'velocity'),
      source: { nodeId: 'clip', portId: 'vel3' }, target: { nodeId: 'cvb', portId: 'velocity' },
      sourceType: 'cv', targetType: 'cv',
    });
    // With NO ES-9 return allocation the tap is the ONLY thing wired — the sink
    // never reaches the mixer (no audio out).
    expect(edges.some((e) => e.target.nodeId === 'mix')).toBe(false);
  });

  it('MIDI-out is tapped too (both note sinks) and never becomes a lane head / mixer member', () => {
    const edges = planColumnWiring(ctxB([member('mo', MIDI_OUT)], 'mo', RET('mo', 1, 2)));
    const ids = new Set(edges.map((e) => e.id));
    expect(ids.has(wcolEdgeId('clip', 'pitch3', 'mo', 'pitch'))).toBe(true);
    expect(ids.has(wcolEdgeId('clip', 'gate3', 'mo', 'gate'))).toBe(true);
    expect(ids.has(wcolEdgeId('clip', 'vel3', 'mo', 'velocity'))).toBe(true);
    // MIDI-out has no returnsAudio → NOT a return source → no audio to the mixer,
    // even if a (spurious) return entry is present.
    expect(edges.some((e) => e.target.nodeId === 'mix')).toBe(false);
    expect(edges.some((e) => e.source.nodeId === 'es9')).toBe(false);
  });

  it('RETURN (no FX): CV Buddy head + ES-9 pair → es9.in1/in2 straight into ch3L/ch3R', () => {
    const edges = planColumnWiring(ctxB([member('cvb', CV_BUDDY)], 'cvb', RET('cvb', 1, 2)));
    expect(edges).toContainEqual({
      id: wcolEdgeId('es9', 'in1', 'mix', 'ch3L'),
      source: { nodeId: 'es9', portId: 'in1' }, target: { nodeId: 'mix', portId: 'ch3L' },
      sourceType: 'audio', targetType: 'audio',
    });
    expect(edges).toContainEqual({
      id: wcolEdgeId('es9', 'in2', 'mix', 'ch3R'),
      source: { nodeId: 'es9', portId: 'in2' }, target: { nodeId: 'mix', portId: 'ch3R' },
      sourceType: 'audio', targetType: 'audio',
    });
    // The note tap coexists (additive).
    expect(edges.some((e) => e.id === wcolEdgeId('clip', 'pitch3', 'cvb', 'pitch'))).toBe(true);
  });

  it('RETURN (with FX): es9 pair → the FX root; the FX tail sends to the mixer (not the ES-9)', () => {
    const edges = planColumnWiring(
      ctxB([member('cvb', CV_BUDDY), member('rev', REVERB_ST)], 'cvb', RET('cvb', 1, 2)),
    );
    const ids = new Set(edges.map((e) => e.id));
    // ES-9 return pair → the stereo FX (reverb) input.
    expect(ids.has(wcolEdgeId('es9', 'in1', 'rev', 'inL'))).toBe(true);
    expect(ids.has(wcolEdgeId('es9', 'in2', 'rev', 'inR'))).toBe(true);
    // The FX tail — NOT the ES-9 — reaches the mixer.
    expect(ids.has(wcolEdgeId('rev', 'outL', 'mix', 'ch3L'))).toBe(true);
    expect(ids.has(wcolEdgeId('es9', 'in1', 'mix', 'ch3L'))).toBe(false);
  });

  it('second CV Buddy uses the in3/in4 pair (1st→in1/2, 2nd→in3/4)', () => {
    const edges = planColumnWiring(ctxB([member('cvb2', CV_BUDDY)], 'cvb2', RET('cvb2', 3, 4)));
    const ids = new Set(edges.map((e) => e.id));
    expect(ids.has(wcolEdgeId('es9', 'in3', 'mix', 'ch3L'))).toBe(true);
    expect(ids.has(wcolEdgeId('es9', 'in4', 'mix', 'ch3R'))).toBe(true);
  });

  it('NO ES-9 (returns omitted): CV Buddy is INERT for audio — tap only, no return', () => {
    const edges = planColumnWiring(ctxB([member('cvb', CV_BUDDY)], 'cvb', undefined));
    expect(edges.some((e) => e.source.nodeId === 'es9')).toBe(false);
    expect(edges.some((e) => e.target.nodeId === 'mix')).toBe(false);
    // Still tapped.
    expect(edges.some((e) => e.id === wcolEdgeId('clip', 'pitch3', 'cvb', 'pitch'))).toBe(true);
  });

  it('ONE-SOURCE-HEAD: an in-app VCO holds the head → the CV Buddy return is NOT summed in', () => {
    // vco is the head (first in-app source); cvb is tapped but its ES-9 return is
    // NOT auto-wired (the one-source rule — the return would be a 2nd source).
    const edges = planColumnWiring(
      ctxB([member('vco', VCO), member('cvb', CV_BUDDY)], 'vco', RET('cvb', 1, 2)),
    );
    const ids = new Set(edges.map((e) => e.id));
    // vco (head) sends to the mixer.
    expect(ids.has(wcolEdgeId('vco', 'out', 'mix', 'ch3L'))).toBe(true);
    // The ES-9 return is NOT wired anywhere (no auto-sum).
    expect(edges.some((e) => e.source.nodeId === 'es9')).toBe(false);
    // The CV Buddy is still tapped (additive automation channel).
    expect(ids.has(wcolEdgeId('clip', 'pitch3', 'cvb', 'pitch'))).toBe(true);
  });

  it('ADDITIVE: adding a CV Buddy tap leaves an in-app VCO’s own clip control + send unchanged', () => {
    const base = planColumnWiring(ctxB([member('vco', VCO)], 'vco'));
    const withTap = planColumnWiring(ctxB([member('vco', VCO), member('cvb', CV_BUDDY)], 'vco', RET('cvb', 1, 2)));
    const withIds = new Set(withTap.map((e) => e.id));
    // Every base edge (vco clip control + vco→mixer send) survives verbatim.
    for (const e of base) expect(withIds.has(e.id), `missing ${e.id}`).toBe(true);
    // And the tap edges are purely NET-NEW.
    expect(withIds.has(wcolEdgeId('clip', 'pitch3', 'cvb', 'pitch'))).toBe(true);
  });

  it('DETERMINISM: byte-identical edge sets across calls (return + tap)', () => {
    const mk = () => planColumnWiring(ctxB([member('cvb', CV_BUDDY), member('rev', REVERB_ST)], 'cvb', RET('cvb', 1, 2)));
    expect(JSON.stringify(mk())).toBe(JSON.stringify(mk()));
    for (const e of mk()) expect(e.id.startsWith('wcol-e-')).toBe(true);
  });
});

describe('isReturnSource + isNoteSink (Part B classifiers)', () => {
  it('the LIVE cvBuddy is a note sink AND a return source', async () => {
    const { isNoteSink, isReturnSource } = await import('./patch-convenience');
    const cvb = liveDef('cvBuddy')!;
    expect(isNoteSink(cvb)).toBe(true);
    expect(isReturnSource(cvb)).toBe(true);
    // A note sink has no main audio in/out — it never joins the audio chain.
    expect(isChainAudioParticipant(cvb)).toBe(false);
    expect(chainRole(cvb)).toBeNull();
  });

  it('the LIVE midiOutBuddy is a note sink but NOT a return source', async () => {
    const { isNoteSink, isReturnSource } = await import('./patch-convenience');
    const mo = liveDef('midiOutBuddy')!;
    expect(isNoteSink(mo)).toBe(true);
    expect(isReturnSource(mo)).toBe(false);
  });
});

// ================================================================
// resolveColumnHead — the one-head classifier (tri-state flag)
// ================================================================

describe('resolveColumnHead (deterministic one-head classifier)', () => {
  const s = (nodeId: string, isHead?: boolean) => ({ nodeId, isHead });

  it('a single fresh source (undefined flag) becomes the head', () => {
    const r = resolveColumnHead([s('a')]);
    expect(r.headNodeId).toBe('a');
    expect(r.flagWrites).toEqual([{ nodeId: 'a', isHead: true }]);
  });

  it('two fresh sources: the FIRST in order is promoted, the 2nd is a deliberate non-head', () => {
    const r = resolveColumnHead([s('a'), s('b')]);
    expect(r.headNodeId).toBe('a');
    expect(r.flagWrites).toEqual([
      { nodeId: 'a', isHead: true },
      { nodeId: 'b', isHead: false },
    ]);
  });

  it('an existing head is KEPT and a fresh 2nd source is classified non-head (no re-promotion)', () => {
    const r = resolveColumnHead([s('a', true), s('b')]);
    expect(r.headNodeId).toBe('a');
    expect(r.flagWrites).toEqual([{ nodeId: 'b', isHead: false }]);
  });

  it('DELETE HEAD → a lone surviving non-head is NOT promoted (headless, no writes)', () => {
    // The head 'a' was deleted; 'b' remains flagged false (deliberate non-head).
    const r = resolveColumnHead([s('b', false)]);
    expect(r.headNodeId).toBeNull();
    expect(r.flagWrites).toEqual([]);
  });

  it('ADD source to a headless column (existing non-head + fresh) → the FRESH one becomes head', () => {
    const r = resolveColumnHead([s('b', false), s('c')]);
    expect(r.headNodeId).toBe('c');
    expect(r.flagWrites).toEqual([{ nodeId: 'c', isHead: true }]);
  });

  it('collab race — TWO flagged heads → the FIRST in order wins, the 2nd is demoted', () => {
    const r = resolveColumnHead([s('a', true), s('b', true)]);
    expect(r.headNodeId).toBe('a');
    expect(r.flagWrites).toEqual([{ nodeId: 'b', isHead: false }]);
  });

  it('IDEMPOTENT — a fully-classified column yields no writes', () => {
    expect(resolveColumnHead([s('a', true), s('b', false)]).flagWrites).toEqual([]);
    expect(resolveColumnHead([]).headNodeId).toBeNull();
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
