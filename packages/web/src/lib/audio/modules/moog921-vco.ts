// packages/web/src/lib/audio/modules/moog921-vco.ts
//
// MOOG 921 VCO — the first module of the Moog System 55 / 35 clone
// initiative (.myrobots/MOOG/). Voltage-controlled oscillator faithful to
// the original 921: ONE oscillator core presenting four simultaneous
// waveform jacks (sine / triangle / sawtooth / rectangular with variable
// pulse width), 1V/oct + linear frequency-control inputs, and a
// hard/soft/off sync switch. Shared by SYS55 + SYS35 (categorized under
// Ports → moogafakkin per the plan's resolved Q4).
//
// DSP: own-code polyBLEP oscillator (packages/dsp/src/moog921-vco.ts +
// lib/moog-vco-dsp.ts) — permissive, not a port of any Moog schematic or
// copyleft source (.myrobots/MOOG/LICENSING.md).
//
// Inputs:
//   pitch (pitch): V/oct pitch input, 0 V = C4. Exponential frequency control.
//   lin_fm (audio): audio-rate LINEAR frequency-control input (the 921's
//     dedicated linear input), scaled by the linFmAmount param.
//   sync (audio): external sync source; rising edges reset/nudge the phase
//     per the sync mode switch.
//   width_cv (cv, paramTarget=width): audio-rate pulse-width CV summed onto
//     the WIDTH knob (PASSTHROUGH — summed per-sample in the worklet).
//   octave (cv, linear, paramTarget=octave): displaces the RANGE knob (octaves).
//   tune (cv, linear, paramTarget=tune): displaces the FREQUENCY fine knob.
//   linFmAmount (cv, linear, paramTarget=linFmAmount): displaces lin-FM depth.
//   level (cv, linear, paramTarget=level): displaces the output level.
//
// Outputs:
//   sine (audio): sine tap.
//   triangle (audio): triangle tap.
//   sawtooth (audio): band-limited sawtooth tap.
//   rectangular (audio): pulse/rectangular tap; duty cycle = WIDTH.
//
// Params:
//   octave (linear -5..5, default 0): RANGE coarse, in octaves.
//   tune (linear -12..12, default 0): FREQUENCY fine, in semitones.
//   width (linear 0.02..0.98, default 0.5): rectangular pulse width / duty.
//   linFmAmount (linear -1..1, default 0): linear-FM input depth.
//   sync (linear -1..1, default 0): sync switch. -1 soft / 0 off / +1 hard.
//   level (linear 0..2, default 1): output gain.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/moog921-vco.js?url';

// Per-context cache so addModule isn't called twice on the same context.
const loadedContexts = new WeakSet<BaseAudioContext>();

