// packages/web/src/lib/audio/modules/tidy-vco.ts
//
// TIDY VCO — flagship virtual-analog SUBTRACTIVE SYNTH VOICE (audio domain).
//
// ── Model ────────────────────────────────────────────────────────────────
// A complete 2-oscillator VA voice in one card: OSC1 + OSC2 (polyBLEP
// saw↔pulse SHAPE morph, shared PW/PWM, OSC2 octave + detune) + a −1-oct
// SUB square → a nonlinear zero-delay-feedback DIODE LADDER filter (the
// EMS VCS3 / TB-303 lineage — bidirectionally-coupled stages, per-stage
// saturation, a feedback squelch limiter, 2× oversampled; CUTOFF is
// calibrated to the RESONANT pitch so keytracked self-oscillation plays
// in tune) → dual RC-curve "punch" ADSRs (CEM3310-style exponential
// segments: filter EG + amp EG) → an OTA-flavored soft-knee VCA →
// equal-power stereo bus. 5-voice poly (the polyPitchGate chord bus,
// lane i → voice i) AND mono pitch/gate with a REAL 2-voice unison
// spread. All-new DSP — no shared filter/EG/VCA code with the catalog's
// transistor-ladder clones or SVF (owner directive: a distinct corner).
//
// ── Poly / mono / stereo ─────────────────────────────────────────────────
//   POLY: while any poly lane is gated the chord bus drives the voices
//   (fixed lane→voice, no allocator; a releasing voice HOLDS its pitch).
//   MONO: with no lane gated, the mono PITCH/GATE pair drives a 2-voice
//   unison — ±(7 ¢ · WIDTH) drift, panned ∓WIDTH, each side its OWN
//   filter + EGs + VCA (true stereo beating, not dual-mono). WIDTH also
//   fans the five poly voices across the field (root stays centered).
//
// ── DSP ──────────────────────────────────────────────────────────────────
//   Worklet: packages/dsp/src/tidy-vco.ts + lib/tidy-vco-dsp.ts. The
//   pure-math mirror (`tidyVcoMath`, re-exported below) is what unit
//   tests + ART exercise under node where AudioWorkletGlobalScope is
//   unavailable.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/tidy-vco.js?url';
import {
  TIDY_VOICES,
  TIDY_VCO_DEFAULTS,
  makeTidyVcoState,
  renderTidyVco,
  type TidyVcoBus,
  type TidyVcoParams,
  // The shared DSP lib (node-importable IDENTICAL source the worklet bundles).
} from '../../../../../dsp/src/lib/tidy-vco-dsp';

const loadedContexts = new WeakSet<BaseAudioContext>();
const PROCESSOR_NAME = 'tidy-vco';

export { TIDY_VOICES };

// ----------------------------------------------------------------------------
// Pure-math mirror — re-exported from the shared DSP lib so unit tests + ART
// can render TIDY VCO under node (worklets can't load without an
// AudioWorkletGlobalScope). This is the SAME source the worklet bundles, so
// there is no second copy to keep in sync.
// ----------------------------------------------------------------------------

export const tidyVcoMath = {
  TIDY_VOICES,
  defaults(): TidyVcoParams {
    return { ...TIDY_VCO_DEFAULTS };
  },
  makeState: makeTidyVcoState,
  render: renderTidyVco,
};
export type { TidyVcoBus, TidyVcoParams };

// ----------------------------------------------------------------------------
// Module def.
// ----------------------------------------------------------------------------

