// packages/web/src/lib/audio/modules/midi-cv-buddy.ts
//
// MIDI-CV-BUDDY — bridges a hardware MIDI controller into the patch as
// pitch + gate + velocity CV. Monophonic; user-selectable voice priority
// (LAST / LOW / HIGH); user-selectable retrigger behavior; pitch-bend
// summed into the pitch output.
//
// Outputs:
//   pitch_cv     — V/oct (codebase convention: 0V = C4 = MIDI 60). Includes
//                  pitch-bend summed in (default ±2 semitones).
//   gate         — 0 / 1. HIGH while at least one key is held; on retrigger
//                  events it briefly dips to 0 for one audio block before
//                  re-rising (so an ADSR or sequencer-clocked thing
//                  re-fires).
//   velocity_cv  — 0..1 (MIDI 0..127 / 127). Updated on each note-on.
//                  Latched between events.
//
// Inputs: none. MIDI source is the hardware controller, picked from a
// dropdown on the card.
//
// Implementation:
//   * No worklet — MIDI handling is main-thread. Each MIDI event lands in
//     a single handler that updates a "held keys" stack and writes new
//     values to three ConstantSourceNodes via setValueAtTime, scheduled at
//     `audioCtx.currentTime + (event.timeStamp - performance.now())/1000 +
//     LOOKAHEAD_S`. The lookahead (2 ms) covers the worst case of the
//     audio thread being mid-block when we schedule, so the value lands
//     at the START of the next block rather than getting clamped to "now"
//     and arriving in the middle of one (which causes a click).
//
//   * Web MIDI permission is NOT requested at module instantiation. The
//     factory creates the ConstantSources and reads the saved data
//     (channel filter, voice priority, retrig, last device id) and waits
//     for the UI card to call `connect()` after the user clicks
//     "Connect MIDI…". This avoids spamming the permission dialog every
//     time the patch loads.
//
//   * Hot-plug: `MIDIAccess.onstatechange` is wired on `connect()`. The
//     card subscribes via `read('devices')` to re-render its dropdown
//     when the device list changes.
//
// Latency budget (honest):
//   Web MIDI event → handler → setValueAtTime → audio thread = ~5-10 ms
//   end-to-end on a typical Chrome/macOS setup. We don't beat the
//   browser's main-thread + audio-thread hop; we just don't add to it.
//
// License: vanilla Web MIDI API; no third-party library bundled (decision
// recorded in PR body — webmidi.js / jzz both add ~10-17 KB gz for
// ergonomics we don't need with one event handler).
//
// (Inputs / Outputs / Params block — IO surface restated for the docs manifest)
//
// Inputs: none.
//
// Outputs:
//   pitch_cv (cv): V/oct (0V = C4 = MIDI 60). Includes pitch-bend.
//   gate (gate): HIGH while any key is held; brief retrigger dip when retrigger fires.
//   velocity_cv (cv): 0..1 (MIDI velocity / 127). Latched between events.
//
// Params: none on the engine side. (Device + channel filter + voice priority +
//   retrigger behavior live in node.data; the card writes them.)

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ModuleFace } from '$lib/graph/types';
import { midiToVOct } from '$lib/audio/note-entry';
import { createMidiScheduler } from '$lib/audio/midi-timing';
import { createMidiInputClaim } from '$lib/midi/input-attach';
import { bindMidiPort, type ConnectedDevice } from '$lib/graph/device-rebind';

// ---------------- Web MIDI minimal types ----------------
//
// TypeScript's lib.dom.d.ts ships these (WebMidi-DOM types) but they
// can be undefined in older toolchains; redeclare the slim shapes we
// actually use so the module compiles regardless.

export interface MidiEventLike {
  /** MIDI status + data bytes. data[0] = status (with channel low-nibble);
   *  data[1] = note or controller; data[2] = velocity or value. */
  data: Uint8Array;
  /** performance.now()-relative ms when the event was received. */
  timeStamp: number;
}

export interface MidiInputLike {
  id: string;
  name?: string | null;
  manufacturer?: string | null;
  state: string;
  /** Set the event callback. Setting to null detaches. */
  onmidimessage: ((ev: MidiEventLike) => void) | null;
}

export interface MidiAccessLike {
  inputs: Map<string, MidiInputLike>;
  onstatechange: ((ev: { port: MidiInputLike }) => void) | null;
}

// ---------------- Pure helpers (testable) ----------------

/** Voice-priority mode. Determines which held note "wins" when multiple
 *  keys are down. LAST = the most recently pressed (the conventional
 *  default for software synths); LOW = the lowest-numbered note (classic
 *  bass-synth behavior); HIGH = the highest. */
export type VoicePriority = 'last' | 'low' | 'high';

/** Pick the winning MIDI note from a held-keys stack under the given
 *  priority. Returns `null` if the stack is empty.
 *
 *  For LAST the stack is treated as press-order; the LAST entry is the
 *  most recently pressed.
 */
export function pickWinner(
  heldKeysInPressOrder: readonly number[],
  priority: VoicePriority,
): number | null {
  if (heldKeysInPressOrder.length === 0) return null;
  if (priority === 'last') {
    return heldKeysInPressOrder[heldKeysInPressOrder.length - 1]!;
  }
  if (priority === 'low') {
    let lo = heldKeysInPressOrder[0]!;
    for (const k of heldKeysInPressOrder) if (k < lo) lo = k;
    return lo;
  }
  // high
  let hi = heldKeysInPressOrder[0]!;
  for (const k of heldKeysInPressOrder) if (k > hi) hi = k;
  return hi;
}

