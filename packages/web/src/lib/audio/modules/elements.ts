// packages/web/src/lib/audio/modules/elements.ts
//
// ELEMENTS — modal / physical-modeling voice (audio domain).
//
// Faithful TypeScript port of Émilie Gillet's Elements (Mutable Instruments).
// Source: eurorack/elements/ — Copyright 2014 Émilie Gillet, MIT-licensed per
// individual file headers. patchtogether.live is AGPL (MIT is compatible).
// See packages/dsp/src/elements.ts for the worklet DSP (the canonical port,
// with full fidelity notes). The pure-math mirror in THIS file is a compact
// re-statement of the same algorithm that the unit tests + ART scenario
// exercise without spinning up an AudioWorklet.
//
// Fidelity summary (see dsp/src/elements.ts for the full breakdown):
//   FAITHFUL  — exciter envelope, BOW(FLOW + bow-table), BLOW(noise + tube),
//               STRIKE(mallet/particles/plectrum), MODAL resonator (SVF bank
//               + cosine-osc POSITION pickup + stereo side channel), SPACE
//               raw/spread/reverb mixdown + soft-limiting.
//   SIMPLIFIED — SPACE reverb tail (compact FDN-lite, not MI's reverb.h);
//               sample-ROM exciters replaced by synthetic equivalents; STRING
//               resonator model deferred.
//
// Inputs:
//   in (audio): external excitation input (mixed into the exciter signal).
//   strike_in (audio): per-strike-event external impulse input.
//   pitch (pitch): V/oct, 0V = C4 (sums with note).
//   gate (gate): held-gate input (drives BOW/BLOW envelopes + STRIKE retriggers).
//   note_cv / env_cv / bowlvl_cv / bowtim_cv / blowlvl_cv / blowmeta_cv /
//     blowtim_cv / strklvl_cv / strkmeta_cv / strktim_cv / geom_cv /
//     bright_cv / damp_cv / pos_cv / space_cv / strength_cv
//     (cv, linear, paramTarget=corresponding param): per-param CV displacement.
//
// Outputs:
//   main (audio): main physical-model voice output.
//   aux (audio): stereo-side / aux output for parallel processing.
//
// Params:
//   note (linear -60..60 st, default 0): semitone offset.
//   envShape (linear 0..1, default 1): exciter envelope macro.
//   bowLevel / bowTimbre (linear 0..1): BOW exciter.
//   blowLevel / blowMeta / blowTimbre (linear 0..1): BLOW (noise+tube) exciter.
//   strikeLevel / strikeMeta / strikeTimbre (linear 0..1): STRIKE exciter.
//   geometry (linear 0..1, default 0.2): resonator-geometry macro.
//   brightness (linear 0..1, default 0.5): resonator high-end.
//   damping (linear 0..1, default 0.25): partial decay.
//   position (linear 0..1, default 0.3): pickup position.
//   space (linear 0..2, default 0.3): SPACE reverb mix amount.
//   strength (linear 0..1, default 0.5): output strength / drive.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import workletUrl from '@patchtogether.live/dsp/dist/elements.js?url';

const loadedContexts = new WeakSet<BaseAudioContext>();

// ───────────────────────── pure-math mirror (testable) ─────────────────────
class _Svf {
  g = 0; r = 0; h = 0; s1 = 0; s2 = 0;
  init(): void { this.g = 0; this.r = 0; this.h = 0; this.s1 = 0; this.s2 = 0; }
  setFQ(f: number, q: number): void {
    this.g = Math.tan(Math.PI * Math.min(f, 0.49));
    this.r = 1 / q;
    this.h = 1 / (1 + this.r * this.g + this.g * this.g);
  }
  bp(input: number): number {
    const hp = (input - this.r * this.s1 - this.g * this.s1 - this.s2) * this.h;
    const bp = this.g * hp + this.s1;
    this.s1 = this.g * hp + bp;
    const lp = this.g * bp + this.s2;
    this.s2 = this.g * bp + lp;
    return bp;
  }
  lp(input: number): number {
    const hp = (input - this.r * this.s1 - this.g * this.s1 - this.s2) * this.h;
    const b = this.g * hp + this.s1;
    this.s1 = this.g * hp + b;
    const l = this.g * b + this.s2;
    this.s2 = this.g * b + l;
    return l;
  }
}

