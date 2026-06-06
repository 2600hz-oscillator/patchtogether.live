// packages/dsp/src/moog902.ts
//
// MOOG 902 — Voltage Controlled Amplifier AudioWorkletProcessor.
//
// Slice 3 of the Moog System 55 / 35 clone initiative (.myrobots/MOOG/).
// The 902 is the classic Moog differential VCA: a manual GAIN pot, a set of
// summing CONTROL INPUTS, a SIGNAL input, and TWO complementary outputs (the
// differential pair — the normal output + its phase-inverted twin). It has a
// LINEAR / EXPONENTIAL response switch. The 902 appears in BOTH systems
// (S35×3, S55×5) → shared → categorized under Moog → SYS55 (the shared
// bucket, mirroring the 921 + 904A).
//
// GAIN LAW (the load-bearing behavior — see .myrobots/MOOG/ spec Fig 9):
//   The amplifier's gain is driven by a CONTROL SUM measured in volts:
//       control = gainKnob(0..6 V)  +  fcv (fixed-control-voltage bias)
//                 + cvAmount * cv   (the summing CONTROL INPUTS)
//   The headline anchors: overall gain ×2 (+6 dB) at pot=max (6 V) OR at
//   CV=6 V; gain reaches its ×3 ceiling near a control sum of ~7.5 V.
//
//   * LINEAR mode: gain rises linearly with the control voltage —
//       gainMul = control / 3      (so 6 V → ×2, the +6 dB anchor)
//     clamped to the ×3 ceiling. A 0 V control = silence.
//   * EXPONENTIAL mode: gain rises exponentially with the control voltage,
//     normalized so it STILL passes through ×2 at 6 V (the shared anchor)
//     and then climbs faster, hitting the ×3 ceiling near ~7.5 V (matching
//     the spec's "max ×3 near FCV+input sum ≈ 7.5 V"). This is the classic
//     VCA "exp = snappier, more aggressive at the top" feel.
//
// DSP is OWN CODE. A clean-room amplifier gain law forked from the repo's own
// existing `vca` (packages/dsp/src/vca.dsp) — re-implemented here in TS with
// the added EXPONENTIAL branch + the Moog ×2-at-6V / ×3-ceiling scaling. NOT
// a port of any Moog schematic or copyleft source (.myrobots/MOOG/
// LICENSING.md: permissive / own-code only).
//
// IMPORTANT: this file does NOT `export` anything at the top level —
// top-level exports leak into the bundled dist/<name>.js + break the ART
// classic-script eval. The Processor class is registered via the
// `registerProcessor` side-effect; tests capture it through a
// registerProcessor shim before importing. (memory:
// dsp-worklet-no-top-level-export)
//
// Inputs (audio-rate node connections):
//   inputs[0] = audio   (the SIGNAL input — the audio to be amplified)
//   inputs[1] = cv      (summing CONTROL INPUT → gain, scaled by cvAmount)
//   inputs[2] = fcv     (fixed-control-voltage bias — a second summing
//                        CONTROL INPUT added straight onto the control sum)
//
// AudioParams (the web factory ALSO sums any cv→param routing via the
// AudioParam fast-path; the audio-rate inputs above are the summing
// CONTROL INPUTS the analog 902 actually exposes):
//   gain (0..1 → mapped to 0..6 V on the control sum), cvAmount (-1..1),
//   mode (0 = LINEAR, 1 = EXPONENTIAL — discrete switch).
//
// Outputs (each mono — the differential pair):
//   outputs[0] = audio       (the amplified signal)
//   outputs[1] = audio_inv   (the phase-inverted twin — differential −)

import { WtParamSmoother } from './lib/wavetable-osc';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: typeof AudioWorkletProcessor,
): void;

// Shim worklet globals when running outside AudioWorkletGlobalScope (vitest
// captures the class via this shim — see moog902 DSP test loader).
const G = globalThis as unknown as {
  AudioWorkletProcessor?: unknown;
  registerProcessor?: unknown;
};
if (typeof G.AudioWorkletProcessor === 'undefined') {
  G.AudioWorkletProcessor = class {};
}
if (typeof G.registerProcessor === 'undefined') {
  G.registerProcessor = () => {};
}

// ───────────────────────── Gain-law constants ─────────────────────────
// The control voltage at the +6 dB (×2) anchor: the GAIN pot maxes at 6 V,
// and CV = 6 V alone also yields ×2.
const V_ANCHOR = 6;
// The gain multiplier at the anchor (×2 = +6 dB).
const GAIN_AT_ANCHOR = 2;
// The hard ceiling: the 902 maxes out at ×3 (the control sum saturates).
const GAIN_CEILING = 3;
// The GAIN pot spans 0..6 V of control (param `gain` is 0..1 → ×6).
const GAIN_POT_VOLTS = 6;

