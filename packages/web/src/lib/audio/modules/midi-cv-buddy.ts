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
import { midiToVOct } from '$lib/audio/note-entry';
import { createMidiScheduler } from '$lib/audio/midi-timing';

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
}

/** Saved per-instance data on the patch node. Lives under
 *  `node.data` (the engine reads `node.params` for AudioParams; this
 *  shape is for non-numeric state). */
export interface MidiCvBuddyData {
  /** Channel filter: 0..15 or null for "all". */
  channel: number | null;
  priority: VoicePriority;
  /** When true, momentary key changes drop the gate to 0 for one block
   *  before re-rising. When false, the gate stays high through legato
   *  changes (only falls when all keys release). */
  retrig: boolean;
  /** Last-used device id; restored on reconnect so the user doesn't have
   *  to pick again if the controller is plugged back in. */
  lastDeviceId: string | null;
}

export const DEFAULT_DATA: MidiCvBuddyData = {
  channel: null,
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

export const midiCvBuddyDef: AudioModuleDef = {
  type: 'midiCvBuddy',
  palette: { top: 'MIDI', sub: 'MIDI' },
  domain: 'audio',
  label: 'midi-cv-buddy',
  category: 'sources',
  schemaVersion: 1,

  // No audio inputs — MIDI source is external (the device).
  inputs: [],
  outputs: [
    { id: 'pitch_cv',    type: 'cv' },
    { id: 'gate',        type: 'gate' },
    { id: 'velocity_cv', type: 'cv' },
  ],
  // No knob params — all settings are dropdown/toggle on the card and live
  // in node.data. (Channel selector + voice priority + retrig are discrete,
  // not continuous, so they don't fit the AudioParam shape.)
  params: [],

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
    let channel: number | null = savedData.channel ?? DEFAULT_DATA.channel;
    let priority: VoicePriority = savedData.priority ?? DEFAULT_DATA.priority;
    let retrig: boolean = savedData.retrig ?? DEFAULT_DATA.retrig;
    let selectedDeviceId: string | null = savedData.lastDeviceId ?? DEFAULT_DATA.lastDeviceId;

    // ---------------- Internal mutable state ----------------
    let heldStack: number[] = [];
    let currentBendVOct = 0;
    let lastNote: number | null = null;
    let lastVelocity = 0;
    let access: MidiAccessLike | null = null;
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

    function attachToDevice(deviceId: string | null): void {
      if (!access) return;
      // Detach handlers from everything first; we only listen on the chosen device.
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
      // Restore saved device id if it's still around.
      if (selectedDeviceId && access.inputs.has(selectedDeviceId)) return selectedDeviceId;
      // Otherwise pick the first available input.
      const first = access.inputs.values().next();
      if (first.done) return null;
      return first.value.id;
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
        // Detach MIDI handlers before tearing down audio nodes.
        if (access) {
          for (const inp of access.inputs.values()) inp.onmidimessage = null;
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
