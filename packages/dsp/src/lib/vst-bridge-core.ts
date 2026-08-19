// packages/dsp/src/lib/vst-bridge-core.ts
//
// Pure core for the VST-bridge worklet (both cards: vstInstrument + vstFx):
// the poly-CV → MIDI voice state machine and the SharedArrayBuffer MIDI
// event ring. Unit-tested here (no Web Audio); the worklet in
// ../vst-bridge.ts is a thin block-mover over these primitives, exactly as
// es9-bridge.ts is over es9-bridge-core.ts.
//
// AUDIO rings are the same SPSC rings the es9 bridge uses — re-exported from
// ./es9-bridge-core (same package, ordinary reuse). The MIDI ring is new:
// fixed 16-byte records so the audio thread never allocates or posts.
//
// NOTE / VELOCITY CONVERSION — duplicated, not imported. The canonical
// definitions live web-side (packages/web/src/lib/audio/note-entry.ts
// `vOctToMidi`, modules/midi-out-buddy.ts `pitchCvToMidiNote` /
// `velocityCvToMidi` / `GATE_THRESHOLD`, modules/clip-types.ts
// `DEFAULT_VELOCITY`), but packages/web only consumes this package's BUILT
// dist bundles and the repo convention is duplicated constants over
// cross-package source imports (multiplayer/provider.ts documents the same
// choice; the es9 ring layout does the same in both directions). Twin tests
// pin the SAME note table on both sides so drift fails fast:
//   here: vst-bridge-core.test.ts   web: vst/vst-transport.test.ts
//
// Convention pinned by those tests: 0.0 pitch CV = C4 = MIDI 60; 1.0 = one
// octave. c3 = −1.0 → 48 · c4 = 0.0 → 60 · a4 = +0.75 → 69 · c5 = +1.0 → 72,
// clamped to MIDI 12..108 (c0..c8).

export { RingIO, createRingSpec, UnderrunFiller, FADE_FRAMES, type RingSpec } from './es9-bridge-core';

// ---------------------------------------------------------------------------
// Note / gate / velocity conversion (duplicates — see header)
// ---------------------------------------------------------------------------

/** Gate is "high" at/above this level (duplicate of midi-out-buddy.ts
 *  GATE_THRESHOLD; same value the sequencer transport edge-detectors use). */
export const GATE_HI = 0.5;

/** Velocity when the card's `vel` input is unpatched (duplicate of
 *  clip-types.ts DEFAULT_VELOCITY). */
export const DEFAULT_VELOCITY = 100;

/** Playable note span (duplicate of note-entry.ts MIN_MIDI/MAX_MIDI):
 *  c0 = MIDI 12 .. c8 = MIDI 108. */
export const MIN_MIDI = 12;
export const MAX_MIDI = 108;
export const C4_MIDI = 60;

/** V/oct → MIDI, rounded to the nearest semitone (0 V = C4 = MIDI 60). */
export function vOctToMidi(vOct: number): number {
  return Math.round(vOct * 12 + C4_MIDI);
}

/** Quantize a V/oct CV to the nearest playable MIDI note (clamped 12..108,
 *  7-bit safe). Non-finite input lands on C4 — the cable's rest value. */
export function pitchCvToMidiNote(vOct: number): number {
  if (!Number.isFinite(vOct)) return C4_MIDI;
  const m = vOctToMidi(vOct);
  return Math.max(0, Math.min(127, Math.max(MIN_MIDI, Math.min(MAX_MIDI, m))));
}

/** Map a 0..1 velocity CV to MIDI velocity 1..127. Floors at 1: NoteOn with
 *  velocity 0 IS NoteOff on the wire and must never be emitted as a NoteOn. */
export function velocityCvToMidi(cv: number): number {
  if (!Number.isFinite(cv)) return 1;
  const scaled = Math.round(Math.max(0, Math.min(1, cv)) * 127);
  return Math.max(1, Math.min(127, scaled));
}

// ---------------------------------------------------------------------------
// Voice state machine — per-sample, allocation-free
// ---------------------------------------------------------------------------

/** Allocation-free event sink: `len` is 2 or 3; trailing bytes are 0 when
 *  unused. `sampleTime` is the worklet's OUTGOING-stream frame counter — the
 *  same clock as the sampleTime in the card's outgoing 0x01 audio blocks. */
