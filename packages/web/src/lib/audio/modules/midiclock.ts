// packages/web/src/lib/audio/modules/midiclock.ts
//
// MIDICLOCK — bridges a hardware MIDI device's TRANSPORT into the patch.
// Sibling to MIDI-CV-BUDDY (which handles note/velocity per channel);
// MIDICLOCK is transport-only:
//
//   clock     — gate. Rising edge every N MIDI clock ticks. MIDI is fixed
//               at 24 PPQN, so N=24 → one edge per quarter note (TIMELORDE
//               compatible — patch MIDICLOCK.clock → TIMELORDE.clock to
//               slave TimeLorde to the external transport). Other values:
//               12=eighth, 6=sixteenth, 3=32nd, 1=raw 24 PPQN.
//   run       — cv. 0 while transport stopped, 1 while running.
//   midistart — gate. One-shot rising edge on MIDI Start (0xFA).
//   midistop  — gate. One-shot rising edge on MIDI Stop (0xFC).
//
// MIDI Continue (0xFB) raises `run` to 1 but does NOT fire midistart;
// Continue exists precisely to resume without re-zeroing downstream
// loops, so a midistart pulse would lie about intent.
//
// Implementation parallels midi-cv-buddy: one ConstantSourceNode per
// output, main-thread event handler, setValueAtTime with the shared
// SCHED_LOOKAHEAD_S so edges land at the start of the next audio block.
//
// Inputs: none. MIDI source is the host device, picked from a dropdown on the card.
//
// Outputs:
//   clock (gate): rising edge every N MIDI clock ticks (N set by user; 24 = quarter, 12 = eighth, etc).
//   run (cv): 0 while transport stopped, 1 while running (latched on MIDI Continue too).
//   midistart (gate): one-shot pulse on MIDI Start (0xFA).
//   midistop (gate): one-shot pulse on MIDI Stop (0xFC).
//
// Params: none on the audio-side — UI device-picker + division are persisted in node.data.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import {
  webMidiAvailable,
  type MidiAccessLike,
  type MidiEventLike,
} from './midi-cv-buddy';
// Timestamp-projection scheduling lives in ONE shared place so all three MIDI
// bridges (MIDICLOCK, MIDI-CV-BUDDY, MIDI LANE) use the same proven math and it
// can't silently drift into "fixed in 1 of 3" again (the original root cause of
// note-jitter under load). See packages/web/src/lib/audio/midi-timing.ts.
import { createMidiScheduler } from '$lib/audio/midi-timing';
// Re-exported for callers/tests that historically imported these from midiclock.
export {
  MIDI_PPQN,
  TIMESTAMP_LOOKAHEAD_S,
  MAX_TIMESTAMP_LAG_MS,
  measureCtxOffset,
  eventTimeStampToAudioTime,
} from '$lib/audio/midi-timing';

// ---------------- MIDI System Real-Time status bytes ----------------
const STATUS_CLOCK = 0xf8;
const STATUS_START = 0xfa;
const STATUS_CONT  = 0xfb;
const STATUS_STOP  = 0xfc;

/** One-shot gate-pulse width. Wide enough that downstream gate-input
 *  modules audio-block-align onto a clean rising edge; narrow enough
 *  that raw-mode (N=1) ticks at 240 BPM (≈ 10 ms between) still produce
 *  a falling edge between adjacent pulses. */
export const GATE_PULSE_S = 0.005;

// ---------------- Pure helpers (testable) ----------------

/** True if a MIDI status byte is a System Real-Time message (0xF8..0xFF).
 *  Channel filtering does NOT apply to these — they're broadcast. */
export function isSystemRealTime(status: number): boolean {
  return status >= 0xf8 && status <= 0xff;
}

/** Allowed clock-divisor values (input MIDI ticks per output edge).
 *  24=quarter (TIMELORDE-compatible), 12=eighth, 6=sixteenth, 3=32nd,
 *  1=raw 24 PPQN. */
export const CLOCK_DIVISORS = [24, 12, 6, 3, 1] as const;
export type ClockDivisor = (typeof CLOCK_DIVISORS)[number];

