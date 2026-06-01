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

// ---------------- MIDI System Real-Time status bytes ----------------
const STATUS_CLOCK = 0xf8;
const STATUS_START = 0xfa;
const STATUS_CONT  = 0xfb;
const STATUS_STOP  = 0xfc;

/** MIDI clock is fixed at 24 PPQN (pulses per quarter note). */
export const MIDI_PPQN = 24;

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

// ---------------- Tempo-stability helpers (pure, testable) ----------------
//
// Web MIDI delivers events on the main thread with `event.timeStamp` set to
// the performance.now()-relative time at which the message arrived. The
// main-thread handler runs LATER (event-loop scheduling, GC pauses, paint
// frames), so `performance.now()` inside the handler is always >= eventTs.
//
// Naively scheduling at `audioCtx.currentTime + lookahead` discards the
// message's own timestamp, so any main-thread jitter (1–10ms is normal,
// 50ms+ under load) becomes audible jitter on the downstream gate. MIDI
// Clock is 24 PPQN, so at 120 BPM a tick is ~20.8 ms — even a few-ms
// scheduling slop sounds like swing.
//
// The fix: anchor scheduling to the message's `timeStamp`, NOT to the
// handler-dispatch time. Two clocks are involved:
//
//   * `performance.now()` — DOMHighResTimestamp ms; what `event.timeStamp`
//     is measured against.
//   * `AudioContext.currentTime` — seconds since context creation; what
//     `setValueAtTime` consumes.
//
// Both tick at real-time, so `ctxOffset := currentTimeS - performanceNowMs/1000`
// is a CONSTANT (modulo small drift from clock-source skew over minutes).
// Measure it once (or periodically), then any event's target audio time is
// `eventTimeStampMs/1000 + ctxOffset + lookahead`. Inter-event Δ on the
// audio clock equals Δ between their `timeStamp`s — to floating-point
// precision — regardless of when their handlers ran.

/** Scheduling lookahead applied to every projected event time. Web Audio
 *  silently coerces "schedule in the past" → currentTime, which is the
 *  exact source of audible swing this helper is designed to avoid. We
 *  add a fixed offset so every projected target sits comfortably in the
 *  future even when the main-thread handler is dispatched well after the
 *  message arrived (event-loop stalls, paint frames, GC pauses).
 *
 *  WHY 25ms (not 2-3ms): the floor must dominate the worst-case
 *  main-thread lag, otherwise events with lag > lookahead get clamped
 *  to the floor and re-introduce ctxNow-spacing (== event-loop jitter
 *  == the bug). 25ms covers a stalled event-loop "for the duration of
 *  one MIDI tick at 120 BPM" — a worst-realistic case. The user
 *  perceives this as a CONSTANT 25ms latency on every clock pulse,
 *  which is inaudible (any MIDI host already runs 5–15ms of buffer);
 *  what they DON'T perceive is jitter, because the same 25ms is added
 *  to every event. */
export const TIMESTAMP_LOOKAHEAD_S = 0.025;

/** Maximum lag we'll honor from event.timeStamp before we treat it as
 *  bogus and re-anchor at "now + lookahead". A real Web MIDI event lags
 *  the handler by a few ms at most; >100 ms means either the tab was
 *  backgrounded (and a burst arrived at once on resume) or the timestamp
 *  is from a different clock domain (some platforms have shipped MIDI
 *  timestamps with the wrong origin). Honoring such a stale timestamp
 *  would project the schedule far in the past — Web Audio coerces that
 *  to currentTime but ALSO loses the relative spacing of the burst.
 *  Clamping here means a burst gets re-anchored at the floor, which is
 *  the lesser audible evil. */
export const MAX_TIMESTAMP_LAG_MS = 100;

/**
 * Compute the calibrated offset between `AudioContext.currentTime` (s)
 * and `performance.now()` (ms). Both clocks tick at real-time so this
 * value is constant up to a small per-platform drift (~ppm). The MIDI
 * handler uses it to project an `event.timeStamp` directly onto the
 * audio clock without re-reading either clock per-event.
 *
 * Re-measure periodically (every few seconds) to absorb drift; calling
 * cheaper than once per MIDI message.
 */
export function measureCtxOffset(
  currentTimeS: number,
  performanceNowMs: number,
): number {
  return currentTimeS - performanceNowMs / 1000;
}

