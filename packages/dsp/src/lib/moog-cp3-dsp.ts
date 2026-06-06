// packages/dsp/src/lib/moog-cp3-dsp.ts
//
// MOOG CP3 / CP3A CONSOLE PANEL (mixer) — pure DSP core.
//
// Own-code (permissive, .myrobots/MOOG/LICENSING.md) — a forked, expanded
// version of the repo's `mixer`: a 4×1 summing mixer that additionally
// provides the CP3's distinctive features:
//
//   • a (+) output AND a (−) (phase-inverted) output — the CP3 presents
//     both polarities of the summed bus simultaneously;
//   • the 4th channel has an external jack + ATTENUATOR; at "10" (1.0) the
//     attenuator is unity so a direct patch passes through unaltered, and
//     the attenuated 4th signal is summed into the bus alongside ch1..ch3;
//   • a MULTIPLE: one input fanned out to three identical passthrough outs
//     (1 → 3), independent of the mixer bus;
//   • two trunk / reference voltage outputs: a constant +12 V and −6 V
//     (scaled into the project's normalized voltage convention).
//
// Max channel gain is ×2 (the CP3 can boost, not just attenuate) and the
// mixer sums AC and/or DC voltages (audio and CV alike — the per-sample
// math is polarity- and DC-transparent).
//
// This module is shared by BOTH the Moog System 55 and System 35 consoles
// (registered under SYS55, the shared bucket, per the resolved Q4 decision
// in .myrobots/MOOG/PLAN.md).
//
// All functions are pure + sample-rate-agnostic so the worklet, the unit
// tests, and node-side ART can reuse the exact same math.

/** The CP3's max per-channel gain. The console can boost up to ×2. */
export const CP3_MAX_GAIN = 2;

/**
 * Map a 0..1 mixer-channel knob (25K-LIN feel, shown 0..10 on the
 * faceplate) to a linear gain in [0, CP3_MAX_GAIN]. Linear taper: knob at
 * "5" (0.5) = unity, knob at "10" (1.0) = ×2, knob at "0" = silence.
 */
export function cp3ChannelGain(knob: number): number {
  const k = knob < 0 ? 0 : knob > 1 ? 1 : knob;
  return k * CP3_MAX_GAIN;
}

/**
 * The 4th-input ATTENUATOR. 25K-LIN feel, shown 0..10; at "10" (1.0) it is
 * UNITY (direct patch passes through unaltered), scaling down linearly to
 * silence at "0". Unlike the channel gains it never boosts past unity — it
 * is an attenuator, the level trim for the external 4th-input jack.
 */
export function cp3Attenuator(knob: number): number {
  return knob < 0 ? 0 : knob > 1 ? 1 : knob;
}

/**
 * The CP3's primary mix math for ONE sample.
 *
 * The 4th input is the SUM of the panel `in4` jack and the external `ext4`
 * jack, scaled by the 4th-channel ATTENUATOR, then the whole 4th channel
 * rides its own ch4 gain like the others. (On the hardware the attenuator
 * trims the external jack into the 4th bus; here in1..in3 take their
 * channel gains directly and the attenuated 4th is the fourth summand.)
 *
 * Returns { pos, neg } — the (+) output and its exact phase-inverse.
 */
export function cp3Mix(
  in1: number, in2: number, in3: number, in4: number, ext4: number,
  g1: number, g2: number, g3: number, g4: number,
  atten4: number,
): { pos: number; neg: number } {
  const ch4Signal = (in4 + ext4) * atten4;
  const pos =
    in1 * g1 +
    in2 * g2 +
    in3 * g3 +
    ch4Signal * g4;
  return { pos, neg: -pos };
}

/**
 * Reference / trunk voltages, expressed in the project's normalized
 * convention where the bipolar CV range is ±1 ≡ ±5 V (the same scale the
 * rest of the rack's CV cables use). The CP3 trunk jacks supply a steady
 * +12 V rail reference and a −6 V rail reference; we scale those rails into
 * the normalized convention so downstream CV math sees the right ratio
 * (+12 V → +2.4, −6 V → −1.2; the −6 is exactly half the +12 and opposite
 * sign, which the unit tests pin).
 */
export const CP3_VOLT_SCALE = 1 / 5; // ±5 V ≡ ±1.0 normalized
export const CP3_PLUS_12V = 12 * CP3_VOLT_SCALE; //  +2.4
export const CP3_MINUS_6V = -6 * CP3_VOLT_SCALE; //  −1.2
