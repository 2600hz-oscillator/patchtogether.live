// packages/dsp/src/marbles.ts
//
// MARBLES — random sampler / clock generator (Mutable Instruments archetype).
// AudioWorklet processor. DSP core in marbles-core.ts (clean-room TS port of
// eurorack/marbles/, MIT-licensed, Copyright 2015 Émilie Gillet).
//
// I/O:
//   inputs:  (none audio-rate; all params are AudioParams + CV)
//   outputs: t1, t2 (gates), x1, x2, x3 (CV ±1 = ±5V), clk (master clock gate)
//
// The internal T clock is master; X channels follow ramps.master (T2 source).
// CV outputs are divided by 5 to map Marbles' ±5V to the host's ±1 cable norm.

import {
  RandomStream,
  TGenerator,
  XYGenerator,
  PRESET_SCALES,
  T_MODEL,
  type GroupSettings,
} from './marbles-core';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  constructor(options?: unknown);
  readonly port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare function registerProcessor(name: string, ctor: new (options?: unknown) => AudioWorkletProcessor): void;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

const T_MODEL_ORDER = [
  T_MODEL.COMPLEMENTARY_BERNOULLI,
  T_MODEL.CLUSTERS,
  T_MODEL.DRUMS,
  T_MODEL.INDEPENDENT_BERNOULLI,
  T_MODEL.THREE_STATES,
  T_MODEL.MARKOV,
] as const;

class MarblesProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // T-section
      { name: 'rate', defaultValue: 0, minValue: -60, maxValue: 60, automationRate: 'a-rate' as const },
      { name: 't_model', defaultValue: 0, minValue: 0, maxValue: 5, automationRate: 'a-rate' as const },
      { name: 't_bias', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 't_jitter', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'deja_vu', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'length', defaultValue: 8, minValue: 1, maxValue: 16, automationRate: 'a-rate' as const },
      { name: 'pw_mean', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      // X-section
      { name: 'spread', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'x_bias', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'steps', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'x_deja_vu', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'x_length', defaultValue: 8, minValue: 1, maxValue: 16, automationRate: 'a-rate' as const },
      { name: 'scale', defaultValue: 0, minValue: 0, maxValue: 5, automationRate: 'a-rate' as const },
    ];
  }

  private stream = new RandomStream(0x12345678);
  private t = new TGenerator(this.stream, sampleRate);
  private xy = new XYGenerator(this.stream);
  private gateBuf: boolean[] = [false, false];
  private slavePhaseBuf: number[] = [0, 0];
  private cvBuf: number[] = [0, 0, 0, 0];
  private cfgCounter = 0;
  private scaleLoaded = -1;

  constructor(options?: unknown) {
    super(options);
    this.t.reset();
    for (let s = 0; s < PRESET_SCALES.length; s++) this.xy.loadScaleAll(s, PRESET_SCALES[s]!);
    this.scaleLoaded = 0;
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const t1 = outputs[0]?.[0];
    const t2 = outputs[1]?.[0];
    const x1 = outputs[2]?.[0];
    const x2 = outputs[3]?.[0];
    const x3 = outputs[4]?.[0];
    const clk = outputs[5]?.[0];
    if (!t1 || !t2 || !x1 || !x2 || !x3 || !clk) return true;

    const n = t1.length;
    const p = (name: string, i: number): number => {
      const a = parameters[name]!;
      return a.length > 1 ? a[i]! : a[0]!;
    };

    for (let i = 0; i < n; i++) {
      const rate = p('rate', i);
      const tModelIdx = clamp(Math.round(p('t_model', i)), 0, 5);
      const tBias = clamp(p('t_bias', i), 0, 1);
      const tJitter = clamp(p('t_jitter', i), 0, 1);
      const dejaVu = clamp(p('deja_vu', i), 0, 1);
      const length = clamp(Math.round(p('length', i)), 1, 16);
      const pwMean = clamp(p('pw_mean', i), 0, 1);
      const spread = clamp(p('spread', i), 0, 1);
      const xBias = clamp(p('x_bias', i), 0, 1);
      const steps = clamp(p('steps', i), 0, 1);
      const xDejaVu = clamp(p('x_deja_vu', i), 0, 1);
      const xLength = clamp(Math.round(p('x_length', i)), 1, 16);
      const scaleIdx = clamp(Math.round(p('scale', i)), 0, PRESET_SCALES.length - 1);

      // Feed T params (cheap; block-rate would suffice but per-sample is fine).
      this.t.model = T_MODEL_ORDER[tModelIdx]!;
      this.t.setRate(rate);
      this.t.setBias(tBias);
      this.t.setJitter(tJitter);
      this.t.setDejaVu(dejaVu);
      this.t.setLength(length);
      this.t.setPulseWidthMean(pwMean);

      const masterPhase = this.t.processSample(2.0, this.gateBuf, this.slavePhaseBuf);

      const xSettings: GroupSettings = {
        spread,
        bias: xBias,
        steps,
        dejaVu: xDejaVu,
        scaleIndex: scaleIdx,
        length: xLength,
      };
      this.xy.processSample(xSettings, xSettings, masterPhase, this.cvBuf);

      t1[i] = this.gateBuf[0] ? 1 : 0;
      t2[i] = this.gateBuf[1] ? 1 : 0;
      x1[i] = clamp(this.cvBuf[0]! / 5, -1, 1);
      x2[i] = clamp(this.cvBuf[1]! / 5, -1, 1);
      x3[i] = clamp(this.cvBuf[2]! / 5, -1, 1);
      clk[i] = masterPhase < 0.5 ? 1 : 0;
    }
    return true;
  }
}

registerProcessor('marbles', MarblesProcessor);
