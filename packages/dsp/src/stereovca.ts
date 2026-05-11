// packages/dsp/src/stereovca.ts
//
// STEREOVCA worklet processor.
//
// Stereo VCA + ring modulator. The same per-channel multiply
// (out = in * (strength + offset) * level) acts as a VCA gain control
// when the strength input is slow (CV / LFO) and as a ring modulator
// when the strength input is audio-rate. No mode toggle: the perceptual
// difference emerges from the signal content.
//
// Inputs (4 audio-rate node connections):
//   inputs[0] = in_l        left audio input
//   inputs[1] = in_r        right audio input (normalled to in_l when
//                           unpatched — Web Audio sends a zero-length
//                           channel array, NOT a silent buffer)
//   inputs[2] = strength_l  left VCA strength / ring carrier
//   inputs[3] = strength_r  right VCA strength / ring carrier (normalled
//                           to strength_l when unpatched)
//
// Outputs (2 audio-rate, 1 channel each):
//   outputs[0] = out_l = in_l * (strength_l + offset) * level
//   outputs[1] = out_r = in_r * (strength_r + offset) * level
//
// Normalling is INDEPENDENT for the two domains: a stereo audio input
// (in_l + in_r both patched) with only strength_l patched gives identical
// strength on both VCAs; conversely, a mono audio source on in_l with
// independent strength_l + strength_r gives different strengths per side.

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

class StereoVcaProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'level',  defaultValue: 1.0, minValue:  0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'offset', defaultValue: 0.0, minValue: -1, maxValue: 1, automationRate: 'a-rate' as const },
    ];
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const inLBuf = inputs[0]?.[0];
    const inRRaw = inputs[1]?.[0];
    const sLBuf  = inputs[2]?.[0];
    const sRRaw  = inputs[3]?.[0];

    // Independent normalling: in_r falls back to in_l, strength_r falls
    // back to strength_l. Web Audio reports unpatched inputs as a
    // zero-length outer array (inputs[i] = []), so inputs[i]?.[0] is
    // undefined — that's the signal we use to trigger the fallback.
    const inR = inRRaw ?? inLBuf;
    const sR  = sRRaw  ?? sLBuf;

    const outL = outputs[0]?.[0];
    const outR = outputs[1]?.[0];

    const level  = parameters.level;
    const offset = parameters.offset;

    const frames = outL?.length ?? outR?.length ?? 0;

    for (let i = 0; i < frames; i++) {
      const lv  = level.length  > 1 ? (level[i]  ?? level[0])  : level[0];
      const off = offset.length > 1 ? (offset[i] ?? offset[0]) : offset[0];
      const xL  = inLBuf ? (inLBuf[i] ?? 0) : 0;
      const xR  = inR    ? (inR[i]    ?? 0) : 0;
      const stL = (sLBuf ? (sLBuf[i] ?? 0) : 0) + off;
      const stR = (sR    ? (sR[i]    ?? 0) : 0) + off;
      if (outL) outL[i] = xL * stL * lv;
      if (outR) outR[i] = xR * stR * lv;
    }
    return true;
  }
}

registerProcessor('stereovca', StereoVcaProcessor);
