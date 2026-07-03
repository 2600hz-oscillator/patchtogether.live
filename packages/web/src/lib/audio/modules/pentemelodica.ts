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
//   * its own gated amplitude envelope — but the A/D/S/R is SHARED across all
//     five voices (one device-level ADSR; poly-adsr alignment with CUBE /
//     WAVECEL / DX7). The gate edge comes from the poly lane.
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
// ── Params (48: 5 voices × 8 + 4 shared ADSR + 4 filter) ───────────────────
//   per voice vN_: tune(st) fine(¢) fm pm pw wave level pan
//   shared ADSR:   attack(s) decay(s) sustain release(s)   (feeds all voices)
//   filter:        cutoff(Hz) resonance mode wetdry
//
// ── CV / patching ──────────────────────────────────────────────────────────
//   This first slice exposes the poly chord bus + five per-voice FM jacks. The
//   48 voice/ADSR/filter params are panel controls (k-rate AudioParams);
//   LFO-able cutoff / per-voice CV jacks are a deliberate follow-up — keep the
//   v1 surface to the six declared input buses.
//
// ── Usage ────────────────────────────────────────────────────────────────
//   Patch MIDI LANE (mode=poly) or POLYSEQZ → poly to play chords; dial each
//   voice's TUNE/FINE for unison/detune/spread, set the shared ADSR + per-voice
//   WAVE for the timbre, then sculpt the whole stack with the embedded filter.
//   Tap a
//   voiceN out to send one voice somewhere else (e.g. a reverb on the top
//   voice only). The stereo OUT keeps the per-voice PAN spread.
//
// ── DSP ──────────────────────────────────────────────────────────────────
//   Worklet: packages/dsp/src/pentemelodica.ts + lib/pentemelodica-dsp.ts.
//   Own-code: polyBLEP oscillator (lib/moog-vco-dsp), TPT SVF
//   (lib/resofilter-dsp), a linear-ADSR Envelope. The pure-math mirror
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
  type AdsrParams,
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
  /** ONE shared amplitude A/D/S/R fed into every voice envelope. Defaults to
   *  the param defaults (attack 0.001 / decay 0.1 / sustain 1 / release 0.005)
   *  when omitted. */
  adsr?: AdsrParams;
  filter: PenteFilterParams;
}

export const pentemelodicaMath = {
  PENTE_VOICES,
  /** Render `n` samples; returns stereo L/R + per-voice pre-mixer taps. */
  render(n: number, sr: number, input: PentemelodicaRenderInput) {
    const state = makePenteState();
    const out = makeRenderOut(n);
    const adsr: AdsrParams = input.adsr ?? {
      attack: 0.001, decay: 0.1, sustain: 1, release: 0.005,
    };
    const params: PenteParams = { voices: input.voices, adsr, filter: input.filter };
    const fm = input.fmInputs ?? new Array(PENTE_VOICES).fill(0);
    renderPentemelodica(params, input.polyPitchGate, fm, n, sr, state, out);
    return out;
  },
};

// ----------------------------------------------------------------------------
// Module def.
// ----------------------------------------------------------------------------

type ParamDef = AudioModuleDef['params'][number];

