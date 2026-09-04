// packages/web/src/lib/audio/modules/midi-lane.ts
//
// MIDI LANE — a per-channel "instrument bus" demux for a hardware MIDI
// sequencer (or any class-compliant USB-MIDI device).
//
// THE WHY (Phase 1 of the hardware-sequencers integration plan):
//   A DAW-style workflow is "1 MIDI channel = 1 instrument". You assign
//   each track of your external sequencer (Reliq, Cre8audio Programm,
//   Empress ZOIA, …) to its own MIDI channel, then drop one MIDI LANE per
//   instrument and point each at that track's channel. The lane demuxes
//   that channel into the CV/gate the rest of the rack speaks — notes,
//   gate, pitch CV, velocity, plus a couple of learn-assignable CC taps
//   for modulation, plus ONE by-note-number gate (the Programm/Reliq
//   drum-router pattern). The SAME outputs drive VIDEO modules for free
//   via the existing cross-domain CV/gate→video bridge (a `gate`/`cv`
//   ConstantSource output cabled into ACIDWARP.scene_cv / DOOM.cv_pN just
//   works — no synth voice required).
//
// DESIGN: this is deliberately NOT a 16-lane mega-module (which would
//   blow up to ~80 ports, a heavy card, and a VRT/CI burden — most lanes
//   idle for any real device). Instead it is a LIGHT, instantiable
//   per-lane bus: drop one per instrument, multi-timbral = drop several.
//   It is the spiritual successor of MIDI-CV-BUDDY (whose note logic it
//   reuses verbatim) but channel-aware (multi-select), with a
//   CC tap bank and a by-note gate built in.
//
// WHAT'S DIFFERENT FROM MIDI-CV-BUDDY:
//   * Channel filter is a multi-SELECT Set (0..15 | null=all), not a
//     single channel — so a lane can collect a few tracks (e.g. the bass
//     + its CC automation arriving on the same channel set).
//   * Two learn-assignable CC taps (cc_a, cc_b) → continuous 0..1 CV.
//     These subsume the per-track CC-modulation lane the plan wants. They
//     can drive audio params directly or video params via the bridge.
//   * One by-note-number gate (note_gate) → fires when a SPECIFIC MIDI
//     note arrives on the lane's channel(s). Generalizes the per-device
//     drum router (Programm ch10 by-note) via configuration, not 8 fixed
//     ports. Defaults to GM kick (MIDI 36).
//   * A polyphonic output (poly, a 10-channel polyPitchGate via
//     createPolySender) that ALWAYS carries the held chord — wire it to a poly
//     synth (DX7 / CUBE) and it just plays, no mode toggle needed.
//     The `mode` setting governs only the MONO outputs (pitch_cv/gate):
//     collapse-the-chord-to-one-winner ('mono') vs. leave-them-quiet ('poly').
//
// PORTS (7 outputs, all always present):
//   pitch_cv     (cv):   V/oct (0V = C4 = MIDI 60). Pitch-bend summed in.
//                        Driven only in mode='mono' (winner of the held stack).
//   gate         (gate): HIGH while any key on the lane is held; retrig dip.
//                        Driven only in mode='mono'.
//   velocity_cv  (cv):   0..1 (MIDI velocity / 127). Latched.
//   cc_a         (cv):   learn-assignable CC tap A, 0..1.
//   cc_b         (cv):   learn-assignable CC tap B, 0..1.
//   note_gate    (gate): fires on the card-selected MIDI note number.
//   poly         (polyPitchGate): ALWAYS carries the held chord (both modes).
//
// Inputs: none — the MIDI source is the external device (card dropdown).
//
// IMPLEMENTATION: main-thread, no worklet (exactly like MIDI-CV-BUDDY /
//   MIDICLOCK). One MIDI handler updates a held-keys stack + the CC/note
//   state and writes ConstantSourceNode offsets via setValueAtTime at a
//   small lookahead so values land at the start of the next audio block.
//   We reuse the pure, tested helpers from midi-cv-buddy (parseNoteEvent /
//   parsePitchBend / pickWinner / velocityToCv / bendToVOct / pushHeld /
//   removeHeld / SCHED_LOOKAHEAD_S / DEFAULT_BEND_SEMITONES) plus
//   a multi-channel Set filter (expandChannelSet pattern,
//   re-implemented locally so the module is self-contained + testable).
//
// PERMISSION UX: like MIDI-CV-BUDDY, we DON'T request Web MIDI on mount.
//   The card calls connect() once ("Connect MIDI…"); Chrome remembers the
//   origin grant.
//
// CONFIG-ONLY Reliq note: the Reliq is a class-compliant USB-MIDI device,
//   so it appears directly in the Web MIDI device dropdown — no driver, no
//   native bridge. Assign each Reliq track to its own MIDI channel, drop
//   one MIDI LANE per track, and set each lane's channel to match. Nothing
//   in this module is Reliq-specific; it is the same path for the Programm
//   and ZOIA.
//
// (Inputs / Outputs / Params block — IO surface restated for the docs manifest)
//
// Inputs: none.
//
// Outputs:
//   pitch_cv (cv): V/oct (0V = C4 = MIDI 60). Includes pitch-bend.
//   gate (gate): HIGH while any key on the lane is held; brief retrigger dip.
//   velocity_cv (cv): 0..1 (MIDI velocity / 127). Latched.
//   cc_a (cv): learn-assignable CC tap A → 0..1.
//   cc_b (cv): learn-assignable CC tap B → 0..1.
//   note_gate (gate): fires on the card-selected MIDI note number.
//   poly (polyPitchGate): always carries the held chord (mode-independent).
//
// Params: none on the engine side. (Device + channel set + voice priority +
//   retrigger + mode + CC# assignments + note# live in node.data; the card
//   writes them.)

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ModuleFace } from '$lib/graph/types';
import { midiToVOct, noteNameForMidi, parseNoteName } from '$lib/audio/note-entry';
import { createPolySender, type PolySender } from '$lib/audio/poly';
import { createMidiScheduler } from '$lib/audio/midi-timing';
import { createMidiInputClaim } from '$lib/midi/input-attach';
import { bindMidiPort, type ConnectedDevice } from '$lib/graph/device-rebind';
import type {
  MidiAccessLike,
  MidiEventLike,
  VoicePriority,
} from './midi-cv-buddy';
import {
  bendToVOct,
  channelMatches,
  DEFAULT_BEND_SEMITONES,
  MIDI_CHANNEL_COUNT,
  parseNoteEvent,
  parsePitchBend,
  pickWinner,
  pushHeld,
  removeHeld,
  SCHED_LOOKAHEAD_S,
  velocityToCv,
  webMidiAvailable,
} from './midi-cv-buddy';

