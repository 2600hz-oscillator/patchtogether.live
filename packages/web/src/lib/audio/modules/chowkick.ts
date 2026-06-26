// packages/web/src/lib/audio/modules/chowkick.ts
//
// CHOWKICK — synth-kick voice. Hand-port of ChowKick by Jatin Chowdhury /
// chowdsp (https://github.com/Chowdhury-DSP/ChowKick, BSD-3-Clause).
//
// Signal flow (matches the source plugin's Pulse Shape → Resonant Filter
// → Level UI):
//   gate_in (rising edge) → PulseShaper (width / amplitude / decay /
//     sustain) + Noise burst (amount / decay / cutoff / type) → summed
//     into a 2nd-order resonant peaking filter (freq + pitch_cv 1V/oct,
//     Q, damping, tight, bounce → tanh feedback saturation) → first-order
//     LPF (tone) × level (dB) → audio_out.
//
// Per-port DSP rationale lives in packages/dsp/src/lib/chowkick-dsp.ts.
// Source citation per ported block lives next to each helper in that file.
//
// CV convention: per ADR-004, CV inputs are bipolar -1..+1 with per-port
// `cvScale` hints — `linear` for additive params (width / amp / decay /
// sustain / damping / tight / bounce), `log` for natively log-spaced
// params (noise_cutoff / freq / q / tone / portamento / level), and
// `discrete` for the noise_type enum.
//
// LINK toggle (per upstream): when on, Q + Damping move together — the
// "tightness" macro behavior. Implemented in the worklet (midpoint
// blend) so it stays consistent under per-sample CV automation.
//
// Inputs:
//   gate_in (audio): rising edge fires a kick.
//   pitch_cv (cv, log, paramTarget=freq): 1V/oct → freq *= 2^pitch_cv
//     in the worklet (the worklet routes the pitch CV separately from
//     the freq AudioParam so 1V/oct is correctly applied as a multiplier
//     rather than a Hz offset).
//   *_cv: bipolar CV summed into the matching AudioParam.
//
// Outputs:
//   audio_out (audio): the mono kick voice.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/chowkick.js?url';

const PROCESSOR_NAME = 'chowkick';
const loadedContexts = new WeakSet<BaseAudioContext>();

