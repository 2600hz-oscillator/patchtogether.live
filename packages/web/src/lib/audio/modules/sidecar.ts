// packages/web/src/lib/audio/modules/sidecar.ts
//
// SIDECAR — stereo sidechain ducker. The MAIN audio pair is the trigger
// (e.g. a kick); the SIDECHAIN pair is the signal that gets ducked and
// summed into the output (e.g. a pad/bass). The sidechain is ALWAYS
// present at the output except when the main fires and pulls it down.
// CV-modulatable threshold + envMag + inputLevel, and two CV-shaped
// envelope outs (env_out + env_inv_out) for cross-patch ducking too.
//
// Topology in three sentences (full rationale in
// packages/dsp/src/lib/compressor-dsp.ts):
//   1. The MAIN pair goes through a one-pole detector HPF (sc_hpf knob;
//      20–1000 Hz, default 20 = effectively off) → |aL| + |aR| stereo-link
//      peak detector.
//   2. log2 → 3-region soft-knee gain computer (threshold + knee + ratio,
//      GMR 2012 eq 4) → asymmetric one-pole smoother (attack / release).
//   3. The resulting gainDb (≤ 0) becomes a duck gain (2^(gainDb/6.0205));
//      output = MAIN passthrough + ducked(inputLevel · SIDECHAIN).
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
// Channel normalling:
//   - audio_r_in unpatched → audio_r := audio_l_in (mono main → stereo duck).
//   - sc_r_in    unpatched → sc_r    := sc_l_in    (mono SC → both outputs).
//   - sc pair unpatched entirely → 0 (nothing to duck; main still passes
//     through to the output).
//
// Stereo-link is always on in v1 — the detector signal is |aL| + |aR|
// summed (the MAIN pair), so a transient on either side ducks BOTH output
// channels equally (no stereo image shift under ducking). A toggle is
// deferred to v2 if a single-channel use case appears.
//
// Inputs:
//   audio_l_in, audio_r_in (audio): MAIN / trigger pair (detector + pass-
//                                   through).
//   sc_l_in, sc_r_in       (audio): SIDECHAIN pair — ducked + summed to out.
//   threshold_cv           (cv):    summed into `threshold` AudioParam.
//   env_mag_cv             (cv):    summed into `envMag` AudioParam.
//   input_level_cv         (cv):    summed into `inputLevel` AudioParam.
//
// Outputs:
//   audio_l_out, audio_r_out (audio): main + ducked sidechain stereo pair.
//   env_out                  (audio at CV-rate): 0..∞ (overshoot allowed).
//   env_inv_out              (audio at CV-rate): 1 - env_out (can go < 0).
//
// Params:
//   threshold  (-60..0 dB,   linear, default -18, CV)
//   ratio      (1..20,        log,    default 4)
//   attack     (0.1..200 ms,  log,    default 10)
//   release    (1..2000 ms,   log,    default 100)
//   knee       (0..24 dB,     linear, default 6)
//   envMag     (0..2,         linear, default 1, CV)
//   inputLevel (0..2 [0–200%],linear, default 1, CV)
//   makeup     (0..24 dB,     linear, default 0)
//   sc_hpf     (20..1000 Hz,  log,    default 20)

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/sidecar.js?url';

