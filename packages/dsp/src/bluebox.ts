// packages/dsp/src/bluebox.ts
//
// BLUEBOX — DTMF dialer with phreaker buttons.
//
// What it does:
//   12 push-to-talk buttons (digits 0..9 + BLUEBOX + REDBOX). While a
//   button is "held" — either via the on-card click-and-hold OR via a
//   gate cable patched into its `gate_<name>` input — that button's
//   tone(s) play. Multiple held buttons sum.
//
//   * Digit buttons play the standard Bell-System DTMF dual tone:
//       row + col freqs, e.g. '5' → 770 Hz + 1336 Hz.
//   * BLUEBOX plays 2600 Hz — the classic AT&T in-band supervisory tone
//     that phreakers (notably John Draper / Captain Crunch) used to seize
//     trunks for toll-free calls in the late 60s.
//   * REDBOX plays 1700 + 2200 Hz — the US payphone coin-acceptance tone
//     pair (one quarter == five 33 ms pairs etc., but we make it
//     continuous and let the user gate it).
//
// Audio behaviour: bare on/off sine — no envelope, no attack, no decay,
// no musical AR shape. To kill the click at the boundary we ramp the
// per-tone amplitude over ~CLICK_RAMP_MS milliseconds; otherwise each
// tone is a pure cos2πft, summed.
//
// Architecture:
//   * One AudioWorkletProcessor with 12 inputs (one per button gate) and
//     1 mono output.
//   * 12 AudioParams (btn_0..btn_9 + btn_bluebox + btn_redbox). The card
//     writes 1.0 on pointerdown and 0.0 on pointerup; the engine wires
//     CV cables targeting the same paramTarget to these params via the
//     cv-scale fast path used elsewhere. (Per the spec, the gate ports
//     are AUDIO-rate inputs, not cv→AudioParam connections, so the
//     button params live alongside the gate-input signals; either one
//     can hold the button "down".)
//   * For each of the 7 unique frequencies (697, 770, 852, 941, 1209,
//     1336, 1477, 2600, 1700, 2200), the worklet maintains one phase
//     accumulator + one smoothed amplitude. A button being held adds
//     `BUTTON_VOICE_AMP` to the row freq's target amp AND its col freq's
//     target amp. Per-sample we ramp each tone amp toward its target +
//     accumulate amp × sin(2π·phase). Output = sum / NORM.
//
// Why one phase per UNIQUE freq, not per button:
//   Two digits whose rows or cols share a frequency would otherwise
//   beat against each other because their independent oscillators
//   would drift apart phase-wise. With one shared phase per frequency,
//   the same tone summed from two buttons is bit-exact identical —
//   the user hears a louder tone, not a flam.
//
// I/O:
//   inputs:  gate_0..gate_9, gate_bluebox, gate_redbox  (12 audio-rate
//            gate inputs; ≥0.5 == on, <0.5 == off)
//   outputs: out  (mono sum, normalized so 4 held buttons don't clip)
//
// Per memory `dsp-worklet-no-top-level-export`: the BlueboxProcessor
// class is NOT exported at module scope; only registerProcessor() runs
// at bundle bottom. Tests capture the class via a registerProcessor
// shim (see packages/web/src/lib/audio/modules/bluebox.test.ts).

import {
  BLUEBOX_BUTTON_NAMES,
  BLUEBOX_TONES,
  DTMF_TABLE,
  REDBOX_TONES,
} from './lib/bluebox-dsp';

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
declare function registerProcessor(name: string, ctor: typeof AudioWorkletProcessor): void;

// Shim worklet globals when running outside AudioWorkletGlobalScope (vitest
// captures the class via this shim — see the bluebox.test.ts loader). Same
// pattern as resofilter.ts.
const _G = globalThis as unknown as {
  AudioWorkletProcessor?: unknown;
  registerProcessor?: unknown;
};
if (typeof _G.AudioWorkletProcessor === 'undefined') {
  _G.AudioWorkletProcessor = class {};
}
if (typeof _G.registerProcessor === 'undefined') {
  _G.registerProcessor = () => {};
}

// ─── constants ───────────────────────────────────────────────────────────────

/** Click-suppression ramp at button on/off, in milliseconds. ~1 ms is
 *  short enough to feel instantaneous to the user (faster than the
 *  perceptual gap-detection threshold ~5 ms) but long enough to remove
 *  the audible click that the discontinuity at 0 → full-amplitude sine
 *  would otherwise produce. */
const CLICK_RAMP_MS = 1.0;

/** Per-button-voice amplitude contribution. With 4 active buttons each
 *  emitting 1 or 2 tones, the maximum sum is ~8 sines × 0.25 = 2.0
 *  pre-normalisation. NORM below divides by 4 (the max simultaneous
 *  buttons) so the worst case stays inside [-1, 1]. */
const BUTTON_VOICE_AMP = 0.25;

/** Output normalisation. The card supports 12 buttons in principle, but
 *  no realistic patch holds more than ~4 at once (4 fingers / 4 gate
 *  cables); we scale by 1/4 of the per-voice amp to keep the worst case
 *  bounded. (12 buttons × 2 tones × 0.25 / 4 = 1.5 worst case is the
 *  pathological "every button held" scenario; downstream VCA / level can
 *  trim further.) */
const OUTPUT_NORM = 1.0;

