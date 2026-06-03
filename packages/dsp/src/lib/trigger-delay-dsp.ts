// packages/dsp/src/lib/trigger-delay-dsp.ts
//
// Pure DSP for the MOOG 911A DUAL TRIGGER DELAY. A trigger delay watches a
// gate input for a RISING edge, waits a programmed delay, then emits a short
// output pulse. The 911A pairs two of these with a coupling MODE:
//
//   OFF      (mode 0) — fully independent: trig1 → delay1 → out1,
//                       trig2 → delay2 → out2.
//   PARALLEL (mode 1) — trig1 fans out to BOTH delays: out1 fires after
//                       delay1, out2 after delay2 (trig2 is ignored).
//   SERIES   (mode 2) — trig1 → delay1 → out1; out1's own pulse re-triggers
//                       delay2 → out2 (a two-stage chain; trig2 ignored).
//
// `lib/` files MAY export freely (esbuild inlines them into the worklet
// bundle); the worklet entry (../moog911a.ts) must NOT — see resofilter.ts /
// the dsp-worklet-no-top-level-export note.
//
// The timing logic is per-sample state, so it lives here (testable) per the
// STATEFUL TIMING DSP RULE, mirroring flipper-dsp.ts / resofilter-dsp.ts.

/** A gate at/above this counts as high. Matches the codebase-wide 0.5
 *  gate threshold (FLIPPER_THRESHOLD, fourplexer, slewswitch). */
export const TRIGGER_DELAY_THRESHOLD = 0.5;

/** Output pulse width in seconds — how long the delayed output stays high
 *  once the countdown elapses (~1 ms, per the brief). Long enough for any
 *  downstream rising-edge detector to catch reliably. */
export const TRIGGER_DELAY_PULSE_S = 0.001;

/** Coupling modes for the 911A. Numeric so they map straight onto the
 *  discrete `mode` param (0..2). */
export const enum TriggerDelayMode {
  Off = 0,
  Parallel = 1,
  Series = 2,
}
export const TRIGGER_DELAY_MAX_MODE = 2;

/**
 * A single trigger delay: rising-edge → wait `delaySamples` → emit a pulse of
 * `pulseSamples`. Pure + per-sample; one `step()` per audio sample.
 *
 * State machine:
 *   idle      — waiting for a rising edge.
 *   counting  — a rising edge armed a countdown; counting down to 0.
 *   pulsing   — countdown elapsed; output held high for `pulseSamples`.
 *
 * Re-trigger rules:
 *   - A rising edge while idle starts a countdown.
 *   - A rising edge while ALREADY counting RESTARTS the countdown (re-arms to
 *     the latest delay) — the standard "retriggerable" mono behaviour.
 *   - The input must go LOW before another rising edge is recognised (edge
 *     detect, not level), so a held-high gate fires exactly once.
 */
export class TriggerDelay {
  private wasHigh = false;
  /** Samples left in the current countdown; <0 means not counting. */
  private countdown = -1;
  /** Samples left in the current output pulse; <=0 means not pulsing. */
  private pulseLeft = 0;
  /** Pulse length in samples (>=1), cached from the ctor. */
  private readonly pulseSamples: number;

  /** `pulseSamples` is the output pulse width in samples (>=1). */
  constructor(pulseSamples: number) {
    this.pulseSamples = Math.max(1, Math.round(pulseSamples));
  }

  /**
   * Advance one sample.
   *   `trig`         — the gate input level this sample.
   *   `delaySamples` — current delay length in samples (read live so the knob
   *                    can move; only matters at the instant a countdown is
   *                    (re)armed). Clamped to >=0 — a 0 delay fires the pulse
   *                    on the NEXT sample after the edge.
   * Returns the output gate level (TRIGGER_DELAY high or 0).
   */
  step(trig: number, delaySamples: number): number {
    const high = trig >= TRIGGER_DELAY_THRESHOLD;
    if (high && !this.wasHigh) {
      // Rising edge: (re)arm the countdown to the current delay.
      this.countdown = Math.max(0, Math.round(delaySamples));
    }
    this.wasHigh = high;

    // Tick the countdown. When it reaches 0 it fires the output pulse.
    if (this.countdown >= 0) {
      if (this.countdown === 0) {
        this.countdown = -1;
        this.pulseLeft = this.pulseSamples;
      } else {
        this.countdown--;
      }
    }

    // Emit the pulse for its full width.
    if (this.pulseLeft > 0) {
      this.pulseLeft--;
      return 1;
    }
    return 0;
  }

  /** Reset to idle (no pending countdown, no active pulse). */
  reset(): void {
    this.wasHigh = false;
    this.countdown = -1;
    this.pulseLeft = 0;
  }
}

/**
 * The 911A as a whole: two TriggerDelays composed per the coupling mode. One
 * `step()` per sample. Pure (no Web Audio), so the worklet wrapper stays thin
 * and the timing is unit-testable.
 */
export class DualTriggerDelay {
  private readonly d1: TriggerDelay;
  private readonly d2: TriggerDelay;
  /** Internal feedback: out1's pulse from the PREVIOUS sample, used as the
   *  trigger source for delay2 in SERIES mode. Reading the previous sample's
   *  out1 keeps the chain causal (no within-sample re-entrancy). */
  private prevOut1 = 0;

  constructor(pulseSamples: number) {
    this.d1 = new TriggerDelay(pulseSamples);
    this.d2 = new TriggerDelay(pulseSamples);
  }

  /**
   * Advance one sample.
   *   trig1 / trig2       — the two gate inputs.
   *   delay1 / delay2     — current delay lengths in samples.
   *   mode                — TriggerDelayMode (clamped 0..2).
   * Returns `[out1, out2]` gate levels.
   */
  step(
    trig1: number,
    trig2: number,
    delay1Samples: number,
    delay2Samples: number,
    mode: number,
  ): [number, number] {
    const m = mode <= TriggerDelayMode.Off
      ? TriggerDelayMode.Off
      : mode >= TriggerDelayMode.Series
        ? TriggerDelayMode.Series
        : TriggerDelayMode.Parallel;

    let out1: number;
    let out2: number;

    switch (m) {
      case TriggerDelayMode.Parallel: {
        // trig1 fans out to BOTH delays; trig2 is ignored.
        out1 = this.d1.step(trig1, delay1Samples);
        out2 = this.d2.step(trig1, delay2Samples);
        break;
      }
      case TriggerDelayMode.Series: {
        // trig1 → d1 → out1; out1's pulse (previous sample) → d2 → out2.
        out1 = this.d1.step(trig1, delay1Samples);
        out2 = this.d2.step(this.prevOut1, delay2Samples);
        break;
      }
      case TriggerDelayMode.Off:
      default: {
        // Fully independent.
        out1 = this.d1.step(trig1, delay1Samples);
        out2 = this.d2.step(trig2, delay2Samples);
        break;
      }
    }

    this.prevOut1 = out1;
    return [out1, out2];
  }

  reset(): void {
    this.d1.reset();
    this.d2.reset();
    this.prevOut1 = 0;
  }
}
