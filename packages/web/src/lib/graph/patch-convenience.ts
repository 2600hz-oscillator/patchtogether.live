// packages/web/src/lib/graph/patch-convenience.ts
//
// PURE, framework-free eligibility + wiring planner for the workflow-mode
// right-click convenience wiring, now folded into a single channel-indexed
// action ("Assign to channel N"):
//   • CLIP CONTROL  — auto-wire a clip-player channel to an instrument
//   • SEND TO MIXER — auto-wire an audio module to a mixer channel
// (The Canvas layer combines these plans with the module→automation-lane
// assignment for "Assign to channel N"; automation itself lives in
// automation-assign.ts.)
//
// DESIGN — NO ALLOW-LIST. Both actions are gated ENTIRELY by a module's port
// DEF (its inputs/outputs/stereoPairs), computed procedurally here, so any
// module that meets the shape criteria gets the option and any that doesn't
// never sees it. Owner-locked eligibility rules (2026-07-20):
//
//   CLIP (Control from):  a module qualifies as an instrument if it can be
//   played by notes — it has a POLY input (polyPitchGate), OR it has a v/oct
//   PITCH input AND a NOTE-GATE input — AND it is NOT itself a note SOURCE
//   (a sequencer/keyboard that EMITS notes). A "note gate" is a gate-typed
//   input that gates a NOTE; CONTROL gates (freeze / reset / sync / clock /
//   record / hold / stop / start) do not count, so e.g. clouds' freeze_gate
//   or a sequencer's record inputs never make it look playable.
//
//   MIXER (Send to):  a module qualifies as an audio source if it has an
//   identifiable MAIN audio output — a stereo L/R pair (resolved via its
//   stereoPairs, naming-agnostic, or an L/R id-token pair) OR a single mono
//   audio out (or one canonical "main"/"out"/"mix" among several) — EVEN if it
//   also exposes extra per-voice / sync / CV outputs. A bank of equal parallel
//   audio outs with no identifiable main (matrix mixers, multi-waveform VCOs)
//   has no main pair → not eligible (the user would have to pick a specific out).
//
// PURITY — no Svelte / SvelteFlow / Yjs imports. Consumes only the data-model
// PortDef shape + the shared findStereoSibling. The Canvas layer builds the
// concrete edges (commitCarriedEdge + writeStereoSiblingEdge) from these plans.

import type { PortDef, CableType, ChainWiring } from './types';
import { findStereoSibling, type StereoDef } from './stereo-autowire';

export type { ChainWiring };

/** The minimal def shape these predicates read. Any AudioModuleDef / video def
 *  with an audio out is assignable. */
export interface ConvenienceDef {
  inputs: readonly PortDef[];
  outputs: readonly PortDef[];
  stereoPairs?: readonly (readonly [string, string])[];
  /** Optional workflow-column chain-wiring override — see ChainWiring. */
  chainWiring?: ChainWiring;
}

// ---------------- Port-role vocabulary (procedural, not a module list) ----------------

/** Gate-typed inputs whose id denotes a CONTROL gate (transport / modulation /
 *  ingest), not a musical note gate. Matched as whole words against the port id
 *  split on non-alphanumerics, so `freeze_gate`, `resetIn`, `record` all match
 *  but a note gate id like `gate` / `trig` / `strike` does not. This is a
 *  PORT-ROLE classifier (like the trigger/gate `edge` seam), not a per-module
 *  allow-list — it generalises to any module. */
const CONTROL_GATE_WORDS = new Set<string>([
  'freeze', 'reset', 'sync', 'clock', 'record', 'rec', 'hold', 'stop',
  'start', 'run', 'arm', 'latch', 'sample', 'shift', 'load', 'clear',
]);

/** Canonical MAIN-output ids — used to pick the mono main among SEVERAL audio
 *  outs by EXACT id match, so a module whose primary out is `audio` plus a
 *  secondary tap `audio_inv` (vca), or `out` plus `aux`/`mod_out`/`sum_out`
 *  (macrooscillator / swolevco), resolves to the real main. Exact (not
 *  substring) match is essential: `audio_inv` also *contains* "audio", so a
 *  substring rule would see two mains and give up. `audio` is THE canonical
 *  mono-audio output id in this codebase. */
const MAIN_OUT_IDS = new Set<string>(['audio', 'out', 'output', 'main', 'mix', 'master']);

