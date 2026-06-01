// packages/web/src/lib/audio/modules/macrooscillator.ts
//
// MACROOSCILLATOR — Plaits-style macro oscillator (audio domain).
//
// Pure-TypeScript AudioWorklet (no Faust, no emscripten vendoring). Two
// models shipped in this first slice: VA (virtual analog) and WAVESHAPE.
// See packages/dsp/src/macrooscillator.ts for the worklet DSP; the pure-math
// mirror in this file is what unit tests + the ART scenario exercise.
//
// I/O surface (matches Plaits' panel naming):
//   inputs:
//     pitch     V/oct (1 unit = 1 octave). Sums with the NOTE param.
//     trig      Gate. Rising edge resets the oscillator phase accumulators.
//     model_cv  CV → model param (discrete switch between models).
//     note_cv   CV → note param (semitones offset, ±60).
//     harm_cv   CV → harmonics param (0..1).
//     timb_cv   CV → timbre param (0..1).
//     morph_cv  CV → morph param (0..1).
//     level_cv  CV → level param (0..1).
//   outputs:
//     out       Main audio out, post-LEVEL.
//     aux       Auxiliary output — per-model "raw" tap (sub-octave in VA,
//               clean pre-distortion body in WAVESHAPE). Not LEVEL-scaled
//               so the player can use AUX as a sidechain / scope reference.
//
// Why not a full Plaits port? See the PR description. Short version:
// pichenettes' Plaits is ~30 .cc files of finely-tuned C++ with proprietary-
// looking SYX patch banks; bringing it in via emscripten was attempted in
// PR #27 and closed in favour of pure-TS engines (see DX7 PR #77 for the
// same direction). This module follows the same convention: clean-room TS,
// model-of-the-archetype rather than a literal port.
//
// Inputs:
//   pitch (pitch): V/oct, 0V = C4. Sums with the note param.
//   trig (gate): rising edge resets the oscillator phase accumulators.
//   model_cv (cv, discrete, paramTarget=model): displaces the model selector.
//   note_cv (cv, linear, paramTarget=note): displaces the note offset (±60 st).
//   harm_cv (cv, linear, paramTarget=harmonics): displaces harmonics 0..1.
//   timb_cv (cv, linear, paramTarget=timbre): displaces timbre 0..1.
//   morph_cv (cv, linear, paramTarget=morph): displaces morph 0..1.
//   level_cv (cv, linear, paramTarget=level): displaces output level 0..1.
//
// Outputs:
//   out (audio): main audio output, post-LEVEL.
//   aux (audio): per-model raw tap (sub-octave in VA, clean pre-distortion in WAVESHAPE).
//     Not LEVEL-scaled — usable as sidechain / scope reference.
//
// Params:
//   model (discrete 0..MACRO_MAX_MODEL, default 0): synthesis model picker.
//   note (linear -60..60 st, default 0): semitones offset added to pitch CV.
//   harmonics (linear 0..1, default 0.3): model-specific harmonics macro.
//   timbre (linear 0..1, default 0.3): model-specific timbre macro.
//   morph (linear 0..1, default 0.5): model-specific morph macro.
//   level (linear 0..1, default 0.8): output level.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/macrooscillator.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

// ----------------------------------------------------------------------------
// Pure-math mirror — reflected from packages/dsp/src/macrooscillator.ts so
// the engines can be driven from node (worklets can't be imported under
// vitest because the AudioWorkletProcessor base class is only present in
// AudioWorkletGlobalScope). Any algorithmic change in the worklet MUST be
// mirrored here.
// ----------------------------------------------------------------------------

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

function _wavefold(x: number, fold: number): number {
  const drive = 1 + fold * 5;
  return Math.sin(x * drive * Math.PI * 0.5) / Math.max(1, drive * 0.5);
}

class _VAEngine {
  phaseA = 0;
  phaseB = 0;
  phaseSub = 0;
  reset(): void {
    this.phaseA = 0;
    this.phaseB = 0;
    this.phaseSub = 0;
  }
  tick(freq: number, harmonics: number, timbre: number, morph: number, sr: number): [number, number] {
    const dt = freq / sr;
    const detuneSemitones = harmonics * 0.5;
    const detuneRatio = Math.pow(2, detuneSemitones / 12) - 1;
    const dtB = dt * (1 + detuneRatio);
    this.phaseA += dt;
    if (this.phaseA >= 1) this.phaseA -= 1;
    this.phaseB += dtB;
    if (this.phaseB >= 1) this.phaseB -= 1;
    this.phaseSub += dt * 0.5;
    if (this.phaseSub >= 1) this.phaseSub -= 1;

    const morphAB = (t: number, dtl: number): number => {
      const sawNaive = 2 * t - 1;
      const saw = sawNaive - _polyBlep(t, dtl);
      const sqrNaive = t < 0.5 ? 1 : -1;
      let sqr = sqrNaive;
      sqr += _polyBlep(t, dtl);
      const tShifted = t + 0.5 - Math.floor(t + 0.5);
      sqr -= _polyBlep(tShifted, dtl);
      const tri = 1 - 4 * Math.abs(t - 0.5);
      if (morph < 0.5) {
        const m = morph * 2;
        return saw * (1 - m) + sqr * m;
      }
      const m = (morph - 0.5) * 2;
      return sqr * (1 - m) + tri * m;
    };
    const oscA = morphAB(this.phaseA, dt);
    const oscB = morphAB(this.phaseB, dtB);
    const summed = (oscA + oscB) * 0.5;
    const folded = _wavefold(summed, timbre);
    const subTri = 1 - 4 * Math.abs(this.phaseSub - 0.5);
    return [folded, subTri];
  }
}