export type MidiEmit = (
  sampleTime: number,
  d0: number,
  d1: number,
  d2: number,
  len: number,
) => void;

const NOTE_ON = 0x90;  // channel 1
const NOTE_OFF = 0x80; // channel 1

/**
 * One poly voice-pair's gate/pitch → NoteOn/NoteOff state machine. Fed one
 * sample at a time (per-sample compare is correct by construction in a
 * worklet — no analyser-rescan hazards). Behavior, per the plan and pinned
 * by tests:
 *
 *  - gate RISE (prev < 0.5, cur ≥ 0.5) → NoteOn(note, vel) where `note` is
 *    the pitch CV sampled AT the rise and `vel` comes from the velocity CV
 *    at the rise (DEFAULT_VELOCITY when unpatched — pass NaN).
 *  - gate FALL → NoteOff for the voice's SOUNDING note (which may differ
 *    from the pitch CV at fall time).
 *  - pitch crosses to a different semitone while the gate is HIGH (tied /
 *    legato steps — the clip player holds gate across tied notes) →
 *    NoteOff(old) then NoteOn(new, same velocity) at the same sampleTime.
 *  - a retrigger (clipplayer dips the gate low for ~3 ms) is just fall+rise.
 *
 * Pitch is quantized round-to-nearest, so the legato compare has built-in
 * ±half-semitone bands; clip CV is stepped/sample-held, so no extra
 * hysteresis is needed (a free-running noisy pitch source could chatter at
 * a band edge — out of scope for the clip chain this card serves).
 */
export class PolyMidiVoice {
  private sounding = -1;      // MIDI note currently on, or -1
  private gateHigh = false;
  private vel = DEFAULT_VELOCITY;

  /** Feed one sample. `velCv` NaN ⇒ vel input unpatched ⇒ DEFAULT_VELOCITY. */
  process(
    pitchCv: number,
    gateLevel: number,
    velCv: number,
    sampleTime: number,
    emit: MidiEmit,
  ): void {
    const high = gateLevel >= GATE_HI;
    if (high && !this.gateHigh) {
      const note = pitchCvToMidiNote(pitchCv);
      const vel = Number.isNaN(velCv) ? DEFAULT_VELOCITY : velocityCvToMidi(velCv);
      // Defensive: a sounding note here means we missed a fall (shouldn't
      // happen sample-fed; cheap to make impossible on the wire).
      if (this.sounding >= 0) emit(sampleTime, NOTE_OFF, this.sounding, 0, 3);
      emit(sampleTime, NOTE_ON, note, vel, 3);
      this.sounding = note;
      this.vel = vel;
      this.gateHigh = true;
    } else if (!high && this.gateHigh) {
      if (this.sounding >= 0) emit(sampleTime, NOTE_OFF, this.sounding, 0, 3);
      this.sounding = -1;
      this.gateHigh = false;
    } else if (high && this.sounding >= 0) {
      const note = pitchCvToMidiNote(pitchCv);
      if (note !== this.sounding) {
        // Off-then-on, same sampleTime — the order the plugin needs to not
        // steal its own voice.
        emit(sampleTime, NOTE_OFF, this.sounding, 0, 3);
        emit(sampleTime, NOTE_ON, note, this.vel, 3);
        this.sounding = note;
      }
    }
  }

  /** Silence the voice (ring detach / card dispose): NoteOff anything
   *  sounding and reset, so no stuck note outlives the card. */
  flush(sampleTime: number, emit: MidiEmit): void {
    if (this.sounding >= 0) emit(sampleTime, NOTE_OFF, this.sounding, 0, 3);
    this.sounding = -1;
    this.gateHigh = false;
    this.vel = DEFAULT_VELOCITY;
  }

  get soundingNote(): number {
    return this.sounding;
  }
}

