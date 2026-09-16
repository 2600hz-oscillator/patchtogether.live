// MPE VOICE STATE — one voice table with two front doors and stable lanes.
//
//   decodeMpe(state, bytes, t)   standard MIDI 1.0 MPE bytes (a stock
//                                LinnStrument, or any MPE controller): zones
//                                (RPN 0/6), bend range (RPN 0/0), member bend
//                                + master bend SUMMED, channel pressure, CC74,
//                                sustain (CC64), CC120/121/123, channel reuse.
//   applyTouch(state, event)     User-Mode surface touches from
//                                `linnstrument/surface-map`: the touch
//                                generation id IS the voice id.
//
// Both doors share the allocator: `createVoiceAllocator` keyed by the voice's
// generation id, never its pitch — two touches of the same pitch are two lanes
// (D13, V02), and `poly-alloc.ts:26-31` anticipates exactly this key. Lane
// exhaustion LRU-steals; the stolen voice's later release is a NO-OP on the
// lane it no longer owns (V10).
//
// Expression combination rules follow the JUCE MPEInstrument precedent the
// design cites (design.md:250): master + member BEND add; master pressure /
// timbre BROADCAST as absolute values to the zone's active voices and a later
// member message updates only that member. Pre-note expression is cached per
// channel and preserved onto the Note On (design.md:209); a released channel's
// cache is cleared so a reused channel never inherits the previous finger.
//
// Ordering caveat, stated rather than solved (design.md:211): MIDI 1.0 cannot
// disambiguate a reordered Note Off on a reused channel + same pitch. Per-port
// order is preserved by the caller; nothing here claims more.
//
// One `MpeState` per source (keys, pad, or a stock instrument). The state is a
// mutable object owned by the caller; every function returns the events it
// produced. ⚠ Plain `.ts`, no runes.

import { createVoiceAllocator, type VoiceAllocator } from '$lib/audio/poly-alloc';
import { midiToVOct } from '$lib/audio/note-entry';
import type { Epoch, SurfaceEvent } from './linnstrument/types';

/**
 * CC 74's REST BYTE, normalised — the timbre a finger reads before it has
 * moved vertically, and what a channel's cache resets to. The wire value is a
 * BYTE and its neutral is 64, so the normalised rest is 64/127 ≈ 0.5039, NOT
 * the midpoint 0.5 of the 0..1 normalisation. Every rest default here and
 * every bipolar re-centring downstream reads this one constant: a literal 0.5
 * put a resting finger 0.0079 off centre on the LinnStrument's bipolar timbre
 * jack, which the module docs promised was exactly 0 (2026-09-15 review).
 */
export const MPE_TIMBRE_REST = 64 / 127;

export interface MpeVoice {
  /** Generation id: the allocator key. */
  id: number;
  /** Stable poly lane for the voice's whole lifetime. */
  lane: number;
  /** Wire channel index 0..15 for the MIDI door; null for touches. */
  channel: number | null;
  /** Pitch at note-on; fixed for the voice's lifetime. */
  note: number;
  /** 0..1, latched at note-on. */
  velocity: number;
  /** Signed semitones (member + master for the MIDI door). */
  bend: number;
  /** 0..1 */
  pressure: number;
  /** 0..1 (CC74 / local Y) */
  timbre: number;
  /** Physically held (note-on without note-off). */
  held: boolean;
  releaseVelocity?: number;
}

export type MpeEndReason = 'release' | 'stolen' | 'reset' | 'all_notes_off' | 'all_sound_off' | 'session' | 'boundary' | 'channel_reuse';

export type MpeEvent =
  | { kind: 'voice_start'; voice: MpeVoice; time: number }
  | { kind: 'voice_expression'; voice: MpeVoice; time: number }
  | { kind: 'voice_end'; voice: MpeVoice; reason: MpeEndReason; time: number };

interface ChannelState {
  bendRaw: number; // 0..16383, 8192 centre
  bendRange: number; // semitones
  pressure: number; // 0..127
  timbre: number; // 0..127
  sustain: boolean;
  rpnMsb: number;
  rpnLsb: number;
  dataMsb: number;
}

export interface MpeZone {
  master: number;
  members: number[];
}

export interface MpeState {
  epoch: Epoch;
  nextId: number;
  voices: Map<number, MpeVoice>;
  byChannel: Map<number, number>;
  channels: ChannelState[];
  zones: MpeZone[];
  alloc: VoiceAllocator;
  counters: { steals: number; rejected: number };
  memberBendSemitones: number;
  masterBendSemitones: number;
}

export interface MpeOptions {
  lanes?: number;
  epoch?: Epoch;
  memberBendSemitones?: number;
  masterBendSemitones?: number;
  /** Initial zone; default is the LinnStrument's lower zone: master 1, members 2–16. */
  zone?: MpeZone | null;
}

