// packages/web/src/lib/audio/modules/pentemelodica.ts
//
// PENTEMELODICA — 5-voice polyphonic analog-style synth (audio domain).
//
// ── Model ────────────────────────────────────────────────────────────────
// A complete polyphonic synth voice-card in one module. A POLY input (the
// 10-channel polyPitchGate chord bus emitted by MIDI LANE / POLYSEQZ /
// SEQUENCER-with-chords) drives five independent analog-style VCO voices. Lane
// i → voice i (fixed 1:1 mapping, no allocator). Each voice has:
//   * a band-limited oscillator (clean-room polyBLEP, anti-aliased) with a
//     continuous tri→saw→square WAVE morph,
//   * TUNE (coarse st) + FINE (cents),
//   * exponential FM and through-phase PM, both driven by the voice's own
//     audio-rate FM jack (fm1..fm5),
//   * a pulse-width control for the square end of the morph,
//   * its own ADSR envelope (gate edge from the poly lane).
//
// The five post-ADSR voices are summed through a stereo mixer (per-voice LEVEL
// + equal-power PAN), then through an embedded multimode filter — a continuous
// LP→BP→HP→Notch MODE dial on a TPT state-variable filter (CUTOFF / RESONANCE)
// with a WET/DRY bypass — and out the stereo OUT_L / OUT_R pair. Each voice's
// pre-mixer mono signal is also tapped to a VOICE1..VOICE5 output for
// per-voice processing / scoping.
//
// ── Inputs ───────────────────────────────────────────────────────────────
//   poly  (polyPitchGate): 5-lane pitch/gate chord bus. Lane i drives voice i.
//   fm1..fm5     (audio) : per-voice audio-rate FM/PM modulator. Voice n reads
//                          fm{n}; the FM (exponential) and PM (phase) depths
//                          are set by that voice's FM / PM faders. A shared
//                          jack drives both so one modulator gives either or
//                          both flavours of modulation.
//
// ── Outputs ──────────────────────────────────────────────────────────────
//   out_l, out_r (audio) : stereo mix, post-filter, post-master-gain.
//   voice1..voice5(audio): per-voice pre-mixer mono tap (post-ADSR, BEFORE
//                          level/pan) — patch into your own VCA / filter / FX.
//
// ── Params (60: 5 voices × 12 + 4 filter) ──────────────────────────────────
//   per voice vN_: tune(st) fine(¢) fm pm pw wave attack(s) decay(s) sustain
//                  release(s) level pan
//   filter:        cutoff(Hz) resonance mode wetdry
//
// ── CV / patching ──────────────────────────────────────────────────────────
//   This first slice exposes the poly chord bus + five per-voice FM jacks. The
//   60 voice/filter params are panel controls (k-rate AudioParams); LFO-able
//   cutoff / per-voice CV jacks are a deliberate follow-up — keep the v1
//   surface to the six declared input buses.
//
// ── Usage ────────────────────────────────────────────────────────────────
//   Patch MIDI LANE (mode=poly) or POLYSEQZ → poly to play chords; dial each
//   voice's TUNE/FINE for unison/detune/spread, set per-voice ADSR + WAVE for
//   the timbre, then sculpt the whole stack with the embedded filter. Tap a
//   voiceN out to send one voice somewhere else (e.g. a reverb on the top
//   voice only). The stereo OUT keeps the per-voice PAN spread.
//
// ── DSP ──────────────────────────────────────────────────────────────────
//   Worklet: packages/dsp/src/pentemelodica.ts + lib/pentemelodica-dsp.ts.
//   Own-code: polyBLEP oscillator (lib/moog-vco-dsp), TPT SVF
//   (lib/resofilter-dsp), helm-style Envelope. The pure-math mirror
//   (`pentemelodicaMath`, re-exported below) is what unit tests + ART exercise
//   under node where AudioWorkletGlobalScope is unavailable.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/pentemelodica.js?url';
import {
  PENTE_VOICES,
  makePenteState,
  makeRenderOut,
  renderPentemelodica,
  type PenteParams,
  type PenteVoiceParams,
  type PenteFilterParams,
  // The shared DSP lib (node-importable IDENTICAL source the worklet bundles).
} from '../../../../../dsp/src/lib/pentemelodica-dsp';

const loadedContexts = new WeakSet<BaseAudioContext>();

export { PENTE_VOICES };

// ----------------------------------------------------------------------------
// Pure-math mirror — re-exported from the shared DSP lib so unit tests + ART
// can render PENTEMELODICA under node (worklets can't load without an
// AudioWorkletGlobalScope). This is the SAME source the worklet bundles, so
// there is no second copy to keep in sync.
// ----------------------------------------------------------------------------

export interface PentemelodicaRenderInput {
  /** length 2*PENTE_VOICES: [pitchV0, gate0, …, pitchV4, gate4]. */
  polyPitchGate: number[];
  /** per-voice FM/PM modulator (constant). length PENTE_VOICES, default 0s. */
  fmInputs?: number[];
  voices: PenteVoiceParams[];
  filter: PenteFilterParams;
}

export const pentemelodicaMath = {
  PENTE_VOICES,
  /** Render `n` samples; returns stereo L/R + per-voice pre-mixer taps. */
  render(n: number, sr: number, input: PentemelodicaRenderInput) {
    const state = makePenteState();
    const out = makeRenderOut(n);
    const params: PenteParams = { voices: input.voices, filter: input.filter };
    const fm = input.fmInputs ?? new Array(PENTE_VOICES).fill(0);
    renderPentemelodica(params, input.polyPitchGate, fm, n, sr, state, out);
    return out;
  },
};