/** Convert a 0..127 MIDI velocity to a 0..1 CV value. Velocity 0 is by
 *  convention a note-off; we still map it to 0 here so a downstream VCA
 *  cleanly mutes if it gets through. */
export function velocityToCv(velocity: number): number {
  if (!Number.isFinite(velocity)) return 0;
  const v = Math.max(0, Math.min(127, Math.round(velocity)));
  return v / 127;
}

/** Map a MIDI 14-bit pitch-bend value (0..16383, center 8192) to
 *  V/oct, given a bend range in semitones (default ±2). */
export function bendToVOct(bend14: number, semitonesEachSide = 2): number {
  if (!Number.isFinite(bend14)) return 0;
  const b = Math.max(0, Math.min(16383, Math.round(bend14)));
  const centered = (b - 8192) / 8192; // -1..+1 (approx — +1 reached at 16384, capped at 16383)
  return (centered * semitonesEachSide) / 12;
}

/** True if a raw MIDI status byte represents a channel-voice event we
 *  care about (note on/off, pitch bend) for the given channel filter.
 *  `channelFilter === null` means "all channels". */
export function channelMatches(statusByte: number, channelFilter: number | null): boolean {
  if (channelFilter === null) return true;
  return (statusByte & 0x0f) === channelFilter;
}

// ---------------- The CHANNEL and PRIORITY rosters ----------------
//
// Both the legacy card's `<select>` and the faceplate's selector cell offer the
// SAME choices, built here once so neither surface re-derives them. The card
// used to spell `{#each Array(16)}` and the `i + 1` inline, and a face that
// spelled them again would be two encodings of one convention — the same
// ONE-PLACE rule the range gates apply to numbers.

/** The MIDI specification's channel count. A PROTOCOL constant, not a
 *  population: it is 16 because the status byte carries a 4-bit channel nibble,
 *  and no amount of code in this repo can change it.
 *
 *  ⚠ CANONICAL HERE rather than in `midi-lane.ts`, which re-exports it. The
 *  dependency runs midi-lane → midi-cv-buddy already (`VoicePriority`), so this
 *  is the only direction that shares one declaration without a cycle. */
export const MIDI_CHANNEL_COUNT = 16;

/** The picker value meaning "listen to every channel" — `null` in the stored
 *  form, and this string in any picker, since a `<select>` value and a
 *  `SelectorOption` value are both strings. */
export const MIDI_CV_BUDDY_CHANNEL_ALL = 'all';

/** ALL + one entry per MIDI channel, `value` 0-based (the wire form) and
 *  `label` 1-based (the form printed on the front of every piece of gear). */
export function midiCvBuddyChannelChoices(): Array<{ value: string; label: string }> {
  return [
    { value: MIDI_CV_BUDDY_CHANNEL_ALL, label: 'ALL' },
    ...Array.from({ length: MIDI_CHANNEL_COUNT }, (_, i) => ({
      value: String(i),
      label: String(i + 1),
    })),
  ];
}

/** The stored filter for a picker value. `null` is ALL, and so is anything
 *  outside the wire range — an unparseable choice must widen rather than mute. */
export function channelForChoice(choice: string): number | null {
  if (choice === MIDI_CV_BUDDY_CHANNEL_ALL) return null;
  const n = Number.parseInt(choice, 10);
  if (!Number.isInteger(n) || n < 0 || n >= MIDI_CHANNEL_COUNT) return null;
  return n;
}

/** The picker value for a stored filter. */
export function choiceForChannel(channel: number | null | undefined): string {
  if (typeof channel !== 'number' || !Number.isInteger(channel)) {
    return MIDI_CV_BUDDY_CHANNEL_ALL;
  }
  if (channel < 0 || channel >= MIDI_CHANNEL_COUNT) return MIDI_CV_BUDDY_CHANNEL_ALL;
  return String(channel);
}

/** The three priorities `pickWinner` implements, as a roster. Typed
 *  `VoicePriority` so adding a name the union does not have is a COMPILE error
 *  rather than a dead option the engine has no branch for. */
export const MIDI_CV_BUDDY_PRIORITIES: ReadonlyArray<{ value: VoicePriority; label: string }> = [
  { value: 'last', label: 'LAST' },
  { value: 'low', label: 'LOW' },
  { value: 'high', label: 'HIGH' },
];

/** The priority roster in the shape a `<select>` and a `SelectorOption` share. */
export function midiCvBuddyPriorityOptions(): Array<{ value: string; label: string }> {
  return MIDI_CV_BUDDY_PRIORITIES.map((p) => ({ value: p.value, label: p.label }));
}

/** Narrow an arbitrary picker value back onto the union. */
export function priorityForChoice(choice: string): VoicePriority {
  return MIDI_CV_BUDDY_PRIORITIES.find((p) => p.value === choice)?.value ?? 'last';
}

