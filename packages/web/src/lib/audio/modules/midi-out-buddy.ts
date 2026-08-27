// packages/web/src/lib/audio/modules/midi-out-buddy.ts
//
// MIDI-OUT-BUDDY (label "MIDI CV BUDDY OUT") — the OUTPUT complement of
// MIDI-CV-BUDDY. Takes CV/gate inputs from the patch and SENDS MIDI notes
// out to a user-selected external MIDI device + channel, so a sequencer /
// envelope / LFO inside the rack can drive a hardware synth.
//
// Inputs (CV/gate):
//   gate     (gate) — rising edge → NoteOn, falling edge → NoteOff.
//   pitch    (cv)   — V/oct (codebase convention 0V = C4 = MIDI 60),
//                     quantized to the nearest semitone for the MIDI note
//                     number. Sampled at the moment of the rising edge.
//   velocity (cv)   — 0..1 CV → MIDI velocity 1..127. Sampled at the rising
//                     edge. (NoteOn velocity 0 is, by spec, a NoteOff, so we
//                     clamp the floor to 1.)
//
// Params (discrete, live on node.data — NOT AudioParams):
//   output device  — MIDIAccess.outputs picker (persisted by device NAME).
//   midiOutChannel — 1..16, INDEPENDENT of the module's lane. Absent = follow
//                    the lane's `data.channel` (so add-to-lane defaults the
//                    MIDI channel to the lane's channel), set = an explicit
//                    override that leaves lane membership + the clip
//                    assignment completely untouched. The card highlights the
//                    module violet while the two differ.
//
// Behavior:
//   * On gate rising edge → send NoteOn [0x90|(ch-1), note, vel].
//   * On gate falling edge → send NoteOff [0x80|(ch-1), heldNote, 0].
//   * The currently-sounding note is TRACKED so the NoteOff targets the note
//     that was actually turned on, even if `pitch` drifted while the gate was
//     held (a slow glide under a held gate must not strand the original note).
//   * No Web MIDI / no device selected → graceful no-op.
//   * Device hot-plug via MIDIAccess.onstatechange (re-resolve the saved
//     device by name).
//   * On dispose AND on device-change we send an all-notes-off (and an
//     explicit NoteOff for any tracked note) so we never strand a stuck note
//     on the external gear.
//
// Bridging (why no worklet):
//   The CV inputs are audio-rate; MIDI send is a main-thread API. We mirror
//   the sequencer's gate-reading pattern: each input is tapped with an
//   AnalyserNode and polled on getSchedulerClock().subscribe(tick). Edge
//   detection + MIDI send happen in the tick. There is NO AudioWorklet here.
//
// Permission UX: like MIDI-CV-BUDDY, we do NOT request MIDI access at module
// instantiation — the card's "Connect MIDI…" button calls connect() once per
// origin. The factory just builds the input taps + reads saved data.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import type { ModuleFace } from '$lib/graph/types';
import { MIDI_CHANNEL_COUNT } from './midi-cv-buddy';
import { vOctToMidi, MIN_MIDI, MAX_MIDI } from '$lib/audio/note-entry';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { createPolyReceiver, POLY_CHANNEL_PAIRS } from '$lib/audio/poly';
import { createRisingEdgeDetector } from './transport-helpers';
import { requestMidiAccess, midiOutcomeMessage } from '$lib/audio/midi-access';

// ---------------- Web MIDI minimal types (output side) ----------------
//
// lib.dom.d.ts ships MIDIOutput, but it can be absent in older toolchains.
// Redeclare the slim shapes we use so the module compiles regardless.

export interface MidiOutputLike {
  id: string;
  name?: string | null;
  manufacturer?: string | null;
  state: string;
  /** Send raw MIDI bytes. timeStamp is optional (immediate when omitted). */
  send(data: number[] | Uint8Array, timestamp?: number): void;
}

export interface MidiOutAccessLike {
  outputs: Map<string, MidiOutputLike>;
  onstatechange: ((ev: { port: MidiOutputLike }) => void) | null;
}

// ---------------- Pure helpers (testable) ----------------

/** Threshold a gate buffer is considered "high" at. Matches the rising-edge
 *  detector default used across the sequencer transport inputs. */
export const GATE_THRESHOLD = 0.5;

/** Quantize a V/oct CV value to the nearest MIDI note number, clamped to the
 *  valid 7-bit MIDI range (and the codebase's supported note span). C4 = 0V =
 *  MIDI 60 per the repo convention (verified against note-entry's vOctToMidi).
 */
export function pitchCvToMidiNote(vOct: number): number {
  if (!Number.isFinite(vOct)) return 60;
  const m = vOctToMidi(vOct); // rounds to nearest semitone, C4 = 60
  // Clamp to the playable note span (also keeps the byte 7-bit-safe).
  return Math.max(0, Math.min(127, Math.max(MIN_MIDI, Math.min(MAX_MIDI, m))));
}

