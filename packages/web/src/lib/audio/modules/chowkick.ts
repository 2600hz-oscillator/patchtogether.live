// packages/web/src/lib/audio/modules/chowkick.ts
//
// CHOWKICK — synth-kick voice. Hand-port of ChowKick by Jatin Chowdhury /
// chowdsp (https://github.com/Chowdhury-DSP/ChowKick, BSD-3-Clause).
//
// Signal flow (matches the source plugin's Pulse Shape → Resonant Filter
// → Level UI):
//   gate_in (rising edge) → PulseShaper (width / amplitude / decay /
//     sustain) + Noise burst (amount / decay / cutoff / type) → summed
//     into a 2nd-order resonant peaking filter (freq + pitch_cv 1V/oct,
//     Q, damping, tight, bounce → tanh feedback saturation) → first-order
//     LPF (tone) × level (dB) → audio_out.
//
// Per-port DSP rationale lives in packages/dsp/src/lib/chowkick-dsp.ts.
// Source citation per ported block lives next to each helper in that file.
//
// CV convention: per ADR-004, CV inputs are bipolar -1..+1 with per-port
// `cvScale` hints — `linear` for additive params (width / amp / decay /
// sustain / damping / tight / bounce), `log` for natively log-spaced
// params (noise_cutoff / freq / q / tone / portamento / level), and
// `discrete` for the noise_type enum.
//
// LINK toggle (per upstream): when on, Q + Damping move together — the
// "tightness" macro behavior. Implemented in the worklet (midpoint
// blend) so it stays consistent under per-sample CV automation.
//
// Inputs:
//   gate_in (audio): rising edge fires a kick.
//   pitch_cv (cv, log, paramTarget=freq): 1V/oct → freq *= 2^pitch_cv
//     in the worklet (the worklet routes the pitch CV separately from
//     the freq AudioParam so 1V/oct is correctly applied as a multiplier
//     rather than a Hz offset).
//   *_cv: bipolar CV summed into the matching AudioParam.
//
// Outputs:
//   audio_out (audio): the mono kick voice.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/chowkick.js?url';

