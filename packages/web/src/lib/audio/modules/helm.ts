// packages/web/src/lib/audio/modules/helm.ts
//
// HELM — polyphonic subtractive synth port (v1).
//
// Algorithm port of Matt Tytel's Helm (helm_engine.cpp / helm_voice_handler.cpp
// / helm_oscillators.cpp / helm_lfo.cpp / state_variable_filter.cpp /
// envelope.cpp / step_generator.cpp), Copyright 2013-2017 Matt Tytel, originally
// licensed GPL-3.0. This port is shipped under AGPL-3.0-or-later, the
// patchtogether.live project license (compatible with GPL-3.0 per FSF
// compatibility matrix). See https://tytel.org/helm.
//
// The worklet lives at packages/dsp/src/helm.ts. This file is the module def,
// the pure-math mirror for unit tests, and the Web MIDI bridge.
//
// v1 ships (matches the issue body):
//   - 4-8 voice polyphony.
//   - 2 morphing oscillators (saw/square/triangle/sine) with tune + transpose
//     + unison.
//   - 1 sub oscillator.
//   - Mixer for osc1/osc2/sub/noise.
//   - State-variable filter, 12dB/24dB LP/BP/HP via blend.
//   - 3 ADSR envelopes (amp/filter/mod).
//   - 2 mono LFOs.
//   - 16-step step sequencer.
//   - Polyphonic MIDI input via Web MIDI API (per-instance device picker +
//     channel filter, gated behind a gear icon on the card).
//   - Stereo output.
//
// Deferred (flagged in PR body): effects bus (distortion/delay/reverb/stutter/
// formant/feedback), arpeggiator, poly LFO, mod sources panel, BPM-locked LFO
// frequencies, modulation matrix (mod sources are pre-wired to musically
// sensible destinations in v1 — see the helm.ts worklet header).
//
// Inputs:
//   pitch_cv (cv): mono V/oct (legacy / step-sequence-driven).
//   gate (gate): mono gate.
//   midi_in (cv): legacy CV channel (kept for parity with other DX7-style modules).
//   seq_reset (gate): rising edge resets the internal step-sequencer.
//
// Outputs:
//   out_l / out_r (audio): stereo mixed voices.
//
// Params (~45 — Helm's full v1 surface):
//   voiceCount (discrete 1..8, default 6): polyphony cap.
//   volume (linear 0..2, default 0.7): master gain.
//   osc1Wave / osc2Wave (discrete 0..3, default 0/1): per-osc waveform (saw/square/tri/sine).
//   osc1Trans / osc2Trans (linear -24..24 st, default 0/0): per-osc transposition.
//   osc1Tune / osc2Tune (linear -100..100 c, default 0/7): per-osc cents fine-tune.
//   osc1Unison / osc2Unison (discrete 1..7, default 1): per-osc unison voice count.
//   osc1Detune / osc2Detune (linear 0..50 c, default 10): unison detune width.
//   osc1Vol / osc2Vol (linear 0..1, default 0.8/0.6): per-osc level.
//   subWave (discrete 0..3, default 3): sub-osc waveform.
//   subVol (linear 0..1, default 0.4): sub-osc level.
//   noiseVol (linear 0..1, default 0): noise mix.
//   filterCutoff (log 20..20000 Hz, default 4000): filter cutoff.
//   filterRes (linear 0.5..16, default 1.0): filter resonance.
//   filterBlend (linear 0..2, default 0): LP/BP/HP crossfade.
//   filterStyle (discrete 0..1, default 0): 12dB / 24dB pole count.
//   filterDrive (linear 0.5..6, default 1.0): pre-filter drive.
//   filterKeyTrack (linear -1..1, default 0.0): cutoff tracks pitch.
//   ampAttack / ampDecay / ampSustain / ampRelease (linear, default see header): amp envelope.
//   filAttack / filDecay / filSustain / filRelease + filEnvDepth: filter envelope.
//   modAttack / modDecay / modSustain / modRelease + modEnvDepth: aux mod envelope.
//   lfo1Wave / lfo1Freq / lfo1Amp + lfo2Wave / lfo2Freq / lfo2Amp: two LFOs.
//   stepNumSteps / stepRate / stepSmooth / stepDepth: built-in step-sequencer LFO.
//   spread (linear 0..1, default 0.3): stereo width.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/helm.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

// ---------------- Web MIDI minimal shapes (same as midi-cv-buddy.ts) ----------------

export interface MidiEventLike {
  data: Uint8Array;
  timeStamp: number;
}
interface MidiInputLike {
  id: string;
  name?: string | null;
  manufacturer?: string | null;
  state: string;
  onmidimessage: ((ev: MidiEventLike) => void) | null;
}
interface MidiAccessLike {
  inputs: Map<string, MidiInputLike>;
  onstatechange: ((ev: { port: MidiInputLike }) => void) | null;
}

function webMidiAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof (navigator as { requestMIDIAccess?: unknown }).requestMIDIAccess === 'function'
  );
}

// ---------------- Pure helpers (testable) ----------------

/** Returns a Set of channels (0-indexed, 0..15) selected; null = all. */
export function expandChannelSet(channels: number[] | null): Set<number> | null {
  if (channels === null) return null;
  const s = new Set<number>();
  for (const c of channels) {
    if (Number.isInteger(c) && c >= 0 && c < 16) s.add(c);
  }
  return s;
}

/** Test whether a status byte's channel matches the configured channel set
 *  (or any-channel mode when channelSet === null). */
export function midiChannelMatches(statusByte: number, channelSet: Set<number> | null): boolean {
  if (channelSet === null) return true;
  return channelSet.has(statusByte & 0x0f);
}

export type ParsedNoteEvent =
  | { kind: 'note-on'; note: number; velocity: number; channel: number }
  | { kind: 'note-off'; note: number; channel: number }
  | { kind: 'all-off'; channel: number }
  | null;

/** Parse a raw MIDI message into a normalized voice event. Returns null when
 *  the message is not a note/all-off. Handles velocity-0-as-note-off and
 *  CC 123 (All Notes Off). */
export function parseHelmMidiEvent(data: Uint8Array): ParsedNoteEvent {
  if (data.length < 1) return null;
  const status = data[0]!;
  const top = status & 0xf0;
  const channel = status & 0x0f;
  if (top === 0x90) {
    const note = data[1] ?? 0;
    const velocity = data[2] ?? 0;
    if (velocity === 0) return { kind: 'note-off', note, channel };
    return { kind: 'note-on', note, velocity, channel };
  }
  if (top === 0x80) {
    const note = data[1] ?? 0;
    return { kind: 'note-off', note, channel };
  }
  if (top === 0xb0) {
    const cc = data[1] ?? 0;
    if (cc === 123 || cc === 120) return { kind: 'all-off', channel };
  }
  return null;
}

// ---------------- Pure-math mirror (used by tests) ----------------
//
// Subset of the worklet useful for tests: amplitude envelope state machine +
// step sequencer step advance. The full per-sample render isn't mirrored
// (would require duplicating ~500 LOC); ART scenarios drive the worklet
// indirectly via OfflineAudioContext.

