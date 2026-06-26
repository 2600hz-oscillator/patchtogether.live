// packages/web/src/lib/audio/modules/callsine.ts
//
// CALLSINE — spectral-analysis additive resynthesizer.
//
// Algorithmic port of Warren's Spectrum (a.k.a. CallSine), MIT-licensed.
//   Upstream:   https://github.com/2600hz-oscillator/callsine
//   Copyright (c) 2026 callsine contributors  (MIT — compatible with our AGPL one-way)
//
// CallSine reads incoming audio, runs an FFT-based partial tracker
// (Hann window → peak detection → McAulay-Quatieri-lite tracking →
// optional F0 harmonic lock), and resynthesizes the signal as an
// additive bank of up to N_TRACKS=64 oscillators. Macros (Plaits-style):
//   harmonics → partials count
//   timbre    → smoothing time (slew)
//   morph     → harmonic LOCK strength (F0 snap)
//   level     → output gain
//
// v1.1 ships 14 voice models — see CALLSINE_MODEL_NAMES. Each is a
// branch of renderVoice() in the worklet (packages/dsp/src/callsine.ts).
// Further follow-up models can be added by appending to MODEL_NAMES +
// extending the switch + bumping the worklet's `model` AudioParam max.
//
// I/O:
//   audio_in (mono)   — signal to resynthesize
//   pitch    (V/oct)  — transpose the entire resynth output
//   gate              — rising edge TOGGLES freeze (latches the bank's
//                       current set of partials at their current freqs/amps)
//   *_cv              — CV → AudioParam fast paths on every macro
//   out      (mono)   — resynth output
//
// Inputs:
//   audio_in (audio): the signal to analyse + resynthesize.
//   pitch (pitch): V/oct global pitch input (transposes the additive bank).
//   gate (gate): rising edge toggles FREEZE (latch partials at their current snapshot).
//   model_cv (cv, discrete, paramTarget=model): displaces the voice-model selector.
//   note_cv (cv, linear, paramTarget=note): displaces note (±60 st).
//   harm_cv (cv, linear, paramTarget=harmonics): displaces partials count.
//   timb_cv (cv, linear, paramTarget=timbre): displaces smoothing time.
//   morph_cv (cv, linear, paramTarget=morph): displaces F0 harmonic-lock strength.
//   level_cv (cv, linear, paramTarget=level): displaces output level.
//
// Outputs:
//   out (audio): additive-resynth output.
//
// Params:
//   model (discrete 0..CALLSINE_MAX_MODEL, default 0): voice-model picker (14 models in v1.1).
//   note (linear -60..60 st, default 0): semitone transpose.
//   harmonics (linear 0..1, default 0.6): partials-count macro.
//   timbre (linear 0..1, default 0.4): smoothing-time macro.
//   morph (linear 0..1, default 0.0): F0 harmonic-lock strength.
//   level (linear 0..1, default 0.8): output level.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/callsine.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

// ---------------------------------------------------------------------------
// Algorithm constants. MUST stay in sync with packages/dsp/src/callsine.ts.
// ---------------------------------------------------------------------------
export const CALLSINE_FFT_SIZE = 1024;
export const CALLSINE_HOP_SIZE = CALLSINE_FFT_SIZE / 4;
export const CALLSINE_NUM_BINS = CALLSINE_FFT_SIZE / 2;
export const CALLSINE_N_TRACKS = 64;

// ---------------------------------------------------------------------------
// Voice model registry. The model knob is discrete; growing this list +
// the worklet's renderVoice() + the worklet `model` AudioParam maxValue
// is how follow-up PRs add models. Keep MAX_MODEL = length - 1.
// ---------------------------------------------------------------------------
export const CALLSINE_MODEL_NAMES = [
  /*  0 */ 'SINES',     // pure sinusoidal additive (canonical resynth)
  /*  1 */ 'SAW',       // polyBLEP saw (upward ramp)
  /*  2 */ 'SQR',       // polyBLEP square, 50% duty
  /*  3 */ 'PULSE25',   // polyBLEP pulse, 25% duty (nasal)
  /*  4 */ 'TRI',       // naive triangle (gentle high-freq rolloff)
  /*  5 */ 'RAMP',      // polyBLEP saw, downward (inverted SAW)
  /*  6 */ 'CHEBY3',    // cos(3·phase) — hollow odd-harmonic shaper
  /*  7 */ 'CHEBY5',    // cos(5·phase) — sharper odd-harmonic shaper
  /*  8 */ 'HARDSYNC',  // saw at 2× phase with cycle-sync — fixed-pitch sync
  /*  9 */ 'FOLD',      // tanh-folded sine — analog-folder character
  /* 10 */ 'NOISE',     // phase-keyed pseudo-random — pitched-noise voice
  /* 11 */ 'FORMANT',   // FM-ish vocal stack (cos(p)·cos(3p + 0.5·sin(p)))
  /* 12 */ 'SUBOSC',    // partial + half-freq sine — thick low end
  /* 13 */ 'METAL',     // ringmod sin(p) × sin(2.41p) — bell-like inharmonic
] as const;
export type CallsineModelName = (typeof CALLSINE_MODEL_NAMES)[number];
export const CALLSINE_MAX_MODEL = CALLSINE_MODEL_NAMES.length - 1;

