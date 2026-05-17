// packages/dsp/src/stages.ts
//
// STAGES — 6-segment cascadable function generator (Mutable Instruments
// Stages archetype, Émilie Gillet, 2017, MIT-licensed). AudioWorklet
// wrapper around StagesEngine — the engine itself lives in
// packages/dsp/src/stages-engine.ts so the host-side module def +
// vitest pass can reuse it without duplication. Clean-room interpretation
// of segment_generator.{h,cc} + chain_state.{h,cc} from eurorack/stages/:
// hardware's inter-module serial-link discovery collapsed into a single
// 6-segment module with 5 in-process link bits, and hysteresis-quantized
// step direction modes deferred (Outliner / chord mode / looping LFO are
// listed as v1 stretch — see README/PR body).
//
// Per-segment TYPEs (matches hardware's RAMP/HOLD/STEP enum):
//   0  RAMP  — phase 0→1 over TIME seconds; output = WarpPhase(phase, SHAPE).
//   1  HOLD  — constant LEVEL output, with SHAPE-controlled portamento.
//   2  STEP  — sample-and-hold of LEVEL on each gate rising edge.
//
// I/O surface:
//   inputs:
//     gate0..gate5    audio-rate per-segment trigger (rising edge → fire
//                     that segment's chain group, IFF it's the leader)
//     trig            global trigger — fires every chain's leader
//   outputs:
//     out0..out5      per-segment CV output (each segment mirrors its
//                     chain group's current value, so a chain's CV is
//                     readable from any of its segments' outputs).

import {
  STAGES_NUM_SEGMENTS,
  STAGES_NUM_LINKS,
  STAGES_NUM_TYPES,
  TYPE_RAMP,
  StagesEngine,
} from './stages-engine';

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

class StagesProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const descs: Array<{
      name: string;
      defaultValue: number;
      minValue: number;
      maxValue: number;
      automationRate: 'a-rate' | 'k-rate';
    }> = [];
    for (let i = 0; i < STAGES_NUM_SEGMENTS; i++) {
      descs.push({
        name: `type${i}`,
        defaultValue: TYPE_RAMP,
        minValue: 0,
        maxValue: STAGES_NUM_TYPES - 1,
        automationRate: 'k-rate',
      });
      descs.push({
        name: `primary${i}`,
        defaultValue: 0.3,
        minValue: -1,
        maxValue: 1,
        automationRate: 'a-rate',
      });
      descs.push({
        name: `shape${i}`,
        defaultValue: 0.5,
        minValue: 0,
        maxValue: 1,
        automationRate: 'a-rate',
      });
    }
    for (let i = 0; i < STAGES_NUM_LINKS; i++) {
      descs.push({
        name: `link${i}`,
        defaultValue: 0,
        minValue: 0,
        maxValue: 1,
        automationRate: 'k-rate',
      });
    }
    return descs;
  }

  private engine = new StagesEngine(sampleRate);
  private gateBuf = new Float32Array(STAGES_NUM_SEGMENTS);

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out0 = outputs[0]?.[0];
    if (!out0) return true;
    const n = out0.length;

    for (let i = 0; i < STAGES_NUM_SEGMENTS; i++) {
      const t = parameters[`type${i}`]?.[0];
      if (t !== undefined) this.engine.setSegmentType(i, t);
    }
    let linksDirty = false;
    for (let i = 0; i < STAGES_NUM_LINKS; i++) {
      const v = (parameters[`link${i}`]?.[0] ?? 0) >= 0.5;
      if (this.engine.links[i] !== v) {
        this.engine.links[i] = v;
        linksDirty = true;
      }
    }
    if (linksDirty) this.engine.rebuildGroups();

    const primArrs: Float32Array[] = [];
    const shapeArrs: Float32Array[] = [];
    for (let i = 0; i < STAGES_NUM_SEGMENTS; i++) {
      primArrs.push(parameters[`primary${i}`]!);
      shapeArrs.push(parameters[`shape${i}`]!);
    }

    const segGateInputs: Array<Float32Array | undefined> = [];
    for (let i = 0; i < STAGES_NUM_SEGMENTS; i++) {
      segGateInputs.push(inputs[i]?.[0]);
    }
    const globalTrigArr = inputs[STAGES_NUM_SEGMENTS]?.[0];

    const segOuts: Array<Float32Array | undefined> = [];
    for (let i = 0; i < STAGES_NUM_SEGMENTS; i++) {
      segOuts.push(outputs[i]?.[0]);
    }

    for (let i = 0; i < n; i++) {
      for (let s = 0; s < STAGES_NUM_SEGMENTS; s++) {
        const p = primArrs[s]!;
        const sh = shapeArrs[s]!;
        this.engine.setSegmentPrimary(s, p.length > 1 ? (p[i] ?? 0.3) : (p[0] ?? 0.3));
        this.engine.setSegmentShape(s, sh.length > 1 ? (sh[i] ?? 0.5) : (sh[0] ?? 0.5));
      }
      for (let s = 0; s < STAGES_NUM_SEGMENTS; s++) {
        const arr = segGateInputs[s];
        this.gateBuf[s] = arr ? (arr[i] ?? 0) : 0;
      }
      const gt = globalTrigArr ? (globalTrigArr[i] ?? 0) : 0;
      const vals = this.engine.tick(this.gateBuf, gt);
      for (let s = 0; s < STAGES_NUM_SEGMENTS; s++) {
        const o = segOuts[s];
        if (o) o[i] = vals[s] ?? 0;
      }
    }
    return true;
  }
}

registerProcessor('stages', StagesProcessor);
