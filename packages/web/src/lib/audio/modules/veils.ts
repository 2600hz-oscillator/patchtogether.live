// packages/web/src/lib/audio/modules/veils.ts
//
// VEILS — quad VCA + summing mix output. From-spec implementation of the
// Mutable Instruments Veils (analog hardware, no firmware to port).
//
// Per channel (i ∈ {1..4}):
//   raw_i    = knob_i + cv_i            (knob and CV sum; CV is a raw
//                                        bipolar carrier in PASSTHROUGH —
//                                        no scaling, so an LFO's full
//                                        ±1V swing is what reaches the VCA)
//   shaped_i = linear:      max(0, raw_i)
//              exponential: max(0, raw_i^2)
//   out_i    = in_i * shaped_i          (per-channel direct out, pre-mix,
//                                        pre-clip — downstream sees the
//                                        raw post-VCA signal)
// Mix:
//   sum  = out_1 + out_2 + out_3 + out_4
//   mix  = tanh(sum)                    (soft-clip overdrive: gain is NOT
//                                        clamped at 1.0; pushing knob +
//                                        CV high gives warm saturation
//                                        instead of digital hard-clip)
//
// Response curve is per-channel exposed as a discrete toggle:
//   resp_i = 0 → linear (best for CV / control signals)
//   resp_i = 1 → exponential (best for audio: smooth fades)
// In the real Veils the channel auto-detects audio vs CV from input
// frequency; we expose it as an explicit toggle to keep behaviour
// predictable in software.
//
// Why CV ports are PASSTHROUGH_BY_DESIGN:
// The gain knob's range is [0, 2] so a ±1V CV plus a unity-knob position
// sweeps gain from 0 (LFO at -1) to 2 (LFO at +1) — already a full
// natural-range sweep without interposing a WaveShaperNode. A cvScale of
// `linear` would HALVE the effective CV range (it computes
// scale = (max-min)/2 = 1.0 — so it would only zero out the effect, not
// improve it). Listed in cv-scale-registry.test.ts PASSTHROUGH_BY_DESIGN.
//
// Inputs:
//   in1 / in2 / in3 / in4 (audio): four channel inputs.
//   cv1 / cv2 / cv3 / cv4 (cv): per-channel raw bipolar CV (PASSTHROUGH).
//
// Outputs:
//   out1 / out2 / out3 / out4 (audio): per-channel direct VCA outputs (pre-mix).
//   mix (audio): tanh-soft-clipped sum of out1..4.
//
// Params:
//   gain1 / gain2 / gain3 / gain4 (linear 0..2, default 0): per-channel knob (sums with CV).
//   resp1..resp4 (discrete 0..1): per-channel response curve (0 = linear, 1 = exponential).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/veils.js?url';

const PROCESSOR_NAME = 'veils';
const loadedContexts = new WeakSet<BaseAudioContext>();

/** Pure-math mirror of the worklet, exposed so unit + ART tests can pin
 *  the gain curve / soft-clip behaviour without spinning up Web Audio.
 *  Any drift here means the worklet and the reference disagree. */
