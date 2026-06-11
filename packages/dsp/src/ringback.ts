// packages/dsp/src/ringback.ts
//
// RINGBACK — AudioWorklet wrapper around RingChannel (see ringback-core.ts for
// the full per-sample DSP + the derivation from the TWOTRACKS record artifact).
//
// Stereo in (L/R) → stereo out (L/R). Two RingChannels (one per channel) run the
// exact crush mechanism the owner loved: integer-cell varispeed write + a
// fractional interpolated read-back at the same cursor + optional feedback into
// the ring, dry/wet at the output.
//
// Params (a-rate so they take CV / smooth automation):
//   rate     — write/read cursor advance per sample (the crush "amount"):
//              1 = mildest, <1 stair-steps + aliases hardest, up to 4.
//   size     — ring length in samples (2..4096): small = comb/ring, large = grainy smear.
//   feedback — read-back re-injected into the ring (0..0.98, clamped < 1 so it can't blow up).
//   mix      — dry/wet (0 = clean input, 1 = full crush).
//
// IMPORTANT: this file does NOT export the Processor class at the top level —
// a top-level export pollutes the bundled dist/<name>.js worklet and breaks the
// ART harness's classic-script eval (see charlottes-echos.ts / twotracks.ts).
// The class is reached via its registerProcessor side-effect only.

import { RingChannel, RINGBACK_MAX_SIZE } from './lib/ringback-core';

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

// Shim the worklet globals when running outside AudioWorkletGlobalScope
// (vitest). Guarded so the real runtime is untouched.
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

class RingbackProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rate',     defaultValue: 0.5, minValue: 0.05, maxValue: 4,    automationRate: 'a-rate' as const },
      { name: 'size',     defaultValue: 64,  minValue: 2,    maxValue: RINGBACK_MAX_SIZE, automationRate: 'a-rate' as const },
      { name: 'feedback', defaultValue: 0.3, minValue: 0,    maxValue: 0.98, automationRate: 'a-rate' as const },
      { name: 'mix',      defaultValue: 1,   minValue: 0,    maxValue: 1,    automationRate: 'a-rate' as const },
    ];
  }

  private chL = new RingChannel(RINGBACK_MAX_SIZE);
  private chR = new RingChannel(RINGBACK_MAX_SIZE);

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    // input[0] = L, input[1] = R (mono in → mirror to both channels).
    const inL = inputs[0]?.[0];
    const inR = inputs[1]?.[0] ?? inL;
    const outL = outputs[0]?.[0];
    const outR = outputs[0]?.[1];
    if (!outL && !outR) return true;

    const frames = outL?.length ?? outR?.length ?? 0;

    const pr = parameters.rate!;
    const ps = parameters.size!;
    const pf = parameters.feedback!;
    const pm = parameters.mix!;
    const av = (arr: Float32Array, i: number): number =>
      (arr.length > 1 ? (arr[i] ?? arr[0]) : arr[0]) ?? 0;

    for (let i = 0; i < frames; i++) {
      const rate = av(pr, i);
      const size = av(ps, i);
      const fb = av(pf, i);
      const mix = av(pm, i);

      const xL = inL ? (inL[i] ?? 0) : 0;
      const xR = inR ? (inR[i] ?? 0) : xL;

      const yL = this.chL.step(xL, rate, size, fb, mix);
      const yR = this.chR.step(xR, rate, size, fb, mix);

      if (outL) outL[i] = yL;
      if (outR) outR[i] = yR;
    }
    return true;
  }
}

registerProcessor('ringback', RingbackProcessor);
