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
//   output device — MIDIAccess.outputs picker (persisted by device NAME).
//   channel       — 1..16.
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
import { vOctToMidi, MIN_MIDI, MAX_MIDI } from '$lib/audio/note-entry';
import { getSchedulerClock } from '$lib/audio/scheduler-clock';
import { createRisingEdgeDetector } from './transport-helpers';

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

/** Per-instance persisted data (node.data). Channel + device name. */
export interface MidiOutBuddyData {
  /** 1..16 MIDI channel. */
  channel: number;
  /** Last-used OUTPUT device id (unstable MIDIOutput.id). Restored on
   *  reconnect; the performance bundle keys the stable name off this id. */
  lastDeviceId: string | null;
}

export const DEFAULT_DATA: MidiOutBuddyData = {
  channel: 1,
  lastDeviceId: null,
};

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

// ---------------- Module def ----------------

export const midiOutBuddyDef: AudioModuleDef = {
  type: 'midiOutBuddy',
  palette: { top: 'MIDI', sub: 'MIDI' },
  domain: 'audio',
  label: 'midi cv buddy out',
  category: 'output',
  schemaVersion: 1,

  // CV/gate inputs (audio-rate, tapped by analysers). No outputs — this is a
  // terminal MIDI sink (emits MIDI to external gear, not audio into the graph).
  inputs: [
    { id: 'gate', type: 'gate' },
    { id: 'pitch', type: 'cv' },
    { id: 'velocity', type: 'cv' },
  ],
  outputs: [],
  // No AudioParam knobs — channel + device are discrete and live in node.data.
  params: [],

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

    // ---------------- Saved data ----------------
    const savedData = (node.data ?? {}) as Partial<MidiOutBuddyData>;
    let channel: number = clampChannel(savedData.channel ?? DEFAULT_DATA.channel);
    let selectedDeviceId: string | null = savedData.lastDeviceId ?? DEFAULT_DATA.lastDeviceId;

    // ---------------- Mutable runtime state ----------------
    let access: MidiOutAccessLike | null = null;
    let permissionDenied = false;
    let subscriber: ((s: MidiOutBuddyCardState) => void) | null = null;
    /** Pure tracker holding the currently-sounding note + the byte sequences
     *  to emit on gate transitions (shared with the unit tests). */
    const tracker = createMidiNoteTracker();
    /** Cross-tick last gate level so we also catch a falling edge (the rising
     *  detector only counts rises). */
    let lastGateLevel = 0;
    let lastPollTime = ctx.currentTime;

    function clampChannel(c: number): number {
      return Math.max(1, Math.min(16, Math.round(Number.isFinite(c) ? c : 1)));
    }

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
      if (!webMidiAvailable()) {
        permissionDenied = true;
        notify();
        return false;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = await (navigator as any).requestMIDIAccess({ sysex: false });
        access = a as MidiOutAccessLike;
        access.onstatechange = () => {
          // Re-resolve the saved device; if it vanished, keep the id so it
          // re-attaches when plugged back in, but flush any held note (the
          // NoteOff goes nowhere if the device is gone — that's fine; it stops
          // us tracking a phantom note across a re-plug).
          if (selectedDeviceId && !access?.outputs.has(selectedDeviceId)) {
            safeSendAll(tracker.onGateFall(channel));
          } else if (!selectedDeviceId) {
            selectedDeviceId = pickDefaultDevice();
          }
          notify();
        };
        if (!selectedDeviceId) selectedDeviceId = pickDefaultDevice();
        notify();
        return true;
      } catch {
        permissionDenied = true;
        notify();
        return false;
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
      const next = clampChannel(c);
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
        for (const tap of [gateTap, pitchTap, velTap]) {
          try { tap.silence.stop(); } catch { /* already stopped */ }
          tap.silence.disconnect();
          tap.gain.disconnect();
          tap.analyser.disconnect();
        }
      },
    };
  },
};
