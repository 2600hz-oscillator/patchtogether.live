// packages/web/src/lib/audio/modules/cocoadelay.ts
//
// COCOA DELAY — port of Tilde Murray's "Cocoa Delay" (GPL-3.0) as a
// patchable stereo delay effect. TS AudioWorklet (see
// packages/dsp/src/cocoadelay.ts for the per-sample DSP).
//
// Ports:
//   in L / in R  — stereo audio in
//   out L / out R— stereo audio out
//   clock        — gate/clock CV; when patched + tempo-sync != Off, the
//                  delay time locks to the measured pulse period × division.
//   CV inputs    — time, feedback, mix(=wet), drive(=gain), lfoAmt, drift,
//                  pan, duck — the musical continuous params, per the
//                  per-param-CV convention other modules use.
//
// Tempo sync (two pieces, faithful to the brief):
//   • clockSource (dropdown): SYSTEM (TIMELORDE) vs MIDI (MIDICLOCK). Both
//     arrive as a pulse stream on the `clock` gate input — the DSP measures
//     the period either way; this param is reflected for labeling + future
//     per-source behavior.
//   • tempoSync (dropdown): Off → free-running ms (the TIME knob); otherwise
//     a musical division of the measured clock period (1/4, 1/8, dotted,
//     triplet …) exactly like the original plugin's host-tempo sync.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/cocoadelay.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

/** Tempo-sync dropdown options (index → label). Index 0 = Off (free ms);
 *  the rest map 1:1 onto SYNC_BEATS in the worklet. */
export const COCOA_TEMPO_SYNC_OPTIONS: readonly string[] = [
  'Off',
  '1', '1/2D', '1/2', '1/2T', '1/4D', '1/4', '1/4T',
  '1/8D', '1/8', '1/8T', '1/16D', '1/16', '1/16T',
  '1/32D', '1/32', '1/32T', '1/64D', '1/64', '1/64T',
];

/** Clock-source dropdown (index → label). */
export const COCOA_CLOCK_SOURCE_OPTIONS: readonly string[] = ['System', 'MIDI'];

/** Pan-mode dropdown (index → label). */
export const COCOA_PAN_MODE_OPTIONS: readonly string[] = ['Static', 'Ping-Pong', 'Circular'];

/** Filter-mode dropdown (index → label). */
export const COCOA_FILTER_MODE_OPTIONS: readonly string[] = ['1-pole', '2-pole', '4-pole', 'State-var'];