export const moog921VcoDef: AudioModuleDef = {
  type: 'moog921Vco',
  palette: { top: 'Moog System 35/55 Clones', sub: 'Moog System 35/55 Clones' },
  domain: 'audio',
  label: '921 vco',
  category: 'sources',

  inputs: [
    { id: 'pitch',    type: 'pitch' },
    { id: 'lin_fm',   type: 'audio' },
    { id: 'sync',     type: 'audio' },
    // width_cv is audio-rate (the worklet sums width knob + CV per-sample),
    // so it doesn't go through the CV→AudioParam fast path. paramTarget keeps
    // docs labelling correct; no cvScale (PASSTHROUGH_BY_DESIGN, like
    // wavetableVco.wavePos).
    { id: 'width_cv', type: 'cv', paramTarget: 'width' },
    // CV → AudioParam routings (engine attaches a scaler so an LFO ±1 sweeps
    // the full natural range centered on the knob).
    { id: 'octave',      type: 'cv', paramTarget: 'octave',      cvScale: { mode: 'linear' } },
    { id: 'tune',        type: 'cv', paramTarget: 'tune',        cvScale: { mode: 'linear' } },
    { id: 'linFmAmount', type: 'cv', paramTarget: 'linFmAmount', cvScale: { mode: 'linear' } },
    { id: 'level',       type: 'cv', paramTarget: 'level',       cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'sine',        type: 'audio' },
    { id: 'triangle',    type: 'audio' },
    { id: 'sawtooth',    type: 'audio' },
    { id: 'rectangular', type: 'audio' },
  ],
  params: [
    { id: 'octave',      label: 'Range', defaultValue: 0,   min: -5,    max: 5,    curve: 'linear', units: 'oct' },
    { id: 'tune',        label: 'Freq',  defaultValue: 0,   min: -12,   max: 12,   curve: 'linear', units: 'st' },
    { id: 'width',       label: 'Width', defaultValue: 0.5, min: 0.02,  max: 0.98, curve: 'linear' },
    { id: 'linFmAmount', label: 'Lin FM',defaultValue: 0,   min: -1,    max: 1,    curve: 'linear' },
    { id: 'sync',        label: 'Sync',  defaultValue: 0,   min: -1,    max: 1,    curve: 'linear' },
    { id: 'level',       label: 'Level', defaultValue: 1,   min: 0,     max: 2,    curve: 'linear' },
  ],

  docs: {
    explanation:
      "A clean-room recreation of the Moog 921 Voltage Controlled Oscillator — the standalone, fully self-contained version of the System 55/35 oscillator (the 921A driver + 921B slave packed into one module). One oscillator core presents FOUR simultaneous waveform jacks off the same pitch — sine, triangle, sawtooth, and a rectangular pulse whose duty cycle you set with WIDTH — so you can take a pure sine to one place and a buzzy saw to another from a single voice. Pitch is exponential 1V/oct (0 V at the PITCH jack = C4), set by the RANGE (octave) and FREQ (fine) knobs and tracked across roughly 1 Hz to 40 kHz, with a dedicated LINEAR FM input for through-zero-style timbral modulation and a sync input that locks the core's phase to an external source. Mental model: it's a normal analog VCO with the Moog-ladder oscillator's band-limited (polyBLEP) waveshapes, four taps instead of a waveform selector.",
    inputs: {
      pitch:
        "1V/oct exponential pitch CV: 0 V plays C4 and every +1.0 raises the oscillator one octave. Patch a keyboard, sequencer, or the 921A driver bus here to play it; it sums on top of the RANGE + FREQ knobs.",
      lin_fm:
        "Audio-rate LINEAR frequency modulation input — adds to the frequency in Hz (not exponentially), so the modulation depth stays constant in pitch terms across the keyboard rather than widening with pitch. Its depth is set by the LIN FM knob; patch another oscillator here for clangorous FM/bell timbres.",
      sync:
        "External sync source: each rising edge resets (hard) or nudges (soft) the oscillator's phase to lock it to the incoming signal, per the SYNC switch — patch a second oscillator here and sweep this one's pitch for the classic hard-sync sweep.",
      width_cv:
        "Pulse-width CV: summed onto the WIDTH knob per sample so an LFO here animates the rectangular output's duty cycle (pulse-width modulation). It only affects the rectangular tap; the sine/triangle/saw stay fixed.",
      octave:
        "CV that displaces the RANGE knob in octaves (coarse pitch); a bipolar LFO/envelope here transposes the oscillator by whole octaves around the knob setting.",
      tune:
        "CV that displaces the FREQ fine knob in semitones; use it for subtle vibrato or fine detune layered on top of the 1V/oct pitch.",
      linFmAmount:
        "CV that displaces the LIN FM depth knob, so you can modulate how much linear FM the lin_fm input applies (e.g. open the FM with an envelope for a percussive attack).",
      level:
        "CV that displaces the output LEVEL, acting as a built-in VCA on every waveform tap — patch an envelope here to shape the oscillator's amplitude without an external VCA.",
    },
    outputs: {
      sine: "The pure sine tap — the fundamental with no harmonics. Same pitch as the other three taps.",
      triangle: "The triangle tap — a soft, hollow tone with only odd harmonics rolling off steeply (mellower than the saw).",
      sawtooth: "The band-limited sawtooth tap — the brightest, fullest waveform (all harmonics), the staple for subtractive bass and leads.",
      rectangular:
        "The rectangular / pulse tap — its duty cycle is set by the WIDTH knob (and width_cv); a 50% square is hollow, off-square pulses get nasal and thin, and sweeping the width is pulse-width modulation.",
    },
    controls: {
      octave: "Coarse pitch in whole octaves (RANGE), -5 to +5 around the patched 1V/oct pitch. The octave CV input adds on top of this.",
      tune: "Fine pitch trim in semitones (FREQ), ±12 (one octave each way) for tuning the oscillator against others or detuning for thickness.",
      width:
        "Duty cycle of the rectangular tap, 2% to 98% (0.5 = a 50% square). Only the rectangular output responds; sweep it (or modulate with width_cv) for pulse-width modulation.",
      linFmAmount: "How much the LINEAR FM input bends the pitch, ±1 — at 0 the lin_fm jack is silent; raise it for FM/bell timbres.",
      sync: "SYNC mode switch: -1 = soft sync (a gentle phase nudge), 0 = off, +1 = hard sync (a full phase reset on each edge of the sync input).",
      level: "Output gain on every waveform tap, 0 to 2 (1 = unity). Acts as the oscillator's own VCA; the level CV input adds on top.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'moog921-vco', {
      numberOfInputs: 4,
      numberOfOutputs: 4,
      outputChannelCount: [1, 1, 1, 1],
    });

    // Feed silence into every input so the node stays in the active
    // processing graph even when nothing's externally patched (mirrors the
    // analogVco silence-keepalive pattern).
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    silence.connect(workletNode, 0, 0);
    silence.connect(workletNode, 0, 1);
    silence.connect(workletNode, 0, 2);
    silence.connect(workletNode, 0, 3);

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of moog921VcoDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['pitch',    { node: workletNode, input: 0 }],
        ['lin_fm',   { node: workletNode, input: 1 }],
        ['sync',     { node: workletNode, input: 2 }],
        ['width_cv', { node: workletNode, input: 3 }],
        // CV → AudioParam fast-path; engine sums the scaled CV into these.
        ['octave',      { node: workletNode, input: 0, param: params.get('octave')!      }],
        ['tune',        { node: workletNode, input: 0, param: params.get('tune')!        }],
        ['linFmAmount', { node: workletNode, input: 0, param: params.get('linFmAmount')! }],
        ['level',       { node: workletNode, input: 0, param: params.get('level')!       }],
      ]),
      outputs: new Map([
        ['sine',        { node: workletNode, output: 0 }],
        ['triangle',    { node: workletNode, output: 1 }],
        ['sawtooth',    { node: workletNode, output: 2 }],
        ['rectangular', { node: workletNode, output: 3 }],
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
