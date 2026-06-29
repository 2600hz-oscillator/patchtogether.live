// packages/dsp/src/lib/ninelives-dsp.ts
//
// NINE LIVES — the PURE DSP core, shared verbatim by:
//   * the AudioWorklet (packages/dsp/src/ninelives.ts) — the live 9-output
//     LFO hot path, and
//   * unit tests (no AudioContext, deterministic) — the same math.
//
// Keeping the maths here (not inside the worklet entry) means tests can
// source-import it directly, and the worklet entry stays import-only of these
// helpers (no top-level export of the Processor — see the worklet header /
// the dsp-worklet-no-top-level-export rule).
//
// ── What NINE LIVES is ──
//   A single low-frequency oscillator fanned out to NINE CV outputs whose
//   rates form a GEOMETRIC ⅓ ladder: out1 runs at the rate knob (identical to
//   a normal LFO), and each subsequent output runs at ⅓ the rate of the one
//   before it. So out_n = rate(out1) × (1/3)^(n-1), and the slowest tap
//   out9 = (1/3)^8 = 1/6561 of out1 (≈ 0.0001524×). All nine taps share ONE
//   waveform shape (the `shape` morph, reused verbatim from the LFO).
//
//   A RESET trigger re-zeroes every phase accumulator on its rising edge, so
//   all nine outputs snap back to phase 0 together (a hard re-sync of the
//   whole ladder). The reset is EDGE-detected (fires once per rising edge),
//   NOT level-held — holding it high does not freeze the ladder.

/** Number of CV outputs on the ladder. */
export const NINE_LIVES_OUTPUT_COUNT = 9;

/** The rate ratio between adjacent outputs: each output runs at ⅓ the rate of
 *  the previous one. */
export const NINE_LIVES_RATIO = 1 / 3;

/**
 * Per-output rate multiplier relative to out1 (index 0). out_n = rate(out1) ×
 * NINE_LIVES_RATE_MULTIPLIERS[n]. By construction:
 *   index 0 (out1) = (1/3)^0 = 1
 *   index 1 (out2) = (1/3)^1 = 1/3
 *   …
 *   index 8 (out9) = (1/3)^8 = 1/6561  (≈ 0.000152415…)
 */
export const NINE_LIVES_RATE_MULTIPLIERS: readonly number[] = Array.from(
  { length: NINE_LIVES_OUTPUT_COUNT },
  (_, i) => NINE_LIVES_RATIO ** i,
);

/** Canonical rising-edge threshold for the RESET trigger. Mirrors GATE_HI in
 *  $lib/audio/gate-trigger (0.5); inlined so the DSP core stays dependency-
 *  free (the worklet bundle pulls in nothing from $lib). */
export const RESET_THRESHOLD = 0.5;

const TWO_PI = Math.PI * 2;

/**
 * Morph between sine, saw, and square for the given normalized phase [0,1).
 *
 * Mirrors the LFO worklet's morph() (packages/dsp/src/lfo.ts) VERBATIM so the
 * shared NINE LIVES waveform is identical to a normal LFO at the same shape:
 *   shape 0 = sine, 1 = saw, 2 = square, with linear crossfades in between.
 * Bipolar, centered on 0, ±1 swing (the LFO's amplitude convention at unity).
 */
export function morph(phase: number, shape: number): number {
  const s = Math.max(0, Math.min(2, shape));
  const sine = Math.sin(TWO_PI * phase);
  const saw = phase * 2 - 1;
  const sq = phase < 0.5 ? 1 : -1;
  if (s < 1) {
    const m = s;
    return sine * (1 - m) + saw * m;
  }
  const m = s - 1;
  return saw * (1 - m) + sq * m;
}

/**
 * The stateful 9-output LFO core. Holds one phase accumulator per output plus a
 * completed-cycle counter (so a test can measure each output's true frequency
 * even for the very slow taps, and so the wrapped phase stays bounded over long
 * runs). `step()` advances every accumulator by one sample, handles the reset
 * trigger, and writes the shared-waveform value of each tap.
 */
export class NineLivesCore {
  /** Wrapped phase [0,1) for each of the 9 outputs (drives the waveform). */
  readonly phases: Float64Array = new Float64Array(NINE_LIVES_OUTPUT_COUNT);

  /** Number of FULL cycles each output has completed since the last reset.
   *  `cycles[n] + phases[n]` is the total (unwrapped) phase = exact cycle
   *  count, used by tests to measure frequency without losing precision on
   *  the fast taps or resolution on the slow ones. */
  readonly cycles: Float64Array = new Float64Array(NINE_LIVES_OUTPUT_COUNT);

  /** Previous reset-input sample, for per-sample rising-edge detection. */
  private prevReset = 0;

  /** Re-zero every phase accumulator + cycle counter (re-sync the ladder). */
  reset(): void {
    this.phases.fill(0);
    this.cycles.fill(0);
  }

  /** Total (unwrapped) phase advanced by output `n` since the last reset, in
   *  cycles. measuredFrequencyHz = totalPhase(n) / elapsedSeconds. */
  totalPhase(n: number): number {
    return (this.cycles[n] ?? 0) + (this.phases[n] ?? 0);
  }

  /**
   * Advance all nine accumulators by ONE sample and write each tap's output.
   *
   * Order matches the LFO worklet: a reset rising edge re-zeroes the phases
   * FIRST, then every accumulator advances by its own rate this sample (so the
   * sample after a reset sits at rate_n/sr, not exactly 0 — the standard LFO
   * hard-sync behaviour). The reset is detected per-sample as a rising edge
   * (prev < TH && cur >= TH) — a worklet/pure-core consumer is exempt from the
   * main-thread windowed edge-detect rule by construction.
   *
   * @param rateHz       out1 frequency in Hz (the rate knob). out_n runs at
   *                     rateHz × (1/3)^(n-1). Negative values are clamped to 0.
   * @param shape        shared waveform morph 0..2 (sine→saw→square).
   * @param resetSample  current RESET-input sample; a rising edge re-syncs all.
   * @param sr           sample rate (Hz).
   * @param out          length-≥9 buffer to receive each tap's bipolar output.
   */
  step(
    rateHz: number,
    shape: number,
    resetSample: number,
    sr: number,
    out: Float32Array | number[],
  ): void {
    // RESET trigger: rising edge re-zeroes the whole ladder (re-sync).
    if (this.prevReset < RESET_THRESHOLD && resetSample >= RESET_THRESHOLD) {
      this.reset();
    }
    this.prevReset = resetSample;

    const r = Math.max(0, rateHz);
    const safeSr = sr > 0 ? sr : 1;
    for (let n = 0; n < NINE_LIVES_OUTPUT_COUNT; n++) {
      const inc = (r * (NINE_LIVES_RATE_MULTIPLIERS[n] ?? 0)) / safeSr;
      let p = (this.phases[n] ?? 0) + inc;
      // Wrap to [0,1), counting completed cycles so totalPhase() stays exact.
      while (p >= 1) {
        p -= 1;
        this.cycles[n] = (this.cycles[n] ?? 0) + 1;
      }
      while (p < 0) {
        p += 1;
        this.cycles[n] = (this.cycles[n] ?? 0) - 1;
      }
      this.phases[n] = p;
      out[n] = morph(p, shape);
    }
  }
}