/** Canonical MAIN-input ids — the input-side mirror of MAIN_OUT_IDS, used to
 *  pick the mono main INPUT among several audio inputs by EXACT id match (a
 *  filter whose primary in is `audio`/`in`/`input` plus a secondary sidechain
 *  tap resolves to the real main). `audio` / `in` / `input` are the canonical
 *  mono-audio input ids in this codebase. */
const MAIN_IN_IDS = new Set<string>(['audio', 'in', 'input', 'main', 'audio_in', 'audioin']);

/** L / R side words for id-token stereo detection when a def declares no
 *  stereoPairs (audioIn, stereovca, twotracks, …). */
const LEFT_WORDS = new Set<string>(['l', 'left']);
const RIGHT_WORDS = new Set<string>(['r', 'right']);

function idWords(id: string): string[] {
  return id.split(/[^a-zA-Z0-9]+/).flatMap((seg) =>
    // split camelCase too: inL → ['in','L']
    seg.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/),
  ).filter(Boolean).map((w) => w.toLowerCase());
}

function hasControlGateWord(id: string): boolean {
  return idWords(id).some((w) => CONTROL_GATE_WORDS.has(w));
}

// ---------------- Port-shape probes ----------------

const isAudio = (p: PortDef): boolean => p.type === 'audio';
const isPitch = (p: PortDef): boolean => p.type === 'pitch';
const isPoly = (p: PortDef): boolean => p.type === 'polyPitchGate';
const isGate = (p: PortDef): boolean => p.type === 'gate';

/** A NOTE gate: a gate-typed INPUT that is not a control gate. `edge: 'trigger'`
 *  (a drum strike) and `edge: 'gate'` (a sustain) both count — both gate a note.
 *  Only the control-gate vocabulary excludes it. */
function isNoteGateInput(p: PortDef): boolean {
  return isGate(p) && !hasControlGateWord(p.id);
}

/** A v/oct PITCH input carried on a `cv` cable — the drum-voice convention
 *  (`pitch_cv`, a 1V/oct transpose typed `cv`, not `pitch`). Distinguished from a
 *  per-knob modulation CV by having NO `paramTarget` (every per-control CV
 *  declares one) and an id that denotes v/oct pitch (a `pitch` / `voct` id
 *  token). SHAPE-detected like every other predicate here, so any voice
 *  following the convention (kickdrum / snaredrum / tomtom) auto-enrols — no
 *  allow-list. */
function isVoctCvInput(p: PortDef): boolean {
  if (p.type !== 'cv' || p.paramTarget) return false;
  const w = idWords(p.id);
  return w.includes('pitch') || w.includes('voct') || (w.includes('v') && w.includes('oct'));
}

/** True if the module EMITS notes (a sequencer / keyboard / arpeggiator): it has
 *  a polyPitchGate OUTPUT, or it emits BOTH a pitch output and a gate output.
 *  Such a module drives instruments — it is never itself a clip target. */
export function isNoteSource(def: ConvenienceDef): boolean {
  const outs = def.outputs;
  if (outs.some(isPoly)) return true;
  return outs.some(isPitch) && outs.some(isGate);
}

// ---------------- CLIP eligibility ----------------

export interface ClipWiring {
  /** How this instrument accepts clip control.
   *  - poly:          one edge, clip poly out → the poly input (whole chord).
   *  - monoPitchGate: two edges, pitch out → v/oct in AND gate out → gate in.
   *  - gateOnly:      one edge, gate out → the note-gate in (percussion — a
   *                   triggered instrument with no v/oct pitch, e.g. kickdrum). */
  mode: 'poly' | 'monoPitchGate' | 'gateOnly';
  /** The instrument INPUT port for the clip pitch/poly out (poly + mono modes). */
  pitchInPort?: string;
  /** The instrument INPUT port for the clip gate out (mono + gateOnly modes). */
  gateInPort?: string;
}

/** Does the module produce an audio output? (An instrument makes sound — used to
 *  distinguish a triggered VOICE from a gated utility for the gate-only path.) */
function hasAudioOut(def: ConvenienceDef): boolean {
  return def.outputs.some(isAudio);
}

/**
 * Resolve HOW a clip player should drive this module, or null if it is not a
 * clip target. Precedence: POLY (keeps the whole chord) → mono PITCH+GATE →
 * GATE-ONLY percussion (a note-gate + audio out but no pitch input at all, e.g.
 * clap — the clip only triggers it). A note SOURCE (sequencer/keyboard) is never
 * a target.
 *
 * A percussion voice that DOES expose a 1V/oct on a `cv` cable (`pitch_cv` — the
 * kickdrum/snaredrum/tomtom convention) is wired monoPitchGate too, mapping the
 * clip PITCH onto the v/oct so a tuned drum tracks the clip's notes rather than
 * only firing on the gate.
 */