/**
 * The MIDI channel FILTER stored on a node, or `null` for ALL.
 *
 * ⚠ THE KEY IS `midiInChannel`, NOT `channel`, AND THE RENAME IS A BUG FIX
 * (#1168's other half, found on this module's promotion 2026-08-25).
 *
 * `channel-columns.ts` declares `data.channel: 1..8` to be COLUMN MEMBERSHIP
 * TRUTH — the workflow reconciler DROPS a node from a lane whose order array
 * lists it while `data.channel !== ch`, and ADOPTS any node whose
 * `data.channel === ch`. `MidiOutBuddyCard.svelte` has carried a header about
 * this since #1168 (*"this card must NEVER write it, or the column reconciler
 * moves the module to another lane and drops its clip assignment"*) and gained
 * its own `midiOutChannel` key for exactly that reason. **The sibling was never
 * checked, and it collided on the same key in BOTH directions:**
 *
 *   * WRITE — picking a MIDI channel wrote `data.channel = 0..15`. Lane columns
 *     are 1..8, so channel 1 (stored 0), or anything above 8, ejected the module
 *     from its lane entirely, and channels 2..9 TELEPORTED it into another
 *     lane's stack. One dropdown change, silently, with no undo entry.
 *   * READ — the factory read `savedData.channel` as the filter, and lane
 *     membership is POSITIONAL (drop position decides, not port shape), so
 *     dropping a fresh MIDI-CV-BUDDY into channel column 5 made the workflow
 *     write `channel: 5` and the module then listened to MIDI channel 6 ONLY.
 *     That one needs no user action at all: the module simply goes deaf on
 *     fifteen of sixteen channels for no visible reason.
 *
 * ⚠ AND THE LEGACY KEY IS NOT READ AS A FALLBACK, WHICH IS A DECISION RATHER
 * THAN AN OMISSION. A stored `3` is the same bytes whether the card wrote a
 * filter or the reconciler wrote a lane, so there is no discriminator to write.
 * Reading it would mean choosing to be wrong on the case that happens with NO
 * user action (the deafness above) in order to be right on the case that
 * requires one — and the case that requires one ALSO ejected the module from
 * its lane, so it was never a working configuration either. A rack saved with a
 * filter therefore re-opens on ALL, which is the recoverable direction: too many
 * notes is audible and one click from correct, where selective deafness is
 * neither.
 */
export function midiInChannelOf(data: Partial<MidiCvBuddyData> | undefined | null): number | null {
  const raw = data?.midiInChannel;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  if (raw < 0 || raw >= MIDI_CHANNEL_COUNT) return null;
  return raw;
}

/** Apply one MIDI event to a held-keys stack. Returns the new stack +
 *  whether this event represented a note-on (vs note-off / other).
 *  Used by the unit tests to validate the voice-priority + retrigger
 *  logic independent of Web MIDI. */
export interface NoteEvent {
  kind: 'note-on' | 'note-off' | 'other';
  /** The MIDI note number if kind !== 'other'. */
  note?: number;
  /** Velocity for note-on (0..127). */
  velocity?: number;
}

/** Parse a raw MIDI data triple into a NoteEvent or null when the event
 *  isn't a note message. Treats note-on with velocity 0 as note-off
 *  (running-status convention). */
export function parseNoteEvent(data: Uint8Array): NoteEvent | null {
  if (data.length < 1) return null;
  const status = data[0]! & 0xf0;
  if (status === 0x90) {
    // Note on (or note off via velocity 0).
    const note = data[1] ?? 0;
    const velocity = data[2] ?? 0;
    if (velocity === 0) return { kind: 'note-off', note };
    return { kind: 'note-on', note, velocity };
  }
  if (status === 0x80) {
    const note = data[1] ?? 0;
    return { kind: 'note-off', note };
  }
  return null;
}

/** Parse a pitch-bend event. Returns the 14-bit value or null. */
export function parsePitchBend(data: Uint8Array): number | null {
  if (data.length < 3) return null;
  if ((data[0]! & 0xf0) !== 0xe0) return null;
  const lsb = data[1]! & 0x7f;
  const msb = data[2]! & 0x7f;
  return (msb << 7) | lsb;
}

/** Push a note onto a held-keys stack, removing any prior occurrence so
 *  re-pressing a held note re-anchors its position at the top (matches
 *  hardware behavior). */
export function pushHeld(stack: readonly number[], note: number): number[] {
  const filtered = stack.filter((n) => n !== note);
  filtered.push(note);
  return filtered;
}

/** Remove a note from the held-keys stack (no-op if not present). */
export function removeHeld(stack: readonly number[], note: number): number[] {
  return stack.filter((n) => n !== note);
}

// ---------------- Module def ----------------

/** Lookahead added to event.timeStamp when scheduling AudioParam updates
 *  (shared by MIDI-CV-BUDDY + MIDI LANE; MIDICLOCK has its own larger
 *  TIMESTAMP_LOOKAHEAD_S).
 *
 *  One render quantum is ~128 samples @ 48 kHz = 2.67 ms. The old 2 ms
 *  value was UNDER one quantum, so the moment the main-thread MIDI handler
 *  jittered even slightly the schedAt() clamp (Math.max(now + lookahead,…))
 *  landed the gate/pitch step INSIDE the current block — exactly the
 *  mid-block discontinuity (a click) we're trying to avoid. Under UI load
 *  (the ES-9 duplex "clicks worse when interacting" report) that jitter is
 *  routine.
 *
 *  Raise to 8 ms (~3 render quanta) so a jittery callback still lands at a
 *  block boundary in the FUTURE. The added latency (~6 ms over the old
 *  value) is inaudible for a clocked rig and well under the perceptual
 *  ~10 ms note-onset threshold. Kept < 10 ms so live MIDI still feels
 *  immediate. */