const freshChannel = (range: number): ChannelState => ({
  bendRaw: 8192, bendRange: range, pressure: 0, timbre: 64, sustain: false, rpnMsb: 127, rpnLsb: 127, dataMsb: 0,
});
const bendUnit = (raw: number): number => (raw - 8192) / 8192;
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export const LOWER_ZONE_ALL: MpeZone = { master: 0, members: Array.from({ length: 15 }, (_, i) => i + 1) };

export function createMpeState(opts: MpeOptions = {}): MpeState {
  const member = opts.memberBendSemitones ?? 48;
  const master = opts.masterBendSemitones ?? 2;
  const zone = opts.zone === undefined ? LOWER_ZONE_ALL : opts.zone;
  const channels = Array.from({ length: 16 }, () => freshChannel(member));
  if (zone) channels[zone.master]!.bendRange = master;
  return {
    epoch: opts.epoch ?? 1,
    nextId: 1,
    voices: new Map(),
    byChannel: new Map(),
    channels,
    zones: zone ? [{ master: zone.master, members: [...zone.members] }] : [],
    alloc: createVoiceAllocator(opts.lanes ?? 16),
    counters: { steals: 0, rejected: 0 },
    memberBendSemitones: member,
    masterBendSemitones: master,
  };
}

export function activeVoices(state: MpeState): MpeVoice[] {
  return [...state.voices.values()].map((v) => ({ ...v }));
}

function zoneOf(state: MpeState, channel: number): MpeZone | undefined {
  return state.zones.find((z) => z.master === channel || z.members.includes(channel));
}

/** Channels a message on `channel` addresses: the zone's members for a master, itself otherwise. */
function affected(state: MpeState, channel: number): number[] {
  const z = zoneOf(state, channel);
  return z && z.master === channel ? z.members : [channel];
}

function computeBend(state: MpeState, channel: number): number {
  const c = state.channels[channel]!;
  const z = zoneOf(state, channel);
  const m = z ? state.channels[z.master]! : null;
  return bendUnit(c.bendRaw) * c.bendRange + (m ? bendUnit(m.bendRaw) * m.bendRange : 0);
}

function endVoice(state: MpeState, voice: MpeVoice, reason: MpeEndReason, time: number, releaseVelocity?: number): MpeEvent {
  state.voices.delete(voice.id);
  if (voice.channel !== null && state.byChannel.get(voice.channel) === voice.id) state.byChannel.delete(voice.channel);
  // Release-after-steal: noteOff returns null and touches no lane.
  state.alloc.noteOff(voice.id);
  const ended: MpeVoice = { ...voice, held: false, releaseVelocity: releaseVelocity ?? voice.releaseVelocity };
  if (voice.channel !== null) {
    const c = state.channels[voice.channel]!;
    c.bendRaw = 8192;
    c.pressure = 0;
    c.timbre = 64;
  }
  return { kind: 'voice_end', voice: ended, reason, time };
}

function startVoice(state: MpeState, id: number, channel: number | null, note: number, velocity: number, expr: { bend: number; pressure: number; timbre: number }, time: number, events: MpeEvent[]): MpeVoice {
  const before = state.alloc.activeCount();
  const lane = state.alloc.noteOn(id);
  if (before >= state.alloc.maxVoices) {
    // LRU-stolen: the previous owner of this lane loses it.
    state.counters.steals++;
    for (const v of state.voices.values()) {
      if (v.lane === lane) {
        events.push(endVoice(state, v, 'stolen', time));
        break;
      }
    }
  }
  const voice: MpeVoice = { id, lane, channel, note, velocity, bend: expr.bend, pressure: expr.pressure, timbre: expr.timbre, held: true };
  state.voices.set(id, voice);
  if (channel !== null) state.byChannel.set(channel, id);
  events.push({ kind: 'voice_start', voice: { ...voice }, time });
  return voice;
}

function refresh(state: MpeState, channel: number, time: number, events: MpeEvent[]): void {
  for (const ch of affected(state, channel)) {
    const id = state.byChannel.get(ch);
    const v = id === undefined ? undefined : state.voices.get(id);
    if (!v) continue;
    const c = state.channels[ch]!;
    v.bend = computeBend(state, ch);
    v.pressure = clamp01(c.pressure / 127);
    v.timbre = clamp01(c.timbre / 127);
    events.push({ kind: 'voice_expression', voice: { ...v }, time });
  }
}

function sustained(state: MpeState, channel: number): boolean {
  const z = zoneOf(state, channel);
  return state.channels[channel]!.sustain || (z !== undefined && state.channels[z.master]!.sustain);
}