class _WaveshapeEngine {
  phase = 0;
  subPhase = 0;
  reset(): void {
    this.phase = 0;
    this.subPhase = 0;
  }
  tick(freq: number, harmonics: number, timbre: number, morph: number, sr: number): [number, number] {
    const dt = freq / sr;
    this.phase += dt;
    if (this.phase >= 1) this.phase -= 1;
    this.subPhase += dt * 0.5;
    if (this.subPhase >= 1) this.subPhase -= 1;
    const sine = Math.sin(2 * Math.PI * this.phase);
    const sub = Math.sin(2 * Math.PI * this.subPhase);
    const body = sine + sub * harmonics * 0.7;
    const drive = 1 + timbre * 7;
    const driven = body * drive;
    const folded = Math.sin(driven * Math.PI * 0.5);
    const tanhd = Math.tanh(driven);
    const main = folded * (1 - morph) + tanhd * morph;
    const normalised = main / Math.max(1, Math.sqrt(drive));
    const aux = body / Math.max(1, 1 + harmonics * 0.7);
    return [normalised, aux];
  }
}

// Carrier:modulator ratio table for FM 2-op (mirror — keep in sync with
// FM2_RATIOS in packages/dsp/src/macrooscillator.ts).
const _FM2_RATIOS: [number, number][] = [
  [1, 1], [1, 2], [2, 1], [1, 3], [3, 1], [1, 4], [2, 3], [3, 2],
];

class _FM2OpEngine {
  cPhase = 0;
  mPhase = 0;
  cPrev = 0;
  reset(): void {
    this.cPhase = 0;
    this.mPhase = 0;
    this.cPrev = 0;
  }
  tick(freq: number, harmonics: number, timbre: number, morph: number, sr: number): [number, number] {
    const ratioIdx = Math.max(0, Math.min(_FM2_RATIOS.length - 1, Math.floor(harmonics * _FM2_RATIOS.length)));
    const [cRatio, mRatio] = _FM2_RATIOS[ratioIdx]!;
    const cFreq = freq * cRatio;
    const mFreq = freq * mRatio;
    this.cPhase += cFreq / sr;
    if (this.cPhase >= 1) this.cPhase -= 1;
    this.mPhase += mFreq / sr;
    if (this.mPhase >= 1) this.mPhase -= 1;
    const modIndex = timbre * 8;
    const mod = Math.sin(2 * Math.PI * this.mPhase) * modIndex;
    const fbk = morph * Math.PI;
    const carrierPhase = 2 * Math.PI * this.cPhase + mod + this.cPrev * fbk;
    const carrier = Math.sin(carrierPhase);
    this.cPrev = carrier;
    const aux = Math.sin(2 * Math.PI * this.cPhase);
    return [carrier * 0.8, aux];
  }
}

const _FM6_BASE_RATIOS = [1.0, 1.0, 2.0, 3.0, 4.0, 1.0];

// Mirror of CHORD_SHAPES — semitone intervals above the root, 4 voices.
const _CHORD_SHAPES: number[][] = [
  [0, 12, 24, 36],
  [0, 7, 12, 19],
  [0, 3, 7, 12],
  [0, 4, 7, 12],
  [0, 2, 7, 12],
  [0, 5, 7, 12],
  [0, 4, 7, 10],
  [0, 3, 6, 9],
];

const _ADDITIVE_PARTIALS = 16;

class _ChordEngine {
  phases = [0, 0, 0, 0];
  reset(): void {
    for (let i = 0; i < 4; i++) this.phases[i] = 0;
  }
  tick(freq: number, harmonics: number, timbre: number, morph: number, sr: number): [number, number] {
    const shapeIdx = Math.max(0, Math.min(_CHORD_SHAPES.length - 1, Math.floor(harmonics * _CHORD_SHAPES.length)));
    const intervals = _CHORD_SHAPES[shapeIdx]!;
    const detuneCents = morph * 5;
    let main = 0;
    let aux = 0;
    for (let v = 0; v < 4; v++) {
      const interval = intervals[v]!;
      const sign = v % 2 === 0 ? 1 : -1;
      const cents = v === 0 ? 0 : sign * detuneCents;
      const voiceFreqHz = Math.min(8000, freq * Math.pow(2, (interval + cents / 100) / 12));
      const dt = voiceFreqHz / sr;
      this.phases[v]! += dt;
      if (this.phases[v]! >= 1) this.phases[v]! -= 1;
      const t = this.phases[v]!;
      const sine = Math.sin(2 * Math.PI * t);
      const saw = 2 * t - 1;
      const sample = sine * (1 - timbre) + saw * timbre;
      const voiceGain = v === 0 ? 1.0 : morph;
      main += sample * voiceGain;
      if (v === 0) aux = sine;
    }
    main /= 1 + 3 * morph;
    return [main * 0.8, aux];
  }
}

const _STRING_MAX_DELAY = 2400;