// ---------------- Pure helpers (testable) ----------------

/** How many channels the MIDI protocol has. A PROTOCOL CONSTANT, not a
 *  population count — MIDI 1.0 puts the channel in the low nibble of the
 *  status byte, so it is 16 by the wire format and cannot drift. Exported so
 *  the channel filter, the card's dropdown and the faceplate\'s channel roster
 *  all read the same number from one place instead of re-typing `16`.
 *
 *  ⚠ RE-EXPORTED, NOT DECLARED. It now lives on `midi-cv-buddy.ts`, whose own
 *  face needs the same roster — and the dependency between these two files runs
 *  midi-lane → midi-cv-buddy (`VoicePriority`, `channelMatches`, …), so that is
 *  the only end that can hold it without a cycle. Every existing importer of
 *  this name is untouched. */
export { MIDI_CHANNEL_COUNT };

/** Returns a Set of channels (0-indexed, 0..15) selected; null = all.
 *  An `expandChannelSet` helper so a lane can collect a subset of
 *  channels — the bass track + any CC automation on the same channel
 *  group, say. Invalid entries are dropped. An empty array collapses to
 *  an empty Set (matches nothing) — distinct from null (matches all). */
export function expandLaneChannels(channels: number[] | null): Set<number> | null {
  if (channels === null) return null;
  const s = new Set<number>();
  for (const c of channels) {
    if (Number.isInteger(c) && c >= 0 && c < MIDI_CHANNEL_COUNT) s.add(c);
  }
  return s;
}

// ---------------- The CHANNEL choice, as one roster ----------------
//
// The card's dropdown and the faceplate\'s selector cell offer the SAME
// seventeen choices — ALL, then the sixteen channels displayed 1-based the way
// every piece of hardware labels them while the wire format is 0-based. The
// roster is BUILT from `MIDI_CHANNEL_COUNT` rather than written out, so there is
// no list to keep in step with anything, and both surfaces import it instead of
// re-deriving the off-by-one. (`MidiLaneCard.svelte` used to spell the
// `{#each Array(16)}` and the `i + 1` inline; a face that spelled them again
// would be two encodings of one convention.)

/** The `channels` value meaning "listen to every channel" — `null` in the
 *  stored form, and this string in any picker, since a `<select>` value and a
 *  `SelectorOption` value are both strings. */
export const MIDI_LANE_CHANNEL_ALL = 'all';

/** ALL + one entry per MIDI channel, `value` 0-based (the wire form) and
 *  `label` 1-based (the form printed on the front of every sequencer). */
export function midiLaneChannelChoices(): Array<{ value: string; label: string }> {
  return [
    { value: MIDI_LANE_CHANNEL_ALL, label: 'ALL' },
    ...Array.from({ length: MIDI_CHANNEL_COUNT }, (_, i) => ({
      value: String(i),
      label: String(i + 1),
    })),
  ];
}

/** The stored `channels` array for a picker value, and back. `null` is ALL. */
export function channelsForChoice(choice: string): number[] | null {
  if (choice === MIDI_LANE_CHANNEL_ALL) return null;
  const n = Number.parseInt(choice, 10);
  if (!Number.isInteger(n) || n < 0 || n >= MIDI_CHANNEL_COUNT) return null;
  return [n];
}

/** The picker value for a stored `channels` array. A multi-channel set has no
 *  single-channel choice to show, so it reads as ALL — which is what the card
 *  has always done (`channelLabel`), and the engine still honours the real Set.
 */
export function choiceForChannels(channels: number[] | null | undefined): string {
  if (channels === null || channels === undefined) return MIDI_LANE_CHANNEL_ALL;
  if (channels.length !== 1) return MIDI_LANE_CHANNEL_ALL;
  const only = channels[0];
  if (!Number.isInteger(only) || only < 0 || only >= MIDI_CHANNEL_COUNT) {
    return MIDI_LANE_CHANNEL_ALL;
  }
  return String(only);
}

/** True if a raw MIDI status byte's channel matches the lane's channel set
 *  (null = all). Applies to channel-voice messages only; the caller gates
 *  on whether the status is a channel-voice message first. */
export function laneChannelMatches(statusByte: number, channelSet: Set<number> | null): boolean {
  if (channelSet === null) return true;
  return channelSet.has(statusByte & 0x0f);
}

/** Parse a Control Change message into { cc, value } or null. CC value is
 *  the raw 7-bit 0..127; the lane maps to 0..1 with `ccToCv`. */
export function parseCc(data: Uint8Array): { cc: number; value: number } | null {
  if (data.length < 3) return null;
  if ((data[0]! & 0xf0) !== 0xb0) return null;
  return { cc: data[1]! & 0x7f, value: data[2]! & 0x7f };
}

/** Map a 7-bit CC value (0..127) to a 0..1 CV value. */
export function ccToCv(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const v = Math.max(0, Math.min(127, Math.round(value)));
  return v / 127;
}

/** Cap on poly voices the lane allocates (the polyPitchGate carries
 *  POLY_CHANNEL_PAIRS=16 pitch/gate pairs across 32 channels — the Web Audio
 *  merger max). MIDI LANE packs up to 16 held keys so it can fully drive a
 *  16-voice consumer (e.g. SIX STRUM's 6 strings). */
export const MAX_POLY_VOICES = 16;

/** Build the poly "lanes" array (pitch V/oct + gate 0/1) from a held-keys
 *  stack under a given voice priority. Newest-held voices win when more
 *  than MAX_POLY_VOICES keys are down (steal-oldest). `bendVOct` is summed
 *  into every voice's pitch. Pure so the poly allocation is unit-testable
 *  without an AudioContext. */
export function buildPolyLanes(
  heldKeysInPressOrder: readonly number[],
  bendVOct: number,
): Array<{ pitch: number; gate: 0 | 1 }> {
  const lanes: Array<{ pitch: number; gate: 0 | 1 }> = [];
  // Take the most-recent MAX_POLY_VOICES (steal-oldest under voice pressure).
  const recent = heldKeysInPressOrder.slice(-MAX_POLY_VOICES);
  for (let i = 0; i < MAX_POLY_VOICES; i++) {
    const note = recent[i];
    if (note === undefined) {
      lanes.push({ pitch: 0, gate: 0 });
    } else {
      lanes.push({ pitch: midiToVOct(note) + bendVOct, gate: 1 });
    }
  }
  return lanes;
}

