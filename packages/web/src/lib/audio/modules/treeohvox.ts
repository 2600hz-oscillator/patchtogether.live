// packages/web/src/lib/audio/modules/treeohvox.ts
//
// TREE.oh.VOX — TB-303 voice slice. Web Audio factory + module def.
// The audio worklet (packages/dsp/src/treeohvox.ts) owns all DSP; this
// file wires the 10 input ports + 1 output + 6 AudioParams.
//
// Algorithmic source: Robin Schmidt's Open303 (MIT,
// https://github.com/RobinSchmidt/Open303). License is MIT — fully
// compatible with this repo's AGPL-3 (one-way MIT → AGPL relicense, per
// the relicense memo from PR Resume 2026-05-19).
//
// The voice slice ports rosic::TeeBeeFilter (TB_303 mode), rosic::Decay-
// Envelope, a simplified AR rosic::AnalogEnvelope, and the BlendOscillator
// (replaced with polyBLEP saw — see the lib's header for the rationale).
// The full 404 module — sequencer, transpose, slide, waveform-switch,
// accent/slide step buttons, TD-3 smiley — is a follow-up task.
//
// Input port layout (audio-rate node connections):
//   pitch_in    → input 0  (V/oct, summed into voice's pitch)
//   gate_in     → input 1  (0/1, rising edge triggers the envelope)
//   accent_in   → input 2  (0/1, latched at the gate edge to flag accent)
//   tune_cv     → input 3  (CV → tune AudioParam)
//   cutoff_cv   → input 4  (CV → cutoff AudioParam)
//   res_cv      → input 5  (CV → resonance AudioParam)
//   env_cv      → input 6  (CV → envelope AudioParam)
//   decay_cv    → input 7  (CV → decay AudioParam)
//   accent_cv   → input 8  (CV → accent AudioParam)
//
// Output port layout:
//   audio_out   → output 0 (mono)

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/treeohvox.js?url';

