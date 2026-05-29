// packages/dsp/src/resofilter.ts
//
// RESOFILTER — multi-mode filter port of Resonarium's MultiFilter
// (gabrielsoule/resonarium, Source/dsp/MultiFilter.{h,cpp}). 5 active
// modes: LP / HP / BP / Notch / Allpass (Resonarium's filterTextFunction
// short tags). See ./lib/resofilter-dsp.ts for the topology + mode rationale.
//
// IMPORTANT: this file does NOT `export` anything at the top level —
// top-level exports leak into the bundled dist/<name>.js + break the ART
// classic-script eval. The Processor class is registered via the
// `registerProcessor` side-effect. The tests capture the class through a
// registerProcessor shim before importing this module.
//
// Inputs (3 audio-rate node connections):
//   inputs[0] = audio       — signal in (stereo: 1 or 2 channels)
//   inputs[1] = cutoff_cv   — UNUSED at the worklet (CV is summed into the
//                              `cutoff` AudioParam by the web factory)
//   inputs[2] = reso_cv     — likewise summed into `resonance` AudioParam
//
// Outputs (2 audio-rate, 1 channel each):
//   outputs[0] = out_l
//   outputs[1] = out_r
//
// Stereo: if the input has a single channel, both filter channels run the
// same sample so out_l == out_r (the filter is intrinsically mono in
// upstream Resonarium too — we just duplicate state to keep the L/R outs
// independent for downstream stereo paths).

import {
  ResofilterChannel,
  RESOFILTER_MAX_MODE,
  type ResofilterMode,
} from './lib/resofilter-dsp';

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
// captures the class via this shim — see the resofilter.test.ts loader).
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
class ResofilterProcessor extends AudioWorkletProcessor {
  private chL: ResofilterChannel;
  private chR: ResofilterChannel;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.chL = new ResofilterChannel(sampleRate);
    this.chR = new ResofilterChannel(sampleRate);
  }

  static get parameterDescriptors() {
    return [
      // CUTOFF — a-rate so cutoff_cv summed into this AudioParam reaches the
      // SVF coefficient on every sample. The worklet's internal one-pole
      // smoother (RfSmoother, 50 Hz corner) prevents the steep transfer
      // function from clicking on rapid CV jumps.
      { name: 'cutoff',    defaultValue: 1000, minValue: 20, maxValue: 20000, automationRate: 'a-rate' as const },
      // RESONANCE — a-rate; res_cv writes here too.
      { name: 'resonance', defaultValue: 0.3,  minValue: 0,  maxValue: 1,     automationRate: 'a-rate' as const },
      // MODE — k-rate (discrete). Switching is free of pops because the SVF
      // state is shared across all five characters (the mode is a pure
      // output picker — see lib/resofilter-dsp.ts).
      { name: 'mode',      defaultValue: 0,    minValue: 0,  maxValue: RESOFILTER_MAX_MODE, automationRate: 'k-rate' as const },
      // MIX — k-rate; 0 = dry, 1 = wet.
      { name: 'mix',       defaultValue: 1,    minValue: 0,  maxValue: 1,     automationRate: 'k-rate' as const },
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
    const inAudio = inputs[0] ?? [];
    const inL = inAudio[0] ?? null;
    const inR = inAudio[1] ?? inAudio[0] ?? null;
    const outL = outputs[0]?.[0];
    const outR = outputs[1]?.[0];
    if (!outL || !outR) return true;
    const n = outL.length;

    // k-rate block constants.
    const modeRaw = this.kval(parameters, 'mode', 0);
    const mode = (Math.max(0, Math.min(RESOFILTER_MAX_MODE, Math.round(modeRaw)))) as ResofilterMode;
    const mix = this.kval(parameters, 'mix', 1);
    const sr = sampleRate;

    for (let s = 0; s < n; s++) {
      const cutoff = this.aval(parameters, 'cutoff', s, 1000);
      const res = this.aval(parameters, 'resonance', s, 0.3);
      const xL = inL?.[s] ?? 0;
      const xR = inR?.[s] ?? xL;
      outL[s] = this.chL.step(xL, cutoff, res, mode, mix, sr);
      outR[s] = this.chR.step(xR, cutoff, res, mode, mix, sr);
    }

    return true;
  }
}

registerProcessor('resofilter', ResofilterProcessor);
