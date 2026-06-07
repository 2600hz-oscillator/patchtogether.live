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

// ──────────────────────────── pure delta/echo core ────────────────────────────

/** Per-control feedback bookkeeping. */
interface ControlFb {
  /** Last CC we SENT to the device for this control (delta dedupe). */
  lastSent?: number;
  /** Last CC the DEVICE sent US (echo-suppression token). */
  inboundCc?: number;
  /** performance.now() of that inbound, for the suppression window. */
  inboundAt?: number;
}

export const ECHO_WINDOW_MS = 120;

/**
 * Pure feedback state machine. Tracks per-key sent/inbound CCs and decides
 * whether a given param→CC update should actually be transmitted. No timers,
 * no MIDI — `now` is injected.
 */
export class FeedbackState {
  private byKey = new Map<string, ControlFb>();
  private readonly echoWindowMs: number;

  constructor(opts: { echoWindowMs?: number } = {}) {
    this.echoWindowMs = opts.echoWindowMs ?? ECHO_WINDOW_MS;
  }

  /** Record that the DEVICE sent us this CC for `key` at `now` (so a same-value
   *  echo back to the device within the window is suppressed). Call from the
   *  inbound CC handler BEFORE the param write lands. */
  noteInbound(key: string, cc: number, now: number): void {
    const fb = this.get(key);
    fb.inboundCc = cc;
    fb.inboundAt = now;
  }

  /**
   * Decide whether to send `cc` for `key` at `now`. Returns true (and records
   * it as lastSent) when the update should go out; false to skip. Skips when:
   *   - cc === lastSent (no change — delta dedupe), OR
   *   - cc === the inbound CC still inside the echo window (would echo the
   *     device's own move straight back).
   */
  shouldSend(key: string, cc: number, now: number): boolean {
    const fb = this.get(key);
    if (fb.lastSent === cc) return false;
    if (
      fb.inboundCc === cc &&
      fb.inboundAt !== undefined &&
      now - fb.inboundAt < this.echoWindowMs
    ) {
      // Still record as sent so we don't keep re-evaluating; the device already
      // shows this value (it originated there).
      fb.lastSent = cc;
      return false;
    }
    fb.lastSent = cc;
    return true;
  }

  /** Forget a control (e.g. on regenerate). */
  forget(key: string): void {
    this.byKey.delete(key);
  }

  clear(): void {
    this.byKey.clear();
  }

  private get(key: string): ControlFb {
    let fb = this.byKey.get(key);
    if (!fb) {
      fb = {};
      this.byKey.set(key, fb);
    }
    return fb;
  }
}

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
