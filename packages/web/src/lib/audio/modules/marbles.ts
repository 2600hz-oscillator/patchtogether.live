// packages/web/src/lib/audio/modules/marbles.ts
//
// MARBLES — random sampler / Bernoulli-gate + quantized-CV generator
// (Mutable Instruments archetype). Audio-domain module def + a pure-math
// host mirror (marbles-engine.ts) for tests/ART. Worklet DSP at
// packages/dsp/src/marbles.ts.
//
// Source: eurorack/marbles/ — Copyright 2015 Émilie Gillet, MIT-licensed per
// file headers ("Code (STM32F projects): MIT license"). MIT is compatible
// with patchtogether.live's AGPL. See packages/dsp/src/marbles-core.ts.
//
// Outputs: t1 / t2 (Bernoulli/coin/clusters/drums/markov gates), x1 / x2 / x3
// (random voltages → SPREAD/BIAS/STEPS + weighted-scale quantizer + déjà-vu),
// clk (master clock). CV outputs are ±1 (= ±5V on hardware).
//
// Inputs:
//   rate_cv (cv, linear, paramTarget=rate): displaces the rate knob.
//   tmodel_cv (cv, discrete, paramTarget=t_model): displaces the T-section model.
//   tbias_cv (cv, linear, paramTarget=t_bias): displaces T BIAS.
//   tjitter_cv (cv, linear, paramTarget=t_jitter): displaces T JITTER.
//   dejavu_cv (cv, linear, paramTarget=deja_vu): displaces T déjà-vu (loop probability).
//   length_cv (cv, linear, paramTarget=length): displaces T loop length.
//   spread_cv (cv, linear, paramTarget=spread): displaces X SPREAD.
//   xbias_cv (cv, linear, paramTarget=x_bias): displaces X BIAS.
//   steps_cv (cv, linear, paramTarget=steps): displaces X STEPS.
//   xdejavu_cv (cv, linear, paramTarget=x_deja_vu): displaces X déjà-vu.
//   scale_cv (cv, discrete, paramTarget=scale): displaces the quantizer scale.
//
// Outputs:
//   t1 / t2 (gate): Bernoulli / coin / clusters / drums / Markov gate pair.
//   x1 / x2 / x3 (cv): three quantized random voltages (per X SPREAD/BIAS/STEPS + déjà-vu).
//   clk (gate): master clock-out.
//
// Params:
//   rate (linear -60..60 st, default 0): clock rate macro.
//   t_model (discrete 0..MARBLES_MAX_T_MODEL, default 0): T-section model.
//   t_bias / t_jitter / deja_vu (linear 0..1): T-section tunings.
//   length (discrete 1..16, default 8): T loop length when déjà-vu locks.
//   pw_mean (linear 0..1, default 0.5): pulse-width macro.
//   spread / x_bias / steps / x_deja_vu (linear 0..1): X-section macros.
//   x_length (discrete 1..16, default 8): X loop length when X déjà-vu locks.
//   scale (discrete 0..MARBLES_SCALE_NAMES.length, default 0): X-section quantizer scale.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/marbles.js?url';

import {
  RandomStream,
  TGenerator,
  XYGenerator,
  PRESET_SCALES,
  T_MODEL,
  type GroupSettings,
} from './marbles-engine';

const loadedContexts = new WeakSet<BaseAudioContext>();

export const MARBLES_T_MODEL_NAMES = [
  'COIN', // complementary Bernoulli
  'CLUSTERS',
  'DRUMS',
  'INDEP',
  '3-STATE',
  'MARKOV',
] as const;
export const MARBLES_MAX_T_MODEL = MARBLES_T_MODEL_NAMES.length - 1;

export const MARBLES_SCALE_NAMES = [
  'C major',
  'C minor',
  'Pentatonic',
  'Pelog',
  'Raag Bhairav',
  'Raag Shri',
] as const;