class _StringEngine {
  buf = new Float32Array(_STRING_MAX_DELAY);
  bufWrite = 0;
  lpState = 0;
  apX1 = 0;
  apY1 = 0;
  excAmp = 0;
  rngState = 0xa5a5a5a5 | 0;
  reset(): void {
    for (let i = 0; i < _STRING_MAX_DELAY; i++) this.buf[i] = 0;
    this.bufWrite = 0;
    this.lpState = 0;
    this.apX1 = 0;
    this.apY1 = 0;
    this.excAmp = 1.0;
  }
  noise(): number {
    this.rngState = (this.rngState * 16807) | 0;
    return (this.rngState & 0x7fffffff) / 0x7fffffff * 2 - 1;
  }
  tick(freq: number, harmonics: number, timbre: number, morph: number, sr: number): [number, number] {
    const delayLen = Math.max(2, Math.min(_STRING_MAX_DELAY - 1, Math.round(sr / freq)));
    const readIdx = (this.bufWrite - delayLen + _STRING_MAX_DELAY) % _STRING_MAX_DELAY;
    const delayed = this.buf[readIdx]!;
    const burst = this.excAmp > 0 ? this.noise() * this.excAmp : 0;
    if (this.excAmp > 0) {
      const burstDecay = Math.exp(-1 / (0.01 * sr));
      this.excAmp *= burstDecay;
    }
    const burstCutHz = 200 + timbre * 7800;
    const burstAlpha = 1 - Math.exp(-2 * Math.PI * burstCutHz / sr);
    const filteredBurst = burst * burstAlpha;
    const loopIn = delayed + filteredBurst;
    const dampHz = 200 + morph * 11800;
    const dampAlpha = 1 - Math.exp(-2 * Math.PI * dampHz / sr);
    this.lpState += dampAlpha * (loopIn - this.lpState);
    const a = harmonics * 0.5;
    const filtered = -a * this.lpState + this.apX1 + a * this.apY1;
    this.apX1 = this.lpState;
    this.apY1 = filtered;
    const looped = filtered * 0.998;
    this.buf[this.bufWrite] = looped;
    this.bufWrite = (this.bufWrite + 1) % _STRING_MAX_DELAY;
    return [looped, delayed];
  }
}

const _MODAL_PRESETS: { ratios: number[]; amps: number[] }[] = [
  { ratios: [1.0, 2.76, 5.41, 8.93, 13.34, 18.64], amps: [1.0, 0.6, 0.4, 0.3, 0.2, 0.15] },
  { ratios: [1.0, 4.0, 10.0, 16.0, 23.0, 30.0], amps: [1.0, 0.7, 0.3, 0.15, 0.1, 0.05] },
  { ratios: [0.5, 1.0, 1.2, 2.4, 3.0, 4.5], amps: [0.8, 1.0, 0.4, 0.3, 0.2, 0.15] },
  { ratios: [1.0, 4.0, 9.5, 14.0, 18.0, 24.0], amps: [1.0, 0.4, 0.2, 0.1, 0.05, 0.03] },
];

const _MODAL_MODES = 6;

class _KickEngine {
  phase = 0;
  pitchEnv = 0;
  ampEnv = 0;
  clickEnv = 0;
  rngState = 0x12345678 | 0;
  reset(): void {
    this.phase = 0;
    this.pitchEnv = 1;
    this.ampEnv = 1;
    this.clickEnv = 1;
  }
  noise(): number {
    this.rngState = (this.rngState * 16807) | 0;
    return (this.rngState & 0x7fffffff) / 0x7fffffff * 2 - 1;
  }
  tick(freq: number, harmonics: number, timbre: number, morph: number, sr: number): [number, number] {
    const pitchDecaySec = 0.03;
    const pitchDecayCoef = Math.exp(-1 / (pitchDecaySec * sr));
    this.pitchEnv *= pitchDecayCoef;
    const sweepOctaves = harmonics * 4;
    const sweepMul = Math.pow(2, sweepOctaves * this.pitchEnv);
    const currentFreq = Math.min(20000, freq * sweepMul);
    const ampDecaySec = 0.05 + morph * 1.45;
    const ampDecayCoef = Math.exp(-1 / (ampDecaySec * sr));
    this.ampEnv *= ampDecayCoef;
    const clickDecayCoef = Math.exp(-1 / (0.003 * sr));
    this.clickEnv *= clickDecayCoef;
    this.phase += currentFreq / sr;
    if (this.phase >= 1) this.phase -= 1;
    const body = Math.sin(2 * Math.PI * this.phase) * this.ampEnv;
    const click = this.noise() * this.clickEnv * timbre * 0.8;
    const main = body + click;
    const auxBody = Math.sin(2 * Math.PI * this.phase) * this.ampEnv;
    return [main, auxBody];
  }
}