// EXPONENTIAL-law constants. The curve g = EXP_A * (e^(control/EXP_TAU) - 1)
// is fitted to pass through BOTH anchors exactly: ×2 at the 6 V anchor and
// ×3 at the ~7.5 V ceiling anchor. Solved from
//   EXP_A*(e^(6/τ)-1) = 2  and  EXP_A*(e^(7.5/τ)-1) = 3   →   τ ≈ 5.0102.
// (e^0 - 1 = 0, so control = 0 → silence; the curve is monotonic.)
const EXP_TAU = 5.0102;
const EXP_A = GAIN_AT_ANCHOR / (Math.exp(V_ANCHOR / EXP_TAU) - 1);

/**
 * Map a CONTROL SUM (in volts) to an amplitude multiplier under the given
 * mode — the single place the 902 gain law lives. (The DSP unit tests pin
 * it indirectly by driving process() and reading the steady-state output.)
 *   LINEAR:      gainMul = control / 3   (6 V → ×2), clamped to [0, ×3].
 *   EXPONENTIAL: passes through ×2 at 6 V, climbs faster, hits ×3 near
 *                ~7.5 V, clamped to [0, ×3]. Below 0 V → silence.
 */
function moog902Gain(control: number, exponential: boolean): number {
  if (control <= 0) return 0;
  let g: number;
  if (!exponential) {
    // Linear: straight line through the origin hitting ×2 at 6 V.
    g = (control / V_ANCHOR) * GAIN_AT_ANCHOR; // = control / 3
  } else {
    // Exponential: g = EXP_A * (e^(control/EXP_TAU) - 1), fitted to pass
    // through BOTH anchors exactly —
    //   At control = 0           → 0   (silence)
    //   At control = 6 (anchor)  → ×2  (the shared +6 dB point)
    //   At control = 7.5         → ×3  (the ceiling anchor — "≈ 7.5 V")
    // The clamp below still pins the hard ×3 max for any larger sum.
    g = EXP_A * (Math.exp(control / EXP_TAU) - 1);
  }
  if (g > GAIN_CEILING) g = GAIN_CEILING;
  return g;
}

// Not `export`ed at the top level by design — see the file-header note.
class Moog902Processor extends AudioWorkletProcessor {
  private sr: number;

  // 80 Hz one-pole smoothers on the knobs keep CV zipper out of the audio
  // path on knob drags. The audio-rate summing CONTROL INPUTS (cv / fcv)
  // are summed UNSMOOTHED so modulation stays sample-accurate.
  private smGain: WtParamSmoother;
  private smCvAmount: WtParamSmoother;
  // The applied multiplier is itself smoothed so a mode flip or a fast
  // control swing doesn't click.
  private smOutGain: WtParamSmoother;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.sr = sampleRate;
    this.smGain = new WtParamSmoother(this.sr);
    this.smCvAmount = new WtParamSmoother(this.sr);
    this.smOutGain = new WtParamSmoother(this.sr);
    this.smGain.prime(0.5);
    this.smCvAmount.prime(1);
    this.smOutGain.prime(0);
  }

  static get parameterDescriptors() {
    return [
      // GAIN — the manual pot (0..1 → 0..6 V of control). Default 0.5 so a
      // bare-spawned 902 passes a patched signal at a sensible level.
      { name: 'gain', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      // CV depth/sign for the summing cv CONTROL INPUT.
      { name: 'cvAmount', defaultValue: 1, minValue: -1, maxValue: 1, automationRate: 'a-rate' as const },
      // RESPONSE switch — 0 LINEAR / 1 EXPONENTIAL (k-rate; it's a switch).
      { name: 'mode', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
    ];
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0];
    const outInv = outputs[1]?.[0];
    // No output buffers wired this block — nothing to do, but keep alive.
    if (!out && !outInv) return true;

    const audioIn = inputs[0]?.[0];
    const cvIn = inputs[1]?.[0];
    const fcvIn = inputs[2]?.[0];

    const gainArr = parameters.gain;
    const cvAmountArr = parameters.cvAmount;
    const modeArr = parameters.mode;

    // mode is k-rate (a switch) — read once, threshold at 0.5.
    const exponential = (modeArr.length > 0 ? modeArr[0] : 0) >= 0.5;

    const blockLen = (out ?? outInv)!.length;
    for (let i = 0; i < blockLen; i++) {
      const x = audioIn ? audioIn[i] : 0;
      const cv = cvIn ? cvIn[i] : 0;
      const fcv = fcvIn ? fcvIn[i] : 0;

      const gainRaw = gainArr.length > 1 ? gainArr[i] : gainArr[0];
      const cvAmountRaw = cvAmountArr.length > 1 ? cvAmountArr[i] : cvAmountArr[0];

      // Smooth the knobs, then build the CONTROL SUM (in volts):
      //   gain pot (0..1 → 0..6 V) + fixed-control-voltage bias + cv*cvAmount.
      const gainKnobV = this.smGain.step(gainRaw) * GAIN_POT_VOLTS;
      const cvAmount = this.smCvAmount.step(cvAmountRaw);
      const control = gainKnobV + fcv + cvAmount * cv;

      const targetGain = moog902Gain(control, exponential);
      const g = this.smOutGain.step(targetGain);

      const y = x * g;
      if (out) out[i] = y;
      // The differential − output: the phase-inverted twin.
      if (outInv) outInv[i] = -y;
    }

    return true;
  }
}

registerProcessor('moog902', Moog902Processor);