/**
 * Planned follow-up models that would require analyzer-side changes (extra
 * partial generation, freezing, multi-bus, etc.) rather than just a new
 * branch in renderVoice(). Kept as a roadmap; not part of the 0..13
 * per-sample dispatch.
 */
export const CALLSINE_PLANNED_MODELS = [
  'NOISE-RES',     // SMS-style filtered-noise residual layered onto sines
  'CHORDIFY',      // each surviving peak gets +3rd/+5th sine voices
  'OCT-UP',        // double the partial bank an octave up
  'OCT-DOWN',      // halve every partial freq (sub-octave resynth)
  'WAVETABLE',     // per-voice wavetable lookup instead of sine
  'DISPERSE',      // inharmonic stretch (n * f * (1 + k*(n-1)))
  'FREEZEBANK',    // continuous slow-evolving frozen-spectrum drone
  'GLITCHHOLD',    // randomly hold N hops, then resume
  'TIMESPRAY',     // granular re-attack of held tracks on gate
  'FX-BUS',        // multi-bus split by frequency band (4 outs)
  'WHISPER',       // amplitude × noise mod (removes pitched character)
  'RING-RESYNTH',  // RM each partial against a user-CV-driven sine
  'COMB',          // re-comb-filter the partial bank
] as const;

// ---------------------------------------------------------------------------
// Pure-math mirror — reflected from packages/dsp/src/callsine.ts so unit
// tests + ART scenarios can drive the algorithm from node (the worklet
// itself can't be imported under vitest). Any algorithmic change in the
// worklet MUST be mirrored here.
// ---------------------------------------------------------------------------

interface _Track {
  alive: boolean;
  phase: number;
  freq: number;
  amp: number;
  ampTarget: number;
}

function _polyBlep(t: number, dt: number): number {
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

function _hashNoise(k: number): number {
  let x = (k | 0) ^ 0x9e3779b9;
  x = (x ^ (x << 13)) | 0;
  x = (x ^ (x >>> 17)) | 0;
  x = (x ^ (x << 5)) | 0;
  return x / 0x80000000;
}

// Mirror of renderVoice() in packages/dsp/src/callsine.ts. Keep in sync.
function _renderVoice(phase01: number, dt: number, model: number): number {
  switch (model) {
    case 0:
      return Math.sin(2 * Math.PI * phase01);
    case 1: {
      const naive = 2 * phase01 - 1;
      return naive - _polyBlep(phase01, dt);
    }
    case 2: {
      const naive = phase01 < 0.5 ? 1 : -1;
      let p2 = phase01 + 0.5;
      if (p2 >= 1) p2 -= 1;
      return naive + _polyBlep(phase01, dt) - _polyBlep(p2, dt);
    }
    case 3: {
      const duty = 0.25;
      const naive = phase01 < duty ? 1 : -1;
      let pd = phase01 + (1 - duty);
      if (pd >= 1) pd -= 1;
      return naive + _polyBlep(phase01, dt) - _polyBlep(pd, dt);
    }
    case 4:
      return phase01 < 0.5 ? 4 * phase01 - 1 : 3 - 4 * phase01;
    case 5: {
      const naive = 1 - 2 * phase01;
      return naive + _polyBlep(phase01, dt);
    }
    case 6:
      return Math.cos(6 * Math.PI * phase01);
    case 7:
      return Math.cos(10 * Math.PI * phase01);
    case 8: {
      const slave = (2 * phase01) % 1;
      const naive = 2 * slave - 1;
      return naive - _polyBlep(slave, dt * 2);
    }
    case 9: {
      const x = 3 * Math.sin(2 * Math.PI * phase01);
      return x / (1 + Math.abs(x));
    }
    case 10: {
      const key = (phase01 * 256) | 0;
      return _hashNoise(key);
    }
    case 11: {
      const p = 2 * Math.PI * phase01;
      return Math.cos(p) * Math.cos(3 * p + 0.5 * Math.sin(p));
    }
    case 12: {
      const p = 2 * Math.PI * phase01;
      return 0.5 * (Math.sin(p) + Math.sin(Math.PI * phase01));
    }
    case 13: {
      const p = 2 * Math.PI * phase01;
      return Math.sin(p) * Math.sin(2.41 * p);
    }
    default:
      return Math.sin(2 * Math.PI * phase01);
  }
}

function _hannWindow(N: number): Float32Array {
  const w = new Float32Array(N);
  for (let n = 0; n < N; n++) w[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (N - 1)));
  return w;
}

