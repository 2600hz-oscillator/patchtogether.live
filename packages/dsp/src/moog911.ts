// packages/dsp/src/moog911.ts
//
// MOOG 911 ENVELOPE GENERATOR — Moog System 55/35 contour generator
// AudioWorkletProcessor.
//
// Slice 3 of the Moog System 55 / 35 clone initiative (.myrobots/MOOG/),
// after the 921 VCO (slice 1). The 911 ships in both systems (S35 ×3,
// S55 ×6) so it's categorized under Moog → SYS55 (the shared bucket).
//
// This is NOT a literal A-D-S-R. The real 911 is a THREE-time-constant
// CONTOUR generator with a single sustain LEVEL — see lib/moog911-eg-dsp.ts
// for the stage diagram + algorithm. The per-sample contour math lives in
// that pure core (Moog911Eg) so the SHIPPED DSP is unit-tested
// (lib/moog911-eg-dsp.test.ts); this worklet just wires audio I/O to it.
//
// IMPORTANT: this file does NOT `export` anything at the top level —
// top-level exports leak into the bundled dist/<name>.js + break the ART
// classic-script eval. The Processor class is registered via the
// `registerProcessor` side-effect; tests capture it through a
// registerProcessor shim before importing. (memory:
// dsp-worklet-no-top-level-export). The core is `lib/`-scoped so the dist
// build doesn't treat it as a worklet entry; esbuild `bundle:true` inlines
// it at no runtime cost.
//
// Inputs (audio-rate node connections):
//   inputs[0] = gate  (S-trigger; >= 0.5 = gate high / contour running,
//                      < 0.5 = gate low / final decay)
//
// AudioParams (CV is summed in by the web factory as a-rate signals):
//   t1   (attack time, seconds — log range)
//   t2   (initial-decay time, seconds — log range)
//   esus (sustain level, 0..1 — linear)
//   t3   (final-decay time, seconds — log range)
//
// Outputs (each mono):
//   outputs[0] = env      (the contour, 0..1)
//   outputs[1] = env_inv  (1 - env — inverted tap for ducking / sidechain)

import { Moog911Eg, GATE_THRESHOLD, MIN_TIME_S } from './lib/moog911-eg-dsp';

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
// captures the class via this shim — see moog911 DSP test loader).
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
class Moog911Processor extends AudioWorkletProcessor {
  private eg: Moog911Eg;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.eg = new Moog911Eg(sampleRate);
  }

  static get parameterDescriptors() {
    return [
      // T1 — ATTACK time. Up to 10 s per the 911 spec.
      { name: 't1', defaultValue: 0.01, minValue: MIN_TIME_S, maxValue: 10, automationRate: 'a-rate' as const },
      // T2 — INITIAL DECAY time. ~2 ms minimum .. 10 s.
      { name: 't2', defaultValue: 0.2, minValue: MIN_TIME_S, maxValue: 10, automationRate: 'a-rate' as const },
      // Esus — SUSTAIN LEVEL (0..1).
      { name: 'esus', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      // T3 — FINAL DECAY time. Up to 10 s.
      { name: 't3', defaultValue: 0.4, minValue: MIN_TIME_S, maxValue: 10, automationRate: 'a-rate' as const },
    ];
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const envOut = outputs[0]?.[0];
    const invOut = outputs[1]?.[0];
    // No output buffers wired this block — nothing to do, but keep alive.
    if (!envOut && !invOut) return true;

    const gateIn = inputs[0]?.[0];
    const t1Arr = parameters.t1;
    const t2Arr = parameters.t2;
    const esusArr = parameters.esus;
    const t3Arr = parameters.t3;

    const blockLen = (envOut ?? invOut)!.length;

    for (let i = 0; i < blockLen; i++) {
      const t1 = t1Arr.length > 1 ? t1Arr[i] : t1Arr[0];
      const t2 = t2Arr.length > 1 ? t2Arr[i] : t2Arr[0];
      const esus = esusArr.length > 1 ? esusArr[i] : esusArr[0];
      const t3 = t3Arr.length > 1 ? t3Arr[i] : t3Arr[0];

      const gate = (gateIn ? gateIn[i] : 0) >= GATE_THRESHOLD;
      const level = this.eg.step(gate, t1, t2, esus, t3);

      if (envOut) envOut[i] = level;
      // Inverted tap: 1 - env (ducking / sidechain semantic, matching ADSR).
      if (invOut) invOut[i] = 1 - level;
    }

    return true;
  }
}

registerProcessor('moog911', Moog911Processor);
