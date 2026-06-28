// packages/web/src/lib/audio/modules/resofilter.ts
//
// RESOFILTER — multi-mode filter port of Resonarium's MultiFilter
// (gabrielsoule/resonarium, plugin/Source/dsp/MultiFilter.{h,cpp}). Five
// modes drawn straight from upstream's MultiFilter::Type enum +
// filterTextFunction (plugin/Source/Parameters.cpp lines 7-21):
//
//     index   short   long           role
//     ─────   ─────   ────           ─────────────────────────────────────
//       0     LP      Low-pass       attenuates above cutoff
//       1     HP      High-pass      attenuates below cutoff
//       2     BP      Band-pass      peaks at cutoff
//       3     NT      Notch          dips at cutoff
//       4     AP      Allpass        flat magnitude, phase-rotating
//
// Upstream's `none` mode is dropped — we have a Mix knob, so users dial mix
// to 0 for a bypass. The 1-level enum (no Type-vs-Character split) was
// chosen over a 2-level `mode + submode` because Resonarium ships exactly
// these 5 characters in one enum (no separate ladder / SVF / comb axis on
// the MultiFilter); flattening keeps the card's mode-name label legible in
// one line and the spec encourages whichever reads better. The card shows
// the long-form name (e.g. "Low-pass") next to the MODE knob.
//
// DSP topology lives in packages/dsp/src/lib/resofilter-dsp.ts (Cytomic /
// Zavalishin TPT SVF; all 5 modes share one state, so the dial is a pure
// output picker — switching modes mid-render is pop-free).
//
// Per-mode topology summary (see lib/resofilter-dsp.ts header for details):
//   • LP:    SVF lp tap
//   • HP:    SVF hp tap
//   • BP:    SVF bp tap
//   • Notch: lp + hp                (= input − k·bp)
//   • Allpass: lp + hp − k·bp       (standard TPT allpass form)
//
// Drive: upstream's MultiFilter does NOT have a drive stage (the optional
// saturation in Resonarium lives in WrappedSVF / Distortion, not here), so
// the brief's "If not, omit" applies — Drive is NOT exposed on this port.
//
// Inputs (3): audio (audio), cutoff_cv (cv→cutoff), reso_cv (cv→resonance).
// Outputs (2): out_l, out_r (stereo pair). The underlying SVF is mono per
// channel, with independent state on L vs R so a stereo input keeps its
// separation through the filter.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/resofilter.js?url';

const PROCESSOR_NAME = 'resofilter';
const loadedContexts = new WeakSet<BaseAudioContext>();

/** Long-form display strings, indexed by the `mode` param value 0..4.
 *  Mirrors RESOFILTER_MODE_NAMES in packages/dsp/src/lib/resofilter-dsp.ts —
 *  duplicated here to keep the web layer free of an SSR import of that
 *  file (which references the `sampleRate` global through its descendants).
 *  Test asserts the count + ordering match the worklet's max. */
export const RESOFILTER_MODE_NAMES = [
  'Low-pass',
  'High-pass',
  'Band-pass',
  'Notch',
  'Allpass',
] as const;
export type ResofilterMode = 0 | 1 | 2 | 3 | 4;
export const RESOFILTER_MODE_COUNT = RESOFILTER_MODE_NAMES.length;
export const RESOFILTER_MAX_MODE = RESOFILTER_MODE_COUNT - 1;