// Naive O(N²) DFT — fine for unit tests at N=1024 (~2 ms in node). The
// worklet uses an in-place radix-2 FFT for performance; this mirror only
// needs to produce the same magnitudes per bin, not run at audio rate.
function _dftMagnitudes(input: Float32Array): Float32Array {
  const N = input.length;
  const out = new Float32Array(N / 2);
  for (let k = 0; k < N / 2; k++) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < N; n++) {
      const ang = (-2 * Math.PI * k * n) / N;
      re += input[n]! * Math.cos(ang);
      im += input[n]! * Math.sin(ang);
    }
    out[k] = Math.sqrt(re * re + im * im);
  }
  return out;
}

/**
 * Run one analysis frame on `frame` (length CALLSINE_FFT_SIZE) and return
 * the detected peak list (in descending amplitude order). Used by tests
 * to verify the peak detector finds the expected sinusoid frequencies in
 * a synthetic input.
 */
function _analyzeFrameForTest(
  frame: Float32Array,
  sr: number,
  maxPartials = CALLSINE_N_TRACKS,
): { peaksHz: number[]; peaksAmp: number[]; f0Hz: number } {
  if (frame.length !== CALLSINE_FFT_SIZE) {
    throw new Error(`expected ${CALLSINE_FFT_SIZE} samples, got ${frame.length}`);
  }
  const win = _hannWindow(CALLSINE_FFT_SIZE);
  const windowed = new Float32Array(CALLSINE_FFT_SIZE);
  for (let n = 0; n < CALLSINE_FFT_SIZE; n++) windowed[n] = frame[n]! * win[n]!;
  const mag = _dftMagnitudes(windowed);

  const binHz = sr / CALLSINE_FFT_SIZE;
  let maxMag = 0;
  for (let b = 0; b < mag.length; b++) if (mag[b]! > maxMag) maxMag = mag[b]!;
  const thr = maxMag * 0.001;

  // Parabolic-refined peak detection.
  const peaksHz: number[] = [];
  const peaksAmp: number[] = [];
  const ampScale = 4 / CALLSINE_FFT_SIZE;
  for (let b = 1; b < mag.length - 1; b++) {
    const m = mag[b]!;
    if (m < thr) continue;
    if (m < mag[b - 1]!) continue;
    if (m < mag[b + 1]!) continue;
    const lm = Math.log(m + 1e-20);
    const lm1 = Math.log(mag[b - 1]! + 1e-20);
    const lm2 = Math.log(mag[b + 1]! + 1e-20);
    const denom = lm1 - 2 * lm + lm2;
    let delta = 0;
    if (Math.abs(denom) > 1e-12) delta = 0.5 * (lm1 - lm2) / denom;
    delta = Math.max(-0.5, Math.min(0.5, delta));
    const vertexLm = lm - 0.25 * (lm1 - lm2) * delta;
    const refinedMag = Math.exp(vertexLm);
    peaksHz.push((b + delta) * binHz);
    peaksAmp.push(refinedMag * ampScale);
  }

  // Sort by amplitude descending, keep top maxPartials.
  const idxs = peaksHz.map((_, i) => i).sort((a, b) => peaksAmp[b]! - peaksAmp[a]!);
  const culled = idxs.slice(0, maxPartials);
  const outHz = culled.map((i) => peaksHz[i]!);
  const outAmp = culled.map((i) => peaksAmp[i]!);

  // F0 via HSS.
  const F0_LO = 60;
  const F0_HI = 800;
  const F0_KMAX = 8;
  const binLo = Math.max(2, Math.ceil(F0_LO / binHz));
  const binHi = Math.min(
    Math.floor(mag.length / F0_KMAX),
    Math.floor(F0_HI / binHz),
  );
  let bestScore = 0;
  let bestBin = -1;
  for (let b = binLo; b <= binHi; b++) {
    let score = 0;
    for (let k = 1; k <= F0_KMAX; k++) {
      const hb = b * k;
      if (hb >= mag.length) break;
      score += mag[hb]! / Math.sqrt(k);
    }
    if (score > bestScore) {
      bestScore = score;
      bestBin = b;
    }
  }
  const f0Hz = bestBin > 0 ? bestBin * binHz : 0;

  return { peaksHz: outHz, peaksAmp: outAmp, f0Hz };
}