class _Cos {
  iir = 0; y1 = 0; y0 = 0;
  init(freq: number): void { this.iir = 2 * Math.cos(2 * Math.PI * freq); }
  start(): void { this.y1 = 0.5 * this.iir; this.y0 = 1; }
  next(): number { const r = this.y0; const t = this.y0; this.y0 = this.iir * this.y0 - this.y1; this.y1 = t; return r; }
}

function _softLimit(x: number): number { return (x * (27 + x * x)) / (27 + 9 * x * x); }

class _Rng {
  s = 0x12345678 >>> 0;
  word(): number { this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0; return this.s; }
  sample(): number { return this.word() / 4294967296; }
}

const _kMaxModes = 64;

class _Resonator {
  f: _Svf[] = [];
  frequency = 220 / 32000;
  geometry = 0.25;
  brightness = 0.5;
  damping = 0.3;
  position = 0.999;
  previousPosition = 0;
  modulationFrequency = 0.5 / 32000;
  modulationOffset = 0.1;
  lfoPhase = 0;
  resolution = 52;
  constructor() { for (let i = 0; i < _kMaxModes; i++) this.f.push(new _Svf()); }
  init(): void { for (const f of this.f) f.init(); this.previousPosition = 0; this.lfoPhase = 0; }
  private stiffness(g: number): number {
    if (g < 0.25) return -0.07 + g * 0.28;
    if (g < 0.3) return 0;
    if (g < 0.9) return (g - 0.3) * 0.12;
    return 0.072 + (g - 0.9) * 2.0;
  }
  private compute(): number {
    let stiffness = this.stiffness(this.geometry);
    let harmonic = this.frequency;
    let stretch = 1;
    const q = 500 * Math.pow(10, -4 * this.damping * 0.8);
    let ba = 1 - this.geometry; ba *= ba; ba *= ba; ba *= ba;
    const brightness = this.brightness * (1 - 0.2 * ba);
    let qLoss = brightness * (2 - brightness) * 0.85 + 0.15;
    const qLossRate = this.geometry * (2 - this.geometry) * 0.1;
    let num = 0;
    let qc = q;
    const max = Math.min(_kMaxModes, this.resolution);
    for (let i = 0; i < max; i++) {
      let pf = harmonic * stretch;
      if (pf < this.frequency) pf = this.frequency;
      if (pf >= 0.49) pf = 0.49; else num = i + 1;
      this.f[i]!.setFQ(pf, 1 + pf * qc);
      stretch += stiffness;
      if (stiffness < 0) stiffness *= 0.93; else stiffness *= 0.98;
      qLoss += qLossRate * (1 - qLoss);
      harmonic += this.frequency;
      qc *= qLoss;
    }
    return num;
  }
  process(inBuf: Float32Array, center: Float32Array, sides: Float32Array, size: number): void {
    const num = this.compute();
    const posInc = (this.position - this.previousPosition) / size;
    for (let n = 0; n < size; n++) {
      this.lfoPhase += this.modulationFrequency;
      if (this.lfoPhase >= 1) this.lfoPhase -= 1;
      this.previousPosition += posInc;
      const lfo = this.lfoPhase > 0.5 ? 1 - this.lfoPhase : this.lfoPhase;
      const amp = new _Cos(); const aux = new _Cos();
      amp.init(this.previousPosition * 0.5);
      aux.init((this.modulationOffset + lfo) * 0.5);
      const input = inBuf[n]! * 0.125;
      let sc = 0; let ss = 0;
      amp.start(); aux.start();
      for (let i = 0; i < num; i++) {
        const s = this.f[i]!.bp(input);
        sc += s * amp.next();
        ss += s * aux.next();
      }
      sides[n] = ss - sc;
      center[n] = sc;
    }
  }
}

const _EXC_MALLET = 2;
const _EXC_PARTICLES = 4;
const _EXC_FLOW = 5;
const _EXC_NOISE = 6;