export function resolveClipWiring(def: ConvenienceDef): ClipWiring | null {
  if (isNoteSource(def)) return null;

  const polyIn = def.inputs.find(isPoly);
  if (polyIn) return { mode: 'poly', pitchInPort: polyIn.id };

  const gateIn = def.inputs.find(isNoteGateInput);

  // Native mono pitch (a `pitch` v/oct cable) + note-gate.
  const pitchIn = def.inputs.find(isPitch);
  if (pitchIn && gateIn) {
    return { mode: 'monoPitchGate', pitchInPort: pitchIn.id, gateInPort: gateIn.id };
  }

  // Percussion voice: a note-gate + audio out, no native `pitch` cable. If it
  // exposes a v/oct on a `cv` cable (the drum `pitch_cv` convention) map the
  // clip PITCH to it too (monoPitchGate); otherwise it is a pure gate-triggered
  // voice with no pitch to send (gateOnly).
  if (gateIn && hasAudioOut(def)) {
    const voctIn = def.inputs.find(isVoctCvInput);
    if (voctIn) {
      return { mode: 'monoPitchGate', pitchInPort: voctIn.id, gateInPort: gateIn.id };
    }
    return { mode: 'gateOnly', gateInPort: gateIn.id };
  }
  return null;
}

/** Does "Control from → Clip N" appear for this module? */
export function isClipEligible(def: ConvenienceDef): boolean {
  return resolveClipWiring(def) !== null;
}

// ---------------- MIXER eligibility ----------------

export type MainAudioOut =
  | { kind: 'stereo'; left: string; right: string }
  | { kind: 'mono'; out: string };

/** Order an L/R id-token pair so the L side is `left`. Falls back to input
 *  order if neither side has a clear L/R word. */
function orderLr(a: PortDef, b: PortDef): { left: string; right: string } {
  const aLeft = idWords(a.id).some((w) => LEFT_WORDS.has(w));
  const bLeft = idWords(b.id).some((w) => LEFT_WORDS.has(w));
  if (bLeft && !aLeft) return { left: b.id, right: a.id };
  return { left: a.id, right: b.id };
}

/**
 * Resolve the module's MAIN audio output — a stereo pair or a mono out — or
 * null if there is no identifiable main audio output. Only `audio`-typed
 * outputs are considered (CV/pitch/gate/video outs are ignored), so a module
 * whose only audio is a real signal bus qualifies and a pure-CV/video module
 * does not.
 */
export function resolveMainAudioOut(def: ConvenienceDef): MainAudioOut | null {
  // 0) chainWiring override wins — a module's def declares its true chain out.
  const ov = def.chainWiring?.outPorts;
  if (ov && ov.length > 0) {
    return ov.length === 2
      ? { kind: 'stereo', left: ov[0], right: ov[1]! }
      : { kind: 'mono', out: ov[0] };
  }

  const audioOuts = def.outputs.filter(isAudio);
  if (audioOuts.length === 0) return null;

  // 1) Stereo pair via declared stereoPairs (authoritative, naming-agnostic).
  for (const o of audioOuts) {
    const sib = findStereoSibling(def as StereoDef, o.id);
    if (sib && audioOuts.some((p) => p.id === sib)) {
      // Emit the tuple in the def's declared order (L, R).
      const pair = def.stereoPairs?.find(
        (t) => (t[0] === o.id && t[1] === sib) || (t[1] === o.id && t[0] === sib),
      );
      if (pair) {
        const first = audioOuts.find((p) => p.id === pair[0])!;
        const second = audioOuts.find((p) => p.id === pair[1])!;
        return { kind: 'stereo', ...orderLr(first, second) };
      }
    }
  }

  // 2) Stereo pair via L/R id tokens (modules with no declared stereoPairs).
  const leftOut = audioOuts.find((p) => idWords(p.id).some((w) => LEFT_WORDS.has(w)));
  const rightOut = audioOuts.find((p) => idWords(p.id).some((w) => RIGHT_WORDS.has(w)));
  if (leftOut && rightOut && leftOut.id !== rightOut.id) {
    return { kind: 'stereo', left: leftOut.id, right: rightOut.id };
  }

  // 3) Single mono audio out.
  if (audioOuts.length === 1) return { kind: 'mono', out: audioOuts[0].id };

  // 4) One canonical main among several audio outs — the out whose id is EXACTLY
  //    a main name (audio/out/main/…), with the others being secondary taps.
  const mains = audioOuts.filter((p) => MAIN_OUT_IDS.has(p.id.toLowerCase()));
  if (mains.length === 1) return { kind: 'mono', out: mains[0].id };

  // 5) A bank of equal parallel outs with no identifiable main → not eligible.
  return null;
}