/** End every voice and open a new epoch (reconnect / mode change / panic). */
export function resetMpe(state: MpeState, time: number, reason: MpeEndReason = 'session'): MpeEvent[] {
  const events: MpeEvent[] = [];
  for (const v of [...state.voices.values()]) events.push(endVoice(state, v, reason, time));
  for (const c of state.channels) {
    c.sustain = false;
    c.bendRaw = 8192;
    c.pressure = 0;
    c.timbre = 64;
  }
  state.alloc.reset();
  state.epoch += 1;
  return events;
}

/** Panic: every voice ends now; the epoch does not move. */
export function panicMpe(state: MpeState, time: number): MpeEvent[] {
  const events: MpeEvent[] = [];
  for (const v of [...state.voices.values()]) events.push(endVoice(state, v, 'all_sound_off', time));
  for (const c of state.channels) c.sustain = false;
  return events;
}

// ── Door 1: standard MPE bytes ────────────────────────────────────────────

function validate(bytes: ArrayLike<number>): { status: number; a: number; b: number } | null {
  if (bytes.length < 2 || bytes.length > 3) return null;
  const status = bytes[0]!;
  if (!Number.isInteger(status) || status < 0x80 || status >= 0xf0) return null;
  const kind = status & 0xf0;
  const expected = kind === 0xc0 || kind === 0xd0 ? 2 : 3;
  if (bytes.length !== expected) return null;
  for (let i = 1; i < expected; i++) {
    const d = bytes[i]!;
    if (!Number.isInteger(d) || d < 0 || d > 127) return null;
  }
  return { status, a: bytes[1]!, b: bytes[2] ?? 0 };
}

function configureZone(state: MpeState, master: number, count: number, time: number, events: MpeEvent[]): void {
  // Zone changes invalidate ownership: release first (design.md:248).
  for (const v of [...state.voices.values()]) if (v.channel !== null) events.push(endVoice(state, v, 'reset', time));
  const members = Array.from({ length: Math.min(15, count) }, (_, i) => (master === 0 ? i + 1 : 14 - i));
  state.zones = state.zones
    .filter((z) => z.master !== master)
    .map((z) => ({ ...z, members: z.members.filter((m) => m !== master && !members.includes(m)) }))
    .filter((z) => !members.includes(z.master) && z.members.length > 0);
  if (members.length) state.zones.push({ master, members });
  state.channels[master]!.bendRange = state.masterBendSemitones;
  for (const m of members) state.channels[m]!.bendRange = state.memberBendSemitones;
}

/**
 * Feed one standard MIDI message. Returns the voice events it produced.
 * Malformed bytes are counted and ignored.
 */
