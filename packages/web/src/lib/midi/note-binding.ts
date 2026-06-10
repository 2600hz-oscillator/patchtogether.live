// packages/web/src/lib/midi/note-binding.ts
//
// PURE note-message parsing + binding model. No Svelte / DOM / Yjs — so it
// unit-tests headlessly and is the SINGLE source of truth for the CC-vs-NOTE
// branch in the MIDI-learn singleton.
//
// A gate/trigger INPUT port or a card BUTTON binds to a MIDI NOTE (not a CC):
//   NOTE-on  => gate HIGH / button press
//   NOTE-off => gate LOW  (momentary release)
//
// The two binding kinds live in a discriminated union so the singleton, the
// performance bundle, and the UI all share one type with explicit guards.

/** A learned MIDI CC → param binding (continuous controls: knobs/faders). */
export interface MidiCcBinding {
  kind: 'cc';
  /** Composite "moduleId:paramId" — unique per control on the rack. */
  key: string;
  /** MIDI channel 0..15 the CC arrived on. */
  channel: number;
  /** CC number 0..127. */
  cc: number;
  /** When the binding was learned (epoch ms). */
  learnedAt: number;
}

/** A learned MIDI NOTE → gate/button binding (momentary on/off). */
export interface MidiNoteBinding {
  kind: 'note';
  /** Composite "moduleId:paramId" — unique per gate/button on the rack. */
  key: string;
  /** MIDI channel 0..15 the NOTE arrived on. */
  channel: number;
  /** Note number 0..127. */
  note: number;
  /** When the binding was learned (epoch ms). */
  learnedAt: number;
}

/** Either binding kind. One per key — a control is CC OR NOTE, never both. */
export type MidiBinding = MidiCcBinding | MidiNoteBinding;

/** Type guard: is this a CC binding? Treats a missing `kind` as 'cc' so legacy
 *  records (saved before the union existed) parse as CC. */
export function isCcBinding(b: { kind?: string }): b is MidiCcBinding {
  return b.kind === undefined || b.kind === 'cc';
}

/** Type guard: is this a NOTE binding? */
export function isNoteBinding(b: { kind?: string }): b is MidiNoteBinding {
  return b.kind === 'note';
}

/** A parsed NOTE message. `kind` is 'on' for a real note-on (velocity > 0) and
 *  'off' for a note-off (0x8n, OR a 0x9n with velocity 0 — the running-status
 *  note-off convention many controllers use). */
export interface ParsedNote {
  channel: number;
  note: number;
  velocity: number;
  kind: 'on' | 'off';
}

/**
 * Pure parse of a raw MIDI message into a NOTE event. Returns null when the
 * status byte isn't a note-on (0x90..0x9F) or note-off (0x80..0x8F).
 *
 *   0x9n vel>0  => on
 *   0x9n vel=0  => off (running-status note-off)
 *   0x8n        => off
 */
export function parseNoteMessage(data: Uint8Array | number[]): ParsedNote | null {
  if (data.length < 3) return null;
  const status = data[0]!;
  const hi = status & 0xf0;
  if (hi !== 0x90 && hi !== 0x80) return null;
  const channel = status & 0x0f;
  const note = data[1]! & 0x7f;
  const velocity = data[2]! & 0x7f;
  const kind: 'on' | 'off' = hi === 0x90 && velocity > 0 ? 'on' : 'off';
  return { channel, note, velocity, kind };
}

/** Does a parsed note match a learned NOTE binding (same channel + note)? */
export function noteMatches(binding: MidiNoteBinding, parsed: ParsedNote): boolean {
  return binding.channel === parsed.channel && binding.note === parsed.note;
}