export function isValidDivisor(n: unknown): n is ClockDivisor {
  return typeof n === 'number' && (CLOCK_DIVISORS as readonly number[]).includes(n);
}

/** Display label for a divisor — used by the card's select. */
export function divisorLabel(d: ClockDivisor): string {
  if (d === 24) return '1/4';
  if (d === 12) return '1/8';
  if (d === 6)  return '1/16';
  if (d === 3)  return '1/32';
  return 'raw';
}

// ---------------- Tempo-stability helpers ----------------
//
// The timestamp-projection scheduling (measureCtxOffset /
// eventTimeStampToAudioTime / createMidiScheduler) now lives in the shared
// $lib/audio/midi-timing module so MIDICLOCK, MIDI-CV-BUDDY and MIDI LANE all
// use one proven implementation. The pure helpers are re-exported from this
// module (see the export block above) for back-compat with existing importers.
//
// NOTE: the projection constants/helpers that used to live here were hoisted
// verbatim into $lib/audio/midi-timing.ts and are re-exported above.

// ---------------- Card-visible state + saved data ----------------

export interface MidiclockCardState {
  connected: boolean;
  permissionDenied: boolean;
  devices: Array<{ id: string; name: string; state: string }>;
  selectedDeviceId: string | null;
  running: boolean;
  divisor: ClockDivisor;
  /** Total clock ticks observed since the last successful Connect.
   *  Card uses this to paint a live activity indicator. */
  ticksReceived: number;
}

export interface MidiclockData {
  divisor: ClockDivisor;
  /** Restored on reconnect so the user doesn't have to re-pick. */
  lastDeviceId: string | null;
}

export const DEFAULT_DATA: MidiclockData = {
  divisor: 24,
  lastDeviceId: null,
};

export interface MidiclockApi {
  connect(): Promise<boolean>;
  selectDevice(deviceId: string | null): void;
  setDivisor(d: ClockDivisor): void;
  getState(): MidiclockCardState;
  subscribe(cb: (s: MidiclockCardState) => void): () => void;
}

// ---------------- Module def ----------------