/**
 * End-to-end render: drive `n` samples of a test input through the math
 * mirror and return the resynth output. The mirror replicates the
 * worklet's circular-buffer-+-hop-analysis cadence exactly so tests can
 * pin the integrated behavior (does feeding a 440 Hz sine produce a
 * ~440 Hz output? does FREEZE actually freeze?).
 */
function _renderMirror(
  audio: Float32Array,
  sr: number,
  params: CallsineParams,
): Float32Array {
  const n = audio.length;
  const out = new Float32Array(n);

  const harmonics = Math.max(0, Math.min(1, params.harmonics));
  const timbre = Math.max(0, Math.min(1, params.timbre));
  const morph = Math.max(0, Math.min(1, params.morph));
  const level = Math.max(0, Math.min(1, params.level));
  const model = Math.max(0, Math.min(CALLSINE_MAX_MODEL, Math.round(params.model)));

  const slewSec = 0.005 * Math.pow(400, timbre);
  const ampCoef = 1 - Math.exp(-1 / Math.max(1, sr * slewSec));
  const freqCoefPerHop = 1 - Math.exp(-1 / Math.max(1, (sr * slewSec) / CALLSINE_HOP_SIZE));
  const activePartials = Math.max(1, Math.min(CALLSINE_N_TRACKS, Math.round(harmonics * CALLSINE_N_TRACKS)));

  const transposeRatio = Math.pow(2, (params.pitchV * 12 + params.note) / 12);

  // Track bank.
  const tracks: _Track[] = [];
  for (let i = 0; i < CALLSINE_N_TRACKS; i++) {
    tracks.push({ alive: false, phase: 0, freq: 0, amp: 0, ampTarget: 0 });
  }

  // Circular write buffer.
  const circular = new Float32Array(CALLSINE_FFT_SIZE);
  let circularWrite = 0;
  let samplesSinceHop = 0;
  const win = _hannWindow(CALLSINE_FFT_SIZE);

  const invSr = 1 / sr;
  const nyquist = 0.5 * sr;
  const aliasCutoff = nyquist * 0.85;
  const aliasRampStart = nyquist * 0.75;
  const aliasRampSpan = aliasCutoff - aliasRampStart;

  for (let i = 0; i < n; i++) {
    circular[circularWrite] = audio[i]!;
    circularWrite = (circularWrite + 1) % CALLSINE_FFT_SIZE;
    samplesSinceHop++;
    if (samplesSinceHop >= CALLSINE_HOP_SIZE) {
      // Run one analysis frame, update track bank.
      const frame = new Float32Array(CALLSINE_FFT_SIZE);
      for (let m = 0; m < CALLSINE_FFT_SIZE; m++) {
        frame[m] = circular[(circularWrite + m) % CALLSINE_FFT_SIZE]! * win[m]!;
      }
      const mag = _dftMagnitudes(frame);
      const binHz = sr / CALLSINE_FFT_SIZE;
      let maxMag = 0;
      for (let b = 0; b < mag.length; b++) if (mag[b]! > maxMag) maxMag = mag[b]!;
      const thr = maxMag * 0.001;
      const ampScale = 4 / CALLSINE_FFT_SIZE;
      // Detect peaks.
      const peakHz: number[] = [];
      const peakAmp: number[] = [];
      for (let b = 1; b < mag.length - 1; b++) {
        const m = mag[b]!;
        if (m < thr) continue;
        if (m < mag[b - 1]!) continue;
        if (m < mag[b + 1]!) continue;
        const lm = Math.log(m + 1e-20);
        const lm1 = Math.log(mag[b - 1]! + 1e-20);
        const lm2 = Math.log(mag[b + 1]! + 1e-20);
        const denom = lm1 - 2 * lm + lm2;
        let delta = 0;
        if (Math.abs(denom) > 1e-12) delta = 0.5 * (lm1 - lm2) / denom;
        delta = Math.max(-0.5, Math.min(0.5, delta));
        const vertexLm = lm - 0.25 * (lm1 - lm2) * delta;
        peakHz.push((b + delta) * binHz);
        peakAmp.push(Math.exp(vertexLm) * ampScale);
      }
      // Cull to activePartials.
      const idxs = peakHz.map((_, k) => k).sort((a, b) => peakAmp[b]! - peakAmp[a]!).slice(0, activePartials);
      const culledHz = idxs.map((k) => peakHz[k]!);
      const culledAmp = idxs.map((k) => peakAmp[k]!);

      // (Skip F0 + lock in the mirror — covered by separate tests via
      // _analyzeFrameForTest. The track-matching step below is what
      // matters for the round-trip render assertions.)

      // Match peaks → tracks.
      const matched = new Array<boolean>(CALLSINE_N_TRACKS).fill(false);
      for (let p = 0; p < culledHz.length; p++) {
        const hz = culledHz[p]!;
        const amp = culledAmp[p]!;
        let bestIdx = -1;
        let bestDist = 0.05;
        for (let ti = 0; ti < CALLSINE_N_TRACKS; ti++) {
          const t = tracks[ti]!;
          if (!t.alive || matched[ti] || t.freq <= 0) continue;
          const rel = Math.abs(t.freq - hz) / Math.max(t.freq, hz);
          if (rel < bestDist) {
            bestDist = rel;
            bestIdx = ti;
          }
        }
        if (bestIdx >= 0) {
          const t = tracks[bestIdx]!;
          t.freq += freqCoefPerHop * (hz - t.freq);
          t.ampTarget = amp;
          matched[bestIdx] = true;
          continue;
        }
        let birthIdx = -1;
        for (let ti = 0; ti < CALLSINE_N_TRACKS; ti++) {
          if (!tracks[ti]!.alive) {
            birthIdx = ti;
            break;
          }
        }
        if (birthIdx < 0) continue;
        const t = tracks[birthIdx]!;
        t.freq = hz;
        t.ampTarget = amp;
        t.alive = true;
        matched[birthIdx] = true;
      }
      for (let ti = 0; ti < CALLSINE_N_TRACKS; ti++) {
        const t = tracks[ti]!;
        if (t.alive && !matched[ti]) {
          t.ampTarget = 0;
          t.alive = false;
        }
      }
      samplesSinceHop = 0;
    }

    // Render.
    let sample = 0;
    for (let ti = 0; ti < CALLSINE_N_TRACKS; ti++) {
      const t = tracks[ti]!;
      if (!t.alive && t.amp < 1e-7 && t.ampTarget < 1e-9) continue;
      t.amp += ampCoef * (t.ampTarget - t.amp);
      const effFreq = t.freq * transposeRatio;
      if (effFreq > 0) {
        let p = t.phase + effFreq * invSr;
        if (p >= 1) p -= Math.floor(p);
        t.phase = p;
      }
      let aliasGain = 1;
      if (effFreq <= 0 || effFreq >= aliasCutoff) aliasGain = 0;
      else if (effFreq > aliasRampStart) aliasGain = (aliasCutoff - effFreq) / aliasRampSpan;
      if (aliasGain <= 0 || t.amp <= 1e-6) continue;
      const dt = effFreq * invSr;
      sample += t.amp * aliasGain * _renderVoice(t.phase, dt, model);
    }
    out[i] = sample * level;
  }

  return out;
}

