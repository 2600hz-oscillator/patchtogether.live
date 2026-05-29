// packages/web/src/lib/audio/modules/wavviz.ts
//
// WAVVIZ — wavetable VCO with two added features:
//   1. Built-in West-Coast wavefolder between the wavetable VCO and
//      the audio output. Fold amount is knob + cv-controllable.
//   2. A mono-video output port (`scope`) carrying the post-fold
//      waveform as an oscilloscope-style trace.
//
// Re-uses the existing wavetable-vco AudioWorklet processor without
// modification — WAVVIZ is the SAME oscillator with extra post-fx.
//
// Inputs:
//   pitch (pitch): V/oct pitch input, 0V = C4.
//   fm (audio): audio-rate FM modulator (post-wavetable, pre-fold).
//   wavePos (cv, paramTarget=wavePos): displaces the wavetable morph position.
//   foldAmount (cv, linear, paramTarget=foldAmount): displaces the wavefold amount.
//
// Outputs:
//   audio (audio): post-fold waveform output.
//   scope (mono-video): live oscilloscope trace of the same post-fold signal.
//
// Params:
//   tune (linear -36..36 st, default 0): coarse tune in semitones.
//   fine (linear -100..100 ¢, default 0): fine tune cents.
//   wavePos (linear 0..1, default 0): wavetable morph position.
//   fmAmount (linear -1..1, default 0): FM input depth.
//   foldAmount (linear 0..1, default 0): West-Coast wavefolder amount.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/wavetable-vco.js?url';
import { buildFoldCurve } from '$lib/audio/fold-curve';

const FRAME_SIZE = 2048;
const FRAME_COUNT = 16;

const loadedContexts = new WeakSet<BaseAudioContext>();

function generateBasicTable(): Float32Array {
  const table = new Float32Array(FRAME_SIZE * FRAME_COUNT);
  for (let f = 0; f < FRAME_COUNT; f++) {
    const t = f / (FRAME_COUNT - 1);
    for (let s = 0; s < FRAME_SIZE; s++) {
      const phase = s / FRAME_SIZE;
      let v: number;
      if (t < 1 / 3) {
        const m = t * 3;
        const saw = phase < 0.5 ? 2 * phase : 2 * phase - 2;
        const sqr = phase < 0.5 ? 1 : -1;
        v = saw * (1 - m) + sqr * m;
      } else if (t < 2 / 3) {
        const m = (t - 1 / 3) * 3;
        const sqr = phase < 0.5 ? 1 : -1;
        const tri =
          phase < 0.25 ? 4 * phase :
          phase < 0.75 ? 2 - 4 * phase :
          -4 + 4 * phase;
        v = sqr * (1 - m) + tri * m;
      } else {
        const m = (t - 2 / 3) * 3;
        const tri =
          phase < 0.25 ? 4 * phase :
          phase < 0.75 ? 2 - 4 * phase :
          -4 + 4 * phase;
        const sn = Math.sin(2 * Math.PI * phase);
        v = tri * (1 - m) + sn * m;
      }
      table[f * FRAME_SIZE + s] = v;
    }
  }
  return table;
}

// Module-grouping Phase 3A: `vizPassthrough` is available on AudioModuleDef
// for viz-capable cards (WAVVIZ renders a wavetable scope). Left UNSET
// until the card adopts the `data-viz-passthrough` <canvas> contract
// ScopeCard uses for GroupCard portal-hoisting.
export const wavvizDef: AudioModuleDef = {
  type: 'wavviz',
  domain: 'audio',
  label: 'WAVVIZ',
  category: 'sources',
  schemaVersion: 2,
  migrate(data, fromVersion) {
    if (fromVersion < 2) {
      // v1 → v2: fmAmount widened from [0..1] to [-1..+1]. Old values are
      // already legal in the new range, so this is a no-op.
    }
    return data;
  },

  inputs: [
    { id: 'pitch',      type: 'pitch' },
    { id: 'fm',         type: 'audio' },
    // wavePos is an audio-rate input on the wavetable worklet (channel 2);
    // it does NOT route through the CV→AudioParam fast path. paramTarget
    // is declared so the docs manifest is consistent with the rest of the
    // codebase. The cv-scale registry treats this as PASSTHROUGH_BY_DESIGN.
    { id: 'wavePos',    type: 'cv', paramTarget: 'wavePos' },
    // foldAmount: linear cv scaling per .myrobots/plans/cv-range-standard.md.
    { id: 'foldAmount', type: 'cv', paramTarget: 'foldAmount', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'audio', type: 'audio' },
    { id: 'scope', type: 'mono-video' },
  ],
  params: [
    { id: 'tune',       label: 'Tune', defaultValue: 0,   min: -36,  max: 36,  curve: 'linear', units: 'st' },
    { id: 'fine',       label: 'Fine', defaultValue: 0,   min: -100, max: 100, curve: 'linear', units: '¢' },
    { id: 'wavePos',    label: 'Wave', defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
    { id: 'fmAmount',   label: 'FM',   defaultValue: 0,   min: -1,   max: 1,   curve: 'linear' },
    { id: 'foldAmount', label: 'Fold', defaultValue: 0,   min: 0,    max: 1,   curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'wavetable-vco', {
      numberOfInputs: 3,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    const table = generateBasicTable();
    const buf = table.buffer;
    workletNode.port.postMessage(
      { type: 'load', table: buf, frameSize: FRAME_SIZE, frameCount: FRAME_COUNT },
      [buf]
    );

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of wavvizDef.params) {
      if (def.id === 'foldAmount') continue;
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    // Wavefolder — WaveShaperNode after the wavetable VCO.
    let currentFold = (node.params ?? {}).foldAmount ?? 0;
    const shaper = ctx.createWaveShaper();
    shaper.oversample = '4x';
    shaper.curve = buildFoldCurve(currentFold);
    workletNode.connect(shaper);

    // Output gain (post-fold) so we can fan out to BOTH the audio port
    // and the scope analyser tap.
    const outGain = ctx.createGain();
    outGain.gain.value = 1;
    shaper.connect(outGain);

    const scopeAnalyser = ctx.createAnalyser();
    scopeAnalyser.fftSize = 2048;
    scopeAnalyser.smoothingTimeConstant = 0;
    outGain.connect(scopeAnalyser);

    return {
      domain: 'audio',
      inputs: new Map([
        ['pitch',      { node: workletNode, input: 0 }],
        ['fm',         { node: workletNode, input: 1 }],
        ['wavePos',    { node: workletNode, input: 2 }],
        // foldAmount CV: route to a sink AudioParam (outGain.gain) so
        // the engine's CV→AudioParam
        // tap analyser still works for motorized fader feedback. The
        // setParam path applies the actual fold curve update.
        ['foldAmount', { node: outGain, input: 0, param: outGain.gain }],
      ]),
      outputs: new Map([
        ['audio', { node: outGain, output: 0 }],
      ]),
      videoSources: new Map([
        ['scope', { analyser: scopeAnalyser, sampleRate: ctx.sampleRate }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'foldAmount') {
          currentFold = value;
          shaper.curve = buildFoldCurve(value);
          return;
        }
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        if (paramId === 'foldAmount') return currentFold;
        return params.get(paramId)?.value;
      },
      dispose() {
        workletNode.disconnect();
        shaper.disconnect();
        outGain.disconnect();
        scopeAnalyser.disconnect();
      },
    };
  },
};