class _SnareEngine {
  phaseA = 0;
  phaseB = 0.5;
  bodyEnv = 0;
  noiseEnv = 0;
  hpState = 0;
  rngState = 0xfacefeed | 0;
  reset(): void {
    this.phaseA = 0;
    this.phaseB = 0.5;
    this.bodyEnv = 1;
    this.noiseEnv = 1;
    this.hpState = 0;
  }
  noise(): number {
    this.rngState = (this.rngState * 16807) | 0;
    return (this.rngState & 0x7fffffff) / 0x7fffffff * 2 - 1;
  }
  tick(freq: number, harmonics: number, timbre: number, morph: number, sr: number): [number, number] {
    const bodyDecaySec = 0.05 + morph * 0.45;
    const bodyDecayCoef = Math.exp(-1 / (bodyDecaySec * sr));
    this.bodyEnv *= bodyDecayCoef;
    const noiseDecaySec = 0.1 + morph * 0.6;
    const noiseDecayCoef = Math.exp(-1 / (noiseDecaySec * sr));
    this.noiseEnv *= noiseDecayCoef;
    this.phaseA += freq / sr;
    if (this.phaseA >= 1) this.phaseA -= 1;
    this.phaseB += (freq * 1.5) / sr;
    if (this.phaseB >= 1) this.phaseB -= 1;
    const body = (Math.sin(2 * Math.PI * this.phaseA) + Math.sin(2 * Math.PI * this.phaseB) * 0.5) * this.bodyEnv * 0.7;
    const hpCutHz = 200 + timbre * 4800;
    const hpAlpha = 1 - Math.exp(-2 * Math.PI * hpCutHz / sr);
    const rawNoise = this.noise();
    this.hpState += hpAlpha * (rawNoise - this.hpState);
    const noiseTone = (rawNoise - this.hpState) * this.noiseEnv;
    const main = body * (1 - harmonics) + noiseTone * harmonics;
    const aux = body;
    return [main, aux];
  }
}

const _HIHAT_RATIOS = [2.0, 3.0, 4.16, 5.43, 6.79, 8.21];

class _HihatEngine {
  phases = new Float32Array(_HIHAT_RATIOS.length);
  ampEnv = 0;
  bpX1 = 0;
  bpX2 = 0;
  bpY1 = 0;
  bpY2 = 0;
  rngState = 0xdeadbeef | 0;
  reset(): void {
    // Use deterministic offsets (not Math.random) in the math mirror so
    // tests are repeatable. The worklet uses Math.random for variety;
    // tests don't care about exact phase, only spectral character.
    for (let i = 0; i < _HIHAT_RATIOS.length; i++) this.phases[i] = (i + 1) * 0.1;
    this.ampEnv = 1;
    this.bpX1 = 0; this.bpX2 = 0; this.bpY1 = 0; this.bpY2 = 0;
  }
  noise(): number {
    this.rngState = (this.rngState * 16807) | 0;
    return (this.rngState & 0x7fffffff) / 0x7fffffff * 2 - 1;
  }
  tick(freq: number, harmonics: number, timbre: number, morph: number, sr: number): [number, number] {
    const decaySec = 0.04 + morph * 0.46;
    const decayCoef = Math.exp(-1 / (decaySec * sr));
    this.ampEnv *= decayCoef;
    let metallic = 0;
    for (let i = 0; i < _HIHAT_RATIOS.length; i++) {
      const ratio = _HIHAT_RATIOS[i]!;
      this.phases[i]! += (freq * ratio) / sr;
      if (this.phases[i]! >= 1) this.phases[i]! -= 1;
      const sq = this.phases[i]! < 0.5 ? 1 : -1;
      metallic += sq;
    }
    metallic /= _HIHAT_RATIOS.length;
    const src = metallic * (1 - timbre) + this.noise() * timbre;
    const bpFreq = 2000 + harmonics * 8000;
    const Q = 0.7;
    const w0 = 2 * Math.PI * bpFreq / sr;
    const cosW0 = Math.cos(w0);
    const sinW0 = Math.sin(w0);
    const alpha = sinW0 / (2 * Q);
    const b0 = alpha;
    const b2 = -alpha;
    const a0 = 1 + alpha;
    const a1 = -2 * cosW0;
    const a2 = 1 - alpha;
    const filtered = (b0 * src + b2 * this.bpX2 - a1 * this.bpY1 - a2 * this.bpY2) / a0;
    this.bpX2 = this.bpX1;
    this.bpX1 = src;
    this.bpY2 = this.bpY1;
    this.bpY1 = filtered;
    const main = filtered * this.ampEnv * 0.8;
    const aux = metallic * this.ampEnv;
    return [main, aux];
  }
}

function _wavetableFrame(phase: number, frameIdx: number, secondPhase: number): number {
  switch (frameIdx) {
    case 0: return Math.sin(2 * Math.PI * phase);
    case 1: return 1 - 4 * Math.abs(phase - 0.5);
    case 2: return 2 * phase - 1;
    case 3: return phase < 0.5 ? 1 : -1;
    case 4: return phase < 0.25 ? 1 : -0.5;
    case 5: {
      const a = 2 * phase - 1;
      const b = 2 * secondPhase - 1;
      return (a + b) * 0.5;
    }
    case 6: {
      let sum = 0;
      for (let k = 1; k <= 7; k += 2) {
        sum += Math.sin(2 * Math.PI * k * phase) / (k * k);
      }
      return sum;
    }
    case 7: {
      const i = Math.floor(phase * 64);
      const x = Math.sin(i * 12.9898) * 43758.5453;
      return (x - Math.floor(x)) * 2 - 1;
    }
    default: return 0;
  }
}

