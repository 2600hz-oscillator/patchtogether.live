// packages/web/src/lib/audio/modules/qbrt.ts
//
// QBRT — stereo resonant filter with vactrol-style ping excitation. The
// "stereo big-knob" filter the project ships for master-bus filtering
// and pluck-style ping-resonator voicings. Faust DSP (packages/dsp/src/
// qbrt.dsp). Per channel: a state-variable filter with continuous LP/BP
// (mode 0..1 crossfades the modes) and a ping gate that fires a short
// vactrol-shaped envelope into the input — the filter rings at its
// center frequency at the impulse moment, then continues to filter the
// audio normally. Use it as a regular VCF by ignoring `ping`, or trigger
// `ping` with a drum sequencer for kick / tom-style pluck-resonator
// drum sounds.
//
// Inputs:
//   L (audio): left-channel signal.
//   R (audio): right-channel signal.
//   ping (gate): rising edge fires a vactrol-shaped excitation impulse.
//   cutoff (cv, log, paramTarget=cutoff): ±5 oct sweep around the cutoff knob.
//   resonance (cv, linear, paramTarget=resonance): displaces resonance.
//   mode (cv, discrete, paramTarget=mode): discretely picks LP / BP.
//   pingDecay (cv, log, paramTarget=pingDecay): scales the ping envelope decay.
//
// Outputs:
//   L (audio): filtered left channel.
//   R (audio): filtered right channel.
//
// Params:
//   cutoff (log 20..20000 Hz, default 1000): center frequency.
//   resonance (linear 0..0.99, default 0.7): filter Q.
//   mode (linear 0..1, default 0): LP↔BP crossfade.
//   pingDecay (log 0.005..0.5s, default 0.15): decay time of the ping envelope.

import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import wasmUrl from '@patchtogether.live/dsp/dist/qbrt.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/qbrt.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/qbrt.worklet.js?url';

const PARAM_PREFIX = '/QBRT';