export const SCHED_LOOKAHEAD_S = 0.008;

/** One Web Audio render quantum in seconds at 48 kHz (128 frames).
 *  SCHED_LOOKAHEAD_S must be ≥ this so a clamped schedule still lands at
 *  the START of a future block, not mid-block. Exported for the lookahead
 *  regression test. */
export const RENDER_QUANTUM_S = 128 / 48000;

/** Default pitch-bend range in semitones each side (MIDI standard).
 *  Most controllers default to ±2 unless a Patch SysEx tells them otherwise.
 *  Exposed for future RPN parsing; v1 is fixed at 2. */
export const DEFAULT_BEND_SEMITONES = 2;

/** Card-readable shape exposed via `handle.read('state')` so the Svelte
 *  card can paint live MIDI status (last note, connection state). */
export interface MidiCvBuddyCardState {
  connected: boolean;
  permissionDenied: boolean;
  /** Devices known to the MIDIAccess. Card uses this to populate the
   *  device-picker dropdown. */
  devices: Array<{ id: string; name: string; state: string }>;
  /** Currently selected device id, or null when none. */
  selectedDeviceId: string | null;
  /** Last note received (MIDI int) for the on-card "ACTIVE NOTE" readout. */
  lastNote: number | null;
  lastVelocity: number;
  /** How many keys are held RIGHT NOW.
   *
   *  ⚠ ADDED FOR THE FACEPLATE'S NOTE LAMP, and it is not redundant with
   *  `lastNote`. `lastNote` is LATCHED — it keeps the last value after every key
   *  is released, deliberately, so a downstream VCO holds its pitch through the
   *  gate's fall — so a lamp bound to it would light on the first note and
   *  never go dark again. midiLane added the same field for the same reason.
   *  This is the only thing on the promoted surface that says the module is
   *  RECEIVING, which matters because the two failure modes (nothing patched to
   *  the keyboard, and a channel filter aimed at the wrong channel) are both
   *  perfectly silent and look identical to a correct module between notes. */
  heldCount: number;
}

/** Saved per-instance data on the patch node. Lives under
 *  `node.data` (the engine reads `node.params` for AudioParams; this
 *  shape is for non-numeric state). */
export interface MidiCvBuddyData {
  /** Channel filter: 0..15 or null for "all".
   *
   *  ⚠ NOT `channel` — see `midiInChannelOf` above for why that key belongs to
   *  the workflow channel-column reconciler and cannot be shared. */
  midiInChannel: number | null;
  priority: VoicePriority;
  /** When true, momentary key changes drop the gate to 0 for one block
   *  before re-rising. When false, the gate stays high through legato
   *  changes (only falls when all keys release). */
  retrig: boolean;
  /** Last-used device id; restored on reconnect so the user doesn't have
   *  to pick again if the controller is plugged back in. */
  lastDeviceId: string | null;
  /**
   * The NAME of that device, remembered so a load can still find the hardware
   * when the id no longer names anything.
   *
   * ⚠ `lastDeviceId` is the `MIDIInput`/`MIDIOutput.id`, which the Web MIDI spec
   * leaves implementation-defined — `performance-bundle.ts` calls it "unstable"
   * in as many words. It is the fast, exact path on the same machine and the
   * session it was saved in; the name is what survives everything else. Absent
   * on patches written before this existed, which resolve by id alone exactly as
   * they did.
   */
  lastDeviceName?: string;
}

export const DEFAULT_DATA: MidiCvBuddyData = {
  midiInChannel: null,
  priority: 'last',
  retrig: true,
  lastDeviceId: null,
};

/**
 * Per-instance handle returned by the factory. Extends AudioDomainNodeHandle
 * with the MIDI-specific controls the Svelte card calls into via
 * `engine.read(node, 'card-api')`.
 */
export interface MidiCvBuddyApi {
  /** Trigger `navigator.requestMIDIAccess()` and wire `onmidimessage`.
   *  Idempotent — calling again after a successful connect is a no-op.
   *  Returns true on success, false if the permission was denied or the
   *  browser lacks Web MIDI. */
  connect(): Promise<boolean>;
  selectDevice(deviceId: string | null): void;
  setChannel(channel: number | null): void;
  setPriority(priority: VoicePriority): void;
  setRetrig(retrig: boolean): void;
  /** Snapshot of card-visible state. */
  getState(): MidiCvBuddyCardState;
  /** Subscribe to state changes. Returns an unsubscribe fn. */
  subscribe(cb: (s: MidiCvBuddyCardState) => void): () => void;
}

// True when running in a browser with Web MIDI available.
export function webMidiAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess === 'function'
  );
}