class _Exciter {
  model = _EXC_MALLET;
  parameter = 0; timbre = 0.99; damping = 0; dampState = 0; particleState = 0.5; particleRange = 1; plectrumDelay = 0; delay = 0;
  lp = new _Svf();
  rng: _Rng; sr: number;
  constructor(rng: _Rng, sr: number) { this.rng = rng; this.sr = sr; this.lp.init(); }
  private pulse(c: number): number { return 1 + 4 * (1 - Math.max(0, Math.min(1, c))); }
  private cutoff(t: number): number { const hz = 20 * Math.pow((this.sr * 0.45) / 20, Math.max(0, Math.min(1, t))); return Math.min(0.49, hz / this.sr); }
  setMeta(meta: number, first: number, last: number): void {
    meta *= last - first + 1;
    let mi = Math.floor(meta);
    if (first + mi > _EXC_NOISE) mi = _EXC_NOISE - first;
    this.model = first + mi;
    if (this.model > _EXC_NOISE) this.model = _EXC_NOISE;
    this.parameter = meta - Math.floor(meta);
  }
  process(rising: boolean, gate: boolean, out: Float32Array, size: number): void {
    this.damping = 0;
    if (this.model === _EXC_MALLET) {
      out.fill(0, 0, size);
      if (rising) { this.dampState = 0; out[0] = this.pulse(this.timbre); }
      if (!gate) this.dampState = 1 - 0.95 * (1 - this.dampState);
      this.damping = this.dampState * (1 - this.parameter);
    } else if (this.model === _EXC_PARTICLES) {
      if (rising) { const p = this.rng.sample(); this.particleState = 1 - 0.6 * p * p; this.delay = 0; this.particleRange = 1; }
      out.fill(0, 0, size);
      if (gate) {
        const amplitude = this.pulse(this.timbre);
        for (let i = 0; i < size; i++) {
          if (this.delay === 0) {
            let amount = this.rng.sample(); amount = 1.05 + 0.5 * amount * amount;
            if (this.rng.word() > 0.7 * 4294967296) { this.particleState *= amount; if (this.particleState >= this.particleRange + 0.25) this.particleState = this.particleRange + 0.25; }
            else if (this.rng.word() < 0.3 * 4294967296) { this.particleState /= amount; if (this.particleState <= 0.02) this.particleState = 0.02; }
            this.delay = Math.floor(this.particleState * 0.15 * this.sr);
            let gain = 1 - this.particleRange; gain *= gain;
            out[i] = this.particleState * amplitude * (1 - gain);
            const decay = 1 - this.parameter; this.particleRange *= 1 - decay * decay * 0.5;
          } else { --this.delay; }
        }
      }
    } else if (this.model === _EXC_FLOW) {
      const scale = this.parameter ** 4;
      const threshold = 0.0001 + scale * 0.125;
      if (rising) this.particleState = 0.5;
      for (let i = 0; i < size; i++) {
        const s = this.rng.sample();
        if (s < threshold) this.particleState = -this.particleState;
        out[i] = this.particleState + (s - 0.5 - this.particleState) * scale;
      }
    } else {
      for (let i = 0; i < size; i++) out[i] = this.rng.sample() - 0.5;
    }
    const c = this.cutoff(this.timbre);
    this.lp.setFQ(c, this.model === _EXC_NOISE ? 0.5 + this.parameter * 20 : 0.5);
    for (let i = 0; i < size; i++) out[i] = this.lp.lp(out[i]!);
  }
}

export interface ElementsParams {
  note: number;
  envShape: number;
  bowLevel: number;
  bowTimbre: number;
  blowLevel: number;
  blowMeta: number;
  blowTimbre: number;
  strikeLevel: number;
  strikeMeta: number;
  strikeTimbre: number;
  geometry: number;
  brightness: number;
  damping: number;
  position: number;
  space: number;
  strength: number;
}

/**
 * Pure-math mirror of the Elements voice. Renders `n` samples for a single
 * gate event at `gateAt` (held until `gateOff`). Returns stereo main/aux. This
 * is the simplified-but-representative path the unit tests exercise; the
 * AudioWorklet (dsp/src/elements.ts) is the full-fidelity engine.
 */