export const midiclockDef: AudioModuleDef = {
  type: 'midiclock',
  palette: { top: 'MIDI', sub: 'MIDI' },
  domain: 'audio',
  label: 'midiclock',
  category: 'sources',
  schemaVersion: 1,

  inputs: [],
  outputs: [
    { id: 'clock',     type: 'gate' },
    { id: 'run',       type: 'cv'   },
    { id: 'midistart', type: 'gate' },
    { id: 'midistop',  type: 'gate' },
  ],
  params: [],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    // Four ConstantSource outputs, all starting at 0.
    const clockSrc = ctx.createConstantSource(); clockSrc.offset.value = 0; clockSrc.start();
    const runSrc   = ctx.createConstantSource(); runSrc.offset.value   = 0; runSrc.start();
    const startSrc = ctx.createConstantSource(); startSrc.offset.value = 0; startSrc.start();
    const stopSrc  = ctx.createConstantSource(); stopSrc.offset.value  = 0; stopSrc.start();

    const savedData = (node.data ?? {}) as Partial<MidiclockData>;
    let divisor: ClockDivisor = isValidDivisor(savedData.divisor)
      ? savedData.divisor
      : DEFAULT_DATA.divisor;
    let selectedDeviceId: string | null = savedData.lastDeviceId ?? DEFAULT_DATA.lastDeviceId;

    let access: MidiAccessLike | null = null;
    let permissionDenied = false;
    let subscriber: ((s: MidiclockCardState) => void) | null = null;

    let tickCounter = 0;
    let ticksReceived = 0;
    let running = false;

    function snapshotState(): MidiclockCardState {
      const devices: MidiclockCardState['devices'] = [];
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
        running,
        divisor,
        ticksReceived,
      };
    }

    function notify(): void {
      subscriber?.(snapshotState());
    }

    // Project event.timeStamp onto the audio clock (preserves inter-message
    // spacing under main-thread dispatch jitter) via the shared scheduler.
    // The scheduler owns the calibrated perf↔ctx offset + its periodic
    // refresh, so all three MIDI bridges share one implementation.
    const scheduler = createMidiScheduler(ctx);
    function schedAt(eventTimeStamp: number): number {
      return scheduler.schedAt(eventTimeStamp);
    }

    function pulse(src: ConstantSourceNode, t: number): void {
      src.offset.cancelScheduledValues(t);
      src.offset.setValueAtTime(1, t);
      src.offset.setValueAtTime(0, t + GATE_PULSE_S);
    }

    function setRun(value: 0 | 1, t: number): void {
      running = value === 1;
      runSrc.offset.cancelScheduledValues(t);
      runSrc.offset.setValueAtTime(value, t);
    }

    function handleMidiMessage(ev: MidiEventLike): void {
      const data = ev.data;
      if (data.length < 1) return;
      const status = data[0]!;
      // Only System Real-Time messages drive this module. Channel-voice
      // events (note on/off, pitch-bend, CC) are MIDI-CV-BUDDY's concern.
      if (!isSystemRealTime(status)) return;
      const t = schedAt(ev.timeStamp);

      if (status === STATUS_CLOCK) {
        ticksReceived++;
        tickCounter++;
        if (tickCounter >= divisor) {
          tickCounter = 0;
          pulse(clockSrc, t);
        }
        // No notify per tick — at 24 PPQN × 120 BPM that's 48 Hz of card
        // repaint pressure. Card has its own rAF for the activity LED.
        return;
      }
      if (status === STATUS_START) {
        // Re-zero the divider so the first emitted edge lands on the
        // downbeat, not partway through a partial count.
        tickCounter = 0;
        setRun(1, t);
        pulse(startSrc, t);
        notify();
        return;
      }
      if (status === STATUS_CONT) {
        setRun(1, t);
        notify();
        return;
      }
      if (status === STATUS_STOP) {
        setRun(0, t);
        pulse(stopSrc, t);
        notify();
        return;
      }
      // 0xFE Active Sensing and 0xFF Reset are intentionally ignored.
    }

    function attachToDevice(deviceId: string | null): void {
      if (!access) return;
      for (const inp of access.inputs.values()) inp.onmidimessage = null;
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
          if (selectedDeviceId && !access?.inputs.has(selectedDeviceId)) {
            // Device disappeared. Keep selection so it reattaches on hot-plug.
          } else if (!selectedDeviceId) {
            selectedDeviceId = pickDefaultDevice();
            attachToDevice(selectedDeviceId);
          }
          notify();
        };
        selectedDeviceId = pickDefaultDevice();
        attachToDevice(selectedDeviceId);
        ticksReceived = 0;
        notify();
        return true;
      } catch {
        permissionDenied = true;
        notify();
        return false;
      }
    }

    function selectDevice(d: string | null): void {
      selectedDeviceId = d;
      attachToDevice(d);
      // Reset the divider counter so the new device starts on a fresh
      // edge. Avoids a half-counted carryover when switching mid-song.
      tickCounter = 0;
      notify();
    }

    function setDivisor(d: ClockDivisor): void {
      divisor = d;
      tickCounter = 0;
      notify();
    }

    const cardApi: MidiclockApi = {
      connect,
      selectDevice,
      setDivisor,
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
        ['clock',     { node: clockSrc, output: 0 }],
        ['run',       { node: runSrc,   output: 0 }],
        ['midistart', { node: startSrc, output: 0 }],
        ['midistop',  { node: stopSrc,  output: 0 }],
      ]),
      setParam() { /* no AudioParam-style knobs */ },
      readParam() { return undefined; },
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
        try { clockSrc.stop(); } catch { /* */ }
        try { runSrc.stop();   } catch { /* */ }
        try { startSrc.stop(); } catch { /* */ }
        try { stopSrc.stop();  } catch { /* */ }
        clockSrc.disconnect();
        runSrc.disconnect();
        startSrc.disconnect();
        stopSrc.disconnect();
      },
    };
  },
};
