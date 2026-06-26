// packages/web/src/lib/audio/modules/destroy.ts
//
// DESTROY — bitcrusher / sample-rate decimator. The grungy lo-fi effect
// the project ships under that name. Faust-compiled DSP
// (packages/dsp/src/destroy.dsp) — three controls: SR decimation (1..64;
// hold every Nth sample), bit-depth reduction (1..16 bits), and a wet/
// dry mix. Pull DECIMATE up for a slo-mo grainy aliasing texture; pull
// BITS down for thick quantization grit; the WET knob keeps the dry
// signal blendable so it works as a parallel-distortion send too.
//
// Inputs:
//   audio (audio): dry signal.
//   decimate (cv, linear, paramTarget=decimate): displaces the SR-decimation count.
//   bits (cv, linear, paramTarget=bits): displaces the bit-depth target.
//   wet (cv, linear, paramTarget=wet): displaces wet/dry mix.
//
// Outputs:
//   audio (audio): destroyed signal.
//
// Params:
//   decimate (linear 1..64, default 1): keep every Nth sample (1 = pristine).
//   bits (linear 1..16, default 16): quantization bit depth (16 = pristine).
//   wet (linear 0..1, default 1): dry/wet mix (0 = dry, 1 = wet).

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/destroy.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/destroy.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/destroy.worklet.js?url';

const PARAM_PREFIX = '/DESTROY';

export const destroyDef: AudioModuleDef = {
  type: 'destroy',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'destroy',
  category: 'effects',
  schemaVersion: 1,
  inputs: [
    { id: 'audio',    type: 'audio' },
    // CV scaling per .myrobots/plans/cv-range-standard.md.
    // decimate: linear (1..64; cv=±1 sweeps ±31.5 from knob).
    // bits: linear (1..16).
    // wet: linear (0..1).
    { id: 'decimate', type: 'cv', paramTarget: 'decimate', cvScale: { mode: 'linear' } },
    { id: 'bits',     type: 'cv', paramTarget: 'bits',     cvScale: { mode: 'linear' } },
    { id: 'wet',      type: 'cv', paramTarget: 'wet',      cvScale: { mode: 'linear' } },
  ],
  outputs: [{ id: 'audio', type: 'audio' }],
  params: [
    { id: 'decimate', label: 'Dec',  defaultValue: 1,  min: 1, max: 64, curve: 'linear' },
    { id: 'bits',     label: 'Bits', defaultValue: 16, min: 1, max: 16, curve: 'linear' },
    { id: 'wet',      label: 'Wet',  defaultValue: 1,  min: 0, max: 1,  curve: 'linear' },
  ],

  docs: {
    explanation:
      "A bitcrusher / sample-rate decimator — the project's grungy lo-fi destroyer. Two classic digital-degradation stages run in series on the input: DECIMATE holds every Nth sample (a sample-rate reduction that adds aliasing and a slo-mo grainy texture), and BITS quantizes the amplitude to fewer bits (the gritty, steppy crunch of low bit-depth). A WET knob crossfades the mangled signal against the clean dry, so it doubles as a parallel-distortion send. Pull DECIMATE up for aliasing grain, pull BITS down for thick quantization grit. Both controls are CV-patchable for rhythmic crush sweeps.",
    inputs: {
      audio: 'The dry signal fed into the decimator + bit-reducer chain. Also passed to the dry side of the WET blend.',
      decimate: 'CV that displaces the DECIMATE knob (linear), modulating the sample-rate reduction — patch an envelope or LFO for rhythmic aliasing sweeps. A ±1V CV sweeps roughly ±31 steps from the knob position.',
      bits: 'CV that displaces the BITS knob (linear), modulating the quantization depth live.',
      wet: 'CV that displaces the WET knob, modulating the dry/wet crush amount.',
    },
    outputs: {
      audio: 'The processed (destroyed) signal blended with the dry input per WET.',
    },
    controls: {
      decimate: 'Sample-rate decimation (1..64): hold every Nth input sample. 1 is pristine (no decimation); higher values drop the effective sample rate for aliasing artifacts and a coarse, downsampled grain.',
      bits: 'Quantization bit depth (1..16): 16 is pristine (effectively no reduction); lower values quantize the amplitude to fewer steps for the thick, steppy crunch of a low-bit converter — 1 bit is near square-wave destruction.',
      wet: 'Dry / wet mix (0..1): 0 is the clean input, 1 is the fully crushed signal, between blends them — useful as a parallel-distortion amount.',
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'destroy', wasmUrl, metaUrl, workletUrl });
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(f);
    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of destroyDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    const pDecimate = params.get(`${PARAM_PREFIX}/decimate`);
    const pBits     = params.get(`${PARAM_PREFIX}/bits`);
    const pWet      = params.get(`${PARAM_PREFIX}/wet`);
    return {
      domain: 'audio',
      inputs: new Map([
        ['audio',    { node: f, input: 0 }],
        ['decimate', { node: f, input: 0, param: pDecimate! }],
        ['bits',     { node: f, input: 0, param: pBits! }],
        ['wet',      { node: f, input: 0, param: pWet! }],
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
        f.disconnect();
      },
    };
  },
};
