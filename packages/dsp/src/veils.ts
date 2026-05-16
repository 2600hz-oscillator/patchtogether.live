// packages/dsp/src/veils.ts
//
// VEILS — quad VCA + summing mix output.
//
// Mutable Instruments Veils is an analog-hardware quad VCA. There's no
// firmware DSP to port: this is a from-spec implementation.
//
// Per channel (i ∈ {1..4}):
//   gain_i  = (knob_i + cv_i) with cv_i a raw bipolar carrier
//   shaped_i= linear  → max(0, gain_i)                       (CV-style)
//             or expo → max(0, sign(gain_i) * gain_i^2)      (audio-style)
//   out_i   = in_i * shaped_i      (per-channel direct out, NO soft-clip)
// Mix:
//   sum    = out_1 + out_2 + out_3 + out_4
//   mix    = tanh(sum)             (soft-clip: gain can be > 1.0; mix stays
//                                   musical when pushed)
//
// "Veils is useful because gain isn't clipped at 1.0" — full knob + +5 V CV
// can drive gain above unity, giving warm soft-clip overdrive on the mix.
// Direct outs are PRE-clip on purpose so a downstream effect can see the
// raw post-VCA signal; only the summed mix has the tanh.
//
// Response curve is per-channel, picked via the `respN` AudioParam:
//   resp_i = 0 → linear (best for CV / control signals)
//   resp_i = 1 → exponential (best for audio: smooth fades)
// We expose this as a discrete toggle in the UI rather than auto-detecting
// signal frequency — explicit beats clever for a software impl.
//
// Inputs (8 audio-rate node connections):
//   inputs[0..3] = in_1..in_4      audio inputs
//   inputs[4..7] = cv_1..cv_4      CV inputs (summed with knob_i)
//
// Outputs (5 audio-rate, 1 channel each):
//   outputs[0..3] = out_1..out_4   per-channel direct outs (post-VCA,
//                                  pre-mix, pre-clip)
//   outputs[4]    = mix            tanh(sum of all 4 channels)

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

class VeilsProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'gain1', defaultValue: 0.0, minValue: 0, maxValue: 2, automationRate: 'a-rate' as const },
      { name: 'gain2', defaultValue: 0.0, minValue: 0, maxValue: 2, automationRate: 'a-rate' as const },
      { name: 'gain3', defaultValue: 0.0, minValue: 0, maxValue: 2, automationRate: 'a-rate' as const },
      { name: 'gain4', defaultValue: 0.0, minValue: 0, maxValue: 2, automationRate: 'a-rate' as const },
      // 0 = linear, 1 = exponential. Half-step boundary picks the curve.
      { name: 'resp1', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'resp2', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'resp3', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
      { name: 'resp4', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' as const },
    ];
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const in1 = inputs[0]?.[0];
    const in2 = inputs[1]?.[0];
    const in3 = inputs[2]?.[0];
    const in4 = inputs[3]?.[0];
    const cv1 = inputs[4]?.[0];
    const cv2 = inputs[5]?.[0];
    const cv3 = inputs[6]?.[0];
    const cv4 = inputs[7]?.[0];

    const out1 = outputs[0]?.[0];
    const out2 = outputs[1]?.[0];
    const out3 = outputs[2]?.[0];
    const out4 = outputs[3]?.[0];
    const mix  = outputs[4]?.[0];

    const g1 = parameters.gain1;
    const g2 = parameters.gain2;
    const g3 = parameters.gain3;
    const g4 = parameters.gain4;
    const r1 = (parameters.resp1?.[0] ?? 0) >= 0.5 ? 1 : 0;
    const r2 = (parameters.resp2?.[0] ?? 0) >= 0.5 ? 1 : 0;
    const r3 = (parameters.resp3?.[0] ?? 0) >= 0.5 ? 1 : 0;
    const r4 = (parameters.resp4?.[0] ?? 0) >= 0.5 ? 1 : 0;

    const frames = out1?.length ?? out2?.length ?? out3?.length ?? out4?.length ?? mix?.length ?? 0;

    for (let i = 0; i < frames; i++) {
      const kn1 = g1.length > 1 ? (g1[i] ?? g1[0]) : g1[0];
      const kn2 = g2.length > 1 ? (g2[i] ?? g2[0]) : g2[0];
      const kn3 = g3.length > 1 ? (g3[i] ?? g3[0]) : g3[0];
      const kn4 = g4.length > 1 ? (g4[i] ?? g4[0]) : g4[0];

      const c1 = cv1 ? (cv1[i] ?? 0) : 0;
      const c2 = cv2 ? (cv2[i] ?? 0) : 0;
      const c3 = cv3 ? (cv3[i] ?? 0) : 0;
      const c4 = cv4 ? (cv4[i] ?? 0) : 0;

      const x1 = in1 ? (in1[i] ?? 0) : 0;
      const x2 = in2 ? (in2[i] ?? 0) : 0;
      const x3 = in3 ? (in3[i] ?? 0) : 0;
      const x4 = in4 ? (in4[i] ?? 0) : 0;

      // Raw post-sum gain. Half-wave-rectify (max with 0) for linear so a
      // negative CV doesn't flip phase — Veils is a unipolar VCA. For expo
      // we square the magnitude (audio-rate smooth-fade curve); both modes
      // are bounded below by 0 but NOT above by 1, so the soft-clip
      // overdrive emerges naturally when knob + CV pushes high.
      const raw1 = kn1 + c1;
      const raw2 = kn2 + c2;
      const raw3 = kn3 + c3;
      const raw4 = kn4 + c4;

      const s1 = r1 === 1 ? (raw1 > 0 ? raw1 * raw1 : 0) : (raw1 > 0 ? raw1 : 0);
      const s2 = r2 === 1 ? (raw2 > 0 ? raw2 * raw2 : 0) : (raw2 > 0 ? raw2 : 0);
      const s3 = r3 === 1 ? (raw3 > 0 ? raw3 * raw3 : 0) : (raw3 > 0 ? raw3 : 0);
      const s4 = r4 === 1 ? (raw4 > 0 ? raw4 * raw4 : 0) : (raw4 > 0 ? raw4 : 0);

      const y1 = x1 * s1;
      const y2 = x2 * s2;
      const y3 = x3 * s3;
      const y4 = x4 * s4;

      if (out1) out1[i] = y1;
      if (out2) out2[i] = y2;
      if (out3) out3[i] = y3;
      if (out4) out4[i] = y4;
      if (mix) {
        const sum = y1 + y2 + y3 + y4;
        // tanh is the Veils-flavored soft-clip — symmetric, asymptotic to
        // ±1, smooth derivative at 0 so small signals pass linearly.
        mix[i] = Math.tanh(sum);
      }
    }
    return true;
  }
}

registerProcessor('veils', VeilsProcessor);