export function decodeMpe(state: MpeState, bytes: ArrayLike<number>, time: number): MpeEvent[] {
  const events: MpeEvent[] = [];
  const msg = validate(bytes);
  if (!msg || !Number.isFinite(time)) {
    state.counters.rejected++;
    return events;
  }
  const { status, a, b } = msg;
  const kind = status & 0xf0;
  const channel = status & 0x0f;
  const c = state.channels[channel]!;

  if (kind === 0xb0) {
    if (a === 101) c.rpnMsb = b;
    else if (a === 100) c.rpnLsb = b;
    else if (a === 99 || a === 98) {
      c.rpnMsb = 127;
      c.rpnLsb = 127;
    } else if (a === 6 || a === 38) {
      if (a === 6) c.dataMsb = b;
      if (c.rpnMsb === 0 && c.rpnLsb === 0) {
        // RPN 0/0 pitch bend sensitivity: semitones + cents/100.
        c.bendRange = a === 6 ? b : c.dataMsb + Math.min(99, b) / 100;
        refresh(state, channel, time, events);
      } else if (a === 6 && c.rpnMsb === 0 && c.rpnLsb === 6 && (channel === 0 || channel === 15)) {
        configureZone(state, channel, b, time, events);
      }
    } else if (a === 74) {
      c.timbre = b;
      for (const ch of affected(state, channel)) if (state.byChannel.has(ch)) state.channels[ch]!.timbre = b;
      refresh(state, channel, time, events);
    } else if (a === 64) {
      c.sustain = b >= 64;
      for (const ch of affected(state, channel)) {
        const id = state.byChannel.get(ch);
        const v = id === undefined ? undefined : state.voices.get(id);
        if (v && !v.held && !sustained(state, ch)) events.push(endVoice(state, v, 'release', time));
      }
    } else if (a === 120) {
      for (const ch of affected(state, channel)) {
        const id = state.byChannel.get(ch);
        const v = id === undefined ? undefined : state.voices.get(id);
        if (v) events.push(endVoice(state, v, 'all_sound_off', time));
      }
    } else if (a === 123) {
      for (const ch of affected(state, channel)) {
        const id = state.byChannel.get(ch);
        const v = id === undefined ? undefined : state.voices.get(id);
        if (!v) continue;
        v.held = false;
        if (!sustained(state, ch)) events.push(endVoice(state, v, 'all_notes_off', time));
      }
    } else if (a === 121) {
      c.bendRaw = 8192;
      c.pressure = 0;
      c.timbre = 64;
      c.sustain = false;
      for (const ch of affected(state, channel)) {
        const id = state.byChannel.get(ch);
        const v = id === undefined ? undefined : state.voices.get(id);
        if (v && !v.held && !sustained(state, ch)) events.push(endVoice(state, v, 'release', time));
      }
      refresh(state, channel, time, events);
    }
    return events;
  }

  const zone = zoneOf(state, channel);
  if (!zone) {
    state.counters.rejected++;
    return events;
  }
  if (kind === 0xe0) {
    c.bendRaw = a + b * 128;
    refresh(state, channel, time, events);
    return events;
  }
  if (kind === 0xd0) {
    c.pressure = a;
    for (const ch of affected(state, channel)) if (state.byChannel.has(ch)) state.channels[ch]!.pressure = a;
    refresh(state, channel, time, events);
    return events;
  }
  if (!zone.members.includes(channel)) {
    state.counters.rejected++;
    return events; // notes on a master channel are not MPE voices
  }
  if (kind === 0x90 && b > 0) {
    // Channel reuse retires the previous owner but keeps explicitly sent
    // pre-note expression for the new finger.
    const before = { bendRaw: c.bendRaw, pressure: c.pressure, timbre: c.timbre };
    const prevId = state.byChannel.get(channel);
    const prev = prevId === undefined ? undefined : state.voices.get(prevId);
    if (prev) events.push(endVoice(state, prev, 'channel_reuse', time));
    Object.assign(c, before);
    startVoice(state, state.nextId++, channel, a, b / 127, { bend: computeBend(state, channel), pressure: clamp01(c.pressure / 127), timbre: clamp01(c.timbre / 127) }, time, events);
    return events;
  }
  if (kind === 0x80 || (kind === 0x90 && b === 0)) {
    const id = state.byChannel.get(channel);
    const v = id === undefined ? undefined : state.voices.get(id);
    if (!v || v.note !== a) {
      state.counters.rejected++;
      return events;
    }
    v.held = false;
    v.releaseVelocity = b / 127;
    if (!sustained(state, channel)) events.push(endVoice(state, v, 'release', time, b / 127));
    return events;
  }
  state.counters.rejected++;
  return events;
}

// ── Door 2: User-Mode surface touches ─────────────────────────────────────

/**
 * Apply one surface event. Only `touch_*` events are voices; `pointer` and
 * `control_edge` belong to the selection reducer and map to nothing here.
 * Events from an older epoch are rejected (V14).
 */
export function applyTouch(state: MpeState, event: SurfaceEvent): MpeEvent[] {
  const events: MpeEvent[] = [];
  if (event.kind === 'pointer' || event.kind === 'control_edge') return events;
  if (event.epoch !== state.epoch) {
    state.counters.rejected++;
    return events;
  }
  const { time } = event;
  if (event.kind === 'touch_start') {
    if (state.voices.has(event.touch)) {
      state.counters.rejected++;
      return events;
    }
    startVoice(state, event.touch, null, event.note, clamp01(event.velocity / 127), { bend: 0, pressure: 0, timbre: MPE_TIMBRE_REST }, time, events);
    return events;
  }
  const v = state.voices.get(event.touch);
  if (!v) {
    state.counters.rejected++;
    return events; // stolen or unknown: release-after-steal NO-OP
  }
  if (event.kind === 'touch_expression') {
    if (event.bendSemitones !== undefined) v.bend = event.bendSemitones;
    if (event.pressure !== undefined) v.pressure = clamp01(event.pressure);
    if (event.timbre !== undefined) v.timbre = clamp01(event.timbre);
    events.push({ kind: 'voice_expression', voice: { ...v }, time });
    return events;
  }
  if (event.kind === 'touch_slide') {
    // Same voice, new column: identity survives a validated horizontal slide (D13).
    return events;
  }
  // touch_end
  events.push(endVoice(state, v, event.reason === 'boundary' ? 'boundary' : event.reason === 'session' ? 'session' : 'release', time, event.releaseVelocity));
  return events;
}

/** pitch CV for a voice: (n − 60 + bend) / 12 (design.md:246) — the tree's V/oct
 *  convention via `midiToVOct`, never a re-typed 60. */
export const voicePitchCv = (v: MpeVoice): number => midiToVOct(v.note + v.bend);
