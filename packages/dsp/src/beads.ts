// The official Beads C++ DSP, compiled to WASM; see native/beads/README.md.
import { BEADS_CONTROLS, BEADS_INPUTS, type BeadsExports } from "./lib/beads-contract";
import { GATE_HI } from "../../web/src/lib/audio/gate-trigger";

export class BeadsProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return BEADS_CONTROLS.map(p => ({
      name: p.id, minValue: p.min, maxValue: p.max,
      defaultValue: p.defaultValue, automationRate: "k-rate",
    }));
  }
  private readonly wasm: BeadsExports;
  private readonly input: Float32Array[];
  private readonly output: Float32Array[];
  private readonly controls: Float32Array;
  private disposed = false;

  constructor(options: { processorOptions: { wasm: WebAssembly.Module; seed?: number } }) {
    super();
    this.wasm = new WebAssembly.Instance(options.processorOptions.wasm, {}).exports as BeadsExports;
    this.wasm._initialize();
    this.wasm.beads_init(sampleRate, options.processorOptions.seed ?? 0xBEAD5);
    const memory = this.wasm.memory.buffer;
    this.input = BEADS_INPUTS.map((_, i) => new Float32Array(memory, this.wasm.beads_input() + i * 128 * 4, 128));
    this.output = [0, 1].map(i => new Float32Array(memory, this.wasm.beads_output() + i * 128 * 4, 128));
    this.controls = new Float32Array(memory, this.wasm.beads_controls(), BEADS_CONTROLS.length);
    this.port.onmessage = event => { if (event.data === "dispose") this.disposed = true; };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean {
    if (this.disposed) return false;
    let mask = 0;
    for (let channel = 0; channel < this.input.length; ++channel) {
      const source = inputs[channel]?.[0];
      if (source) {
        mask |= 1 << channel;
        this.input[channel]!.set(source);
      } else {
        this.input[channel]!.fill(0);
      }
    }
    // Right normals to left ONLY when absent; a connected silent R stays R.
    const right = inputs[1]?.[0] ?? inputs[0]?.[0];
    if (right) this.input[1]!.set(right);
    for (let i = 0; i < BEADS_CONTROLS.length; ++i) {
      const p = BEADS_CONTROLS[i]!;
      const value = parameters[p.id]?.[0] ?? p.defaultValue;
      this.controls[i] = Math.max(p.min, Math.min(p.max, i >= 12 ? Math.round(value) : value));
    }
    this.wasm.beads_process(mask, GATE_HI);
    outputs[0]?.[0]?.set(this.output[0]!);
    outputs[1]?.[0]?.set(this.output[1]!);
    return true;
  }
}
registerProcessor("beads", BeadsProcessor);
