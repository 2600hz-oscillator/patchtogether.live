// packages/dsp/src/gatemaiden.ts
//
// GATEMAIDEN — single-input gate↔trigger converter worklet. The conversion
// logic (rising-edge detect → short trigger pulse + minimum-width derived gate)
// is pure + unit-tested in ./lib/gatemaiden-dsp.ts; this entry just wraps it in
// an AudioWorkletProcessor.
//
// IMPORTANT: this file does NOT `export` anything at the top level — top-level
// exports leak into the bundled dist/gatemaiden.js + break the ART
// classic-script eval. The Processor is registered via the registerProcessor
// side-effect; tests capture the class through a registerProcessor shim.
//
// Inputs (1 node connection, channel 0 read):
//   inputs[0] = in   — a gate OR a trigger (generic CV).
//
// Outputs (2 gate-style outs, 1 channel each):
//   outputs[0] = gate  — held square, min width gateLen (trigger→gate widening)
//   outputs[1] = trig  — short pulse on every rising edge (gate→trigger)

import {
  GateMaidenState,
  GATE_LEN_MIN,
  GATE_LEN_MAX,
  GATE_LEN_DEFAULT,
} from './lib/gatemaiden-dsp';

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
// captures the class via this shim — see gatemaiden.test.ts).
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
class GateMaidenProcessor extends AudioWorkletProcessor {
  private st: GateMaidenState;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.st = new GateMaidenState(sampleRate);
  }

  static get parameterDescriptors() {
    return [
      {
        name: 'gateLen',
        defaultValue: GATE_LEN_DEFAULT,
        minValue: GATE_LEN_MIN,
        maxValue: GATE_LEN_MAX,
        automationRate: 'k-rate' as const,
      },
      {
        name: 'trigShape',
        defaultValue: 0, // 0 = triangle, 1 = square
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate' as const,
      },
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
    const input = inputs[0]?.[0] ?? null;
    const gateOut = outputs[0]?.[0];
    const trigOut = outputs[1]?.[0];
    if (!gateOut || !trigOut) return true;
    const n = gateOut.length;

    const gateLen = this.kval(parameters, 'gateLen', GATE_LEN_DEFAULT);
    const trigShape = this.kval(parameters, 'trigShape', 0);

    for (let s = 0; s < n; s++) {
      const out = this.st.step(input ? input[s]! : 0, gateLen, trigShape);
      gateOut[s] = out.gate;
      trigOut[s] = out.trig;
    }
    return true;
  }
}

registerProcessor('gatemaiden', GateMaidenProcessor);
