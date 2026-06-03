// packages/dsp/src/moog911a.ts
//
// MOOG 911A DUAL TRIGGER DELAY — two independent trigger delays with a
// coupling MODE. A gate on an input is detected on its RISING edge; after a
// programmed delay the corresponding output emits a short (~1 ms) pulse.
//
//   OFF      (mode 0) — independent: trig1→delay1→out1, trig2→delay2→out2.
//   PARALLEL (mode 1) — trig1 fires BOTH delays (out1 after d1, out2 after d2).
//   SERIES   (mode 2) — trig1→d1→out1; out1's pulse → d2 → out2 (chain).
//
// The timing state machine is pure + unit-tested in
// ./lib/trigger-delay-dsp.ts (DualTriggerDelay); this entry just wraps it in
// an AudioWorkletProcessor, converting the seconds-domain delay params to
// samples via the worklet's `sampleRate` global.
//
// IMPORTANT: this file does NOT `export` anything at the top level — top-level
// exports leak into the bundled dist/moog911a.js + break the ART classic-
// script eval. The Processor is registered via the `registerProcessor`
// side-effect (see resofilter.ts / the dsp-worklet-no-top-level-export note).
//
// Inputs (2 gate node connections):
//   inputs[0] = trig1 (gate)
//   inputs[1] = trig2 (gate)
// Outputs (2 gate, 1 channel each):
//   outputs[0] = out1 (gate)
//   outputs[1] = out2 (gate)

import {
  DualTriggerDelay,
  TRIGGER_DELAY_PULSE_S,
  TRIGGER_DELAY_MAX_MODE,
} from './lib/trigger-delay-dsp';

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
// captures the class via this shim — see moog911a.test.ts's loader).
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
class Moog911aProcessor extends AudioWorkletProcessor {
  private readonly dual: DualTriggerDelay;
  private readonly sr: number;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.sr = sampleRate;
    this.dual = new DualTriggerDelay(Math.round(TRIGGER_DELAY_PULSE_S * this.sr));
  }

  static get parameterDescriptors() {
    return [
      // DELAY 1 / DELAY 2 — seconds; a-rate so a moving knob is read live (it
      // only changes the armed countdown at the instant of a rising edge).
      { name: 'delay1', defaultValue: 0.1, minValue: 0.002, maxValue: 10, automationRate: 'a-rate' as const },
      { name: 'delay2', defaultValue: 0.1, minValue: 0.002, maxValue: 10, automationRate: 'a-rate' as const },
      // MODE — discrete 0..2 (OFF / PARALLEL / SERIES). k-rate.
      { name: 'mode',   defaultValue: 0,   minValue: 0,     maxValue: TRIGGER_DELAY_MAX_MODE, automationRate: 'k-rate' as const },
    ];
  }

  private kval(p: Record<string, Float32Array>, name: string, fallback: number): number {
    const arr = p[name];
    return arr && arr.length > 0 ? (arr[0] as number) : fallback;
  }
  private aval(p: Record<string, Float32Array>, name: string, s: number, fallback: number): number {
    const arr = p[name];
    if (!arr || arr.length === 0) return fallback;
    return (arr.length > 1 ? arr[s] : arr[0]) as number;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const in1 = inputs[0]?.[0] ?? null; // trig1
    const in2 = inputs[1]?.[0] ?? null; // trig2
    const out1 = outputs[0]?.[0];
    const out2 = outputs[1]?.[0];
    if (!out1 || !out2) return true;
    const n = out1.length;

    // k-rate mode for the whole block.
    const mode = Math.round(this.kval(parameters, 'mode', 0));

    for (let s = 0; s < n; s++) {
      const d1Samples = this.aval(parameters, 'delay1', s, 0.1) * this.sr;
      const d2Samples = this.aval(parameters, 'delay2', s, 0.1) * this.sr;
      const [o1, o2] = this.dual.step(
        in1 ? in1[s] : 0,
        in2 ? in2[s] : 0,
        d1Samples,
        d2Samples,
        mode,
      );
      out1[s] = o1;
      out2[s] = o2;
    }
    return true;
  }
}

registerProcessor('moog911a', Moog911aProcessor);
