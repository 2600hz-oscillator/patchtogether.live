// packages/dsp/src/lib/helm-engine.ts
//
// HELM SYNTH ENGINE — shared, host-importable extraction of the HELM voice
// handler + render loop.
//
// Algorithm port of Helm's helm_engine.cpp / helm_voice_handler.cpp /
// helm_oscillators.cpp / helm_lfo.cpp / state_variable_filter.cpp /
// envelope.cpp / step_generator.cpp by Matt Tytel (GPL-3.0).
//   Original: https://tytel.org/helm — Copyright 2013-2017 Matt Tytel.
//   This port: AGPL-3.0-or-later as part of patchtogether.live.
//
// GPL-3.0 NOTE: this is the SAME copyleft lineage as packages/dsp/src/helm.ts.
// It is fine for this AGPL web app but is relevant to any future native port's
// GPL firewall — keep it tagged.
//
// WHY THIS FILE EXISTS:
//   The shipped HELM module (packages/dsp/src/helm.ts) is a monolithic
//   AudioWorkletProcessor with the synth engine inlined. POLYHELM
//   (packages/dsp/src/polyhelm.ts) is HELM + a polyPitchGate (poly bus) input
//   that drives the SAME voice allocator. Rather than refactor the shipped
//   helm.ts (which must stay byte-identical — its ART/unit coverage pins the
//   current behavior), this file is a FAITHFUL extraction of helm.ts's engine
//   so POLYHELM can reuse it without duplicating ~500 LOC of render math.
//
//   This mirrors the lib/adsr-env.ts precedent: a verbatim copy of helm's
//   Envelope lives in lib/ for the newer poly modules, while helm.ts keeps its
//   own inline copy + stays untouched.
//
//   lib/ files may `export` freely — esbuild inlines them into each worklet
//   entry at build time. The worklet ENTRY files (src/*.ts) must NOT top-level-
//   export their Processor class (the dsp-worklet-no-top-level-export rule);
//   this is a lib helper, so exporting the engine class here is correct.
//
// The engine is decoupled from AudioWorkletProcessor: it owns voices + render
// and exposes note-on/note-off (by MIDI note, HELM's native path) AND
// per-lane note-on/note-off (the poly-bus path POLYHELM needs). The worklet
// entry feeds it inputs + AudioParams; the engine is pure JS so it's unit-
// testable directly (no AudioWorkletGlobalScope).

const TWO_PI = Math.PI * 2;
export const MAX_VOICES = 8;
export const MAX_UNISON = 7;
export const C4_HZ = 261.625565;
export const NUM_STEPS = 16;

// ----------------------------------------------------------------------------
// Waveforms (algorithm port of mopo/src/wave.h Wave::wave).
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