class _WavetableEngine {
  phase = 0;
  secondPhase = 0;
  lpState = 0;
  reset(): void {
    this.phase = 0;
    this.secondPhase = 0;
    this.lpState = 0;
  }
  tick(freq: number, harmonics: number, timbre: number, morph: number, sr: number): [number, number] {
    this.phase += freq / sr;
    if (this.phase >= 1) this.phase -= 1;
    this.secondPhase += (freq * 1.01) / sr;
    if (this.secondPhase >= 1) this.secondPhase -= 1;
    const frameF = harmonics * 7;
    const frameLo = Math.floor(frameF);
    const frameHi = Math.min(7, frameLo + 1);
    const blend = frameF - frameLo;
    const morphPhase = morph < 0.5
      ? this.phase
      : (this.phase < (1 - (morph - 0.5)) ? this.phase / (1 - (morph - 0.5)) : 1);
    const morphSecondPhase = morph < 0.5
      ? this.secondPhase
      : (this.secondPhase < (1 - (morph - 0.5)) ? this.secondPhase / (1 - (morph - 0.5)) : 1);
    const wLo = _wavetableFrame(morphPhase, frameLo, morphSecondPhase);
    const wHi = _wavetableFrame(morphPhase, frameHi, morphSecondPhase);
    const raw = wLo * (1 - blend) + wHi * blend;
    const cutHz = 200 + timbre * 11800;
    const alpha = 1 - Math.exp(-2 * Math.PI * cutHz / sr);
    this.lpState += alpha * (raw - this.lpState);
    return [this.lpState, raw];
  }
}

interface _Grain {
  active: boolean;
  pos: number;
  length: number;
  pitchMul: number;
  phase: number;
}

const _GRAN_MAX_GRAINS = 8;

class _GranularEngine {
  grains: _Grain[] = [];
  spawnTimer = 0;
  rngState = 0xcafef00d | 0;
  constructor() {
    for (let i = 0; i < _GRAN_MAX_GRAINS; i++) {
      this.grains.push({ active: false, pos: 0, length: 0, pitchMul: 1, phase: 0 });
    }
  }
  reset(): void {
    for (const g of this.grains) {
      g.active = false;
      g.pos = 0;
      g.length = 0;
      g.pitchMul = 1;
      g.phase = 0;
    }
    this.spawnTimer = 0;
  }
  rand(): number {
    this.rngState = (this.rngState * 16807) | 0;
    return (this.rngState & 0x7fffffff) / 0x7fffffff;
  }
  grainEnv(pos: number, length: number, morph: number): number {
    const t = pos / length;
    if (t < 0 || t >= 1) return 0;
    if (morph < 0.33) return 1;
    if (morph < 0.66) return 1 - Math.abs(2 * t - 1);
    return 0.5 - 0.5 * Math.cos(2 * Math.PI * t);
  }
  tick(freq: number, harmonics: number, timbre: number, morph: number, sr: number): [number, number] {
    const spawnRateHz = 5 + harmonics * 195;
    const spawnEvery = sr / spawnRateHz;
    this.spawnTimer += 1;
    if (this.spawnTimer >= spawnEvery) {
      this.spawnTimer -= spawnEvery;
      for (const g of this.grains) {
        if (!g.active) {
          g.active = true;
          g.pos = 0;
          g.length = Math.floor(0.01 * sr);
          const jitter = (this.rand() * 2 - 1) * timbre * 0.06;
          g.pitchMul = 1 + jitter;
          g.phase = this.rand();
          break;
        }
      }
    }
    let main = 0;
    let auxClean = 0;
    let activeCount = 0;
    for (const g of this.grains) {
      if (!g.active) continue;
      const env = this.grainEnv(g.pos, g.length, morph);
      g.phase += (freq * g.pitchMul) / sr;
      if (g.phase >= 1) g.phase -= 1;
      const grainSample = Math.sin(2 * Math.PI * g.phase) * env;
      main += grainSample;
      activeCount++;
      g.pos += 1;
      if (g.pos >= g.length) g.active = false;
    }
    auxClean = Math.sin(2 * Math.PI * (this.spawnTimer / spawnEvery));
    if (activeCount > 1) main /= Math.sqrt(activeCount);
    return [main * 0.7, auxClean];
  }
}

const _VOWEL_PRESETS: { f: [number, number, number]; g: [number, number, number] }[] = [
  { f: [730, 1090, 2440], g: [1.0, 0.5, 0.3] },
  { f: [530, 1840, 2480], g: [1.0, 0.6, 0.3] },
  { f: [270, 2290, 3010], g: [1.0, 0.4, 0.2] },
  { f: [570, 840, 2410], g: [1.0, 0.5, 0.3] },
  { f: [300, 870, 2240], g: [1.0, 0.3, 0.2] },
  { f: [640, 1190, 2390], g: [1.0, 0.5, 0.3] },
];