export const elementsMath = {
  render(
    n: number,
    sr: number,
    pitchV: number,
    params: ElementsParams,
    gateAt = 0,
    gateOff = -1,
  ): { main: Float32Array; aux: Float32Array } {
    const rng = new _Rng();
    const reson = new _Resonator();
    reson.init();
    reson.resolution = 52;
    reson.modulationFrequency = 0.5 / sr;
    const bow = new _Exciter(rng, sr); bow.model = _EXC_FLOW; bow.parameter = 0.7;
    const blow = new _Exciter(rng, sr); blow.model = _EXC_NOISE;
    const strike = new _Exciter(rng, sr);

    const main = new Float32Array(n);
    const aux = new Float32Array(n);

    const midi = 69 + pitchV * 12 + params.note;
    let freq = (440 * Math.pow(2, (midi - 69) / 12)) / sr;
    if (freq < 0.0001) freq = 0.0001;
    if (freq > 0.49) freq = 0.49;
    reson.frequency = freq;
    reson.geometry = params.geometry;
    reson.brightness = params.brightness;
    reson.position = params.position;
    reson.previousPosition = params.position;
    reson.damping = params.damping;

    // SPACE mixdown coefficients (part.cc).
    let space = params.space >= 1 ? 1 : params.space;
    const rawGain = space <= 0.05 ? 1 : space <= 0.1 ? 2 - space * 20 : 0;
    space = space >= 0.1 ? space - 0.1 : 0;
    const spread = space <= 0.7 ? space : 0.7;

    // brightness-coupled bow timbre.
    const brightnessFactor = 0.4 + 0.6 * params.brightness;
    bow.timbre = params.bowTimbre * brightnessFactor;
    blow.timbre = params.blowTimbre; blow.parameter = params.blowMeta;
    const sm = params.strikeMeta;
    strike.setMeta(sm <= 0.4 ? sm * 0.625 : sm * 1.25 - 0.25, _EXC_MALLET, _EXC_PARTICLES);
    strike.timbre = params.strikeTimbre;

    const BLOCK = 64;
    const bowBuf = new Float32Array(BLOCK);
    const blowBuf = new Float32Array(BLOCK);
    const strikeBuf = new Float32Array(BLOCK);
    const bowStr = new Float32Array(BLOCK);
    const rawBuf = new Float32Array(BLOCK);
    const center = new Float32Array(BLOCK);
    const sides = new Float32Array(BLOCK);

    let prevGate = false;
    let envValue = 0;
    // Simple ADSR-ish envelope shaped by envShape (compact mirror of the
    // multistage envelope: attack rate + sustain + release rate).
    const shape = params.envShape;
    let sustain = 0.5;
    if (shape < 0.4) sustain = 0;
    else if (shape < 0.6) sustain = (shape - 0.4) * 5;
    else sustain = 1;
    const attackRate = 1 / Math.max(1, 0.005 * sr);
    const releaseRate = 1 / Math.max(1, 0.2 * sr);
    let envPhase = 0; // 0 attack, 1 sustain, 2 release

    let strikeLevel = params.strikeLevel * 1.25;
    const strikeBleed = strikeLevel > 1 ? (strikeLevel - 1) * 2 : 0;
    strikeLevel = strikeLevel < 1 ? strikeLevel : 1;
    strikeLevel *= 1.5;
    let blowLevel = params.blowLevel * 1.5;
    blowLevel = blowLevel < 1 ? blowLevel * 0.4 : 0.4;

    for (let base = 0; base < n; base += BLOCK) {
      const size = Math.min(BLOCK, n - base);
      const gateOn = base >= gateAt && (gateOff < 0 || base < gateOff);
      const rising = gateOn && !prevGate;

      bow.process(rising, gateOn, bowBuf, size);
      blow.process(rising, gateOn, blowBuf, size);
      strike.process(rising, gateOn, strikeBuf, size);
      prevGate = gateOn;

      for (let i = 0; i < size; i++) {
        // envelope
        if (rising && i === 0) { envPhase = 0; }
        if (!gateOn) envPhase = 2;
        if (envPhase === 0) { envValue += attackRate; if (envValue >= 1) { envValue = 1; envPhase = 1; } }
        else if (envPhase === 1) { envValue += (sustain - envValue) * 0.001; }
        else { envValue -= releaseRate; if (envValue < 0) envValue = 0; }

        const accent = 0.25 + 0.75 * params.strength;
        bowStr[i] = envValue * params.bowLevel;
        const e = envValue * accent;
        let input = 0;
        input += bowBuf[i]! * bowStr[i]! * 0.125 * accent;
        input += blowBuf[i]! * blowLevel * e;
        input += strikeBuf[i]! * accent * strikeLevel;
        rawBuf[i] = input * 0.5;
      }

      reson.process(rawBuf, center, sides, size);

      for (let i = 0; i < size; i++) {
        const c = center[i]! + strikeBleed * strikeBuf[i]! * accentSafe(params.strength);
        const side = sides[i]! * spread;
        let r = c - side;
        let l = c + side;
        l = l + (rawBuf[i]! - l) * rawGain;
        main[base + i] = _softLimit(r);
        aux[base + i] = _softLimit(l);
      }
    }
    return { main, aux };
  },
};