export const veilsMath = {
  /** Per-channel gain shaper. `raw` is knob + CV. */
  shape(raw: number, resp: 'linear' | 'exponential'): number {
    if (raw <= 0) return 0;
    return resp === 'exponential' ? raw * raw : raw;
  },

  /** Per-channel VCA multiply: out = in * shape(knob + cv, resp). */
  channelSample(
    inSample: number,
    knob: number,
    cv: number,
    resp: 'linear' | 'exponential',
  ): number {
    return inSample * veilsMath.shape(knob + cv, resp);
  },

  /** Soft-clip the summed mix output. tanh keeps the symmetry and gives
   *  the warm-saturation taper Veils is known for when gain > 1. */
  softClip(sum: number): number {
    return Math.tanh(sum);
  },

  /** Render `frames` samples through all 4 channels. Each channel input
   *  pair (audio + CV) may be null = unpatched (silent). Returns the
   *  four per-channel direct outs + the post-soft-clip mix. */
  render(
    ins: ReadonlyArray<Float32Array | null>,
    cvs: ReadonlyArray<Float32Array | null>,
    knobs: ReadonlyArray<number>,
    resps: ReadonlyArray<'linear' | 'exponential'>,
    frames: number,
  ): { outs: Float32Array[]; mix: Float32Array } {
    const outs = [
      new Float32Array(frames),
      new Float32Array(frames),
      new Float32Array(frames),
      new Float32Array(frames),
    ];
    const mix = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let ch = 0; ch < 4; ch++) {
        const inBuf = ins[ch];
        const cvBuf = cvs[ch];
        const x  = inBuf ? (inBuf[i] ?? 0) : 0;
        const c  = cvBuf ? (cvBuf[i] ?? 0) : 0;
        const k  = knobs[ch] ?? 0;
        const r  = resps[ch] ?? 'linear';
        const y  = veilsMath.channelSample(x, k, c, r);
        outs[ch]![i] = y;
        sum += y;
      }
      mix[i] = veilsMath.softClip(sum);
    }
    return { outs, mix };
  },
};

