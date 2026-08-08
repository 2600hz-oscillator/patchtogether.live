// packages/web/src/lib/electra/feedback.ts
//
// FEEDBACK PUMP — app value/level → Electra control display.
//
// Two streams, both on the CTRL port as PLAIN CC (the device's parameter-map
// auto-sync; we avoid the slow 14 07/14 0E JSON value writes):
//   - writable controls: reflect the live param so a motorized/encoder pot
//     tracks CV + remote rack-mate edits (feedback-tracked, echo-suppressed).
//   - meters: per-channel VU + master VU streamed at ~30Hz (1 small CC each).
//
// Echo suppression: when an inbound CC writes a param, the param then changes,
// which would make us echo the SAME CC straight back to the device — a feedback
// loop / value judder. We guard with a per-control "last value WE wrote to the
// app from the device" token + a short window: if the param's current CC equals
// what the device just sent us inside the window, we skip the echo.
//
// The delta + echo + throttle LOGIC is pure (FeedbackState below) so it unit-tests
// without Web MIDI; the FeedbackPump class wires it to a broker + the engine.

import type { ElectraAllocation } from './types';
import { valueToCc7, ampToMeterCc } from './curve';
import { CcSuppressor, ECHO_WINDOW_MS } from '$lib/midi/cc-dedupe';

// ──────────────────────────── pure delta/echo core ────────────────────────────
//
// MOVED. The delta-dedupe + echo-window state machine now lives in
// `$lib/midi/cc-dedupe` as `CcSuppressor` — unchanged logic, just no longer
// namespaced to Electra, because every outbound-CC consumer needs it (the
// device-control work is the second). `FeedbackState` remains the name Electra
// uses; it is an alias, so this module's callers and tests are unaffected.

export { ECHO_WINDOW_MS };
// A `const` alias (not `export { X as Y }`) so the name is also a LOCAL binding
// this module can `new` — FeedbackPump below constructs one.
export const FeedbackState = CcSuppressor;
export type FeedbackState = CcSuppressor;

// ──────────────────────────── pump wiring ────────────────────────────

/** What the pump needs to read app state + send to the device. Injected so the
 *  pump is testable with fakes. */
export interface FeedbackDeps {
  /** Read a writable control's current param value (engine.readParam / read). */
  readParamValue: (key: string) => number | undefined;
  /** Read a per-channel meter's current RMS amplitude (0..1) for a meter key. */
  readMeterAmp: (key: string) => number | undefined;
  /** Send a plain CC on a device/channel. */
  sendCc: (deviceId: number, cc: number, value: number) => void;
  /** Inject the clock (defaults to performance.now). */
  now?: () => number;
}

/**
 * Drives value + meter feedback. Construct with the allocation table + deps,
 * then call `pumpControls()` (writable feedback, debounced/deltaed) and
 * `pumpMeters()` (VU stream) — or `start(intervalMs)` to run both on a timer.
 */
export class FeedbackPump {
  private readonly rw: ElectraAllocation[];
  private readonly meters: ElectraAllocation[];
  private readonly state = new FeedbackState();
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private allocations: ElectraAllocation[], private deps: FeedbackDeps) {
    this.rw = allocations.filter((a) => a.role === 'rw');
    this.meters = allocations.filter((a) => a.role === 'meter');
    this.now = deps.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  }

  /** Record a device-originated CC so the matching feedback is echo-suppressed. */
  noteInbound(key: string, cc: number): void {
    this.state.noteInbound(key, cc, this.now());
  }

  /**
   * PRIME the device with the CURRENT value of every writable control, FORCE-
   * sending (bypassing the delta/echo dedupe) so the device shows real values
   * immediately after connect — not the preset's 0 defaults.
   *
   * Why a dedicated prime (vs. the steady pumpControls): the .epr upload over
   * SysEx hasn't been ingested by the device when the first ~33ms pump tick
   * fires, so that early value CC is dropped — and pumpControls then records it
   * as `lastSent` and never re-sends, leaving an untouched control (the whole
   * MIXMASTER page) stuck at 0. prime() resets the per-control state and resends,
   * so calling it a few times as the upload settles guarantees the device lands
   * on the live values. A control whose value isn't readable yet (engine not up
   * at click time) is skipped; a later prime catches it. Returns the count sent.
   */
  prime(): number {
    this.state.clear(); // forget stale sent/inbound so every readable control resends
    const now = this.now();
    let sent = 0;
    for (const a of this.rw) {
      const v = this.deps.readParamValue(a.key);
      if (v === undefined || a.min === undefined || a.max === undefined) continue;
      const cc = valueToCc7(v, a.min, a.max, a.curve ?? 'linear');
      this.state.shouldSend(a.key, cc, now); // record as lastSent so the steady pump won't immediately re-send
      this.deps.sendCc(a.deviceId, a.number, cc);
      sent++;
    }
    return sent;
  }

  /** One pass over writable controls: read param → curve-aware CC → maybe send. */
  pumpControls(): void {
    const now = this.now();
    for (const a of this.rw) {
      const v = this.deps.readParamValue(a.key);
      if (v === undefined || a.min === undefined || a.max === undefined) continue;
      const cc = valueToCc7(v, a.min, a.max, a.curve ?? 'linear');
      if (this.state.shouldSend(a.key, cc, now)) {
        this.deps.sendCc(a.deviceId, a.number, cc);
      }
    }
  }

  /** One pass over meters: read amp → dBFS-mapped CC → send (always; read-only,
   *  no echo risk, and a small CC per update is cheap at 30Hz). Deltaed so a
   *  silent channel doesn't spam identical CCs. */
  pumpMeters(): void {
    const now = this.now();
    for (const a of this.meters) {
      const amp = this.deps.readMeterAmp(a.key);
      if (amp === undefined) continue;
      const cc = ampToMeterCc(amp);
      if (this.state.shouldSend(a.key, cc, now)) {
        this.deps.sendCc(a.deviceId, a.number, cc);
      }
    }
  }

  /** Start the combined loop at `intervalMs` (≈33ms ⇒ 30Hz for meters). */
  start(intervalMs = 33): void {
    this.stop();
    this.timer = setInterval(() => {
      this.pumpControls();
      this.pumpMeters();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