function accentSafe(strength: number): number { return 0.25 + 0.75 * strength; }

// ──────────────────────────────── module def ───────────────────────────────
export const elementsDef: AudioModuleDef = {
  type: 'elements',
  palette: { top: 'Audio modules', sub: 'Effects' },
  domain: 'audio',
  label: 'elements',
  category: 'sources',
  schemaVersion: 1,
  stereoPairs: [['main', 'aux']],
  ossAttribution: { author: 'Émilie Gillet' },

  inputs: [
    { id: 'in',           type: 'audio' },
    { id: 'strike_in',    type: 'audio' },
    { id: 'pitch',        type: 'pitch' },
    { id: 'gate',         type: 'gate' },
    { id: 'note_cv',      type: 'cv', paramTarget: 'note',         cvScale: { mode: 'linear' } },
    { id: 'env_cv',       type: 'cv', paramTarget: 'envShape',     cvScale: { mode: 'linear' } },
    { id: 'bowlvl_cv',    type: 'cv', paramTarget: 'bowLevel',     cvScale: { mode: 'linear' } },
    { id: 'bowtim_cv',    type: 'cv', paramTarget: 'bowTimbre',    cvScale: { mode: 'linear' } },
    { id: 'blowlvl_cv',   type: 'cv', paramTarget: 'blowLevel',    cvScale: { mode: 'linear' } },
    { id: 'blowmeta_cv',  type: 'cv', paramTarget: 'blowMeta',     cvScale: { mode: 'linear' } },
    { id: 'blowtim_cv',   type: 'cv', paramTarget: 'blowTimbre',   cvScale: { mode: 'linear' } },
    { id: 'strklvl_cv',   type: 'cv', paramTarget: 'strikeLevel',  cvScale: { mode: 'linear' } },
    { id: 'strkmeta_cv',  type: 'cv', paramTarget: 'strikeMeta',   cvScale: { mode: 'linear' } },
    { id: 'strktim_cv',   type: 'cv', paramTarget: 'strikeTimbre', cvScale: { mode: 'linear' } },
    { id: 'geom_cv',      type: 'cv', paramTarget: 'geometry',     cvScale: { mode: 'linear' } },
    { id: 'bright_cv',    type: 'cv', paramTarget: 'brightness',   cvScale: { mode: 'linear' } },
    { id: 'damp_cv',      type: 'cv', paramTarget: 'damping',      cvScale: { mode: 'linear' } },
    { id: 'pos_cv',       type: 'cv', paramTarget: 'position',     cvScale: { mode: 'linear' } },
    { id: 'space_cv',     type: 'cv', paramTarget: 'space',        cvScale: { mode: 'linear' } },
    { id: 'strength_cv',  type: 'cv', paramTarget: 'strength',     cvScale: { mode: 'linear' } },
  ],
  outputs: [
    { id: 'main', type: 'audio' },
    { id: 'aux',  type: 'audio' },
  ],
  params: [
    { id: 'note',         label: 'Note',         defaultValue: 0,    min: -60, max: 60, curve: 'linear', units: 'st' },
    { id: 'envShape',     label: 'Env',          defaultValue: 1,    min: 0,   max: 1,  curve: 'linear' },
    { id: 'bowLevel',     label: 'Bow',          defaultValue: 0,    min: 0,   max: 1,  curve: 'linear' },
    { id: 'bowTimbre',    label: 'Bow Tmb',      defaultValue: 0.5,  min: 0,   max: 1,  curve: 'linear' },
    { id: 'blowLevel',    label: 'Blow',         defaultValue: 0,    min: 0,   max: 1,  curve: 'linear' },
    { id: 'blowMeta',     label: 'Flow',         defaultValue: 0.5,  min: 0,   max: 1,  curve: 'linear' },
    { id: 'blowTimbre',   label: 'Blow Tmb',     defaultValue: 0.5,  min: 0,   max: 1,  curve: 'linear' },
    { id: 'strikeLevel',  label: 'Strike',       defaultValue: 0.8,  min: 0,   max: 1,  curve: 'linear' },
    { id: 'strikeMeta',   label: 'Mallet',       defaultValue: 0.5,  min: 0,   max: 1,  curve: 'linear' },
    { id: 'strikeTimbre', label: 'Strike Tmb',   defaultValue: 0.5,  min: 0,   max: 1,  curve: 'linear' },
    { id: 'geometry',     label: 'Geometry',     defaultValue: 0.2,  min: 0,   max: 1,  curve: 'linear' },
    { id: 'brightness',   label: 'Brightness',   defaultValue: 0.5,  min: 0,   max: 1,  curve: 'linear' },
    { id: 'damping',      label: 'Damping',      defaultValue: 0.25, min: 0,   max: 1,  curve: 'linear' },
    { id: 'position',     label: 'Position',     defaultValue: 0.3,  min: 0,   max: 1,  curve: 'linear' },
    { id: 'space',        label: 'Space',        defaultValue: 0.3,  min: 0,   max: 2,  curve: 'linear' },
    { id: 'strength',     label: 'Strength',     defaultValue: 0.5,  min: 0,   max: 1,  curve: 'linear' },
  ],

  docs: {
    explanation: "A modal physical-modeling voice (a port of Mutable Instruments Elements): instead of an oscillator you have THREE exciters that inject energy into a tuned modal resonator, like rubbing, blowing, or hitting a physical object. BOW is continuous friction (a smooth, sustained scrape, as on a bowed string). BLOW is breath/air noise shaped by a tube (its Flow + Timbre give everything from a flute to a rush of wind). STRIKE is a percussive impact (a mallet hit, scattered particles, or a plucked pluck). You blend the three by their LEVEL knobs and they sum into the RESONATOR — a bank of tuned filters whose GEOMETRY, BRIGHTNESS, DAMPING, and POSITION sculpt the virtual body (string vs. plate vs. bell, how bright, how long it rings, where it's struck). The resonator's output then runs through SPACE, a single meta-knob that goes from bone-dry, through stereo widening, into reverb, and finally a frozen infinite tail. A GATE plays the note (it opens the exciter envelope); PITCH (V/oct) and the Note knob tune it. You can also feed an external signal into the resonator instead of (or alongside) the built-in exciters to 'play' the body with any sound. Two outputs (MAIN + AUX) form a stereo pair.",
    inputs: {
      in: "External excitation input — an audio signal mixed in alongside the BOW/BLOW/STRIKE exciters so you can drive the modal resonator with any external sound (a drum loop, another voice, noise) and hear it 'resonated' through the body. Unpatched it contributes nothing and the built-in exciters play the voice on their own.",
      strike_in: "External per-strike impulse input — an audio signal injected at the STRIKE stage to excite the resonator with an outside transient (e.g. a click or click-track) in place of the internal mallet/particle exciter. Unpatched it does nothing; the internal STRIKE exciter still fires on the gate.",
      pitch: "1V/oct pitch CV. Sums with the Note knob to set the resonator's fundamental frequency; 0V plays the base note (≈ C4) and each volt shifts an octave.",
      gate: "The note gate (a GATE, level-sensitive on both edges): while it is high the BOW and BLOW exciters sustain and the exciter envelope holds open; its rising edge also retriggers/strikes the STRIKE exciter, and its falling edge starts the release. Hold it for a sustained bow/blow tone, pulse it for plucks and hits.",
      note_cv: "CV that displaces the Note control, transposing the played pitch in semitones (sums on top of the pitch input).",
      env_cv: "CV that displaces the Env control, modulating the exciter envelope's shape (how percussive vs. sustained the excitation is).",
      bowlvl_cv: "CV that displaces the Bow control, modulating how much of the continuous-friction BOW exciter feeds the resonator.",
      bowtim_cv: "CV that displaces the Bow Tmb control, modulating the BOW exciter's tone (its friction-table brightness, also tracked by the resonator's brightness).",
      blowlvl_cv: "CV that displaces the Blow control, modulating how much of the breath/air BLOW exciter feeds the resonator.",
      blowmeta_cv: "CV that displaces the Flow control (the BLOW exciter's meta/character — the granularity and turbulence of the breath).",
      blowtim_cv: "CV that displaces the Blow Tmb control, modulating the BLOW exciter's tone (the air noise's spectral tilt / tube colour).",
      strklvl_cv: "CV that displaces the Strike control, modulating how much of the percussive STRIKE exciter feeds the resonator (high values bleed extra raw impact into the body).",
      strkmeta_cv: "CV that displaces the Mallet control (the STRIKE exciter's meta — it morphs the impact model from a soft mallet through to scattered particles).",
      strktim_cv: "CV that displaces the Strike Tmb control, modulating the STRIKE exciter's tone (the hardness/brightness of the impact).",
      geom_cv: "CV that displaces the Geometry control, reshaping the resonator's modal layout (the inharmonicity / 'body shape' — string toward plate/bell).",
      bright_cv: "CV that displaces the Brightness control, modulating the resonator's high-frequency content (how much energy survives in the upper partials).",
      damp_cv: "CV that displaces the Damping control, modulating how fast the resonator's partials decay (short, muted ring vs. long sustain).",
      pos_cv: "CV that displaces the Position control, moving the virtual pickup point along the body and combing the partials (changes which harmonics are emphasised).",
      space_cv: "CV that displaces the Space control, sweeping the dry → stereo-spread → reverb → freeze meta-amount.",
      strength_cv: "CV that displaces the Strength control, modulating the excitation strength / accent (how hard the voice is driven).",
    },
    outputs: {
      main: "The primary modal-voice output — the resonator's centre/right channel after the SPACE mixdown and soft-limiting. Use it on its own for a mono patch.",
      aux: "The stereo partner of MAIN — the resonator's side/left channel (a slightly different pickup tap via a slow internal LFO), so MAIN + AUX together give a stereo image whose width grows with SPACE. At very low SPACE this channel also carries the dry, un-resonated exciter signal (the 'raw' tap), so AUX can double as a direct exciter output. The two share the stereoPairs grouping (MAIN = right, AUX = left).",
    },
    controls: {
      note: "Coarse tune of the played note in semitones (sums with the pitch input's V/oct); sets the resonator's fundamental.",
      envShape: "Exciter envelope shape (labeled Env): morphs the excitation from a short percussive blip (fast decay, no sustain) up through to a held, fully-sustained excitation while the gate is high — i.e. how plucked vs. bowed the voice feels.",
      bowLevel: "BOW exciter level (labeled Bow): how much continuous-friction excitation (a smooth, sustained scrape, like a bow on a string) is injected into the resonator. 0 = no bow.",
      bowTimbre: "BOW tone (labeled Bow Tmb): the brightness/character of the friction excitation — from a soft, dark bow to a scratchy, bright one. The resonator's brightness also colours it.",
      blowLevel: "BLOW exciter level (labeled Blow): how much breath/air-noise excitation (shaped by a tube model) is injected into the resonator. 0 = no blow.",
      blowMeta: "BLOW character (labeled Flow): the meta-parameter of the breath model — the granularity and turbulence of the air, from a smooth steady stream to a rough, bubbling flow.",
      blowTimbre: "BLOW tone (labeled Blow Tmb): the spectral tilt / tube colour of the breath noise — from a dark, hollow air sound to a bright, hissy one.",
      strikeLevel: "STRIKE exciter level (labeled Strike): how much percussive-impact excitation (mallet / particles / pluck) is injected into the resonator on each gate. Past unity it also bleeds extra raw impact straight into the body.",
      strikeMeta: "STRIKE character (labeled Mallet): the meta-parameter that morphs the impact model — from a soft, single mallet hit through to scattered, granular particles.",
      strikeTimbre: "STRIKE tone (labeled Strike Tmb / Strk Tmb): the hardness/brightness of the impact — from a soft, muffled thud to a sharp, bright click.",
      geometry: "Resonator geometry: reshapes the modal layout / inharmonicity of the virtual body, sweeping from a near-harmonic string toward plate-, bar-, and bell-like stretched/clustered partials.",
      brightness: "Resonator brightness: how much energy survives in the upper partials — dark and woody at low settings, bright and metallic at high settings. Also feeds the BOW timbre.",
      damping: "Resonator damping: how fast the partials lose energy — low values ring long and sustain, high values decay quickly into a short, muted body.",
      position: "Pickup position along the resonator body: combs the partials (emphasising or notching harmonics) the way moving where you pluck/listen changes a string's tone; also sets the stereo side-channel offset.",
      space: "SPACE meta-knob (0–2): one knob that sweeps the ambience. Near 0 the voice is bone-dry (and AUX carries the raw exciter); rising into the low range adds stereo SPREAD (widening MAIN/AUX); past the midpoint it crossfades in a REVERB whose tail lengthens as you go up; near the top (~1.75+) the reverb FREEZES into an infinite, self-sustaining tail.",
      strength: "Excitation strength / accent: scales how hard the exciters drive the resonator (an overall accent/intensity), from a gentle, soft voice to a hard-driven, louder one.",
    },
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    if (!loadedContexts.has(ctx)) {
      await ctx.audioWorklet.addModule(workletUrl);
      loadedContexts.add(ctx);
    }

    const workletNode = new AudioWorkletNode(ctx, 'elements', {
      numberOfInputs: 4,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
    });

    const params = workletNode.parameters as unknown as Map<string, AudioParam>;
    for (const def of elementsDef.params) {
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      params.get(def.id)?.setValueAtTime(v, ctx.currentTime);
    }

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['in',          { node: workletNode, input: 0 }],
        ['strike_in',   { node: workletNode, input: 1 }],
        ['pitch',       { node: workletNode, input: 2 }],
        ['gate',        { node: workletNode, input: 3 }],
        ['note_cv',     { node: workletNode, input: 0, param: params.get('note')! }],
        ['env_cv',      { node: workletNode, input: 0, param: params.get('envShape')! }],
        ['bowlvl_cv',   { node: workletNode, input: 0, param: params.get('bowLevel')! }],
        ['bowtim_cv',   { node: workletNode, input: 0, param: params.get('bowTimbre')! }],
        ['blowlvl_cv',  { node: workletNode, input: 0, param: params.get('blowLevel')! }],
        ['blowmeta_cv', { node: workletNode, input: 0, param: params.get('blowMeta')! }],
        ['blowtim_cv',  { node: workletNode, input: 0, param: params.get('blowTimbre')! }],
        ['strklvl_cv',  { node: workletNode, input: 0, param: params.get('strikeLevel')! }],
        ['strkmeta_cv', { node: workletNode, input: 0, param: params.get('strikeMeta')! }],
        ['strktim_cv',  { node: workletNode, input: 0, param: params.get('strikeTimbre')! }],
        ['geom_cv',     { node: workletNode, input: 0, param: params.get('geometry')! }],
        ['bright_cv',   { node: workletNode, input: 0, param: params.get('brightness')! }],
        ['damp_cv',     { node: workletNode, input: 0, param: params.get('damping')! }],
        ['pos_cv',      { node: workletNode, input: 0, param: params.get('position')! }],
        ['space_cv',    { node: workletNode, input: 0, param: params.get('space')! }],
        ['strength_cv', { node: workletNode, input: 0, param: params.get('strength')! }],
      ]),
      outputs: new Map([
        ['main', { node: workletNode, output: 0 }],
        ['aux',  { node: workletNode, output: 1 }],
      ]),
      setParam(paramId, value) { params.get(paramId)?.setValueAtTime(value, ctx.currentTime); },
      readParam(paramId) { return params.get(paramId)?.value; },
      dispose() { try { workletNode.disconnect(); } catch { /* */ } },
    };
  },
};