// ---------------- The FACEPLATE ----------------
//
// WHAT THIS MODULE IS FOR, MUSICALLY. It is the mono workhorse that lets you
// PLAY the rack from a keyboard: one winning note out of whatever you are
// holding, as pitch + gate + velocity CV. MIDI LANE is its channel-aware
// successor and CUBE/DX7 take chords; this one is the thing you reach for when
// you want a keyboard to drive one VCO and one envelope, which is most of the
// time. The verb is "press a key and hear it".
//
// ⚠ IT IS A ZERO-PARAM FACE. `params: []` — every setting lives on `node.data`,
// so all four controls arrive as `controlFamilies` + `SHELL_CELLS` entries.
// `order: []` would have been legal and would have painted a blank tile, which
// is worse than the placeholder it replaces (the matrixMix lesson).
//
// THE TIER LADDER, read back as a sentence: the mini tile shows CONNECT,
// because nothing else on this module means anything until Web MIDI is granted;
// the compact tile adds CHANNEL, because a keyboard on the wrong channel is
// SILENT rather than wrong and that is the second thing to get right; the plate
// adds PRIORITY and RETRIGGER, which shape how a held chord collapses onto one
// voice and are the only two settings you can usefully audition by ear.
//
// `order` and `pages` AGREE here, unusually. Priority is not a fifth-most-
// important control that happens to belong with retrigger — the two really are
// the second IDEA, and the first two really are the first, so the ranking and
// the signal order are the same list. Said out loud because a face whose two
// lists agree is normally a face that only wrote one of them.
export const MIDI_CV_BUDDY_FACE: ModuleFace = {
  // ⚠ MECHANICALLY FORCED, not a style choice — the midiLane argument, and the
  // same three output types. `glyphBinding` reaches a live trace through
  // `primaryAudioOutPortId`, which matches `type === 'audio'` EXACTLY. This
  // module's outputs are cv / gate / cv, so any other glyph value falls through
  // to `{kind:'static'}`, the dead binding module-face-lint reddens.
  glyph: 'none',
  // The DEVICE ROSTER is the one affordance here that cannot be a cell: it
  // lives on the engine handle behind `requestMIDIAccess()` and differs on
  // every machine, so it is neither a `ParamDef` nor an `options` roster (a
  // roster is a fixed set known when the def is authored). See the extension.
  extension: 'midiCvBuddy',
  order: [
    'midi-cv-buddy-connect-{n}',
    'midi-cv-buddy-channel-{n}',
    'midi-cv-buddy-priority-{n}',
    'midi-cv-buddy-retrig-{n}',
  ],
  pages: [
    {
      id: 'input',
      label: 'input',
      hint:
        'Web MIDI needs the browser\'s consent before any device is even visible, and until it '
        + 'is granted this module has no stream to listen to and all three jacks sit at rest. '
        + 'Then point it at one channel: a keyboard on the wrong channel is SILENT rather than '
        + 'wrong, which is the hardest kind of fault to spot. ALL listens to every channel.',
      controls: ['midi-cv-buddy-connect-{n}', 'midi-cv-buddy-channel-{n}'],
    },
    {
      // ⚠ `mono`, NOT `voice` — the dx7 double-band scar. `rearFieldPlan`
      // derives a LEADING `voice`/`signal` section for a module whose ports
      // carry gate/pitch drive, and this module's three outputs do; a page with
      // that id renders a SECOND band carrying the same name. midiLane calls
      // the same idea `mono`, which is also the more honest word here: it is
      // the module's defining limitation, not a synth voice.
      id: 'mono',
      label: 'mono',
      hint:
        'How a held chord collapses onto the single PITCH and GATE jacks, because this module is '
        + 'monophonic on purpose. LAST follows the newest key (what a keyboard player expects), '
        + 'LOW pins the bass note and HIGH the melody note. RETRIG dips the gate for one block on '
        + 'each new note so a downstream envelope re-fires instead of sustaining through the '
        + 'change; turn it off for legato.',
      controls: ['midi-cv-buddy-priority-{n}', 'midi-cv-buddy-retrig-{n}'],
    },
  ],
};