export class SvfState {
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

export function computePassCoeffs(
  blend: number,
  cutoffHz: number,
  resonance: number,
  db24: boolean,
  sr: number,
): SvfCoeffs {
  const cutoff = Math.max(1, Math.min(sr * 0.49, cutoffHz));
  let q = Math.max(0.5, Math.min(16, resonance));
  if (db24) q = Math.sqrt(q);
  const g = Math.tan(Math.PI * Math.min(cutoff / sr, 0.49));
  const k = 1 / q;
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
// Envelope (algorithm port of mopo/src/envelope.cpp). VERBATIM copy of
// helm.ts's Envelope (hard retrigger — rising edge resets value to 0).
// ----------------------------------------------------------------------------

export enum EnvState {
  Idle = 0,
  Attack = 1,
  Decay = 2,
  Sustain = 3,
  Release = 4,
}

export class Envelope {
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
// Voice — per-note phases, envelopes, filter state.
// ----------------------------------------------------------------------------

export class Voice {
  active = false;
  midi = 60;
  /** Note-on timestamp (sample frame) for the steal-oldest allocator. */
  startSample = -1;
  osc1Phases = new Float64Array(MAX_UNISON);
  osc2Phases = new Float64Array(MAX_UNISON);
  subPhase = 0;
  svfL = new SvfState();
  svfR = new SvfState();
  ampEnv = new Envelope();
  filEnv = new Envelope();
  modEnv = new Envelope();
  velocity = 1;
  /** Note channel (1..16) — kept for future per-channel routing. */
  channel = 0;
  /** Poly-bus lane (0..4) that owns this voice, or -1 for the MIDI/CV path.
   *  POLYHELM uses this to find + release the voice when a lane's gate falls. */
  laneOwner = -1;
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
// Step sequencer — gate-clocked note sequencer (see helm.ts header for v2
// semantics: default OFF; advances one step per rising gate edge; retriggers
// the most-recent voice's envelopes on each advance).
// ----------------------------------------------------------------------------

export class StepSequencer {
  currentStep = -1;
  smoothedValue = 0;
  latchedValue = 0;
  advance(numSteps: number, steps: Float32Array): number {
    const n = Math.max(1, Math.min(NUM_STEPS, Math.round(numSteps)));
    this.currentStep = (this.currentStep + 1) % n;
    if (this.currentStep < 0) this.currentStep = 0;
    this.latchedValue = steps[this.currentStep] ?? 0;
    return this.currentStep;
  }
  reset(): void {
    this.currentStep = -1;
    this.latchedValue = 0;
  }
  smooth(smoothing: number, sr: number): number {
    const target = this.latchedValue;
    const tau = Math.max(0.001, smoothing * 0.5);
    const coef = Math.exp(-1 / (sr * tau));
    this.smoothedValue = target + (this.smoothedValue - target) * coef;
    return this.smoothedValue;
  }
}

// ----------------------------------------------------------------------------
// LFO (algorithm port of helm_lfo.cpp — free-Hz only).
// ----------------------------------------------------------------------------

export class Lfo {
  phase = 0;
  tick(waveIdx: number, freqHz: number, sr: number): number {
    this.phase += freqHz / sr;
    if (this.phase >= 1) this.phase -= 1;
    return lfoWave(waveIdx, this.phase);
  }
}

// ----------------------------------------------------------------------------
// Parameter descriptors — the full HELM v1 surface (shared by helm + polyhelm
// so both worklets declare the identical AudioParam set).
// ----------------------------------------------------------------------------

export function helmParameterDescriptors() {
  return [
    // Polyphony.
    { name: 'voiceCount',  defaultValue: 6,    minValue: 1,    maxValue: MAX_VOICES, automationRate: 'k-rate' as const },
    // Master.
    { name: 'volume',      defaultValue: 0.7,  minValue: 0,    maxValue: 2 },
    // Osc 1.
    { name: 'osc1Wave',    defaultValue: 0,    minValue: 0,    maxValue: NUM_WAVES - 1 },
    { name: 'osc1Trans',   defaultValue: 0,    minValue: -24,  maxValue: 24 },
    { name: 'osc1Tune',    defaultValue: 0,    minValue: -100, maxValue: 100 },
    { name: 'osc1Unison',  defaultValue: 1,    minValue: 1,    maxValue: MAX_UNISON },
    { name: 'osc1Detune',  defaultValue: 10,   minValue: 0,    maxValue: 50 },
    { name: 'osc1Vol',     defaultValue: 0.8,  minValue: 0,    maxValue: 1 },
    // Osc 2.
    { name: 'osc2Wave',    defaultValue: 1,    minValue: 0,    maxValue: NUM_WAVES - 1 },
    { name: 'osc2Trans',   defaultValue: 0,    minValue: -24,  maxValue: 24 },
    { name: 'osc2Tune',    defaultValue: 7,    minValue: -100, maxValue: 100 },
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
    { name: 'filterBlend',   defaultValue: 0,    minValue: 0,     maxValue: 2 },
    { name: 'filterStyle',   defaultValue: 0,    minValue: 0,     maxValue: 1 },
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
    { name: 'filEnvDepth', defaultValue: 0,     minValue: -1.0, maxValue: 1.0 },
    // Mod env.
    { name: 'modAttack',   defaultValue: 0.005, minValue: 0.0,  maxValue: 8 },
    { name: 'modDecay',    defaultValue: 0.5,   minValue: 0.0,  maxValue: 8 },
    { name: 'modSustain',  defaultValue: 0.0,   minValue: 0.0,  maxValue: 1 },
    { name: 'modRelease',  defaultValue: 0.3,   minValue: 0.0,  maxValue: 8 },
    { name: 'modEnvDepth', defaultValue: 0,     minValue: -1.0, maxValue: 1.0 },
    // LFO 1 → filter cutoff.
    { name: 'lfo1Wave',    defaultValue: 3,     minValue: 0,    maxValue: NUM_WAVES - 1 },
    { name: 'lfo1Freq',    defaultValue: 1.0,   minValue: 0.01, maxValue: 30 },
    { name: 'lfo1Amp',     defaultValue: 0,     minValue: 0,    maxValue: 1 },
    // LFO 2 → osc2 pitch.
    { name: 'lfo2Wave',    defaultValue: 3,     minValue: 0,    maxValue: NUM_WAVES - 1 },
    { name: 'lfo2Freq',    defaultValue: 4.0,   minValue: 0.01, maxValue: 30 },
    { name: 'lfo2Amp',     defaultValue: 0,     minValue: 0,    maxValue: 1 },
    // Step sequencer → osc2 transpose.
    { name: 'stepNumSteps',defaultValue: 8,     minValue: 1,    maxValue: NUM_STEPS },
    { name: 'stepRate',    defaultValue: 4.0,   minValue: 0.1,  maxValue: 30 },
    { name: 'stepSmooth',  defaultValue: 0.0,   minValue: 0.0,  maxValue: 1.0 },
    { name: 'stepDepth',   defaultValue: 0,     minValue: -1.0, maxValue: 1.0 },
    // Stereo spread.
    { name: 'spread',      defaultValue: 0.3,   minValue: 0,    maxValue: 1 },
  ];
}

/** Flat per-block parameter snapshot (k-rate; read once per render block). */
export interface HelmParams {
  voiceCount: number;
  volume: number;
  osc1Wave: number; osc1Trans: number; osc1Tune: number; osc1Unison: number; osc1Detune: number; osc1Vol: number;
  osc2Wave: number; osc2Trans: number; osc2Tune: number; osc2Unison: number; osc2Detune: number; osc2Vol: number;
  subWave: number; subVol: number;
  noiseVol: number;
  filterCutoff: number; filterRes: number; filterBlend: number; filterStyle: number; filterDrive: number; filterKeyTrack: number;
  ampAttack: number; ampDecay: number; ampSustain: number; ampRelease: number;
  filAttack: number; filDecay: number; filSustain: number; filRelease: number; filEnvDepth: number;
  modAttack: number; modDecay: number; modSustain: number; modRelease: number; modEnvDepth: number;
  lfo1Wave: number; lfo1Freq: number; lfo1Amp: number;
  lfo2Wave: number; lfo2Freq: number; lfo2Amp: number;
  stepNumSteps: number; stepSmooth: number; stepDepth: number;
  spread: number;
}

/** Pull the k-rate first-sample value of an AudioParam buffer. */
function k(params: Record<string, Float32Array>, name: string, fallback: number): number {
  const buf = params[name];
  return buf && buf.length > 0 ? buf[0]! : fallback;
}

/** Snapshot the k-rate params for one block from the AudioParam buffers. */
export function readHelmParams(params: Record<string, Float32Array>): HelmParams {
  return {
    voiceCount: Math.max(1, Math.min(MAX_VOICES, k(params, 'voiceCount', 6) | 0)),
    volume: k(params, 'volume', 0.7),
    osc1Wave: k(params, 'osc1Wave', 0), osc1Trans: k(params, 'osc1Trans', 0), osc1Tune: k(params, 'osc1Tune', 0),
    osc1Unison: Math.max(1, Math.min(MAX_UNISON, k(params, 'osc1Unison', 1) | 0)), osc1Detune: k(params, 'osc1Detune', 10), osc1Vol: k(params, 'osc1Vol', 0.8),
    osc2Wave: k(params, 'osc2Wave', 1), osc2Trans: k(params, 'osc2Trans', 0), osc2Tune: k(params, 'osc2Tune', 7),
    osc2Unison: Math.max(1, Math.min(MAX_UNISON, k(params, 'osc2Unison', 1) | 0)), osc2Detune: k(params, 'osc2Detune', 10), osc2Vol: k(params, 'osc2Vol', 0.6),
    subWave: k(params, 'subWave', 3), subVol: k(params, 'subVol', 0.4),
    noiseVol: k(params, 'noiseVol', 0),
    filterCutoff: k(params, 'filterCutoff', 4000), filterRes: k(params, 'filterRes', 1), filterBlend: k(params, 'filterBlend', 0),
    filterStyle: Math.round(k(params, 'filterStyle', 0)) === FILTER_24DB ? FILTER_24DB : FILTER_12DB,
    filterDrive: k(params, 'filterDrive', 1), filterKeyTrack: k(params, 'filterKeyTrack', 0),
    ampAttack: k(params, 'ampAttack', 0.005), ampDecay: k(params, 'ampDecay', 0.2), ampSustain: k(params, 'ampSustain', 0.6), ampRelease: k(params, 'ampRelease', 0.3),
    filAttack: k(params, 'filAttack', 0.005), filDecay: k(params, 'filDecay', 0.5), filSustain: k(params, 'filSustain', 0), filRelease: k(params, 'filRelease', 0.3), filEnvDepth: k(params, 'filEnvDepth', 0),
    modAttack: k(params, 'modAttack', 0.005), modDecay: k(params, 'modDecay', 0.5), modSustain: k(params, 'modSustain', 0), modRelease: k(params, 'modRelease', 0.3), modEnvDepth: k(params, 'modEnvDepth', 0),
    lfo1Wave: k(params, 'lfo1Wave', 3), lfo1Freq: k(params, 'lfo1Freq', 1), lfo1Amp: k(params, 'lfo1Amp', 0),
    lfo2Wave: k(params, 'lfo2Wave', 3), lfo2Freq: k(params, 'lfo2Freq', 4), lfo2Amp: k(params, 'lfo2Amp', 0),
    stepNumSteps: k(params, 'stepNumSteps', 8), stepSmooth: k(params, 'stepSmooth', 0), stepDepth: k(params, 'stepDepth', 0),
    spread: k(params, 'spread', 0.3),
  };
}

// ----------------------------------------------------------------------------
// The engine.
// ----------------------------------------------------------------------------

export class HelmEngine {
  readonly voices: Voice[] = Array.from({ length: MAX_VOICES }, () => new Voice());
  currentSample = 0;
  private lfo1 = new Lfo();
  private lfo2 = new Lfo();
  readonly seq = new StepSequencer();
  readonly stepValues = new Float32Array(NUM_STEPS);
  /** Sequencer on/off — default OFF (matches helm.ts). */
  seqOn = false;
  /** Combined-gate edge state (CV fallback + held-note OR poly-lane gate). */
  private gatePrev = false;
  /** seq_reset rising-edge state. */
  private resetPrev = false;
  private noiseSeed = 0x13579bdf | 0;

  constructor() {
    // Default step pattern: a gentle climbing chromatic.
    for (let i = 0; i < NUM_STEPS; i++) {
      this.stepValues[i] = (i / (NUM_STEPS - 1)) * 2 - 1;
    }
    for (const v of this.voices) v.reset();
  }

  // ---------------- Sequencer control ----------------

  setSeqOn(on: boolean): void {
    this.seqOn = !!on;
    if (!this.seqOn) this.seq.latchedValue = 0;
  }

  resetSeq(): void {
    this.seq.reset();
  }

  setSteps(steps: number[]): void {
    const n = Math.min(NUM_STEPS, steps.length);
    for (let i = 0; i < n; i++) {
      const s = steps[i];
      this.stepValues[i] = typeof s === 'number' ? Math.max(-1, Math.min(1, s)) : 0;
    }
  }

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

  /** MIDI / mono-CV note-on (HELM's native path; laneOwner stays -1). */
  handleNoteOn(midi: number, velocity: number, channel: number): void {
    const m = Math.max(0, Math.min(127, midi | 0));
    const vel = Math.max(0, Math.min(127, velocity)) / 127;
    if (vel === 0) {
      this.handleNoteOff(m);
      return;
    }
    const v = this.allocateVoice(MAX_VOICES);
    this.startVoice(v, m, vel, channel, -1);
  }

  /** MIDI / mono-CV note-off — release the matching active voice. */
  handleNoteOff(midi: number): void {
    const m = Math.max(0, Math.min(127, midi | 0));
    for (const v of this.voices) {
      if (
        v.active && v.laneOwner === -1 && v.midi === m &&
        v.ampEnv.state !== EnvState.Release && v.ampEnv.state !== EnvState.Idle
      ) {
        this.releaseVoice(v);
        return;
      }
    }
  }

  /** Poly-bus lane note-on — allocate a voice OWNED by this lane. Mirrors the
   *  DX7 lane allocator: prefer the voice already owned by this lane
   *  (retrigger), else a free slot, else steal. The voice stores its played
   *  MIDI note, and note-off only triggers Release — never resets v.midi — so
   *  the release tail plays at the HELD pitch (held-pitch-through-release is
   *  correct by construction, same as DX7; the cube gated-cache bug does NOT
   *  apply because the pitch lives on the persistent voice, not a per-block
   *  array). */
  noteOnLane(lane: number, midi: number, velocity: number): void {
    const m = Math.max(0, Math.min(127, midi | 0));
    const vel = Math.max(0, Math.min(1, velocity));
    if (vel <= 0) {
      this.noteOffLane(lane);
      return;
    }
    // Prefer the existing voice owned by this lane (retrigger).
    let v: Voice | null = null;
    for (const cand of this.voices) {
      if (cand.laneOwner === lane && cand.active) { v = cand; break; }
    }
    if (!v) v = this.allocateVoice(MAX_VOICES);
    this.startVoice(v, m, vel, 0, lane);
  }

  /** Poly-bus lane note-off — release the active voice owned by this lane. */
  noteOffLane(lane: number): void {
    for (const v of this.voices) {
      if (
        v.active && v.laneOwner === lane &&
        v.ampEnv.state !== EnvState.Release && v.ampEnv.state !== EnvState.Idle
      ) {
        this.releaseVoice(v);
        return;
      }
    }
  }

  /** Update the held pitch of a lane's still-gated voice (pitch glide / bend
   *  while the gate stays high). Never touches a releasing/idle voice. */
  updateLanePitch(lane: number, midi: number): void {
    const m = Math.max(0, Math.min(127, midi | 0));
    for (const v of this.voices) {
      if (v.active && v.laneOwner === lane && v.ampEnv.state !== EnvState.Release && v.ampEnv.state !== EnvState.Idle) {
        v.midi = m;
        return;
      }
    }
  }

  private startVoice(v: Voice, midi: number, velocity01: number, channel: number, laneOwner: number): void {
    v.active = true;
    v.midi = midi;
    v.velocity = velocity01;
    v.channel = channel;
    v.laneOwner = laneOwner;
    v.startSample = this.currentSample;
    v.reset();
    v.ampEnv.trigger(true);
    v.filEnv.trigger(true);
    v.modEnv.trigger(true);
  }

  private releaseVoice(v: Voice): void {
    v.ampEnv.trigger(false);
    v.filEnv.trigger(false);
    v.modEnv.trigger(false);
  }

  allOff(): void {
    for (const v of this.voices) {
      v.ampEnv.trigger(false);
      v.filEnv.trigger(false);
      v.modEnv.trigger(false);
    }
  }

  /** Any voice currently holding (gate up = attack/decay/sustain) — drives the
   *  combined sequencer gate. */
  anyHeldNote(): boolean {
    for (const v of this.voices) {
      if (v.active && v.ampEnv.state !== EnvState.Idle && v.ampEnv.state !== EnvState.Release) return true;
    }
    return false;
  }

  private noise(): number {
    this.noiseSeed = (this.noiseSeed * 16807) | 0;
    return (this.noiseSeed & 0x7fffffff) / 0x7fffffff * 2 - 1;
  }

  /**
   * Advance the sequencer gate-edge detector + seq_reset edge for this block.
   * `cvGateHigh` is the optional mono-CV-fallback gate; the engine OR's it
   * with any held note (MIDI or poly lane).
   *
   * `seqResetHigh` is the dedicated seq_reset port's level this block.
   */
  tickSequencerEdges(cvGateHigh: boolean, seqResetHigh: boolean, stepNumSteps: number): void {
    if (seqResetHigh && !this.resetPrev) this.resetSeq();
    this.resetPrev = seqResetHigh;

    const combinedGate = cvGateHigh || this.anyHeldNote();
    if (this.seqOn && combinedGate && !this.gatePrev) {
      this.seq.advance(Math.round(stepNumSteps), this.stepValues);
      this.retriggerActiveEnvelopes();
    }
    this.gatePrev = combinedGate;
  }

  /**
   * Render one audio block into outL/outR. Returns true (worklet keep-alive).
   * The caller is responsible for note-on/off + tickSequencerEdges BEFORE this.
   *
   * `outL` / `outR` are the output channel buffers (outR may === outL for mono
   * fan-out). `blockLen` is outL.length.
   */
  renderBlock(outL: Float32Array, outR: Float32Array, p: HelmParams, sr: number): boolean {
    const blockLen = outL.length;

    // Stop early if no voices active.
    let anyActive = false;
    for (let i = 0; i < p.voiceCount; i++) if (this.voices[i]!.active) { anyActive = true; break; }
    if (!anyActive) {
      for (let i = 0; i < blockLen; i++) {
        outL[i] = 0;
        if (outR !== outL) outR[i] = 0;
      }
      this.currentSample += blockLen;
      return true;
    }

    // Block-rate modulators.
    const lfo1Val = this.lfo1.tick(p.lfo1Wave, p.lfo1Freq, sr) * p.lfo1Amp;
    const lfo2Val = this.lfo2.tick(p.lfo2Wave, p.lfo2Freq, sr) * p.lfo2Amp;
    const stepVal = this.seqOn ? this.seq.smooth(p.stepSmooth, sr) * p.stepDepth : 0;

    for (let i = 0; i < blockLen; i++) {
      outL[i] = 0;
      if (outR !== outL) outR[i] = 0;
    }

    for (let vi = 0; vi < p.voiceCount; vi++) {
      const v = this.voices[vi]!;
      if (!v.active) continue;

      const baseMidi = v.midi;
      const osc1ModSemis = p.modEnvDepth * 12 * v.modEnv.value;
      const osc2ModSemis = lfo2Val * 1.0 + stepVal * 12;

      const osc1MidiBase = baseMidi + p.osc1Trans + p.osc1Tune / 100 + osc1ModSemis;
      const osc2MidiBase = baseMidi + p.osc2Trans + p.osc2Tune / 100 + osc2ModSemis;
      const subMidi = baseMidi - 24;
      const osc1Freq = C4_HZ * Math.pow(2, (osc1MidiBase - 60) / 12);
      const osc2Freq = C4_HZ * Math.pow(2, (osc2MidiBase - 60) / 12);
      const subFreq = C4_HZ * Math.pow(2, (subMidi - 60) / 12);

      const cutoffOctOffset =
        p.filEnvDepth * 8 * v.filEnv.value +
        lfo1Val * 5 +
        (p.filterKeyTrack * (baseMidi - 60)) / 12;
      const cutoffHz = Math.max(20, Math.min(sr * 0.49, p.filterCutoff * Math.pow(2, cutoffOctOffset)));
      const coeffs = computePassCoeffs(p.filterBlend, cutoffHz, p.filterRes, p.filterStyle === FILTER_24DB, sr);

      for (let i = 0; i < blockLen; i++) {
        // OSC1 (unison).
        let osc1Sum = 0;
        for (let u = 0; u < p.osc1Unison; u++) {
          const detuneCents = p.osc1Unison === 1
            ? 0
            : (u - (p.osc1Unison - 1) / 2) * (p.osc1Detune / Math.max(1, p.osc1Unison - 1));
          const f = osc1Freq * Math.pow(2, detuneCents / 1200);
          const dt = f / sr;
          v.osc1Phases[u]! += dt;
          if (v.osc1Phases[u]! >= 1) v.osc1Phases[u]! -= 1;
          osc1Sum += morphWave(p.osc1Wave, v.osc1Phases[u]!, dt);
        }
        osc1Sum /= Math.sqrt(p.osc1Unison);

        // OSC2 (unison).
        let osc2Sum = 0;
        for (let u = 0; u < p.osc2Unison; u++) {
          const detuneCents = p.osc2Unison === 1
            ? 0
            : (u - (p.osc2Unison - 1) / 2) * (p.osc2Detune / Math.max(1, p.osc2Unison - 1));
          const f = osc2Freq * Math.pow(2, detuneCents / 1200);
          const dt = f / sr;
          v.osc2Phases[u]! += dt;
          if (v.osc2Phases[u]! >= 1) v.osc2Phases[u]! -= 1;
          osc2Sum += morphWave(p.osc2Wave, v.osc2Phases[u]!, dt);
        }
        osc2Sum /= Math.sqrt(p.osc2Unison);

        // SUB.
        const subDt = subFreq / sr;
        v.subPhase += subDt;
        if (v.subPhase >= 1) v.subPhase -= 1;
        const subSample = morphWave(p.subWave, v.subPhase, subDt);

        // Noise.
        const noiseSample = this.noise();

        // Mix.
        let pre =
          osc1Sum * p.osc1Vol +
          osc2Sum * p.osc2Vol +
          subSample * p.subVol +
          noiseSample * p.noiseVol;
        pre *= p.filterDrive;

        // Filter.
        const filtered = p.filterStyle === FILTER_24DB
          ? svfTick24(v.svfL, coeffs, pre)
          : svfTick12(v.svfL, coeffs, pre);

        // Amp env + velocity.
        const ampEnvVal = v.ampEnv.tick(p.ampAttack, p.ampDecay, p.ampSustain, p.ampRelease, sr);
        v.filEnv.tick(p.filAttack, p.filDecay, p.filSustain, p.filRelease, sr);
        v.modEnv.tick(p.modAttack, p.modDecay, p.modSustain, p.modRelease, sr);

        const amp = ampEnvVal * v.velocity;
        const monoOut = filtered * amp;

        // Stereo spread.
        const panBias = ((vi % 2 === 0) ? -1 : 1) * p.spread * 0.5;
        const lGain = Math.max(0, 1 - Math.max(0, panBias));
        const rGain = Math.max(0, 1 + Math.min(0, panBias));
        outL[i] += monoOut * lGain;
        if (outR !== outL) outR[i] += monoOut * rGain;
      }

      // Voice killer.
      if (v.ampEnv.state === EnvState.Idle) {
        v.active = false;
        v.laneOwner = -1;
      }
    }

    // Master.
    const scale = (p.volume * 0.3) / Math.sqrt(p.voiceCount);
    for (let i = 0; i < blockLen; i++) {
      outL[i] *= scale;
      if (outR !== outL) outR[i] *= scale;
    }
    this.currentSample += blockLen;
    return true;
  }
}