const PROCESSOR_NAME = 'chowkick';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const chowkickDef: AudioModuleDef = {
  type: 'chowkick',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'chowkick',
  category: 'sources',
  schemaVersion: 1,
  ossAttribution: {
    author: 'ChowKick by Jatin Chowdhury / chowdsp, BSD-3-Clause',
  },

  inputs: [
    // gate_in is a 1-channel audio node connection (rising-edge detected
    // in the worklet — matches DRUMMERGIRL's gate input plumbing).
    { id: 'gate_in', type: 'gate' },
    // pitch_cv is its own node input (the worklet multiplies the freq
    // AudioParam by 2^pitch_cv to apply 1V/oct correctly — a freq CV
    // additively summed into the freq AudioParam would NOT be 1V/oct).
    { id: 'pitch_cv', type: 'cv' },
    // Per-knob CV inputs — bipolar -1..+1 → AudioParam summing with
    // cvScale hints per ADR-004.
    { id: 'width_cv',         type: 'cv', paramTarget: 'width',        cvScale: { mode: 'log' } },
    { id: 'amplitude_cv',     type: 'cv', paramTarget: 'amplitude',    cvScale: { mode: 'linear' } },
    { id: 'decay_cv',         type: 'cv', paramTarget: 'decay',        cvScale: { mode: 'linear' } },
    { id: 'sustain_cv',       type: 'cv', paramTarget: 'sustain',      cvScale: { mode: 'linear' } },
    { id: 'noise_amount_cv',  type: 'cv', paramTarget: 'noise_amount', cvScale: { mode: 'linear' } },
    { id: 'noise_decay_cv',   type: 'cv', paramTarget: 'noise_decay',  cvScale: { mode: 'linear' } },
    { id: 'noise_cutoff_cv',  type: 'cv', paramTarget: 'noise_cutoff', cvScale: { mode: 'log' } },
    { id: 'freq_cv',          type: 'cv', paramTarget: 'freq',         cvScale: { mode: 'log' } },
    { id: 'q_cv',             type: 'cv', paramTarget: 'q',            cvScale: { mode: 'log' } },
    { id: 'damping_cv',       type: 'cv', paramTarget: 'damping',      cvScale: { mode: 'linear' } },
    { id: 'tight_cv',         type: 'cv', paramTarget: 'tight',        cvScale: { mode: 'linear' } },
    { id: 'bounce_cv',        type: 'cv', paramTarget: 'bounce',       cvScale: { mode: 'linear' } },
    { id: 'tone_cv',          type: 'cv', paramTarget: 'tone',         cvScale: { mode: 'log' } },
    { id: 'portamento_cv',    type: 'cv', paramTarget: 'portamento',   cvScale: { mode: 'log' } },
    { id: 'level_cv',         type: 'cv', paramTarget: 'level',        cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'audio_out', type: 'audio' },
  ],
  params: [
    { id: 'width',         label: 'Width',     defaultValue: 1,     min: 0.1, max: 50,   curve: 'log',      units: 'ms' },
    { id: 'amplitude',     label: 'Amp',       defaultValue: 1,     min: 0,   max: 2,    curve: 'linear' },
    { id: 'decay',         label: 'Decay',     defaultValue: 1,     min: 0,   max: 1,    curve: 'linear' },
    { id: 'sustain',       label: 'Sustain',   defaultValue: 0.5,   min: 0,   max: 1,    curve: 'linear' },
    { id: 'noise_amount',  label: 'N Amt',     defaultValue: 0,     min: 0,   max: 1,    curve: 'linear' },
    { id: 'noise_decay',   label: 'N Dec',     defaultValue: 0.5,   min: 0,   max: 1,    curve: 'linear' },
    { id: 'noise_cutoff',  label: 'N Cut',     defaultValue: 500,   min: 20,  max: 5000, curve: 'log',      units: 'Hz' },
    { id: 'noise_type',    label: 'N Type',    defaultValue: 0,     min: 0,   max: 3,    curve: 'discrete' },
    { id: 'freq',          label: 'Freq',      defaultValue: 80,    min: 20,  max: 500,  curve: 'log',      units: 'Hz' },
    { id: 'q',             label: 'Q',         defaultValue: 0.5,   min: 0.1, max: 10,   curve: 'log' },
    { id: 'damping',       label: 'Damp',      defaultValue: 0.5,   min: 0,   max: 1,    curve: 'linear' },
    { id: 'tight',         label: 'Tight',     defaultValue: 0.5,   min: 0,   max: 1,    curve: 'linear' },
    { id: 'bounce',        label: 'Bounce',    defaultValue: 0,     min: 0,   max: 1,    curve: 'linear' },
    { id: 'tone',          label: 'Tone',      defaultValue: 800,   min: 50,  max: 2000, curve: 'log',      units: 'Hz' },
    { id: 'portamento',    label: 'Porta',     defaultValue: 0.5,   min: 0,   max: 100,  curve: 'log',      units: 'ms' },
    { id: 'level',         label: 'Level',     defaultValue: 0,     min: -60, max: 0,    curve: 'linear',   units: 'dB' },
    { id: 'link',          label: 'Link',      defaultValue: 0,     min: 0,   max: 1,    curve: 'discrete' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 2 audio-rate node inputs: gate (input 0) + pitch_cv (input 1). All
    // other CV inputs route via AudioParams, not separate node connections.
    const worklet = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    // Keep the worklet "alive" with silence sources on the audio-rate
    // inputs, so it processes blocks even when nothing is patched. Matches
    // the DRUMMERGIRL pattern.
    const merger = ctx.createChannelMerger(2);
    merger.connect(worklet);
    const silenceGate = ctx.createConstantSource();
    silenceGate.offset.value = 0;
    silenceGate.start();
    silenceGate.connect(merger, 0, 0);
    const silencePitch = ctx.createConstantSource();
    silencePitch.offset.value = 0;
    silencePitch.start();
    silencePitch.connect(merger, 0, 1);

    // Set initial params from the persisted node state (or defaults).
    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of chowkickDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    // Input map: gate + pitch route to the merger (worklet input 0/1
    // respectively); per-knob CV inputs route into AudioParams.
    const inputsMap = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>();
    inputsMap.set('gate_in',  { node: merger, input: 0 });
    inputsMap.set('pitch_cv', { node: merger, input: 1 });
    // CV → AudioParam. The `input` index is required by the engine's
    // adapter type but unused for param-targeted edges (the engine
    // connects the CV source directly into the AudioParam).
    const paramCv: Array<[string, string]> = [
      ['width_cv',        'width'],
      ['amplitude_cv',    'amplitude'],
      ['decay_cv',        'decay'],
      ['sustain_cv',      'sustain'],
      ['noise_amount_cv', 'noise_amount'],
      ['noise_decay_cv',  'noise_decay'],
      ['noise_cutoff_cv', 'noise_cutoff'],
      ['freq_cv',         'freq'],
      ['q_cv',            'q'],
      ['damping_cv',      'damping'],
      ['tight_cv',        'tight'],
      ['bounce_cv',       'bounce'],
      ['tone_cv',         'tone'],
      ['portamento_cv',   'portamento'],
      ['level_cv',        'level'],
    ];
    for (const [portId, paramId] of paramCv) {
      const p = params.get(paramId);
      if (p) inputsMap.set(portId, { node: worklet, input: 0, param: p });
    }

    return {
      domain: 'audio',
      inputs: inputsMap,
      outputs: new Map([['audio_out', { node: worklet, output: 0 }]]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silenceGate.stop(); } catch { /* already stopped */ }
        try { silencePitch.stop(); } catch { /* already stopped */ }
        try { silenceGate.disconnect(); } catch { /* */ }
        try { silencePitch.disconnect(); } catch { /* */ }
        try { merger.disconnect(); } catch { /* */ }
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
};