/** Build the per-voice param list (×5). The amplitude ADSR is NOT per-voice —
 *  one shared A/D/S/R (added separately below) feeds every voice envelope. */
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
  label: 'pentemelodica',
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
    // ONE shared amplitude ADSR (poly-adsr alignment) — same ids/ranges/curves/
    // defaults as CUBE's. Every voice envelope reads these (gated per-lane).
    { id: 'attack',  label: 'A', defaultValue: 0.001, min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'decay',   label: 'D', defaultValue: 0.1,   min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'sustain', label: 'S', defaultValue: 1,     min: 0,     max: 1, curve: 'linear' },
    { id: 'release', label: 'R', defaultValue: 0.005, min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'cutoff',    label: 'Cutoff', defaultValue: 1000, min: 20, max: 20000, curve: 'log', units: 'Hz' },
    { id: 'resonance', label: 'Reso',   defaultValue: 0.2,  min: 0,  max: 0.99,  curve: 'linear' },
    { id: 'mode',      label: 'Mode',   defaultValue: 0,    min: 0,  max: 1,     curve: 'linear' },
    { id: 'wetdry',    label: 'Wet',    defaultValue: 1,    min: 0,  max: 1,     curve: 'linear' },
  ],

  docs: {
    explanation:
      "A complete five-voice polyphonic analog-style synth in one card. A poly chord bus drives five independent VCO voices (lane i → voice i, a fixed 1:1 mapping with no allocator), each a band-limited oscillator with a continuous triangle→saw→square WAVE morph, coarse Tune + Fine detune, exponential FM and through-phase PM (from that voice's own FM jack), and a pulse-width control. The five voices share ONE amplitude ADSR (the gate edge comes from each poly lane), get summed through a per-voice level + pan stereo mixer, then pass through an embedded multimode filter (LP→BP→HP→Notch MODE dial, Cutoff/Resonance, Wet/Dry) to the stereo OUT. Each voice is also tapped pre-mixer to its own VOICE output for separate processing. To play chords you must feed the POLY input from a real poly source — patch MIDI LANE (in poly mode) or POLYSEQZ (or a SEQUENCER set to chord steps) into POLY; a single mono note source only lights one voice.",
    inputs: {
      poly: "The 5-lane poly pitch/gate chord bus that plays the voices: lane i drives voice i (fixed mapping). Patch a real poly source here — MIDI LANE in poly mode, POLYSEQZ, or SEQUENCER with chord steps — so each held note opens a voice's shared ADSR; a mono pitch source only plays voice 1.",
      fm1: "Voice 1's audio-rate modulator jack: it feeds both that voice's exponential FM and its phase modulation, with the depths set by voice 1's FM and PM faders — so one patched modulator gives either or both flavours.",
      fm2: "Voice 2's audio-rate FM/PM modulator jack (depths set by voice 2's FM/PM faders).",
      fm3: "Voice 3's audio-rate FM/PM modulator jack (depths set by voice 3's FM/PM faders).",
      fm4: "Voice 4's audio-rate FM/PM modulator jack (depths set by voice 4's FM/PM faders).",
      fm5: "Voice 5's audio-rate FM/PM modulator jack (depths set by voice 5's FM/PM faders).",
    },
    outputs: {
      out_l: "Left channel of the stereo mix: all five voices, post-ADSR, through the per-voice level/pan mixer and the embedded filter, at master level. (Pairs with out_r as the main stereo output.)",
      out_r: "Right channel of the stereo mix (the partner of out_l, carrying the per-voice pan spread).",
      voice1: "Voice 1's individual signal, tapped post-ADSR but BEFORE the mixer's level/pan and the shared filter — patch it to send just this voice to its own VCA/filter/FX.",
      voice2: "Voice 2's pre-mixer mono tap (post-ADSR, before level/pan/filter).",
      voice3: "Voice 3's pre-mixer mono tap (post-ADSR, before level/pan/filter).",
      voice4: "Voice 4's pre-mixer mono tap (post-ADSR, before level/pan/filter).",
      voice5: "Voice 5's pre-mixer mono tap (post-ADSR, before level/pan/filter).",
    },
    controls: {
      // Per-voice oscillator strip (×5). Same control on each voice; {N} is the
      // voice number 1..5.
      v1_tune: "Voice 1 coarse tune in semitones (-36 to +36) — set per voice for unison, octaves, or chord-spread detuning.",
      v2_tune: "Voice 2 coarse tune in semitones (-36 to +36).",
      v3_tune: "Voice 3 coarse tune in semitones (-36 to +36).",
      v4_tune: "Voice 4 coarse tune in semitones (-36 to +36).",
      v5_tune: "Voice 5 coarse tune in semitones (-36 to +36).",
      v1_fine: "Voice 1 fine tune in cents (-100 to +100) — for subtle detune/beating against the other voices.",
      v2_fine: "Voice 2 fine tune in cents (-100 to +100).",
      v3_fine: "Voice 3 fine tune in cents (-100 to +100).",
      v4_fine: "Voice 4 fine tune in cents (-100 to +100).",
      v5_fine: "Voice 5 fine tune in cents (-100 to +100).",
      v1_fm: "Voice 1 exponential-FM depth (-1..+1) from its FM 1 jack — adds inharmonic/clangy modulation.",
      v2_fm: "Voice 2 exponential-FM depth (-1..+1) from its FM 2 jack.",
      v3_fm: "Voice 3 exponential-FM depth (-1..+1) from its FM 3 jack.",
      v4_fm: "Voice 4 exponential-FM depth (-1..+1) from its FM 4 jack.",
      v5_fm: "Voice 5 exponential-FM depth (-1..+1) from its FM 5 jack.",
      v1_pm: "Voice 1 phase-modulation depth (-1..+1) from its FM 1 jack — the DX-style PM flavour of the same modulator.",
      v2_pm: "Voice 2 phase-modulation depth (-1..+1) from its FM 2 jack.",
      v3_pm: "Voice 3 phase-modulation depth (-1..+1) from its FM 3 jack.",
      v4_pm: "Voice 4 phase-modulation depth (-1..+1) from its FM 4 jack.",
      v5_pm: "Voice 5 phase-modulation depth (-1..+1) from its FM 5 jack.",
      v1_pw: "Voice 1 pulse width (0.05–0.95) — shapes the square end of the WAVE morph (50% is a true square).",
      v2_pw: "Voice 2 pulse width (0.05–0.95).",
      v3_pw: "Voice 3 pulse width (0.05–0.95).",
      v4_pw: "Voice 4 pulse width (0.05–0.95).",
      v5_pw: "Voice 5 pulse width (0.05–0.95).",
      v1_wave: "Voice 1 waveform morph (0..1): continuously blends triangle → saw → square; the per-voice scope shows the resulting shape.",
      v2_wave: "Voice 2 waveform morph (triangle → saw → square).",
      v3_wave: "Voice 3 waveform morph (triangle → saw → square).",
      v4_wave: "Voice 4 waveform morph (triangle → saw → square).",
      v5_wave: "Voice 5 waveform morph (triangle → saw → square).",
      v1_level: "Voice 1 mixer level (0..1) into the stereo bus.",
      v2_level: "Voice 2 mixer level (0..1) into the stereo bus.",
      v3_level: "Voice 3 mixer level (0..1) into the stereo bus.",
      v4_level: "Voice 4 mixer level (0..1) into the stereo bus.",
      v5_level: "Voice 5 mixer level (0..1) into the stereo bus.",
      v1_pan: "Voice 1 stereo pan (-1 = left … +1 = right), equal-power, placing the voice in the OUT image.",
      v2_pan: "Voice 2 stereo pan (-1 left … +1 right).",
      v3_pan: "Voice 3 stereo pan (-1 left … +1 right).",
      v4_pan: "Voice 4 stereo pan (-1 left … +1 right).",
      v5_pan: "Voice 5 stereo pan (-1 left … +1 right).",
      // Shared amplitude ADSR (feeds every voice envelope; gated per lane).
      attack: "Shared amplitude-envelope attack time (0.001–5 s, log): how fast each voice fades in when its poly lane's gate opens. One ADSR feeds all five voices.",
      decay: "Shared amplitude-envelope decay time (0.001–5 s, log): the fall from the attack peak down to the sustain level.",
      sustain: "Shared amplitude-envelope sustain level (0..1): the held level while a note's gate stays open.",
      release: "Shared amplitude-envelope release time (0.001–5 s, log): how long each voice takes to fade out after its gate closes.",
      // Embedded multimode filter (on the summed mix).
      cutoff: "Embedded filter cutoff frequency (20 Hz–20 kHz, log) applied to the summed five-voice mix.",
      resonance: "Embedded filter resonance (0–0.99): emphasis at the cutoff, up to near self-oscillation.",
      mode: "Embedded filter MODE dial (0..1): continuously morphs the SVF response low-pass → band-pass → high-pass → notch.",
      wetdry: "Embedded filter wet/dry mix (0 = dry/bypassed … 1 = fully filtered).",
    },
  },

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