const PROCESSOR_NAME = 'treeohvox';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const treeohvoxDef: AudioModuleDef = {
  type: 'treeohvox',
  palette: { top: 'Ports', sub: 'Ports' },
  domain: 'audio',
  label: 'TREE.oh.VOX',
  category: 'sources',
  schemaVersion: 1,
  ossAttribution: { author: 'Robin Schmidt (Open303, MIT)' },

  inputs: [
    // Audio-rate node ports — pitch / gate / accent ride on dedicated
    // input slots so the worklet can read them without going through an
    // AudioParam (an AudioParam would smooth across the gate edge and
    // smear retriggers).
    { id: 'pitch_in',  type: 'pitch' },
    { id: 'gate_in',   type: 'gate' },
    { id: 'accent_in', type: 'gate' },
    // CV inputs targeting AudioParams. Linear cvScale = sum-into-param;
    // matches the rest of the rack's convention for knob CV.
    { id: 'tune_cv',     type: 'cv', paramTarget: 'tune',      cvScale: { mode: 'linear' } },
    { id: 'cutoff_cv',   type: 'cv', paramTarget: 'cutoff',    cvScale: { mode: 'linear' } },
    { id: 'res_cv',      type: 'cv', paramTarget: 'resonance', cvScale: { mode: 'linear' } },
    { id: 'env_cv',      type: 'cv', paramTarget: 'envelope',  cvScale: { mode: 'linear' } },
    { id: 'decay_cv',    type: 'cv', paramTarget: 'decay',     cvScale: { mode: 'linear' } },
    { id: 'accent_cv',   type: 'cv', paramTarget: 'accent',    cvScale: { mode: 'linear' } },
    { id: 'waveform_cv', type: 'cv', paramTarget: 'waveform',  cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'audio_out', type: 'audio' },
  ],
  params: [
    // TUNE — ±12 semitones from V/oct input. Default 0.
    { id: 'tune',      label: 'Tune',     defaultValue: 0,    min: -12,  max: 12,    curve: 'linear', units: 'st' },
    // CUTOFF — 40 Hz .. 6 kHz log taper, default 1 kHz (Open303 default).
    // The aggressive 6 kHz ceiling is the 303 character; modern filters
    // push to 20 kHz but the 303 polynomial approx + post chain assume
    // a much lower top end.
    { id: 'cutoff',    label: 'Cutoff',   defaultValue: 1000, min: 40,   max: 6000,  curve: 'log',    units: 'Hz' },
    // RESONANCE — 0..1 raw; the worklet skews it exponentially to match
    // Open303's resonanceSkewed math.
    { id: 'resonance', label: 'Reso',     defaultValue: 0.5,  min: 0,    max: 1,     curve: 'linear' },
    // ENVELOPE — env-mod depth on cutoff. 0..1 maps to 0..100% in
    // Open303's calculateEnvModScalerAndOffset terms.
    { id: 'envelope',  label: 'EnvMod',   defaultValue: 0.5,  min: 0,    max: 1,     curve: 'linear' },
    // DECAY — filter envelope decay time. 200 ms .. 2 s is the canonical
    // 303 range (Open303 normalDecay default is 1 s; Devil Fish mod
    // extends to 3 s — we cap at 3 s so DECAY can sweep into doom-y
    // sustained territory without losing the 303 feel).
    { id: 'decay',     label: 'Decay',    defaultValue: 600,  min: 50,   max: 3000,  curve: 'log',    units: 'ms' },
    // ACCENT — accent-amount. 0 = identical to non-accent; 1 = full
    // boost on both amp peak + filter env contribution. Default 0.5
    // — the brief specifies this as a tasteful starting position; 303
    // hardware accent is a single boolean on/off, this knob makes the
    // depth controllable.
    { id: 'accent',    label: 'Accent',   defaultValue: 0.5,  min: 0,    max: 1,     curve: 'linear' },
    // WAVEFORM — morphs the BlendOscillator: 0 = saw (classic 303), 1 = square.
    // Open303's BlendOscillator crossfades SAW303↔SQR303; default 0 keeps the
    // canonical saw voice (and existing ART baselines) unchanged.
    { id: 'waveform',  label: 'Wave',     defaultValue: 0,    min: 0,    max: 1,     curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 9 input slots: 3 audio-rate (pitch/gate/accent) + 6 CV-into-param.
    // The CV inputs are wired to AudioParams, but the AudioWorkletNode
    // still needs a numberOfInputs count that covers the audio-rate
    // signals. Web Audio routes the CV connections through the
    // AudioParam regardless of the input count; pitch/gate/accent need
    // genuine input slots since the worklet's process() reads
    // inputs[0..2].
    const workletNode = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 3,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
      outputChannelCount: [1],
    });

    // Silence-pump on the audio inputs so the worklet keeps decoding
    // (matches the videobox fix from PR #301). Without this an unpatched
    // TREE.oh.VOX wouldn't render reliably on Safari — process() is
    // skipped when an input has no source and outputs are unconnected.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);
    silence.connect(workletNode, 0, 1);
    silence.connect(workletNode, 0, 2);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of treeohvoxDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['pitch_in',  { node: workletNode, input: 0 }],
        ['gate_in',   { node: workletNode, input: 1 }],
        ['accent_in', { node: workletNode, input: 2 }],
        // CV-into-AudioParam ports use `input: 0` as a placeholder; the
        // engine uses the `param` field to do the real wiring via
        // `source.connect(param)`, never `source.connect(node, 0, n)`.
        // This mirrors the resofilter factory exactly.
        ['tune_cv',     { node: workletNode, input: 0, param: params.get('tune')! }],
        ['cutoff_cv',   { node: workletNode, input: 0, param: params.get('cutoff')! }],
        ['res_cv',      { node: workletNode, input: 0, param: params.get('resonance')! }],
        ['env_cv',      { node: workletNode, input: 0, param: params.get('envelope')! }],
        ['decay_cv',    { node: workletNode, input: 0, param: params.get('decay')! }],
        ['accent_cv',   { node: workletNode, input: 0, param: params.get('accent')! }],
        ['waveform_cv', { node: workletNode, input: 0, param: params.get('waveform')! }],
      ]),
      outputs: new Map([
        ['audio_out', { node: workletNode, output: 0 }],
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
