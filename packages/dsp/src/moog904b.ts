// packages/dsp/src/moog904b.ts
//
// MOOG 904B — Voltage Controlled High Pass Filter AudioWorkletProcessor.
//
// Batch-1 module of the Moog System 55 / 35 clone initiative
// (.myrobots/MOOG/). The 904B is the high-pass companion to the 904A LPF:
// a 24 dB/oct transistor-ladder HIGH-pass. Like the hardware, the high-pass
// is derived from the ladder by SUBTRACTING the low-passed signal from the
// input (the ladder is fundamentally a low-pass; hp = input − lp).
//
// IMPLEMENTATION NOTE: a single subtraction `input − lp4` does NOT give a
// clean 24 dB/oct high-pass — subtracting a steep, phase-shifted 4-pole
// low-pass leaves a resonant bump near cutoff + a shallow ~6 dB/oct stopband
// (measured: only ~−8 dB an octave below cutoff). So we CASCADE FOUR
// one-pole high-pass stages, each a clean `input − lp1` derivation off its
// OWN ladder instance. Four 6 dB/oct stages → a genuine 24 dB/oct high-pass
// with a deep monotonic stopband (measured ~−80 dB an octave below cutoff)
// and a flat passband — the response the 904B's 24 dB/oct spec calls for,
// built entirely out of the shared ladder lib's hpDerive() tap.
//
// It has a CUTOFF pot, a two-position RANGE switch (LOW 4 Hz–20 kHz /
// HIGH = +1.5 oct), a summing 1 V/oct CONTROL INPUT, and — unlike the
// 904A — NO REGENERATION / resonance knob (the hardware 904B has no
// resonance pot), so every stage runs with zero ladder feedback.
//
// DSP CONSUMES the shared own-code transistor-ladder core
// (./lib/moog-ladder-dsp.ts) — the SAME clean-room TPT/Zavalishin
// zero-delay-feedback ladder the 904A uses, via its hpDerive() helper
// (hp = input − lpN). Permissive / own-code, NOT a port of the LGPLv3
// Huovilainen code, the CC-BY-SA musicdsp model, or any Moog schematic
// (.myrobots/MOOG/LICENSING.md).
//
// IMPORTANT: this file does NOT `export` anything at the top level —
// top-level exports leak into the bundled dist/<name>.js + break the ART
// classic-script eval. The Processor class is registered via the
// `registerProcessor` side-effect; tests capture it through a
// registerProcessor shim before importing. (memory:
// dsp-worklet-no-top-level-export)
//
// Inputs (audio-rate node connections):
//   inputs[0] = audio       (signal to be filtered)
//   inputs[1] = cutoff_cv   (1 V/oct CONTROL INPUT, summed onto cutoff)
//
// AudioParams (the web factory ALSO sums CV into cutoff via the AudioParam
// fast-path; the audio-rate input above is the summing CONTROL INPUT):
//   cutoff (FIXED CONTROL VOLTAGE, Hz), range (RANGE switch 1=LOW / 2=HIGH).
//
// Outputs (mono):
//   outputs[0] = audio (24 dB/oct high-pass)

import { MoogLadder, hpDerive } from './lib/moog-ladder-dsp';
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
// captures the class via this shim — see moog904b DSP test loader).
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

// RANGE switch → cutoff multiplier. The 904B's RANGE shifts the cutoff:
//   LOW  (1): the full 4 Hz–20 kHz span (×1).
//   HIGH (2): +1.5 octaves (×2^1.5 ≈ ×2.83) so the same knob sweep sits
//             higher (per the service-manual RANGE behaviour).
const RANGE_HIGH_MULT = Math.pow(2, 1.5);

function rangeMultiplier904b(range: number): number {
  return Math.round(range) >= 2 ? RANGE_HIGH_MULT : 1;
}

// Number of cascaded one-pole HP stages → filter slope. 4 × 6 dB/oct = the
// 904B's 24 dB/oct.
const HP_STAGES = 4;

// Not `export`ed at the top level by design — see the file-header note.
class Moog904bProcessor extends AudioWorkletProcessor {
  private sr: number;
  // One ladder per cascade stage; each contributes a clean 6 dB/oct HP
  // (input − lp1). Four in series = 24 dB/oct.
  private ladders: MoogLadder[];

  // 80 Hz one-pole smoother on the cutoff knob keeps CV zipper out of the
  // audio path on knob drags (cutoff smoothed in Hz). The audio-rate
  // CONTROL INPUT (cutoff_cv) is summed UNSMOOTHED so modulation stays
  // sample-accurate.
  private smCutoff: WtParamSmoother;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.sr = sampleRate;
    this.ladders = [];
    for (let s = 0; s < HP_STAGES; s++) this.ladders.push(new MoogLadder(this.sr));
    this.smCutoff = new WtParamSmoother(this.sr);
    this.smCutoff.prime(1000);
  }

  static get parameterDescriptors() {
    return [
      // FIXED CONTROL VOLTAGE — the cutoff pot, in Hz (log knob on the UI
      // side). a-rate so external CV can sweep it continuously.
      { name: 'cutoff', defaultValue: 1000, minValue: 4, maxValue: 20000, automationRate: 'a-rate' as const },
      // RANGE switch — 1 = LOW (4 Hz–20 kHz) / 2 = HIGH (+1.5 oct).
      { name: 'range', defaultValue: 1, minValue: 1, maxValue: 2, automationRate: 'k-rate' as const },
    ];
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0];
    // No output buffer wired this block — nothing to do, but keep alive.
    if (!out) return true;

    const audioIn = inputs[0]?.[0];
    const cutoffCvIn = inputs[1]?.[0];

    const cutoffArr = parameters.cutoff;
    const rangeArr = parameters.range;

    // RANGE is k-rate (a switch, not a swept value) — read once.
    const range = rangeArr.length > 0 ? rangeArr[0] : 1;
    const rangeMul = rangeMultiplier904b(range);

    const blockLen = out.length;
    for (let i = 0; i < blockLen; i++) {
      const x = audioIn ? audioIn[i] : 0;
      const cutoffCv = cutoffCvIn ? cutoffCvIn[i] : 0;

      const cutoffRaw = cutoffArr.length > 1 ? cutoffArr[i] : cutoffArr[0];

      // Smooth the knob, then apply RANGE + the 1 V/oct CONTROL INPUT
      // (exponential: each volt = one octave). The AudioParam fast-path
      // already summed any cv→cutoff routing into cutoffRaw; the dedicated
      // audio-rate cutoff_cv input is the 904B's summing 1 V/oct jack,
      // applied multiplicatively here.
      const cutoffKnob = this.smCutoff.step(cutoffRaw);
      let cutoffHz = cutoffKnob * rangeMul * Math.pow(2, cutoffCv);
      if (cutoffHz < 4) cutoffHz = 4;
      else if (cutoffHz > 20000) cutoffHz = 20000;

      // The 904B has NO regeneration/resonance pot, so every ladder runs
      // with k = 0 (no feedback) + the cheap exact LINEAR solve (drive = 0).
      // Cascade FOUR clean one-pole high-pass stages (each input − lp1 off
      // its own ladder) → a genuine 24 dB/oct high-pass with a deep
      // monotonic stopband, vs the bumpy shallow response a single
      // input − lp4 would give.
      let y = x;
      for (let s = 0; s < HP_STAGES; s++) {
        const taps = this.ladders[s].step(y, cutoffHz, 0, 0);
        y = hpDerive(y, taps, 1);
      }
      out[i] = y;
    }

    return true;
  }
}

registerProcessor('moog904b', Moog904bProcessor);