/** Map a 0..1 velocity CV to a MIDI velocity 1..127.
 *  - Values <= 0 clamp to 1 (NoteOn with velocity 0 == NoteOff on the wire,
 *    which we must never emit as a NoteOn).
 *  - Values >= 1 clamp to 127.
 *  - In between: round(cv * 127), floored to 1. */
export function velocityCvToMidi(cv: number): number {
  if (!Number.isFinite(cv)) return 1;
  const scaled = Math.round(Math.max(0, Math.min(1, cv)) * 127);
  return Math.max(1, Math.min(127, scaled));
}

/** Build a NoteOn message for a given 1-based channel. */
export function noteOnBytes(channel1: number, note: number, velocity: number): number[] {
  const ch = Math.max(1, Math.min(16, Math.round(channel1))) - 1;
  return [0x90 | ch, note & 0x7f, velocity & 0x7f];
}

/** Build a NoteOff message for a given 1-based channel (velocity 0). */
export function noteOffBytes(channel1: number, note: number): number[] {
  const ch = Math.max(1, Math.min(16, Math.round(channel1))) - 1;
  return [0x80 | ch, note & 0x7f, 0];
}

/** Build an All-Notes-Off CC (CC 123, value 0) for a given 1-based channel. */
export function allNotesOffBytes(channel1: number): number[] {
  const ch = Math.max(1, Math.min(16, Math.round(channel1))) - 1;
  return [0xb0 | ch, 123, 0];
}

// ---------------- Pure note-tracking state machine ----------------
//
// The factory's tick reads audio-rate buffers; the *decision* of which MIDI
// bytes to emit given a gate transition is pure and lives here so it can be
// unit-tested without an AudioContext or Web MIDI. The tracker holds the
// currently-sounding note and, on a gate transition, returns the exact byte
// messages to send (in order). The caller does the actual `output.send()`.

export interface MidiNoteTracker {
  /** The note currently turned on at the external device, or null. */
  readonly soundingNote: number | null;
  /** Gate rose: send a NoteOn for `note` at `velocity`. If a note is somehow
   *  still sounding (retrigger with no observed fall), close it first so it's
   *  never stranded. Returns the byte messages to send, in order. Updates
   *  `soundingNote` to the new note. */
  onGateRise(channel1: number, note: number, velocity: number): number[][];
  /** Gate fell: send a NoteOff for whatever note is sounding (matched, even if
   *  pitch drifted under the held gate). No-op when nothing is sounding.
   *  Returns the byte messages to send. Clears `soundingNote`. */
  onGateFall(channel1: number): number[][];
  /** Flush: NoteOff the sounding note (if any) + All-Notes-Off on `channel1`.
   *  Used on dispose / device-change / channel-change. Returns the messages. */
  flush(channel1: number): number[][];
}

export function createMidiNoteTracker(): MidiNoteTracker {
  let sounding: number | null = null;
  return {
    get soundingNote() {
      return sounding;
    },
    onGateRise(channel1, note, velocity) {
      const msgs: number[][] = [];
      if (sounding !== null) {
        msgs.push(noteOffBytes(channel1, sounding));
      }
      msgs.push(noteOnBytes(channel1, note, velocity));
      sounding = note;
      return msgs;
    },
    onGateFall(channel1) {
      if (sounding === null) return [];
      const msgs = [noteOffBytes(channel1, sounding)];
      sounding = null;
      return msgs;
    },
    flush(channel1) {
      const msgs: number[][] = [];
      if (sounding !== null) {
        msgs.push(noteOffBytes(channel1, sounding));
        sounding = null;
      }
      msgs.push(allNotesOffBytes(channel1));
      return msgs;
    },
  };
}

// ---------------- Card-readable + saved shapes ----------------

/** Card-visible state exposed via handle.read('state'). */
export interface MidiOutBuddyCardState {
  connected: boolean;
  permissionDenied: boolean;
  /** Human-readable reason the last connect failed ('' when fine). See
   *  $lib/audio/midi-access — a SUPPRESSED prompt used to look identical to a
   *  broken button. */
  accessMessage: string;
  /** OUTPUT devices known to the MIDIAccess (the picker list). */
  devices: Array<{ id: string; name: string; state: string }>;
  /** Currently selected OUTPUT device id, or null when none. */
  selectedDeviceId: string | null;
  /** 1..16. */
  channel: number;
  /** The MIDI note currently sounding on the external device, or null. Drives
   *  the on-card note-activity indicator. */
  activeNote: number | null;
}

