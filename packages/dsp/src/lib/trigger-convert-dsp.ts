// packages/dsp/src/lib/trigger-convert-dsp.ts
//
// Pure trigger-format-conversion logic for the MOOG 961 INTERFACE. The 961 is
// a trigger/gate format converter — in the real hardware it bridges S-trigger
// (switch-trigger, normally-closed to ground) and V-trigger (voltage-trigger,
// positive pulse) formats between a Moog modular and the outside world. In OUR
// graph all triggers are plain `gate` cables (0/1), so polarity is COSMETIC and
// we model only the TIMING behaviours:
//
//   (1) audio_in level over the `sensitivity` threshold → fire v_out1 AND
//       v_out2 (rising-edge on the RECTIFIED audio crossing the threshold).
//   (2) s_in passes straight through onto v_out1 AND v_out2 (format
//       passthrough: an external trigger drives the same V outputs).
//   (3) v_in_a → s_out_a, the gate passed through with its INPUT width
//       (duration-matched, like FLIPPER mirrors a gate to its selected out).
//   (4) v_in_b → s_out_b as a FIXED-WIDTH one-shot of `switchOnTimeSec`
//       seconds on each rising edge (the column-B "switch-on time" pulse —
//       this is the part that needs a sample countdown, hence the pure lib).
//
// `lib/` files MAY export freely (esbuild inlines them into the worklet
// bundle); the worklet entry (../moog961.ts) must NOT — see resofilter.ts.

/** A signal at/above this counts as a gate-high. Matches the 0.5 threshold the
 *  rest of the gate-logic modules (ILLOGIC / FLIPPER) use. */
export const GATE_THRESHOLD = 0.5;

/** Minimum/maximum/default for the SWITCH-ON TIME param (seconds). Mirrored by
 *  the module def + card so the worklet, def, and UI agree. */
export const SWITCH_ON_TIME_MIN = 0.04;
export const SWITCH_ON_TIME_MAX = 4;
export const SWITCH_ON_TIME_DEFAULT = 0.2;

/** Sensitivity (audio→trigger threshold) range. The rectified audio level is
 *  compared against this directly (linear 0..1). */
export const SENSITIVITY_MIN = 0;
export const SENSITIVITY_MAX = 1;
export const SENSITIVITY_DEFAULT = 0.5;

/** The four output values the 961 produces each sample, in def-order. */
export interface TriggerConvertOut {
  vOut1: number;
  vOut2: number;
  sOutA: number;
  sOutB: number;
}

/**
 * Pure per-sample 961 conversion state. Construct once per voice with the
 * audio sample rate; call step() per sample. All state (edge detectors + the
 * column-B one-shot countdown) is per-instance so two copies never interfere.
 */
export class TriggerConvertState {
  private readonly sr: number;

  // Rising-edge trackers (wasHigh flags — see the rising-edge-detect rule).
  private audioWasHigh = false; // rectified audio over threshold
  private sInWasHigh = false;   // external S-trigger input
  private vbWasHigh = false;    // column-B V input

  // Column-B fixed-width one-shot: samples of pulse remaining (0 = idle).
  private bPulseRemaining = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate > 0 ? sampleRate : 48000;
  }

  /** How many samples a `switchOnTimeSec` pulse lasts at this sample rate.
   *  At least 1 sample so even the shortest setting emits a detectable pulse. */
  pulseSamples(switchOnTimeSec: number): number {
    const clamped = Math.max(
      SWITCH_ON_TIME_MIN,
      Math.min(SWITCH_ON_TIME_MAX, switchOnTimeSec),
    );
    return Math.max(1, Math.round(clamped * this.sr));
  }

  /**
   * Advance one sample.
   *
   * @param audioIn  rectified-or-raw audio sample (we rectify internally).
   * @param sIn      external S-trigger gate (0/1).
   * @param vInA     column-A V input gate (passed through, width-matched).
   * @param vInB     column-B V input gate (fires a fixed one-shot on rising).
   * @param sensitivity  audio→trigger threshold (linear, 0..1).
   * @param switchOnTimeSec  column-B fixed pulse width in seconds.
   */
  step(
    audioIn: number,
    sIn: number,
    vInA: number,
    vInB: number,
    sensitivity: number,
    switchOnTimeSec: number,
  ): TriggerConvertOut {
    // (1) audio_in over the sensitivity threshold → rising-edge trigger.
    // Rectify so a negative half-cycle also counts (the hardware's audio→
    // trigger comparator responds to signal magnitude crossing a level).
    const rect = audioIn < 0 ? -audioIn : audioIn;
    const audioHigh = rect >= sensitivity && sensitivity > 0
      ? true
      : sensitivity <= 0
        ? rect > 0 // a 0 threshold fires on any non-zero signal
        : false;
    const audioRising = audioHigh && !this.audioWasHigh;
    this.audioWasHigh = audioHigh;

    // (2) s_in passes straight through to the V outputs.
    const sHigh = sIn >= GATE_THRESHOLD;
    this.sInWasHigh = sHigh; // tracked for symmetry / future polarity work

    // v_out1 / v_out2 are driven HIGH while the external S-trigger is held
    // (format passthrough), OR pulsed by the audio→trigger detector. We mirror
    // the s_in gate for its full width (duration-matched, like FLIPPER) and OR
    // in a single-sample tick when the audio detector fires a fresh edge.
    const vTrig = sHigh ? 1 : audioRising ? 1 : 0;
    const vOut1 = vTrig;
    const vOut2 = vTrig;

    // (3) v_in_a → s_out_a: pass the gate through with its INPUT width.
    const sOutA = vInA >= GATE_THRESHOLD ? 1 : 0;

    // (4) v_in_b → s_out_b: fixed-width one-shot on each rising edge.
    const vbHigh = vInB >= GATE_THRESHOLD;
    if (vbHigh && !this.vbWasHigh) {
      // Rising edge → (re)arm the countdown. Retrigger restarts the full pulse.
      this.bPulseRemaining = this.pulseSamples(switchOnTimeSec);
    }
    this.vbWasHigh = vbHigh;
    let sOutB = 0;
    if (this.bPulseRemaining > 0) {
      sOutB = 1;
      this.bPulseRemaining--;
    }

    return { vOut1, vOut2, sOutA, sOutB };
  }

  /** Reset all edge trackers + the one-shot countdown. */
  reset(): void {
    this.audioWasHigh = false;
    this.sInWasHigh = false;
    this.vbWasHigh = false;
    this.bPulseRemaining = 0;
  }
}
