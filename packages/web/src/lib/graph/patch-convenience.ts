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

import type { PortDef, CableType } from './types';
import { findStereoSibling, type StereoDef } from './stereo-autowire';

/** The minimal def shape these predicates read. Any AudioModuleDef / video def
 *  with an audio out is assignable. */
export interface ConvenienceDef {
  inputs: readonly PortDef[];
  outputs: readonly PortDef[];
  stereoPairs?: readonly (readonly [string, string])[];
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