/** Per-instance persisted data (node.data). Channel + device name.
 *
 *  CHANNEL OWNERSHIP (the #1168 split — read this before touching either key):
 *  `data.channel` is NOT ours. It is the WORKFLOW CHANNEL-COLUMN membership
 *  scalar (`$lib/graph/channel-columns`: "MEMBERSHIP truth = a scalar on the
 *  member node: data.channel: 1..8"). The column reconciler prunes any node
 *  whose `data.channel !== ch` out of column `ch`'s order array and adopts it
 *  into the column matching the new value — which also re-plans the lane's
 *  clip note-tap edges and re-binds the automation lane. So a card that wrote
 *  `data.channel` to set its MIDI output channel was silently REASSIGNING ITS
 *  LANE (and losing its clip assignment) on every channel change.
 *
 *  The MIDI-out channel therefore lives on its OWN key, `midiOutChannel`, and
 *  this module NEVER writes `data.channel`. Absent/null override = "follow the
 *  lane", which is how add-to-lane still defaults the MIDI channel to the
 *  lane's channel with no write at all. */
export interface MidiOutBuddyData {
  /** LANE / COLUMN membership channel (1..8) — owned by the channel-column
   *  system, READ-ONLY here. It seeds the MIDI-out channel default. */
  channel?: number;
  /** EXPLICIT MIDI output channel override (1..16). null/absent = follow the
   *  lane channel (`channel`), else `DEFAULT_MIDI_OUT_CHANNEL`. This is the
   *  ONLY channel key this module's card writes. */
  midiOutChannel?: number | null;
  /** Last-used OUTPUT device id (unstable MIDIOutput.id). Restored on
   *  reconnect; the performance bundle keys the stable name off this id. */
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

/** MIDI channel used when the module is neither in a lane nor overridden. */
export const DEFAULT_MIDI_OUT_CHANNEL = 1;

export const DEFAULT_DATA: MidiOutBuddyData = {
  midiOutChannel: null,
  lastDeviceId: null,
};

/** Clamp any value to a legal 1..16 MIDI channel. */
export function clampMidiChannel(c: unknown): number {
  const n = typeof c === 'number' && Number.isFinite(c) ? c : DEFAULT_MIDI_OUT_CHANNEL;
  return Math.max(1, Math.min(16, Math.round(n)));
}

/** The lane/column channel this module sits in (`data.channel`), or null when
 *  it is not a column member (free canvas). NEVER written here. */
export function laneChannelOf(data: Partial<MidiOutBuddyData> | undefined | null): number | null {
  const raw = data?.channel;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return clampMidiChannel(raw);
}

/** The user's EXPLICIT channel override, or null when they never set one. */
export function midiOutChannelOverrideOf(
  data: Partial<MidiOutBuddyData> | undefined | null,
): number | null {
  const raw = data?.midiOutChannel;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return clampMidiChannel(raw);
}

/** The channel MIDI is actually SENT on: the explicit override, else the lane
 *  channel (the add-to-lane default), else channel 1. */
export function effectiveMidiOutChannel(
  data: Partial<MidiOutBuddyData> | undefined | null,
): number {
  return midiOutChannelOverrideOf(data) ?? laneChannelOf(data) ?? DEFAULT_MIDI_OUT_CHANNEL;
}

/** True when the module sits in a lane but sends MIDI on a DIFFERENT channel —
 *  the condition the card highlights (violet) so a divergent route is obvious.
 *  False with no lane (nothing to diverge from) and false when the override
 *  happens to equal the lane channel. */
export function isMidiOutChannelOverridden(
  data: Partial<MidiOutBuddyData> | undefined | null,
): boolean {
  const lane = laneChannelOf(data);
  if (lane === null) return false;
  return effectiveMidiOutChannel(data) !== lane;
}

// ---------------- The CHANNEL roster ----------------
//
// Both the legacy card's `<select>` and the faceplate's selector cell offer the
// SAME sixteen choices, built here once so neither surface re-derives them. The
// card used to spell `{#each Array(16)}` and the `i + 1` inline.
//
// ⚠ 1-BASED ON BOTH SIDES HERE, unlike MIDI-CV-BUDDY, and the asymmetry is real
// rather than an inconsistency to tidy. This module's stored `midiOutChannel`
// IS 1..16 — `clampMidiChannel` says so and `effectiveMidiOutChannel` compares
// it directly against a lane number, which is also 1-based — whereas the input
// side stores the 0..15 wire nibble it matches a status byte against. Making
// them agree would mean changing one module's saved shape for symmetry.

/** 1..16, `value` and `label` both the number every piece of gear prints. */
export function midiOutBuddyChannelChoices(): Array<{ value: string; label: string }> {
  return Array.from({ length: MIDI_CHANNEL_COUNT }, (_, i) => ({
    value: String(i + 1),
    label: String(i + 1),
  }));
}

/** The stored channel for a picker value, clamped into 1..16. */
export function channelForChoice(choice: string): number {
  return clampMidiChannel(Number.parseInt(choice, 10));
}

/** Card-callable API surface (engine.read(node, 'card-api')). */
export interface MidiOutBuddyApi {
  /** navigator.requestMIDIAccess() + wire the output picker. Idempotent.
   *  Returns true on success, false when denied / Web MIDI absent. */
  connect(): Promise<boolean>;
  selectDevice(deviceId: string | null): void;
  setChannel(channel: number): void;
  getState(): MidiOutBuddyCardState;
  subscribe(cb: (s: MidiOutBuddyCardState) => void): () => void;
}

/** True when running in a browser with Web MIDI available. */
export function webMidiAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess === 'function'
  );
}

