// packages/dsp/src/blades.ts
//
// BLADES — dual state-variable VCF + COLOR overdrive + mix bus.
//
// From-spec implementation of the Mutable Instruments Blades archetype.
// The eurorack/blades/ folder upstream ships hardware_design only (no
// firmware DSP — Blades is analog), so this is not a port. The behaviour
// we model:
//   • Two independent SVF cores. Each core exposes LP / BP / HP outputs
//     selected by a per-core `modeN` param (0=LP, 1=BP, 2=HP).
//   • Per-core cutoff (knob, Hz) and resonance (0..1, hot-rodded close to
//     self-oscillation at the top).
//   • Per-core V/oct CV input (1 V/oct around the cutoff knob) and an
//     audio-rate cutoff CV that sums in (cv*5 octaves, matching the
//     existing simple FILTER convention).
//   • COLOR knob — single global drive amount applied to each filter
//     core's input as a tanh soft-clip overdrive. 0 = clean, 1 = heavily
//     saturated pre-filter input. Signature Blades grit.
//   • Mix bus: out_mix = mode-dependent combination of the two filter
//     outs. `mixMode` param:
//       0 = parallel — mix = tanh(out1_parallel + out2_parallel)
//       1 = serial   — mix = tanh(filter2(filter1(in1)))
//     In serial mode the direct out1 / out2 ports still reflect each
//     filter operating on its own audio input — only the MIX tap changes.
//   • Per-filter direct outs are independent of the mix routing.
//
// SVF core (ZDF / topology-preserving form, after Vadim Zavalishin):
//   g = tan(π * fc / sr)
//   k = 2 - 2 * res                (k=0.02 floor: edge of self-osc)
//   a1 = 1 / (1 + g*(g + k))
//   a2 = g * a1
//   a3 = g * a2
//   v3 = in - ic2eq
//   v1 = a1*ic1eq + a2*v3
//   v2 = ic2eq + a2*ic1eq + a3*v3
//   ic1eq = 2*v1 - ic1eq
//   ic2eq = 2*v2 - ic2eq
//   LP = v2; BP = v1; HP = in - k*v1 - v2  (uses the raw input, NOT v3)
// Stable through self-oscillation; all three modes computed in one pass
// so the per-core mode selector is just an output picker.
//
// V/oct mapping: voctN input is added in octaves. Cutoff Hz =
// knob * 2^(voct + cv * 5). The "cv * 5" term matches filter.dsp's
// convention so muscle memory transfers.
//
// Inputs (6 audio-rate node connections):
//   inputs[0] = in1             audio in → filter 1
//   inputs[1] = in2             audio in → filter 2
//   inputs[2] = voct1           V/oct CV → filter 1 cutoff
//   inputs[3] = voct2           V/oct CV → filter 2 cutoff
//   inputs[4] = cutoff1_cv      audio-rate cutoff CV (octave-scaled)
//   inputs[5] = cutoff2_cv      audio-rate cutoff CV (octave-scaled)
//
// Outputs (3 audio-rate, 1 channel each):
//   outputs[0] = out1           filter 1 output (mode1: LP/BP/HP)
//   outputs[1] = out2           filter 2 output (mode2: LP/BP/HP)
//   outputs[2] = mix            sum (parallel) or filter1→filter2 (serial)

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
declare const sampleRate: number;

class BladesProcessor extends AudioWorkletProcessor {
  // SVF state per "voice". We keep THREE state vectors:
  //   v1: filter 1 (always processes its own in1)
  //   v2: filter 2 — direct path (processes in2 → out2 port)
  //   v3: filter 2 — serial path (processes y1 → mix bus when mixMode=1)
  // The serial path runs every sample but its output only feeds the mix
  // bus when mixMode==1; this keeps its state coherent so switching mix
  // modes mid-render doesn't pop.
  ic1_f1 = 0; ic2_f1 = 0;
  ic1_f2 = 0; ic2_f2 = 0;
  ic1_s2 = 0; ic2_s2 = 0;