/** Does "Send to → MixMaster ch N" appear for this module? */
export function isMixerEligible(def: ConvenienceDef): boolean {
  return resolveMainAudioOut(def) !== null;
}

// ---------------- Clip / mixer channel port maps ----------------
//
// The clip-player and MixMaster channel port ids are STATIC (built from a
// compile-time constant in each def), so the channel→port mapping is encoded
// here rather than re-scanned. Guarded by patch-convenience.test.ts against the
// live clipplayer / mixmstrs defs so a def change trips the test.

/** Clip player: 8 lanes (1-based). Per channel the pitch/poly source is
 *  `pitch{n}` (a polyPitchGate cable — carries the whole chord for a poly
 *  input, and the root for a mono pitch input via the engine splitter); the
 *  gate source is `gate{n}`. */
export const CLIP_CHANNEL_COUNT = 8;
export function clipChannelPorts(channel: number): { pitchOut: string; gateOut: string } {
  return { pitchOut: `pitch${channel}`, gateOut: `gate${channel}` };
}

/** MixMaster: 8 stereo channels (1-based). Per channel the inputs are
 *  `ch{n}L` / `ch{n}R` (audio). Matches MIXMSTRS_CHANNELS (the mixmstrs def's
 *  8-channel layout); guarded by the channel-port-map test against the live def. */
export const MIXER_CHANNEL_COUNT = 8;
export function mixerChannelPorts(channel: number): { leftIn: string; rightIn: string } {
  return { leftIn: `ch${channel}L`, rightIn: `ch${channel}R` };
}

// ---------------- Concrete edge plans ----------------

/** One source→target edge to write, with resolved cable types. */
export interface ConvenienceEdge {
  fromPortId: string;
  toPortId: string;
  sourceType: CableType;
  targetType: CableType;
}

/**
 * Plan the edges for "Control from → Clip {channel}" on an instrument.
 * - poly instrument: one edge, clip `pitch{n}` (polyPitchGate) → the poly input.
 * - mono instrument: two edges, `pitch{n}` → pitch input AND `gate{n}` → gate input.
 * Returns null if the module is not a clip target.
 */
export function planClipControl(def: ConvenienceDef, channel: number): ConvenienceEdge[] | null {
  const wiring = resolveClipWiring(def);
  if (!wiring) return null;
  const { pitchOut, gateOut } = clipChannelPorts(channel);

  if (wiring.mode === 'poly') {
    const polyIn = def.inputs.find((p) => p.id === wiring.pitchInPort)!;
    return [{ fromPortId: pitchOut, toPortId: polyIn.id, sourceType: 'polyPitchGate', targetType: polyIn.type }];
  }
  if (wiring.mode === 'gateOnly') {
    const gateIn = def.inputs.find((p) => p.id === wiring.gateInPort)!;
    return [{ fromPortId: gateOut, toPortId: gateIn.id, sourceType: 'gate', targetType: gateIn.type }];
  }
  const pitchIn = def.inputs.find((p) => p.id === wiring.pitchInPort)!;
  const gateIn = def.inputs.find((p) => p.id === wiring.gateInPort)!;
  return [
    { fromPortId: pitchOut, toPortId: pitchIn.id, sourceType: 'polyPitchGate', targetType: pitchIn.type },
    { fromPortId: gateOut, toPortId: gateIn.id, sourceType: 'gate', targetType: gateIn.type },
  ];
}

/**
 * Plan the edges for "Send to → MixMaster ch {channel}" on an audio module.
 * - stereo source: L→ch{n}L, R→ch{n}R.
 * - mono source: the single out → BOTH ch{n}L and ch{n}R (mono fills the pair,
 *   reusing the stereo double-patch shape).
 * Returns null if the module has no identifiable main audio output.
 */
