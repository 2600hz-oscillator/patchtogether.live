// packages/dsp/src/sidecar.ts
//
// SIDECAR — stereo sidechain compressor worklet processor.
//
// Topology + DSP rationale live in ./lib/compressor-dsp.ts (Giannoulis-
// Massberg-Reiss 2012; Faust co.compressor_stereo as cross-check). This
// file is the AudioWorkletProcessor wrapper: it owns the worklet IO
// surface (4 audio inputs, 2 CV-into-AudioParam inputs, 4 outputs) and
// delegates per-sample math to the helpers in lib/.
//
// IMPORTANT: this file does NOT `export` anything at the top level —
// top-level exports leak into the bundled dist/<name>.js + break the ART
// classic-script eval. The Processor class is registered via the
// `registerProcessor` side-effect. Tests capture the class through a
// registerProcessor shim before importing this module.
//
// Inputs (4 audio-rate node connections):
//   inputs[0] = audio_l_in
//   inputs[1] = audio_r_in
//   inputs[2] = sc_l_in   — falls back to audio_l_in if BOTH SC inputs unpatched
//   inputs[3] = sc_r_in   — falls back to audio_r_in if BOTH SC inputs unpatched
//
// AudioParams (CV is summed in by the web factory):
//   threshold (a-rate)   — dB, -60..0, default -18
//   envMag    (a-rate)   — 0..2, default 1
//   ratio     (k-rate)   — 1..20, default 4
//   attack    (k-rate)   — 0.1..200 ms, default 10
//   release   (k-rate)   — 1..2000 ms, default 100
//   knee      (k-rate)   — 0..24 dB, default 6
//   makeup    (k-rate)   — 0..24 dB, default 0
//   sc_hpf    (k-rate)   — 20..1000 Hz, default 20
//
// Outputs (4 audio-rate, 1 channel each):
//   outputs[0] = audio_l_out
//   outputs[1] = audio_r_out
//   outputs[2] = env_out       — (-gainDb/24) * envMag, NO CLAMP (overshoot OK)
//   outputs[3] = env_inv_out   — 1 - env_out, also un-clamped

import {
  hpfCoef,
  smootherCoef,
  sidecarStep,
  makeSidecarState,
  type SidecarState,
} from './lib/compressor-dsp';

declare const sampleRate: number;
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

// Shim worklet globals when running outside AudioWorkletGlobalScope (vitest
// captures the class via this shim — see the sidecar.test.ts loader).
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

// Not `export`ed at the top level by design — see the file-header note.
class SidecarProcessor extends AudioWorkletProcessor {
  private state: SidecarState;
  private sr: number;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    this.sr = sampleRate;
    this.state = makeSidecarState(this.sr, -18, 1);
  }

  static get parameterDescriptors() {
    return [
      // CV-targeted params are a-rate so per-sample CV reaches the gain
      // computer / envelope without a k-rate stair-step.
      { name: 'threshold', defaultValue: -18,  minValue: -60,  maxValue: 0,    automationRate: 'a-rate' as const },
      { name: 'envMag',    defaultValue: 1,    minValue: 0,    maxValue: 2,    automationRate: 'a-rate' as const },
      // Knob-only params are k-rate; they don't need per-sample updates and
      // the worklet's internal param-smoother handles user-driven jumps.
      { name: 'ratio',     defaultValue: 4,    minValue: 1,    maxValue: 20,   automationRate: 'k-rate' as const },
      { name: 'attack',    defaultValue: 10,   minValue: 0.1,  maxValue: 200,  automationRate: 'k-rate' as const },
      { name: 'release',   defaultValue: 100,  minValue: 1,    maxValue: 2000, automationRate: 'k-rate' as const },
      { name: 'knee',      defaultValue: 6,    minValue: 0,    maxValue: 24,   automationRate: 'k-rate' as const },
      { name: 'makeup',    defaultValue: 0,    minValue: 0,    maxValue: 24,   automationRate: 'k-rate' as const },
      { name: 'sc_hpf',    defaultValue: 20,   minValue: 20,   maxValue: 1000, automationRate: 'k-rate' as const },
    ];
  }

  private kval(p: Record<string, Float32Array>, name: string, fallback: number): number {
    const arr = p[name];
    return arr && arr.length > 0 ? (arr[0] as number) : fallback;
  }
  private aval(p: Record<string, Float32Array>, name: string, s: number, fallback: number): number {
    const arr = p[name];
    if (!arr || arr.length === 0) return fallback;
    return (arr.length > 1 ? arr[s] : arr[0]) as number;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const inAL = inputs[0]?.[0];
    const inAR = inputs[1]?.[0] ?? inputs[0]?.[0]; // audio_r → audio_l fallback

    // SC fallback: if BOTH SC inputs are unpatched, fall back to the audio
    // pair. If only one SC side is patched, the other side falls back to
    // the same-side audio (matches the "feed-forward" default of a typical
    // compressor where unpatched SC == self-detect).
    const inSLRaw = inputs[2]?.[0];
    const inSRRaw = inputs[3]?.[0];
    const bothScUnpatched = inSLRaw === undefined && inSRRaw === undefined;
    const inSL = bothScUnpatched ? inAL : (inSLRaw ?? inAL);
    const inSR = bothScUnpatched ? inAR : (inSRRaw ?? inAR);

    const outAL = outputs[0]?.[0];
    const outAR = outputs[1]?.[0];
    const outEnv = outputs[2]?.[0];
    const outEnvInv = outputs[3]?.[0];
    if (!outAL || !outAR) return true;
    const n = outAL.length;

    // Block-constant params (k-rate).
    const ratio = this.kval(parameters, 'ratio', 4);
    const knee = this.kval(parameters, 'knee', 6);
    const attackMs = this.kval(parameters, 'attack', 10);
    const releaseMs = this.kval(parameters, 'release', 100);
    const makeup = this.kval(parameters, 'makeup', 0);
    const scHpf = this.kval(parameters, 'sc_hpf', 20);

    // Precompute coefficients once per block.
    const aAtt = smootherCoef(attackMs, this.sr);
    const aRel = smootherCoef(releaseMs, this.sr);
    const hpfA = hpfCoef(scHpf, this.sr);

    for (let s = 0; s < n; s++) {
      const threshold = this.aval(parameters, 'threshold', s, -18);
      const envMag = this.aval(parameters, 'envMag', s, 1);

      const aL = inAL ? (inAL[s] ?? 0) : 0;
      const aR = inAR ? (inAR[s] ?? 0) : 0;
      const sL = inSL ? (inSL[s] ?? 0) : 0;
      const sR = inSR ? (inSR[s] ?? 0) : 0;

      const r = sidecarStep(
        aL, aR, sL, sR,
        { threshold, ratio, knee, envMag, makeup, aAtt, aRel, hpfA },
        this.state,
      );

      outAL[s] = r.outL;
      outAR[s] = r.outR;
      if (outEnv) outEnv[s] = r.envOut;
      if (outEnvInv) outEnvInv[s] = r.envInvOut;
    }

    return true;
  }
}

registerProcessor('sidecar', SidecarProcessor);
