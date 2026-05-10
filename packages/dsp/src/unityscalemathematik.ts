// packages/dsp/src/unityscalemathematik.ts
//
// UNITYSCALEMATHEMATIK worklet processor.
//
// Three independent CV-shaping channels:
//   UNITY: y = x * unityAtten
//   A:     y = sign(x) * |x|^k * aAtten   where k = 1 + 2*aCurve  (k in [1,3])
//   B:     y = sign(x) * |x|^k * bAtten   where k = 1 + 2*bCurve  (k in [1,3])
//
// curve=0 -> k=1 -> pure linear pass (sections A/B match UNITY semantics).
// curve=1 -> k=3 -> steep expo response. The sign of x is preserved so the
// transform is bipolar (a -0.5 input on a steep curve becomes a smaller-
// magnitude negative number, never flipped to positive).
//
// All five params are a-rate so audio-rate CV on the atten / curve inputs
// modulates per-sample without aliasing artifacts.

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

class UnityScaleProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'unityAtten', defaultValue: 1.0, minValue: -1, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'aAtten',     defaultValue: 1.0, minValue: -1, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'aCurve',     defaultValue: 0.0, minValue:  0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'bAtten',     defaultValue: 1.0, minValue: -1, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'bCurve',     defaultValue: 0.0, minValue:  0, maxValue: 1, automationRate: 'a-rate' as const },
    ];
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const uIn = inputs[0]?.[0];
    const aIn = inputs[1]?.[0];
    const bIn = inputs[2]?.[0];
    const uOut = outputs[0]?.[0];
    const aOut = outputs[1]?.[0];
    const bOut = outputs[2]?.[0];

    const uAtt = parameters.unityAtten;
    const aAtt = parameters.aAtten;
    const aCv  = parameters.aCurve;
    const bAtt = parameters.bAtten;
    const bCv  = parameters.bCurve;

    const frames = uOut?.length ?? aOut?.length ?? bOut?.length ?? 0;

    for (let i = 0; i < frames; i++) {
      if (uOut) {
        const x = uIn ? (uIn[i] ?? 0) : 0;
        const a = uAtt.length > 1 ? (uAtt[i] ?? uAtt[0]) : uAtt[0];
        uOut[i] = x * a;
      }
      if (aOut) {
        const x = aIn ? (aIn[i] ?? 0) : 0;
        const a = aAtt.length > 1 ? (aAtt[i] ?? aAtt[0]) : aAtt[0];
        const cRaw = aCv.length > 1 ? (aCv[i] ?? aCv[0]) : aCv[0];
        const c = cRaw < 0 ? 0 : cRaw > 1 ? 1 : cRaw;
        const k = 1 + 2 * c;
        const ax = x < 0 ? -x : x;
        const mag = k === 1 ? ax : Math.pow(ax, k);
        const s = x < 0 ? -1 : x > 0 ? 1 : 0;
        aOut[i] = s * mag * a;
      }
      if (bOut) {
        const x = bIn ? (bIn[i] ?? 0) : 0;
        const a = bAtt.length > 1 ? (bAtt[i] ?? bAtt[0]) : bAtt[0];
        const cRaw = bCv.length > 1 ? (bCv[i] ?? bCv[0]) : bCv[0];
        const c = cRaw < 0 ? 0 : cRaw > 1 ? 1 : cRaw;
        const k = 1 + 2 * c;
        const ax = x < 0 ? -x : x;
        const mag = k === 1 ? ax : Math.pow(ax, k);
        const s = x < 0 ? -1 : x > 0 ? 1 : 0;
        bOut[i] = s * mag * a;
      }
    }
    return true;
  }
}

registerProcessor('unityscalemathematik', UnityScaleProcessor);