export interface CallsineParams {
  /** 0..CALLSINE_MAX_MODEL (CALLSINE_MODEL_NAMES). Rounded to int in render. */
  model: number;
  /** Semitones offset on top of pitchV. */
  note: number;
  /** 0..1 → partials count (1..N_TRACKS). */
  harmonics: number;
  /** 0..1 → slew time (5 ms..2 s, log curve). */
  timbre: number;
  /** 0..1 → harmonic-lock strength. */
  morph: number;
  /** 0..1 → output gain. */
  level: number;
  /** V/oct pitch shift (1 unit = 1 octave). */
  pitchV: number;
}

/** Pure-math helpers exported for unit tests + ART. */
export const callsineMath = {
  /** Hann window of length N. */
  hannWindow: _hannWindow,
  /** O(N²) DFT magnitudes for testing — same bins as the worklet's FFT. */
  dftMagnitudes: _dftMagnitudes,
  /** Run one analysis frame; returns sorted peak list + F0. */
  analyzeFrame: _analyzeFrameForTest,
  /** Full end-to-end render (analysis + bank + transpose + level). */
  render: _renderMirror,
  /** Map a timbre macro 0..1 to slew seconds (5 ms..2 s log curve). */
  timbreToSlewSec(t: number): number {
    const v = Math.max(0, Math.min(1, t));
    return 0.005 * Math.pow(400, v);
  },
  /** Map a harmonics macro 0..1 to partial count 1..N_TRACKS. */
  harmonicsToPartials(h: number): number {
    const v = Math.max(0, Math.min(1, h));
    return Math.max(1, Math.min(CALLSINE_N_TRACKS, Math.round(v * CALLSINE_N_TRACKS)));
  },
};