class _SpeechEngine {
  phase = 0;
  x1 = [0, 0, 0];
  x2 = [0, 0, 0];
  y1 = [0, 0, 0];
  y2 = [0, 0, 0];
  rngState = 0x1badc0de | 0;
  reset(): void {
    this.phase = 0;
    for (let i = 0; i < 3; i++) {
      this.x1[i] = 0; this.x2[i] = 0; this.y1[i] = 0; this.y2[i] = 0;
    }
  }
  noise(): number {
    this.rngState = (this.rngState * 16807) | 0;
    return (this.rngState & 0x7fffffff) / 0x7fffffff * 2 - 1;
  }
  glottal(t: number): number {
    if (t < 0.3) return Math.sin(Math.PI * (t / 0.3));
    if (t < 0.5) return -0.3 * Math.sin(Math.PI * ((t - 0.3) / 0.2));
    return 0;
  }
  tick(freq: number, harmonics: number, timbre: number, morph: number, sr: number): [number, number] {
    const vowelIdx = Math.max(0, Math.min(_VOWEL_PRESETS.length - 1, Math.floor(harmonics * _VOWEL_PRESETS.length)));
    const vowel = _VOWEL_PRESETS[vowelIdx]!;
    const Q = 3 + timbre * 37;
    this.phase += freq / sr;
    if (this.phase >= 1) this.phase -= 1;
    const pulse = this.glottal(this.phase);
    const src = pulse * (1 - morph) + this.noise() * morph * 0.5;
    let main = 0;
    for (let i = 0; i < 3; i++) {
      const fc = vowel.f[i]!;
      const gain = vowel.g[i]!;
      const w0 = 2 * Math.PI * fc / sr;
      const cosW0 = Math.cos(w0);
      const sinW0 = Math.sin(w0);
      const alpha = sinW0 / (2 * Q);
      const b0 = alpha;
      const b2 = -alpha;
      const a0 = 1 + alpha;
      const a1 = -2 * cosW0;
      const a2 = 1 - alpha;
      const y = (b0 * src + b2 * this.x2[i]! - a1 * this.y1[i]! - a2 * this.y2[i]!) / a0;
      this.x2[i] = this.x1[i]!;
      this.x1[i] = src;
      this.y2[i] = this.y1[i]!;
      this.y1[i] = y;
      main += y * gain;
    }
    main *= 4.0;
    const aux = pulse;
    return [main, aux];
  }
}

class _ModalEngine {
  x1 = new Float32Array(_MODAL_MODES);
  x2 = new Float32Array(_MODAL_MODES);
  y1 = new Float32Array(_MODAL_MODES);
  y2 = new Float32Array(_MODAL_MODES);
  impPhase = 0;
  reset(): void {
    for (let i = 0; i < _MODAL_MODES; i++) {
      this.x1[i] = 0; this.x2[i] = 0; this.y1[i] = 0; this.y2[i] = 0;
    }
    this.impPhase = 0;
  }
  tick(freq: number, harmonics: number, timbre: number, morph: number, sr: number): [number, number] {
    const presetIdx = Math.max(0, Math.min(_MODAL_PRESETS.length - 1, Math.floor(harmonics * _MODAL_PRESETS.length)));
    const preset = _MODAL_PRESETS[presetIdx]!;
    const Q = 5 + timbre * 195;
    const impulseEvery = sr / 4;
    this.impPhase += 1;
    let impulse = 0;
    if (this.impPhase >= impulseEvery) {
      impulse = 1.0;
      this.impPhase -= impulseEvery;
    }
    let main = 0;
    let auxFund = 0;
    for (let m = 0; m < _MODAL_MODES; m++) {
      const ratio = preset.ratios[m]!;
      const baseAmp = preset.amps[m]!;
      const morphAmp = baseAmp * (1 - morph) + (m / _MODAL_MODES) * morph;
      const modeFreq = Math.min(sr * 0.45, freq * ratio);
      const w0 = 2 * Math.PI * modeFreq / sr;
      const cosW0 = Math.cos(w0);
      const sinW0 = Math.sin(w0);
      const alpha = sinW0 / (2 * Q);
      const b0 = alpha;
      const b2 = -alpha;
      const a0 = 1 + alpha;
      const a1 = -2 * cosW0;
      const a2 = 1 - alpha;
      const inSample = impulse;
      const y = (b0 * inSample + b2 * this.x2[m]! - a1 * this.y1[m]! - a2 * this.y2[m]!) / a0;
      this.x2[m] = this.x1[m]!;
      this.x1[m] = inSample;
      this.y2[m] = this.y1[m]!;
      this.y1[m] = y;
      main += y * morphAmp;
      if (m === 0) auxFund = y * baseAmp;
    }
    main *= 0.25;
    return [main, auxFund * 0.25];
  }
}

class _AdditiveEngine {
  phases = new Float32Array(_ADDITIVE_PARTIALS);
  reset(): void {
    for (let i = 0; i < _ADDITIVE_PARTIALS; i++) this.phases[i] = 0;
  }
  tick(freq: number, harmonics: number, timbre: number, morph: number, sr: number): [number, number] {
    const inharm = harmonics;
    let main = 0;
    let auxFund = 0;
    let normSum = 0;
    for (let p = 0; p < _ADDITIVE_PARTIALS; p++) {
      const n = p + 1;
      const partialFreq = n * freq * (1 + inharm * 0.1 * (n - 1));
      if (partialFreq >= sr * 0.5) continue;
      this.phases[p]! += partialFreq / sr;
      if (this.phases[p]! >= 1) this.phases[p]! -= 1;
      const tiltExp = 0.5 + 1.5 * timbre;
      let amp = 1 / Math.pow(n, tiltExp);
      if (n % 2 === 1) amp *= 1 - morph;
      else amp *= morph;
      main += Math.sin(2 * Math.PI * this.phases[p]!) * amp;
      normSum += amp;
      if (p === 0) auxFund = Math.sin(2 * Math.PI * this.phases[p]!);
    }
    if (normSum > 1) main /= normSum;
    return [main * 0.9, auxFund];
  }
}

