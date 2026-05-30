// packages/web/src/lib/audio/modules/sidecar.ts
//
// SIDECAR — stereo sidechain compressor. Stereo audio in, stereo audio
// out, dedicated SC pair (HPF-filterable on the detector path only),
// CV-modulatable threshold + envMag, and two CV-shaped envelope outs
// (env_out + env_inv_out) for cross-patch ducking.
//
// Topology in three sentences (full rationale in
// packages/dsp/src/lib/compressor-dsp.ts):
//   1. SC L/R go through a one-pole HPF (sc_hpf knob; 20–1000 Hz, default
//      20 = effectively off) → |sL| + |sR| stereo-link peak detector.
//   2. log2 → 3-region soft-knee gain computer (threshold + knee + ratio,
//      GMR 2012 eq 4) → asymmetric one-pole smoother (attack / release).
//   3. The resulting gainDb (≤ 0) is converted back to linear via
//      2^(gainDb/6.0205) and multiplied into the audio path.
//
// env_out semantics — IMPORTANT, NOT a typical compressor envelope:
//   env_out = (-gainDb / 24) * envMag, NO HARD CLAMP.
//   - At envMag = 1 + reduction = 24 dB, env_out reaches 1.0.
//   - At envMag = 2 + reduction = 24 dB, env_out reaches 2.0 (overshoot).
//   Downstream modules MUST tolerate env_out > 1.0 when envMag > 1.
//   env_inv_out = 1 - env_out, also un-clamped (can go negative when
//   env_out > 1). The two outs are the standard "duck this when SC fires"
//   pair: patch env_inv_out into a downstream VCA strength to make that
//   VCA close when this compressor is reducing.
//
// SC normalling — feed-forward default:
//   - sc_l_in + sc_r_in BOTH unpatched → SC := audio_l_in + audio_r_in
//     (i.e. self-detect; SIDECAR behaves as a plain stereo compressor).
//   - Only sc_l_in patched → sc_r := audio_r_in (mono SC + audio R-side).
//   - Only sc_r_in patched → sc_l := audio_l_in (mirror).
//   - Both SC inputs patched → external SC pair only (no audio leak into
//     the detector). This is the bus-comp / ducker use case.
//
// Stereo-link is always on in v1 — the detector signal is |sL| + |sR|
// summed, so a transient on either side reduces gain on BOTH audio
// channels equally (no stereo image shift under compression). A toggle
// is deferred to v2 if a single-channel use case appears.
//
// Inputs:
//   audio_l_in, audio_r_in (audio): stereo audio in.
//   sc_l_in, sc_r_in       (audio): sidechain detector pair (see normalling
//                                   rules above).
//   threshold_cv           (cv):    summed into `threshold` AudioParam.
//   env_mag_cv             (cv):    summed into `envMag` AudioParam.
//
// Outputs:
//   audio_l_out, audio_r_out (audio): compressed stereo pair.
//   env_out                  (audio at CV-rate): 0..∞ (overshoot allowed).
//   env_inv_out              (audio at CV-rate): 1 - env_out (can go < 0).
//
// Params:
//   threshold (-60..0 dB,   linear, default -18, CV)
//   ratio     (1..20,        log,    default 4)
//   attack    (0.1..200 ms,  log,    default 10)
//   release   (1..2000 ms,   log,    default 100)
//   knee      (0..24 dB,     linear, default 6)
//   envMag    (0..2,         linear, default 1, CV)
//   makeup    (0..24 dB,     linear, default 0)
//   sc_hpf    (20..1000 Hz,  log,    default 20)

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/sidecar.js?url';

