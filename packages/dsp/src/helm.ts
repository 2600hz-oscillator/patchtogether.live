// packages/dsp/src/helm.ts
//
// HELM — pure-TypeScript polyphonic subtractive synth.
//
// Algorithm port of Helm's helm_engine.cpp / helm_voice_handler.cpp /
// helm_oscillators.cpp / helm_lfo.cpp / state_variable_filter.cpp /
// envelope.cpp / step_generator.cpp by Matt Tytel (GPL-3.0).
//
// Original: https://tytel.org/helm — Copyright 2013-2017 Matt Tytel.
// This port: licensed under AGPL-3.0-or-later as part of patchtogether.live.
//
// v1 scope (matches the issue body):
//   - 4-8 voices (params.voiceCount).
//   - 2 main oscillators with morphing wave shapes (saw/square/triangle/sine)
//     + per-osc tune (cents) + transpose (semis) + unison voices (1..7) +
//     unison detune (cents).
//   - 1 sub-oscillator (-2 octaves; sine/square/triangle selectable).
//   - Noise oscillator.
//   - State-variable filter, 12dB or 24dB pole select, LP/BP/HP blend.
//   - 3 ADSR envelopes: amplitude / filter / mod (mod available but v1
//     does not expose a routing matrix — mod env is wired to oscillator-1
//     pitch as a starter modulation source; LFOs 1 & 2 are wired to filter
//     cutoff so a player has audible motion out of the box).
//   - 2 mono LFOs (HELM's poly LFO is deferred).
//   - Step sequencer (1..16 steps with smoothing + rate-divided clock,
//     wired to oscillator-2 tune).
//   - Polyphonic note input via message port (note-on / note-off messages
//     come from the main-thread MIDI handler in helm.ts).
//   - Stereo output (osc → filter → amp env → stereo pan-spread).
//
// Note on the wiring of LFO/MOD-ENV/STEPSEQ:
//   Helm exposes a freeform modulation matrix in its UI (drag from any
//   mod source onto any param). Building that matrix UI is a bigger lift
//   than v1 ships. The patch I've wired up here gives users *audible*
//   motion from every modulator without the matrix:
//     LFO1 → filter cutoff   (depth = lfo1Amp knob)
//     LFO2 → osc2 pitch      (depth = lfo2Amp knob × ±1 semitone)
//     ENV(mod) → osc1 pitch  (depth = modEnvDepth knob × ±12 semis)
//     STEPSEQ → osc2 transpose (depth = stepDepth knob × ±12 semis)
//   Follow-up PR is tracked to add the full matrix.
//
// MIDI input is *not* read by the worklet directly — the host (helm.ts)
// listens to Web MIDI events on the main thread and forwards
// note-on / note-off via this.port.postMessage. This matches the project's
// midi-cv-buddy.ts pattern. The worklet's only inputs are optional CV pitch
// and gate fallbacks so the module can be driven by other patch sources
// (e.g. a SCORE) when no MIDI device is connected.

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}
declare function registerProcessor(
  name: string,
  ctor: typeof AudioWorkletProcessor
): void;

const TWO_PI = Math.PI * 2;
const MAX_VOICES = 8;
const MAX_UNISON = 7;
const C4_HZ = 261.625565;
const NUM_STEPS = 16;

// ----------------------------------------------------------------------------
// Waveforms (algorithm port of mopo/src/wave.h Wave::wave — minus the
// bandlimited lookup since we run at audio rate with PolyBLEP only where it
// matters; oscillators use a phase-fraction approach close enough musically).
// ----------------------------------------------------------------------------

/** Waveform indices matching the Helm panel order (saw/square/triangle/sine). */
export const WAVE_SAW = 0;
export const WAVE_SQUARE = 1;
export const WAVE_TRIANGLE = 2;
export const WAVE_SINE = 3;
export const NUM_WAVES = 4;

function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** Render one sample of a morph oscillator at phase `t` (0..1) with phase
 *  increment dt. waveIdx = continuous 0..3 morphs across the four shapes via
 *  fractional crossfade. */
export function morphWave(waveIdx: number, t: number, dt: number): number {
  const idx = Math.max(0, Math.min(NUM_WAVES - 1, waveIdx));
  const lo = Math.floor(idx);
  const hi = Math.min(NUM_WAVES - 1, lo + 1);
  const blend = idx - lo;
  return basicWave(lo, t, dt) * (1 - blend) + basicWave(hi, t, dt) * blend;
}

function basicWave(idx: number, t: number, dt: number): number {
  switch (idx) {
    case WAVE_SAW: {
      const naive = 2 * t - 1;
      return naive - polyBlep(t, dt);
    }
    case WAVE_SQUARE: {
      let s = t < 0.5 ? 1 : -1;
      s += polyBlep(t, dt);
      const t2 = t + 0.5 - Math.floor(t + 0.5);
      s -= polyBlep(t2, dt);
      return s;
    }
    case WAVE_TRIANGLE:
      return 1 - 4 * Math.abs(t - 0.5);
    case WAVE_SINE:
      return Math.sin(TWO_PI * t);
    default:
      return 0;
  }
}

/** LFO waveforms — same shapes but cycle-band-limit isn't required at LFO
 *  rates. */