// ---------------- The FACEPLATE ----------------
//
// WHAT THIS MODULE IS FOR, MUSICALLY. It is the one module that points the
// rack OUTWARDS: a gate and a pitch from anywhere inside — a sequencer, a clip
// lane, an envelope — become MIDI notes on a hardware synth in the room. Every
// other note-sink in the fleet makes sound in the browser; this one makes
// something else make sound. The verb is "play the gear on the desk from the
// patch on the screen".
//
// ⚠ IT IS A ZERO-PARAM FACE. `params: []`, so both controls arrive as
// `controlFamilies` + `SHELL_CELLS` entries over `node.data`. `order: []` would
// have been legal and would have painted a blank tile, which is worse than the
// placeholder it replaces (the matrixMix lesson).
//
// THE TIER LADDER, read back as a sentence: the mini tile shows CONNECT,
// because without the browser's Web MIDI grant there is no output port to send
// to and every note this module computes goes nowhere; the compact tile adds
// CHANNEL, because a synth listening on channel 1 while the rack sends on 10 is
// the single most common way for this module to look broken while working
// perfectly. There is nothing below those two — the device picker is the only
// other affordance and it cannot be a cell.
//
// ⚠ ONE PAGE, AND IT IS NOT PADDED TOWARD MORE. Two cells is one idea — put
// these notes on that instrument — and `DOCK_TAB_MIN_BANDS` is 7, so the rail
// never enters the question. A second page here would be a header hunting for
// content, which this module does not have.
export const MIDI_OUT_BUDDY_FACE: ModuleFace = {
  // ⚠ MECHANICALLY FORCED, and by the strongest form of the argument in the
  // fleet: `glyphBinding` reaches a live trace through `primaryAudioOutPortId`,
  // which matches `type === 'audio'` EXACTLY, and this module declares
  // `outputs: []` — it is a TERMINAL MIDI SINK, so there is not merely no audio
  // port, there is no port at all. Any other glyph value falls through to
  // `{kind:'static'}`, the dead binding module-face-lint reddens. Same
  // situation as push2Control, for the same reason.
  glyph: 'none',
  // The OUTPUT-PORT ROSTER is the one affordance here that cannot be a cell: it
  // lives on the engine handle behind `requestMIDIAccess()` and differs on
  // every machine, so it is neither a `ParamDef` nor an `options` roster (a
  // roster is a fixed set known when the def is authored). See the extension.
  extension: 'midiOutBuddy',
  order: [
    'midi-out-buddy-connect-{n}',
    'midi-out-buddy-channel-{n}',
  ],
  pages: [
    {
      // ⚠ `send`, NOT `voice` or `signal` — the dx7 double-band scar.
      // `rearFieldPlan` derives a LEADING `voice`/`signal` section for a module
      // whose ports carry gate/poly/pitch drive, and all four of this module's
      // inputs do; a page with that id renders a SECOND band with the same
      // name.
      id: 'send',
      label: 'send',
      hint:
        'Web MIDI needs the browser\'s consent before any output port is even visible, and until '
        + 'it is granted every note this module computes goes nowhere. Then pick the channel the '
        + 'synth on the other end is listening on: a mismatch here is silent rather than wrong, '
        + 'which is the hardest kind of fault to spot. Dropped into a workflow lane the channel '
        + 'DEFAULTS to that lane\'s number and changing it re-routes the MIDI only — the module '
        + 'stays in its lane with its clip assignment intact.',
      controls: ['midi-out-buddy-connect-{n}', 'midi-out-buddy-channel-{n}'],
    },
  ],
};

// ---------------- Module def ----------------

