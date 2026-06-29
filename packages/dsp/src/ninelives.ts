// packages/dsp/src/ninelives.ts
//
// NINE LIVES — the AudioWorklet processor: a low-frequency oscillator fanned
// out to NINE CV outputs on a geometric ⅓ rate ladder, all sharing one
// waveform shape, with a RESET trigger that re-syncs the whole ladder.
//
//   out1 runs at the `rate` knob (identical to a normal LFO), and each
//   subsequent output runs at ⅓ the rate of the previous one:
//     out_n = rate × (1/3)^(n-1)   →   out9 = (1/3)^8 = 1/6561 of out1.
//
//   `shape` morphs the shared waveform sine→saw→square (0..2), reused verbatim
//   from the LFO. inputs[0] = RESET: a rising edge (≥ 0.5) re-zeroes every
//   phase accumulator so all nine taps snap back to phase 0 together.
//
// The per-sample maths lives in ./lib/ninelives-dsp.ts so unit tests can
// source-import it without an AudioContext. IMPORTANT: this file does NOT
// `export` anything at the top level — a top-level export leaks into the
// bundled dist/ninelives.js + breaks ART's classic-script eval. The Processor
// registers via the `registerProcessor` side-effect only (see the
// dsp-worklet-no-top-level-export rule).

import { NineLivesCore, NINE_LIVES_OUTPUT_COUNT } from './lib/ninelives-dsp';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: typeof AudioWorkletProcessor
): void;

class NineLivesProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // out1 rate. Same range as the LFO (0.01 Hz .. 100 Hz). The web def maps
      // the knob log per the LFO's range→frequency mapping, so out1 behaves
      // identically to a normal LFO. Sample-and-held per block (see below).
      { name: 'rate',  defaultValue: 1, minValue: 0.01, maxValue: 100, automationRate: 'a-rate' as const },
      // Shared waveform morph: 0 = sine, 1 = saw, 2 = square (linear crossfade).
      // a-rate so the morph stays smooth, exactly like the LFO's `shape`.
      { name: 'shape', defaultValue: 0, minValue: 0,    maxValue: 2,   automationRate: 'a-rate' as const },
    ];
  }

  private core = new NineLivesCore();
  // Scratch buffer reused every block to avoid per-sample allocation.
  private scratch = new Float32Array(NINE_LIVES_OUTPUT_COUNT);

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const out0 = outputs[0]?.[0];
    if (!out0) return true;
    const blockLen = out0.length;
    const sr = sampleRate;

    const resetIn = inputs[0]?.[0];
    const rateArr = parameters.rate;
    const shapeArr = parameters.shape;

    // Sample-and-hold the rate at the start of each block (matches the LFO:
    // avoids audio-rate skew on the rate input). Shape stays a-rate so the
    // morph interpolates smoothly.
    const rateHeld = rateArr[0] ?? 0;

    const core = this.core;
    const scratch = this.scratch;

    for (let i = 0; i < blockLen; i++) {
      const shape = shapeArr.length > 1 ? (shapeArr[i] ?? 0) : (shapeArr[0] ?? 0);
      const resetSample = resetIn ? (resetIn[i] ?? 0) : 0;
      core.step(rateHeld, shape, resetSample, sr, scratch);
      for (let n = 0; n < NINE_LIVES_OUTPUT_COUNT; n++) {
        const o = outputs[n]?.[0];
        if (o) o[i] = scratch[n] ?? 0;
      }
    }
    return true;
  }
}

registerProcessor('ninelives', NineLivesProcessor);