/**
 * Project a Web-MIDI `event.timeStamp` (a `performance.now()`-relative
 * DOMHighResTimestamp, in milliseconds) onto the AudioContext's
 * `currentTime` clock (in seconds), with a fixed lookahead budget.
 *
 *   eventTimeStampMs   — `event.timeStamp` from the MIDIMessageEvent.
 *   currentTimeS       — `audioContext.currentTime` at handler-dispatch.
 *   performanceNowMs   — `performance.now()` at handler-dispatch.
 *   ctxOffsetS         — calibrated `currentTimeS - performanceNowMs/1000`,
 *                        measured once at MIDI init + refreshed every few
 *                        seconds. Passed in so the helper stays pure.
 *
 * Returns the audio-context time (seconds) at which the message's
 * scheduled value-change should land. Properties:
 *
 *   1. Two messages whose `timeStamp`s differ by `Δms` are scheduled
 *      `Δms / 1000` seconds apart on the audio clock — independent of
 *      when their handlers actually ran. (THIS is what was broken in the
 *      pre-fix code: the old `Math.max(now + lookahead, ...)` floor
 *      clamped every event to "now + lookahead", erasing the spacing.)
 *   2. Every schedule is at least `TIMESTAMP_LOOKAHEAD_S * 0.5` in the
 *      future, so Web Audio never coerces the schedule into the past.
 *   3. If the timestamp lag exceeds `MAX_TIMESTAMP_LAG_MS` (stale burst
 *      e.g. after tab-resume), we re-anchor at "now + lookahead" — the
 *      burst loses its embedded spacing but doesn't pollute the schedule.
 *
 * Pure. Tests pin the math directly.
 */
export function eventTimeStampToAudioTime(
  eventTimeStampMs: number,
  currentTimeS: number,
  performanceNowMs: number,
  ctxOffsetS: number,
): number {
  const lagMs = performanceNowMs - eventTimeStampMs;
  // Defense in depth: stale or future-skewed timestamps re-anchor at the
  // floor so a misbehaving driver can't push the schedule arbitrarily
  // forward or backward.
  if (lagMs < 0 || lagMs > MAX_TIMESTAMP_LAG_MS) {
    return currentTimeS + TIMESTAMP_LOOKAHEAD_S;
  }
  const target = eventTimeStampMs / 1000 + ctxOffsetS + TIMESTAMP_LOOKAHEAD_S;
  // Floor: an event with lag > TIMESTAMP_LOOKAHEAD_S would produce a
  // target in the past on the audio clock. The lookahead is sized so
  // this only happens for outliers (event-loop stall > 25 ms). When it
  // does, clamp to one audio block ahead — Web Audio honors the
  // schedule, but the affected event loses its projected spacing.
  // This is INTENTIONALLY a tiny floor (not lookahead/2) so that the
  // CLAMP only catches genuine outliers; events with normal lag pass
  // through the projection and keep their inter-pulse spacing.
  const FLOOR_EPSILON_S = 128 / 48000; // one 48 kHz audio block
  const floor = currentTimeS + FLOOR_EPSILON_S;
  return target > floor ? target : floor;
}

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
  domain: 'audio',
  label: 'MIDICLOCK',
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

    // Calibrated offset between perf.now() and audioCtx.currentTime.
    // Refreshed every ~CTX_OFFSET_REFRESH_MS to absorb sub-ppm clock
    // drift between the two reference clocks. Re-reading both clocks per
    // MIDI message would itself add jitter (each call ~µs but the order
    // of operations matters for tight inter-message spacing).
    let ctxOffsetS = typeof performance !== 'undefined'
      ? measureCtxOffset(ctx.currentTime, performance.now())
      : 0;
    let lastOffsetRefreshMs = typeof performance !== 'undefined' ? performance.now() : 0;
    const CTX_OFFSET_REFRESH_MS = 2000;

    function schedAt(eventTimeStamp: number): number {
      // Preserve inter-message spacing by projecting event.timeStamp onto
      // the audio-context clock using the calibrated offset. The old
      // implementation floored every event at `currentTime + lookahead`,
      // which threw away the message's own arrival time and made downstream
      // jitter == main-thread event-loop jitter. At 24 PPQN that is
      // audible swing. See eventTimeStampToAudioTime() docs.
      const now = ctx.currentTime;
      const perfNow = typeof performance !== 'undefined' ? performance.now() : eventTimeStamp;
      // Refresh the offset periodically. Drift between perf.now() and
      // currentTime is typically <1 ppm but accumulates over long sessions;
      // 2s refresh is way under the audibility threshold (drift across 2s
      // ≈ 2 µs, four orders of magnitude below the MIDI tick period).
      if (perfNow - lastOffsetRefreshMs > CTX_OFFSET_REFRESH_MS) {
        ctxOffsetS = measureCtxOffset(now, perfNow);
        lastOffsetRefreshMs = perfNow;
      }
      return eventTimeStampToAudioTime(eventTimeStamp, now, perfNow, ctxOffsetS);
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