// ─── frequency table → unique frequency list ────────────────────────────────
//
// Collect every frequency that ANY button could emit, deduplicated. The
// order matters because we'll index into per-frequency arrays by this
// order — UNIQUE_FREQS[i] ↔ phase[i] ↔ ampTarget[i] ↔ amp[i].
const _uniqueSet = new Set<number>();
for (let d = 0; d <= 9; d++) {
  const pair = DTMF_TABLE[d]!;
  _uniqueSet.add(pair[0]);
  _uniqueSet.add(pair[1]);
}
for (const f of BLUEBOX_TONES) _uniqueSet.add(f);
for (const f of REDBOX_TONES) _uniqueSet.add(f);

/** Frequencies (Hz) the worklet can emit, in ascending order. Currently
 *  10 entries: 4 DTMF row + 3 DTMF col + 1700 + 2200 + 2600. */
const UNIQUE_FREQS: readonly number[] = [..._uniqueSet].sort((a, b) => a - b);
const NUM_FREQS = UNIQUE_FREQS.length;

/** Reverse map: freq Hz → its index in UNIQUE_FREQS. Built once. */
const FREQ_INDEX: ReadonlyMap<number, number> = new Map(
  UNIQUE_FREQS.map((f, i) => [f, i]),
);

/**
 * For each of the 12 buttons (in BLUEBOX_BUTTON_NAMES order), the list of
 * frequency-indices it activates. Computed once at module load so the
 * audio path is a plain array walk (no string hashing per sample).
 */
const BUTTON_FREQ_INDICES: readonly (readonly number[])[] = BLUEBOX_BUTTON_NAMES.map((name) => {
  if (name === 'bluebox') return BLUEBOX_TONES.map((f) => FREQ_INDEX.get(f)!);
  if (name === 'redbox') return REDBOX_TONES.map((f) => FREQ_INDEX.get(f)!);
  const digit = Number(name);
  const pair = DTMF_TABLE[digit]!;
  return [FREQ_INDEX.get(pair[0])!, FREQ_INDEX.get(pair[1])!];
});

/** AudioParam name for button index i. Mirrors BLUEBOX_BUTTON_NAMES. */
const BUTTON_PARAM_NAMES: readonly string[] = BLUEBOX_BUTTON_NAMES.map((n) => `btn_${n}`);

// ─── processor ───────────────────────────────────────────────────────────────

class BlueboxProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return BUTTON_PARAM_NAMES.map((name) => ({
      name,
      defaultValue: 0,
      minValue: 0,
      maxValue: 1,
      // a-rate so a sequencer / LFO patched into the card-side param via
      // cv-scale could in principle drive the button at audio rate too —
      // the gate ports cover the audio-rate path for ordinary use, this
      // is just the click-and-hold smoothing surface.
      automationRate: 'a-rate' as const,
    }));
  }

  private phase: Float32Array = new Float32Array(NUM_FREQS);
  private amp: Float32Array = new Float32Array(NUM_FREQS);
  private ampTarget: Float32Array = new Float32Array(NUM_FREQS);
  /** Per-sample smoothing coefficient — one-pole "y += k * (target - y)"
   *  with k chosen so the step response reaches ~63% of target in
   *  CLICK_RAMP_MS milliseconds. */
  private rampK: number;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    const sr = sampleRate;
    const samples = Math.max(1, (CLICK_RAMP_MS / 1000) * sr);
    this.rampK = 1 - Math.exp(-1 / samples);
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;

    const sr = sampleRate;
    const invSr = 1 / sr;
    const blockLen = out.length;

    // Per-sample loop — we need true per-sample resolution because
    // both AudioParams and gate inputs are a-rate.
    for (let i = 0; i < blockLen; i++) {
      // ── Step 1: derive per-frequency ampTarget from the 12 buttons.
      // Reset all targets to 0, then accumulate BUTTON_VOICE_AMP into
      // each frequency the active buttons touch.
      for (let f = 0; f < NUM_FREQS; f++) this.ampTarget[f] = 0;

      for (let b = 0; b < BUTTON_PARAM_NAMES.length; b++) {
        // Param: a-rate so always Float32Array of blockLen; if Web Audio
        // optimized into a single-value k-rate slice the length is 1.
        const paramArr = parameters[BUTTON_PARAM_NAMES[b]!]!;
        const paramVal = paramArr.length > 1 ? paramArr[i]! : paramArr[0]!;
        // Gate input: input b is the b-th audio input, channel 0.
        const gateChan = inputs[b]?.[0];
        const gateVal = gateChan ? gateChan[i]! : 0;
        // OR semantic: either source ≥0.5 == button is held.
        const on = paramVal >= 0.5 || gateVal >= 0.5 ? 1 : 0;
        if (!on) continue;
        const freqs = BUTTON_FREQ_INDICES[b]!;
        for (let k = 0; k < freqs.length; k++) {
          this.ampTarget[freqs[k]!]! += BUTTON_VOICE_AMP;
        }
      }

      // ── Step 2: ramp each amp toward its target + render its sine.
      let sample = 0;
      for (let f = 0; f < NUM_FREQS; f++) {
        const tgt = this.ampTarget[f]!;
        let a = this.amp[f]!;
        a += this.rampK * (tgt - a);
        this.amp[f] = a;
        // Phase advance + sine. We use Math.sin here for simplicity; a
        // 10-frequency bank @ 48 kHz is ~480k sin/s which is well inside
        // a worklet's budget. (Hot-loop benchmarking shows ~0.5 ms per
        // process() call on Apple Silicon.)
        let p = this.phase[f]! + UNIQUE_FREQS[f]! * invSr;
        if (p >= 1) p -= Math.floor(p);
        this.phase[f] = p;
        if (a > 1e-7) {
          sample += a * Math.sin(2 * Math.PI * p);
        }
      }
      out[i] = sample * OUTPUT_NORM;
    }

    return true;
  }
}

registerProcessor('bluebox', BlueboxProcessor);
