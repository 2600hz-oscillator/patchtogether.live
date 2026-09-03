// packages/dsp/src/lib/cv-clock-core.ts
//
// CV-CLOCK CORE — CV Buddy's hardware RUN + CLOCK generator, as a pure,
// sample-accurate engine that runs inside the seq-clock AudioWorklet module
// (../seq-clock.ts, processor 'cv-clock').
//
// WHY: the CV clock dropped ONE pulse in a live performance (SPEEDERR-001,
// 2026-09-02 — ledger item 10): the main-thread scheduler pre-places pulses
// over a 200 ms lookahead window, and a 200–360 ms main-thread stall out-lasted
// the window, so exactly one pulse could not be placed and every follower on
// the passive split (two Pam's + a Böhm) re-locked audibly. The scheduler
// already DROPS rather than flushes (cv-buddy/clock-math.ts + the #2324
// invariant suite), so the margin, not the semantics, was the defect.
// AudioParam scheduling is main-thread-only, which is why the durable fix is
// to move pulse EMISSION onto the audio thread: this core renders the pulse
// train per sample, so a main-thread stall of any length can starve only the
// CONFIG messages (a tempo edit applies late) and never the pulses themselves.
//
// This core reproduces the main-thread scheduler's musical semantics EXACTLY
// (cv-buddy.ts tick() + cv-buddy/clock-math.ts advanceClock):
//   • period = 60/bpm/ppqn seconds (pulses per quarter note)
//   • PHASE ACCUMULATOR, not a t=0 grid: a tempo change alters the interval
//     from the NEXT pulse onward and never teleports a pulse that was already
//     due (the Pam's/Mandala instability clock-math.ts documents)
//   • the train ANCHORS when the clock starts (running rising edge), so it
//     begins WITH the transport rather than at an arbitrary grid phase
//   • `offsetMs` is applied AT EMIT, not baked into the phase, so nudging the
//     trim moves the pulses by exactly the trim delta
//   • DROP-NOT-FLUSH: a pulse whose time has already passed can no longer
//     sound on time — it is counted in `skipped` and stepped over, never
//     emitted late in a clump. (On the audio thread this is reachable only
//     via a config jump, e.g. an offset trim; a main-thread stall cannot
//     starve process() itself.)
//   • RUN is a LEVEL held at `runLevel` while running, 0 while stopped —
//     it follows play state, it does not pulse.
//   • a degenerate tempo (non-finite / non-positive bpm or ppqn) schedules
//     nothing AND holds the phase, so recovering a sane tempo resumes where
//     it left off rather than jumping.
//
// `running` arrives PRE-FOLDED as (clock owner && transport running) — slot
// ownership is a rack-level fact the main thread owns (slot-alloc.ts), so the
// worklet never re-derives it.
//
// PURE + deterministic (no RNG, no wall-clock, no Web Audio API) so vitest can
// pin every boundary. The worklet imports + runs THIS code — no mirror, no
// drift.

/** Live config pushed to the engine on edit / scheduler tick (NOT per audio
 *  block). `runLevel` and `pulseS` mirror the web package's GATE_HI and
 *  CLOCK_PULSE_HIGH_S — the dsp package cannot import them, so the wiring
 *  side (cv-buddy.ts) sends the authoritative values; the defaults here only
 *  cover the gap before the first config message. */
export interface CvClockConfig {
  bpm: number;
  ppqn: number;
  /** Manual latency trim, milliseconds, applied at emit. */
  offsetMs: number;
  /** Pre-folded (clock owner && transport running). */
  running: boolean;
  /** Level held on the RUN output while running (web GATE_HI). */
  runLevel: number;
  /** Clock pulse high time in seconds (web CLOCK_PULSE_HIGH_S = 5 ms). */
  pulseS: number;
}

/** Seconds between clock pulses — the same law as clock-math.ts
 *  `pulsePeriodS`. Returns Infinity for degenerate inputs (emit nothing,
 *  hold phase). */
export function cvPulsePeriodS(bpm: number, ppqn: number): number {
  if (!Number.isFinite(bpm) || !Number.isFinite(ppqn) || bpm <= 0 || ppqn <= 0) {
    return Infinity;
  }
  return 60 / bpm / ppqn;
}

const DEFAULT_CONFIG: CvClockConfig = {
  bpm: 120,
  ppqn: 24,
  offsetMs: 0,
  running: false,
  runLevel: 0.5, // web GATE_HI — overwritten by the first config message
  pulseS: 0.005, // web CLOCK_PULSE_HIGH_S — overwritten by the first config message
};