export function lfoWave(waveIdx: number, t: number): number {
  const idx = Math.max(0, Math.min(NUM_WAVES - 1, Math.round(waveIdx)));
  switch (idx) {
    case WAVE_SAW:
      return 2 * t - 1;
    case WAVE_SQUARE:
      return t < 0.5 ? 1 : -1;
    case WAVE_TRIANGLE:
      return 1 - 4 * Math.abs(t - 0.5);
    case WAVE_SINE:
    default:
      return Math.sin(TWO_PI * t);
  }
}

// ----------------------------------------------------------------------------
// State-variable filter (algorithm port of mopo/src/state_variable_filter.cpp
// — Andy Simper TPT topology, "Cytomic" formulation).
// ----------------------------------------------------------------------------

/** filterStyle indices: 0=12dB, 1=24dB. */
export const FILTER_12DB = 0;
export const FILTER_24DB = 1;

class SvfState {
  ic1eqA = 0;
  ic2eqA = 0;
  ic1eqB = 0;
  ic2eqB = 0;
  reset(): void {
    this.ic1eqA = 0;
    this.ic2eqA = 0;
    this.ic1eqB = 0;
    this.ic2eqB = 0;
  }
}

interface SvfCoeffs {
  a1: number;
  a2: number;
  a3: number;
  m0: number;
  m1: number;
  m2: number;
}

function computePassCoeffs(blend: number, cutoffHz: number, resonance: number, db24: boolean, sr: number): SvfCoeffs {
  const cutoff = Math.max(1, Math.min(sr * 0.49, cutoffHz));
  let q = Math.max(0.5, Math.min(16, resonance));
  if (db24) q = Math.sqrt(q);
  const g = Math.tan(Math.PI * Math.min(cutoff / sr, 0.49));
  const k = 1 / q;
  // blend: 0..2 — 0=LP, 1=BP, 2=HP, with smooth cross-blends in between
  // matches Helm's filter_blend semantics.
  const lpAmt = Math.sqrt(Math.max(0, Math.min(1, 1 - blend)));
  const bpAmt = Math.sqrt(Math.max(0, Math.min(1, 1 - Math.abs(blend - 1))));
  const hpAmt = Math.sqrt(Math.max(0, Math.min(1, blend - 1)));
  const m0 = hpAmt;
  const m1 = bpAmt - k * hpAmt;
  const m2 = lpAmt - hpAmt;
  const a1 = 1 / (1 + g * (g + k));
  const a2 = g * a1;
  const a3 = g * a2;
  return { a1, a2, a3, m0, m1, m2 };
}

function svfTick12(s: SvfState, c: SvfCoeffs, audio: number): number {
  const v3 = audio - s.ic2eqA;
  const v1 = c.a1 * s.ic1eqA + c.a2 * v3;
  const v2 = s.ic2eqA + c.a2 * s.ic1eqA + c.a3 * v3;
  s.ic1eqA = 2 * v1 - s.ic1eqA;
  s.ic2eqA = 2 * v2 - s.ic2eqA;
  return c.m0 * audio + c.m1 * v1 + c.m2 * v2;
}

function svfTick24(s: SvfState, c: SvfCoeffs, audio: number): number {
  // Two cascaded 12dB stages — second stage soft-clip between, matching
  // Helm's process24db.
  const v3a = audio - s.ic2eqA;
  const v1a = c.a1 * s.ic1eqA + c.a2 * v3a;
  const v2a = s.ic2eqA + c.a2 * s.ic1eqA + c.a3 * v3a;
  s.ic1eqA = 2 * v1a - s.ic1eqA;
  s.ic2eqA = 2 * v2a - s.ic2eqA;
  const outA = c.m0 * audio + c.m1 * v1a + c.m2 * v2a;
  const distort = Math.tanh(outA);
  const v3b = distort - s.ic2eqB;
  const v1b = c.a1 * s.ic1eqB + c.a2 * v3b;
  const v2b = s.ic2eqB + c.a2 * s.ic1eqB + c.a3 * v3b;
  s.ic1eqB = 2 * v1b - s.ic1eqB;
  s.ic2eqB = 2 * v2b - s.ic2eqB;
  return c.m0 * distort + c.m1 * v1b + c.m2 * v2b;
}

// ----------------------------------------------------------------------------
// Envelope (algorithm port of mopo/src/envelope.cpp — exponential decay /
// release, linear attack ramp matching the original ATTACK_DONE=0.999
// crossover).
// ----------------------------------------------------------------------------

enum EnvState {
  Idle = 0,
  Attack = 1,
  Decay = 2,
  Sustain = 3,
  Release = 4,
}

class Envelope {
  state: EnvState = EnvState.Idle;
  value = 0;
  /** Gate trigger: rising edge → Attack; falling edge → Release. */
  trigger(on: boolean): void {
    if (on) {
      this.state = EnvState.Attack;
      this.value = 0;
    } else if (this.state !== EnvState.Idle) {
      this.state = EnvState.Release;
    }
  }
  /** Advance one sample. attack/decay/release are in SECONDS, sustain 0..1.*/
  tick(attack: number, decay: number, sustain: number, release: number, sr: number): number {
    if (this.state === EnvState.Attack) {
      const a = Math.max(1e-6, attack);
      const inc = 1 / (sr * a);
      this.value += inc;
      if (this.value >= 0.999) {
        this.value = 1.0;
        this.state = EnvState.Decay;
      }
    } else if (this.state === EnvState.Decay) {
      const d = Math.max(1e-6, decay);
      const susTarget = Math.max(0, Math.min(1, sustain));
      // Single-pole exp approach toward sustain. Time-constant d so 99% in
      // approximately 5d.
      const coef = Math.exp(-1 / (sr * d));
      this.value = susTarget + (this.value - susTarget) * coef;
      if (Math.abs(this.value - susTarget) < 1e-4) {
        this.value = susTarget;
        this.state = EnvState.Sustain;
      }
    } else if (this.state === EnvState.Sustain) {
      this.value = Math.max(0, Math.min(1, sustain));
    } else if (this.state === EnvState.Release) {
      const r = Math.max(1e-6, release);
      const coef = Math.exp(-1 / (sr * r));
      this.value *= coef;
      if (this.value < 1e-5) {
        this.value = 0;
        this.state = EnvState.Idle;
      }
    }
    return this.value;
  }
}