// ---------------- Types / data shape ----------------

export type LaneMode = 'mono' | 'poly';

/** Card-readable state surfaced via `handle.read('state')`. */
export interface MidiLaneCardState {
  connected: boolean;
  permissionDenied: boolean;
  devices: Array<{ id: string; name: string; state: string }>;
  selectedDeviceId: string | null;
  /** Last note received on the lane (MIDI int) for the readout. */
  lastNote: number | null;
  lastVelocity: number;
  /**
   * How many keys are held on this lane RIGHT NOW.
   *
   * ⚠ ADDED FOR THE FACEPLATE, BECAUSE `lastNote` CANNOT ANSWER THE QUESTION.
   * `lastNote` is LATCHED — it is assigned on note-on and never cleared, not on
   * note-off and not on a channel change — so a lamp bound to
   * `lastNote !== null` lights on the first note of the session and never goes
   * dark again, which is a lamp that says nothing. The card got away with it by
   * painting the note NAME (a latched last value is a defensible readout); a
   * lamp is a live indicator and needs a live quantity. `heldStack.length` is
   * that quantity and it is already maintained on every note-on and note-off.
   */
  heldCount: number;
  /** Last CC VALUE (0..127) seen for cc_a / cc_b (live readout). */
  lastCcA: number | null;
  lastCcB: number | null;
  /** Currently-ASSIGNED CC# for cc_a / cc_b (null = unassigned). The card
   *  reads these back to persist a learned binding into node.data. */
  ccANum: number | null;
  ccBNum: number | null;
  /** True while waiting to capture the next CC for cc_a / cc_b. */
  learningCcA: boolean;
  learningCcB: boolean;
}

