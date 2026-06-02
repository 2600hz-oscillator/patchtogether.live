// packages/web/src/lib/audio/modules/attenumix.ts
//
// ATTENUMIX — the simple mixer. 4-channel attenuating mixer with per-
// channel direct outs, per-channel CV-summed attenuator, and a master
// gain knob with tanh soft-clip on the summed mix.
//
// Per channel (i ∈ {1..4}):
//   att_i = clamp(knob_i + cv_i, 0, 1)    (knob+CV sum, bounded 0..1 —
//                                          attenuators only attenuate,
//                                          they never boost)
//   out_i = in_i * att_i                  (per-channel direct out)
// Mix:
//   sum   = out_1 + out_2 + out_3 + out_4
//   mix   = tanh(sum * master)            (master 0..2; tanh keeps a
//                                          master>1 boost musical)
//
// Why a separate module from VEILS (which shares the same "quad VCA +
// summing mix" topology):
//   - VEILS' channel knobs span [0, 2] because its identity is "gain past
//     unity = warm soft-clip at the channel". ATTENUMIX' channel knobs cap
//     at 1.0 because attenuators ATTENUATE — the boost lives on the
//     master, with the tanh placed after the master multiply.
//   - VEILS has a per-channel linear/exponential response toggle (a
//     classic VEILS feature). ATTENUMIX is the no-toggles, every-knob-
//     does-what-it-says-it-does mixer. If you want quad-VCA-with-
//     overdrive-per-channel, use VEILS; if you want "the mixer", use
//     ATTENUMIX.
//
// CV-input semantics: PASSTHROUGH_BY_DESIGN. The attenuator's natural
// range is [0, 1]; a ±1V LFO at knob=0 already sweeps full range (clamp
// rejects the negative half, the positive half fully opens the channel).
// Interposing a `linear` cvScale would compute (1-0)/2 = 0.5 and HALVE
// the LFO's reach — strictly worse. Documented in
// cv-scale-registry.test.ts → PASSTHROUGH_BY_DESIGN.
//
// Inputs:
//   in1 / in2 / in3 / in4 (audio): four channel inputs.
//   cv1 / cv2 / cv3 / cv4 (cv): per-channel raw bipolar CV (PASSTHROUGH).
//
// Outputs:
//   out1 / out2 / out3 / out4 (audio): per-channel direct outs (post-attenuator, pre-mix).
//   mix (audio): tanh(sum * master) — soft-clipped summing bus.
//
// Params:
//   att1 / att2 / att3 / att4 (linear 0..1, default 0): per-channel attenuator (sums with CV, clamped 0..1).
//   master (linear 0..2, default 1.0): output gain on the summed bus (>1 = boost into tanh).

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/attenumix.js?url';

const PROCESSOR_NAME = 'attenumix';
const loadedContexts = new WeakSet<BaseAudioContext>();

/** Pure-math mirror of the worklet — unit + ART tests pin the per-channel
 *  attenuation, the mix-sum identity, and the master+tanh saturation curve
 *  without spinning up Web Audio. Any drift here means the worklet and
 *  this reference disagree. */
export const attenumixMath = {
  /** Per-channel attenuator: clamp(knob + cv, 0, 1). Negative knob+cv
   *  mutes (no phase flip); >1 knob+cv stops at unity (no boost). */
  channelAtt(knob: number, cv: number): number {
    const s = knob + cv;
    if (s <= 0) return 0;
    if (s >= 1) return 1;
    return s;
  },

  /** Per-channel multiply: out = in * att(knob + cv). */
  channelSample(inSample: number, knob: number, cv: number): number {
    return inSample * attenumixMath.channelAtt(knob, cv);
  },

  /** Mix soft-clip: tanh(sum * master). Master spans [0, 2] — pushing
   *  past 1 recruits the tanh for warm saturation. */
  mixSample(sum: number, master: number): number {
    return Math.tanh(sum * master);
  },

  /** Render `frames` samples through all 4 channels. Each channel's
   *  audio + CV may be null = unpatched (silent). Returns the four
   *  per-channel direct outs + the post-soft-clip mix. */
  render(
    ins: ReadonlyArray<Float32Array | null>,
    cvs: ReadonlyArray<Float32Array | null>,
    knobs: ReadonlyArray<number>,
    master: number,
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
        const x = inBuf ? (inBuf[i] ?? 0) : 0;
        const c = cvBuf ? (cvBuf[i] ?? 0) : 0;
        const k = knobs[ch] ?? 0;
        const y = attenumixMath.channelSample(x, k, c);
        outs[ch]![i] = y;
        sum += y;
      }
      mix[i] = attenumixMath.mixSample(sum, master);
    }
    return { outs, mix };
  },
};

export const attenumixDef: AudioModuleDef = {
  type: 'attenumix',
  palette: { top: 'Audio modules', sub: 'Mixing' },
  domain: 'audio',
  label: 'ATTENUMIX',
  category: 'utilities',
  schemaVersion: 1,

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
    // Per-channel attenuators cap at 1.0 — the boost-above-unity lives on
    // the master knob. Default 0 so a freshly spawned ATTENUMIX is silent
    // until the user dials in a channel.
    { id: 'att1',   label: 'Att1',   defaultValue: 0,   min: 0, max: 1, curve: 'linear' },
    { id: 'att2',   label: 'Att2',   defaultValue: 0,   min: 0, max: 1, curve: 'linear' },
    { id: 'att3',   label: 'Att3',   defaultValue: 0,   min: 0, max: 1, curve: 'linear' },
    { id: 'att4',   label: 'Att4',   defaultValue: 0,   min: 0, max: 1, curve: 'linear' },
    // Master defaults to 1.0 = unity gain. Range up to 2.0 so users can
    // push the sum into the tanh for warm saturation.
    { id: 'master', label: 'Master', defaultValue: 1.0, min: 0, max: 2, curve: 'linear' },
  ],

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
    for (const def of attenumixDef.params) {
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