export function planSendToMixer(def: ConvenienceDef, channel: number): ConvenienceEdge[] | null {
  const main = resolveMainAudioOut(def);
  if (!main) return null;
  const { leftIn, rightIn } = mixerChannelPorts(channel);

  if (main.kind === 'stereo') {
    return [
      { fromPortId: main.left, toPortId: leftIn, sourceType: 'audio', targetType: 'audio' },
      { fromPortId: main.right, toPortId: rightIn, sourceType: 'audio', targetType: 'audio' },
    ];
  }
  return [
    { fromPortId: main.out, toPortId: leftIn, sourceType: 'audio', targetType: 'audio' },
    { fromPortId: main.out, toPortId: rightIn, sourceType: 'audio', targetType: 'audio' },
  ];
}

// ================= WORKFLOW CHANNEL COLUMNS (net-new) =================
//
// The workflow-mode "channel columns" feature chains modules vertically inside
// a column (source → filter → reverb → mixer channel). The reconciler DRIVES
// the planners above (planClipControl on the source, planSendToMixer on the
// tail) plus the new resolveMainAudioIn/planColumnChain here for the internal
// adjacent-pair links — proving it is not a parallel system. Every function
// below is PURE (no Svelte / Yjs); the Canvas applicator + the automation-assign
// janitor commit the results.

export type MainAudioIn =
  | { kind: 'stereo'; left: string; right: string }
  | { kind: 'mono'; in: string };

/**
 * Resolve the module's MAIN audio INPUT — the input-side mirror of
 * resolveMainAudioOut. A stereo pair or a mono in, or null if there is no
 * identifiable main audio input (a pure source / pure-CV / pure-video module).
 * Precedence identical to the output resolver:
 *   0) chainWiring.inPorts override (a module declares its true insert input).
 *   1) declared stereoPairs among the audio inputs (authoritative).
 *   2) an L/R id-token pair.
 *   3) a single mono audio input.
 *   4) one canonical main (`audio`/`in`/`input`/…) among several audio inputs.
 *   5) a bank of equal parallel inputs with no identifiable main → null.
 */
export function resolveMainAudioIn(def: ConvenienceDef): MainAudioIn | null {
  // 0) chainWiring override wins.
  const ov = def.chainWiring?.inPorts;
  if (ov && ov.length > 0) {
    return ov.length === 2
      ? { kind: 'stereo', left: ov[0], right: ov[1]! }
      : { kind: 'mono', in: ov[0] };
  }

  const audioIns = def.inputs.filter(isAudio);
  if (audioIns.length === 0) return null;

  // 1) Stereo pair via declared stereoPairs.
  for (const p of audioIns) {
    const sib = findStereoSibling(def as StereoDef, p.id);
    if (sib && audioIns.some((q) => q.id === sib)) {
      const pair = def.stereoPairs?.find(
        (t) => (t[0] === p.id && t[1] === sib) || (t[1] === p.id && t[0] === sib),
      );
      if (pair) {
        const first = audioIns.find((q) => q.id === pair[0])!;
        const second = audioIns.find((q) => q.id === pair[1])!;
        return { kind: 'stereo', ...orderLr(first, second) };
      }
    }
  }

  // 2) Stereo pair via L/R id tokens.
  const leftIn = audioIns.find((p) => idWords(p.id).some((w) => LEFT_WORDS.has(w)));
  const rightIn = audioIns.find((p) => idWords(p.id).some((w) => RIGHT_WORDS.has(w)));
  if (leftIn && rightIn && leftIn.id !== rightIn.id) {
    return { kind: 'stereo', left: leftIn.id, right: rightIn.id };
  }

  // 3) Single mono audio in.
  if (audioIns.length === 1) return { kind: 'mono', in: audioIns[0].id };

  // 4) One canonical main among several audio ins.
  const mains = audioIns.filter((p) => MAIN_IN_IDS.has(p.id.toLowerCase()));
  if (mains.length === 1) return { kind: 'mono', in: mains[0].id };

  // 5) No identifiable main input.
  return null;
}

/** Declared chain ROLE for a module — the chainWiring override, else inferred
 *  from its main-in / main-out shape. `both` = a DSP insert (has both);
 *  `source` = emits audio but takes none; `dsp` = takes audio but the resolver
 *  found no main out (rare). A module with neither is not audio-participating. */