class _FM6OpEngine {
  phases = [0, 0, 0, 0, 0, 0];
  fbkPrev = 0;
  envs = [1, 1, 1, 1, 1, 1];
  reset(): void {
    for (let i = 0; i < 6; i++) this.phases[i] = 0;
    this.fbkPrev = 0;
    for (let i = 0; i < 6; i++) this.envs[i] = 1;
  }
  tick(freq: number, harmonics: number, timbre: number, morph: number, sr: number): [number, number] {
    const ratioScale = 0.25 + harmonics * 0.75;
    const decaySec = 0.05 * Math.pow(100, morph);
    const decayCoef = Math.exp(-1 / (decaySec * sr));
    for (let i = 0; i < 6; i++) {
      const ratio = i === 0 ? 1.0 : _FM6_BASE_RATIOS[i]! * ratioScale;
      this.phases[i]! += (freq * ratio) / sr;
      if (this.phases[i]! >= 1) this.phases[i]! -= 1;
      this.envs[i]! *= decayCoef;
    }
    const modIndex = timbre * 6;
    const fbkAmt = 0.5 * modIndex;
    const fbkPhase = 2 * Math.PI * this.phases[5]! + this.fbkPrev * fbkAmt;
    const fbk = Math.sin(fbkPhase) * this.envs[5]!;
    this.fbkPrev = fbk;
    const op4 = Math.sin(2 * Math.PI * this.phases[4]!) * this.envs[4]! * modIndex * 0.5;
    const op3 = Math.sin(2 * Math.PI * this.phases[3]! + op4) * this.envs[3]! * modIndex * 0.5;
    const op2 = Math.sin(2 * Math.PI * this.phases[2]! + op3) * this.envs[2]! * modIndex * 0.5;
    const op1 = Math.sin(2 * Math.PI * this.phases[1]! + op2) * this.envs[1]! * modIndex * 0.5;
    const carrierMod = op1 + fbk * 0.5;
    const carrier = Math.sin(2 * Math.PI * this.phases[0]! + carrierMod) * this.envs[0]!;
    const aux = Math.sin(2 * Math.PI * this.phases[0]!);
    return [carrier * 0.7, aux];
  }
}

export interface MacroParams {
  /** 0=VA, 1=WAVESHAPE, 2=FM 2-OP, 3=FM 6-OP, 4=CHORD, 5=ADDITIVE,
   *  6=STRING, 7=MODAL, 8=KICK, 9=SNARE, 10=HIHAT, 11=WAVETABLE,
   *  12=GRANULAR, 13=SPEECH. Rounded to integer in render. */
  model: number;
  /** Semitones offset on top of the V/oct pitch input. */
  note: number;
  harmonics: number;
  timbre: number;
  morph: number;
  level: number;
}

/** Maximum legal model index. Grows as engines land; keep equal to
 *  (number-of-engines − 1) and in sync with MODEL_NAMES on the card +
 *  the model AudioParam's maxValue. */
export const MACRO_MAX_MODEL = 13;

/** Pure-math helpers — called from unit tests + ART. The actual audio runs
 *  in the worklet at packages/dsp/src/macrooscillator.ts. */
export const macrooscillatorMath = {
  /** Render `n` samples of MACROOSCILLATOR at constant pitchV / params. */
  render(
    n: number,
    sr: number,
    pitchV: number,
    params: MacroParams,
  ): { main: Float32Array; aux: Float32Array } {
    const va = new _VAEngine();
    const ws = new _WaveshapeEngine();
    const fm2 = new _FM2OpEngine();
    const fm6 = new _FM6OpEngine();
    const chord = new _ChordEngine();
    const add = new _AdditiveEngine();
    const str = new _StringEngine();
    const modal = new _ModalEngine();
    const kick = new _KickEngine();
    const snare = new _SnareEngine();
    const hihat = new _HihatEngine();
    const wt = new _WavetableEngine();
    const gran = new _GranularEngine();
    const speech = new _SpeechEngine();
    // STRING + drum models need an excitation burst — emulate the gate
    // rising-edge reset by calling reset() on the math mirror up front.
    str.reset();
    kick.reset();
    snare.reset();
    hihat.reset();
    const main = new Float32Array(n);
    const aux = new Float32Array(n);
    const semitones = pitchV * 12 + params.note;
    let freq = 261.6256 * Math.pow(2, semitones / 12);
    if (freq < 1) freq = 1;
    else if (freq > 20000) freq = 20000;
    const modelIdx = Math.max(0, Math.min(MACRO_MAX_MODEL, Math.round(params.model)));
    const h = Math.max(0, Math.min(1, params.harmonics));
    const t = Math.max(0, Math.min(1, params.timbre));
    const m = Math.max(0, Math.min(1, params.morph));
    const lvl = Math.max(0, Math.min(1, params.level));
    for (let i = 0; i < n; i++) {
      const [vaMain, vaAux] = va.tick(freq, h, t, m, sr);
      const [wsMain, wsAux] = ws.tick(freq, h, t, m, sr);
      const [fm2Main, fm2Aux] = fm2.tick(freq, h, t, m, sr);
      const [fm6Main, fm6Aux] = fm6.tick(freq, h, t, m, sr);
      const [chordMain, chordAux] = chord.tick(freq, h, t, m, sr);
      const [addMain, addAux] = add.tick(freq, h, t, m, sr);
      const [strMain, strAux] = str.tick(freq, h, t, m, sr);
      const [modMain, modAux] = modal.tick(freq, h, t, m, sr);
      const [kickMain, kickAux] = kick.tick(freq, h, t, m, sr);
      const [snareMain, snareAux] = snare.tick(freq, h, t, m, sr);
      const [hhMain, hhAux] = hihat.tick(freq, h, t, m, sr);
      const [wtMain, wtAux] = wt.tick(freq, h, t, m, sr);
      const [granMain, granAux] = gran.tick(freq, h, t, m, sr);
      const [speechMain, speechAux] = speech.tick(freq, h, t, m, sr);
      let mp = vaMain;
      let ap = vaAux;
      if (modelIdx === 1) { mp = wsMain; ap = wsAux; }
      else if (modelIdx === 2) { mp = fm2Main; ap = fm2Aux; }
      else if (modelIdx === 3) { mp = fm6Main; ap = fm6Aux; }
      else if (modelIdx === 4) { mp = chordMain; ap = chordAux; }
      else if (modelIdx === 5) { mp = addMain; ap = addAux; }
      else if (modelIdx === 6) { mp = strMain; ap = strAux; }
      else if (modelIdx === 7) { mp = modMain; ap = modAux; }
      else if (modelIdx === 8) { mp = kickMain; ap = kickAux; }
      else if (modelIdx === 9) { mp = snareMain; ap = snareAux; }
      else if (modelIdx === 10) { mp = hhMain; ap = hhAux; }
      else if (modelIdx === 11) { mp = wtMain; ap = wtAux; }
      else if (modelIdx === 12) { mp = granMain; ap = granAux; }
      else if (modelIdx === 13) { mp = speechMain; ap = speechAux; }
      main[i] = mp * lvl;
      aux[i] = ap;
    }
    return { main, aux };
  },
};