// ---------------------------------------------------------------------------
// SharedArrayBuffer SPSC MIDI event ring — fixed 16-byte records, one
// producer (the worklet), one consumer (the bridge Worker). Mirrored
// web-side in $lib/audio/vst/vst-ring.ts; the layouts must match
// byte-for-byte and twin tests pin the same raw-byte sequence on both sides.
//
// Record layout (16 bytes, native little-endian via the typed-array views —
// both halves run on the same machine):
//   bytes 0-3   sampleTime lo (u32)
//   bytes 4-7   sampleTime hi (u32)
//   byte  8     len (1-3)
//   bytes 9-11  MIDI data, zero-padded
//   bytes 12-15 reserved (0)
// header: SharedArrayBuffer(8) as Int32Array → [0]=head, [1]=tail,
//   monotonically increasing RECORD counters (int32 wrap;
//   occupancy = (head - tail) | 0). capacity is a power of two.
// ---------------------------------------------------------------------------

export const MIDI_RECORD_BYTES = 16;
const MIDI_RECORD_WORDS = 4; // Int32 words per record

export interface MidiRingSpec {
  header: SharedArrayBuffer;
  data: SharedArrayBuffer;
  /** Records; power of two. */
  capacity: number;
}

export class MidiRingIO {
  readonly capacity: number;
  private readonly mask: number;
  private readonly header: Int32Array;
  private readonly words: Int32Array;
  private readonly bytes: Uint8Array;

  constructor(spec: MidiRingSpec) {
    this.capacity = spec.capacity;
    this.mask = spec.capacity - 1;
    this.header = new Int32Array(spec.header);
    this.words = new Int32Array(spec.data);
    this.bytes = new Uint8Array(spec.data);
  }

  get occupancy(): number {
    return (Atomics.load(this.header, 0) - Atomics.load(this.header, 1)) | 0;
  }

  get free(): number {
    return this.capacity - this.occupancy;
  }

  /** Producer: append one event. Returns false (drops the event) when full —
   *  the worklet must never block; a full ring means the worker is gone and
   *  the far side silences parked instances anyway. */
  write(sampleTime: number, d0: number, d1: number, d2: number, len: number): boolean {
    const head = Atomics.load(this.header, 0);
    if (((head - Atomics.load(this.header, 1)) | 0) >= this.capacity) return false;
    const rec = head & this.mask;
    const w = rec * MIDI_RECORD_WORDS;
    this.words[w] = sampleTime % 0x1_0000_0000 | 0;
    this.words[w + 1] = Math.floor(sampleTime / 0x1_0000_0000) | 0;
    const b = rec * MIDI_RECORD_BYTES;
    this.bytes[b + 8] = len & 0xff;
    this.bytes[b + 9] = d0 & 0xff;
    this.bytes[b + 10] = len > 1 ? d1 & 0xff : 0;
    this.bytes[b + 11] = len > 2 ? d2 & 0xff : 0;
    this.bytes[b + 12] = 0;
    this.bytes[b + 13] = 0;
    this.bytes[b + 14] = 0;
    this.bytes[b + 15] = 0;
    Atomics.store(this.header, 0, (head + 1) | 0);
    return true;
  }

  /** Consumer: drain up to `max` events into `dst`. Returns events read. */
  read(
    max: number,
    dst: (sampleTime: number, d0: number, d1: number, d2: number, len: number) => void,
  ): number {
    const tail = Atomics.load(this.header, 1);
    const n = Math.min(max, ((Atomics.load(this.header, 0) - tail) | 0));
    if (n <= 0) return 0;
    for (let i = 0; i < n; i++) {
      const rec = (tail + i) & this.mask;
      const w = rec * MIDI_RECORD_WORDS;
      const lo = (this.words[w] ?? 0) >>> 0;
      const hi = (this.words[w + 1] ?? 0) >>> 0;
      const b = rec * MIDI_RECORD_BYTES;
      dst(
        hi * 0x1_0000_0000 + lo,
        this.bytes[b + 9] ?? 0,
        this.bytes[b + 10] ?? 0,
        this.bytes[b + 11] ?? 0,
        this.bytes[b + 8] ?? 0,
      );
    }
    Atomics.store(this.header, 1, (tail + n) | 0);
    return n;
  }
}

/** Allocate the SharedArrayBuffers for a MIDI ring (capacity rounded up to a
 *  power of two). Callers feature-detect SAB availability first. */
export function createMidiRingSpec(capacityRecords: number): MidiRingSpec {
  let cap = 2;
  while (cap < capacityRecords) cap <<= 1;
  return {
    header: new SharedArrayBuffer(8),
    data: new SharedArrayBuffer(cap * MIDI_RECORD_BYTES),
    capacity: cap,
  };
}