const T_MODEL_ORDER = [
  T_MODEL.COMPLEMENTARY_BERNOULLI,
  T_MODEL.CLUSTERS,
  T_MODEL.DRUMS,
  T_MODEL.INDEPENDENT_BERNOULLI,
  T_MODEL.THREE_STATES,
  T_MODEL.MARKOV,
];

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export interface MarblesParams {
  rate: number;
  t_model: number;
  t_bias: number;
  t_jitter: number;
  deja_vu: number;
  length: number;
  pw_mean: number;
  spread: number;
  x_bias: number;
  steps: number;
  x_deja_vu: number;
  x_length: number;
  scale: number;
}

/**
 * Pure-math render — numerically identical to the worklet. Returns the gate +
 * CV streams over `n` samples. Used by unit tests + ART.
 */
export const marblesMath = {
  render(n: number, sr: number, params: MarblesParams) {
    const stream = new RandomStream(0x12345678);
    const t = new TGenerator(stream, sr);
    const xy = new XYGenerator(stream);
    for (let s = 0; s < PRESET_SCALES.length; s++) xy.loadScaleAll(s, PRESET_SCALES[s]!);
    t.reset();

    t.model = T_MODEL_ORDER[clamp(Math.round(params.t_model), 0, MARBLES_MAX_T_MODEL)]!;
    t.setRate(params.rate);
    t.setBias(clamp(params.t_bias, 0, 1));
    t.setJitter(clamp(params.t_jitter, 0, 1));
    t.setDejaVu(clamp(params.deja_vu, 0, 1));
    t.setLength(clamp(Math.round(params.length), 1, 16));
    t.setPulseWidthMean(clamp(params.pw_mean, 0, 1));

    const xSettings: GroupSettings = {
      spread: clamp(params.spread, 0, 1),
      bias: clamp(params.x_bias, 0, 1),
      steps: clamp(params.steps, 0, 1),
      dejaVu: clamp(params.x_deja_vu, 0, 1),
      scaleIndex: clamp(Math.round(params.scale), 0, PRESET_SCALES.length - 1),
      length: clamp(Math.round(params.x_length), 1, 16),
    };

    const t1 = new Float32Array(n);
    const t2 = new Float32Array(n);
    const x1 = new Float32Array(n);
    const x2 = new Float32Array(n);
    const x3 = new Float32Array(n);
    const clk = new Float32Array(n);
    const gateBuf = [false, false];
    const slaveBuf = [0, 0];
    const cvBuf = [0, 0, 0, 0];

    for (let i = 0; i < n; i++) {
      const masterPhase = t.processSample(2.0, gateBuf, slaveBuf);
      xy.processSample(xSettings, xSettings, masterPhase, cvBuf);
      t1[i] = gateBuf[0] ? 1 : 0;
      t2[i] = gateBuf[1] ? 1 : 0;
      x1[i] = clamp(cvBuf[0]! / 5, -1, 1);
      x2[i] = clamp(cvBuf[1]! / 5, -1, 1);
      x3[i] = clamp(cvBuf[2]! / 5, -1, 1);
      clk[i] = masterPhase < 0.5 ? 1 : 0;
    }
    return { t1, t2, x1, x2, x3, clk };
  },
};