export interface AdsrParams {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

/** Minimal envelope reference used in tests — single-pole approach toward
 *  the segment target. Returns an array of per-sample values for `nSamples`
 *  with the given trigger schedule (sample → on/off). */
export function renderAdsr(
  params: AdsrParams,
  triggers: { sample: number; on: boolean }[],
  nSamples: number,
  sr: number,
): Float32Array {
  let state: 'idle' | 'attack' | 'decay' | 'sustain' | 'release' = 'idle';
  let value = 0;
  const out = new Float32Array(nSamples);
  let nextTrigIdx = 0;
  for (let i = 0; i < nSamples; i++) {
    while (nextTrigIdx < triggers.length && triggers[nextTrigIdx]!.sample <= i) {
      const t = triggers[nextTrigIdx]!;
      if (t.on) {
        state = 'attack';
        value = 0;
      } else if (state !== 'idle') {
        state = 'release';
      }
      nextTrigIdx++;
    }
    if (state === 'attack') {
      const a = Math.max(1e-6, params.attack);
      value += 1 / (sr * a);
      if (value >= 0.999) { value = 1; state = 'decay'; }
    } else if (state === 'decay') {
      const d = Math.max(1e-6, params.decay);
      const target = Math.max(0, Math.min(1, params.sustain));
      const coef = Math.exp(-1 / (sr * d));
      value = target + (value - target) * coef;
      if (Math.abs(value - target) < 1e-4) { value = target; state = 'sustain'; }
    } else if (state === 'sustain') {
      value = Math.max(0, Math.min(1, params.sustain));
    } else if (state === 'release') {
      const r = Math.max(1e-6, params.release);
      const coef = Math.exp(-1 / (sr * r));
      value *= coef;
      if (value < 1e-5) { value = 0; state = 'idle'; }
    }
    out[i] = value;
  }
  return out;
}

// ---------------- Card-visible state ----------------

export interface HelmMidiState {
  connected: boolean;
  permissionDenied: boolean;
  devices: Array<{ id: string; name: string; state: string }>;
  selectedDeviceId: string | null;
  channels: number[] | null;     // 0-indexed; null = all
  /** Most recently-received note (MIDI int). null when none yet. */
  lastNote: number | null;
  /** Notes currently held — drives the activity indicator. */
  activeNotes: number[];
  /** Settings menu open (card-local UI state — kept on the engine handle so
   *  Y.Doc remote opens don't get confused). */
  settingsOpen: boolean;
  /** Sequencer on/off — gates ALL sequencer behavior (no advance, no mod
   *  contribution, no envelope retrigger) when off. Default OFF. */
  seqOn: boolean;
  /** Current step pointer (0..15) or -1 when never advanced / just reset.
   *  Drives the green dot overlay in the step grid. */
  currentStep: number;
}

export interface HelmMidiData {
  /** Persisted across reloads via node.data. */
  lastDeviceId: string | null;
  channels: number[] | null;
  /** Sequencer on/off — persisted so it survives reloads. */
  seqOn?: boolean;
}

export const DEFAULT_HELM_MIDI_DATA: HelmMidiData = {
  lastDeviceId: null,
  channels: null,
  seqOn: false,
};

export interface HelmCardApi {
  connect(): Promise<boolean>;
  selectDevice(deviceId: string | null): void;
  setChannels(channels: number[] | null): void;
  setSettingsOpen(open: boolean): void;
  /** Send a 16-step sequencer pattern to the worklet. */
  setSteps(steps: number[]): void;
  /** Toggle the sequencer on/off. */
  setSeqOn(on: boolean): void;
  /** Snap the step pointer back to -1 (next gate → step 0). */
  resetSeq(): void;
  getState(): HelmMidiState;
  subscribe(cb: (s: HelmMidiState) => void): () => void;
}

// ---------------- Module def ----------------

export const helmDef: AudioModuleDef = {
  type: 'helm',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'helm',
  category: 'sources',
  schemaVersion: 1,
  ossAttribution: { author: 'Matt Tytel' },

  // No CV→AudioParam routings in v1 (the card surface is already dense; CV
  // ports for filter cutoff / amp env attack etc. are follow-up work). We
  // expose `midi_in` and a `pitch_cv`/`gate` pair for fallback patching
  // when no MIDI device is connected — same pattern as DX7.
  //
  // `seq_reset` is a gate input: a rising edge snaps the step pointer back
  // so the next gate advances to step 0. Used together with the on/off
  // toggle to drive deterministic patterns from another sequencer / clock.
  inputs: [
    { id: 'pitch_cv', type: 'cv' },
    { id: 'gate',     type: 'gate' },
    // `midi_in` is a no-op port that exists purely so the palette/cable
    // visuals show MIDI as a first-class input. It does NOT carry audio —
    // MIDI flows through the Web MIDI API, not through a cable. Listed in
    // PASSTHROUGH_BY_DESIGN since it has no paramTarget and no cvScale.
    { id: 'midi_in',  type: 'cv' },
    { id: 'seq_reset',type: 'gate' },
  ],
  outputs: [
    { id: 'out_l', type: 'audio' },
    { id: 'out_r', type: 'audio' },
  ],

  params: [
    { id: 'voiceCount',  label: 'Voices',      defaultValue: 6,    min: 1,    max: 8,     curve: 'discrete' },
    { id: 'volume',      label: 'Vol',         defaultValue: 0.7,  min: 0,    max: 2,     curve: 'linear' },

    // OSC 1
    { id: 'osc1Wave',    label: 'O1 Wav',      defaultValue: 0,    min: 0,    max: 3,     curve: 'discrete' },
    { id: 'osc1Trans',   label: 'O1 Tr',       defaultValue: 0,    min: -24,  max: 24,    curve: 'linear', units: 'st' },
    { id: 'osc1Tune',    label: 'O1 Tu',       defaultValue: 0,    min: -100, max: 100,   curve: 'linear', units: 'c' },
    { id: 'osc1Unison',  label: 'O1 Uni',      defaultValue: 1,    min: 1,    max: 7,     curve: 'discrete' },
    { id: 'osc1Detune',  label: 'O1 Det',      defaultValue: 10,   min: 0,    max: 50,    curve: 'linear', units: 'c' },
    { id: 'osc1Vol',     label: 'O1 Vol',      defaultValue: 0.8,  min: 0,    max: 1,     curve: 'linear' },

    // OSC 2
    { id: 'osc2Wave',    label: 'O2 Wav',      defaultValue: 1,    min: 0,    max: 3,     curve: 'discrete' },
    { id: 'osc2Trans',   label: 'O2 Tr',       defaultValue: 0,    min: -24,  max: 24,    curve: 'linear', units: 'st' },
    { id: 'osc2Tune',    label: 'O2 Tu',       defaultValue: 7,    min: -100, max: 100,   curve: 'linear', units: 'c' },
    { id: 'osc2Unison',  label: 'O2 Uni',      defaultValue: 1,    min: 1,    max: 7,     curve: 'discrete' },
    { id: 'osc2Detune',  label: 'O2 Det',      defaultValue: 10,   min: 0,    max: 50,    curve: 'linear', units: 'c' },
    { id: 'osc2Vol',     label: 'O2 Vol',      defaultValue: 0.6,  min: 0,    max: 1,     curve: 'linear' },

    // Sub + Noise
    { id: 'subWave',     label: 'Sub W',       defaultValue: 3,    min: 0,    max: 3,     curve: 'discrete' },
    { id: 'subVol',      label: 'Sub V',       defaultValue: 0.4,  min: 0,    max: 1,     curve: 'linear' },
    { id: 'noiseVol',    label: 'Noise',       defaultValue: 0,    min: 0,    max: 1,     curve: 'linear' },

    // Filter
    { id: 'filterCutoff',  label: 'Cut',       defaultValue: 4000, min: 20,   max: 20000, curve: 'log', units: 'Hz' },
    { id: 'filterRes',     label: 'Res',       defaultValue: 1.0,  min: 0.5,  max: 16,    curve: 'linear' },
    { id: 'filterBlend',   label: 'Mode',      defaultValue: 0,    min: 0,    max: 2,     curve: 'linear' }, // 0=LP,1=BP,2=HP
    { id: 'filterStyle',   label: 'Pole',      defaultValue: 0,    min: 0,    max: 1,     curve: 'discrete' },
    { id: 'filterDrive',   label: 'Drv',       defaultValue: 1.0,  min: 0.5,  max: 6,     curve: 'linear' },
    { id: 'filterKeyTrack',label: 'Key',       defaultValue: 0.0,  min: -1,   max: 1,     curve: 'linear' },

    // Amp env
    { id: 'ampAttack',   label: 'A A',         defaultValue: 0.005, min: 0,   max: 8,     curve: 'linear', units: 's' },
    { id: 'ampDecay',    label: 'A D',         defaultValue: 0.2,   min: 0,   max: 8,     curve: 'linear', units: 's' },
    { id: 'ampSustain',  label: 'A S',         defaultValue: 0.6,   min: 0,   max: 1,     curve: 'linear' },
    { id: 'ampRelease',  label: 'A R',         defaultValue: 0.3,   min: 0,   max: 8,     curve: 'linear', units: 's' },

    // Filter env
    { id: 'filAttack',   label: 'F A',         defaultValue: 0.005, min: 0,   max: 8,     curve: 'linear', units: 's' },
    { id: 'filDecay',    label: 'F D',         defaultValue: 0.5,   min: 0,   max: 8,     curve: 'linear', units: 's' },
    { id: 'filSustain',  label: 'F S',         defaultValue: 0.0,   min: 0,   max: 1,     curve: 'linear' },
    { id: 'filRelease',  label: 'F R',         defaultValue: 0.3,   min: 0,   max: 8,     curve: 'linear', units: 's' },
    { id: 'filEnvDepth', label: 'F Dpth',      defaultValue: 0,     min: -1,  max: 1,     curve: 'linear' },

    // Mod env
    { id: 'modAttack',   label: 'M A',         defaultValue: 0.005, min: 0,   max: 8,     curve: 'linear', units: 's' },
    { id: 'modDecay',    label: 'M D',         defaultValue: 0.5,   min: 0,   max: 8,     curve: 'linear', units: 's' },
    { id: 'modSustain',  label: 'M S',         defaultValue: 0.0,   min: 0,   max: 1,     curve: 'linear' },
    { id: 'modRelease',  label: 'M R',         defaultValue: 0.3,   min: 0,   max: 8,     curve: 'linear', units: 's' },
    { id: 'modEnvDepth', label: 'M Dpth',      defaultValue: 0,     min: -1,  max: 1,     curve: 'linear' },

    // LFOs
    { id: 'lfo1Wave',    label: 'L1 W',        defaultValue: 3,     min: 0,   max: 3,     curve: 'discrete' },
    { id: 'lfo1Freq',    label: 'L1 Hz',       defaultValue: 1.0,   min: 0.01,max: 30,    curve: 'log', units: 'Hz' },
    { id: 'lfo1Amp',     label: 'L1 Amt',      defaultValue: 0,     min: 0,   max: 1,     curve: 'linear' },

    { id: 'lfo2Wave',    label: 'L2 W',        defaultValue: 3,     min: 0,   max: 3,     curve: 'discrete' },
    { id: 'lfo2Freq',    label: 'L2 Hz',       defaultValue: 4.0,   min: 0.01,max: 30,    curve: 'log', units: 'Hz' },
    { id: 'lfo2Amp',     label: 'L2 Amt',      defaultValue: 0,     min: 0,   max: 1,     curve: 'linear' },

    // Step sequencer
    { id: 'stepNumSteps',label: 'Steps',       defaultValue: 8,     min: 1,   max: 16,    curve: 'discrete' },
    { id: 'stepRate',    label: 'St Hz',       defaultValue: 4.0,   min: 0.1, max: 30,    curve: 'log', units: 'Hz' },
    { id: 'stepSmooth',  label: 'St Smth',     defaultValue: 0.0,   min: 0,   max: 1,     curve: 'linear' },
    { id: 'stepDepth',   label: 'St Dpth',     defaultValue: 0,     min: -1,  max: 1,     curve: 'linear' },

    // Stereo
    { id: 'spread',      label: 'Spr',         defaultValue: 0.3,   min: 0,   max: 1,     curve: 'linear' },
  ],

  docs: {
    explanation:
      "A full polyphonic subtractive (analog-style) synth voice — a port of Matt Tytel's Helm. The signal chain per voice is: two morphing oscillators (each saw/square/triangle/sine, with their own tune, transpose, unison stack and detune) plus a sub-oscillator and a noise source are mixed, run through one state-variable multimode resonant filter (low-pass / band-pass / high-pass, 12 or 24 dB/oct), and shaped by an amplitude VCA. Three dedicated ADSR envelopes drive it: the AMP envelope shapes loudness, the FILTER envelope sweeps the filter cutoff by an amount you set, and the MOD envelope is a spare modulation source. Two LFOs and a built-in 16-step sequencer add motion. Mental model: hold notes (via MIDI or a patched gate) and each note grabs one of up to 8 voices; voiceCount sets how many notes can sound at once, and voices are stolen oldest-first when you run out. v1 pre-wires the modulators to musical destinations (LFO1→cutoff, LFO2→osc2 pitch, MOD env→osc1 pitch, step sequencer→osc2 transpose) rather than exposing Helm's full mod matrix.",
    inputs: {
      pitch_cv:
        "Monophonic V/oct pitch for the fallback CV/gate path used when no MIDI device is connected: while the GATE input is high it plays a single voice at midi note 60 + (pitch_cv × 12 semitones). MIDI note input (via the gear-icon device picker) takes priority and drives true polyphony; this CV path is a single-note fallback for patching from a sequencer or keyboard CV.",
      gate:
        "Note on/off gate for the fallback CV/gate path (level-sensitive): a rising edge starts a note at the current pitch_cv and a falling edge releases it. It is ALSO the sequencer's clock — every rising edge here advances the built-in step sequencer one step (and re-attacks the envelopes), so the same gate that plays notes also walks the pattern.",
      midi_in:
        "A presentation-only port that exists so MIDI shows up as a first-class cable on the panel; it carries no audio or CV and nothing is read from it. Actual MIDI flows through the Web MIDI API (open the gear icon to pick a device and receive channels), not through this cable.",
      seq_reset:
        "Reset gate for the built-in step sequencer (trigger): a rising edge snaps the step pointer back so the next gate advance lands on step 0. Honored whether or not the sequencer is switched on, so you can sync the pattern's start to a clock or another sequencer.",
    },
    outputs: {
      out_l:
        "Left channel of the stereo mix of all sounding voices. The stereo image comes from spreading each oscillator's unison voices across the field by the SPR (spread) amount; with no unison and spread at 0 the output is effectively centered/mono.",
      out_r:
        "Right channel of the stereo mix of all sounding voices (the spread partner of out_l). Patch both out_l and out_r to keep the unison/pan stereo image.",
    },
    controls: {
      voiceCount:
        "Polyphony cap (1–8): the maximum number of notes that can sound simultaneously. When more notes are held than voices available, the synth steals a voice (a releasing voice first, otherwise the oldest-held note). Set it to 1 for a strictly monophonic patch.",
      volume: "Master output level for the whole synth (0–2, default 0.7); above 1 it boosts past unity.",

      osc1Wave:
        "Oscillator 1 waveform, morphing across 0 = saw, 1 = square, 2 = triangle, 3 = sine (the knob crossfades between adjacent shapes at in-between values).",
      osc1Trans: "Oscillator 1 coarse transpose in semitones (−24 to +24), shifting it by whole steps relative to the played note.",
      osc1Tune: "Oscillator 1 fine tune in cents (−100 to +100) for slight detuning or beating against osc 2.",
      osc1Unison: "Number of stacked unison copies of oscillator 1 (1–7); higher counts thicken the tone and, with detune, widen it.",
      osc1Detune: "How far apart the oscillator 1 unison copies are spread in cents (0–50); 0 stacks them in tune, higher values fatten and detune the stack. No effect when unison is 1.",
      osc1Vol: "Oscillator 1 level in the pre-filter mix (0–1).",

      osc2Wave: "Oscillator 2 waveform, morphing across 0 = saw, 1 = square, 2 = triangle, 3 = sine, just like osc 1 (defaults to square).",
      osc2Trans: "Oscillator 2 coarse transpose in semitones (−24 to +24) — e.g. +12 for an octave-up layer.",
      osc2Tune: "Oscillator 2 fine tune in cents (−100 to +100); defaults to +7 c so the two oscillators beat slightly out of the box.",
      osc2Unison: "Number of stacked unison copies of oscillator 2 (1–7).",
      osc2Detune: "Cents spread between oscillator 2's unison copies (0–50); no effect when unison is 1.",
      osc2Vol: "Oscillator 2 level in the pre-filter mix (0–1).",

      subWave: "Sub-oscillator waveform (0 = saw, 1 = square, 2 = triangle, 3 = sine; defaults to sine). The sub plays two octaves below the note for low-end weight.",
      subVol: "Sub-oscillator level in the mix (0–1).",
      noiseVol: "White-noise level in the mix (0–1, default 0) — adds breath/hiss or, through a resonant filter, percussive/wind textures.",

      filterCutoff: "Filter cutoff frequency (20 Hz–20 kHz, log) — the corner where the filter starts acting. The filter envelope and LFO 1 add to this around the knob value.",
      filterRes: "Filter resonance / emphasis at the cutoff (0.5–16); higher values peak harder and can self-oscillate-like ring.",
      filterBlend: "Continuously crossfades the filter response across 0 = low-pass, 1 = band-pass, 2 = high-pass, so in-between values are blends of two modes (labeled MODE on the panel).",
      filterStyle: "Filter slope / pole count: 0 = 12 dB/oct (2-pole, gentler) and 1 = 24 dB/oct (4-pole, steeper, more aggressive). Labeled POLE.",
      filterDrive: "Pre-filter drive/gain (0.5–6) pushing harder into the filter for added saturation and bite.",
      filterKeyTrack: "How much the cutoff follows the played pitch (−1 to +1): positive opens the filter as you play higher (keeping brightness consistent up the keyboard), negative inverts it, 0 is no tracking.",

      ampAttack: "Amplitude envelope attack time in seconds (0–8): how quickly each note fades in on note-on.",
      ampDecay: "Amplitude envelope decay time in seconds (0–8): how quickly the level falls from peak to the sustain level after the attack.",
      ampSustain: "Amplitude envelope sustain level (0–1): the steady loudness held while the note is on, after the decay.",
      ampRelease: "Amplitude envelope release time in seconds (0–8): how long the note takes to fade out after note-off.",

      filAttack: "Filter envelope attack time in seconds (0–8): how fast the filter-env contour rises on note-on (its effect on cutoff is scaled by F Dpth).",
      filDecay: "Filter envelope decay time in seconds (0–8): fall from the envelope's peak to its sustain.",
      filSustain: "Filter envelope sustain level (0–1) held while the note is on (default 0, so by default the filter sweep decays away).",
      filRelease: "Filter envelope release time in seconds (0–8) after note-off.",
      filEnvDepth: "How much (and which direction) the filter envelope modulates the cutoff (−1 to +1, labeled F Dpth): positive sweeps the cutoff up with the envelope, negative sweeps it down, 0 disables the filter envelope's effect.",

      modAttack: "Mod envelope attack time in seconds (0–8). The mod envelope is a spare ADSR; in v1 it is pre-wired to oscillator-1 pitch (depth set by M Dpth).",
      modDecay: "Mod envelope decay time in seconds (0–8).",
      modSustain: "Mod envelope sustain level (0–1, default 0).",
      modRelease: "Mod envelope release time in seconds (0–8) after note-off.",
      modEnvDepth: "How much the mod envelope modulates its destination — oscillator-1 pitch in v1 — over ±12 semitones (−1 to +1, labeled M Dpth); 0 disables it.",

      lfo1Wave: "LFO 1 waveform (0 = saw, 1 = square, 2 = triangle, 3 = sine, default sine).",
      lfo1Freq: "LFO 1 rate in Hz (0.01–30, log).",
      lfo1Amp: "LFO 1 depth (0–1): how much LFO 1 modulates its destination — the filter cutoff in v1 (0 = off).",
      lfo2Wave: "LFO 2 waveform (0 = saw, 1 = square, 2 = triangle, 3 = sine, default sine).",
      lfo2Freq: "LFO 2 rate in Hz (0.01–30, log, default 4 Hz).",
      lfo2Amp: "LFO 2 depth (0–1): how much LFO 2 modulates its destination — oscillator-2 pitch (±1 semitone) in v1 (0 = off).",

      stepNumSteps: "Number of active steps in the built-in step sequencer (1–16) before the pattern loops.",
      stepRate: "Step sequencer rate knob (0.1–30 Hz). Retained from v1's free-running mode; in the current gate-clocked mode the sequencer advances on GATE rising edges, so this is effectively inactive.",
      stepSmooth: "Glide/smoothing between step values (0–1): 0 jumps instantly between steps, higher values slew the modulation for portamento-like motion.",
      stepDepth: "How much the step sequencer modulates its destination — oscillator-2 transpose over ±12 semitones (−1 to +1, labeled Amt); 0 disables it.",

      spread:
        "Stereo width (0–1): how far each oscillator's unison voices are panned across the stereo field. 0 collapses toward center/mono; higher values widen the image.",

      // Static card controls. These have no param/family of their own, so each
      // is declared as a single-member control family below (kind 'other') and
      // keyed here as a `<familyId>-{n}` template (a lone button substitutes
      // nothing for {n}).
      "helm-gear-btn-{n}": "Gear icon (header) — opens the MIDI settings panel: pick the input device and which MIDI channels to receive on, and view the last note / active-voice count.",
      "helm-seq-onoff-{n}": "SEQ ON/OFF — switches the built-in step sequencer on or off. When off the pattern contributes no modulation and doesn't advance; default off.",
      "helm-seq-reset-{n}": "RST — resets the step pointer so the next gate advance starts the pattern at step 0 (same effect as a rising edge on the SEQ RESET input).",
      "helm-step-{n}":
        "Step {n} value slider — sets this step's modulation amount (−1..+1). With the sequencer on, the step values are walked one-per-gate and sent to the sequencer's destination (osc-2 transpose, scaled by St Dpth/Amt).",
    },
  },

  controlFamilies: [
    {
      id: 'helm-step',
      label: 'Step sequencer value slider',
      kind: 'step-grid',
      testidPrefix: 'helm-step',
      countParam: 'stepNumSteps',
    },
    // Single static buttons (no param/family of their own). Declared as
    // one-member families so the docs gate can key authored prose to them; the
    // testidPrefix is grep-verified against the card by the lint.
    { id: 'helm-gear-btn',  label: 'MIDI settings',     kind: 'other', testidPrefix: 'helm-gear-btn' },
    { id: 'helm-seq-onoff', label: 'Step sequencer on', kind: 'other', testidPrefix: 'helm-seq-onoff' },
    { id: 'helm-seq-reset', label: 'Step sequencer rst', kind: 'other', testidPrefix: 'helm-seq-reset' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'helm', {
      // 4 inputs: pitch_cv + gate + midi_in (no-op) + seq_reset (gate).
      numberOfInputs: 4,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    } as AudioWorkletNodeOptions);

    // ---------------- Apply initial param values ----------------
    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of helmDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    // Stereo splitter so the engine can address out_l / out_r individually.
    const splitter = ctx.createChannelSplitter(2);
    workletNode.connect(splitter);

    // ---------------- MIDI state ----------------
    const savedData = ((node.data ?? {}) as Partial<HelmMidiData>);
    let selectedDeviceId: string | null = savedData.lastDeviceId ?? null;
    let channelsSelected: number[] | null = savedData.channels ?? null;
    let activeNotes = new Set<number>();
    let lastNote: number | null = null;
    let access: MidiAccessLike | null = null;
    let permissionDenied = false;
    let settingsOpen = false;
    let subscriber: ((s: HelmMidiState) => void) | null = null;
    let channelSet: Set<number> | null = expandChannelSet(channelsSelected);
    // Sequencer state — seqOn defaults OFF (matches PR #204 perceptual default
    // since stepDepth was 0 there too).
    let seqOn = savedData.seqOn === true;
    let currentStep = -1;

    // Initial step pattern from node.data.steps if present.
    {
      const data = node.data as { steps?: number[] } | undefined;
      if (data && Array.isArray(data.steps)) {
        workletNode.port.postMessage({ type: 'set-steps', steps: data.steps.slice(0, 16) });
      }
    }
    // Push initial seqOn to the worklet (set-seq-on is idempotent; explicit
    // post here ensures the worklet stays in sync with persisted state).
    workletNode.port.postMessage({ type: 'set-seq-on', on: seqOn });

    // Listen for step-tick messages from the worklet.
    workletNode.port.onmessage = (e: MessageEvent<{ type: string; step?: number }>) => {
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'step-tick' && typeof m.step === 'number') {
        currentStep = m.step;
        notify();
      }
    };

    function snapshot(): HelmMidiState {
      const devices: HelmMidiState['devices'] = [];
      if (access) {
        for (const [id, inp] of access.inputs) {
          devices.push({ id, name: inp.name ?? id, state: inp.state });
        }
      }
      return {
        connected: access !== null,
        permissionDenied,
        devices,
        selectedDeviceId,
        channels: channelsSelected,
        lastNote,
        activeNotes: Array.from(activeNotes).sort((a, b) => a - b),
        settingsOpen,
        seqOn,
        currentStep,
      };
    }
    function notify(): void { subscriber?.(snapshot()); }

    function handleMidiMessage(ev: MidiEventLike): void {
      const data = ev.data;
      if (data.length < 1) return;
      const status = data[0]!;
      if ((status & 0x80) && (status & 0xf0) <= 0xe0) {
        if (!midiChannelMatches(status, channelSet)) return;
      }
      const ne = parseHelmMidiEvent(data);
      if (!ne) return;
      if (ne.kind === 'note-on') {
        activeNotes.add(ne.note);
        lastNote = ne.note;
        workletNode.port.postMessage({
          type: 'note-on',
          note: ne.note,
          velocity: ne.velocity,
          channel: ne.channel,
        });
        notify();
      } else if (ne.kind === 'note-off') {
        activeNotes.delete(ne.note);
        workletNode.port.postMessage({ type: 'note-off', note: ne.note, channel: ne.channel });
        notify();
      } else if (ne.kind === 'all-off') {
        activeNotes.clear();
        workletNode.port.postMessage({ type: 'all-off' });
        notify();
      }
    }

    function attachToDevice(deviceId: string | null): void {
      if (!access) return;
      for (const inp of access.inputs.values()) {
        inp.onmidimessage = null;
      }
      if (deviceId === null) return;
      const inp = access.inputs.get(deviceId);
      if (!inp) return;
      inp.onmidimessage = handleMidiMessage;
    }

    function pickDefaultDevice(): string | null {
      if (!access) return null;
      if (selectedDeviceId && access.inputs.has(selectedDeviceId)) return selectedDeviceId;
      const first = access.inputs.values().next();
      if (first.done) return null;
      return first.value.id;
    }

    async function connect(): Promise<boolean> {
      if (access) return true;
      if (!webMidiAvailable()) {
        permissionDenied = true;
        notify();
        return false;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a = await (navigator as any).requestMIDIAccess({ sysex: false });
        access = a as MidiAccessLike;
        access.onstatechange = () => {
          if (!selectedDeviceId) {
            selectedDeviceId = pickDefaultDevice();
            attachToDevice(selectedDeviceId);
          }
          notify();
        };
        selectedDeviceId = pickDefaultDevice();
        attachToDevice(selectedDeviceId);
        notify();
        return true;
      } catch {
        permissionDenied = true;
        notify();
        return false;
      }
    }

    function selectDevice(deviceId: string | null): void {
      selectedDeviceId = deviceId;
      attachToDevice(deviceId);
      notify();
    }

    function setChannels(channels: number[] | null): void {
      channelsSelected = channels;
      channelSet = expandChannelSet(channels);
      // Drop active notes — preserves the "stuck note" guarantee.
      if (activeNotes.size > 0) {
        workletNode.port.postMessage({ type: 'all-off' });
        activeNotes.clear();
      }
      notify();
    }

    function setSettingsOpen(open: boolean): void {
      settingsOpen = open;
      notify();
    }

    function setSteps(steps: number[]): void {
      workletNode.port.postMessage({ type: 'set-steps', steps: steps.slice(0, 16) });
    }

    function setSeqOn(on: boolean): void {
      seqOn = !!on;
      workletNode.port.postMessage({ type: 'set-seq-on', on: seqOn });
      notify();
    }

    function resetSeq(): void {
      currentStep = -1;
      workletNode.port.postMessage({ type: 'seq-reset' });
      notify();
    }

    const cardApi: HelmCardApi = {
      connect,
      selectDevice,
      setChannels,
      setSettingsOpen,
      setSteps,
      setSeqOn,
      resetSeq,
      getState: snapshot,
      subscribe(cb) {
        subscriber = cb;
        cb(snapshot());
        return () => { if (subscriber === cb) subscriber = null; };
      },
    };

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['pitch_cv',  { node: workletNode, input: 0 }],
        ['gate',      { node: workletNode, input: 1 }],
        ['midi_in',   { node: workletNode, input: 2 }],
        ['seq_reset', { node: workletNode, input: 3 }],
      ]),
      outputs: new Map<string, { node: AudioNode; output: number }>([
        ['out_l', { node: splitter, output: 0 }],
        ['out_r', { node: splitter, output: 1 }],
      ]),
      setParam(paramId, value) {
        const p = params.get(paramId);
        if (!p) return;
        p.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      read(key) {
        if (key === 'card-api') return cardApi;
        if (key === 'state') return snapshot();
        return undefined;
      },
      dispose() {
        if (access) {
          for (const inp of access.inputs.values()) inp.onmidimessage = null;
          access.onstatechange = null;
          access = null;
        }
        subscriber = null;
        try { workletNode.port.onmessage = null; } catch { /* */ }
        try { workletNode.port.close(); } catch { /* */ }
        try { splitter.disconnect(); } catch { /* */ }
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};