export const macrooscillatorDef: AudioModuleDef = {
  type: 'macrooscillator',
  domain: 'audio',
  label: 'MACROOSCILLATOR',
  category: 'sources',
  schemaVersion: 1,
  ossAttribution: { author: 'Émilie Gillet' },

  inputs: [
    { id: 'pitch',    type: 'pitch' },
    { id: 'trig',     type: 'gate' },
    // CV → AudioParam fast paths. Linear scale matches the project's
    // `cv ±1 → param full range` convention (see
    // .myrobots/plans/cv-range-standard.md and the shimmershine/wavetable-vco
    // patterns).
    { id: 'model_cv', type: 'cv', paramTarget: 'model',     cvScale: { mode: 'discrete' } },
    { id: 'note_cv',  type: 'cv', paramTarget: 'note',      cvScale: { mode: 'linear' } },
    { id: 'harm_cv',  type: 'cv', paramTarget: 'harmonics', cvScale: { mode: 'linear' } },
    { id: 'timb_cv',  type: 'cv', paramTarget: 'timbre',    cvScale: { mode: 'linear' } },
    { id: 'morph_cv', type: 'cv', paramTarget: 'morph',     cvScale: { mode: 'linear' } },
    { id: 'level_cv', type: 'cv', paramTarget: 'level',     cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'out', type: 'audio' },
    { id: 'aux', type: 'audio' },
  ],
  params: [
    { id: 'model',     label: 'Model',     defaultValue: 0,   min: 0,   max: MACRO_MAX_MODEL,  curve: 'discrete' },
    { id: 'note',      label: 'Note',      defaultValue: 0,   min: -60, max: 60, curve: 'linear', units: 'st' },
    { id: 'harmonics', label: 'Harmonics', defaultValue: 0.3, min: 0,   max: 1,  curve: 'linear' },
    { id: 'timbre',    label: 'Timbre',    defaultValue: 0.3, min: 0,   max: 1,  curve: 'linear' },
    { id: 'morph',     label: 'Morph',     defaultValue: 0.5, min: 0,   max: 1,  curve: 'linear' },
    { id: 'level',     label: 'Level',     defaultValue: 0.8, min: 0,   max: 1,  curve: 'linear' },
  ],

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    // 2 inputs (pitch + trig audio-rate carriers), 2 outputs (out, aux),
    // each mono. The CV → AudioParam routings ride into input 0 (the
    // pitch input slot); engine attaches them via `param:` on the handle
    // map below.
    const workletNode = new AudioWorkletNode(ctx, 'macrooscillator', {
      numberOfInputs: 2,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of macrooscillatorDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['pitch',    { node: workletNode, input: 0 }],
        ['trig',     { node: workletNode, input: 1 }],
        // CV → AudioParam routings. `input` here is unused for param
        // targets (the engine wires the source to the AudioParam directly
        // through the cvScale node), but the engine still expects a node
        // reference so we point at the worklet itself.
        ['model_cv', { node: workletNode, input: 0, param: params.get('model')! }],
        ['note_cv',  { node: workletNode, input: 0, param: params.get('note')! }],
        ['harm_cv',  { node: workletNode, input: 0, param: params.get('harmonics')! }],
        ['timb_cv',  { node: workletNode, input: 0, param: params.get('timbre')! }],
        ['morph_cv', { node: workletNode, input: 0, param: params.get('morph')! }],
        ['level_cv', { node: workletNode, input: 0, param: params.get('level')! }],
      ]),
      outputs: new Map([
        ['out', { node: workletNode, output: 0 }],
        ['aux', { node: workletNode, output: 1 }],
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
