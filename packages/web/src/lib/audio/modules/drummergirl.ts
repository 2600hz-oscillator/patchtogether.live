// packages/web/src/lib/audio/modules/drummergirl.ts
//
// DRUMMERGIRL — gate-triggered all-in-one synth drum voice. One module,
// one voice — fire a gate, hear a drum hit shaped by pitch / tone /
// shape / volume / decay. Used as the per-voice DSP for voices 1-3 of
// RIOTGIRLS and stands alone in the palette for plain drum-machine /
// percussion-voice use. Faust-compiled DSP (packages/dsp/src/
// drummergirl.dsp): a pitched body oscillator + a noise/transient
// shaper crossfaded by `shape`, with `tone` modulating the body
// timbre, gain-shaped by an internal AD envelope set by `decay`.
//
// Inputs:
//   gate (gate): rising edge fires one drum hit.
//   pitch (cv, linear, paramTarget=pitch): displaces the pitch knob (±36 semi).
//   tone (cv, linear, paramTarget=tone): displaces tone (body timbre).
//   shape (cv, linear, paramTarget=shape): displaces the body/noise crossfade.
//   volume (cv, linear, paramTarget=volume): displaces the per-hit gain (0..2).
//   decay (cv, log, paramTarget=decay): scales the envelope decay symmetrically.
//
// Outputs:
//   audio (audio): the drum hit waveform.
//
// Params:
//   pitch (linear -36..36 semi, default 0): body-oscillator transposition.
//   tone (linear 0..1, default 0.3): body-timbre macro.
//   shape (linear 0..1, default 0.3): crossfade body ↔ noise/transient.
//   volume (linear 0..2, default 1.0): per-hit output gain.
//   decay (log 0.001..0.5 s, default 0.15): AD envelope decay.

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/drummergirl.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/drummergirl.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/drummergirl.worklet.js?url';

const PARAM_PREFIX = '/DRUMMERGIRL';

export const drummergirlDef: AudioModuleDef = {
  type: 'drummergirl',
  domain: 'audio',
  label: 'DRUMMERGIRL',
  category: 'sources',
  // v2: added `volume` (0-2.0) and `decay` (0.001-0.5s, log) params. Loading a
  // v1 save will populate these from defaults — no migration callback needed.
  schemaVersion: 2,
  inputs: [
    { id: 'gate',   type: 'gate' },
    // CV scaling per .myrobots/plans/cv-range-standard.md.
    // pitch: linear (-36..+36 semi; cv=±1 sweeps ±36 semi from knob center).
    // tone/shape: linear (already 0..1 native).
    // volume: linear (0..2; cv=±1 sweeps ±1.0 from knob).
    // decay: log (0.001..0.5s).
    { id: 'pitch',  type: 'cv', paramTarget: 'pitch',  cvScale: { mode: 'linear' } },
    { id: 'tone',   type: 'cv', paramTarget: 'tone',   cvScale: { mode: 'linear' } },
    { id: 'shape',  type: 'cv', paramTarget: 'shape',  cvScale: { mode: 'linear' } },
    { id: 'volume', type: 'cv', paramTarget: 'volume', cvScale: { mode: 'linear' } },
    { id: 'decay',  type: 'cv', paramTarget: 'decay',  cvScale: { mode: 'log' } },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'pitch',  label: 'Pitch',  defaultValue: 0,    min: -36,    max: 36,  curve: 'linear', units: 'semi' },
    { id: 'tone',   label: 'Tone',   defaultValue: 0.3,  min: 0,      max: 1,   curve: 'linear' },
    { id: 'shape',  label: 'Shape',  defaultValue: 0.3,  min: 0,      max: 1,   curve: 'linear' },
    { id: 'volume', label: 'Volume', defaultValue: 1.0,  min: 0,      max: 2.0, curve: 'linear' },
    { id: 'decay',  label: 'Decay',  defaultValue: 0.15, min: 0.001,  max: 0.5, curve: 'log',    units: 's' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'drummergirl', wasmUrl, metaUrl, workletUrl });
    // Single audio-rate input (gate). Use a 1-channel merger with silence so
    // the worklet stays active even with nothing patched in.
    const merger = ctx.createChannelMerger(1);
    merger.connect(f);
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(merger, 0, 0);

    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of drummergirlDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    const pPitch  = params.get(`${PARAM_PREFIX}/pitch`);
    const pTone   = params.get(`${PARAM_PREFIX}/tone`);
    const pShape  = params.get(`${PARAM_PREFIX}/shape`);
    const pVolume = params.get(`${PARAM_PREFIX}/volume`);
    const pDecay  = params.get(`${PARAM_PREFIX}/decay`);

    return {
      domain: 'audio',
      inputs: new Map([
        ['gate',   { node: merger, input: 0 }],
        ['pitch',  { node: f, input: 0, param: pPitch! }],
        ['tone',   { node: f, input: 0, param: pTone! }],
        ['shape',  { node: f, input: 0, param: pShape! }],
        ['volume', { node: f, input: 0, param: pVolume! }],
        ['decay',  { node: f, input: 0, param: pDecay! }],
      ]),
      outputs: new Map([['audio', { node: f, output: 0 }]]),
      setParam(paramId, value) {
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        silence.disconnect();
        merger.disconnect();
        f.disconnect();
      },
    };
  },
};
