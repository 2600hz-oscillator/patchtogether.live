// packages/web/src/lib/audio/modules/hydrogen-kit-types.ts
//
// Shared types for HYDROGEN drumkits. A kit is 16 instruments + a
// human-readable name + author/license info. Each instrument is either
// SAMPLE-based (a URL fetched + decoded on factory-init, played via
// BufferSource) or SYNTH-based (a Web Audio voice synthesized inline
// at trigger time — no asset, no LFS bloat).
//
// The hydrogen factory's fireInstrument() branches on inst.kind:
//   * 'sample' — clone of the existing BufferSource + filter + env path
//   * 'synth'  — call inst.synth(ctx, dest, atTime, opts) and let the
//                synth function own its nodes; we receive back a Voice
//                handle for choke-group bookkeeping.
//
// Per-voice user controls (Vol/Pan/Pitch/Cutoff/Q/A/D/S/R) are uniform
// across all kit types — the synth voice receives them via SynthOpts so
// sample + synth instruments behave the same way under the HydrogenCard
// knobs.

import type { TR808Instrument } from './hydrogen-tr808-kit-data';

/** Args passed to every kit instrument when it's triggered. Sample +
 *  synth voices both receive these so the HydrogenCard's per-voice
 *  knobs work identically across kits. */
export interface VoiceOpts {
  /** 0..1 — caller's velocity scalar; the factory sets this to 1 for
   *  pattern-grid steps; trig{i} CV passes the gate amplitude. */
  velocity: number;
  /** Pitch offset in semitones — sample kits apply via playbackRate
   *  (2^(pitchSt/12)); synth kits apply via base-frequency shift. */
  pitchSt: number;
  /** Lowpass cutoff in Hz — sample kits apply via per-voice
   *  BiquadFilter; synth kits typically apply via the same per-voice
   *  filter inserted on the signal chain. Defaults to 20 kHz (≈ open). */
  cutoffHz: number;
  /** Filter Q. Defaults to 0.7 (≈ flat) for both kit types. */
  q: number;
  /** ADSR (seconds). Sample kits apply as the existing amp envelope
   *  around the BufferSource; synth kits typically apply to the voice
   *  output gain. */
  attackS: number;
  decayS: number;
  sustain: number; // 0..1
  releaseS: number;
}

/** Returned by every synth instrument — the factory calls stop() during
 *  a mute-group choke. */
export interface SynthVoice {
  /** Schedule the voice to ramp out + tear down at `atTime`. Safe to
   *  call multiple times (no-op after the first). */
  stop(atTime: number): void;
  /** Resolves after the voice has naturally ended so the factory can
   *  drop its choke-group bookkeeping entry. */
  ended: Promise<void>;
}

/** A synthesized instrument. The synth function builds nodes, schedules
 *  them, and returns a SynthVoice for the factory. */
export type SynthFn = (
  ctx: AudioContext,
  /** The factory-owned per-instrument bus (instrumentGain[idx]). The
   *  synth's terminal node should connect here. */
  dest: AudioNode,
  atTime: number,
  opts: VoiceOpts,
) => SynthVoice;

/** Common fields for a kit instrument — id (0..15 slot), short label,
 *  long name, default mix (gain/pan), default amp envelope, mute group. */
interface KitInstrumentBase {
  id: number;
  label: string;
  name: string;
  midiNote?: number; // optional — only TR-808-derived kits set this
  defaultGain: number;
  defaultPan: number;
  defaultA: number;
  defaultD: number;
  defaultS: number;
  defaultR: number;
  /** 0 = no group. Voices sharing a group choke each other. */
  muteGroup: number;
}

/** Sample-based instrument — fetched + decoded on factory-init. */
export interface KitInstrumentSample extends KitInstrumentBase {
  kind: 'sample';
  sampleUrl: string;
}

/** Synth-based instrument — synthesized inline at trigger time. */
export interface KitInstrumentSynth extends KitInstrumentBase {
  kind: 'synth';
  synth: SynthFn;
}

export type KitInstrument = KitInstrumentSample | KitInstrumentSynth;

/** A complete drumkit — 16 instruments, name, attribution. */
export interface KitDef {
  /** Stable id used as the `kit` param value. */
  id: string;
  /** Short human-readable name (shown in the card header). */
  name: string;
  /** One-line attribution (license + author) — shown in the kit picker. */
  attribution: string;
  /** Exactly 16 instruments, ids 0..15. */
  instruments: readonly KitInstrument[];
}

/** Adapt a legacy TR808Instrument (sample-only, no `kind` discriminator)
 *  to the new KitInstrument shape. Lets the existing TR-808 data file
 *  participate in the kit registry without rewriting its data table. */
export function tr808ToKitInstrument(inst: TR808Instrument): KitInstrumentSample {
  return {
    kind: 'sample',
    id: inst.id,
    label: inst.label,
    name: inst.name,
    midiNote: inst.midiNote,
    sampleUrl: inst.sampleUrl,
    defaultGain: inst.defaultGain,
    defaultPan: inst.defaultPan,
    defaultA: inst.defaultA,
    defaultD: inst.defaultD,
    defaultS: inst.defaultS,
    defaultR: inst.defaultR,
    muteGroup: inst.muteGroup,
  };
}