export const cocoaDelayDef: AudioModuleDef = {
  type: 'cocoadelay',
  domain: 'audio',
  label: 'COCOA DELAY',
  category: 'effects',
  schemaVersion: 1,
  stereoPairs: [['inL', 'inR'], ['outL', 'outR']],
  ossAttribution: { author: 'Tilde Murray (Cocoa Delay, GPL-3.0)' },

  inputs: [
    { id: 'inL', type: 'audio' },
    { id: 'inR', type: 'audio' },
    // External clock for tempo sync (TIMELORDE or MIDICLOCK).
    { id: 'clock', type: 'gate' },
    // Per-param CV (range standard per .myrobots/plans/cv-range-standard.md).
    { id: 'time_cv',     type: 'cv', paramTarget: 'delayTime', cvScale: { mode: 'log' } },
    { id: 'feedback_cv', type: 'cv', paramTarget: 'feedback',  cvScale: { mode: 'linear' } },
    { id: 'mix_cv',      type: 'cv', paramTarget: 'wetVolume', cvScale: { mode: 'linear' } },
    { id: 'drive_cv',    type: 'cv', paramTarget: 'driveGain', cvScale: { mode: 'linear' } },
    { id: 'lfo_cv',      type: 'cv', paramTarget: 'lfoAmount', cvScale: { mode: 'linear' } },
    { id: 'drift_cv',    type: 'cv', paramTarget: 'driftAmount', cvScale: { mode: 'linear' } },
    { id: 'pan_cv',      type: 'cv', paramTarget: 'pan',       cvScale: { mode: 'linear' } },
    { id: 'duck_cv',     type: 'cv', paramTarget: 'duckAmount', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'outL', type: 'audio' },
    { id: 'outR', type: 'audio' },
  ],
  params: [
    // DELAY / TIME
    { id: 'delayTime',   label: 'Time',     defaultValue: 0.2,  min: 0.001, max: 2.0,  curve: 'log',      units: 's' },
    { id: 'tempoSync',   label: 'Sync',     defaultValue: 0,    min: 0,     max: 19,   curve: 'discrete' },
    { id: 'clockSource', label: 'Clk Src',  defaultValue: 0,    min: 0,     max: 1,    curve: 'discrete' },
    // LFO
    { id: 'lfoAmount',    label: 'LFO Amt',  defaultValue: 0.0,  min: 0.0,   max: 0.5,  curve: 'linear' },
    { id: 'lfoFrequency', label: 'LFO Freq', defaultValue: 2.0,  min: 0.1,   max: 10.0, curve: 'log',   units: 'hz' },
    // DRIFT
    { id: 'driftAmount', label: 'Drift Amt', defaultValue: 0.001, min: 0.0,  max: 0.05, curve: 'linear' },
    { id: 'driftSpeed',  label: 'Drift Spd', defaultValue: 1.0,   min: 0.1,  max: 10.0, curve: 'log' },
    // FEEDBACK
    { id: 'feedback',     label: 'Feedback', defaultValue: 0.5,  min: -1.0,  max: 1.0,  curve: 'linear' },
    { id: 'stereoOffset', label: 'Stereo',   defaultValue: 0.0,  min: -0.5,  max: 0.5,  curve: 'linear' },
    { id: 'pan',          label: 'Pan',      defaultValue: 0.0,  min: -Math.PI * 0.5, max: Math.PI * 0.5, curve: 'linear' },
    { id: 'panMode',      label: 'Pan Mode', defaultValue: 0,    min: 0,     max: 2,    curve: 'discrete' },
    // DUCKING
    { id: 'duckAmount',  label: 'Duck Amt', defaultValue: 0.0,  min: 0.0,   max: 10.0, curve: 'linear' },
    { id: 'duckAttack',  label: 'Attack',   defaultValue: 10.0, min: 0.1,   max: 100.0, curve: 'log' },
    { id: 'duckRelease', label: 'Release',  defaultValue: 10.0, min: 0.1,   max: 100.0, curve: 'log' },
    // FILTER (in feedback path)
    { id: 'filterMode', label: 'Filt Mode', defaultValue: 0,    min: 0,     max: 3,    curve: 'discrete' },
    { id: 'lowCut',     label: 'Low Cut',   defaultValue: 0.75, min: 0.01,  max: 1.0,  curve: 'linear' },
    { id: 'highCut',    label: 'High Cut',  defaultValue: 0.001, min: 0.001, max: 0.99, curve: 'linear' },
    // DRIVE
    { id: 'driveGain',       label: 'Gain',  defaultValue: 0.1,  min: 0.0,   max: 10.0, curve: 'linear' },
    { id: 'driveMix',        label: 'D.Mix', defaultValue: 1.0,  min: 0.0,   max: 1.0,  curve: 'linear' },
    { id: 'driveCutoff',     label: 'D.Filt',defaultValue: 1.0,  min: 0.01,  max: 1.0,  curve: 'linear' },
    { id: 'driveIterations', label: 'Iters', defaultValue: 1,    min: 1,     max: 16,   curve: 'discrete' },
    // DRY / WET
    { id: 'dryVolume', label: 'Dry', defaultValue: 1.0, min: 0.0, max: 2.0, curve: 'linear' },
    { id: 'wetVolume', label: 'Wet', defaultValue: 0.5, min: 0.0, max: 2.0, curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'cocoadelay', {
      numberOfInputs: 3, // L, R, clock
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    // Keep the node alive when nothing is patched in.
    const silenceL = ctx.createConstantSource();
    const silenceR = ctx.createConstantSource();
    const silenceClk = ctx.createConstantSource();
    silenceL.offset.value = 0;
    silenceR.offset.value = 0;
    silenceClk.offset.value = 0;
    silenceL.start();
    silenceR.start();
    silenceClk.start();
    silenceL.connect(workletNode, 0, 0);
    silenceR.connect(workletNode, 0, 1);
    silenceClk.connect(workletNode, 0, 2);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of cocoaDelayDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map([
        ['inL',         { node: workletNode, input: 0 }],
        ['inR',         { node: workletNode, input: 1 }],
        ['clock',       { node: workletNode, input: 2 }],
        ['time_cv',     { node: workletNode, input: 0, param: params.get('delayTime')! }],
        ['feedback_cv', { node: workletNode, input: 0, param: params.get('feedback')! }],
        ['mix_cv',      { node: workletNode, input: 0, param: params.get('wetVolume')! }],
        ['drive_cv',    { node: workletNode, input: 0, param: params.get('driveGain')! }],
        ['lfo_cv',      { node: workletNode, input: 0, param: params.get('lfoAmount')! }],
        ['drift_cv',    { node: workletNode, input: 0, param: params.get('driftAmount')! }],
        ['pan_cv',      { node: workletNode, input: 0, param: params.get('pan')! }],
        ['duck_cv',     { node: workletNode, input: 0, param: params.get('duckAmount')! }],
      ]),
      outputs: new Map([
        ['outL', { node: workletNode, output: 0 }],
        ['outR', { node: workletNode, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silenceL.stop(); } catch { /* */ }
        try { silenceR.stop(); } catch { /* */ }
        try { silenceClk.stop(); } catch { /* */ }
        silenceL.disconnect();
        silenceR.disconnect();
        silenceClk.disconnect();
        workletNode.disconnect();
      },
    };
  },
};
