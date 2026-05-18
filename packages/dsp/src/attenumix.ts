// packages/dsp/src/attenumix.ts
//
// ATTENUMIX — the simple mixer.
//
// 4-channel attenuating mixer. Each channel has an audio input, an
// attenuator knob (0..1), a CV input (summed with the knob), and a direct
// out (post-attenuator, pre-mix). The summed mix is multiplied by a master
// knob (0..2) and run through tanh so pushing master above unity stays
// musical instead of digital-clipping.
//
// Per channel (i ∈ {1..4}):
//   att_i      = clamp(knob_i + cv_i, 0, 1)
//   out_i      = in_i * att_i                (per-channel direct out)
// Mix:
//   sum        = out_1 + out_2 + out_3 + out_4
//   mix        = tanh(sum * master)
//
// Design notes vs. VEILS (which is also a "quad VCA + mix"):
//   - ATTENUMIX caps each attenuator at 1.0 — the per-channel knob is for
//     trimming a signal DOWN, never boosting it. (VEILS spans 0..2 because
//     its identity is "gain past unity → soft overdrive at the channel
//     level".) The boost-above-unity behaviour lives on the master knob
//     instead, with the tanh placed AFTER the master multiply so it's the
//     master that pushes into saturation.
//   - No per-channel response toggle (linear is the only mode).
//   - Same CV-passthrough semantic as VEILS: a +1V LFO at knob=0 sweeps the
//     channel from silence to full open (att = clamp(0+1) = 1.0).
//
// Inputs (8 audio-rate node connections):
//   inputs[0..3] = in_1..in_4   audio inputs
//   inputs[4..7] = cv_1..cv_4   per-channel attenuator CV (summed with knob)
//
// Outputs (5 audio-rate, 1 channel each):
//   outputs[0..3] = out_1..out_4   per-channel direct outs (post-attenuator)
//   outputs[4]    = mix            tanh(master * sum_of_directs)

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

class AttenumixProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'att1',   defaultValue: 0.0, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'att2',   defaultValue: 0.0, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'att3',   defaultValue: 0.0, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'att4',   defaultValue: 0.0, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      // Master defaults to 1.0 so a freshly spawned ATTENUMIX with an open
      // channel passes audio at unity. Range 0..2 — anything above 1
      // recruits the tanh on the mix for warm saturation.
      { name: 'master', defaultValue: 1.0, minValue: 0, maxValue: 2, automationRate: 'a-rate' as const },
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

    const a1 = parameters.att1;
    const a2 = parameters.att2;
    const a3 = parameters.att3;
    const a4 = parameters.att4;
    const ms = parameters.master;

    const frames =
      out1?.length ?? out2?.length ?? out3?.length ?? out4?.length ?? mix?.length ?? 0;

    for (let i = 0; i < frames; i++) {
      const k1 = a1.length > 1 ? (a1[i] ?? a1[0]) : a1[0];
      const k2 = a2.length > 1 ? (a2[i] ?? a2[0]) : a2[0];
      const k3 = a3.length > 1 ? (a3[i] ?? a3[0]) : a3[0];
      const k4 = a4.length > 1 ? (a4[i] ?? a4[0]) : a4[0];
      const mv = ms.length > 1 ? (ms[i] ?? ms[0]) : ms[0];

      const c1 = cv1 ? (cv1[i] ?? 0) : 0;
      const c2 = cv2 ? (cv2[i] ?? 0) : 0;
      const c3 = cv3 ? (cv3[i] ?? 0) : 0;
      const c4 = cv4 ? (cv4[i] ?? 0) : 0;

      const x1 = in1 ? (in1[i] ?? 0) : 0;
      const x2 = in2 ? (in2[i] ?? 0) : 0;
      const x3 = in3 ? (in3[i] ?? 0) : 0;
      const x4 = in4 ? (in4[i] ?? 0) : 0;

      // Per-channel attenuator is clamped to [0, 1]. A negative knob+CV
      // mutes (no phase flip); a >1 knob+CV stops at unity (no boost). The
      // boost-above-unity behaviour lives on the master knob, NOT here.
      const s1 = (k1 ?? 0) + c1; const att1v = s1 < 0 ? 0 : s1 > 1 ? 1 : s1;
      const s2 = (k2 ?? 0) + c2; const att2v = s2 < 0 ? 0 : s2 > 1 ? 1 : s2;
      const s3 = (k3 ?? 0) + c3; const att3v = s3 < 0 ? 0 : s3 > 1 ? 1 : s3;
      const s4 = (k4 ?? 0) + c4; const att4v = s4 < 0 ? 0 : s4 > 1 ? 1 : s4;

      const y1 = x1 * att1v;
      const y2 = x2 * att2v;
      const y3 = x3 * att3v;
      const y4 = x4 * att4v;

      if (out1) out1[i] = y1;
      if (out2) out2[i] = y2;
      if (out3) out3[i] = y3;
      if (out4) out4[i] = y4;
      if (mix) {
        const sum = y1 + y2 + y3 + y4;
        // tanh is symmetric, asymptotic to ±1, and linear near zero — so
        // small signals pass clean, and only when master pushes the sum
        // past ~1.0 does the saturation become audible.
        mix[i] = Math.tanh(sum * (mv ?? 1));
      }
    }
    return true;
  }
}

registerProcessor('attenumix', AttenumixProcessor);
