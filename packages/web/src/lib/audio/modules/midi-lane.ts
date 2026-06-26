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
//   reuses verbatim) but channel-aware (multi-select, like HELM), with a
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
//     synth (POLYHELM / DX7 / CUBE) and it just plays, no mode toggle needed.
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
//   removeHeld / SCHED_LOOKAHEAD_S / DEFAULT_BEND_SEMITONES) and the
//   HELM-style multi-channel Set filter (expandChannelSet pattern,
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
import { midiToVOct } from '$lib/audio/note-entry';
import { createPolySender, type PolySender } from '$lib/audio/poly';
import { createMidiScheduler } from '$lib/audio/midi-timing';
import type {
  MidiAccessLike,
  MidiEventLike,
  VoicePriority,
} from './midi-cv-buddy';
import {
  bendToVOct,
  channelMatches,
  DEFAULT_BEND_SEMITONES,
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

/** Returns a Set of channels (0-indexed, 0..15) selected; null = all.
 *  Mirrors HELM's `expandChannelSet` so a lane can collect a subset of
 *  channels — the bass track + any CC automation on the same channel
 *  group, say. Invalid entries are dropped. An empty array collapses to
 *  an empty Set (matches nothing) — distinct from null (matches all). */
export function expandLaneChannels(channels: number[] | null): Set<number> | null {
  if (channels === null) return null;
  const s = new Set<number>();
  for (const c of channels) {
    if (Number.isInteger(c) && c >= 0 && c < 16) s.add(c);
  }
  return s;
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

/** Cap on poly voices the lane allocates (the polyPitchGate carries 5
 *  pitch/gate pairs across 10 channels). */
export const MAX_POLY_VOICES = 5;

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

export const midiLaneDef: AudioModuleDef = {
  type: 'midiLane',
  palette: { top: 'MIDI', sub: 'MIDI' },
  domain: 'audio',
  label: 'midi lane',
  category: 'sources',
  schemaVersion: 1,

  inputs: [],
  outputs: [
    { id: 'pitch_cv',    type: 'cv' },
    { id: 'gate',        type: 'gate' },
    { id: 'velocity_cv', type: 'cv' },
    { id: 'cc_a',        type: 'cv' },
    { id: 'cc_b',        type: 'cv' },
    { id: 'note_gate',   type: 'gate' },
    // Polyphonic chord output. Always declared AND always live: it carries the
    // held chord in BOTH modes, so wiring it to a poly synth (POLYHELM / DX7 /
    // CUBE / cartesian) plays straight away. `mode` only affects the MONO
    // outputs above. (#674: poly used to be silent in the default mono mode.)
    { id: 'poly',        type: 'polyPitchGate' },
  ],
  params: [],

  docs: {
    explanation:
      "A per-channel instrument bus that demuxes ONE MIDI channel (or a small set of channels) out of a hardware sequencer into everything the rack needs to play that track — pitch, gate, velocity, two assignable CC taps, a by-note-number gate, AND a polyphonic chord output. The intended workflow is DAW-style 'one MIDI channel = one instrument': assign each track of an external sequencer (Reliq, Cre8audio Programm, Empress ZOIA, …) to its own MIDI channel, drop one MIDI LANE per instrument, and point each lane at its track's channel. It is the channel-aware successor of MIDI-CV-BUDDY: the mono pitch/gate/velocity behave the same (a voice-priority winner of the held stack), but a multi-select channel filter, a learn-assignable CC bank, a by-note gate, and an always-live poly output are added. The card's `mode` setting governs only the MONO outputs — 'mono' collapses a held chord to one winning note on PITCH/GATE, 'poly' leaves those quiet — while the POLY output carries the whole held chord in BOTH modes. Device, channel set, voice priority, retrigger, mode, CC# assignments and the note# are all discrete card settings saved in the patch (no audio-side knobs). The SAME outputs drive video modules for free via the cross-domain CV/gate bridge.",
    inputs: {},
    outputs: {
      pitch_cv:
        "The winning held note as pitch CV in volts-per-octave (0V = C4 = MIDI 60), with pitch-bend summed in. Driven only when the card's mode is 'mono' (it follows the voice-priority winner of the held stack and latches the last note); in 'poly' mode it stays quiet and you use the POLY output instead.",
      gate:
        "High while any key on this lane's channel(s) is held, with a brief retrigger dip so downstream envelopes re-fire. Driven only in 'mono' mode (it sits low in 'poly' mode). Patch it into an envelope or VCA gate.",
      velocity_cv:
        "How hard the most recent note was struck, as 0..1 CV (MIDI velocity / 127), latched between events. Route it to a VCA level or filter cutoff for velocity dynamics.",
      cc_a:
        "Learn-assignable Continuous-Controller tap A, output as 0..1 CV: it follows whatever MIDI CC number the card has assigned to slot A (e.g. a mod wheel or a track's automation lane on this channel). Wire it to an audio param — or, via the cross-domain bridge, a video param — for hands-on modulation from the external gear.",
      cc_b:
        "Learn-assignable Continuous-Controller tap B, a second independent 0..1 CV tap following its own card-assigned CC number — a second modulation lane alongside cc_a.",
      note_gate:
        "A gate that fires when the SPECIFIC MIDI note number selected on the card arrives on this lane's channel(s) (defaults to GM kick, MIDI 36). It generalizes the per-device drum-router pattern (e.g. the Programm's ch10 by-note triggers) through one configurable port — patch it into a drum voice's strike or any trigger input.",
      poly:
        "A polyphonic pitch+gate bus (up to 10 voices) that ALWAYS carries the full held chord, in both 'mono' and 'poly' modes. Wire it to a poly-aware voice — POLYHELM, DX7, CUBE, or a module with a poly input — and the chord plays straight away with no mode toggle. This is the real polyphonic source chain: MIDI LANE.poly → poly synth produces audible chords (it does not need the mono outputs).",
    },
    controls: {},
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
     *  present output: a user who wires it to a poly synth (POLYHELM / DX7 /
     *  CUBE) expects "wire poly → hear notes" to work straight away, without
     *  first hunting down a MONO→POLY toggle that is itself hidden until MIDI
     *  is connected. Driving it unconditionally is harmless to the MONO outputs
     *  (separate ConstantSource nodes) and only matters when the POLY port is
     *  actually patched. The `mode` setting now governs ONLY the MONO outputs
     *  (pitch_cv/gate: collapse-to-winner vs. silent) — NOT whether the POLY
     *  port carries signal. (Was: poly only ran in mode='poly', so a freshly-
     *  dropped lane left in its default MONO mode fed silent gates to the poly
     *  synth — the "POLYHELM produces no audio" bug, #674.) */
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

    function attachToDevice(deviceId: string | null): void {
      if (!access) return;
      for (const inp of access.inputs.values()) {
        inp.onmidimessage = null;
      }
      if (deviceId === null) return;
      const inp = access.inputs.get(deviceId);
      if (!inp) return;
      inp.onmidimessage = handleMidiMessage;
    }

    function pickDefaultDevice(): string | null {
      if (!access) return null;
      if (selectedDeviceId && access.inputs.has(selectedDeviceId)) return selectedDeviceId;
      const first = access.inputs.values().next();
      if (first.done) return null;
      return first.value.id;
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
        if (access) {
          for (const inp of access.inputs.values()) inp.onmidimessage = null;
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