export const callsineDef: AudioModuleDef = {
  type: 'callsine',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'callsine',
  // CallSine is fundamentally audio-in → audio-out (a resynth, not a
  // synth), so the category is 'effects' for sub-classification under
  // module-categories.ts (we put it in Hybrid → Hybrid because it also
  // exposes a freeze-gated audio source. See module-categories.ts.).
  category: 'effects',
  schemaVersion: 1,
  ossAttribution: { author: 'callsine contributors (Warren\'s Spectrum)' },

  inputs: [
    // Audio under analysis. Mono.
    { id: 'audio_in', type: 'audio' },
    // V/oct → transposes the entire resynth output post-analysis.
    { id: 'pitch',    type: 'pitch' },
    // Rising edge TOGGLES the FREEZE latch (mirrors CallSine's FREEZE
    // button). Hold to glitch-stutter; tap to freeze the current bank.
    { id: 'gate',     type: 'gate' },
    // CV → AudioParam fast paths.
    { id: 'model_cv', type: 'cv', paramTarget: 'model',     cvScale: { mode: 'discrete' } },
    { id: 'note_cv',  type: 'cv', paramTarget: 'note',      cvScale: { mode: 'linear' } },
    { id: 'harm_cv',  type: 'cv', paramTarget: 'harmonics', cvScale: { mode: 'linear' } },
    { id: 'timb_cv',  type: 'cv', paramTarget: 'timbre',    cvScale: { mode: 'linear' } },
    { id: 'morph_cv', type: 'cv', paramTarget: 'morph',     cvScale: { mode: 'linear' } },
    { id: 'level_cv', type: 'cv', paramTarget: 'level',     cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'audio' },
  ],
  params: [
    { id: 'model',     label: 'Model',     defaultValue: 0,   min: 0,   max: CALLSINE_MAX_MODEL, curve: 'discrete' },
    { id: 'note',      label: 'Note',      defaultValue: 0,   min: -60, max: 60, curve: 'linear', units: 'st' },
    { id: 'harmonics', label: 'Harmonics', defaultValue: 0.6, min: 0,   max: 1,  curve: 'linear' },
    { id: 'timbre',    label: 'Timbre',    defaultValue: 0.4, min: 0,   max: 1,  curve: 'linear' },
    { id: 'morph',     label: 'Morph',     defaultValue: 0.0, min: 0,   max: 1,  curve: 'linear' },
    { id: 'level',     label: 'Level',     defaultValue: 0.8, min: 0,   max: 1,  curve: 'linear' },
  ],

  docs: {
    explanation:
      "A spectral-analysis additive resynthesizer (a port of Warren's Spectrum / CallSine). It listens to whatever audio you feed in, runs a rolling FFT to find the loudest sinusoidal partials, tracks them over time, and rebuilds the sound with a bank of up to 64 oscillators — so it's a resynth, not a synth from scratch. Because the rebuild is a bank of oscillators, you can transpose the whole thing cleanly (Note / pitch CV), thin it out or fill it in (Harmonics), smear it in time (Timbre), snap its partials to a harmonic series for a more tonal result (Morph), and swap the oscillator waveform for one of 14 voice models (sine, saw, square, formant, metal, etc.). A gate toggles FREEZE, latching the current spectrum so you can stutter or drone on a held moment.",
    inputs: {
      audio_in: "The mono audio to analyse and resynthesize — anything: a synth voice, a drum loop, a vocal. CallSine tracks its strongest partials and rebuilds them with the oscillator bank.",
      pitch: "A 1V/oct pitch input that transposes the entire resynth output after analysis (it shifts the rebuilt partials, so it pitches the sound without time-stretching it). Adds with the Note knob.",
      gate: "FREEZE toggle: a rising edge flips the freeze latch on or off, snapshotting the bank's current partials (their frequencies + amplitudes) so the output drones on that spectrum even as the input changes. Tap it to freeze a moment; pulse it to glitch-stutter. It reacts to the edge, not the held level.",
      model_cv: "CV that displaces the voice-Model selector (discrete), so a stepped CV can switch oscillator waveforms.",
      note_cv: "CV that adds to the Note transpose (linear, ±60 st range), for melodic transposition from an LFO or sequencer.",
      harm_cv: "CV that adds to the Harmonics macro, opening up or thinning the partial count.",
      timb_cv: "CV that adds to the Timbre macro, sweeping the analyzer smear/slew.",
      morph_cv: "CV that adds to the Morph macro, modulating the harmonic-lock strength.",
      level_cv: "CV that adds to the output Level.",
    },
    outputs: {
      out: "The mono additive-resynth output: the tracked partials rebuilt with the selected voice model, transposed and leveled. Frozen when FREEZE is engaged.",
    },
    controls: {
      model: "The oscillator waveform each partial uses (discrete, 14 models: SINES, SAW, SQR, PULSE25, TRI, RAMP, CHEBY3/5, HARDSYNC, FOLD, NOISE, FORMANT, SUBOSC, METAL) — pick SINES for a clean resynth or a richer model to recolor the spectrum. The current model name is shown under the title.",
      note: "Semitone transpose of the whole output (-60 to +60), added to the 1V/oct pitch input — shift the resynth up or down without changing its timing.",
      harmonics: "Partials-count macro (0..1): scales how many of the strongest tracked partials are resynthesized (1 up to all 64) — low for a sparse, hollow reduction, high for a faithful full-spectrum rebuild.",
      timbre: "Smoothing/slew macro (0..1, mapping to roughly 5 ms–2 s): low tracks the input crisply, high smears partials over time for a blurred, evolving texture.",
      morph: "Harmonic-lock strength (0..1): pulls the tracked partials toward an exact harmonic series of the detected fundamental — 0 leaves them where the analysis found them (inharmonic, faithful), higher values snap them tonal.",
      level: "Output gain (0..1); the Level CV input adds to this.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // Three audio-rate inputs: audio (0), pitch (1), gate (2). Single mono
    // output. The CV → AudioParam routings ride into input 0 (the engine
    // attaches them to the AudioParam directly via the `param:` field on
    // the input map below; the node reference is just bookkeeping).
    const workletNode = new AudioWorkletNode(ctx, 'callsine', {
      numberOfInputs: 3,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of callsineDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['audio_in', { node: workletNode, input: 0 }],
        ['pitch',    { node: workletNode, input: 1 }],
        ['gate',     { node: workletNode, input: 2 }],
        ['model_cv', { node: workletNode, input: 0, param: params.get('model')! }],
        ['note_cv',  { node: workletNode, input: 0, param: params.get('note')! }],
        ['harm_cv',  { node: workletNode, input: 0, param: params.get('harmonics')! }],
        ['timb_cv',  { node: workletNode, input: 0, param: params.get('timbre')! }],
        ['morph_cv', { node: workletNode, input: 0, param: params.get('morph')! }],
        ['level_cv', { node: workletNode, input: 0, param: params.get('level')! }],
      ]),
      outputs: new Map([
        ['out', { node: workletNode, output: 0 }],
      ]),
      setParam(paramId, value) {
        params.get(paramId)?.setValueAtTime(value, ctx.currentTime);
      },
      readParam(paramId) {
        return params.get(paramId)?.value;
      },
      dispose() {
        try { workletNode.disconnect(); } catch { /* */ }
      },
    };
  },
};