export const tidyVcoDef: AudioModuleDef = {
  type: 'tidyVco',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'tidy vco',
  category: 'sources',
  size: '3u', // natural box ≈ 527×720px (two full fader bands) → 3u × 4hp measured
  hp: 4,
  stereoPairs: [['out_l', 'out_r']],

  inputs: [
    // 5-lane poly chord bus → voices. NOT a paramTarget (poly is a direct
    // node connection, never a CV→AudioParam target). No `edge` on the
    // poly port — the per-lane gate edges are consumed inside the worklet.
    { id: 'poly', type: 'polyPitchGate' },
    // Mono pair (the fallback path when no poly lane is gated).
    { id: 'pitch', type: 'cv' },
    { id: 'gate', type: 'gate', edge: 'gate' },
    // Per-knob CV jacks, consumed DIRECTLY by the worklet (octave/full-swing
    // laws applied inside the core — kickdrum/clap convention).
    { id: 'cutoff_cv', type: 'cv' },
    { id: 'res_cv', type: 'cv' },
    { id: 'pwm_cv', type: 'cv' },
    { id: 'drive_cv', type: 'cv' },
  ],
  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],

  params: [
    // ── Oscillators ──
    { id: 'shape1', label: 'Shape 1', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'shape2', label: 'Shape 2', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'pw', label: 'PW', defaultValue: 0.5, min: 0.05, max: 0.5, curve: 'linear' },
    { id: 'detune', label: 'Detune', defaultValue: 6, min: -50, max: 50, curve: 'linear', units: '¢' },
    { id: 'oct2', label: 'Oct 2', defaultValue: 0, min: -1, max: 1, curve: 'discrete' },
    { id: 'mix', label: 'Mix', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
    { id: 'sub', label: 'Sub', defaultValue: 0.15, min: 0, max: 1, curve: 'linear' },
    // ── Filter ──
    { id: 'cutoff', label: 'Cutoff', defaultValue: 900, min: 40, max: 14000, curve: 'log', units: 'Hz' },
    { id: 'res', label: 'Res', defaultValue: 0.35, min: 0, max: 1, curve: 'linear' },
    { id: 'drive', label: 'Drive', defaultValue: 0.25, min: 0, max: 1, curve: 'linear' },
    { id: 'env', label: 'Env', defaultValue: 0.45, min: -1, max: 1, curve: 'linear' },
    { id: 'track', label: 'Track', defaultValue: 0.4, min: 0, max: 1, curve: 'linear' },
    // ── Filter EG ──
    { id: 'fatk', label: 'F.A', defaultValue: 0.005, min: 0.0005, max: 5, curve: 'log', units: 's' },
    { id: 'fdec', label: 'F.D', defaultValue: 0.35, min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'fsus', label: 'F.S', defaultValue: 0.2, min: 0, max: 1, curve: 'linear' },
    { id: 'frel', label: 'F.R', defaultValue: 0.3, min: 0.001, max: 5, curve: 'log', units: 's' },
    // ── Amp EG ──
    { id: 'atk', label: 'A', defaultValue: 0.003, min: 0.0005, max: 5, curve: 'log', units: 's' },
    { id: 'dec', label: 'D', defaultValue: 0.25, min: 0.001, max: 5, curve: 'log', units: 's' },
    { id: 'sus', label: 'S', defaultValue: 0.75, min: 0, max: 1, curve: 'linear' },
    { id: 'rel', label: 'R', defaultValue: 0.25, min: 0.001, max: 5, curve: 'log', units: 's' },
    // ── Global ──
    { id: 'width', label: 'Width', defaultValue: 0.4, min: 0, max: 1, curve: 'linear' },
    { id: 'level', label: 'Level', defaultValue: 0, min: -24, max: 12, curve: 'linear', units: 'dB' },
    // The card's manual gate pad (drone/audition — OR-ed with the gate input).
    { id: 'hold', label: 'Hold', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
  ],

  docs: {
    explanation:
      'A flagship two-oscillator virtual-analog subtractive voice: OSC1 and OSC2 each morph continuously from sawtooth to pulse (band-limited polyBLEP), share one pulse-width control with a PWM CV jack, and OSC2 adds an octave switch plus cents detune; a sub square one octave under OSC1 fattens the bottom. The mix feeds an all-new nonlinear zero-delay-feedback DIODE LADDER filter — the EMS VCS3 / TB-303 circuit family, deliberately distinct from a Moog-style transistor ladder: bidirectionally coupled stages give a softer, warmer knee into a 24 dB/oct slope, the resonance return passes through a squelch limiter so high RES compresses into a bounded, CLEAN self-oscillation whistle, and the CUTOFF knob is calibrated to the resonant pitch itself (keytracked self-osc plays in tune; the zero-res brightness knee sits well below the knob — the diode pole spread, part of the sound). DRIVE saturates into the filter for harmonic warmth (2× oversampled, loudness-compensated), and the diode ladder’s natural bass-loss at high resonance is deliberately only part-compensated — a musical squelch dip instead of a vanished low end. Two RC-curve ADSRs shape the note: real one-pole exponential segments in the CEM3310 lineage, whose attack charges toward an overshoot target and cuts over at full level — a convex, punchy front — with analog retrigger (a re-struck note resumes from its current level, never a click). The filter EG sweeps cutoff by up to ±4 octaves via ENV; the amp EG drives an OTA-flavored VCA whose tanh knee blooms gentle even harmonics as notes get louder. The voice is 5-voice polyphonic on the POLY chord bus (lane i drives voice i; a releasing voice holds its pitch), falls back to the mono PITCH/GATE pair when no lane is gated — where it plays a REAL two-voice unison, detuned ±7 cents times WIDTH and panned to opposite sides, each side with its own filter and envelopes — and WIDTH also fans the five poly voices across the stereo field with the root note anchored center.',
    inputs: {
      poly: 'The 5-lane poly pitch/gate chord bus: lane i drives voice i (fixed mapping, no allocator). Patch a real poly source — MIDI LANE, POLYSEQZ, or a SEQUENCER with chords — and each gated lane opens that voice’s own filter + amp envelopes; a releasing voice keeps sounding at its held pitch. While ANY lane is gated this bus wins over the mono pitch/gate pair.',
      pitch: 'Mono pitch CV, 1 V/oct with 0 V = C4. When no poly lane is gated, this drives the 2-voice unison pair (both voices track it, split by WIDTH’s detune drift).',
      gate: 'Mono gate (level-sensitive, not edge-only): high opens the unison pair’s envelopes, low releases them — note-off matters, an ADSR sustain lives while this is held. Poly lanes take precedence the moment any lane goes high.',
      cutoff_cv: 'Filter cutoff CV at 4 octaves per volt — a ±1 V full swing covers ±4 octaves around the CUTOFF knob. Audio-rate (per-sample) for filter FM growl.',
      res_cv: 'Resonance CV: ±1 V spans the whole RES range on top of the knob — sequence the squelch, or push a moderate knob setting over the self-osc threshold.',
      pwm_cv: 'Pulse-width modulation CV: ±0.45 duty per volt on the shared PW, audio-rate. Classic PWM strings come from an LFO here with SHAPE at pulse.',
      drive_cv: 'Drive CV: ±1 V spans the whole DRIVE range on top of the knob — automate the filter’s input saturation for building intensity.',
    },
    outputs: {
      out_l: 'Left output of the stereo voice bus (equal-power voice pans, 1/√n normalization, dB LEVEL, DC-blocked, true-peak bounded). Pairs with out_r — patching L into a stereo target auto-wires R.',
      out_r: 'Right output — the partner of out_l, carrying the WIDTH pan fan (poly) or the opposite unison voice (mono).',
    },
    controls: {
      shape1: 'OSC1 waveform morph: 0 = sawtooth, 1 = pulse, continuous crossfade between (both legs band-limited; the even harmonics drain out as it approaches the square).',
      shape2: 'OSC2 waveform morph, same law as SHAPE 1 (0 = saw, 1 = pulse).',
      pw: 'Shared pulse width for both oscillators’ pulse legs: 0.5 = square (even harmonics nulled) down to 0.05 = a thin reedy sliver. The PWM CV jack modulates around this.',
      detune: 'OSC2 detune in cents (±50): a few cents gives the classic two-osc VA shimmer (beat rate = the detune in Hz-fraction of the note), more approaches quarter-tone clash.',
      oct2: 'OSC2 octave switch: −1, 0, or +1 octave against OSC1.',
      mix: 'Equal-power OSC1↔OSC2 balance: 0 = OSC1 only, 1 = OSC2 only.',
      sub: 'Sub-oscillator level: a band-limited square one octave below OSC1, mixed under the pair for floor weight.',
      cutoff: 'Filter cutoff, 40 Hz–14 kHz — calibrated to the RESONANT pitch: at full RES the filter whistles AT this frequency (and tracks it to under 3 cents). The zero-res brightness knee sits a few octaves below the knob — the diode ladder’s soft spread knee, part of its warmth.',
      res: 'Resonance: squelchy diode-ladder emphasis that compresses through the feedback limiter as it rises; self-oscillation starts near 0.89 and the whistle stays bounded and near-sinusoidal. High RES thins the lows by a few dB by design (the part-compensated diode squelch dip).',
      drive: 'Input saturation into the ladder (2× oversampled tanh with loudness makeup): grows odd harmonics by tens of dB across the travel without acting as a volume knob.',
      env: 'Filter-EG amount, bipolar: up to ±4 octaves of cutoff sweep from the filter ADSR. Negative values pull the attack DARK and open into the sustain.',
      track: 'Cutoff keytracking, 0–100 %: at 100 % the filter (and its self-osc whistle) follows the keyboard exactly — play the resonance as a voice.',
      fatk: 'Filter EG attack time (RC-curve: exponential charge toward an overshoot target — front-loaded, punchy).',
      fdec: 'Filter EG decay time to the filter sustain level (−60 dB RC convention).',
      fsus: 'Filter EG sustain level — the settled brightness while a note is held.',
      frel: 'Filter EG release time after note-off (the brightness falls at its own rate, independent of the amp tail).',
      atk: 'Amp attack time — the same convex RC punch: a re-struck note resumes from its current level (analog retrigger, no reset click).',
      dec: 'Amp decay time to SUSTAIN while the note is held.',
      sus: 'Amp sustain level (read live — sweeping it during a held note tracks).',
      rel: 'Amp release time after note-off.',
      width: 'Stereo width: in poly it fans the five voices across the field (root anchored center); in mono it engages the 2-voice unison — ±(7 ¢ × WIDTH) drift panned to opposite sides. 0 = center mono, 1 = full field.',
      level: 'Output level in dB (−24…+12) into the true-peak bound.',
      hold: 'Manual gate pad: hold/latch to drone the voice from the card (OR-ed with the GATE input — an external gate keeps working).',
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 7 audio-rate node inputs: poly (0, 10-ch), pitch (1), gate (2),
    // cutoff_cv (3), res_cv (4), pwm_cv (5), drive_cv (6). TWO mono outputs
    // (out_l, out_r).
    const worklet = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 7,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    // Keep the worklet alive with a single 0-offset silence source on every
    // input, so it processes blocks (and the HOLD pad can drone immediately)
    // even when nothing is patched yet. One ConstantSource, 7 connections.
    // The poly input relies on channelCountMode 'max' — a real 10-channel
    // cable fans it out when patched.
    const silence = ctx.createConstantSource();
    silence.offset.value = 0;
    silence.start();
    for (let i = 0; i < 7; i++) silence.connect(worklet, 0, i);

    // Set initial params from the persisted node state (or defaults).
    const params = worklet.parameters as unknown as Map<string, AudioParam>;
    const initial = node.params ?? {};
    for (const def of tidyVcoDef.params) {
      const v = initial[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    const inputsMap = new Map<string, { node: AudioNode; input: number }>();
    inputsMap.set('poly', { node: worklet, input: 0 });
    inputsMap.set('pitch', { node: worklet, input: 1 });
    inputsMap.set('gate', { node: worklet, input: 2 });
    inputsMap.set('cutoff_cv', { node: worklet, input: 3 });
    inputsMap.set('res_cv', { node: worklet, input: 4 });
    inputsMap.set('pwm_cv', { node: worklet, input: 5 });
    inputsMap.set('drive_cv', { node: worklet, input: 6 });

    return {
      domain: 'audio',
      inputs: inputsMap,
      outputs: new Map([
        ['out_l', { node: worklet, output: 0 }],
        ['out_r', { node: worklet, output: 1 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try {
          silence.stop();
        } catch {
          /* already stopped */
        }
        try {
          silence.disconnect();
        } catch {
          /* */
        }
        try {
          worklet.disconnect();
        } catch {
          /* */
        }
      },
    };
  },
};