/**
 * Sample-accurate RUN + CLOCK renderer. Drive it from an AudioWorklet's
 * `process()` (or a test loop) via `process(clockOut, runOut, frames)`.
 *
 * Output per sample: clock (0|1, a `pulseS`-wide square at each grid point) on
 * `clockOut`; run (0|runLevel) on `runOut`.
 */
export class CvClockCore {
  readonly sampleRate: number;

  private cfg: CvClockConfig = { ...DEFAULT_CONFIG };

  /** Engine-local time in seconds, advanced by exactly 1/sampleRate per
   *  rendered sample. Only differences of this value are meaningful. */
  private t = 0;
  /** UNSHIFTED time of the next pulse (see clock-math.ts ClockPhase.next), or
   *  null when stopped — the train re-anchors on the next start. */
  private nextUnshifted: number | null = null;
  /** Samples the clock line stays high for the pulse in flight. */
  private pulseSamplesLeft = 0;

  /** Cumulative pulses emitted since construction. Monotonic. */
  private emitted = 0;
  /** Cumulative pulses dropped-and-counted since construction. Monotonic —
   *  the same conservation law as advanceClock's `skipped`: every grid point
   *  is either EMITTED or COUNTED, never flushed late. */
  private dropped = 0;

  constructor(sampleRate: number, cfg?: Partial<CvClockConfig>) {
    this.sampleRate = sampleRate > 0 ? sampleRate : 48000;
    if (cfg) this.setConfig(cfg);
  }

  /** Push new live config. Coalescing is the caller's concern; applying the
   *  same config twice is free. */
  setConfig(cfg: Partial<CvClockConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
  }

  get pulses(): number {
    return this.emitted;
  }
  get skipped(): number {
    return this.dropped;
  }

  /** Render `frames` samples of clock + run. */
  process(clockOut: Float32Array, runOut: Float32Array, frames: number): void {
    const n = Math.min(frames, clockOut.length, runOut.length);
    const dt = 1 / this.sampleRate;

    if (!this.cfg.running) {
      // Stopped (or not the clock owner): both lines LOW immediately — the
      // mirror of stopClock()'s cancel+set(0) — and the phase re-anchors on
      // the next start so the train begins WITH the transport.
      this.nextUnshifted = null;
      this.pulseSamplesLeft = 0;
      for (let i = 0; i < n; i++) {
        clockOut[i] = 0;
        runOut[i] = 0;
      }
      this.t += n * dt;
      return;
    }

    const runLevel = this.cfg.runLevel;
    const period = cvPulsePeriodS(this.cfg.bpm, this.cfg.ppqn);
    const clockable = Number.isFinite(period) && period > 0;
    const offsetS = Number.isFinite(this.cfg.offsetMs) ? this.cfg.offsetMs / 1000 : 0;
    const pulseSamples = Math.max(1, Math.round(this.cfg.pulseS * this.sampleRate));

    for (let i = 0; i < n; i++) {
      if (clockable) {
        // Anchor on start: the first pulse fires NOW (advanceClock's
        // `base = winStart - offsetS`, so the first EMITTED time is winStart).
        if (this.nextUnshifted === null) this.nextUnshifted = this.t - offsetS;

        let due = this.nextUnshifted + offsetS;

        // DROP-NOT-FLUSH. A pulse older than one sample can no longer sound
        // on time; count it and catch the phase up in one step (advanceClock's
        // `skipped = ceil((winStart - firstDue) / period)` with
        // winStart := now - one sample). Steady-state rendering never lands
        // here — t crosses each due time within one sample — so this is
        // reachable only when a config jump (offset trim) moves `due` into
        // the past. Emitting the backlog instead would be the clamp-to-now
        // burst the #2324 suite forbids.
        const behind = this.t - dt - due;
        if (behind > 0) {
          const missed = Math.ceil(behind / period);
          this.dropped += missed;
          this.nextUnshifted += missed * period;
          due = this.nextUnshifted + offsetS;
        }

        if (due <= this.t) {
          // Crossed within this sample → a fresh pulse starts here. If the
          // previous pulse is still high (period < pulseS at extreme
          // bpm×ppqn), the line simply stays high — the same overlap the
          // main-thread openGate/closeGate interleave produces.
          this.pulseSamplesLeft = pulseSamples;
          this.emitted++;
          this.nextUnshifted += period;
        }
      }

      if (this.pulseSamplesLeft > 0) {
        clockOut[i] = 1;
        this.pulseSamplesLeft--;
      } else {
        clockOut[i] = 0;
      }
      runOut[i] = runLevel;
      this.t += dt;
    }
  }
}