export function chainRole(def: ConvenienceDef): 'source' | 'dsp' | 'both' | null {
  if (def.chainWiring?.role) return def.chainWiring.role;
  const hasOut = resolveMainAudioOut(def) !== null;
  const hasIn = resolveMainAudioIn(def) !== null;
  if (hasOut && hasIn) return 'both';
  if (hasOut) return 'source';
  if (hasIn) return 'dsp';
  return null;
}

/** True when a module participates in a column's AUDIO chain (has a resolvable
 *  main out OR main in). A pure-video / pure-CV member does not — it stays a
 *  visual, automation-only column member. */
export function isChainAudioParticipant(def: ConvenienceDef): boolean {
  return resolveMainAudioOut(def) !== null || resolveMainAudioIn(def) !== null;
}

/** MixMaster aux-send ports for send slot `n` (1|2): the send OUTPUT the loop's
 *  head reads (send{n}L/R) and the RETURN input its tail feeds (ret{n}L/R).
 *  Guarded against the live mixmstrs def by the channel-port-map test. */
export const SEND_SLOT_COUNT = 2;
export function sendPorts(slot: number): {
  sendL: string;
  sendR: string;
  retL: string;
  retR: string;
} {
  return { sendL: `send${slot}L`, sendR: `send${slot}R`, retL: `ret${slot}L`, retR: `ret${slot}R` };
}

/** One planned chain edge (node-qualified — chain links cross node pairs). */
export interface ChainEdgePlan {
  fromNodeId: string;
  fromPortId: string;
  toNodeId: string;
  toPortId: string;
  sourceType: CableType;
  targetType: CableType;
}

/**
 * Plan the audio-signal edges linking ONE adjacent pair (up → down):
 * resolveMainAudioOut(up) → resolveMainAudioIn(down), emitting BOTH L and R
 * EXPLICITLY (never relying on the engine's stereo normaling):
 *   - stereo → stereo: L→L, R→R.
 *   - mono   → stereo: mono fills BOTH L and R (two edges).
 *   - stereo → mono:   L and R BOTH into the mono in (two edges → the engine
 *                      SUMS them = a stereo→mono downmix).
 *   - mono   → mono:   one edge (the duplicate is de-duped).
 * Returns [] when either side has no identifiable main (skip this link).
 */