export const resofilterDef: AudioModuleDef = {
  type: 'resofilter',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'resofilter',
  category: 'processors',
  schemaVersion: 1,
  stereoPairs: [['out_l', 'out_r']],
  ossAttribution: { author: 'Gabriel Soule (Resonarium, MultiFilter)' },

  inputs: [
    // Stereo-aware audio input. Web Audio sums channels per input port; the
    // worklet branches on inputs[0][0] / inputs[0][1] so a stereo source
    // keeps its L/R separation. A mono source duplicates onto both filter
    // channels.
    { id: 'audio',     type: 'audio' },
    // Per-param CV via cvScale linear (matches the spec). The factory wires
    // these into the cutoff / resonance AudioParams.
    { id: 'cutoff_cv', type: 'cv', paramTarget: 'cutoff',    cvScale: { mode: 'linear' } },
    { id: 'reso_cv',   type: 'cv', paramTarget: 'resonance', cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],
  params: [
    // Cutoff — log fader 20 Hz .. 20 kHz, default 1 kHz (Resonarium's
    // MultiFilterParams default per Parameters.cpp line 165).
    { id: 'cutoff',    label: 'Cutoff', defaultValue: 1000, min: 20, max: 20000, curve: 'log',      units: 'Hz' },
    // Resonance — internal worklet maps this 0..1 to k = 2 − 2·res, clamped
    // above 0 so a1 = 1/(1+g·(g+k)) stays well-defined. Default 0.3 per
    // the brief (upstream defaults closer to 0.7 / sqrt(2) which is too
    // peaky for a from-the-stock-rack feel).
    { id: 'resonance', label: 'Reso',   defaultValue: 0.3,  min: 0,  max: 1,     curve: 'linear' },
    // Mode — discrete picker; RESOFILTER_MODE_NAMES[mode] renders next to
    // the knob on the card. N = 5 → max = N − 1 = 4.
    { id: 'mode',      label: 'Mode',   defaultValue: 0,    min: 0,  max: RESOFILTER_MAX_MODE, curve: 'discrete' },
    // Mix — 0 = full dry (bypass), 1 = full wet. Defaults to fully wet
    // since RESOFILTER is a filter, not a parallel effect.
    { id: 'mix',       label: 'Mix',    defaultValue: 1,    min: 0,  max: 1,     curve: 'linear' },
  ],

  docs: {
    explanation:
      "A clean multi-mode resonant filter (ported from Resonarium's MultiFilter) built on a zero-delay-feedback state-variable topology, so all of its modes share one filter state and switching between them mid-sound is pop-free. One MODE knob picks the response — Low-pass (attenuate above cutoff), High-pass (attenuate below), Band-pass (peak at cutoff), Notch (dip at cutoff), or Allpass (flat magnitude, phase-rotating) — and the card prints the long-form name of the current mode next to the knob. The input is stereo-aware (independent L/R filter state preserves the image), CUTOFF and RESONANCE are CV-modulatable, and a MIX knob crossfades dry to wet (turn it to 0 for bypass). A general-purpose tone-shaper for both subtractive synth voices and full mixes.",
    inputs: {
      audio: "The signal to filter (mono or stereo). A stereo source keeps its left/right separation through independent per-channel filter state; a mono source feeds both channels.",
      cutoff_cv: "CV control of the CUTOFF frequency — patch an envelope or LFO here for filter sweeps (it adds to the knob position).",
      reso_cv: "CV control of the RESONANCE — modulate the emphasis at the cutoff for talking/wah-style motion (adds to the knob position).",
    },
    outputs: {
      out_l: "Left filtered output (with the dry/wet MIX applied).",
      out_r: "Right filtered output. With a mono input it carries the same filtered signal as OUT L.",
    },
    controls: {
      cutoff: "The corner frequency the filter pivots around (20 Hz to 20 kHz, log, default 1 kHz) — what 'above'/'below'/'at cutoff' refers to for the selected mode. The CUTOFF CV input adds to this.",
      resonance: "Emphasis at the cutoff frequency (0 to 1, default 0.3): higher values sharpen the peak and ring more — subtle by default, pronounced toward 1. The RESO CV input adds to this.",
      mode: "Picks the filter response among Low-pass, High-pass, Band-pass, Notch, and Allpass (the chosen name is shown on the card). All five share one filter state so changing mode while audio plays is pop-free.",
      mix: "Dry/wet balance (0 to 1, default fully wet): 1 is the pure filtered signal, 0 is full bypass (the unfiltered input), and in between blends the two.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 2,
      // 2-channel input so a stereo source feeds L/R filter channels.
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
      outputChannelCount: [1, 1],
    });

    // Keep the node alive when nothing is patched in.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of resofilterDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['audio',     { node: workletNode, input: 0 }],
        ['cutoff_cv', { node: workletNode, input: 0, param: params.get('cutoff')! }],
        ['reso_cv',   { node: workletNode, input: 0, param: params.get('resonance')! }],
      ]),
      outputs: new Map([
        ['out_l', { node: workletNode, output: 0 }],
        ['out_r', { node: workletNode, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* */ }
        try { silence.disconnect(); } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};
