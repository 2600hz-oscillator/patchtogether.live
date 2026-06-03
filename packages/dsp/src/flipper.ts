// packages/dsp/src/flipper.ts
//
// FLIPPER — a gate flip-flop. A gate on EITHER input alternately fires the
// FLIP output, then the FLOP output, then back. No params. The toggle logic
// lives in ./lib/flipper-dsp.ts (pure + unit-tested); this entry just wraps it
// in an AudioWorkletProcessor.
//
// IMPORTANT: this file does NOT `export` anything at the top level — top-level
// exports leak into the bundled dist/flipper.js + break the ART classic-script
// eval. The Processor is registered via the `registerProcessor` side-effect.
import { FlipperState } from './lib/flipper-dsp';

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

// Shim worklet globals when running outside AudioWorkletGlobalScope (vitest).
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
class FlipperProcessor extends AudioWorkletProcessor {
  private st = new FlipperState();

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const in1 = inputs[0]?.[0] ?? null; // gate input 1
    const in2 = inputs[1]?.[0] ?? null; // gate input 2
    const flip = outputs[0]?.[0];
    const flop = outputs[1]?.[0];
    if (!flip || !flop) return true;
    const n = flip.length;
    for (let s = 0; s < n; s++) {
      const [f, g] = this.st.step(in1 ? in1[s] : 0, in2 ? in2[s] : 0);
      flip[s] = f;
      flop[s] = g;
    }
    return true;
  }
}

registerProcessor('flipper', FlipperProcessor);