export const midiCvBuddyDef: AudioModuleDef = {
  type: 'midiCvBuddy',
  palette: { top: 'MIDI', sub: 'MIDI' },
  domain: 'audio',
  label: 'midi-cv-buddy',
  category: 'sources',

  // No audio inputs — MIDI source is external (the device).
  inputs: [],
  outputs: [
    { id: 'pitch_cv',    type: 'cv' },
    { id: 'gate',        type: 'gate', edge: 'gate' },
    { id: 'velocity_cv', type: 'cv' },
  ],
  // No knob params — all settings are dropdown/toggle on the card and live
  // in node.data. (Channel selector + voice priority + retrig are discrete,
  // not continuous, so they don't fit the AudioParam shape.)
  params: [],

  face: MIDI_CV_BUDDY_FACE,

  // ⚠ FOUR FAMILIES FOR FOUR CELLS, AND THE COUNT IS FORCED BY THE RESOLVER.
  // `resolveFaceControl` resolves a face key to a PARAM id, a family TEMPLATE
  // (`<id>-{n}`) or a legend STATIC — and this module declares `params: []`, so
  // every one of its controls has to arrive as a family. Each really is a named
  // affordance the module owns, and each has a real control on the legacy card
  // carrying the same `testidPrefix`, which is what `module-docs-lint`'s
  // card-drift leg checks.
  controlFamilies: [
    { id: 'midi-cv-buddy-connect',  label: 'Connect MIDI', kind: 'other', testidPrefix: 'midi-cv-buddy-connect' },
    { id: 'midi-cv-buddy-channel',  label: 'Channel',      kind: 'other', testidPrefix: 'midi-cv-buddy-channel' },
    { id: 'midi-cv-buddy-priority', label: 'Priority',     kind: 'other', testidPrefix: 'midi-cv-buddy-priority' },
    { id: 'midi-cv-buddy-retrig',   label: 'Retrigger',    kind: 'other', testidPrefix: 'midi-cv-buddy-retrig' },
  ],

  docs: {
    explanation:
      "Turns a hardware MIDI keyboard or controller into the pitch + gate + velocity CV the rest of the rack speaks — the classic MIDI-to-CV interface. It is MONOPHONIC: when you hold a chord it picks one winning note (by the card's voice-priority setting — last-played, lowest, or highest) and tracks that. Mental model: play a key and PITCH follows it as 1V/octave, GATE goes high while you hold and dips briefly on a retrigger so envelopes re-fire, and VELOCITY latches how hard you struck. Pitch-bend is summed into the pitch output. The card owns the device dropdown, channel filter, voice-priority and retrigger choices (all discrete, saved in the patch — no audio-side knobs); Web MIDI permission is requested only when you click Connect, not on patch load. For polyphony, use MIDI LANE's poly output instead; this module is the simple mono workhorse.",
    inputs: {},
    outputs: {
      pitch_cv:
        "The current note as pitch CV in volts-per-octave (the codebase convention 0V = C4 = MIDI note 60), with pitch-bend summed in (default ±2 semitones). It tracks the winning held key per the card's voice-priority mode and latches the last note after you let go, so a downstream VCO holds its pitch through the gate's fall rather than snapping to a default.",
      gate:
        "Stays high while at least one key is held and low when all keys are released. On a retrigger (a fresh strike while the retrigger mode wants a re-fire) it briefly dips to 0 for one audio block before re-rising, so an ADSR or VCA downstream re-fires its envelope cleanly. Patch it into an envelope's gate or a VCA.",
      velocity_cv:
        "How hard the most recent note was struck, as 0..1 CV (MIDI velocity 0..127 scaled by 1/127). It updates on each note-on and latches between events, so you can route it to a VCA level or a filter cutoff for velocity-sensitive dynamics.",
    },
    controls: {
      'midi-cv-buddy-connect-{n}':
        "The one-time-per-origin permission gesture. Web MIDI needs the browser's consent before any device is even visible, and until it is granted this module has no stream to listen to and all three jacks sit at rest — so this is the first thing to press, not an optional extra. It reaches the same request every MIDI module in the rack shares, which always yields a nameable outcome: granted, refused, unsupported, or the quiet case where the browser suppressed its own prompt without telling anyone. Once access is granted the dock's device body lists the inputs it found and remembers the one you pick, so a reloaded patch re-attaches without another click.",
      'midi-cv-buddy-channel-{n}':
        "Which MIDI channel this module listens to — ALL, or one of the sixteen. The channels are shown 1..16 the way every keyboard and sequencer prints them on its own front panel, while the wire format underneath is 0..15. Pick a channel when more than one instrument is sending on the same cable and you want this one to hear only its own track; leave it on ALL for a single keyboard, where a filter can only ever make the module silent. Changing it clears any held keys first, because a note-off arriving on the OLD channel would otherwise be dropped and strand the gate high forever.",
      'midi-cv-buddy-priority-{n}':
        "Which held key wins when you are holding more than one, because this module drives a single PITCH and GATE pair and has to choose. LAST follows the most recently pressed note, which is what a keyboard player expects and what almost every software synth does. LOW pins the lowest note, the classic mono-bass behaviour — hold a root and play a melody above it and the bass never moves. HIGH pins the highest, which does the same for a lead line under a held pedal tone. Changing it re-picks the winner immediately but does NOT re-fire the gate, so a settings change never sounds like a new note.",
      'midi-cv-buddy-retrig-{n}':
        "Whether a fresh key press re-fires downstream envelopes while you are already holding a note. ON drops the gate to 0 for exactly one audio block before re-raising it, which an ADSR or a VCA reads as a new note and re-attacks; that is the percussive, every-note-articulated feel. OFF leaves the gate high through the change, so the pitch moves and the envelope keeps whatever it was doing — legato, and the only way to get a real slide out of a mono line. It applies from the next note-on; the currently sounding note is untouched.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // ---------------- ConstantSource outputs ----------------
    //
    // Three CV sources, all starting at neutral values:
    //   * pitch_cv: starts at 0 V (= C4). Until a key is pressed, this is
    //     what downstream VCOs will see. Anyone treating it as the "current
    //     pitch" without checking gate gets C4 — that's a reasonable
    //     default (better than the random previous-instance value).
    //   * gate:        0 (no keys held).
    //   * velocity_cv: 0 (no velocity received).
    const pitchSrc = ctx.createConstantSource();
    pitchSrc.offset.value = 0;
    pitchSrc.start();
    const gateSrc = ctx.createConstantSource();
    gateSrc.offset.value = 0;
    gateSrc.start();
    const velSrc = ctx.createConstantSource();
    velSrc.offset.value = 0;
    velSrc.start();

    // ---------------- Saved data (with defaults) ----------------
    const savedData = ((node.data ?? {}) as Partial<MidiCvBuddyData>);
    // ⚠ `midiInChannelOf`, never `savedData.channel` — that key is the workflow
    // channel-column reconciler's membership truth and reading it made a
    // lane-dropped module listen to one channel it never chose. See the
    // function's own header for the measurement and for why there is no legacy
    // fallback to write.
    let channel: number | null = midiInChannelOf(savedData);
    let priority: VoicePriority = savedData.priority ?? DEFAULT_DATA.priority;
    let retrig: boolean = savedData.retrig ?? DEFAULT_DATA.retrig;
    let selectedDeviceId: string | null = savedData.lastDeviceId ?? DEFAULT_DATA.lastDeviceId;

    // ---------------- Internal mutable state ----------------
    let heldStack: number[] = [];
    let currentBendVOct = 0;
    let lastNote: number | null = null;
    let lastVelocity = 0;
    let access: MidiAccessLike | null = null;
    /** Identity-scoped handler-slot claim — see $lib/midi/input-attach. */
    const claim = createMidiInputClaim('midi-cv-buddy');
    let permissionDenied = false;
    let subscriber: ((s: MidiCvBuddyCardState) => void) | null = null;

    function snapshotState(): MidiCvBuddyCardState {
      const devices: MidiCvBuddyCardState['devices'] = [];
      if (access) {
        for (const [id, inp] of access.inputs) {
          devices.push({ id, name: inp.name ?? id, state: inp.state });
        }
      }
      return {
        connected: access !== null,
        permissionDenied,
        devices,
        selectedDeviceId,
        lastNote,
        lastVelocity,
        heldCount: heldStack.length,
      };
    }

    function notify(): void {
      subscriber?.(snapshotState());
    }

    // Project each event's own `event.timeStamp` onto the audio clock so two
    // notes keep their real inter-note spacing regardless of how late their
    // main-thread handlers run. The OLD `Math.max(now + L, now + delta + L)`
    // floor collapsed every note to `currentTime + L` (a Web-MIDI handler
    // always runs after the event, so delta <= 0), making note spacing equal
    // main-thread dispatch jitter — audible swing under load. The shared
    // scheduler owns the perf↔ctx offset + refresh (one impl for all three
    // MIDI bridges; see $lib/audio/midi-timing).
    const scheduler = createMidiScheduler(ctx);
    function schedAt(eventTimeStamp: number): number {
      return scheduler.schedAt(eventTimeStamp);
    }

    function applyVoiceFromStack(eventTime: number): void {
      const winner = pickWinner(heldStack, priority);
      if (winner === null) {
        // All keys released → gate low, freeze pitch at last value.
        gateSrc.offset.cancelScheduledValues(eventTime);
        gateSrc.offset.setValueAtTime(0, eventTime);
        return;
      }
      const vOct = midiToVOct(winner) + currentBendVOct;
      pitchSrc.offset.cancelScheduledValues(eventTime);
      pitchSrc.offset.setValueAtTime(vOct, eventTime);
      // Gate high. Retrigger is handled by the caller (writes 0 then 1).
      gateSrc.offset.cancelScheduledValues(eventTime);
      gateSrc.offset.setValueAtTime(1, eventTime);
    }

    function applyPitchBendOnly(eventTime: number): void {
      const winner = pickWinner(heldStack, priority);
      if (winner === null) return; // bend with no key held = no audible change
      const vOct = midiToVOct(winner) + currentBendVOct;
      pitchSrc.offset.cancelScheduledValues(eventTime);
      pitchSrc.offset.setValueAtTime(vOct, eventTime);
    }

    function handleMidiMessage(ev: MidiEventLike): void {
      const data = ev.data;
      if (data.length < 1) return;
      const status = data[0]!;
      // Channel filter applies to channel-voice messages only (top nibble
      // 0x80..0xE0). System messages (0xF0+) bypass.
      if ((status & 0x80) && (status & 0xf0) <= 0xe0) {
        if (!channelMatches(status, channel)) return;
      }
      const t = schedAt(ev.timeStamp);

      // Pitch-bend?
      const bend = parsePitchBend(data);
      if (bend !== null) {
        currentBendVOct = bendToVOct(bend, DEFAULT_BEND_SEMITONES);
        applyPitchBendOnly(t);
        return;
      }

      const note = parseNoteEvent(data);
      if (!note || note.note === undefined) return;

      if (note.kind === 'note-on') {
        const prevWinner = pickWinner(heldStack, priority);
        heldStack = pushHeld(heldStack, note.note);
        lastNote = note.note;
        lastVelocity = note.velocity ?? 0;
        velSrc.offset.cancelScheduledValues(t);
        velSrc.offset.setValueAtTime(velocityToCv(lastVelocity), t);

        // Retrigger handling: if a previous voice was active AND retrig is
        // on, drop gate to 0 for one block before re-raising. This lets
        // ADSR / sample-and-hold downstream see a real new-note event.
        if (retrig && prevWinner !== null) {
          gateSrc.offset.cancelScheduledValues(t);
          gateSrc.offset.setValueAtTime(0, t);
          // 1 audio block @ 128 samples / 48kHz ≈ 2.67 ms. Use 3 ms to be
          // safe on slower sample rates / larger buffer sizes. The
          // downstream ADSR sees a real falling edge then a real rising
          // edge.
          gateSrc.offset.setValueAtTime(1, t + 0.003);
          // Pitch lands on the new note simultaneously (no need to wait
          // for the gate to drop — pitch can move under a low gate
          // without consequence).
          const winner = pickWinner(heldStack, priority);
          if (winner !== null) {
            const vOct = midiToVOct(winner) + currentBendVOct;
            pitchSrc.offset.cancelScheduledValues(t);
            pitchSrc.offset.setValueAtTime(vOct, t);
          }
        } else {
          applyVoiceFromStack(t);
        }
        notify();
        return;
      }

      if (note.kind === 'note-off') {
        heldStack = removeHeld(heldStack, note.note);
        // Apply (which lifts gate if nothing held, or repaints pitch to
        // whatever's still down).
        applyVoiceFromStack(t);
        notify();
        return;
      }
    }

    /** Listen on EXACTLY the chosen device. Re-targeting releases only the
     *  port THIS module held (see $lib/midi/input-attach) — it does not clear
     *  handler slots installed by anything else sharing the access. */
    function attachToDevice(deviceId: string | null): void {
      if (!access) return;
      const inp = deviceId === null ? undefined : access.inputs.get(deviceId);
      claim.attachOnly(inp ? [inp] : [], handleMidiMessage);
    }

    /**
     * Which input port to bind — the SHARED seam (`bindMidiPort`), not a
     * fourth hand-rolled copy of "saved id if still there, else the first one".
     *
     * ⚠ THE SAVED **NAME** IS THE DURABLE RECORD, NOT THE ID.
     * `MIDIInput.id` is implementation-defined and Chrome regenerates it,
     * which is why this module's surface writes `data.lastDeviceName` at pick
     * time. Until this call site existed nothing ever read that name back, so a
     * reloaded patch could only ever fall through to "the first port" — the
     * WRONG hardware, silently. See `bindMidiPort`'s header.
     */
    function pickDefaultDevice(): string | null {
      if (!access) return null;
      const connected: ConnectedDevice[] = [];
      for (const [id, inp] of access.inputs) connected.push({ id, name: inp.name ?? id });
      return bindMidiPort(
        { id: selectedDeviceId, name: savedData.lastDeviceName ?? null },
        connected,
      ).id;
    }

    async function connect(): Promise<boolean> {
      if (access) return true; // idempotent
      if (!webMidiAvailable()) {
        permissionDenied = true; // browser doesn't support it; treat as "denied"
        notify();
        return false;
      }
      try {
        // Cast: navigator type may not include requestMIDIAccess depending on
        // lib settings. Confirmed available by webMidiAvailable() above.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = await (navigator as any).requestMIDIAccess({ sysex: false });
        access = a as MidiAccessLike;
        // Hot-plug: device list changes update the card.
        access.onstatechange = () => {
          // If the currently-selected device disappeared, drop selection.
          if (selectedDeviceId && !access?.inputs.has(selectedDeviceId)) {
            // Don't null it out — keep it so the device re-attaches when
            // it comes back. But detach the listener and notify.
          } else if (!selectedDeviceId) {
            selectedDeviceId = pickDefaultDevice();
            attachToDevice(selectedDeviceId);
          }
          notify();
        };
        selectedDeviceId = pickDefaultDevice();
        attachToDevice(selectedDeviceId);
        notify();
        return true;
      } catch {
        permissionDenied = true;
        notify();
        return false;
      }
    }

    function selectDevice(deviceId: string | null): void {
      selectedDeviceId = deviceId;
      attachToDevice(deviceId);
      notify();
    }

    function setChannel(c: number | null): void {
      channel = c;
      // Clear held keys when the channel filter changes — any in-flight
      // note-offs that come back on the old channel would otherwise be
      // dropped, stranding a gate high forever.
      if (heldStack.length > 0) {
        heldStack = [];
        const t = ctx.currentTime + SCHED_LOOKAHEAD_S;
        gateSrc.offset.cancelScheduledValues(t);
        gateSrc.offset.setValueAtTime(0, t);
      }
      notify();
    }

    function setPriority(p: VoicePriority): void {
      priority = p;
      // Re-pick the winner under the new priority (without re-firing the
      // gate — a settings change shouldn't sound like a new note).
      const winner = pickWinner(heldStack, priority);
      if (winner !== null) {
        const t = ctx.currentTime + SCHED_LOOKAHEAD_S;
        const vOct = midiToVOct(winner) + currentBendVOct;
        pitchSrc.offset.cancelScheduledValues(t);
        pitchSrc.offset.setValueAtTime(vOct, t);
      }
      notify();
    }

    function setRetrig(r: boolean): void {
      retrig = r;
      // No scheduling side effect — applies on the next note-on.
      notify();
    }

    const cardApi: MidiCvBuddyApi = {
      connect,
      selectDevice,
      setChannel,
      setPriority,
      setRetrig,
      getState: snapshotState,
      subscribe(cb) {
        subscriber = cb;
        cb(snapshotState());
        return () => {
          if (subscriber === cb) subscriber = null;
        };
      },
    };

    return {
      domain: 'audio',
      inputs: new Map(),
      outputs: new Map([
        ['pitch_cv',    { node: pitchSrc, output: 0 }],
        ['gate',        { node: gateSrc,  output: 0 }],
        ['velocity_cv', { node: velSrc,   output: 0 }],
      ]),
      setParam() {
        // No AudioParam-style knobs.
      },
      readParam() {
        return undefined;
      },
      read(key) {
        if (key === 'card-api') return cardApi;
        if (key === 'state') return snapshotState();
        return undefined;
      },
      dispose() {
        // Detach OUR MIDI handler before tearing down audio nodes — only the
        // port we installed on, never a sweep across the whole access.
        claim.detach();
        if (access) {
          access.onstatechange = null;
          access = null;
        }
        subscriber = null;
        try { pitchSrc.stop(); } catch { /* */ }
        try { gateSrc.stop();  } catch { /* */ }
        try { velSrc.stop();   } catch { /* */ }
        pitchSrc.disconnect();
        gateSrc.disconnect();
        velSrc.disconnect();
      },
    };
  },
};
