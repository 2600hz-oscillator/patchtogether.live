// packages/dsp/src/sample-hold.ts
//
// SAMPLE & HOLD / quantizer — the AudioWorklet processor.
//
// Two CV outputs from two inputs:
//   * cv_out   — the HELD (or, ungated, the live passed-through) value.
//   * cv_quant — that same value snapped to the nearest note of the
//                selected scale (1V/oct, root = C / 0V).
//
// Behaviour (pure maths in ./lib/sample-hold-dsp.ts):
//   * gate_in PATCHED  → on a RISING EDGE of gate_in, latch cv_in; hold it on
//                        cv_out until the next rising edge. (classic S&H)
//   * gate_in UNPATCHED → cv_in passes through continuously, so the module is a
//                         pure QUANTIZER. The web factory detects "is gate_in
//                         connected?" at the GRAPH level (mirroring the
//                         SKIFREE/SEQUENCER unpatched-input pattern) and feeds
//                         a k-rate `gateConnected` AudioParam (1 = patched).
//
// IMPORTANT: this file does NOT `export` anything at the top level — a
// top-level export leaks into the bundled dist/sample-hold.js and breaks the
// ART classic-script eval. The Processor registers via the `registerProcessor`
// side-effect; tests capture the class through a registerProcessor shim (see
// packages/web/src/lib/audio/modules/sample-hold.test.ts) OR exercise the pure
// maths in ./lib/sample-hold-dsp.ts directly.
//
// Inputs (single-channel CV/gate node connections):
//   inputs[0] = cv_in    — value to sample/quantize.
//   inputs[1] = gate_in  — gate/clock; rising edge latches.
//
// Outputs (two single-channel CV outputs):
//   outputs[0] = cv_out    (held / passed-through value)
//   outputs[1] = cv_quant  (cv_out snapped to the selected scale)

import { quantizeVoltage, GATE_THRESHOLD } from './lib/sample-hold-dsp';

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

// Shim worklet globals when running outside AudioWorkletGlobalScope (vitest
// captures the class via this shim — see the sample-hold.test.ts loader). In
// the real worklet these globals already exist, so the guards are no-ops.
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

class SampleHoldProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Selected scale index (0..N-1). k-rate — switching scales mid-render is
      // pop-free since the quantizer is a pure output picker.
      { name: 'scale', defaultValue: 1, minValue: 0, maxValue: 32, automationRate: 'k-rate' as const },
      // 1 = gate_in is patched (sample & hold). 0 = unpatched (pure quantizer:
      // cv passes through continuously). Set by the web factory at the graph
      // level — the worklet can't see the patch topology, only its inputs.
      { name: 'gateConnected', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
    ];
  }

  // The latched value (cv_out when gated).
  private held = 0;
  // Rising-edge detector state for gate_in.
  private prevGate = 0;

  constructor(options?: { processorOptions?: { initialHeld?: number } }) {
    super(options);
    const ih = options?.processorOptions?.initialHeld;
    if (typeof ih === 'number' && Number.isFinite(ih)) this.held = ih;
    void sampleRate;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const cvIn = inputs[0]?.[0];
    const gateIn = inputs[1]?.[0];

    const cvOut = outputs[0]?.[0];
    const quantOut = outputs[1]?.[0];
    if (!cvOut || !quantOut) return true;

    const N = cvOut.length;
    const scaleIdx = parameters.scale[0]!;
    const gateConnected = parameters.gateConnected[0]! >= 0.5;

    if (!gateConnected) {
      // ── Pure QUANTIZER: pass cv_in straight through; quantize live. ──
      for (let i = 0; i < N; i++) {
        const x = cvIn ? cvIn[i]! : 0;
        this.held = x; // keep `held` tracking the live input so a later
                       // gate-connect starts from the current value.
        cvOut[i] = x;
        quantOut[i] = quantizeVoltage(x, scaleIdx);
      }
      // No gate edges in this mode; keep prevGate at 0 so the first edge after
      // a (re)connect is detected cleanly.
      this.prevGate = 0;
      return true;
    }

    // ── SAMPLE & HOLD: latch on a rising edge of gate_in. ──
    // Quantize once per block when the value is steady; only re-quantize the
    // samples after an edge changes `held`. Cheap to just compute the quantized
    // held value lazily — but a per-edge recompute keeps it simple + correct.
    let quantHeld = quantizeVoltage(this.held, scaleIdx);
    for (let i = 0; i < N; i++) {
      const x = cvIn ? cvIn[i]! : 0;
      const g = gateIn ? gateIn[i]! : 0;
      if (g >= GATE_THRESHOLD && this.prevGate < GATE_THRESHOLD) {
        this.held = x;
        quantHeld = quantizeVoltage(this.held, scaleIdx);
      }
      this.prevGate = g;
      cvOut[i] = this.held;
      quantOut[i] = quantHeld;
    }
    return true;
  }
}

registerProcessor('sample-hold', SampleHoldProcessor);