/** Saved per-instance data on the patch node (`node.data`, Yjs-synced). */
export interface MidiLaneData {
  /** Channel set: array of 0..15, or null for "all". */
  channels: number[] | null;
  priority: VoicePriority;
  retrig: boolean;
  mode: LaneMode;
  /** CC numbers tapped by cc_a / cc_b (null = unassigned / no CC drives it). */
  ccA: number | null;
  ccB: number | null;
  /** MIDI note number the note_gate fires on (default GM kick = 36). */
  noteGateNote: number;
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

export const DEFAULT_DATA: MidiLaneData = {
  channels: null,
  priority: 'last',
  retrig: true,
  mode: 'mono',
  ccA: 1, // CC1 = mod wheel — the most common "give me some modulation" CC
  ccB: null,
  noteGateNote: 36, // GM kick
  lastDeviceId: null,
};

// ---------------- The by-note GATE's note number, as one validator ----------
//
// ⚠ ONE GRAMMAR, TWO SURFACES. The card types this number into an
// `<input type="number" min="0" max="127">` and the faceplate types it into a
// `ShellEntryCell`; a card and a face that parse differently both look correct
// and disagree about what the user typed, and no runtime gate reads a grammar.
// So the grammar lives here, beside the engine that consumes it, and both
// surfaces import it.
//
// ⚠ THE FACE REFUSES WHERE THE CARD CLAMPED, DELIBERATELY. `setNoteGateNote`
// ends in `Math.max(0, Math.min(127, Math.round(n)))` — type `200` on the card
// and the gate silently re-points at 127, which is the backdraft shape (a
// control writing a value the domain does not contain while the model quietly
// corrects it). `ShellEntryCell.parse` returns a tagged union precisely so a
// rejection can write NOTHING, so the faceplate reports `200` as invalid and
// leaves the stored note alone. The engine's clamp stays as the last line of
// defence for a value arriving from an older saved patch.

/** Lowest / highest MIDI note number the by-note gate accepts. The MIDI note
 *  space is 7-bit and `setNoteGateNote` has always taken all of it; the card's
 *  `min="0" max="127"` is the same range spelled in HTML. */
export const NOTE_GATE_MIN_NOTE = 0;
export const NOTE_GATE_MAX_NOTE = 127;

/**
 * Parse a typed by-note-gate note. Accepts EITHER a bare MIDI number (`36` —
 * the form the card's number input takes, and the form drum programmers think
 * in) OR a note NAME (`c2`, `f#3` — the spelling the card prints beside the
 * number). Returns null for anything else, INCLUDING an out-of-range number.
 *
 * ⚠ THE TWO ACCEPTED FORMS COVER DIFFERENT RANGES, AND THE UNION IS WHY BOTH
 * ARE HERE. `parseNoteName` is bounded to `MIN_MIDI`..`MAX_MIDI` (12..108, the
 * range that has a printable name), so a name-only field could not reach the
 * 31 note numbers outside it that the card's input reaches today — a parity
 * loss of exactly the kind promotion must not introduce. The numeric form
 * covers the full 0..127, and the name form is the affordance added on top.
 */
export function parseNoteGateNote(text: string): number | null {
  const s = text.trim();
  if (s === '') return null;
  if (/^[0-9]{1,3}$/.test(s)) {
    const n = Number.parseInt(s, 10);
    return n >= NOTE_GATE_MIN_NOTE && n <= NOTE_GATE_MAX_NOTE ? n : null;
  }
  return parseNoteName(s);
}

/**
 * How a stored note number spells itself back into the field. The NAME where
 * one exists (`36` → `c2`), the bare number where it does not — so the text is
 * always something `parseNoteGateNote` accepts and the field round-trips for
 * every value the module can hold.
 */
export function noteGateNoteText(note: number): string {
  const name = noteNameForMidi(note);
  return name === '' ? String(note) : name;
}

/** GATE_PULSE_S — how long the note_gate stays high for a one-shot note
 *  trigger before falling. ~6 ms is long enough to clear a downstream
 *  edge detector + an ADSR's first block, short enough to retrigger fast
 *  drum patterns. */
export const NOTE_GATE_PULSE_S = 0.006;

export interface MidiLaneApi {
  connect(): Promise<boolean>;
  selectDevice(deviceId: string | null): void;
  setChannels(channels: number[] | null): void;
  setPriority(priority: VoicePriority): void;
  setRetrig(retrig: boolean): void;
  setMode(mode: LaneMode): void;
  /** Begin "learn" — bind the next CC# seen to cc_a / cc_b. */
  learnCcA(): void;
  learnCcB(): void;
  setCcA(cc: number | null): void;
  setCcB(cc: number | null): void;
  setNoteGateNote(note: number): void;
  getState(): MidiLaneCardState;
  subscribe(cb: (s: MidiLaneCardState) => void): () => void;
}

// ---------------- The FACEPLATE (PF-20) ----------------
//
// WHAT MIDI LANE IS FOR, IN ONE PARAGRAPH. It is the module that lets ONE track
// of a hardware sequencer play ONE instrument in the rack. Everything it emits
// — pitch, gate, velocity, two CC taps, a by-note drum gate and an always-live
// poly chord — is a demux of a single MIDI channel. The verb a player performs
// is BIND: grant the browser MIDI, point this lane at a channel, and the track
// is now an instrument. Every rank below descends from that.
//
// ── THE TIER LADDER, READ BACK AS A SENTENCE ────────────────────────────────
//
// `glyph: 'none'`, so the compact tier shows THREE controls: CONNECT, CH and
// MODE — grant access, choose the track, decide whether the mono jacks speak.
// That is the whole of "bind this lane" and it fits on a 192 px lane tile. The
// plate tier adds NOTE#, PRIO and RETRIG: the drum tap and the two settings
// that shape how a held chord collapses onto PITCH/GATE. The dock adds the four
// CC-tap gestures, which are the only controls here that cannot do anything
// until a device is in the player's hands and being wiggled.
//
// ⚠ CONNECT IS RANK 1 AND THAT IS THE POINT OF THE PROMOTION, not a nicety.
// `laneRenderKind` returns 'placeholder' for this module today — a tile with NO
// ranked controls at all — and `connect()` is reachable only from a mounted
// legacy card, so on a module that is completely inert until Web MIDI is
// granted, the grant required first discovering that the dock full view exists.
// An `action` cell is not dock-restricted (only `panel` is), so the gesture
// lands on the lane tile. This is midiclock's argument verbatim (#2187) and it
// applies here for the same mechanical reason.
//
// ⚠ WHY `order` AND `pages` DISAGREE. `order` is PRIORITY — it decides what
// survives at the mini/compact/plate tiers, so it is sorted by "what breaks if
// this is wrong". `pages` is SIGNAL ORDER on the one tier that shows
// everything, so it groups by which part of the module a control belongs to:
// NOTE# ranks 4th (a lane whose drum tap is on the wrong note is silently dead)
// but pages LAST, because the by-note gate is a separate tap off the same
// stream rather than part of the mono voice.
//
// ⚠ FOUR BANDS, NO TAB RAIL. `DOCK_TAB_MIN_BANDS` is 7 and `face.tabbed` is
// owner-instruction-only. Nothing is padded to reach a rail and nothing is
// merged to stay under one — these are the four ideas the module actually has.
//
// ⚠ `note gate` IS A ONE-CONTROL BAND ON IDENTITY GROUNDS. The rule is that
// a page earns a header at ≥2 controls, or 1 that is the module's identity, and
// the by-note gate is one of exactly two things that make this module not
// MIDI-CV-BUDDY (the other is the CC bank, which has its own band). The def's
// own header says so: it "generalizes the per-device drum router … via
// configuration, not 8 fixed ports".
//
// ⚠ NO HERO. A hero promotes a CONTROL, and there is nothing here that wants to
// be big: no live picture, no scope trace, no XY pad. Declaring one would also
// EMPTY ITS BAND (`heroFacePlan` MOVES the key), and every band here is already
// at its honest size.
//
// ⚠ NO `face.rear`. The rear card is a projection of `pages`; this module has
// no inputs at all, and its seven outputs take the derived default — one `out`
// section splitting by cable domain. Authoring a group would restate the
// domains, which is the case the derived default exists for.
export const MIDI_LANE_FACE: ModuleFace = {
  // ⚠ MECHANICALLY FORCED, not a style choice. `glyphBinding` reaches a live
  // trace through `primaryAudioOutPortId`, which matches `type === 'audio'`
  // EXACTLY. This module's seven outputs are cv / gate / cv / cv / cv / gate /
  // polyPitchGate — not one `audio` port — so any other glyph value falls
  // through to `{kind:'static'}`, the dead binding module-face-lint reddens.
  glyph: 'none',
  // The DEVICE ROSTER is the one affordance here that cannot be a cell: it
  // lives on the engine handle behind `requestMIDIAccess()` and differs on
  // every machine, so it is neither a ParamDef nor an `options` roster (a
  // roster is a fixed set known when the def is authored). See the extension.
  extension: 'midiLane',
  order: [
    'midi-lane-connect-{n}',
    'midi-lane-channel-{n}',
    'midi-lane-mode-{n}',
    'midi-lane-note-{n}',
    'midi-lane-priority-{n}',
    'midi-lane-retrig-{n}',
    'midi-lane-learn-a-{n}',
    'midi-lane-clear-a-{n}',
    'midi-lane-learn-b-{n}',
    'midi-lane-clear-b-{n}',
  ],
  pages: [
    {
      id: 'lane',
      label: 'lane',
      hint:
        'Web MIDI needs the browser\'s consent before any device is even visible, and until it '
        + 'is granted this lane has no stream to demux. Then point the lane at one channel: '
        + '"one MIDI channel = one instrument" is the workflow the module exists for, and a lane '
        + 'aimed at the wrong channel is silent rather than wrong. ALL collects every channel.',
      controls: ['midi-lane-connect-{n}', 'midi-lane-channel-{n}'],
    },
    {
      id: 'mono',
      label: 'mono',
      hint:
        'How a held chord collapses onto the single PITCH and GATE jacks. MONO picks one winning '
        + 'note by voice priority; POLY leaves those two jacks quiet and you take the chord off '
        + 'the POLY jack, which carries it in BOTH modes. RETRIG dips the gate for a block on each '
        + 'new note so a downstream envelope re-fires instead of sustaining through the change.',
      controls: ['midi-lane-mode-{n}', 'midi-lane-priority-{n}', 'midi-lane-retrig-{n}'],
    },
    {
      id: 'cc',
      label: 'cc taps',
      hint:
        'Two independent 0..1 CV taps off the same channel. Press LEARN and move a controller on '
        + 'the device to bind the next CC number that arrives; CLEAR unassigns the tap so nothing '
        + 'drives it. Wire them at audio params, or at video params through the cross-domain '
        + 'bridge. Which number each tap is bound to is on its lamp in the device strip above.',
      controls: [
        'midi-lane-learn-a-{n}',
        'midi-lane-clear-a-{n}',
        'midi-lane-learn-b-{n}',
        'midi-lane-clear-b-{n}',
      ],
    },
    {
      id: 'note',
      label: 'note gate',
      hint:
        'The NOTE jack fires a one-shot pulse when this exact note arrives on the lane\'s '
        + 'channel(s) — the drum-router pattern through one configurable port instead of eight '
        + 'fixed ones. Type a note name (c2) or a bare MIDI number (36); both are accepted and an '
        + 'out-of-range value is refused rather than quietly rounded to the nearest legal one.',
      controls: ['midi-lane-note-{n}'],
    },
  ],
};

export const midiLaneDef: AudioModuleDef = {
  type: 'midiLane',
  palette: { top: 'MIDI', sub: 'MIDI' },
  domain: 'audio',
  label: 'midi lane',
  category: 'sources',

  inputs: [],
  outputs: [
    { id: 'pitch_cv',    type: 'cv' },
    { id: 'gate',        type: 'gate', edge: 'gate' },
    { id: 'velocity_cv', type: 'cv' },
    { id: 'cc_a',        type: 'cv' },
    { id: 'cc_b',        type: 'cv' },
    { id: 'note_gate',   type: 'gate', edge: 'trigger' },
    // Polyphonic chord output. Always declared AND always live: it carries the
    // held chord in BOTH modes, so wiring it to a poly synth (DX7 /
    // CUBE / cartesian) plays straight away. `mode` only affects the MONO
    // outputs above. (#674: poly used to be silent in the default mono mode.)
    { id: 'poly',        type: 'polyPitchGate' },
  ],
  params: [],

  face: MIDI_LANE_FACE,

  // ⚠ TEN FAMILIES FOR TEN CELLS, AND THE COUNT IS FORCED BY THE RESOLVER.
  // `resolveFaceControl` resolves a face key to a PARAM id, a family TEMPLATE
  // (`<id>-{n}`) or a legend STATIC — and this module declares `params: []`, so
  // every one of its controls has to arrive as a family. That is not a
  // workaround: each of these really is a named affordance the module owns, and
  // each has a real control on the legacy card carrying the same
  // `testidPrefix`, which is what `module-docs-lint`'s card-drift leg checks.
  //
  // ⚠ THE SETTINGS STAY ON `node.data` AND ARE **NOT** MIGRATED TO PARAMS in
  // this PR, deliberately. Turning the seven of them into `ParamDef`s is a real
  // and probably good idea — it would buy automation, MIDI-learn, group-expose,
  // undo and a Push 2 card — but it is a CONTRACT migration that needs a
  // saved-patch read order (params → legacy `data` → default) per key, ten new
  // contract-lock lines, a Push 2 card where there is none today, and a fresh
  // ART pass on the poly path. `ShellSelectorCell` / `ShellToggleCell` /
  // `ShellEntryCell` all read and write `node.data` through closures by design,
  // so the face needs none of that to be complete, and bundling it would put a
  // contract migration inside a promotion.
  controlFamilies: [
    { id: 'midi-lane-connect',  label: 'Connect MIDI', kind: 'other', testidPrefix: 'midi-lane-connect' },
    { id: 'midi-lane-channel',  label: 'Channel',      kind: 'other', testidPrefix: 'midi-lane-channel' },
    { id: 'midi-lane-mode',     label: 'Mode',         kind: 'other', testidPrefix: 'midi-lane-mode' },
    { id: 'midi-lane-note',     label: 'Note',         kind: 'other', testidPrefix: 'midi-lane-note' },
    { id: 'midi-lane-priority', label: 'Priority',     kind: 'other', testidPrefix: 'midi-lane-priority' },
    { id: 'midi-lane-retrig',   label: 'Retrigger',    kind: 'other', testidPrefix: 'midi-lane-retrig' },
    { id: 'midi-lane-learn-a',  label: 'Learn CC A',   kind: 'other', testidPrefix: 'midi-lane-learn-a' },
    { id: 'midi-lane-clear-a',  label: 'Clear CC A',   kind: 'other', testidPrefix: 'midi-lane-clear-a' },
    { id: 'midi-lane-learn-b',  label: 'Learn CC B',   kind: 'other', testidPrefix: 'midi-lane-learn-b' },
    { id: 'midi-lane-clear-b',  label: 'Clear CC B',   kind: 'other', testidPrefix: 'midi-lane-clear-b' },
  ],

  docs: {
    explanation:
      "A per-channel instrument bus that demuxes ONE MIDI channel (or a small set of channels) out of a hardware sequencer into everything the rack needs to play that track — pitch, gate, velocity, two assignable CC taps, a by-note-number gate, AND a polyphonic chord output. The intended workflow is DAW-style 'one MIDI channel = one instrument': assign each track of an external sequencer (Reliq, Cre8audio Programm, Empress ZOIA, …) to its own MIDI channel, drop one MIDI LANE per instrument, and point each lane at its track's channel. It is the channel-aware successor of MIDI-CV-BUDDY: the mono pitch/gate/velocity behave the same (a voice-priority winner of the held stack), but a multi-select channel filter, a learn-assignable CC bank, a by-note gate, and an always-live poly output are added. the faceplate\'s `mode` setting governs only the MONO outputs — 'mono' collapses a held chord to one winning note on PITCH/GATE, 'poly' leaves those quiet — while the POLY output carries the whole held chord in BOTH modes. Device, channel set, voice priority, retrigger, mode, CC# assignments and the note# are all discrete card settings saved in the patch (no audio-side knobs). The SAME outputs drive video modules for free via the cross-domain CV/gate bridge.",
    inputs: {},
    outputs: {
      pitch_cv:
        "The winning held note as pitch CV in volts-per-octave (0V = C4 = MIDI 60), with pitch-bend summed in. Driven only when the faceplate's mode is 'mono' (it follows the voice-priority winner of the held stack and latches the last note); in 'poly' mode it stays quiet and you use the POLY output instead.",
      gate:
        "High while any key on this lane's channel(s) is held, with a brief retrigger dip so downstream envelopes re-fire. Driven only in 'mono' mode (it sits low in 'poly' mode). Patch it into an envelope or VCA gate.",
      velocity_cv:
        "How hard the most recent note was struck, as 0..1 CV (MIDI velocity / 127), latched between events. Route it to a VCA level or filter cutoff for velocity dynamics.",
      cc_a:
        "Learn-assignable Continuous-Controller tap A, output as 0..1 CV: it follows whatever MIDI CC number the card has assigned to slot A (e.g. a mod wheel or a track's automation lane on this channel). Wire it to an audio param — or, via the cross-domain bridge, a video param — for hands-on modulation from the external gear.",
      cc_b:
        "Learn-assignable Continuous-Controller tap B, a second independent 0..1 CV tap following its own card-assigned CC number — a second modulation lane alongside cc_a.",
      note_gate:
        "A gate that fires when the SPECIFIC MIDI note number selected on the faceplate arrives on this lane's channel(s) (defaults to GM kick, MIDI 36). It generalizes the per-device drum-router pattern (e.g. the Programm's ch10 by-note triggers) through one configurable port — patch it into a drum voice's strike or any trigger input.",
      poly:
        "A polyphonic pitch+gate bus (up to 10 voices) that ALWAYS carries the full held chord, in both 'mono' and 'poly' modes. Wire it to a poly-aware voice — DX7, CUBE, or a module with a poly input — and the chord plays straight away with no mode toggle. This is the real polyphonic source chain: MIDI LANE.poly → poly synth produces audible chords (it does not need the mono outputs).",
    },
    controls: {
      'midi-lane-connect-{n}':
        "The one-time-per-origin permission gesture, and the first thing to press on a lane that has never been used. Web MIDI needs the browser's consent before any device is even visible, so until it is granted this module has no stream to demux and all seven jacks sit at rest — it is not optional and it is not a setting. Once access is granted the device strip at the top of the dock faceplate lists the inputs that were found and remembers the one you pick, so a reloaded patch re-attaches without another press. The grant is per origin, not per lane: drop a second MIDI LANE afterwards and it is already connected.",
      'midi-lane-channel-{n}':
        "Which MIDI channel this lane listens to — the setting the whole module is built around. The intended workflow is DAW-style 'one channel = one instrument': assign each track of the external sequencer to its own channel, drop one lane per track, and set each lane's channel to match. Channels are shown 1..16 the way the hardware labels them, while the wire format counts from zero; ALL collects every channel into this one lane, which is what you want for a single-track device and what you do not want the moment two tracks are playing. Changing it clears any held notes so a channel switch cannot strand a gate high.",
      'midi-lane-mode-{n}':
        "Whether the MONO jacks speak. In MONO the held stack collapses to one winning note (see PRIORITY) and drives PITCH and GATE; in POLY those two jacks stay quiet and the chord goes out of the POLY jack instead. The thing worth knowing is that POLY is not a mode you have to find: the POLY jack carries the full held chord in BOTH settings, so wiring it to a poly-aware voice plays straight away and this control only decides whether the mono pair is ALSO live. Switching clears held notes so the bank you just left cannot leave a voice sounding.",
      'midi-lane-note-{n}':
        "Which single MIDI note fires the NOTE jack — the by-note drum tap. When a note-on with exactly this number arrives on the lane's channel(s), NOTE emits a short one-shot pulse suitable for a drum voice's strike or any trigger input; every other note is ignored by this jack and still flows through PITCH/GATE/POLY as usual. It generalizes the per-device drum-router pattern (a Programm or Reliq sending its kit on channel 10 by note number) through one configurable port rather than eight fixed ones, so a rack with six drum voices is six lanes on one channel with six different notes here. Type either a note name (c2, f#3) or a bare MIDI number (0..127); the default 36 is the General MIDI kick. A value outside 0..127 is refused rather than rounded to the nearest legal one.",
      'midi-lane-priority-{n}':
        "Which held note wins when several are down and the lane is in MONO. LAST follows the most recently pressed key, which is what feels like playing; LOW holds the bottom of the chord, the classic bass-line behaviour that lets you play over a held root; HIGH holds the top, so a melody survives notes added underneath it. It has no effect at all in POLY, where every held note gets its own voice on the POLY jack.",
      'midi-lane-retrig-{n}':
        "Whether a new note while another is already held re-fires downstream envelopes. ON drops the GATE jack for a single audio block and raises it again, which an ADSR reads as a fresh note-on, so legato playing articulates every note. OFF leaves the gate high through the change, so the envelope sustains and only the pitch moves — the legato behaviour you want for a slide or a portamento line. MONO only; it has no bearing on the POLY jack, where each voice has its own gate.",
      'midi-lane-learn-a-{n}':
        "Arms CC tap A to bind itself to the next controller number that arrives on this lane's channel(s). Press it, then move the control you want on the device — a mod wheel, a fader, a track's automation lane — and tap A follows that CC number from then on, emitting it as 0..1 CV on the CC A jack. This is how a tap gets bound: there is no list of controller numbers to hunt through, because which physical control sends which number is a property of the device rather than of this module. The binding is saved with the patch. Only one tap arms at a time, so arming A disarms B.",
      'midi-lane-clear-a-{n}':
        "Unassigns CC tap A, so no controller number drives it and the CC A jack holds its last value instead of following anything. Use it to free a tap you bound by accident, or to park a lane's modulation before re-learning it to a different control. It does not change the CC A jack's current level, and it does not touch tap B.",
      'midi-lane-learn-b-{n}':
        "Arms CC tap B, the second independent modulation tap, exactly as LEARN A arms the first — press it and move a control on the device to bind the next controller number that arrives. Two taps is what lets one track carry two hands' worth of modulation: a wheel into a filter and a pedal into a delay send, say, from the same channel. Arming B disarms A, since only one tap can be listening for the next number.",
      'midi-lane-clear-b-{n}':
        "Unassigns CC tap B, leaving the CC B jack holding its last value with nothing driving it. The mirror of CLEAR A, and independent of it — clearing one tap never disturbs the other's binding.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // ---------------- ConstantSource outputs ----------------
    const pitchSrc = ctx.createConstantSource();
    pitchSrc.offset.value = 0;
    pitchSrc.start();
    const gateSrc = ctx.createConstantSource();
    gateSrc.offset.value = 0;
    gateSrc.start();
    const velSrc = ctx.createConstantSource();
    velSrc.offset.value = 0;
    velSrc.start();
    const ccASrc = ctx.createConstantSource();
    ccASrc.offset.value = 0;
    ccASrc.start();
    const ccBSrc = ctx.createConstantSource();
    ccBSrc.offset.value = 0;
    ccBSrc.start();
    const noteGateSrc = ctx.createConstantSource();
    noteGateSrc.offset.value = 0;
    noteGateSrc.start();

    // Poly sender (10-channel polyPitchGate merger). Always created AND always
    // fed (in both modes) so the `poly` output carries the held chord whenever
    // it's patched — see applyPoly.
    const poly: PolySender = createPolySender(ctx);

    // ---------------- Saved data (with defaults) ----------------
    const savedData = (node.data ?? {}) as Partial<MidiLaneData>;
    let channelSet: Set<number> | null = expandLaneChannels(
      savedData.channels ?? DEFAULT_DATA.channels,
    );
    let priority: VoicePriority = savedData.priority ?? DEFAULT_DATA.priority;
    let retrig: boolean = savedData.retrig ?? DEFAULT_DATA.retrig;
    let mode: LaneMode = savedData.mode ?? DEFAULT_DATA.mode;
    let ccA: number | null = savedData.ccA ?? DEFAULT_DATA.ccA;
    let ccB: number | null = savedData.ccB ?? DEFAULT_DATA.ccB;
    let noteGateNote: number = savedData.noteGateNote ?? DEFAULT_DATA.noteGateNote;
    let selectedDeviceId: string | null = savedData.lastDeviceId ?? DEFAULT_DATA.lastDeviceId;

    // ---------------- Internal mutable state ----------------
    let heldStack: number[] = [];
    let currentBendVOct = 0;
    let lastNote: number | null = null;
    let lastVelocity = 0;
    let lastCcA: number | null = null;
    let lastCcB: number | null = null;
    let learningCcA = false;
    let learningCcB = false;
    let access: MidiAccessLike | null = null;
    /** Identity-scoped handler-slot claim — see $lib/midi/input-attach. */
    const claim = createMidiInputClaim('midi-lane');
    let permissionDenied = false;
    let subscriber: ((s: MidiLaneCardState) => void) | null = null;

    function snapshotState(): MidiLaneCardState {
      const devices: MidiLaneCardState['devices'] = [];
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
        lastCcA,
        lastCcB,
        ccANum: ccA,
        ccBNum: ccB,
        learningCcA,
        learningCcB,
      };
    }

    function notify(): void {
      subscriber?.(snapshotState());
    }

    // Project each event's own `event.timeStamp` onto the audio clock so
    // sequenced notes keep their real inter-note spacing regardless of when
    // the main-thread handler runs. The OLD `Math.max(now + L, now + delta + L)`
    // floor collapsed every note to `currentTime + L` (delta <= 0 because a
    // Web-MIDI handler always runs after the event), so note spacing equalled
    // main-thread dispatch jitter — the dominant audible "swing" when locked
    // to an external clock under heavy main-thread (video) load. The shared
    // scheduler owns the perf↔ctx offset + refresh; see $lib/audio/midi-timing.
    const scheduler = createMidiScheduler(ctx);
    function schedAt(eventTimeStamp: number): number {
      return scheduler.schedAt(eventTimeStamp);
    }

    /** Repaint the mono pitch/gate outputs from the held-keys stack. */
    function applyMono(eventTime: number): void {
      const winner = pickWinner(heldStack, priority);
      if (winner === null) {
        gateSrc.offset.cancelScheduledValues(eventTime);
        gateSrc.offset.setValueAtTime(0, eventTime);
        return;
      }
      const vOct = midiToVOct(winner) + currentBendVOct;
      pitchSrc.offset.cancelScheduledValues(eventTime);
      pitchSrc.offset.setValueAtTime(vOct, eventTime);
      gateSrc.offset.cancelScheduledValues(eventTime);
      gateSrc.offset.setValueAtTime(1, eventTime);
    }

    function applyPitchBendOnly(eventTime: number): void {
      const winner = pickWinner(heldStack, priority);
      if (winner !== null) {
        const vOct = midiToVOct(winner) + currentBendVOct;
        pitchSrc.offset.cancelScheduledValues(eventTime);
        pitchSrc.offset.setValueAtTime(vOct, eventTime);
      }
      // The POLY port always tracks the held chord (see applyPoly) — re-paint
      // every held voice's pitch with the new bend regardless of mode.
      applyPoly(eventTime);
    }

    /** Repaint the dedicated POLY output from the held-keys stack. Sustained
     *  (gates stay high until release).
     *
     *  ALWAYS driven, in BOTH modes. The `poly` port is a distinct, always-
     *  present output: a user who wires it to a poly synth (DX7 /
     *  CUBE) expects "wire poly → hear notes" to work straight away, without
     *  first hunting down a MONO→POLY toggle that is itself hidden until MIDI
     *  is connected. Driving it unconditionally is harmless to the MONO outputs
     *  (separate ConstantSource nodes) and only matters when the POLY port is
     *  actually patched. The `mode` setting now governs ONLY the MONO outputs
     *  (pitch_cv/gate: collapse-to-winner vs. silent) — NOT whether the POLY
     *  port carries signal. (Was: poly only ran in mode='poly', so a freshly-
     *  dropped lane left in its default MONO mode fed silent gates to the poly
     *  synth — the "poly synth produces no audio" bug, #674.) */
    function applyPoly(eventTime: number): void {
      const lanes = buildPolyLanes(heldStack, currentBendVOct);
      poly.scheduleStep(eventTime, lanes, 0);
    }

    function handleMidiMessage(ev: MidiEventLike): void {
      const data = ev.data;
      if (data.length < 1) return;
      const status = data[0]!;
      // Channel filter applies to channel-voice messages (0x80..0xE0).
      if ((status & 0x80) && (status & 0xf0) <= 0xe0) {
        if (!laneChannelMatches(status, channelSet)) return;
      } else if (status >= 0xf0) {
        // System messages — not a lane note/CC. Ignore.
        return;
      }
      const t = schedAt(ev.timeStamp);

      // ---- CC ----
      const cc = parseCc(data);
      if (cc !== null) {
        // Learn mode: capture the next CC# for whichever tap is learning.
        if (learningCcA) {
          ccA = cc.cc;
          learningCcA = false;
        }
        if (learningCcB) {
          ccB = cc.cc;
          learningCcB = false;
        }
        if (ccA !== null && cc.cc === ccA) {
          lastCcA = cc.value;
          ccASrc.offset.cancelScheduledValues(t);
          ccASrc.offset.setValueAtTime(ccToCv(cc.value), t);
        }
        if (ccB !== null && cc.cc === ccB) {
          lastCcB = cc.value;
          ccBSrc.offset.cancelScheduledValues(t);
          ccBSrc.offset.setValueAtTime(ccToCv(cc.value), t);
        }
        notify();
        return;
      }

      // ---- Pitch bend ----
      const bend = parsePitchBend(data);
      if (bend !== null) {
        currentBendVOct = bendToVOct(bend, DEFAULT_BEND_SEMITONES);
        applyPitchBendOnly(t);
        return;
      }

      // ---- Notes ----
      const note = parseNoteEvent(data);
      if (!note || note.note === undefined) return;

      if (note.kind === 'note-on') {
        // by-note-number gate: fire a one-shot pulse on the selected note.
        if (note.note === noteGateNote) {
          noteGateSrc.offset.cancelScheduledValues(t);
          noteGateSrc.offset.setValueAtTime(1, t);
          noteGateSrc.offset.setValueAtTime(0, t + NOTE_GATE_PULSE_S);
        }

        const prevWinner = pickWinner(heldStack, priority);
        heldStack = pushHeld(heldStack, note.note);
        lastNote = note.note;
        lastVelocity = note.velocity ?? 0;
        velSrc.offset.cancelScheduledValues(t);
        velSrc.offset.setValueAtTime(velocityToCv(lastVelocity), t);

        // The POLY port always tracks the held chord (mode-independent — see
        // applyPoly). The `mode` setting only governs the MONO outputs below.
        applyPoly(t);

        if (mode === 'poly') {
          // Poly mode: MONO outputs stay quiet (the poly bus carries the chord).
        } else if (retrig && prevWinner !== null) {
          // Mono retrigger: drop the gate for one block so a downstream
          // ADSR re-fires.
          gateSrc.offset.cancelScheduledValues(t);
          gateSrc.offset.setValueAtTime(0, t);
          gateSrc.offset.setValueAtTime(1, t + 0.003);
          const winner = pickWinner(heldStack, priority);
          if (winner !== null) {
            const vOct = midiToVOct(winner) + currentBendVOct;
            pitchSrc.offset.cancelScheduledValues(t);
            pitchSrc.offset.setValueAtTime(vOct, t);
          }
        } else {
          applyMono(t);
        }
        notify();
        return;
      }

      if (note.kind === 'note-off') {
        heldStack = removeHeld(heldStack, note.note);
        // POLY port always tracks the held chord; MONO outputs only in mono mode.
        applyPoly(t);
        if (mode !== 'poly') applyMono(t);
        notify();
        return;
      }
    }

    /** Listen on EXACTLY the selected device. Re-targeting releases only the
     *  port THIS lane held — it never sweeps the access clearing slots other
     *  subsystems installed (see $lib/midi/input-attach). */
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
      if (access) return true;
      if (!webMidiAvailable()) {
        permissionDenied = true;
        notify();
        return false;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = await (navigator as any).requestMIDIAccess({ sysex: false });
        access = a as MidiAccessLike;
        access.onstatechange = () => {
          if (!selectedDeviceId) {
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

    function panic(): void {
      // Clear held notes + drop gates so a settings change can't strand a
      // gate or poly voice high.
      heldStack = [];
      const t = ctx.currentTime + SCHED_LOOKAHEAD_S;
      gateSrc.offset.cancelScheduledValues(t);
      gateSrc.offset.setValueAtTime(0, t);
      poly.silence(t);
    }

    function setChannels(c: number[] | null): void {
      channelSet = expandLaneChannels(c);
      panic();
      notify();
    }

    function setPriority(p: VoicePriority): void {
      priority = p;
      const winner = pickWinner(heldStack, priority);
      if (winner !== null && mode === 'mono') {
        const t = ctx.currentTime + SCHED_LOOKAHEAD_S;
        const vOct = midiToVOct(winner) + currentBendVOct;
        pitchSrc.offset.cancelScheduledValues(t);
        pitchSrc.offset.setValueAtTime(vOct, t);
      }
      notify();
    }

    function setRetrig(r: boolean): void {
      retrig = r;
      notify();
    }

    function setMode(m: LaneMode): void {
      if (m === mode) return;
      mode = m;
      // Switching modes: clear voices so the inactive output bank goes
      // quiet (poly→mono leaves no stranded poly gates; mono→poly drops
      // the mono gate so only poly speaks).
      panic();
      notify();
    }

    function learnCcA(): void {
      learningCcA = true;
      learningCcB = false; // only learn one at a time
      notify();
    }

    function learnCcB(): void {
      learningCcB = true;
      learningCcA = false;
      notify();
    }

    function setCcA(cc: number | null): void {
      ccA = cc;
      learningCcA = false;
      notify();
    }

    function setCcB(cc: number | null): void {
      ccB = cc;
      learningCcB = false;
      notify();
    }

    function setNoteGateNote(n: number): void {
      noteGateNote = Math.max(0, Math.min(127, Math.round(n)));
      notify();
    }

    const cardApi: MidiLaneApi = {
      connect,
      selectDevice,
      setChannels,
      setPriority,
      setRetrig,
      setMode,
      learnCcA,
      learnCcB,
      setCcA,
      setCcB,
      setNoteGateNote,
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
        ['pitch_cv',    { node: pitchSrc,    output: 0 }],
        ['gate',        { node: gateSrc,     output: 0 }],
        ['velocity_cv', { node: velSrc,      output: 0 }],
        ['cc_a',        { node: ccASrc,      output: 0 }],
        ['cc_b',        { node: ccBSrc,      output: 0 }],
        ['note_gate',   { node: noteGateSrc, output: 0 }],
        ['poly',        { node: poly.output, output: 0 }],
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
        // Release ONLY the port this lane installed a handler on. (Was: null
        // every input on the access — which evicts any other consumer of the
        // same MIDIAccess, and is the shape this seam exists to forbid.)
        claim.detach();
        if (access) {
          access.onstatechange = null;
          access = null;
        }
        subscriber = null;
        for (const s of [pitchSrc, gateSrc, velSrc, ccASrc, ccBSrc, noteGateSrc]) {
          try { s.stop(); } catch { /* */ }
          s.disconnect();
        }
        poly.dispose();
      },
    };
  },
};