export const qbrtDef: AudioModuleDef = {
  type: 'qbrt',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'qbrt',
  category: 'filters',
  // `pingDecay` (added with the vactrol-style ping path rework) is backfilled
  // from its factory default on load, so no migration callback (or version
  // bump) is needed.
  inputs: [
    { id: 'L',         type: 'audio' },
    { id: 'R',         type: 'audio' },
    { id: 'ping',      type: 'gate' },
    // CV scaling per .myrobots/plans/cv-range-standard.md — LFO ±1 sweeps
    // the param's full musical range centered on the knob.
    //
    // cutoff: log scaling (20Hz..20kHz spans 10 octaves; cv=±1 = ±5 octaves).
    // resonance: linear (0..0.99 — already small but full sweep).
    // mode: discrete bucket (0/1).
    // pingDecay: log (0.005..0.5s spans ~6.6 octaves).
    { id: 'cutoff',    type: 'cv', paramTarget: 'cutoff',    cvScale: { mode: 'log' } },
    { id: 'resonance', type: 'cv', paramTarget: 'resonance', cvScale: { mode: 'linear' } },
    { id: 'mode',      type: 'cv', paramTarget: 'mode',      cvScale: { mode: 'discrete' } },
    { id: 'pingDecay', type: 'cv', paramTarget: 'pingDecay', cvScale: { mode: 'log' } },
  ],
  outputs: [
    { id: 'L', type: 'audio' },
    { id: 'R', type: 'audio' },
  ],
  params: [
    { id: 'cutoff',    label: 'Cut',  defaultValue: 1000, min: 20,    max: 20000, curve: 'log',    units: 'Hz' },
    { id: 'resonance', label: 'Res',  defaultValue: 0.7,  min: 0,     max: 0.99,  curve: 'linear' },
    { id: 'mode',      label: 'Mode', defaultValue: 0,    min: 0,     max: 1,     curve: 'linear' },
    { id: 'pingDecay', label: 'Ping', defaultValue: 0.15, min: 0.005, max: 0.5,   curve: 'log',    units: 's' },
  ],

  docs: {
    explanation:
      "A stereo resonant filter with a 'ping' excitation input — the project's big-knob VCF, also used as a pluck/drum resonator. Each channel runs a state-variable filter whose mode crossfades continuously between low-pass and band-pass, with a big resonance (Q) control that can sing right up to self-oscillation. The twist is the PING input: a trigger fires a short vactrol-shaped impulse into the filter, so it rings at its cutoff frequency for a moment and then settles — patch a drum sequencer into PING and sweep CUTOFF and you get kick/tom-style pluck-resonator sounds with no oscillator at all. Ignore PING and it's an ordinary stereo filter you patch audio through.",
    inputs: {
      L: "Left audio input — the signal fed through the left filter channel.",
      R: "Right audio input — the signal fed through the right filter channel.",
      ping:
        "Ping trigger: each rising edge fires a short vactrol-shaped excitation impulse into both channels, making the filter ring at its cutoff frequency (a pluck). Drive it from a clock or drum sequencer for resonator-style drum hits; the PING DECAY control sets how long each ring lasts.",
      cutoff:
        "CV that displaces the CUTOFF (center frequency) around the knob, log-scaled so ±1 sweeps about ±5 octaves — patch an envelope or LFO here for filter sweeps, or to pitch the ping resonance.",
      resonance:
        "CV that displaces the RESONANCE (Q) around the knob, so a modulator can push the filter toward or away from self-oscillation.",
      mode:
        "CV that picks the filter MODE (low-pass vs. band-pass) in discrete steps — useful for switching response under gate control.",
      pingDecay:
        "CV that displaces the PING DECAY (ring length) around the knob, log-scaled — modulate it to make ping hits longer or shorter per trigger.",
    },
    outputs: {
      L: "Left filtered output — the left channel after the resonant filter (and any ping ring).",
      R: "Right filtered output — the right channel after the resonant filter (and any ping ring).",
    },
    controls: {
      cutoff: "CUTOFF — the filter's center/corner frequency (20 Hz–20 kHz); also the pitch the filter rings at when PING fires.",
      resonance: "RESONANCE — the filter Q: higher values sharpen the peak and emphasize the ring, approaching self-oscillation near the top.",
      mode: "MODE — crossfades the filter response continuously from low-pass (0) to band-pass (1); band-pass narrows the passband around CUTOFF for a more vocal/ringing tone.",
      pingDecay: "PING DECAY — how long the ring lasts after each PING trigger (5 ms–0.5 s); short for clicky percussive plucks, long for sustained resonant tones.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const f = await instantiateFaustModule(ctx, { name: 'qbrt', wasmUrl, metaUrl, workletUrl });
    const merger = ctx.createChannelMerger(3);
    merger.connect(f);
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(merger, 0, 0);
    silence.connect(merger, 0, 1);
    silence.connect(merger, 0, 2);

    const splitter = ctx.createChannelSplitter(2);
    f.connect(splitter);

    const params = f.parameters as unknown as Map<string, AudioParam>;
    for (const def of qbrtDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(`${PARAM_PREFIX}/${def.id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    const pCutoff    = params.get(`${PARAM_PREFIX}/cutoff`);
    const pRes       = params.get(`${PARAM_PREFIX}/resonance`);
    const pMode      = params.get(`${PARAM_PREFIX}/mode`);
    const pPingDecay = params.get(`${PARAM_PREFIX}/pingDecay`);

    return {
      domain: 'audio',
      inputs: new Map([
        ['L',         { node: merger, input: 0 }],
        ['R',         { node: merger, input: 1 }],
        ['ping',      { node: merger, input: 2 }],
        ['cutoff',    { node: f, input: 0, param: pCutoff! }],
        ['resonance', { node: f, input: 0, param: pRes! }],
        ['mode',      { node: f, input: 0, param: pMode! }],
        ['pingDecay', { node: f, input: 0, param: pPingDecay! }],
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
        try { silence.stop(); } catch { /* already stopped */ }
        silence.disconnect();
        merger.disconnect();
        f.disconnect();
        splitter.disconnect();
      },
    };
  },
};