export const veilsDef: AudioModuleDef = {
  type: 'veils',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'veils',
  category: 'utilities',

  inputs: [
    { id: 'in1', type: 'audio' },
    { id: 'in2', type: 'audio' },
    { id: 'in3', type: 'audio' },
    { id: 'in4', type: 'audio' },
    { id: 'cv1', type: 'cv' },
    { id: 'cv2', type: 'cv' },
    { id: 'cv3', type: 'cv' },
    { id: 'cv4', type: 'cv' },
  ],
  outputs: [
    { id: 'out1', type: 'audio' },
    { id: 'out2', type: 'audio' },
    { id: 'out3', type: 'audio' },
    { id: 'out4', type: 'audio' },
    { id: 'mix',  type: 'audio' },
  ],
  params: [
    // Gain knobs span [0, 2] so a unity-position knob + a +1V CV can push
    // into soft-clip territory (the whole point of Veils). Default 0 so a
    // freshly spawned VEILS is silent until the user dials in gain.
    { id: 'gain1', label: 'Ch1',  defaultValue: 0, min: 0, max: 2, curve: 'linear' },
    { id: 'gain2', label: 'Ch2',  defaultValue: 0, min: 0, max: 2, curve: 'linear' },
    { id: 'gain3', label: 'Ch3',  defaultValue: 0, min: 0, max: 2, curve: 'linear' },
    { id: 'gain4', label: 'Ch4',  defaultValue: 0, min: 0, max: 2, curve: 'linear' },
    // Per-channel response toggle. 0 = linear, 1 = exponential. The
    // worklet treats >=0.5 as expo. Defaults: ch1/ch2 linear (CV-friendly),
    // ch3/ch4 expo (audio-friendly) — covers both use cases out of the
    // box without forcing the user to flip anything.
    { id: 'resp1', label: 'Resp1', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    { id: 'resp2', label: 'Resp2', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
    { id: 'resp3', label: 'Resp3', defaultValue: 1, min: 0, max: 1, curve: 'discrete' },
    { id: 'resp4', label: 'Resp4', defaultValue: 1, min: 0, max: 1, curve: 'discrete' },
  ],

  docs: {
    explanation:
      "A quad VCA and mixer modelled on the Mutable Instruments Veils: four independent voltage-controlled amplifiers that each have a gain knob, a CV input, a direct out, and a linear/exponential response toggle — feeding one summed MIX out. Per channel out = in · shape(knob + cv), where the gain knob spans 0..2: at unity-position knob a ±1V CV sweeps gain from 0 (CV at -1) to 2 (CV at +1). The four channels sum and pass through a tanh soft-clip (mix = tanh(sum)) — gain is NOT clamped at unity, so pushing knob+CV high overdrives into warm saturation rather than digital clipping. Use it as four utility VCAs, a CV-controlled mixer, or four cross-fading/amplitude-modulated voices. There is a DSP worklet for the per-sample VCA + soft-clip math.",
    inputs: {
      in1: "Channel 1 audio input — multiplied by its VCA gain shape(gain1 + cv1) into the channel-1 direct out and the mix.",
      in2: "Channel 2 audio input, multiplied by shape(gain2 + cv2).",
      in3: "Channel 3 audio input, multiplied by shape(gain3 + cv3).",
      in4: "Channel 4 audio input, multiplied by shape(gain4 + cv4).",
      cv1: "Channel 1 gain CV. Summed RAW with the gain knob (no scaling): a ±1V LFO at a unity-position knob sweeps gain 0..2, the natural full-range VCA modulation, so this is the per-channel tremolo / ducking / cross-fade control.",
      cv2: "Channel 2 gain CV (raw, summed with gain2).",
      cv3: "Channel 3 gain CV (raw, summed with gain3).",
      cv4: "Channel 4 gain CV (raw, summed with gain4).",
    },
    outputs: {
      out1: "Channel 1 direct VCA out — in1 · shape(gain1 + cv1), taken BEFORE the summing bus and soft-clip, so downstream sees the raw post-VCA channel.",
      out2: "Channel 2 direct VCA out (pre-mix, pre-clip).",
      out3: "Channel 3 direct VCA out (pre-mix, pre-clip).",
      out4: "Channel 4 direct VCA out (pre-mix, pre-clip).",
      mix: "The summed bus, soft-clipped: tanh(out1 + out2 + out3 + out4). Because the sum is not clamped before the tanh, driving channels past unity produces warm saturation — Veils' signature overdrive — instead of a hard clip.",
    },
    controls: {
      gain1: "Channel 1 VCA gain knob, linear 0..2 (default 0 = silent). Sums with CV1; the past-unity range exists so knob + CV can push the channel into the mix soft-clip.",
      gain2: "Channel 2 VCA gain, linear 0..2 (default 0). Sums with CV2.",
      gain3: "Channel 3 VCA gain, linear 0..2 (default 0). Sums with CV3.",
      gain4: "Channel 4 VCA gain, linear 0..2 (default 0). Sums with CV4.",
      resp1: "Channel 1 response toggle: 0 = LINEAR (gain follows knob+CV directly — best for control signals), 1 = EXPONENTIAL (the signal is squared, giving smoother perceptual fades — best for audio). Default LINEAR.",
      resp2: "Channel 2 response toggle (0 = linear, 1 = exponential). Default LINEAR.",
      resp3: "Channel 3 response toggle (0 = linear, 1 = exponential). Default EXPONENTIAL (audio-friendly out of the box).",
      resp4: "Channel 4 response toggle (0 = linear, 1 = exponential). Default EXPONENTIAL.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const worklet = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 8,
      numberOfOutputs: 5,
      outputChannelCount: [1, 1, 1, 1, 1],
    });

    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of veilsDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['in1', { node: worklet, input: 0 }],
        ['in2', { node: worklet, input: 1 }],
        ['in3', { node: worklet, input: 2 }],
        ['in4', { node: worklet, input: 3 }],
        ['cv1', { node: worklet, input: 4 }],
        ['cv2', { node: worklet, input: 5 }],
        ['cv3', { node: worklet, input: 6 }],
        ['cv4', { node: worklet, input: 7 }],
      ]),
      outputs: new Map([
        ['out1', { node: worklet, output: 0 }],
        ['out2', { node: worklet, output: 1 }],
        ['out3', { node: worklet, output: 2 }],
        ['out4', { node: worklet, output: 3 }],
        ['mix',  { node: worklet, output: 4 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
};