// ----------------------------------------------------------------------------
// Module def.
// ----------------------------------------------------------------------------

type ParamDef = AudioModuleDef['params'][number];

/** Build the per-voice param list (×5). */
function voiceParams(): ParamDef[] {
  const ps: ParamDef[] = [];
  for (let v = 1; v <= PENTE_VOICES; v++) {
    ps.push(
      { id: `v${v}_tune`,    label: 'Tune',    defaultValue: 0,     min: -36,  max: 36,  curve: 'linear', units: 'st' },
      { id: `v${v}_fine`,    label: 'Fine',    defaultValue: 0,     min: -100, max: 100, curve: 'linear', units: '¢' },
      { id: `v${v}_fm`,      label: 'FM',      defaultValue: 0,     min: -1,   max: 1,   curve: 'linear' },
      { id: `v${v}_pm`,      label: 'PM',      defaultValue: 0,     min: -1,   max: 1,   curve: 'linear' },
      { id: `v${v}_pw`,      label: 'PW',      defaultValue: 0.5,   min: 0.05, max: 0.95, curve: 'linear' },
      { id: `v${v}_wave`,    label: 'Wave',    defaultValue: 0,     min: 0,    max: 1,   curve: 'linear' },
      { id: `v${v}_attack`,  label: 'Atk',     defaultValue: 0.005, min: 0.001, max: 5,  curve: 'log', units: 's' },
      { id: `v${v}_decay`,   label: 'Dec',     defaultValue: 0.1,   min: 0.001, max: 5,  curve: 'log', units: 's' },
      { id: `v${v}_sustain`, label: 'Sus',     defaultValue: 0.7,   min: 0,    max: 1,   curve: 'linear' },
      { id: `v${v}_release`, label: 'Rel',     defaultValue: 0.2,   min: 0.001, max: 5,  curve: 'log', units: 's' },
      { id: `v${v}_level`,   label: 'Level',   defaultValue: 0.8,   min: 0,    max: 1,   curve: 'linear' },
      { id: `v${v}_pan`,     label: 'Pan',     defaultValue: 0,     min: -1,   max: 1,   curve: 'linear' },
    );
  }
  return ps;
}

export const pentemelodicaDef: AudioModuleDef = {
  type: 'pentemelodica',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'PENTEMELODICA',
  category: 'sources',
  schemaVersion: 1,
  stereoPairs: [['out_l', 'out_r']],

  inputs: [
    // 5-lane poly chord bus → voices. NOT a paramTarget (poly is a direct
    // node connection, never a CV→AudioParam target).
    { id: 'poly', type: 'polyPitchGate' },
    // Per-voice audio-rate FM/PM modulator jacks.
    { id: 'fm1', type: 'audio' },
    { id: 'fm2', type: 'audio' },
    { id: 'fm3', type: 'audio' },
    { id: 'fm4', type: 'audio' },
    { id: 'fm5', type: 'audio' },
  ],
  outputs: [
    { id: 'out_l',  type: 'audio' },
    { id: 'out_r',  type: 'audio' },
    { id: 'voice1', type: 'audio' },
    { id: 'voice2', type: 'audio' },
    { id: 'voice3', type: 'audio' },
    { id: 'voice4', type: 'audio' },
    { id: 'voice5', type: 'audio' },
  ],
  params: [
    ...voiceParams(),
    { id: 'cutoff',    label: 'Cutoff', defaultValue: 1000, min: 20, max: 20000, curve: 'log', units: 'Hz' },
    { id: 'resonance', label: 'Reso',   defaultValue: 0.2,  min: 0,  max: 0.99,  curve: 'linear' },
    { id: 'mode',      label: 'Mode',   defaultValue: 0,    min: 0,  max: 1,     curve: 'linear' },
    { id: 'wetdry',    label: 'Wet',    defaultValue: 1,    min: 0,  max: 1,     curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'pentemelodica', {
      // 6 inputs: poly (10-ch) + fm1..fm5 (mono). 7 outputs: out_l, out_r +
      // voice1..voice5, all mono. channelCountMode defaults to 'max' so the
      // 10-channel poly source passes through input 0 cleanly (same as DX7 /
      // CUBE).
      numberOfInputs: 6,
      numberOfOutputs: 7,
      outputChannelCount: [1, 1, 1, 1, 1, 1, 1],
    } as AudioWorkletNodeOptions);

    // Silence keep-alive: feed a 0-offset ConstantSource into every input bus
    // so the node stays in the active processing graph even when nothing is
    // patched (mirrors moog921-vco / analogVco).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    for (let k = 0; k < 6; k++) silence.connect(workletNode, 0, k);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of pentemelodicaDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['poly', { node: workletNode, input: 0 }],
        ['fm1',  { node: workletNode, input: 1 }],
        ['fm2',  { node: workletNode, input: 2 }],
        ['fm3',  { node: workletNode, input: 3 }],
        ['fm4',  { node: workletNode, input: 4 }],
        ['fm5',  { node: workletNode, input: 5 }],
      ]),
      outputs: new Map([
        ['out_l',  { node: workletNode, output: 0 }],
        ['out_r',  { node: workletNode, output: 1 }],
        ['voice1', { node: workletNode, output: 2 }],
        ['voice2', { node: workletNode, output: 3 }],
        ['voice3', { node: workletNode, output: 4 }],
        ['voice4', { node: workletNode, output: 5 }],
        ['voice5', { node: workletNode, output: 6 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silence.stop(); } catch { /* already stopped */ }
        try { silence.disconnect(); } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};
