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
//
// Inputs:
//   gate (gate): rising edge fires one meow event.
//   pitch (pitch): V/oct pitch input, 0V = C4. Summed with the pitch knob (transposition).
//   morph (cv, linear, paramTarget=morph): displaces the vowel-formant morph (0..1).
//   decay (cv, log, paramTarget=decay): scales the tail decay symmetrically.
//   level (cv, linear, paramTarget=level): displaces the output level.
//
// Outputs:
//   L (audio): left channel of the stereo-decorrelated meow.
//   R (audio): right channel.
//
// Params:
//   pitch (linear -36..36 semi, default 0): transposition added on top of pitch CV.
//   morph (linear 0..1, default 0.25): vowel-formant macro (towards a/i/u/e/o regions).
//   decay (log 0.05..2 s, default 0.4): tail decay time.
//   level (linear 0..2, default 1): output level.

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
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'meowbox',
  category: 'sources',
  // The `pitch` input port type changed from 'cv' (semis-as-AudioParam) to
  // 'pitch' (V/oct audio-rate); no persisted-data shape change, so no migration
  // callback (or version bump) is needed.
  schemaVersion: 1,
  inputs: [
    { id: 'gate',  type: 'gate' },
    // `pitch` is a true 1V/octave audio-rate input (PR fix/meowbox-voct):
    // the DSP consumes the volts directly from a merger channel — NOT
    // routed via the CV→AudioParam fast path. cvScale therefore does
    // not apply (the cv-scale registry treats `pitch` typed inputs as
    // out-of-scope; the DSP's exp2 mapping is the V/oct standard).
    //
    // morph / decay / level remain CV→AudioParam — cvScale per
    // .myrobots/plans/cv-range-standard.md so an LFO at ±1 sweeps the
    // full natural range:
    //   morph: linear (0..1).
    //   decay: log    (0.05..2s).
    //   level: linear (0..2).
    { id: 'pitch', type: 'pitch' },
    { id: 'morph', type: 'cv',    paramTarget: 'morph', cvScale: { mode: 'linear' } },
    { id: 'decay', type: 'cv',    paramTarget: 'decay', cvScale: { mode: 'log' } },
    { id: 'level', type: 'cv',    paramTarget: 'level', cvScale: { mode: 'linear' } },
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

  docs: {
    explanation:
      "A gate-triggered cat-vocal synth voice: fire a gate and it sings one 'meow' at the patched pitch. Under the hood it's a formant synth — a harmonic + noise excitation pushed through a bank of vowel formants, with a stereo-decorrelated tail so the result spreads across the L/R outputs. The Morph control sweeps the vowel (the a/e/i/o/u regions) so a single meow can sound like different vocal shapes, and Decay sets how long the tail rings. Pitch tracks a true 1V/oct input so you can play it from a keyboard or sequencer like any other oscillator, with the Pitch knob acting as a transposition on top.",
    inputs: {
      gate: "The trigger: a rising edge fires one meow event and re-excites the voice. It responds to the edge, not how long the level stays up — the meow's length comes from the Decay control.",
      pitch: "A true 1V/oct pitch input (0 V = middle C). The DSP reads the volts directly and the Pitch knob is added on top as a transposition, so patch a sequencer or keyboard pitch CV here to play melodies; with nothing patched it sits at C4.",
      morph: "CV that adds to the Morph control, sweeping the vowel formant in real time (e.g. an envelope opening the 'mouth' across the meow).",
      decay: "CV that scales the tail Decay time (logarithmic), for shorter chirps or longer wails.",
      level: "CV that adds to the output Level for per-hit dynamics.",
    },
    outputs: {
      L: "Left channel of the stereo-decorrelated meow — the two channels carry the same voice with a decorrelated tail, so summing to mono is fine but keeping them split gives a wider sound.",
      R: "Right channel of the stereo-decorrelated meow (the decorrelated partner of L).",
    },
    controls: {
      pitch: "Transposes the voice in semitones (-36 to +36), summed on top of the 1V/oct pitch input — use it to set the cat's register or to offset an incoming melody.",
      morph: "The vowel-formant macro (0..1): morphs the timbre across the a/i/u/e/o formant regions, changing the 'shape' of the meow from one vowel-like color to another.",
      decay: "Tail decay time (0.05–2 s, log-tapered): short for a clipped chirp, long for a drawn-out wail.",
      level: "Output level from silence to 2x; the Level CV input adds to this.",
    },
  },

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