const PROCESSOR_NAME = 'sidecar';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const sidecarDef: AudioModuleDef = {
  type: 'sidecar',
  domain: 'audio',
  label: 'SIDECAR',
  category: 'processors',
  schemaVersion: 1,
  stereoPairs: [['audio_l_in', 'audio_r_in'], ['sc_l_in', 'sc_r_in'], ['audio_l_out', 'audio_r_out']],
  ossAttribution: {
    author: 'Algorithm: Giannoulis-Massberg-Reiss 2012 JAES; Faust co.compressor_stereo as reference',
  },

  inputs: [
    { id: 'audio_l_in',   type: 'audio' },
    { id: 'audio_r_in',   type: 'audio' },
    { id: 'sc_l_in',      type: 'audio' },
    { id: 'sc_r_in',      type: 'audio' },
    { id: 'threshold_cv', type: 'cv', paramTarget: 'threshold', cvScale: { mode: 'linear' } },
    { id: 'env_mag_cv',   type: 'cv', paramTarget: 'envMag',    cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'audio_l_out', type: 'audio' },
    { id: 'audio_r_out', type: 'audio' },
    // env_out + env_inv_out are typed `cv` so they connect cleanly to
    // CV-family sinks (VCA strength, ADSR-style env consumers, modulation
    // inputs). This matches ADSR's `env` / `env_inv` typing — same
    // "audio-rate CV" pattern. NOTE: env_out has NO HARD CLAMP, so when
    // envMag > 1 the signal can exceed ±1 (overshoot). Downstream
    // consumers in CV_FAMILY tolerate this — Web Audio sums/multiplies
    // them just like any other audio signal.
    { id: 'env_out',     type: 'cv' },
    { id: 'env_inv_out', type: 'cv' },
  ],
  params: [
    { id: 'threshold', label: 'Threshold', defaultValue: -18,  min: -60, max: 0,    curve: 'linear', units: 'dB' },
    { id: 'ratio',     label: 'Ratio',     defaultValue: 4,    min: 1,   max: 20,   curve: 'log' },
    { id: 'attack',    label: 'Attack',    defaultValue: 10,   min: 0.1, max: 200,  curve: 'log',    units: 'ms' },
    { id: 'release',   label: 'Release',   defaultValue: 100,  min: 1,   max: 2000, curve: 'log',    units: 'ms' },
    { id: 'knee',      label: 'Knee',      defaultValue: 6,    min: 0,   max: 24,   curve: 'linear', units: 'dB' },
    { id: 'envMag',    label: 'Env Mag',   defaultValue: 1,    min: 0,   max: 2,    curve: 'linear' },
    { id: 'makeup',    label: 'Makeup',    defaultValue: 0,    min: 0,   max: 24,   curve: 'linear', units: 'dB' },
    { id: 'sc_hpf',    label: 'SC HPF',    defaultValue: 20,   min: 20,  max: 1000, curve: 'log',    units: 'Hz' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const worklet = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      // 4 audio inputs (audio L/R + SC L/R). CV inputs are routed via
      // AudioParams not separate node inputs — Web Audio sums CV directly
      // into the AudioParam, which is exactly what we want for
      // threshold_cv + env_mag_cv.
      numberOfInputs: 4,
      numberOfOutputs: 4,
      outputChannelCount: [1, 1, 1, 1],
    });

    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of sidecarDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['audio_l_in',   { node: worklet, input: 0 }],
        ['audio_r_in',   { node: worklet, input: 1 }],
        ['sc_l_in',      { node: worklet, input: 2 }],
        ['sc_r_in',      { node: worklet, input: 3 }],
        // CV → AudioParam. The `input` index is required by the engine's
        // adapter type but unused for param-targeted edges (the engine
        // connects the CV source directly into the AudioParam).
        ['threshold_cv', { node: worklet, input: 0, param: params.get('threshold')! }],
        ['env_mag_cv',   { node: worklet, input: 0, param: params.get('envMag')! }],
      ]),
      outputs: new Map([
        ['audio_l_out', { node: worklet, output: 0 }],
        ['audio_r_out', { node: worklet, output: 1 }],
        ['env_out',     { node: worklet, output: 2 }],
        ['env_inv_out', { node: worklet, output: 3 }],
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