export const chowkickDef: AudioModuleDef = {
  type: 'chowkick',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'chowkick',
  category: 'sources',
  schemaVersion: 1,
  ossAttribution: {
    author: 'ChowKick by Jatin Chowdhury / chowdsp, BSD-3-Clause',
  },

  inputs: [
    // gate_in is a 1-channel audio node connection (rising-edge detected
    // in the worklet — matches DRUMMERGIRL's gate input plumbing).
    { id: 'gate_in', type: 'gate' },
    // pitch_cv is its own node input (the worklet multiplies the freq
    // AudioParam by 2^pitch_cv to apply 1V/oct correctly — a freq CV
    // additively summed into the freq AudioParam would NOT be 1V/oct).
    { id: 'pitch_cv', type: 'cv' },
    // Per-knob CV inputs — bipolar -1..+1 → AudioParam summing with
    // cvScale hints per ADR-004.
    { id: 'width_cv',         type: 'cv', paramTarget: 'width',        cvScale: { mode: 'log' } },
    { id: 'amplitude_cv',     type: 'cv', paramTarget: 'amplitude',    cvScale: { mode: 'linear' } },
    { id: 'decay_cv',         type: 'cv', paramTarget: 'decay',        cvScale: { mode: 'linear' } },
    { id: 'sustain_cv',       type: 'cv', paramTarget: 'sustain',      cvScale: { mode: 'linear' } },
    { id: 'noise_amount_cv',  type: 'cv', paramTarget: 'noise_amount', cvScale: { mode: 'linear' } },
    { id: 'noise_decay_cv',   type: 'cv', paramTarget: 'noise_decay',  cvScale: { mode: 'linear' } },
    { id: 'noise_cutoff_cv',  type: 'cv', paramTarget: 'noise_cutoff', cvScale: { mode: 'log' } },
    { id: 'freq_cv',          type: 'cv', paramTarget: 'freq',         cvScale: { mode: 'log' } },
    { id: 'q_cv',             type: 'cv', paramTarget: 'q',            cvScale: { mode: 'log' } },
    { id: 'damping_cv',       type: 'cv', paramTarget: 'damping',      cvScale: { mode: 'linear' } },
    { id: 'tight_cv',         type: 'cv', paramTarget: 'tight',        cvScale: { mode: 'linear' } },
    { id: 'bounce_cv',        type: 'cv', paramTarget: 'bounce',       cvScale: { mode: 'linear' } },
    { id: 'tone_cv',          type: 'cv', paramTarget: 'tone',         cvScale: { mode: 'log' } },
    { id: 'portamento_cv',    type: 'cv', paramTarget: 'portamento',   cvScale: { mode: 'log' } },
    { id: 'level_cv',         type: 'cv', paramTarget: 'level',        cvScale: { mode: 'linear' } },
    // PUNCH params (PR feat/chowkick-oomph): pitch-sweep depth/decay + body drive.
    { id: 'pitch_amount_cv',  type: 'cv', paramTarget: 'pitch_amount', cvScale: { mode: 'linear' } },
    { id: 'pitch_decay_cv',   type: 'cv', paramTarget: 'pitch_decay',  cvScale: { mode: 'linear' } },
    { id: 'drive_cv',         type: 'cv', paramTarget: 'drive',        cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'audio_out', type: 'audio' },
  ],
  params: [
    // PUNCH DEFAULTS (PR feat/chowkick-oomph, tuning pass 2) — see the worklet
    // header. Pass 1 fixed the DC-blob into a real pitched ~80 Hz kick; pass 2
    // leans into perceptual PUNCH: a loud bright SNAP (noise 0.5 @ 5.5 kHz,
    // ~1.5 ms), a deep FAST chirp (pitch 0.9 / decay 0.28 ≈ 8 ms, start 4×), a
    // sharper body (q 1.6) and hotter drive (0.5). noise_cutoff + tone ranges
    // pushed (8 kHz / 4 kHz) so the user can dial an even brighter snap.
    { id: 'width',         label: 'Width',     defaultValue: 0.5,   min: 0.1, max: 50,   curve: 'log',      units: 'ms' },
    { id: 'amplitude',     label: 'Amp',       defaultValue: 1,     min: 0,   max: 2,    curve: 'linear' },
    { id: 'decay',         label: 'Decay',     defaultValue: 0.3,   min: 0,   max: 1,    curve: 'linear' },
    { id: 'sustain',       label: 'Sustain',   defaultValue: 0,     min: 0,   max: 1,    curve: 'linear' },
    { id: 'noise_amount',  label: 'N Amt',     defaultValue: 0.5,   min: 0,   max: 1,    curve: 'linear' },
    { id: 'noise_decay',   label: 'N Dec',     defaultValue: 0.07,  min: 0,   max: 1,    curve: 'linear' },
    { id: 'noise_cutoff',  label: 'N Cut',     defaultValue: 5500,  min: 20,  max: 8000, curve: 'log',      units: 'Hz' },
    { id: 'noise_type',    label: 'N Type',    defaultValue: 0,     min: 0,   max: 3,    curve: 'discrete' },
    { id: 'freq',          label: 'Freq',      defaultValue: 80,    min: 20,  max: 500,  curve: 'log',      units: 'Hz' },
    { id: 'q',             label: 'Q',         defaultValue: 1.6,   min: 0.1, max: 10,   curve: 'log' },
    { id: 'damping',       label: 'Damp',      defaultValue: 0.4,   min: 0,   max: 1,    curve: 'linear' },
    { id: 'tight',         label: 'Tight',     defaultValue: 0.6,   min: 0,   max: 1,    curve: 'linear' },
    { id: 'bounce',        label: 'Bounce',    defaultValue: 0,     min: 0,   max: 1,    curve: 'linear' },
    { id: 'tone',          label: 'Tone',      defaultValue: 3200,  min: 50,  max: 4000, curve: 'log',      units: 'Hz' },
    { id: 'portamento',    label: 'Porta',     defaultValue: 0.5,   min: 0,   max: 100,  curve: 'log',      units: 'ms' },
    { id: 'level',         label: 'Level',     defaultValue: 0,     min: -60, max: 0,    curve: 'linear',   units: 'dB' },
    { id: 'link',          label: 'Link',      defaultValue: 0,     min: 0,   max: 1,    curve: 'discrete' },
    { id: 'pitch_amount',  label: 'P Amt',     defaultValue: 0.9,   min: 0,   max: 1,    curve: 'linear' },
    { id: 'pitch_decay',   label: 'P Dec',     defaultValue: 0.28,  min: 0,   max: 1,    curve: 'linear' },
    { id: 'drive',         label: 'Drive',     defaultValue: 0.5,   min: 0,   max: 1,    curve: 'linear' },
  ],

  docs: {
    explanation:
      "A physical-modeling synth-kick voice, ported from Chowdhury DSP's ChowKick. Instead of a simple sine + envelope, it strikes a tuned 2-pole resonant filter with a shaped pulse plus a noise burst — the filter rings like a struck drum body, so the character comes from how you excite and tune that resonator. The signal path is two bands you tune separately: a PULSE SHAPE band (the click/transient and its noise) feeds a RESONANT FILTER band (the pitched body), then a pitch-sweep 'punch', drive saturation, and tone/level on the way out. The card draws a live preview of the pulse envelope and the filter's resonant peak so you can see the kick you're sculpting. Trigger it from a gate; tune the body with the Freq knob or a 1V/oct CV. Every knob also has a CV input for animated, per-hit kicks.",
    inputs: {
      gate_in: "The trigger: a rising edge strikes the resonator (fires the pulse + noise burst that excite the body). Each edge is one kick; the hit's length comes from the decay/damping controls, not how long the gate stays high.",
      pitch_cv: "A 1V/oct pitch input applied as a multiplier on the body Freq (the worklet does freq × 2^pitch_cv), so it tracks pitch correctly across octaves — patch a sequencer here to tune kicks melodically. This is separate from the freq_cv summing input.",
      width_cv: "CV that scales the pulse Width (log).",
      amplitude_cv: "CV that adds to the pulse Amp (the excitation strength).",
      decay_cv: "CV that adds to the pulse Decay.",
      sustain_cv: "CV that adds to the pulse Sustain floor.",
      noise_amount_cv: "CV that adds to the Noise Amount (how much transient noise is mixed into the strike).",
      noise_decay_cv: "CV that adds to the Noise Decay.",
      noise_cutoff_cv: "CV that scales the Noise Cutoff (log) — the brightness of the click.",
      freq_cv: "CV that scales the body Freq (log, summed) — for filter/pitch sweeps that aren't 1V/oct-tracked (use pitch_cv for true octave tracking).",
      q_cv: "CV that scales the resonator Q (log) — the sharpness/ring of the body.",
      damping_cv: "CV that adds to Damping (the ring time: long boom vs short thud).",
      tight_cv: "CV that adds to Tight (the tightness macro affecting the body's snap).",
      bounce_cv: "CV that adds to Bounce (extra resonant feedback/saturation character).",
      tone_cv: "CV that scales the output Tone low-pass cutoff (log).",
      portamento_cv: "CV that scales the Portamento glide time (log).",
      level_cv: "CV that adds to the output Level (dB).",
      pitch_amount_cv: "CV that adds to the Pitch Amount (depth of the per-hit downward pitch sweep — the 'punch').",
      pitch_decay_cv: "CV that adds to the Pitch Decay (how fast that sweep settles).",
      drive_cv: "CV that adds to Drive (the body saturation/overdrive).",
    },
    outputs: {
      audio_out: "The mono kick voice — the excited resonant body, pitch-swept, driven, and tone/level-shaped. Patch to a mixer or bus.",
    },
    controls: {
      width: "PULSE SHAPE: width of the excitation pulse (0.1–50 ms, log) — how long the strike pushes the body before it decays; shown in the envelope preview.",
      amplitude: "PULSE SHAPE: strength of the excitation pulse (0..2) — how hard the body is struck.",
      decay: "PULSE SHAPE: how quickly the pulse falls after its hold (0..1).",
      sustain: "PULSE SHAPE: the floor the pulse decays toward (0..1) — raise it to sustain the strike rather than let it die fully.",
      noise_amount: "PULSE SHAPE: how much filtered noise is added to the strike (0..1) — adds click/snap and grit to the attack.",
      noise_decay: "PULSE SHAPE: decay time of the noise burst (0..1).",
      noise_cutoff: "PULSE SHAPE: low-pass cutoff of the noise (20–8000 Hz, log) — the brightness/color of the click.",
      noise_type: "PULSE SHAPE: the noise color (discrete: Uniform, Gaussian, Pink, Velvet) — different textures for the strike's noise.",
      freq: "RESONANT FILTER: the body's tuned frequency (20–500 Hz, log) — the kick's pitch; the resonant peak is shown in the filter preview. The pitch_cv input tracks this in 1V/oct.",
      q: "RESONANT FILTER: resonance sharpness (0.1–10, log) — higher Q rings longer and more tonally.",
      damping: "RESONANT FILTER: the ring time / pole radius (0..1) — low = a long boom, high = a short thud.",
      tight: "RESONANT FILTER: the tightness macro (0..1) tightening the body's snap; when LINK is on it moves together with Q and Damping.",
      bounce: "RESONANT FILTER: extra resonant feedback/saturation character on the body (0..1) for a livelier, springier ring.",
      tone: "Output low-pass tone (50–4000 Hz, log) — rolls off the top end of the whole kick.",
      portamento: "Pitch glide time between consecutive notes (0–100 ms, log) — for sliding kick tunings.",
      level: "Output level in dB (-60 to 0).",
      link: "Tightness LINK toggle (0 = off, 1 = on): when on, Q and Damping move together as one 'tightness' macro, the upstream plugin's coupled behavior.",
      pitch_amount: "PUNCH: depth of the fast downward pitch sweep at the start of each hit (0..1) — the chirp that gives the kick its punch.",
      pitch_decay: "PUNCH: how fast that pitch sweep settles to the body Freq (0..1) — short for a sharp click, longer for a deeper drop.",
      drive: "PUNCH: body saturation/overdrive (0..1) — adds harmonics and loudness/heat to the kick.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 2 audio-rate node inputs: gate (input 0) + pitch_cv (input 1). All
    // other CV inputs route via AudioParams, not separate node connections.
    const worklet = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    // Keep the worklet "alive" with silence sources on the audio-rate
    // inputs, so it processes blocks even when nothing is patched. Matches
    // the DRUMMERGIRL pattern.
    const merger = ctx.createChannelMerger(2);
    merger.connect(worklet);
    const silenceGate = ctx.createConstantSource();
    silenceGate.offset.value = 0;
    silenceGate.start();
    silenceGate.connect(merger, 0, 0);
    const silencePitch = ctx.createConstantSource();
    silencePitch.offset.value = 0;
    silencePitch.start();
    silencePitch.connect(merger, 0, 1);

    // Set initial params from the persisted node state (or defaults).
    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of chowkickDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    // Input map: gate + pitch route to the merger (worklet input 0/1
    // respectively); per-knob CV inputs route into AudioParams.
    const inputsMap = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>();
    inputsMap.set('gate_in',  { node: merger, input: 0 });
    inputsMap.set('pitch_cv', { node: merger, input: 1 });
    // CV → AudioParam. The `input` index is required by the engine's
    // adapter type but unused for param-targeted edges (the engine
    // connects the CV source directly into the AudioParam).
    const paramCv: Array<[string, string]> = [
      ['width_cv',        'width'],
      ['amplitude_cv',    'amplitude'],
      ['decay_cv',        'decay'],
      ['sustain_cv',      'sustain'],
      ['noise_amount_cv', 'noise_amount'],
      ['noise_decay_cv',  'noise_decay'],
      ['noise_cutoff_cv', 'noise_cutoff'],
      ['freq_cv',         'freq'],
      ['q_cv',            'q'],
      ['damping_cv',      'damping'],
      ['tight_cv',        'tight'],
      ['bounce_cv',       'bounce'],
      ['tone_cv',         'tone'],
      ['portamento_cv',   'portamento'],
      ['level_cv',        'level'],
      ['pitch_amount_cv', 'pitch_amount'],
      ['pitch_decay_cv',  'pitch_decay'],
      ['drive_cv',        'drive'],
    ];
    for (const [portId, paramId] of paramCv) {
      const p = params.get(paramId);
      if (p) inputsMap.set(portId, { node: worklet, input: 0, param: p });
    }

    return {
      domain: 'audio',
      inputs: inputsMap,
      outputs: new Map([['audio_out', { node: worklet, output: 0 }]]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { silenceGate.stop(); } catch { /* already stopped */ }
        try { silencePitch.stop(); } catch { /* already stopped */ }
        try { silenceGate.disconnect(); } catch { /* */ }
        try { silencePitch.disconnect(); } catch { /* */ }
        try { merger.disconnect(); } catch { /* */ }
        try { worklet.disconnect(); } catch { /* */ }
      },
    };
  },
};
