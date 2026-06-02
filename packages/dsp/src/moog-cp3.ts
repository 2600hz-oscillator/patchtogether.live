// packages/dsp/src/moog-cp3.ts
//
// MOOG CP3 / CP3A CONSOLE PANEL (mixer) AudioWorkletProcessor.
//
// CP3 console mixer slice of the Moog System 55 / 35 clone initiative
// (.myrobots/MOOG/). Shared by BOTH systems (registered under SYS55, the
// shared bucket, per the resolved Q4 decision in .myrobots/MOOG/PLAN.md).
//
// DSP is OWN CODE — a forked + expanded version of the repo's `mixer`
// (own code, permissive; .myrobots/MOOG/LICENSING.md), not a port of any
// Moog schematic / copyleft source. The math core lives in
// ./lib/moog-cp3-dsp.ts so the worklet, the unit tests, and node-side ART
// share the exact same code.
//
// The CP3 is a multi-function console mixer:
//   (1) primary 4×1 mixer with a (+) output AND a (−) phase-inverted
//       output; max per-channel gain ×2; mixes AC and/or DC (audio + CV);
//   (2) the 4th input adds an external jack (ext4) + an ATTENUATOR — at
//       "10" (1.0) the attenuator is unity so a direct patch passes
//       through unaltered;
//   (3) a MULTIPLE — input in1 fanned out to three identical passthrough
//       outs (mult1 / mult2 / mult3), independent of the mixer bus;
//   (4) trunk / reference jacks — a constant +12 V and −6 V reference,
//       scaled into the project's normalized CV convention.
//
// IMPORTANT: this file does NOT `export` anything at the top level —
// top-level exports leak into the bundled dist/<name>.js + break the ART
// classic-script eval. The Processor class is registered via the
// `registerProcessor` side-effect; tests capture it through a
// registerProcessor shim before importing. (memory:
// dsp-worklet-no-top-level-export)
//
// Inputs (audio-rate node connections; mixer accepts audio AND cv):
//   inputs[0] = in1   (channel 1)
//   inputs[1] = in2   (channel 2)
//   inputs[2] = in3   (channel 3)
//   inputs[3] = in4   (channel 4 — panel jack)
//   inputs[4] = ext4  (channel 4 — external jack, summed with in4 then
//                      scaled by the 4th-input ATTENUATOR)
//
// AudioParams:
//   ch1..ch4     per-channel level (0..1 knob → 0..×2 gain)
//   attenuator4  4th-input attenuator (0..1; 1.0 = unity)
//
// Outputs (each mono):
//   outputs[0] = out_pos   (+) summed bus
//   outputs[1] = out_neg   (−) phase-inverted summed bus
//   outputs[2] = mult1     in1 passthrough
//   outputs[3] = mult2     in1 passthrough
//   outputs[4] = mult3     in1 passthrough
//   outputs[5] = plus12    constant +12 V reference (normalized)
//   outputs[6] = minus6    constant −6 V reference (normalized)

import {
  cp3ChannelGain,
  cp3Attenuator,
  cp3Mix,
  CP3_PLUS_12V,
  CP3_MINUS_6V,
} from './lib/moog-cp3-dsp';
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
// captures the class via this shim — see the moog-cp3 DSP test loader).
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
class MoogCp3Processor extends AudioWorkletProcessor {
  private sr: number;

  // 80 Hz one-pole smoothers on the knobs keep CV zipper out of the audio
  // path on knob drags (same pattern as the 921 VCO).
  private smCh1: WtParamSmoother;
  private smCh2: WtParamSmoother;
  private smCh3: WtParamSmoother;
  private smCh4: WtParamSmoother;
  private smAtten4: WtParamSmoother;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.sr = sampleRate;
    this.smCh1 = new WtParamSmoother(this.sr);
    this.smCh2 = new WtParamSmoother(this.sr);
    this.smCh3 = new WtParamSmoother(this.sr);
    this.smCh4 = new WtParamSmoother(this.sr);
    this.smAtten4 = new WtParamSmoother(this.sr);
    this.smCh1.prime(1);
    this.smCh2.prime(1);
    this.smCh3.prime(1);
    this.smCh4.prime(1);
    this.smAtten4.prime(1);
  }

  static get parameterDescriptors() {
    return [
      { name: 'ch1',         defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'ch2',         defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'ch3',         defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'ch4',         defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      // 4th-input attenuator. 1.0 = unity (direct patch passes unaltered).
      { name: 'attenuator4', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
    ];
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const outPos = outputs[0]?.[0];
    const outNeg = outputs[1]?.[0];
    const outM1 = outputs[2]?.[0];
    const outM2 = outputs[3]?.[0];
    const outM3 = outputs[4]?.[0];
    const outPlus12 = outputs[5]?.[0];
    const outMinus6 = outputs[6]?.[0];

    const in1 = inputs[0]?.[0];
    const in2 = inputs[1]?.[0];
    const in3 = inputs[2]?.[0];
    const in4 = inputs[3]?.[0];
    const ext4 = inputs[4]?.[0];

    const ch1Arr = parameters.ch1;
    const ch2Arr = parameters.ch2;
    const ch3Arr = parameters.ch3;
    const ch4Arr = parameters.ch4;
    const atten4Arr = parameters.attenuator4;

    // Size the block from any wired output (all share length 128).
    const ref =
      outPos ?? outNeg ?? outM1 ?? outM2 ?? outM3 ?? outPlus12 ?? outMinus6;
    if (!ref) return true; // nothing wired this block; keep alive.
    const blockLen = ref.length;

    for (let i = 0; i < blockLen; i++) {
      const ch1 = cp3ChannelGain(this.smCh1.step(ch1Arr.length > 1 ? ch1Arr[i] : ch1Arr[0]));
      const ch2 = cp3ChannelGain(this.smCh2.step(ch2Arr.length > 1 ? ch2Arr[i] : ch2Arr[0]));
      const ch3 = cp3ChannelGain(this.smCh3.step(ch3Arr.length > 1 ? ch3Arr[i] : ch3Arr[0]));
      const ch4 = cp3ChannelGain(this.smCh4.step(ch4Arr.length > 1 ? ch4Arr[i] : ch4Arr[0]));
      const atten4 = cp3Attenuator(this.smAtten4.step(atten4Arr.length > 1 ? atten4Arr[i] : atten4Arr[0]));

      const s1 = in1 ? in1[i] : 0;
      const s2 = in2 ? in2[i] : 0;
      const s3 = in3 ? in3[i] : 0;
      const s4 = in4 ? in4[i] : 0;
      const sExt4 = ext4 ? ext4[i] : 0;

      const { pos, neg } = cp3Mix(s1, s2, s3, s4, sExt4, ch1, ch2, ch3, ch4, atten4);

      if (outPos) outPos[i] = pos;
      if (outNeg) outNeg[i] = neg;
      // The MULTIPLE: in1 fanned out unaltered to three outs.
      if (outM1) outM1[i] = s1;
      if (outM2) outM2[i] = s1;
      if (outM3) outM3[i] = s1;
      // Trunk / reference voltage rails (constant).
      if (outPlus12) outPlus12[i] = CP3_PLUS_12V;
      if (outMinus6) outMinus6[i] = CP3_MINUS_6V;
    }

    return true;
  }
}

registerProcessor('moog-cp3', MoogCp3Processor);
