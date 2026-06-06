// packages/dsp/src/moog905.ts
//
// MOOG 905 SPRING REVERBERATION — AudioWorklet entry. Wraps the in-house
// SpringReverb tank (./lib/spring-reverb-dsp.ts) and applies the dry/wet MIX
// here so the lib stays a pure wet generator.
//
// IMPORTANT: this file does NOT `export` anything at the top level — top-level
// exports leak into the bundled dist/moog905.js + break the ART classic-script
// eval. The Processor class is registered via the `registerProcessor`
// side-effect; the tests capture the class through a registerProcessor shim
// (mirrors resofilter.ts exactly).
//
// Inputs (1 audio-rate node connection):
//   inputs[0] = audio — dry signal in (mono; first channel used).
//
// Outputs (1 audio-rate, 1 channel):
//   outputs[0] = audio — dry/wet mix (dry = input, wet = spring reverb).
//
// Params (all k-rate; fine for a reverb's macro knobs):
//   mix   0..1 — dry↔wet blend (0 = dry, 1 = wet).
//   decay 0..1 — tail length / feedback.
//   size  0..1 — spring length / dispersion character.

import { SpringReverb } from './lib/spring-reverb-dsp';

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
// captures the class via this shim — see moog905.test.ts's loader).
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

// Not `export`ed at the top level by design — see the file-header note.
class Moog905Processor extends AudioWorkletProcessor {
  private spring: SpringReverb;
  // Cache the last decay/size we pushed so we only re-derive coefficients on
  // an actual change.
  private lastDecay = NaN;
  private lastSize = NaN;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.spring = new SpringReverb(sampleRate);
  }

  static get parameterDescriptors() {
    return [
      { name: 'mix',   defaultValue: 0.35, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'decay', defaultValue: 0.6,  minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'size',  defaultValue: 0.5,  minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
    ];
  }

  private kval(p: Record<string, Float32Array>, name: string, fallback: number): number {
    const arr = p[name];
    return arr && arr.length > 0 ? (arr[0] as number) : fallback;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const inAudio = inputs[0] ?? [];
    const inCh = inAudio[0] ?? null;
    const n = out.length;

    const mix = this.kval(parameters, 'mix', 0.35);
    const decay = this.kval(parameters, 'decay', 0.6);
    const size = this.kval(parameters, 'size', 0.5);

    // Re-derive coefficients only when decay/size actually move.
    if (decay !== this.lastDecay || size !== this.lastSize) {
      this.spring.setParams({ decay, size });
      this.lastDecay = decay;
      this.lastSize = size;
    }

    const dryGain = 1 - mix;
    const wetGain = mix;
    for (let s = 0; s < n; s++) {
      const x = inCh?.[s] ?? 0;
      const wet = this.spring.step(x);
      out[s] = x * dryGain + wet * wetGain;
    }

    return true;
  }
}

registerProcessor('moog905', Moog905Processor);