// ----------------------------------------------------------------------------
// Voice — encapsulates everything that's per-note: phases, envelopes, filter
// state.
// ----------------------------------------------------------------------------

class Voice {
  active = false;
  midi = 60;
  /** Note-on timestamp (sample frame) for the steal-oldest allocator. */
  startSample = -1;
  /** Per-oscillator phase accumulators. Sized to MAX_UNISON. */
  osc1Phases = new Float64Array(MAX_UNISON);
  osc2Phases = new Float64Array(MAX_UNISON);
  subPhase = 0;
  /** Filter state. */
  svfL = new SvfState();
  svfR = new SvfState();
  ampEnv = new Envelope();
  filEnv = new Envelope();
  modEnv = new Envelope();
  /** Velocity (0..1) for amp scaling. */
  velocity = 1;
  /** Note channel (1..16) — kept for future per-channel routing. */
  channel = 0;
  reset(): void {
    for (let i = 0; i < MAX_UNISON; i++) {
      this.osc1Phases[i] = i / MAX_UNISON;
      this.osc2Phases[i] = (i + 0.5) / MAX_UNISON;
    }
    this.subPhase = 0;
    this.svfL.reset();
    this.svfR.reset();
    this.ampEnv.state = EnvState.Idle;
    this.ampEnv.value = 0;
    this.filEnv.state = EnvState.Idle;
    this.filEnv.value = 0;
    this.modEnv.state = EnvState.Idle;
    this.modEnv.value = 0;
  }
}

// ----------------------------------------------------------------------------
// Step sequencer — gate-clocked note sequencer.
//
// v2 (post-PR-#204) sequencer semantics:
//   - Default OFF. When OFF, the sequencer does nothing — no advance, no
//     modulation contribution, no envelope retrigger.
//   - When ON, the sequencer advances exactly one step per rising edge on
//     the gate input (combined: fallback CV gate + MIDI-derived gate).
//   - On each advance, all three envelopes (amp/filter/mod) on the most
//     recent note are retriggered, and the step value is latched into the
//     osc2 transpose modulation amount.
//   - The internal `stepRate` clock is **disabled** when ON (knob is left in
//     the UI for a future free-run mode).
//   - `seq_reset` (rising edge on the dedicated input port) sets the step
//     pointer back to -1 so the next gate advance lands on step 0. The UI
//     reset button posts a {type:'seq-reset'} message with the same effect.
//
// `currentStep === -1` is the post-reset / never-advanced state — UI hides
// the green dot when currentStep < 0.
// ----------------------------------------------------------------------------

class StepSequencer {
  /** -1 = post-reset / never advanced (no dot drawn yet). */
  currentStep = -1;
  smoothedValue = 0;
  /** Latched step value after the most recent advance. 0 in the never-
   *  advanced state so the contribution is zero. */
  latchedValue = 0;
  /** Move forward one step (or wrap). Latches steps[currentStep] into
   *  latchedValue. Returns the new currentStep (>=0). */
  advance(numSteps: number, steps: Float32Array): number {
    const n = Math.max(1, Math.min(NUM_STEPS, Math.round(numSteps)));
    this.currentStep = (this.currentStep + 1) % n;
    if (this.currentStep < 0) this.currentStep = 0;
    this.latchedValue = steps[this.currentStep] ?? 0;
    return this.currentStep;
  }
  /** Reset the step pointer so the next advance lands on step 0. */
  reset(): void {
    this.currentStep = -1;
    this.latchedValue = 0;
  }
  /** Exponentially smooth the latched value toward its target. Smoothing
   *  is unchanged from the free-run version so the `stepSmooth` knob keeps
   *  its existing musical meaning. */
  smooth(smoothing: number, sr: number): number {
    const target = this.latchedValue;
    const tau = Math.max(0.001, smoothing * 0.5);
    const coef = Math.exp(-1 / (sr * tau));
    this.smoothedValue = target + (this.smoothedValue - target) * coef;
    return this.smoothedValue;
  }
}

// ----------------------------------------------------------------------------
// LFO (algorithm port of helm_lfo.cpp — without the temposync switch; v1
// runs free-Hz only).
// ----------------------------------------------------------------------------

class Lfo {
  phase = 0;
  tick(waveIdx: number, freqHz: number, sr: number): number {
    this.phase += freqHz / sr;
    if (this.phase >= 1) this.phase -= 1;
    return lfoWave(waveIdx, this.phase);
  }
}

// ----------------------------------------------------------------------------
// Message protocol — host → worklet.
// ----------------------------------------------------------------------------