export function planPairLink(
  upNodeId: string,
  upDef: ConvenienceDef,
  downNodeId: string,
  downDef: ConvenienceDef,
): ChainEdgePlan[] {
  const out = resolveMainAudioOut(upDef);
  const inn = resolveMainAudioIn(downDef);
  if (!out || !inn) return [];
  const outL = out.kind === 'stereo' ? out.left : out.out;
  const outR = out.kind === 'stereo' ? out.right : out.out;
  const inL = inn.kind === 'stereo' ? inn.left : inn.in;
  const inR = inn.kind === 'stereo' ? inn.right : inn.in;
  const raw: ChainEdgePlan[] = [
    { fromNodeId: upNodeId, fromPortId: outL, toNodeId: downNodeId, toPortId: inL, sourceType: 'audio', targetType: 'audio' },
    { fromNodeId: upNodeId, fromPortId: outR, toNodeId: downNodeId, toPortId: inR, sourceType: 'audio', targetType: 'audio' },
  ];
  // De-dup identical endpoint pairs (mono→mono yields the same edge twice).
  const seen = new Set<string>();
  const out2: ChainEdgePlan[] = [];
  for (const e of raw) {
    const k = `${e.fromPortId}->${e.toPortId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out2.push(e);
  }
  return out2;
}

/** A column member for the wiring planner: its node id + its resolved def. */
export interface ColumnMember {
  nodeId: string;
  def: ConvenienceDef;
}

/** Deterministic namespaced edge id for a reconciler-OWNED workflow-column
 *  edge. The `wcol-` prefix is what makes the stale-removal pass structurally
 *  unable to touch a hand-drawn (non-wcol) cable, and the endpoint-derived body
 *  makes two peers computing the same wiring converge on ONE Y.Map key. */
export function wcolEdgeId(
  src: string,
  srcPort: string,
  dst: string,
  dstPort: string,
): string {
  return `wcol-e-${src}-${srcPort}-${dst}-${dstPort}`;
}

/** A fully-formed reconciler-owned edge (Edge-shaped, wcol- id). */
export interface WcolEdge {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
  sourceType: CableType;
  targetType: CableType;
}

function toWcol(p: ChainEdgePlan): WcolEdge {
  return {
    id: wcolEdgeId(p.fromNodeId, p.fromPortId, p.toNodeId, p.toPortId),
    source: { nodeId: p.fromNodeId, portId: p.fromPortId },
    target: { nodeId: p.toNodeId, portId: p.toPortId },
    sourceType: p.sourceType,
    targetType: p.targetType,
  };
}

/** Context for planning a whole column's reconciler-owned wiring. */
export interface ColumnWiringCtx {
  /** 1-based channel number. */
  channel: number;
  /** Ordered members source → … → tail (columns[ch], already pruned/deduped). */
  members: readonly ColumnMember[];
  /** The canonical clip-player node id (source of pitch/gate), or null. */
  clipPlayerId: string | null;
  /** The canonical mixmstrs node id (channel destination), or null. */
  mixerId: string | null;
}

/** True when a member is a chain SOURCE — it has no identifiable main audio IN,
 *  so it can only be the HEAD of an island (never fed by an upstream member). A
 *  pure source (VCO), a non-audio instrument, and a video-VCO all qualify; a DSP
 *  (filter/reverb) or a both-ports insert (twotracks override) does NOT. */
function isChainSource(def: ConvenienceDef): boolean {
  return resolveMainAudioIn(def) === null;
}

/**
 * Plan the COMPLETE reconciler-owned edge set for one column, DETERMINISTICALLY
 * (pure function of the members array + channel + endpoints). Two peers with the
 * same inputs produce byte-identical WcolEdge[] (same ids), so the Y.Map
 * converges. ROLE-BASED single-strip model — a channel column is ONE channel
 * strip = ONE audio path to the mixer, INDEPENDENT of the order members were
 * added (owner bug 3):
 *   - CLIP CONTROL: EVERY source instrument on the channel (clip-eligible + no
 *     audio-in) gets the clip's pitch{n}/gate{n} → layered play.
 *   - CHAIN: SOURCES (no main audio-in) are the chain HEADS; FX (have a main
 *     audio-in) form the post-source chain in column order. Every source feeds
 *     the FX-chain head (summed there); with NO FX the sources go straight to
 *     the mixer channel.
 *   - SEND: a SINGLE tail per column → ch{n}L/R. With FX the tail is the last FX
 *     with a main out; with no FX every source is its own tail and they SUM at
 *     the mixer channel bus (the owner's multi-source default). Deriving heads
 *     from ROLE (not raw insertion order) makes [source, FX] and [FX, source]
 *     wire IDENTICALLY — no double-send into the mixer, no missing splice.
 */
export function planColumnWiring(ctx: ColumnWiringCtx): WcolEdge[] {
  const { channel, members, clipPlayerId, mixerId } = ctx;
  const out: WcolEdge[] = [];
  const seenIds = new Set<string>();
  const push = (e: WcolEdge) => {
    if (seenIds.has(e.id)) return;
    seenIds.add(e.id);
    out.push(e);
  };

  // (1) CLIP CONTROL — every SOURCE instrument (clip-eligible + no audio-in).
  //     A fed DSP (has audio-in) is driven by the chain, never by the clip.
  if (clipPlayerId) {
    for (const m of members) {
      if (resolveClipWiring(m.def) === null) continue;
      if (!isChainSource(m.def)) continue;
      const clip = planClipControl(m.def, channel);
      if (!clip) continue;
      for (const e of clip) {
        push(toWcol({
          fromNodeId: clipPlayerId, fromPortId: e.fromPortId,
          toNodeId: m.nodeId, toPortId: e.toPortId,
          sourceType: e.sourceType, targetType: e.targetType,
        }));
      }
    }
  }

  // (2)+(3) ROLE-BASED CHAIN + single send. Split the audio participants by ROLE
  // (NOT insertion order): SOURCES have no main audio-in, FX do. FX chain in
  // column order; every source feeds the FX head (or the mixer if there is no
  // FX); a SINGLE tail feeds ch{n}.
  const audio = members.filter((m) => isChainAudioParticipant(m.def));
  const sources = audio.filter((m) => isChainSource(m.def));
  const fx = audio.filter((m) => !isChainSource(m.def)); // has a main audio-in

  // FX internal chain: fx[i] → fx[i+1] (column order among the FX).
  for (let i = 0; i + 1 < fx.length; i++) {
    for (const e of planPairLink(fx[i]!.nodeId, fx[i]!.def, fx[i + 1]!.nodeId, fx[i + 1]!.def)) {
      push(toWcol(e));
    }
  }

  // Every source feeds the HEAD of the FX chain (they sum into it). With no FX
  // the sources go straight to the mixer channel (handled by the send pass).
  if (fx.length > 0) {
    const head = fx[0]!;
    for (const s of sources) {
      for (const e of planPairLink(s.nodeId, s.def, head.nodeId, head.def)) push(toWcol(e));
    }
  }

  // SEND-TO-MIXER — a SINGLE tail per column. With FX: the last FX with a main
  // out. Without FX: every source is its own tail (they sum at the ch bus).
  if (mixerId) {
    const emitSend = (m: ColumnMember) => {
      const send = planSendToMixer(m.def, channel);
      if (!send) return;
      for (const e of send) {
        push(toWcol({
          fromNodeId: m.nodeId, fromPortId: e.fromPortId,
          toNodeId: mixerId, toPortId: e.toPortId,
          sourceType: e.sourceType, targetType: e.targetType,
        }));
      }
    };
    if (fx.length > 0) {
      let tail: ColumnMember | null = null;
      for (const m of fx) if (resolveMainAudioOut(m.def) !== null) tail = m; // last main-out FX
      if (tail) emitSend(tail);
    } else {
      for (const s of sources) if (resolveMainAudioOut(s.def) !== null) emitSend(s);
    }
  }

  return out;
}

/** Context for planning a send-loop's reconciler-owned wiring. */
export interface SendWiringCtx {
  /** 1-based send slot (1|2). */
  slot: number;
  /** Ordered send tenants head → … → tail. */
  members: readonly ColumnMember[];
  /** The canonical mixmstrs node id (send output + return input), or null. */
  mixerId: string | null;
}

/**
 * Plan the reconciler-owned wiring for one aux-send loop:
 *   mixer.send{n}L/R → HEAD.mainIn ; internal adjacent links ; TAIL.mainOut →
 *   mixer.ret{n}L/R.
 * No clip control, no automation lane (a send is a pure shared bus for v1).
 * Deterministic + pure, same as planColumnWiring.
 */
export function planSendWiring(ctx: SendWiringCtx): WcolEdge[] {
  const { slot, members, mixerId } = ctx;
  const audio = members.filter((m) => isChainAudioParticipant(m.def));
  if (!mixerId || audio.length === 0) return [];
  const out: WcolEdge[] = [];
  const seenIds = new Set<string>();
  const push = (e: WcolEdge) => {
    if (seenIds.has(e.id)) return;
    seenIds.add(e.id);
    out.push(e);
  };
  const { sendL, sendR, retL, retR } = sendPorts(slot);

  // HEAD: mixer send{n}L/R → head module's main input. The mixer's send output
  // is a real stereo pair, so drive both sides of the head's main in.
  const head = audio[0]!;
  const headIn = resolveMainAudioIn(head.def);
  if (headIn) {
    const inL = headIn.kind === 'stereo' ? headIn.left : headIn.in;
    const inR = headIn.kind === 'stereo' ? headIn.right : headIn.in;
    push(toWcol({ fromNodeId: mixerId, fromPortId: sendL, toNodeId: head.nodeId, toPortId: inL, sourceType: 'audio', targetType: 'audio' }));
    if (inR !== inL) {
      push(toWcol({ fromNodeId: mixerId, fromPortId: sendR, toNodeId: head.nodeId, toPortId: inR, sourceType: 'audio', targetType: 'audio' }));
    }
  }

  // INTERNAL links.
  for (let i = 0; i + 1 < audio.length; i++) {
    for (const e of planPairLink(audio[i]!.nodeId, audio[i]!.def, audio[i + 1]!.nodeId, audio[i + 1]!.def)) {
      push(toWcol(e));
    }
  }

  // TAIL: tail module main out → mixer ret{n}L/R.
  const tail = audio[audio.length - 1]!;
  const tailOut = resolveMainAudioOut(tail.def);
  if (tailOut) {
    const outL = tailOut.kind === 'stereo' ? tailOut.left : tailOut.out;
    const outR = tailOut.kind === 'stereo' ? tailOut.right : tailOut.out;
    push(toWcol({ fromNodeId: tail.nodeId, fromPortId: outL, toNodeId: mixerId, toPortId: retL, sourceType: 'audio', targetType: 'audio' }));
    push(toWcol({ fromNodeId: tail.nodeId, fromPortId: outR, toNodeId: mixerId, toPortId: retR, sourceType: 'audio', targetType: 'audio' }));
  }

  return out;
}