const PROCESSOR_NAME = 'sidecar';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const sidecarDef: AudioModuleDef = {
  type: 'sidecar',
  palette: { top: 'Audio modules', sub: 'Utility' },
  domain: 'audio',
  label: 'sidecar',
  category: 'processors',
  stereoPairs: [['audio_l_in', 'audio_r_in'], ['sc_l_in', 'sc_r_in'], ['audio_l_out', 'audio_r_out']],
  ossAttribution: {
    author: 'Algorithm: Giannoulis-Massberg-Reiss 2012 JAES; Faust co.compressor_stereo as reference',
  },

  inputs: [
    { id: 'audio_l_in',   type: 'audio' },
    { id: 'audio_r_in',   type: 'audio' },
    { id: 'sc_l_in',      type: 'audio' },
    { id: 'sc_r_in',      type: 'audio' },
    { id: 'threshold_cv',   type: 'cv', paramTarget: 'threshold',  cvScale: { mode: 'linear' } },
    { id: 'env_mag_cv',     type: 'cv', paramTarget: 'envMag',     cvScale: { mode: 'linear' } },
    { id: 'input_level_cv', type: 'cv', paramTarget: 'inputLevel', cvScale: { mode: 'linear' } },
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
    { id: 'envMag',     label: 'Env Mag',    defaultValue: 1,    min: 0,   max: 2,    curve: 'linear' },
    { id: 'inputLevel', label: 'Input Lvl',  defaultValue: 1,    min: 0,   max: 2,    curve: 'linear', units: '%' },
    { id: 'makeup',     label: 'Makeup',     defaultValue: 0,    min: 0,   max: 24,   curve: 'linear', units: 'dB' },
    { id: 'sc_hpf',    label: 'SC HPF',    defaultValue: 20,   min: 20,  max: 1000, curve: 'log',    units: 'Hz' },
  ],

  docs: {
    explanation:
      "A stereo sidechain ducker — the classic 'pumping' compressor where one signal pushes another down. The MAIN pair is the trigger (typically a kick drum); the SIDECHAIN pair is the signal that gets ducked and summed into the output (typically a pad or bass). The sidechain is always present at the output EXCEPT when the main fires, at which point the detector pulls it down by a compressor-style gain computer (threshold, ratio, knee, attack, release) and lets it spring back. Detection is stereo-linked so a transient on either main channel ducks both output channels equally (no image shift), and a sidechain high-pass lets you key off the kick's body without the low end choking the detector. Two extra CV outputs (ENV and ENV INV) expose the live ducking envelope for cross-patching the same pump into other VCAs. Real-source chain: feed a rhythmic source into MAIN and the bus you want pumped into SIDECHAIN.",
    inputs: {
      audio_l_in: "Left MAIN / trigger input — the signal whose transients drive the ducking (e.g. a kick). It also passes through to the output untouched. Unpatched: silent.",
      audio_r_in: "Right MAIN / trigger input. If unpatched it is normalled to MAIN L, so a mono trigger drives both detector channels.",
      sc_l_in: "Left SIDECHAIN input — the signal that gets ducked and summed to the output (e.g. a pad). If the whole SC pair is unpatched, nothing is ducked and only the MAIN passes through.",
      sc_r_in: "Right SIDECHAIN input. If unpatched it is normalled to SC L (mono sidechain to both output channels).",
      threshold_cv: "CV that adds to the THRESHOLD knob — modulate how loud the main must get before ducking begins.",
      env_mag_cv: "CV that adds to the ENV MAG knob — scale how far the ENV / ENV INV outputs swing for a given amount of gain reduction.",
      input_level_cv: "CV that adds to the INPUT LVL knob — modulate the sidechain's input gain (how loud the ducked signal sits in the output).",
    },
    outputs: {
      audio_l_out: "Left output: the MAIN left passthrough plus the ducked left sidechain.",
      audio_r_out: "Right output: the MAIN right passthrough plus the ducked right sidechain.",
      env_out: "The ducking envelope as CV (rises as gain reduction increases). It is NOT hard-clamped: with ENV MAG above 1 it can exceed 1.0 — patch it where overshoot is tolerated. Use it to drive another VCA's strength so it ducks in time with this one.",
      env_inv_out: "The inverted ducking envelope (1 − ENV), also un-clamped (can go negative when ENV exceeds 1). Patch it into a downstream VCA's strength to make that VCA CLOSE while this ducker is reducing.",
    },
    controls: {
      threshold: "The main level (in dB) above which ducking kicks in (-60 to 0 dB, default -18): lower it to duck on quieter hits, raise it so only loud transients pump the sidechain. The THR CV input adds to this.",
      ratio: "How hard the sidechain is pushed down once over threshold (1:1 to 20:1, default 4): higher ratios duck more aggressively.",
      attack: "How fast the duck clamps down after the main fires (0.1 to 200 ms, log, default 10): short for a snappy pump, longer for a gentler dip.",
      release: "How fast the sidechain springs back up after the main passes (1 to 2000 ms, log, default 100): this sets the 'breath' / pumping speed.",
      knee: "The soft-knee width around the threshold in dB (0 to 24, default 6): a wider knee eases ducking in gradually instead of switching hard at the threshold.",
      envMag: "Scales how far the ENV / ENV INV CV outputs swing for a given gain reduction (0 to 2, default 1). At 1 a 24 dB reduction reaches ENV 1.0; above 1 the env overshoots past 1.0. Display/CV-shaping only — does not change the audio ducking. The MAG CV input adds to this.",
      inputLevel: "Input gain on the SIDECHAIN signal before ducking (0 to 200%, default 100%): boost a quiet pad into the mix or trim a loud one. The LVL CV input adds to this.",
      makeup: "A fixed output gain in dB added after ducking (0 to 24, default 0) to bring the overall level back up.",
      sc_hpf: "A high-pass on the DETECTOR signal only (20 to 1000 Hz, log, default 20 = effectively off): raise it so the detector keys on the main's punch rather than its low end, preventing bass from over-triggering the duck. It does not filter the audio you hear.",
    },
  },

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
        ['threshold_cv',   { node: worklet, input: 0, param: params.get('threshold')! }],
        ['env_mag_cv',     { node: worklet, input: 0, param: params.get('envMag')! }],
        ['input_level_cv', { node: worklet, input: 0, param: params.get('inputLevel')! }],
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