export const midiOutBuddyDef: AudioModuleDef = {
  type: 'midiOutBuddy',
  palette: { top: 'MIDI', sub: 'MIDI' },
  domain: 'audio',
  label: 'midi cv buddy out',
  category: 'output',

  // CV/gate inputs (audio-rate, tapped by analysers). No outputs — this is a
  // terminal MIDI sink (emits MIDI to external gear, not audio into the graph).
  inputs: [
    // POLY note bus — the preferred input, and the ONLY one that can carry a
    // chord. Each of the 16 lanes has its own pitch + gate, so a 4-note column
    // out of a POLY clip lane becomes 4 simultaneous MIDI notes. Before this
    // port existed the module had only the mono trio below, and a poly source
    // patched into `pitch` collapsed to lane 0 (`polyPitchGate → cv` pulls
    // channel 0) — so a 4-note drum column sent exactly ONE note (owner report,
    // 2026-08-06).
    { id: 'poly', type: 'polyPitchGate' },
    { id: 'gate', type: 'gate', edge: 'gate' },
    { id: 'pitch', type: 'cv' },
    { id: 'velocity', type: 'cv' },
  ],
  outputs: [],
  // No AudioParam knobs — channel + device are discrete and live in node.data.
  params: [],

  face: MIDI_OUT_BUDDY_FACE,

  // ⚠ TWO FAMILIES FOR TWO CELLS, AND THE COUNT IS FORCED BY THE RESOLVER.
  // `resolveFaceControl` resolves a face key to a PARAM id, a family TEMPLATE
  // (`<id>-{n}`) or a legend STATIC — and this module declares `params: []`, so
  // both of its controls have to arrive as families. Each has a real control on
  // the legacy card carrying the same `testidPrefix`, which is what
  // `module-docs-lint`'s card-drift leg checks.
  controlFamilies: [
    { id: 'midi-out-buddy-connect', label: 'Connect MIDI', kind: 'other', testidPrefix: 'midi-out-buddy-connect' },
    { id: 'midi-out-buddy-channel', label: 'Channel',      kind: 'other', testidPrefix: 'midi-out-buddy-channel' },
  ],

  // Declarative lane-tap marker (INERT in Part A — consumed by the Part-B tap
  // planner). MIDI-OUT-BUDDY is a lane note-sink like CV Buddy: a dropped clip
  // lane can tap its pitch/gate/velocity into these inputs. See ChainWiring.
  // The lane tap targets the POLY bus, not the mono `pitch` port: a clip lane
  // set to POLY emits a whole chord on `pitch{n}`, and a mono target collapses
  // it to lane 0 (one note out of four — the owner's drum-trigger report).
  // `gate`/`velocity` stay mono; the module's poly-precedence rule keeps the
  // mono gate from double-triggering (see the tick).
  chainWiring: { role: 'noteSink', laneTap: { pitchIn: 'poly', gateIn: 'gate', velIn: 'velocity' } },

  docs: {
    explanation:
      "The OUTPUT complement of MIDI-CV-BUDDY: it reads gate / pitch / velocity CV from inside the rack and SENDS MIDI notes out to a hardware synth on a chosen device + channel. Mental model: anything in the rack that produces a gate and a pitch — a SEQUENCER, an envelope, an LFO-driven gate — can now play an external instrument. On each rising edge of GATE it sends a MIDI Note On using the pitch + velocity sampled at that instant; on the falling edge it sends Note Off for whatever note it actually started, so a glide under a held gate never strands the wrong note. The output device and MIDI channel are discrete card settings saved in the patch (no audio-side knobs), and Web MIDI permission is requested only when you click Connect. Dropped into a workflow channel lane, CH DEFAULTS to that lane's channel — but it is an INDEPENDENT setting: changing it re-routes the MIDI only, leaving the module in its lane with its clip assignment intact, and the card turns violet with a CH ≠ LANE badge while the two differ (set CH back to the lane's number to follow it again). It defends against stuck notes: on dispose and on a device change it sends an all-notes-off plus an explicit Note Off for any tracked note.",
    inputs: {
      poly:
        "The POLYPHONIC note input and the preferred way to drive this module: the 16-lane polyPitchGate cable (a pitch AND a gate per lane) from a POLY clip lane, POLYSEQZ, MIDI LANE or another poly source. Every gated lane becomes its OWN MIDI note, so a 4-note chord column sends four simultaneous Note Ons — each tracked independently, so releasing one voice sends only that voice's Note Off. Velocity for every poly voice comes from the VELOCITY input (the poly cable carries no velocity). While ANY poly lane is gated the mono GATE input below is ignored, so a clip lane that patches both (the standard auto-wiring) never double-triggers.",
      gate:
        "The MONO note trigger, for a one-voice source: a rising edge sends a MIDI Note On (sampling PITCH and VELOCITY at that instant), and the following falling edge sends the matching Note Off. Patch a SEQUENCER's gate or an envelope's gate here to drive notes out to the external synth. Ignored while the POLY input has any gated lane (poly takes precedence).",
      pitch:
        "The note pitch as 1V/octave CV (0V = C4 = MIDI 60), quantized to the nearest semitone to pick the MIDI note number. It is sampled at the moment of the gate's rising edge, so the note that gets sent is whatever pitch was present when the gate opened (later drift under a held gate doesn't re-trigger).",
      velocity:
        "How hard to strike the outgoing note, as 0..1 CV mapped to MIDI velocity 1..127 (the floor is clamped to 1 because a Note On with velocity 0 is, by spec, a Note Off). Sampled at the rising edge alongside pitch; leave it unpatched for a default level.",
    },
    outputs: {},
    controls: {
      'midi-out-buddy-connect-{n}':
        "The one-time-per-origin permission gesture. Web MIDI needs the browser's consent before any output port is even visible, so until it is granted this module still watches its inputs and computes notes but has nowhere to send them — it is inert in the way that looks exactly like broken. It reaches the same request every MIDI module in the rack shares, which always yields a nameable outcome: granted, refused, unsupported, or the quiet case where the browser suppressed its own prompt without telling anyone. Once access is granted the dock's device body lists the OUTPUT ports it found and remembers the one you pick, so a reloaded patch re-attaches to the same synth without another click.",
      'midi-out-buddy-channel-{n}':
        "Which MIDI channel the notes are SENT on, 1..16 as every synth prints it on its own front panel. Set it to whatever the instrument on the other end is listening to; a mismatch produces perfect silence with everything else working, which is this module's most common apparent fault. Dropped into a workflow channel lane it DEFAULTS to that lane's number, so the usual case needs no setting at all — and it is an INDEPENDENT key from lane membership, so changing it re-routes the MIDI only and leaves the module in its lane with its clip assignment intact. While the two differ the module says so, and setting it back to the lane's number makes it follow the lane again.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // ---------------- Input taps (gate / pitch / velocity) ----------------
    //
    // Each input is a GainNode → AnalyserNode tap kept alive by a silent
    // ConstantSource (same trick transport-cv / score use), so the analyser
    // reports a real time-domain buffer even when nothing is patched in yet.
    function makeTap() {
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      gain.connect(analyser);
      const silence = ctx.createConstantSource();
      silence.offset.value = 0;
      silence.start();
      silence.connect(gain);
      return { gain, analyser, silence, buf: new Float32Array(2048) };
    }
    const gateTap = makeTap();
    const pitchTap = makeTap();
    const velTap = makeTap();
    const gateEdge = createRisingEdgeDetector(GATE_THRESHOLD);

    // ---------------- POLY note bus (polyPitchGate) ----------------
    //
    // One INDEPENDENT note tracker per voice lane: a chord's voices start and
    // stop on their own gates, so releasing one voice must send only that
    // voice's Note Off. Each lane taps the splitter through the SAME
    // gain→analyser+silent-source rig the mono inputs use, so the poll is the
    // identical code path (and reads real zeros while unpatched).
    const polyRx = createPolyReceiver(ctx);
    const polyLanes = Array.from({ length: POLY_CHANNEL_PAIRS }, (_, lane) => {
      const gate = makeTap();
      const pitch = makeTap();
      const g = polyRx.laneOutput(lane, 'gate');
      const p = polyRx.laneOutput(lane, 'pitch');
      g.node.connect(gate.gain, g.output);
      p.node.connect(pitch.gain, p.output);
      return {
        gate,
        pitch,
        tracker: createMidiNoteTracker(),
        edge: createRisingEdgeDetector(GATE_THRESHOLD),
        lastLevel: 0,
      };
    });

    // ---------------- Saved data ----------------
    // The MIDI-out channel is DERIVED, never a second copy of the lane scalar:
    // explicit `midiOutChannel` override → else the lane's `data.channel` (the
    // add-to-lane default) → else 1. See MidiOutBuddyData for why the two keys
    // must stay separate.
    const savedData = (node.data ?? {}) as Partial<MidiOutBuddyData>;
    let channel: number = effectiveMidiOutChannel(savedData);
    let selectedDeviceId: string | null = savedData.lastDeviceId ?? DEFAULT_DATA.lastDeviceId;

    // ---------------- Mutable runtime state ----------------
    let access: MidiOutAccessLike | null = null;
    let permissionDenied = false;
    let accessMessage = '';
    let subscriber: ((s: MidiOutBuddyCardState) => void) | null = null;
    /** Pure tracker holding the currently-sounding note + the byte sequences
     *  to emit on gate transitions (shared with the unit tests). */
    const tracker = createMidiNoteTracker();
    /** Cross-tick last gate level so we also catch a falling edge (the rising
     *  detector only counts rises). */
    let lastGateLevel = 0;
    let lastPollTime = ctx.currentTime;

    function out(): MidiOutputLike | null {
      if (!access || selectedDeviceId === null) return null;
      return access.outputs.get(selectedDeviceId) ?? null;
    }

    function safeSend(bytes: number[]): void {
      const o = out();
      if (!o) return;
      try {
        o.send(bytes);
      } catch (err) {
        console.error('[midi-out-buddy] send failed', err);
      }
    }

    /** Send a list of byte messages (in order) to the selected output. */
    function safeSendAll(messages: number[][]): void {
      for (const m of messages) safeSend(m);
    }

    /** Read the most recent sample value from a tap's analyser buffer. */
    function latestSample(tap: ReturnType<typeof makeTap>): number {
      tap.analyser.getFloatTimeDomainData(tap.buf as Float32Array<ArrayBuffer>);
      return tap.buf[tap.buf.length - 1] ?? 0;
    }

    /** Turn off any sounding note + flush all-notes-off (used on dispose /
     *  device change / channel change so external gear never strands a note). */
    function panic(): void {
      safeSendAll(tracker.flush(channel));
      // Every poly voice too — a chord must never strand notes on a device
      // change / channel change / dispose.
      for (const ln of polyLanes) safeSendAll(ln.tracker.flush(channel));
    }

    function snapshotState(): MidiOutBuddyCardState {
      const devices: MidiOutBuddyCardState['devices'] = [];
      if (access) {
        for (const [id, o] of access.outputs) {
          devices.push({ id, name: o.name ?? id, state: o.state });
        }
      }
      return {
        connected: access !== null,
        permissionDenied,
        accessMessage,
        devices,
        selectedDeviceId,
        channel,
        activeNote: tracker.soundingNote,
      };
    }

    function notify(): void {
      subscriber?.(snapshotState());
    }

    // ---------------- The tick: edge detection + MIDI send ----------------
    function tick(): void {
      try {
        const now = ctx.currentTime;
        const elapsed = now - lastPollTime;
        lastPollTime = now;

        gateTap.analyser.getFloatTimeDomainData(gateTap.buf as Float32Array<ArrayBuffer>);
        const newSamples = Math.min(
          gateTap.buf.length,
          Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
        );
        const start = gateTap.buf.length - newSamples;

        // ---- POLY lanes first: each is its own voice, and any gated lane
        // SUPPRESSES the mono path below (the documented poly/mono precedence
        // that lets a clip lane wire both without double-triggering — see
        // resolveClipWiring). Velocity is shared: the poly cable has none.
        let polyActive = false;
        for (const ln of polyLanes) {
          ln.gate.analyser.getFloatTimeDomainData(ln.gate.buf as Float32Array<ArrayBuffer>);
          const rises = ln.edge.scan(ln.gate.buf, start, ln.gate.buf.length);
          let fell = false;
          let prev = ln.lastLevel;
          for (let i = start; i < ln.gate.buf.length; i++) {
            const cur = ln.gate.buf[i] ?? 0;
            if (prev >= GATE_THRESHOLD && cur < GATE_THRESHOLD) fell = true;
            prev = cur;
          }
          ln.lastLevel = prev;
          const high = ln.lastLevel >= GATE_THRESHOLD;
          // ANY activity on the cable this tick — a level, a rise, or a fall —
          // means the poly bus owns the output, so the mono path below is
          // skipped. Keyed on the pulse, not just the end level: a trigger that
          // rose AND fell inside one poll would otherwise leave polyActive
          // false and let the mono gate fire the same hit a second time.
          if (high || rises > 0 || fell) polyActive = true;
          if (rises > 0) {
            const note = pitchCvToMidiNote(latestSample(ln.pitch));
            const vel = velocityCvToMidi(latestSample(velTap));
            safeSendAll(ln.tracker.onGateRise(channel, note, vel));
            // A pulse SHORTER than the ~25 ms scheduler tick rises and falls
            // inside this one window, so it ends low with no fall left to
            // observe next tick. Close it here or the Note On hangs on the
            // external device until the next rise — and a DRUM TRIGGER (this
            // module's headline use case) is exactly that short pulse.
            if (!high) safeSendAll(ln.tracker.onGateFall(channel));
          } else if (fell && ln.tracker.soundingNote !== null) {
            safeSendAll(ln.tracker.onGateFall(channel));
          }
        }
        if (polyActive) {
          // A poly chord owns the output this tick. Release any note the MONO
          // path is still holding so it can't hang under the chord, and skip
          // the mono edge logic entirely.
          if (tracker.soundingNote !== null) safeSendAll(tracker.onGateFall(channel));
          // Keep the mono level tracker in step so the first tick after the
          // chord ends doesn't read a stale edge.
          gateTap.analyser.getFloatTimeDomainData(gateTap.buf as Float32Array<ArrayBuffer>);
          lastGateLevel = gateTap.buf[gateTap.buf.length - 1] ?? 0;
          notify();
          return;
        }

        // Rising edges → NoteOn. Use the detector for accurate cross-tick rise
        // counting; for each rise, snapshot pitch + velocity at that instant.
        const rises = gateEdge.scan(gateTap.buf, start, gateTap.buf.length);

        // Falling-edge detection (the rising detector doesn't report these):
        // scan the same new-sample window for a high→low crossing.
        let fell = false;
        let prev = lastGateLevel;
        for (let i = start; i < gateTap.buf.length; i++) {
          const cur = gateTap.buf[i] ?? 0;
          if (prev >= GATE_THRESHOLD && cur < GATE_THRESHOLD) fell = true;
          prev = cur;
        }
        lastGateLevel = prev;

        // Order matters within a tick: if both a rise and a fall happened in
        // this window (a full pulse shorter than TICK_MS), the END state of the
        // gate is what `prev` reports. Resolve to the final state:
        //   - net rise (ends high): ensure a note is on for the latest pitch.
        //   - net fall (ends low): ensure the sounding note is off.
        if (rises > 0 && lastGateLevel >= GATE_THRESHOLD) {
          // New note-on. The tracker closes any still-sounding note first
          // (retrigger without an observed fall) so it's never stranded.
          const note = pitchCvToMidiNote(latestSample(pitchTap));
          const vel = velocityCvToMidi(latestSample(velTap));
          safeSendAll(tracker.onGateRise(channel, note, vel));
          notify();
        } else if ((fell || rises > 0) && lastGateLevel < GATE_THRESHOLD) {
          // Net fall (or a complete pulse that ended low) → NoteOff of the
          // note that was actually turned on (matched even if pitch drifted).
          if (tracker.soundingNote !== null) {
            safeSendAll(tracker.onGateFall(channel));
            notify();
          }
        }
      } catch (err) {
        console.error('[midi-out-buddy] tick error', err);
      }
    }
    const unsubscribeTick = getSchedulerClock().subscribe(tick);

    // ---------------- Device selection / hot-plug ----------------
    function pickDefaultDevice(): string | null {
      if (!access) return null;
      if (selectedDeviceId && access.outputs.has(selectedDeviceId)) return selectedDeviceId;
      const first = access.outputs.values().next();
      if (first.done) return null;
      return (first.value as MidiOutputLike).id;
    }

    async function connect(): Promise<boolean> {
      if (access) return true;
      const outcome = await requestMidiAccess({
        onLateResolve: (a) => { adoptAccess(a as unknown as MidiOutAccessLike); },
      });
      if (outcome.kind !== 'granted') {
        permissionDenied = outcome.kind === 'denied' || outcome.kind === 'unsupported';
        accessMessage = midiOutcomeMessage(outcome);
        notify();
        return false;
      }
      accessMessage = '';
      adoptAccess(outcome.access as unknown as MidiOutAccessLike);
      return true;
    }

    /** Wire a freshly-granted access. Shared by connect() and the LATE-grant
     *  path so a slow answer takes the identical route. */
    function adoptAccess(a: MidiOutAccessLike): void {
      try {
        access = a;
        access.onstatechange = () => {
          // Re-resolve the saved device; if it vanished, keep the id so it
          // re-attaches when plugged back in, but flush any held note (the
          // NoteOff goes nowhere if the device is gone — that's fine; it stops
          // us tracking a phantom note across a re-plug).
          if (selectedDeviceId && !access?.outputs.has(selectedDeviceId)) {
            // panic() clears the mono tracker AND every poly voice. The sends
            // go nowhere (the device is gone) — the point is that no tracker is
            // left believing it holds a note, which would suppress the next
            // Note On for that voice when the device comes back.
            panic();
          } else if (!selectedDeviceId) {
            selectedDeviceId = pickDefaultDevice();
          }
          notify();
        };
        if (!selectedDeviceId) selectedDeviceId = pickDefaultDevice();
        permissionDenied = false;
        accessMessage = '';
        notify();
      } catch (err) {
        permissionDenied = true;
        accessMessage = `MIDI device setup failed: ${(err as Error).message}`;
        notify();
      }
    }

    function selectDevice(deviceId: string | null): void {
      if (deviceId === selectedDeviceId) return;
      // Flush the note on the OLD device before switching, so we don't strand
      // a held note on gear we're about to stop addressing.
      panic();
      selectedDeviceId = deviceId;
      notify();
    }

    function setChannel(c: number): void {
      const next = clampMidiChannel(c);
      if (next === channel) return;
      // Flush on the old channel so a held note isn't stranded there.
      panic();
      channel = next;
      notify();
    }

    const cardApi: MidiOutBuddyApi = {
      connect,
      selectDevice,
      setChannel,
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
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['poly', { node: polyRx.input, input: 0 }],
        ['gate', { node: gateTap.gain, input: 0 }],
        ['pitch', { node: pitchTap.gain, input: 0 }],
        ['velocity', { node: velTap.gain, input: 0 }],
      ]),
      outputs: new Map(),
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
        // All-notes-off + matched note-off BEFORE tearing down, so external
        // gear is never left with a stuck note.
        panic();
        unsubscribeTick();
        if (access) {
          access.onstatechange = null;
          access = null;
        }
        subscriber = null;
        const polyTaps = polyLanes.flatMap((ln) => [ln.gate, ln.pitch]);
        for (const tap of [gateTap, pitchTap, velTap, ...polyTaps]) {
          try { tap.silence.stop(); } catch { /* already stopped */ }
          tap.silence.disconnect();
          tap.gain.disconnect();
          tap.analyser.disconnect();
        }
        polyRx.dispose();
      },
    };
  },
};