interface NoteOnMsg {
  type: 'note-on';
  note: number;        // MIDI 0..127
  velocity: number;    // 0..127
  channel?: number;    // 1..16, optional
}
interface NoteOffMsg {
  type: 'note-off';
  note: number;
  channel?: number;
}
interface AllOffMsg {
  type: 'all-off';
}
interface SetStepsMsg {
  type: 'set-steps';
  steps: number[]; // length up to NUM_STEPS
}
interface SetSeqOnMsg {
  type: 'set-seq-on';
  on: boolean;
}
interface SeqResetMsg {
  type: 'seq-reset';
}
type HostMsg = NoteOnMsg | NoteOffMsg | AllOffMsg | SetStepsMsg | SetSeqOnMsg | SeqResetMsg;

// ----------------------------------------------------------------------------
// Processor.
// ----------------------------------------------------------------------------

class HelmProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Polyphony.
      { name: 'voiceCount',  defaultValue: 6,    minValue: 1,    maxValue: MAX_VOICES, automationRate: 'k-rate' as const },
      // Master.
      { name: 'volume',      defaultValue: 0.7,  minValue: 0,    maxValue: 2 },
      // Osc 1.
      { name: 'osc1Wave',    defaultValue: 0,    minValue: 0,    maxValue: NUM_WAVES - 1 },
      { name: 'osc1Trans',   defaultValue: 0,    minValue: -24,  maxValue: 24 },
      { name: 'osc1Tune',    defaultValue: 0,    minValue: -100, maxValue: 100 },  // cents
      { name: 'osc1Unison',  defaultValue: 1,    minValue: 1,    maxValue: MAX_UNISON },
      { name: 'osc1Detune',  defaultValue: 10,   minValue: 0,    maxValue: 50 },   // cents spread
      { name: 'osc1Vol',     defaultValue: 0.8,  minValue: 0,    maxValue: 1 },
      // Osc 2.
      { name: 'osc2Wave',    defaultValue: 1,    minValue: 0,    maxValue: NUM_WAVES - 1 },
      { name: 'osc2Trans',   defaultValue: 0,    minValue: -24,  maxValue: 24 },
      { name: 'osc2Tune',    defaultValue: 7,    minValue: -100, maxValue: 100 },  // detuned default
      { name: 'osc2Unison',  defaultValue: 1,    minValue: 1,    maxValue: MAX_UNISON },
      { name: 'osc2Detune',  defaultValue: 10,   minValue: 0,    maxValue: 50 },
      { name: 'osc2Vol',     defaultValue: 0.6,  minValue: 0,    maxValue: 1 },
      // Sub.
      { name: 'subWave',     defaultValue: 3,    minValue: 0,    maxValue: NUM_WAVES - 1 },
      { name: 'subVol',      defaultValue: 0.4,  minValue: 0,    maxValue: 1 },
      // Noise.
      { name: 'noiseVol',    defaultValue: 0.0,  minValue: 0,    maxValue: 1 },
      // Filter.
      { name: 'filterCutoff',  defaultValue: 4000, minValue: 20,    maxValue: 20000 },
      { name: 'filterRes',     defaultValue: 1.0,  minValue: 0.5,   maxValue: 16 },
      { name: 'filterBlend',   defaultValue: 0,    minValue: 0,     maxValue: 2 },     // 0=LP,1=BP,2=HP
      { name: 'filterStyle',   defaultValue: 0,    minValue: 0,     maxValue: 1 },     // 0=12dB,1=24dB
      { name: 'filterDrive',   defaultValue: 1.0,  minValue: 0.5,   maxValue: 6 },
      { name: 'filterKeyTrack',defaultValue: 0.0,  minValue: -1.0,  maxValue: 1.0 },
      // Amp env.
      { name: 'ampAttack',   defaultValue: 0.005, minValue: 0.0,  maxValue: 8 },
      { name: 'ampDecay',    defaultValue: 0.2,   minValue: 0.0,  maxValue: 8 },
      { name: 'ampSustain',  defaultValue: 0.6,   minValue: 0.0,  maxValue: 1 },
      { name: 'ampRelease',  defaultValue: 0.3,   minValue: 0.0,  maxValue: 8 },
      // Filter env.
      { name: 'filAttack',   defaultValue: 0.005, minValue: 0.0,  maxValue: 8 },
      { name: 'filDecay',    defaultValue: 0.5,   minValue: 0.0,  maxValue: 8 },
      { name: 'filSustain',  defaultValue: 0.0,   minValue: 0.0,  maxValue: 1 },
      { name: 'filRelease',  defaultValue: 0.3,   minValue: 0.0,  maxValue: 8 },
      { name: 'filEnvDepth', defaultValue: 0,     minValue: -1.0, maxValue: 1.0 },     // ±10 octaves at the cutoff
      // Mod env.
      { name: 'modAttack',   defaultValue: 0.005, minValue: 0.0,  maxValue: 8 },
      { name: 'modDecay',    defaultValue: 0.5,   minValue: 0.0,  maxValue: 8 },
      { name: 'modSustain',  defaultValue: 0.0,   minValue: 0.0,  maxValue: 1 },
      { name: 'modRelease',  defaultValue: 0.3,   minValue: 0.0,  maxValue: 8 },
      { name: 'modEnvDepth', defaultValue: 0,     minValue: -1.0, maxValue: 1.0 },     // → osc1 pitch ±12 semis
      // LFO 1 → filter cutoff.
      { name: 'lfo1Wave',    defaultValue: 3,     minValue: 0,    maxValue: NUM_WAVES - 1 },
      { name: 'lfo1Freq',    defaultValue: 1.0,   minValue: 0.01, maxValue: 30 },     // Hz
      { name: 'lfo1Amp',     defaultValue: 0,     minValue: 0,    maxValue: 1 },
      // LFO 2 → osc2 pitch.
      { name: 'lfo2Wave',    defaultValue: 3,     minValue: 0,    maxValue: NUM_WAVES - 1 },
      { name: 'lfo2Freq',    defaultValue: 4.0,   minValue: 0.01, maxValue: 30 },
      { name: 'lfo2Amp',     defaultValue: 0,     minValue: 0,    maxValue: 1 },
      // Step sequencer → osc2 transpose (gate-clocked; see StepSequencer comment).
      { name: 'stepNumSteps',defaultValue: 8,     minValue: 1,    maxValue: NUM_STEPS },
      { name: 'stepRate',    defaultValue: 4.0,   minValue: 0.1,  maxValue: 30 },     // Hz — reserved for future free-run mode
      { name: 'stepSmooth',  defaultValue: 0.0,   minValue: 0.0,  maxValue: 1.0 },
      { name: 'stepDepth',   defaultValue: 0,     minValue: -1.0, maxValue: 1.0 },    // → osc2 ±12 semis
      // Stereo spread (unison voices panned out).
      { name: 'spread',      defaultValue: 0.3,   minValue: 0,    maxValue: 1 },
    ];
  }

  private voices: Voice[] = Array.from({ length: MAX_VOICES }, () => new Voice());
  private currentSample = 0;
  private isr = 1 / sampleRate;
  private lfo1 = new Lfo();
  private lfo2 = new Lfo();
  private seq = new StepSequencer();
  private stepValues = new Float32Array(NUM_STEPS);
  /** Sequencer on/off — default OFF so existing patches don't change
   *  behavior when this rolls out (PR #204 shipped an internally-clocked
   *  sequencer with stepDepth=0 default, which sounded like nothing; this
   *  default preserves that "silent" baseline). */
  private seqOn = false;
  /** Edge-detection state for the combined gate (CV fallback + MIDI).
   *  Held across blocks so we don't double-trigger when a gate straddles
   *  the block boundary. */
  private gatePrev = false;
  /** Edge-detection state for the dedicated seq_reset port. */
  private resetPrev = false;
  /** Last currentStep posted to the host (so we only emit step-tick on
   *  change, not every block). */
  private lastPostedStep = -2;
  private fallbackGateHigh = false;
  private fallbackPitchVOct = 0;
  /** rng for noise. */
  private noiseSeed = 0x13579bdf | 0;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    // Default step pattern: a gentle climbing chromatic so the user hears
    // something when they turn stepDepth up.
    for (let i = 0; i < NUM_STEPS; i++) {
      this.stepValues[i] = (i / (NUM_STEPS - 1)) * 2 - 1;
    }
    for (const v of this.voices) v.reset();
    this.port.onmessage = (e: MessageEvent<HostMsg>) => {
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'note-on') this.handleNoteOn(m.note, m.velocity, m.channel ?? 0);
      else if (m.type === 'note-off') this.handleNoteOff(m.note);
      else if (m.type === 'all-off') this.allOff();
      else if (m.type === 'set-steps') this.setSteps(m.steps);
      else if (m.type === 'set-seq-on') this.setSeqOn(m.on);
      else if (m.type === 'seq-reset') this.resetSeq();
    };
  }

  // ---------------- Sequencer host-message handlers ----------------

  private setSeqOn(on: boolean): void {
    this.seqOn = !!on;
    // When turning OFF, also reset latched value so the osc2 modulation
    // contribution snaps back to 0 instead of bleeding the last latched
    // value through the smoother indefinitely. When turning ON, the next
    // gate will populate latchedValue from step 0.
    if (!this.seqOn) {
      this.seq.latchedValue = 0;
    }
    this.postStepTick(true);
  }

  private resetSeq(): void {
    this.seq.reset();
    this.postStepTick(true);
  }

  /** Trigger all three envelopes on the most recently noted-on voice.
   *  Used by the sequencer's gate-clocked path so each step advance
   *  re-attacks the current voice's envelopes. If no voice is active
   *  (no note held), this is a no-op — the sequencer needs a held note
   *  to be audible, mirroring how a tracker/seq-driven mono synth feels. */
  private retriggerActiveEnvelopes(): void {
    let mostRecent: Voice | null = null;
    for (const v of this.voices) {
      if (!v.active) continue;
      if (!mostRecent || v.startSample > mostRecent.startSample) mostRecent = v;
    }
    if (!mostRecent) return;
    mostRecent.ampEnv.trigger(true);
    mostRecent.filEnv.trigger(true);
    mostRecent.modEnv.trigger(true);
  }

  private postStepTick(force: boolean): void {
    if (!force && this.lastPostedStep === this.seq.currentStep) return;
    this.lastPostedStep = this.seq.currentStep;
    try {
      this.port.postMessage({ type: 'step-tick', step: this.seq.currentStep });
    } catch {
      // Port may have closed during dispose — swallow.
    }
  }

  // ---------------- Voice allocator ----------------

  private allocateVoice(maxVoices: number): Voice {
    // 1. Free slot.
    for (let i = 0; i < maxVoices; i++) {
      const v = this.voices[i]!;
      if (!v.active) return v;
    }
    // 2. Steal a voice already releasing.
    let oldestReleasing: Voice | null = null;
    for (let i = 0; i < maxVoices; i++) {
      const v = this.voices[i]!;
      if (v.ampEnv.state === EnvState.Release) {
        if (!oldestReleasing || v.startSample < oldestReleasing.startSample) {
          oldestReleasing = v;
        }
      }
    }
    if (oldestReleasing) return oldestReleasing;
    // 3. Steal the oldest active voice.
    let oldest = this.voices[0]!;
    for (let i = 1; i < maxVoices; i++) {
      const v = this.voices[i]!;
      if (v.startSample < oldest.startSample) oldest = v;
    }
    return oldest;
  }

  private handleNoteOn(midi: number, velocity: number, channel: number): void {
    const m = Math.max(0, Math.min(127, midi | 0));
    const vel = Math.max(0, Math.min(127, velocity)) / 127;
    if (vel === 0) {
      // MIDI runs-status convention: velocity 0 note-on = note-off.
      this.handleNoteOff(m);
      return;
    }
    const v = this.allocateVoice(MAX_VOICES);
    v.active = true;
    v.midi = m;
    v.velocity = vel;
    v.channel = channel;
    v.startSample = this.currentSample;
    v.reset();
    v.ampEnv.trigger(true);
    v.filEnv.trigger(true);
    v.modEnv.trigger(true);
  }

  private handleNoteOff(midi: number): void {
    const m = Math.max(0, Math.min(127, midi | 0));
    for (const v of this.voices) {
      if (v.active && v.midi === m && v.ampEnv.state !== EnvState.Release && v.ampEnv.state !== EnvState.Idle) {
        v.ampEnv.trigger(false);
        v.filEnv.trigger(false);
        v.modEnv.trigger(false);
        return;
      }
    }
  }

  private allOff(): void {
    for (const v of this.voices) {
      v.ampEnv.trigger(false);
      v.filEnv.trigger(false);
      v.modEnv.trigger(false);
    }
  }

  private setSteps(steps: number[]): void {
    const n = Math.min(NUM_STEPS, steps.length);
    for (let i = 0; i < n; i++) {
      const s = steps[i];
      this.stepValues[i] = typeof s === 'number' ? Math.max(-1, Math.min(1, s)) : 0;
    }
  }

  private noise(): number {
    this.noiseSeed = (this.noiseSeed * 16807) | 0;
    return (this.noiseSeed & 0x7fffffff) / 0x7fffffff * 2 - 1;
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const outL = outputs[0]?.[0];
    const outR = outputs[0]?.[1] ?? outL;
    if (!outL) return true;

    // Optional fallback inputs (pitch CV + gate + midi marker + seq_reset).
    const pitchIn = inputs[0]?.[0];
    const gateIn = inputs[1]?.[0];
    // inputs[2] is midi_in (no-op marker port — see helm.ts module def).
    const seqResetIn = inputs[3]?.[0];

    const blockLen = outL.length;
    const sr = sampleRate;

    // K-rate (use first sample).
    const voiceCount = Math.max(1, Math.min(MAX_VOICES, parameters.voiceCount[0]! | 0));
    const volume = parameters.volume[0]!;
    const osc1Wave = parameters.osc1Wave[0]!;
    const osc1Trans = parameters.osc1Trans[0]!;
    const osc1Tune = parameters.osc1Tune[0]!;
    const osc1Unison = Math.max(1, Math.min(MAX_UNISON, parameters.osc1Unison[0]! | 0));
    const osc1Detune = parameters.osc1Detune[0]!;
    const osc1Vol = parameters.osc1Vol[0]!;
    const osc2Wave = parameters.osc2Wave[0]!;
    const osc2Trans = parameters.osc2Trans[0]!;
    const osc2Tune = parameters.osc2Tune[0]!;
    const osc2Unison = Math.max(1, Math.min(MAX_UNISON, parameters.osc2Unison[0]! | 0));
    const osc2Detune = parameters.osc2Detune[0]!;
    const osc2Vol = parameters.osc2Vol[0]!;
    const subWave = parameters.subWave[0]!;
    const subVol = parameters.subVol[0]!;
    const noiseVol = parameters.noiseVol[0]!;
    const filterCutoff = parameters.filterCutoff[0]!;
    const filterRes = parameters.filterRes[0]!;
    const filterBlend = parameters.filterBlend[0]!;
    const filterStyle = Math.round(parameters.filterStyle[0]!) === FILTER_24DB ? FILTER_24DB : FILTER_12DB;
    const filterDrive = parameters.filterDrive[0]!;
    const filterKeyTrack = parameters.filterKeyTrack[0]!;
    const ampAttack = parameters.ampAttack[0]!;
    const ampDecay = parameters.ampDecay[0]!;
    const ampSustain = parameters.ampSustain[0]!;
    const ampRelease = parameters.ampRelease[0]!;
    const filAttack = parameters.filAttack[0]!;
    const filDecay = parameters.filDecay[0]!;
    const filSustain = parameters.filSustain[0]!;
    const filRelease = parameters.filRelease[0]!;
    const filEnvDepth = parameters.filEnvDepth[0]!;
    const modAttack = parameters.modAttack[0]!;
    const modDecay = parameters.modDecay[0]!;
    const modSustain = parameters.modSustain[0]!;
    const modRelease = parameters.modRelease[0]!;
    const modEnvDepth = parameters.modEnvDepth[0]!;
    const lfo1Wave = parameters.lfo1Wave[0]!;
    const lfo1Freq = parameters.lfo1Freq[0]!;
    const lfo1Amp = parameters.lfo1Amp[0]!;
    const lfo2Wave = parameters.lfo2Wave[0]!;
    const lfo2Freq = parameters.lfo2Freq[0]!;
    const lfo2Amp = parameters.lfo2Amp[0]!;
    const stepNumSteps = parameters.stepNumSteps[0]!;
    // stepRate is read but unused in v2 (gate-clocked). Knob retained in
    // the UI for a future free-run mode. Reference the param so the noUnusedLocals
    // rule + DCE both stay happy.
    void parameters.stepRate[0];
    const stepSmooth = parameters.stepSmooth[0]!;
    const stepDepth = parameters.stepDepth[0]!;
    const spread = parameters.spread[0]!;

    // Fallback CV/gate path (only honored if MIDI not driving).
    // Block-rate gate decision.
    if (gateIn) {
      const gateHigh = (gateIn[0] ?? 0) > 0.5;
      const pitchV = pitchIn?.[0] ?? 0;
      if (gateHigh && !this.fallbackGateHigh) {
        // Synthesize a note-on at midi = 60 + pitchVOct * 12.
        const midi = Math.round(60 + pitchV * 12);
        this.handleNoteOn(midi, 100, 0);
        this.fallbackPitchVOct = pitchV;
      } else if (!gateHigh && this.fallbackGateHigh) {
        const midi = Math.round(60 + this.fallbackPitchVOct * 12);
        this.handleNoteOff(midi);
      }
      this.fallbackGateHigh = gateHigh;
    }

    // ---------------- Sequencer gate edge detection ----------------
    //
    // Combined gate = CV-fallback gate OR any held MIDI note. This is the
    // signal that advances the sequencer (when on). Block-rate is fine —
    // the user-perceptible cost is at most one audio block (~3ms at 48k)
    // of latency between a gate and the step advance, well below
    // perceptual threshold for a step sequencer.
    const cvGateHigh = gateIn ? (gateIn[0] ?? 0) > 0.5 : false;
    let midiGateHigh = false;
    for (const v of this.voices) {
      if (v.active && v.ampEnv.state !== EnvState.Idle && v.ampEnv.state !== EnvState.Release) {
        midiGateHigh = true;
        break;
      }
    }
    const combinedGate = cvGateHigh || midiGateHigh;
    // Reset port: rising edge → snap pointer back to -1 so the NEXT
    // gate lands on step 0. Honored regardless of seqOn so the user can
    // park the pointer before turning the sequencer on.
    if (seqResetIn) {
      const resetHigh = (seqResetIn[0] ?? 0) > 0.5;
      if (resetHigh && !this.resetPrev) {
        this.resetSeq();
      }
      this.resetPrev = resetHigh;
    }
    if (this.seqOn) {
      if (combinedGate && !this.gatePrev) {
        // Advance step pointer, latch its value, then retrigger the
        // currently-held voice's envelopes. The existing
        // handleNoteOn / fallback-CV path is what created the voice and
        // already triggered envelopes on this same edge — calling
        // trigger(true) here a second time is the explicit re-attack we
        // want (sequencer behavior is "every gate re-attacks"), and is
        // idempotent for already-attacking envs (state stays Attack,
        // value resets to 0).
        this.seq.advance(Math.round(stepNumSteps), this.stepValues);
        this.retriggerActiveEnvelopes();
        this.postStepTick(false);
      }
    }
    this.gatePrev = combinedGate;

    // Stop early if no voices active.
    let anyActive = false;
    for (let i = 0; i < voiceCount; i++) if (this.voices[i]!.active) { anyActive = true; break; }
    if (!anyActive) {
      for (let i = 0; i < blockLen; i++) {
        outL[i] = 0;
        if (outR !== outL) outR![i] = 0;
      }
      this.currentSample += blockLen;
      return true;
    }

    // Pre-compute LFO + step sequencer for this block (use the value at the
    // first sample of the block — k-rate modulators are fine for v1).
    const lfo1Val = this.lfo1.tick(lfo1Wave, lfo1Freq, sr) * lfo1Amp;
    const lfo2Val = this.lfo2.tick(lfo2Wave, lfo2Freq, sr) * lfo2Amp;
    // Sequencer modulation amount. When OFF: zero contribution (regardless
    // of stepDepth). When ON: smoothed latched value × stepDepth. stepRate
    // is intentionally unused — gate-clocked only in v2.
    const stepVal = this.seqOn
      ? this.seq.smooth(stepSmooth, sr) * stepDepth
      : 0;

    // Render each voice and sum into the output.
    for (let i = 0; i < blockLen; i++) {
      outL[i] = 0;
      if (outR !== outL) outR![i] = 0;
    }

    for (let vi = 0; vi < voiceCount; vi++) {
      const v = this.voices[vi]!;
      if (!v.active) continue;

      // Effective MIDI pitch per oscillator (Helm semantics — transpose is
      // a coarse semitone, tune is fine cents).
      const baseMidi = v.midi;
      // Per-voice mod sources.
      const osc1ModSemis = modEnvDepth * 12 * v.modEnv.value;
      const osc2ModSemis = lfo2Val * 1.0 /* ±1 semitone per lfo2Amp unit */ + stepVal * 12;

      const osc1MidiBase = baseMidi + osc1Trans + osc1Tune / 100 + osc1ModSemis;
      const osc2MidiBase = baseMidi + osc2Trans + osc2Tune / 100 + osc2ModSemis;
      const subMidi = baseMidi - 24; // -2 octaves
      const osc1Freq = C4_HZ * Math.pow(2, (osc1MidiBase - 60) / 12);
      const osc2Freq = C4_HZ * Math.pow(2, (osc2MidiBase - 60) / 12);
      const subFreq = C4_HZ * Math.pow(2, (subMidi - 60) / 12);

      // Filter cutoff base: cutoff + filEnv depth (10 oct max) + lfo1 (5
      // oct max) + filterKeyTrack * (midi - 60) semis.
      const cutoffOctOffset =
        filEnvDepth * 8 * v.filEnv.value +
        lfo1Val * 5 +
        (filterKeyTrack * (baseMidi - 60)) / 12;
      const cutoffHz = Math.max(20, Math.min(sr * 0.49, filterCutoff * Math.pow(2, cutoffOctOffset)));
      const coeffs = computePassCoeffs(filterBlend, cutoffHz, filterRes, filterStyle === FILTER_24DB, sr);

      // Per-sample render.
      for (let i = 0; i < blockLen; i++) {
        // OSC1 (with unison).
        let osc1Sum = 0;
        for (let u = 0; u < osc1Unison; u++) {
          const detuneCents = osc1Unison === 1
            ? 0
            : (u - (osc1Unison - 1) / 2) * (osc1Detune / Math.max(1, osc1Unison - 1));
          const f = osc1Freq * Math.pow(2, detuneCents / 1200);
          const dt = f / sr;
          v.osc1Phases[u]! += dt;
          if (v.osc1Phases[u]! >= 1) v.osc1Phases[u]! -= 1;
          osc1Sum += morphWave(osc1Wave, v.osc1Phases[u]!, dt);
        }
        osc1Sum /= Math.sqrt(osc1Unison);

        // OSC2 (with unison).
        let osc2Sum = 0;
        for (let u = 0; u < osc2Unison; u++) {
          const detuneCents = osc2Unison === 1
            ? 0
            : (u - (osc2Unison - 1) / 2) * (osc2Detune / Math.max(1, osc2Unison - 1));
          const f = osc2Freq * Math.pow(2, detuneCents / 1200);
          const dt = f / sr;
          v.osc2Phases[u]! += dt;
          if (v.osc2Phases[u]! >= 1) v.osc2Phases[u]! -= 1;
          osc2Sum += morphWave(osc2Wave, v.osc2Phases[u]!, dt);
        }
        osc2Sum /= Math.sqrt(osc2Unison);

        // SUB.
        const subDt = subFreq / sr;
        v.subPhase += subDt;
        if (v.subPhase >= 1) v.subPhase -= 1;
        const subSample = morphWave(subWave, v.subPhase, subDt);

        // Noise.
        const noiseSample = this.noise();

        // Mix.
        let pre =
          osc1Sum * osc1Vol +
          osc2Sum * osc2Vol +
          subSample * subVol +
          noiseSample * noiseVol;

        // Drive.
        pre *= filterDrive;

        // Filter (mono in → mono out; then split to stereo via spread).
        let filtered = 0;
        if (filterStyle === FILTER_24DB) {
          filtered = svfTick24(v.svfL, coeffs, pre);
        } else {
          filtered = svfTick12(v.svfL, coeffs, pre);
        }

        // Amp env + velocity.
        const ampEnvVal = v.ampEnv.tick(ampAttack, ampDecay, ampSustain, ampRelease, sr);
        // Tick filter env + mod env once per sample (they're updated for the
        // *next* block — but per-sample is more correct).
        v.filEnv.tick(filAttack, filDecay, filSustain, filRelease, sr);
        v.modEnv.tick(modAttack, modDecay, modSustain, modRelease, sr);

        const amp = ampEnvVal * v.velocity;
        const monoOut = filtered * amp;

        // Stereo spread: alternate-voices panned slightly to opposite sides.
        const panBias = ((vi % 2 === 0) ? -1 : 1) * spread * 0.5;
        const lGain = Math.max(0, 1 - Math.max(0, panBias));
        const rGain = Math.max(0, 1 + Math.min(0, panBias));
        outL[i] += monoOut * lGain;
        if (outR !== outL) outR![i] += monoOut * rGain;
      }

      // Voice killer: when amp env has fully released, mark inactive.
      if (v.ampEnv.state === EnvState.Idle) {
        v.active = false;
      }
    }

    // Master.
    for (let i = 0; i < blockLen; i++) {
      // Mix scaling — divide by sqrt(voiceCount) so 8 voices don't clip.
      const scale = (volume * 0.3) / Math.sqrt(voiceCount);
      outL[i] *= scale;
      if (outR !== outL) outR![i] *= scale;
    }
    this.currentSample += blockLen;
    return true;
  }
}

registerProcessor('helm', HelmProcessor);