  static get parameterDescriptors() {
    return [
      { name: 'cutoff1', defaultValue: 1000, minValue: 20, maxValue: 20000, automationRate: 'a-rate' as const },
      { name: 'cutoff2', defaultValue: 1000, minValue: 20, maxValue: 20000, automationRate: 'a-rate' as const },
      { name: 'res1',    defaultValue: 0.1,  minValue: 0,  maxValue: 1,     automationRate: 'a-rate' as const },
      { name: 'res2',    defaultValue: 0.1,  minValue: 0,  maxValue: 1,     automationRate: 'a-rate' as const },
      { name: 'mode1',   defaultValue: 0,    minValue: 0,  maxValue: 2,     automationRate: 'k-rate' as const },
      { name: 'mode2',   defaultValue: 0,    minValue: 0,  maxValue: 2,     automationRate: 'k-rate' as const },
      // COLOR — global drive 0..1 applied as tanh(in * (1 + 9*color)).
      // 0 → drive=1 (essentially linear for |x|<0.5).
      // 1 → drive=10 (hard saturation by |x|>0.2).
      { name: 'color',   defaultValue: 0,    minValue: 0,  maxValue: 1,     automationRate: 'a-rate' as const },
      // Mix mode toggle. 0=parallel, 1=serial. K-rate is fine.
      { name: 'mixMode', defaultValue: 0,    minValue: 0,  maxValue: 1,     automationRate: 'k-rate' as const },
    ];
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const in1 = inputs[0]?.[0];
    const in2 = inputs[1]?.[0];
    const voct1 = inputs[2]?.[0];
    const voct2 = inputs[3]?.[0];
    const cv1 = inputs[4]?.[0];
    const cv2 = inputs[5]?.[0];

    const out1 = outputs[0]?.[0];
    const out2 = outputs[1]?.[0];
    const mix  = outputs[2]?.[0];

    const c1 = parameters.cutoff1!;
    const c2 = parameters.cutoff2!;
    const r1 = parameters.res1!;
    const r2 = parameters.res2!;
    const col = parameters.color!;
    const mode1 = Math.max(0, Math.min(2, Math.round(parameters.mode1?.[0] ?? 0))) | 0;
    const mode2 = Math.max(0, Math.min(2, Math.round(parameters.mode2?.[0] ?? 0))) | 0;
    const mixMode = (parameters.mixMode?.[0] ?? 0) >= 0.5 ? 1 : 0;

    const sr = sampleRate;
    const frames = out1?.length ?? out2?.length ?? mix?.length ?? 0;

    for (let i = 0; i < frames; i++) {
      const kn1 = c1.length > 1 ? (c1[i] ?? c1[0]!) : c1[0]!;
      const kn2 = c2.length > 1 ? (c2[i] ?? c2[0]!) : c2[0]!;
      const rs1 = r1.length > 1 ? (r1[i] ?? r1[0]!) : r1[0]!;
      const rs2 = r2.length > 1 ? (r2[i] ?? r2[0]!) : r2[0]!;
      const co  = col.length > 1 ? (col[i] ?? col[0]!) : col[0]!;

      const vo1 = voct1 ? (voct1[i] ?? 0) : 0;
      const vo2 = voct2 ? (voct2[i] ?? 0) : 0;
      const md1 = cv1 ? (cv1[i] ?? 0) : 0;
      const md2 = cv2 ? (cv2[i] ?? 0) : 0;

      // Effective cutoff. Clamp just below Nyquist so tan stays finite.
      const fcMax = sr * 0.49;
      const fc1 = Math.min(fcMax, Math.max(10, kn1 * Math.pow(2, vo1 + md1 * 5)));
      const fc2 = Math.min(fcMax, Math.max(10, kn2 * Math.pow(2, vo2 + md2 * 5)));
      const g1 = Math.tan(Math.PI * fc1 / sr);
      const g2 = Math.tan(Math.PI * fc2 / sr);

      const rcl1 = Math.max(0, Math.min(1, rs1));
      const rcl2 = Math.max(0, Math.min(1, rs2));
      // k floor: edge of self-oscillation. At res=1 → k≈0; the ZDF SVF
      // stays bounded but rings indefinitely. We clamp to 0.003 so a
      // FLOAT round-off doesn't push us into the unstable region (since
      // a1 = 1/(1+g*(g+k)) blows up if k goes negative).
      const k1 = Math.max(0.003, 2 - 2 * rcl1);
      const k2 = Math.max(0.003, 2 - 2 * rcl2);

      // COLOR pre-stage. drive=1 is near-linear for |x|<0.5; drive=10 is
      // brutal. Skip the tanh when color==0 to save one transcendental
      // per sample in the clean case.
      const colcl = Math.max(0, Math.min(1, co));
      const drive = 1 + 9 * colcl;
      const x1raw = in1 ? (in1[i] ?? 0) : 0;
      const x2raw = in2 ? (in2[i] ?? 0) : 0;
      const xd1 = colcl === 0 ? x1raw : Math.tanh(x1raw * drive);
      const xd2 = colcl === 0 ? x2raw : Math.tanh(x2raw * drive);

      // ----- filter 1 (always xd1 → state v1) -----
      const a1_1 = 1 / (1 + g1 * (g1 + k1));
      const a2_1 = g1 * a1_1;
      const a3_1 = g1 * a2_1;
      const v3_1 = xd1 - this.ic2_f1;
      const v1_1 = a1_1 * this.ic1_f1 + a2_1 * v3_1;
      const v2_1 = this.ic2_f1 + a2_1 * this.ic1_f1 + a3_1 * v3_1;
      this.ic1_f1 = 2 * v1_1 - this.ic1_f1;
      this.ic2_f1 = 2 * v2_1 - this.ic2_f1;
      const lp1 = v2_1, bp1 = v1_1, hp1 = xd1 - k1 * v1_1 - v2_1;
      const y1 = mode1 === 0 ? lp1 : mode1 === 1 ? bp1 : hp1;

      // ----- filter 2 direct path (xd2 → state v2 → out2) -----
      const a1_2 = 1 / (1 + g2 * (g2 + k2));
      const a2_2 = g2 * a1_2;
      const a3_2 = g2 * a2_2;
      const v3_2 = xd2 - this.ic2_f2;
      const v1_2 = a1_2 * this.ic1_f2 + a2_2 * v3_2;
      const v2_2 = this.ic2_f2 + a2_2 * this.ic1_f2 + a3_2 * v3_2;
      this.ic1_f2 = 2 * v1_2 - this.ic1_f2;
      this.ic2_f2 = 2 * v2_2 - this.ic2_f2;
      const lp2 = v2_2, bp2 = v1_2, hp2 = xd2 - k2 * v1_2 - v2_2;
      const y2 = mode2 === 0 ? lp2 : mode2 === 1 ? bp2 : hp2;

      // ----- filter 2 serial path (y1 → state s2 → mix when mixMode=1) -----
      // We run this every sample so the serial state stays coherent — if
      // the user flips mixMode mid-render, the serial cascade is already
      // warmed up rather than starting from zeros and popping.
      const v3_s = y1 - this.ic2_s2;
      const v1_s = a1_2 * this.ic1_s2 + a2_2 * v3_s;
      const v2_s = this.ic2_s2 + a2_2 * this.ic1_s2 + a3_2 * v3_s;
      this.ic1_s2 = 2 * v1_s - this.ic1_s2;
      this.ic2_s2 = 2 * v2_s - this.ic2_s2;
      const lps = v2_s, bps = v1_s, hps = y1 - k2 * v1_s - v2_s;
      const ys = mode2 === 0 ? lps : mode2 === 1 ? bps : hps;

      if (out1) out1[i] = y1;
      if (out2) out2[i] = y2;
      if (mix) {
        // tanh on the mix bus prevents two hot filters from punching the
        // output past ±2. Subtle in normal use, audible only when both
        // resonances are cranked.
        mix[i] = mixMode === 0 ? Math.tanh(y1 + y2) : Math.tanh(ys);
      }
    }
    return true;
  }
}

registerProcessor('blades', BladesProcessor);