export const marblesDef: AudioModuleDef = {
  type: 'marbles',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'marbles',
  category: 'sources',
  schemaVersion: 1,
  ossAttribution: { author: 'Émilie Gillet' },

  inputs: [
    { id: 'rate_cv', type: 'cv', paramTarget: 'rate', cvScale: { mode: 'linear' } },
    { id: 'tmodel_cv', type: 'cv', paramTarget: 't_model', cvScale: { mode: 'discrete' } },
    { id: 'tbias_cv', type: 'cv', paramTarget: 't_bias', cvScale: { mode: 'linear' } },
    { id: 'tjitter_cv', type: 'cv', paramTarget: 't_jitter', cvScale: { mode: 'linear' } },
    { id: 'dejavu_cv', type: 'cv', paramTarget: 'deja_vu', cvScale: { mode: 'linear' } },
    { id: 'length_cv', type: 'cv', paramTarget: 'length', cvScale: { mode: 'linear' } },
    { id: 'spread_cv', type: 'cv', paramTarget: 'spread', cvScale: { mode: 'linear' } },
    { id: 'xbias_cv', type: 'cv', paramTarget: 'x_bias', cvScale: { mode: 'linear' } },
    { id: 'steps_cv', type: 'cv', paramTarget: 'steps', cvScale: { mode: 'linear' } },
    { id: 'xdejavu_cv', type: 'cv', paramTarget: 'x_deja_vu', cvScale: { mode: 'linear' } },
    { id: 'scale_cv', type: 'cv', paramTarget: 'scale', cvScale: { mode: 'discrete' } },
  ],
  outputs: [
    { id: 't1', type: 'gate' },
    { id: 't2', type: 'gate' },
    { id: 'x1', type: 'cv' },
    { id: 'x2', type: 'cv' },
    { id: 'x3', type: 'cv' },
    { id: 'clk', type: 'gate' },
  ],
  params: [
    { id: 'rate', label: 'Rate', defaultValue: 0, min: -60, max: 60, curve: 'linear', units: 'st' },
    { id: 't_model', label: 'T Model', defaultValue: 0, min: 0, max: MARBLES_MAX_T_MODEL, curve: 'discrete' },
    { id: 't_bias', label: 'T Bias', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 't_jitter', label: 'T Jitter', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'deja_vu', label: 'Déjà Vu', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'length', label: 'Length', defaultValue: 8, min: 1, max: 16, curve: 'discrete' },
    { id: 'pw_mean', label: 'PWidth', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'spread', label: 'Spread', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'x_bias', label: 'X Bias', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'steps', label: 'Steps', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'x_deja_vu', label: 'X Déjà Vu', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'x_length', label: 'X Length', defaultValue: 8, min: 1, max: 16, curve: 'discrete' },
    { id: 'scale', label: 'Scale', defaultValue: 0, min: 0, max: MARBLES_SCALE_NAMES.length - 1, curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }
    const workletNode = new AudioWorkletNode(ctx, 'marbles', {
      numberOfInputs: 0,
      numberOfOutputs: 6,
      outputChannelCount: [1, 1, 1, 1, 1, 1],
    });
    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of marblesDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }
    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['rate_cv', { node: workletNode, input: 0, param: params.get('rate')! }],
        ['tmodel_cv', { node: workletNode, input: 0, param: params.get('t_model')! }],
        ['tbias_cv', { node: workletNode, input: 0, param: params.get('t_bias')! }],
        ['tjitter_cv', { node: workletNode, input: 0, param: params.get('t_jitter')! }],
        ['dejavu_cv', { node: workletNode, input: 0, param: params.get('deja_vu')! }],
        ['length_cv', { node: workletNode, input: 0, param: params.get('length')! }],
        ['spread_cv', { node: workletNode, input: 0, param: params.get('spread')! }],
        ['xbias_cv', { node: workletNode, input: 0, param: params.get('x_bias')! }],
        ['steps_cv', { node: workletNode, input: 0, param: params.get('steps')! }],
        ['xdejavu_cv', { node: workletNode, input: 0, param: params.get('x_deja_vu')! }],
        ['scale_cv', { node: workletNode, input: 0, param: params.get('scale')! }],
      ]),
      outputs: new Map([
        ['t1', { node: workletNode, output: 0 }],
        ['t2', { node: workletNode, output: 1 }],
        ['x1', { node: workletNode, output: 2 }],
        ['x2', { node: workletNode, output: 3 }],
        ['x3', { node: workletNode, output: 4 }],
        ['clk', { node: workletNode, output: 5 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try {
          workletNode.disconnect();
        } catch {
          /* */
        }
      },
    };
  },
};
