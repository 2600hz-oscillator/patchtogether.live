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

/** A binding-or-raw-record the guards accept. The union member with all-optional
 *  fields lets a caller pass a legacy record (no `kind`) without TS's weak-type
 *  "no properties in common" rejection, while a concrete MidiBinding still
 *  narrows correctly. */
type BindingLike = MidiBinding | { kind?: 'cc' | 'note'; cc?: number; note?: number };

/** Type guard: is this a CC binding? Treats a missing `kind` as 'cc' so legacy
 *  records (saved before the union existed) parse as CC. */
export function isCcBinding(b: BindingLike): b is MidiCcBinding {
  return b.kind === undefined || b.kind === 'cc';
}

/** Type guard: is this a NOTE binding? */
export function isNoteBinding(b: BindingLike): b is MidiNoteBinding {
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

// ──────────────────────── address (channel+cc/note) identity ────────────────────────
//
// A binding's ADDRESS is the physical MIDI message it listens for: (channel, cc)
// for a CC binding or (channel, note) for a NOTE binding. The dispatch loop fires
// a binding when an inbound message matches its address — so TWO bindings sharing
// one address means a single physical knob/pad drives BOTH params (the Electra
// "controls collide across pages" bug). The invariant we enforce everywhere a
// binding is added (learn / import / bundle-load) is: AT MOST ONE binding per
// address — the most-recently-learned one wins (a physical control maps to ONE
// param at a time). These pure helpers are the single source of truth for that.

/** A minimal binding-record shape the address helpers accept (the persisted /
 *  exported record is structurally this — `kind` may be absent on legacy CC
 *  records, handled by `isCcBinding`). */
type AddressableBinding = {
  /** Present on real bindings ("moduleId:paramId"); ignored by the address
   *  helpers but declared so a full binding literal type-checks here. */
  key?: string;
  kind?: 'cc' | 'note';
  channel: number;
  cc?: number;
  note?: number;
  learnedAt?: number;
};

/** The address (physical MIDI message identity) a binding listens for:
 *  `cc:<channel>:<cc>` or `note:<channel>:<note>`. Two bindings with the SAME
 *  address would both fire on one inbound message — the collision we prevent. */
export function bindingAddress(b: AddressableBinding): string {
  return isNoteBinding(b as BindingLike)
    ? `note:${b.channel}:${b.note}`
    : `cc:${b.channel}:${b.cc}`;
}

/**
 * Drop colliding bindings so AT MOST ONE remains per address — the newest
 * (highest `learnedAt`) wins; on a tie the LATER element in the input wins
 * (stable: a fresh import batch / re-learn supersedes the stale entry). Order of
 * the survivors is preserved from the input. Pure — used by the MIDI-learn
 * singleton (learn/import/load) and the performance-bundle merge so every path
 * that adds a binding upholds the one-owner-per-address invariant.
 */
export function dedupeBindingsByAddress<T extends AddressableBinding>(bindings: T[]): T[] {
  // First pass: pick the winning record per address (newest learnedAt, ties → later).
  const winnerByAddr = new Map<string, T>();
  for (const b of bindings) {
    const addr = bindingAddress(b);
    const prev = winnerByAddr.get(addr);
    if (!prev || (b.learnedAt ?? 0) >= (prev.learnedAt ?? 0)) winnerByAddr.set(addr, b);
  }
  // Second pass: emit each address's winner exactly once, preserving the input
  // order of the winners (so the result is deterministic, not Map-iteration order).
  const emitted = new Set<string>();
  const out: T[] = [];
  for (const b of bindings) {
    const addr = bindingAddress(b);
    if (winnerByAddr.get(addr) === b && !emitted.has(addr)) {
      emitted.add(addr);
      out.push(b);
    }
  }
  return out;
}
