// packages/web/src/lib/audio/modules/meowbox.ts
//
// MEOWBOX — gate-triggered cat-vocal synth voice. Faust DSP — formant bank +
// harmonic+noise excitation + stereo decorrelation tail. See drummergirl.ts
// for the closest reference (similar gate-triggered all-in-one voice shape).
//
// Schema v2 (PR fix/meowbox-voct): the `pitch` input is now a true 1V/oct
// audio-rate input — type changed from 'cv' (semitone-scaled AudioParam) to
// 'pitch' (V/oct audio-rate). The DSP's `process(gate, pitch)` consumes the
// volts directly; the `pitch` knob (semitones) is now a transposition added
// on top of the CV (mirrors analog-vco's `tune` knob). Old saves load
// unchanged — the knob default (0) and CV default (silence = 0V) reproduce
// the previous "C4 with no input" behavior.

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/meowbox.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/meowbox.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/meowbox.worklet.js?url';

const PARAM_PREFIX = '/MEOWBOX';

/** Base frequency at 0V/oct + 0-semi knob = C4 = 261.6256 Hz.
 *  Matches the constant in packages/dsp/src/meowbox.dsp. */
export const MEOWBOX_C4_HZ = 261.6256;

/** Pure mirror of the DSP's `baseFreq(pVolt, pSemi)` formula:
 *
 *    freqHz = 261.6256 × 2^(pVolt + pSemi / 12)
 *
 *  Exposed for unit testing and for any UI/preset code that needs to
 *  predict the rendered fundamental from a (V/oct CV, transposition knob)
 *  pair. Mirrors the analog-vco convention.
 */
export function meowboxBaseFreqHz(pitchVolts: number, pitchSemis = 0): number {
  return MEOWBOX_C4_HZ * Math.pow(2, pitchVolts + pitchSemis / 12);
}

export const meowboxDef: AudioModuleDef = {
  type: 'meowbox',
  domain: 'audio',
  label: 'MEOWBOX',
  category: 'sources',
  // v2: `pitch` input port type changed from 'cv' (semis-as-AudioParam) to
  //     'pitch' (V/oct audio-rate); DSP gained an audio-rate `pitch` channel.
  //     No persisted-data shape change — the migrate() callback is a no-op.
  schemaVersion: 2,
  inputs: [
    { id: 'gate',  type: 'gate' },
    { id: 'pitch', type: 'pitch' },
    { id: 'morph', type: 'cv',   paramTarget: 'morph' },
    { id: 'decay', type: 'cv',   paramTarget: 'decay' },
    { id: 'level', type: 'cv',   paramTarget: 'level' },
  ],
  outputs: [
    { id: 'L', type: 'audio' },
    { id: 'R', type: 'audio' },
  ],
  params: [
    // The pitch knob is a transposition in semitones, added on top of the
    // V/oct pitch CV inside the DSP's baseFreq. A patch with no `pitch` cable
    // (CV silent at 0V) and pitch knob = 0 ⇒ 0V + 0 semis = C4 (261.63 Hz),
    // matching the old default behavior.
    { id: 'pitch', label: 'Ptch',  defaultValue: 0,    min: -36,   max: 36,  curve: 'linear', units: 'semi' },
    { id: 'morph', label: 'Morph', defaultValue: 0.25, min: 0,     max: 1,   curve: 'linear' },
    { id: 'decay', label: 'Dcy',   defaultValue: 0.4,  min: 0.05,  max: 2,   curve: 'log',    units: 's' },
    { id: 'level', label: 'Lvl',   defaultValue: 1,    min: 0,     max: 2,   curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'meowbox', wasmUrl, metaUrl, workletUrl });
    // Two audio-rate inputs: channel 0 = gate, channel 1 = pitch (V/oct).
    // Mirrors analog-vco's pattern. The merger feeds Faust's multi-channel
    // input so a sequencer's pitch CV writes to the pitch channel only,
    // without bleeding into gate.
    const merger = ctx.createChannelMerger(2);
    merger.connect(f);
    // Feed silence to every merger input so the worklet stays in the active
    // processing graph even when nothing's externally patched.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(merger, 0, 0);
    silence.connect(merger, 0, 1);

    const splitter = ctx.createChannelSplitter(2);
    f.connect(splitter);

    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of meowboxDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    const pMorph = params.get(`${PARAM_PREFIX}/morph`);
    const pDecay = params.get(`${PARAM_PREFIX}/decay`);
    const pLevel = params.get(`${PARAM_PREFIX}/level`);

    return {
      domain: 'audio',
      inputs: new Map([
        ['gate',  { node: merger, input: 0 }],
        ['pitch', { node: merger, input: 1 }],
        ['morph', { node: f, input: 0, param: pMorph! }],
        ['decay', { node: f, input: 0, param: pDecay! }],
        ['level', { node: f, input: 0, param: pLevel! }],
      ]),
      outputs: new Map([
        ['L', { node: splitter, output: 0 }],
        ['R', { node: splitter, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(`${PARAM_PREFIX}/${paramId}`)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(`${PARAM_PREFIX}/${paramId}`)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* */ }
        silence.disconnect();
        merger.disconnect();
        splitter.disconnect();
        f.disconnect();
      },
    };
  },
};
