// packages/dsp/src/lib/gatemaiden-dsp.ts
//
// Pure per-sample core for GATEMAIDEN — a single-input gate↔trigger converter
// (the user-facing repackaging of the MOOG 961 converter primitives + the
// Doepfer A-162 / Maths idiom). ONE generic CV input → BOTH a gate output and
// a trigger output, derived from the input's level + rising edges:
//
//   - GATE out  = held HIGH while the input is high, with a MINIMUM width of
//                 `gateLenSec` after each rising edge. So a long gate passes
//                 through duration-matched; a short TRIGGER in becomes a clean
//                 gate of at least gateLenSec (trigger → gate widening).
//   - TRIG out  = a short pulse (default triangle) on EVERY rising edge of the
//                 input. A gate in → one trigger per gate START; a trigger in →
//                 one reshaped pulse per input pulse (effectively passthrough).
//
// No mode switch + no "is this a gate or a trigger" auto-classification is
// needed — deriving both from level+edges works for any input (Maths EOR/EOC
// style). Sample-accurate, so it is exempt from the main-thread overlap-rescan
// double-count class by construction.
//
// `lib/` files MAY export freely (esbuild inlines them into the worklet
// bundle); the worklet entry (../gatemaiden.ts) must NOT export — see
// resofilter.ts / the dsp-worklet-no-top-level-export rule.

/** A signal at/above this counts as gate-high. Mirrors GATE_HI in the web-side
 *  $lib/audio/gate-trigger (kept in lockstep by value — packages can't import
 *  across the web/dsp boundary). */
export const GATE_HI = 0.5;

/** Default short-trigger pulse width (s) — 5 ms, within the real 1–5 ms band.
 *  Mirrors TRIGGER_PULSE_S in $lib/audio/gate-trigger. */
export const TRIGGER_PULSE_S = 0.005;

/** Min / max / default for the derived-gate length (s). The card + module def
 *  mirror these so worklet, def, and UI agree. */
export const GATE_LEN_MIN = 0.005;
export const GATE_LEN_MAX = 2;
export const GATE_LEN_DEFAULT = 0.05; // 50 ms

/** The two values GATEMAIDEN emits each sample. */
export interface GateMaidenOut {
  gate: number;
  trig: number;
}

/**
 * Pure per-sample GATEMAIDEN state. Construct once per instance with the audio
 * sample rate; call step() per sample.
 */
export class GateMaidenState {
  private readonly sr: number;
  private wasHigh = false;
  /** Samples since the last rising edge (−1 = none yet). Drives the min-gate. */
  private sinceRise = -1;
  /** Trigger-pulse countdown (samples remaining; 0 = idle) + its full length. */
  private trigRemaining = 0;
  private trigTotal = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate > 0 ? sampleRate : 48000;
  }

  /**
   * Advance one sample.
   * @param input        the CV-family input sample (gate OR trigger).
   * @param gateLenSec   minimum width of the derived gate (trigger→gate).
   * @param trigShape    0 = triangle (default), 1 = square emitted trigger.
   */
  step(input: number, gateLenSec: number, trigShape: number): GateMaidenOut {
    const high = input >= GATE_HI;
    const rising = high && !this.wasHigh;
    this.wasHigh = high;

    const clampedLen = Math.max(GATE_LEN_MIN, Math.min(GATE_LEN_MAX, gateLenSec));
    const gateLenSamples = Math.max(1, Math.round(clampedLen * this.sr));

    if (rising) {
      this.sinceRise = 0;
      this.trigRemaining = Math.max(1, Math.round(TRIGGER_PULSE_S * this.sr));
      this.trigTotal = this.trigRemaining;
    } else if (this.sinceRise >= 0) {
      this.sinceRise++;
    }

    // GATE: high while input is high, OR within the minimum-width window after
    // a rising edge. A long input gate stays high for its own duration (high
    // dominates); a 1-sample trigger holds for gateLenSamples.
    const withinMin = this.sinceRise >= 0 && this.sinceRise < gateLenSamples;
    const gate = high || withinMin ? 1 : 0;

    // TRIG: a short shaped pulse on each rising edge.
    let trig = 0;
    if (this.trigRemaining > 0) {
      if (trigShape >= 0.5) {
        trig = 1; // square
      } else {
        // triangle: ramp 0→1 over the first half, 1→0 over the second.
        const frac = (this.trigTotal - this.trigRemaining + 0.5) / this.trigTotal;
        trig = frac < 0.5 ? frac * 2 : (1 - frac) * 2;
      }
      this.trigRemaining--;
    }

    return { gate, trig };
  }

  /** Reset all edge/countdown state. */
  reset(): void {
    this.wasHigh = false;
    this.sinceRise = -1;
    this.trigRemaining = 0;
    this.trigTotal = 0;
  }
}
