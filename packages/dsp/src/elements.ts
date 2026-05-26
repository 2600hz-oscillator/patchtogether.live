// packages/dsp/src/elements.ts
//
// ELEMENTS — modal / physical-modeling voice (Mutable Instruments archetype).
//
// Clean-room TypeScript port (algorithm-level, not bit-exact) of Émilie
// Gillet's Elements DSP from the open-source `eurorack/elements/` repository.
// The source is MIT-licensed per individual file headers (Copyright 2014
// Émilie Gillet); we keep attribution here and in the audio module def at
// packages/web/src/lib/audio/modules/elements.ts. patchtogether.live is
// AGPL — MIT is compatible (we may include MIT-derived code).
//
// Reference files we mapped from:
//   eurorack/elements/dsp/exciter.{h,cc}   — BOW(FLOW)/BLOW(noise)/STRIKE
//                                            (mallet/particles/plectrum)
//                                            exciters + per-exciter SVF.
//   eurorack/elements/dsp/resonator.{h,cc} — modal filter bank: parallel SVF
//                                            bandpasses with stiffness-stretched
//                                            partials, geometry/brightness/
//                                            damping, cosine-osc pickup taps
//                                            (center + LFO-modulated sides) and
//                                            a small bowed band-pass waveguide.
//   eurorack/elements/dsp/tube.{h,cc}      — blown waveguide tube (BLOW > 1).
//   eurorack/elements/dsp/voice.{h,cc}     — top-level voice: envelope, exciter
//                                            mixing, strike-bleed, resonator
//                                            dispatch, palm-mute damping.
//   eurorack/elements/dsp/multistage_envelope.h — float ADSR envelope.
//   eurorack/elements/dsp/part.{h,cc}      — SPACE → raw/spread/reverb mixdown,
//                                            soft-limiting, stereo main/aux.
//
// FAITHFUL in this port:
//   - Exciter envelope (shape-morphing ADSR), accent/strength curve.
//   - BOW: FLOW noise generator + bow-table friction band-waveguide.
//   - BLOW: filtered noise + waveguide TUBE (when BLOW level pushed past 1).
//   - STRIKE: mallet impulse + particles + plectrum, meta-morph, strike bleed.
//   - MODAL resonator: parallel SVF bandpass bank, geometry stiffness stretch,
//     damping→Q, brightness→per-mode Q-loss, cosine-osc POSITION pickup taps,
//     stereo side channel via a slow LFO-offset second pickup.
//   - Pitch: 1V/oct → MIDI → frequency, STRENGTH accent, GATE-driven envelope.
//   - Stereo main/aux mixdown + SPACE raw-gain / spread split + SoftLimit.
//
// SIMPLIFIED (clearly documented, not faked):
//   - SPACE reverb tail uses a compact Schroeder/Dattorro-lite diffuser +
//     feedback comb network rather than MI's exact reverb topology. It tracks
//     the same SPACE → amount/time/spread/freeze mapping but is not a sample-
//     accurate reproduction of fx/reverb.h. The dry modal voice IS faithful.
//   - blow's GRANULAR_SAMPLE_PLAYER and strike's SAMPLE_PLAYER (which read MI's
//     baked PCM sample ROM) are replaced by filtered-noise / synthetic-particle
//     generators of equivalent spectral character — we have no sample ROM.
//   - STRING resonator model (Karplus-Strong) is deferred; this slice ships the
//     MODAL model only (the flagship Elements timbre).

const kSampleRateRef = 32000; // MI's native rate; used only for time constants.

// ───────────────────────── stmlib State-Variable Filter ────────────────────
// Faithful port of stmlib::Svf (Chamberlin / TPT topology). MI configures it
// with set_f_q (normalised frequency 0..0.5, Q) for the modal bank, and reads
// FILTER_MODE_BAND_PASS / _BAND_PASS_NORMALIZED.
class Svf {
  g = 0;
  r = 0;
  h = 0;
  state1 = 0;
  state2 = 0;
  init(): void {
    this.g = 0;
    this.r = 0;
    this.h = 0;
    this.state1 = 0;
    this.state2 = 0;
  }
  // f: normalised frequency (cycles/sample, 0..0.5). q: resonance/quality.
  setFQ(f: number, q: number): void {
    this.g = Math.tan(Math.PI * Math.min(f, 0.49));
    this.r = 1 / q;
    this.h = 1 / (1 + this.r * this.g + this.g * this.g);
  }
  // Mirrors set_g_q: g passed directly (already tan-warped), q is resonance.
  setGQ(g: number, q: number): void {
    this.g = g;
    this.r = 1 / q;
    this.h = 1 / (1 + this.r * this.g + this.g * this.g);
  }
  g_(): number {
    return this.g;
  }
  // FILTER_MODE_BAND_PASS
  processBandPass(input: number): number {
    const hp = (input - this.r * this.state1 - this.g * this.state1 - this.state2) * this.h;
    const bp = this.g * hp + this.state1;
    this.state1 = this.g * hp + bp;
    const lp = this.g * bp + this.state2;
    this.state2 = this.g * bp + lp;
    return bp;
  }
  // FILTER_MODE_BAND_PASS_NORMALIZED (bp * r, gives unity-ish peak gain)
  processBandPassNormalized(input: number): number {
    return this.processBandPass(input) * this.r;
  }
  // FILTER_MODE_LOW_PASS
  processLowPass(input: number): number {
    const hp = (input - this.r * this.state1 - this.g * this.state1 - this.state2) * this.h;
    const bp = this.g * hp + this.state1;
    this.state1 = this.g * hp + bp;
    const lp = this.g * bp + this.state2;
    this.state2 = this.g * bp + lp;
    return lp;
  }
}

// ─────────────────────── CosineOscillator (pickup taps) ─────────────────────
// MI's CosineOscillator (COSINE_OSCILLATOR_APPROXIMATE): a resonator that emits
// cos(n·w) iteratively. Used to weight each mode by cos(position·π·n) so the
// POSITION knob acts as a frequency-domain comb (pickup position).
class CosineOscillator {
  iir = 0;
  y1 = 0;
  y0 = 0;
  init(frequency: number): void {
    // frequency is normalised 0..0.5 (here: position·0.5).
    this.iir = 2 * Math.cos(2 * Math.PI * frequency);
  }
  start(): void {
    this.y1 = 0.5 * this.iir; // cos(w)
    this.y0 = 1.0; // cos(0)
  }
  next(): number {
    const result = this.y0;
    const temp = this.y0;
    this.y0 = this.iir * this.y0 - this.y1;
    this.y1 = temp;
    return result;
  }
}

function softLimit(x: number): number {
  return x * (27 + x * x) / (27 + 9 * x * x);
}

// ──────────────────────────── PRNG (white noise) ───────────────────────────
class Rng {
  state = 0x12345678 >>> 0;
  word(): number {
    // 32-bit LCG matching the spirit of stmlib::Random::GetWord.
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state;
  }
  // 0..1
  sample(): number {
    return this.word() / 4294967296;
  }
  // -1..1
  bipolar(): number {
    return this.sample() * 2 - 1;
  }
}

// ─────────────────────────── Multistage envelope ───────────────────────────
// Float ADSR (3-segment: attack→decay→sustain→release). MI uses LUT-driven
// increments + quartic/exp shapes; we use direct quartic/exp curves of the
// same character. `time` params are seconds-ish in 0..1 (mapped to rates).
const ENV_SHAPE_LINEAR = 0;
const ENV_SHAPE_EXPONENTIAL = 1;
const ENV_SHAPE_QUARTIC = 2;

class MultistageEnvelope {
  level = [0, 1, 0.5, 0]; // up to 4 break-points
  time = [0.5, 0.5, 0.5]; // per-segment, 0..1 (mapped to phase increments)
  shape = [ENV_SHAPE_QUARTIC, ENV_SHAPE_EXPONENTIAL, ENV_SHAPE_EXPONENTIAL];
  numSegments = 3;
  sustainPoint = 2;
  segment = 3;
  startValue = 0;
  value = 0;
  phase = 0;
  sr = 32000;

  init(sr: number): void {
    this.sr = sr;
    this.segment = this.numSegments;
    this.value = 0;
    this.startValue = 0;
    this.phase = 0;
  }

  setAdsr(a: number, d: number, s: number, r: number): void {
    this.numSegments = 3;
    this.sustainPoint = 2;
    this.level[0] = 0;
    this.level[1] = 1;
    this.level[2] = s;
    this.level[3] = 0;
    this.time[0] = a;
    this.time[1] = d;
    this.time[2] = r;
    this.shape[0] = ENV_SHAPE_QUARTIC;
    this.shape[1] = ENV_SHAPE_EXPONENTIAL;
    this.shape[2] = ENV_SHAPE_EXPONENTIAL;
  }

  // Map a 0..1 "time" param to a per-sample phase increment. MI's lut_env_increments
  // spans roughly 0.5 ms .. 8 s; we approximate with an exponential mapping.
  private phaseIncrement(t: number): number {
    const seconds = 0.001 * Math.pow(8000, Math.max(0, Math.min(1, t)));
    return 1 / Math.max(1, seconds * this.sr);
  }

  // flags bit0=rising edge, bit1=falling edge, bit2=gate.
  process(flags: number): number {
    const RISING = 1;
    const FALLING = 2;
    const GATE = 4;
    if (flags & RISING) {
      this.startValue = this.segment === this.numSegments ? this.level[0]! : this.value;
      this.segment = 0;
      this.phase = 0;
    } else if (flags & FALLING && this.sustainPoint) {
      this.startValue = this.value;
      this.segment = this.sustainPoint;
      this.phase = 0;
    } else if (this.phase >= 1) {
      this.startValue = this.level[this.segment + 1]!;
      ++this.segment;
      this.phase = 0;
    }
    const done = this.segment === this.numSegments;
    const sustained = !!this.sustainPoint && this.segment === this.sustainPoint && (flags & GATE);
    let inc = 0;
    if (!sustained && !done) inc = this.phaseIncrement(this.time[this.segment]!);
    let t = this.phase;
    const sh = this.shape[this.segment] ?? ENV_SHAPE_LINEAR;
    if (sh === ENV_SHAPE_EXPONENTIAL) t = 1 - (1 - t) * (1 - t);
    else if (sh === ENV_SHAPE_QUARTIC) t = t * t;
    this.phase += inc;
    const target = this.level[this.segment + 1] ?? 0;
    this.value = this.startValue + (target - this.startValue) * t;
    return this.value;
  }
}

// ─────────────────────────────── Exciter ───────────────────────────────────
const EXCITER_FLAG_RISING_EDGE = 1;
const EXCITER_FLAG_GATE = 4;

export const EXCITER_MODEL_MALLET = 2;
export const EXCITER_MODEL_PLECTRUM = 3;
export const EXCITER_MODEL_PARTICLES = 4;
export const EXCITER_MODEL_FLOW = 5;
export const EXCITER_MODEL_NOISE = 6;

class Exciter {
  model = EXCITER_MODEL_MALLET;
  parameter = 0;
  timbre = 0.99;
  signature = 0;
  damping = 0;
  lp = new Svf();
  dampState = 0;
  particleState = 0.5;
  particleRange = 1;
  plectrumDelay = 0;
  delay = 0;
  rng: Rng;
  sr: number;

  constructor(rng: Rng, sr: number) {
    this.rng = rng;
    this.sr = sr;
    this.lp.init();
  }

  setModel(m: number): void {
    this.model = m;
  }
  setParameter(p: number): void {
    this.parameter = p;
  }
  setTimbre(t: number): void {
    this.timbre = t;
  }
  setSignature(s: number): void {
    this.signature = s;
  }
  // meta-morph between two models (used by STRIKE: PARTICLES..NOISE region etc.)
  setMeta(meta: number, first: number, last: number): void {
    meta *= last - first + 1;
    let mi = Math.floor(meta);
    const mf = meta - mi;
    if (first + mi > EXCITER_MODEL_NOISE) mi = EXCITER_MODEL_NOISE - first;
    this.model = first + mi;
    if (this.model > EXCITER_MODEL_NOISE) this.model = EXCITER_MODEL_NOISE;
    this.parameter = mf;
  }

  // GetPulseAmplitude: MI uses lut_approx_svf_gain. We approximate the
  // compensating gain of a bandpass at a given normalised cutoff: lower cutoff
  // → higher gain so an impulse rings audibly.
  private pulseAmplitude(cutoff: number): number {
    return 1 + 4 * (1 - Math.max(0, Math.min(1, cutoff)));
  }

  process(flags: number, out: Float32Array, size: number): void {
    this.damping = 0;
    switch (this.model) {
      case EXCITER_MODEL_MALLET:
        this.processMallet(flags, out, size);
        break;
      case EXCITER_MODEL_PLECTRUM:
        this.processPlectrum(flags, out, size);
        break;
      case EXCITER_MODEL_PARTICLES:
        this.processParticles(flags, out, size);
        break;
      case EXCITER_MODEL_FLOW:
        this.processFlow(flags, out, size);
        break;
      default:
        this.processNoise(flags, out, size);
        break;
    }
    // Per-exciter lowpass / resonant SVF (timbre = cutoff, parameter = res for noise).
    if (this.model === EXCITER_MODEL_NOISE) {
      const cutoff = this.normCutoff(this.timbre);
      const q = 0.5 + this.parameter * 20;
      this.lp.setFQ(cutoff, q);
    } else {
      const cutoff = this.normCutoff(this.timbre);
      this.lp.setFQ(cutoff, 0.5);
    }
    for (let i = 0; i < size; i++) out[i] = this.lp.processLowPass(out[i]!);
  }

  // map timbre 0..1 to a musical normalised cutoff (≈20Hz .. ~SR*0.45).
  private normCutoff(t: number): number {
    const hz = 20 * Math.pow(this.sr * 0.45 / 20, Math.max(0, Math.min(1, t)));
    return Math.min(0.49, hz / this.sr);
  }

  private processMallet(flags: number, out: Float32Array, size: number): void {
    out.fill(0, 0, size);
    if (flags & EXCITER_FLAG_RISING_EDGE) {
      this.dampState = 0;
      out[0] = this.pulseAmplitude(this.timbre);
    }
    if (!(flags & EXCITER_FLAG_GATE)) {
      this.dampState = 1 - 0.95 * (1 - this.dampState);
    }
    this.damping = this.dampState * (1 - this.parameter);
  }

  private processPlectrum(flags: number, out: Float32Array, size: number): void {
    const amplitude = this.pulseAmplitude(this.timbre);
    let damp = this.dampState;
    let impulse = 0;
    if (flags & EXCITER_FLAG_RISING_EDGE) {
      impulse = -amplitude * (0.05 + this.signature * 0.2);
      this.plectrumDelay = Math.floor(4096 * this.parameter * this.parameter) + 64;
    }
    for (let i = 0; i < size; i++) {
      if (this.plectrumDelay) {
        --this.plectrumDelay;
        if (this.plectrumDelay === 0) impulse = amplitude;
        damp = 1 - 0.997 * (1 - damp);
      } else {
        damp = 0.9 * damp;
      }
      out[i] = impulse;
      impulse = 0;
    }
    this.damping = damp * 0.5;
    this.dampState = damp;
  }

  private processParticles(flags: number, out: Float32Array, size: number): void {
    if (flags & EXCITER_FLAG_RISING_EDGE) {
      let p = this.rng.sample();
      this.particleState = 1 - 0.6 * p * p;
      this.delay = 0;
      this.particleRange = 1;
    }
    out.fill(0, 0, size);
    if (flags & EXCITER_FLAG_GATE) {
      const amplitude = this.pulseAmplitude(this.timbre);
      for (let i = 0; i < size; i++) {
        if (this.delay === 0) {
          let amount = this.rng.sample();
          amount = 1.05 + 0.5 * amount * amount;
          const w = this.rng.word();
          if (w > 0.7 * 4294967296) {
            this.particleState *= amount;
            if (this.particleState >= this.particleRange + 0.25) this.particleState = this.particleRange + 0.25;
          } else if (this.rng.word() < 0.3 * 4294967296) {
            this.particleState /= amount;
            if (this.particleState <= 0.02) this.particleState = 0.02;
          }
          this.delay = Math.floor(this.particleState * 0.15 * this.sr);
          let gain = 1 - this.particleRange;
          gain *= gain;
          out[i] = this.particleState * amplitude * (1 - gain);
          const decay = 1 - this.parameter;
          this.particleRange *= 1 - decay * decay * 0.5;
        } else {
          --this.delay;
        }
      }
    }
  }

  private processFlow(flags: number, out: Float32Array, size: number): void {
    const scale = this.parameter * this.parameter * this.parameter * this.parameter;
    const threshold = 0.0001 + scale * 0.125;
    if (flags & EXCITER_FLAG_RISING_EDGE) this.particleState = 0.5;
    for (let i = 0; i < size; i++) {
      const sample = this.rng.sample();
      if (sample < threshold) this.particleState = -this.particleState;
      out[i] = this.particleState + (sample - 0.5 - this.particleState) * scale;
    }
  }

  private processNoise(_flags: number, out: Float32Array, size: number): void {
    for (let i = 0; i < size; i++) out[i] = this.rng.sample() - 0.5;
  }
}

// ───────────────────────────────── Tube ────────────────────────────────────
const kTubeDelaySize = 1024;
class Tube {
  delayLine = new Float32Array(kTubeDelaySize);
  zeroState = 0;
  poleState = 0;
  delayPtr = 0;
  process(
    frequency: number,
    envelope: number,
    damping: number,
    timbre: number,
    io: Float32Array,
    gain: number,
    size: number,
  ): void {
    let delay = 1 / frequency;
    while (delay >= kTubeDelaySize) delay *= 0.5;
    const delayIntegral = Math.floor(delay);
    const delayFractional = delay - delayIntegral;
    let env = envelope >= 1 ? 1 : envelope;
    const damp = 3.6 - damping * 1.8;
    let lpf = frequency * (1 + timbre * timbre * 256);
    if (lpf >= 0.995) lpf = 0.995;
    let d = this.delayPtr;
    for (let i = 0; i < size; i++) {
      const breath = io[i]! * damp + 0.8;
      const a = this.delayLine[(d + delayIntegral) % kTubeDelaySize]!;
      const b = this.delayLine[(d + delayIntegral + 1) % kTubeDelaySize]!;
      const inSample = a + (b - a) * delayFractional;
      const pressureDelta = -0.95 * (inSample * env + this.zeroState) - breath;
      this.zeroState = inSample;
      const reed = pressureDelta * -0.2 + 0.8;
      let out = pressureDelta * reed + breath;
      if (out < -5) out = -5;
      else if (out > 5) out = 5;
      this.delayLine[d] = out * 0.5;
      --d;
      if (d < 0) d = kTubeDelaySize - 1;
      this.poleState += lpf * (out - this.poleState);
      io[i] = io[i]! + gain * env * this.poleState;
    }
    this.delayPtr = d;
  }
}

// ─────────────────────────────── Resonator ─────────────────────────────────
const kMaxModes = 64;
const kMaxBowedModes = 8;
const kMaxDelayLineSize = 1024;

function bowTable(x: number, velocity: number): number {
  x = 0.13 * velocity - x;
  let bow = x * 6;
  bow = Math.abs(bow) + 0.75;
  bow *= bow;
  bow *= bow;
  bow = 0.25 / bow;
  if (bow < 0.0025) bow = 0.0025;
  if (bow > 0.245) bow = 0.245;
  return x * bow;
}

class BowDelayLine {
  buf = new Float32Array(kMaxDelayLineSize);
  ptr = 0;
  delay = 1;
  setDelay(d: number): void {
    this.delay = Math.max(1, Math.min(kMaxDelayLineSize - 1, d | 0));
  }
  read(): number {
    return this.buf[(this.ptr - this.delay + kMaxDelayLineSize) % kMaxDelayLineSize]!;
  }
  write(v: number): void {
    this.buf[this.ptr] = v;
    this.ptr = (this.ptr + 1) % kMaxDelayLineSize;
  }
}

export class ElementsResonator {
  f: Svf[] = [];
  fBow: Svf[] = [];
  dBow: BowDelayLine[] = [];
  frequency = 220 / kSampleRateRef;
  geometry = 0.25;
  brightness = 0.5;
  damping = 0.3;
  position = 0.999;
  previousPosition = 0;
  modulationFrequency = 0.5 / kSampleRateRef;
  modulationOffset = 0.1;
  lfoPhase = 0;
  bowSignal = 0;
  resolution = 52;

  constructor() {
    for (let i = 0; i < kMaxModes; i++) this.f.push(new Svf());
    for (let i = 0; i < kMaxBowedModes; i++) {
      this.fBow.push(new Svf());
      this.dBow.push(new BowDelayLine());
    }
  }

  init(): void {
    for (const f of this.f) f.init();
    for (const f of this.fBow) f.init();
    for (const d of this.dBow) {
      d.buf.fill(0);
      d.ptr = 0;
    }
    this.previousPosition = 0;
    this.lfoPhase = 0;
    this.bowSignal = 0;
  }

  // Interpolated stiffness mapping (MI's lut_stiffness): geometry 0..1 →
  // stiffness from slightly negative (membrane-ish) through 0 (harmonic /
  // string) to positive (inharmonic / bell-like). MI's table keeps the
  // magnitudes small so partials stay positive; we mirror that shape with a
  // gentle piecewise curve. (Bit-exact reproduction would need MI's baked
  // 256-entry lut_stiffness ROM.)
  private stiffnessForGeometry(g: number): number {
    if (g < 0.25) return -0.07 + g * 0.28; // -0.07 .. 0   (near-harmonic membrane)
    if (g < 0.3) return 0; // harmonic plateau (string)
    if (g < 0.9) return (g - 0.3) * 0.12; // 0 .. ~0.072  (gentle stretch)
    return 0.072 + (g - 0.9) * 2.0; // bell / clangorous
  }

  private computeFilters(): number {
    const stiffnessBase = this.stiffnessForGeometry(this.geometry);
    let stiffness = stiffnessBase;
    let harmonic = this.frequency;
    let stretchFactor = 1;
    // damping 0..1 → Q across ~4 decades (MI: 500 * lut_4_decades(damping*0.8)).
    // lut_4_decades maps low input → high value, so LOW damping = high Q =
    // long ring-out; HIGH damping = low Q = fast decay.
    const q = 500 * Math.pow(10, -4 * this.damping * 0.8);
    let brightnessAttenuation = 1 - this.geometry;
    brightnessAttenuation *= brightnessAttenuation;
    brightnessAttenuation *= brightnessAttenuation;
    brightnessAttenuation *= brightnessAttenuation;
    const brightness = this.brightness * (1 - 0.2 * brightnessAttenuation);
    let qLoss = brightness * (2 - brightness) * 0.85 + 0.15;
    const qLossDampingRate = this.geometry * (2 - this.geometry) * 0.1;
    let numModes = 0;
    let qCurrent = q;
    const max = Math.min(kMaxModes, this.resolution);
    for (let i = 0; i < max; i++) {
      let partialFrequency = harmonic * stretchFactor;
      // Guard against folded-back / non-physical negative frequencies (can
      // happen at the extreme inharmonic end). MI's FREQUENCY_FAST tan-approx
      // is implicitly bounded; we clamp explicitly.
      if (partialFrequency < this.frequency) partialFrequency = this.frequency;
      if (partialFrequency >= 0.49) {
        partialFrequency = 0.49;
      } else {
        numModes = i + 1;
      }
      this.f[i]!.setFQ(partialFrequency, 1 + partialFrequency * qCurrent);
      if (i < kMaxBowedModes) {
        let period = Math.floor(1 / partialFrequency);
        while (period >= kMaxDelayLineSize) period >>= 1;
        this.dBow[i]!.setDelay(period);
        this.fBow[i]!.setGQ(this.f[i]!.g_(), 1 + partialFrequency * 1500);
      }
      stretchFactor += stiffness;
      if (stiffness < 0) stiffness *= 0.93;
      else stiffness *= 0.98;
      qLoss += qLossDampingRate * (1 - qLoss);
      harmonic += this.frequency;
      qCurrent *= qLoss;
    }
    return numModes;
  }

  // bowStrength: per-sample bow velocity (already e*bow_level). in: excitation.
  // Writes center + sides (stereo pair, pre-mixdown).
  process(
    bowStrength: Float32Array,
    inBuf: Float32Array,
    center: Float32Array,
    sides: Float32Array,
    size: number,
  ): void {
    const numModes = this.computeFilters();
    const numBandedWg = Math.min(kMaxBowedModes, numModes);
    const positionIncrement = (this.position - this.previousPosition) / size;
    for (let n = 0; n < size; n++) {
      this.lfoPhase += this.modulationFrequency;
      if (this.lfoPhase >= 1) this.lfoPhase -= 1;
      this.previousPosition += positionIncrement;
      const lfo = this.lfoPhase > 0.5 ? 1 - this.lfoPhase : this.lfoPhase;
      const amplitudes = new CosineOscillator();
      const auxAmplitudes = new CosineOscillator();
      amplitudes.init(this.previousPosition * 0.5);
      auxAmplitudes.init((this.modulationOffset + lfo) * 0.5);

      let input = inBuf[n]! * 0.125;
      let sumCenter = 0;
      let sumSide = 0;
      amplitudes.start();
      auxAmplitudes.start();
      for (let i = 0; i < numModes; i++) {
        const s = this.f[i]!.processBandPass(input);
        sumCenter += s * amplitudes.next();
        sumSide += s * auxAmplitudes.next();
      }
      sides[n] = sumSide - sumCenter;

      // Bowed modes (band-waveguide friction).
      let bowSignal = 0;
      input += this.bowSignal;
      amplitudes.start();
      for (let i = 0; i < numBandedWg; i++) {
        let s = 0.99 * this.dBow[i]!.read();
        bowSignal += s;
        s = this.fBow[i]!.processBandPassNormalized(input + s);
        this.dBow[i]!.write(s);
        sumCenter += s * amplitudes.next() * 8;
      }
      this.bowSignal = bowTable(bowSignal, bowStrength[n]!);
      center[n] = sumCenter;
    }
  }
}

// ──────────────────────────── Simplified diffuser ──────────────────────────
// A short all-pass chain standing in for MI's blow diffuser (voice.cc).
class Diffuser {
  private buffers: Float32Array[];
  private ptrs: number[];
  private delays = [142, 107, 379, 277];
  private gain = 0.625;
  constructor() {
    this.buffers = this.delays.map((d) => new Float32Array(d));
    this.ptrs = this.delays.map(() => 0);
  }
  process(io: Float32Array, size: number): void {
    for (let n = 0; n < size; n++) {
      let x = io[n]!;
      for (let k = 0; k < this.buffers.length; k++) {
        const buf = this.buffers[k]!;
        const p = this.ptrs[k]!;
        const delayed = buf[p]!;
        const v = x - this.gain * delayed;
        buf[p] = v;
        x = delayed + this.gain * v;
        this.ptrs[k] = (p + 1) % buf.length;
      }
      io[n] = x;
    }
  }
}

// ────────────────────── Simplified SPACE reverb (documented) ────────────────
// NOT a port of fx/reverb.h. A compact FDN-lite: 4 feedback combs into 2
// allpasses, stereo-spread. Tracks SPACE → amount / time / freeze the same way
// part.cc does, but is its own topology.
class SpaceReverb {
  private comb: Float32Array[];
  private combPtr: number[];
  private combLp: number[];
  private apL = new Float32Array(225);
  private apR = new Float32Array(341);
  private apLptr = 0;
  private apRptr = 0;
  private combLens = [1116, 1188, 1277, 1356];
  amount = 0;
  time = 0.5;
  lp = 0.7;
  inputGain = 0.2;
  freeze = false;
  constructor() {
    this.comb = this.combLens.map((l) => new Float32Array(l));
    this.combPtr = this.combLens.map(() => 0);
    this.combLp = this.combLens.map(() => 0);
  }
  process(main: Float32Array, aux: Float32Array, size: number): void {
    if (this.amount <= 0) return;
    const fb = this.freeze ? 1.0 : 0.7 + 0.28 * this.time;
    const damp = 1 - this.lp;
    for (let n = 0; n < size; n++) {
      const inMix = (main[n]! + aux[n]!) * 0.5 * (this.freeze ? 0 : this.inputGain);
      let acc = 0;
      for (let k = 0; k < this.comb.length; k++) {
        const buf = this.comb[k]!;
        const p = this.combPtr[k]!;
        const y = buf[p]!;
        this.combLp[k] = y * (1 - damp) + this.combLp[k]! * damp;
        buf[p] = inMix + this.combLp[k]! * fb;
        this.combPtr[k] = (p + 1) % buf.length;
        acc += y;
      }
      acc *= 0.25;
      // 2 allpasses for diffusion + stereo decorrelation.
      let l = acc;
      const dl = this.apL[this.apLptr]!;
      const vl = l - 0.5 * dl;
      this.apL[this.apLptr] = vl;
      l = dl + 0.5 * vl;
      this.apLptr = (this.apLptr + 1) % this.apL.length;
      let r = acc;
      const dr = this.apR[this.apRptr]!;
      const vr = r - 0.5 * dr;
      this.apR[this.apRptr] = vr;
      r = dr + 0.5 * vr;
      this.apRptr = (this.apRptr + 1) % this.apR.length;
      main[n] = main[n]! + (l - main[n]!) * this.amount;
      aux[n] = aux[n]! + (r - aux[n]!) * this.amount;
    }
  }
}

// ──────────────────────────────── Patch ────────────────────────────────────
export interface ElementsPatch {
  exciterEnvelopeShape: number; // 0..1
  exciterBowLevel: number;
  exciterBowTimbre: number;
  exciterBlowLevel: number;
  exciterBlowMeta: number;
  exciterBlowTimbre: number;
  exciterStrikeLevel: number;
  exciterStrikeMeta: number;
  exciterStrikeTimbre: number;
  resonatorGeometry: number;
  resonatorBrightness: number;
  resonatorDamping: number;
  resonatorPosition: number;
  space: number;
}

export function defaultPatch(): ElementsPatch {
  return {
    exciterEnvelopeShape: 1.0,
    exciterBowLevel: 0.0,
    exciterBowTimbre: 0.5,
    exciterBlowLevel: 0.0,
    exciterBlowMeta: 0.5,
    exciterBlowTimbre: 0.5,
    exciterStrikeLevel: 0.8,
    exciterStrikeMeta: 0.5,
    exciterStrikeTimbre: 0.5,
    resonatorGeometry: 0.2,
    resonatorBrightness: 0.5,
    resonatorDamping: 0.25,
    resonatorPosition: 0.3,
    space: 0.3,
  };
}

// ──────────────────────────────── Voice ────────────────────────────────────
export class ElementsVoice {
  private rng = new Rng();
  private envelope = new MultistageEnvelope();
  private bow: Exciter;
  private blow: Exciter;
  private strike: Exciter;
  private tube = new Tube();
  private resonator = new ElementsResonator();
  private diffuser = new Diffuser();

  private bowBuf: Float32Array;
  private blowBuf: Float32Array;
  private strikeBuf: Float32Array;
  private bowStrengthBuf: Float32Array;

  private previousGate = false;
  private strength = 0;
  private exciterLevel = 0;
  private envelopeValue = 0;
  private sr: number;

  constructor(sr: number, maxBlock: number) {
    this.sr = sr;
    this.bow = new Exciter(this.rng, sr);
    this.blow = new Exciter(this.rng, sr);
    this.strike = new Exciter(this.rng, sr);
    this.bow.setModel(EXCITER_MODEL_FLOW);
    this.bow.setParameter(0.7);
    this.bow.setTimbre(0.5);
    this.blow.setModel(EXCITER_MODEL_NOISE);
    this.envelope.init(sr);
    this.envelope.setAdsr(0.5, 0.5, 0.5, 0.5);
    this.resonator.init();
    this.resonator.resolution = 52;
    this.bowBuf = new Float32Array(maxBlock);
    this.blowBuf = new Float32Array(maxBlock);
    this.strikeBuf = new Float32Array(maxBlock);
    this.bowStrengthBuf = new Float32Array(maxBlock);
  }

  reset(): void {
    this.envelope.init(this.sr);
    this.resonator.init();
    this.previousGate = false;
    this.strength = 0;
    this.exciterLevel = 0;
    this.envelopeValue = 0;
  }

  getExciterLevel(): number {
    return this.exciterLevel;
  }

  private gateFlags(gate: boolean): number {
    let f = 0;
    if (gate) f |= EXCITER_FLAG_GATE;
    if (gate && !this.previousGate) f |= EXCITER_FLAG_RISING_EDGE;
    if (!gate && this.previousGate) f |= 2; // falling edge
    this.previousGate = gate;
    return f;
  }

  // frequency: normalised (cycles/sample). strength: 0..1 accent.
  process(
    patch: ElementsPatch,
    frequency: number,
    strength: number,
    gate: boolean,
    blowIn: Float32Array | null,
    strikeIn: Float32Array | null,
    center: Float32Array,
    sides: Float32Array,
    size: number,
  ): void {
    const flags = this.gateFlags(gate);

    // Envelope (shape-morphing ADSR).
    let envelopeGain = 1;
    const shape = patch.exciterEnvelopeShape;
    if (shape < 0.4) {
      const a = shape * 0.75 + 0.15;
      const dr = a * 1.8;
      this.envelope.setAdsr(a, dr, 0, dr);
      envelopeGain = 5 - shape * 10;
    } else if (shape < 0.6) {
      const s = (shape - 0.4) * 5;
      this.envelope.setAdsr(0.45, 0.81, s, 0.81);
    } else {
      const a = (1 - shape) * 0.75 + 0.15;
      const dr = a * 1.8;
      this.envelope.setAdsr(a, dr, 1, dr);
    }
    const envelopeValue = this.envelope.process(flags) * envelopeGain;
    const envelopeIncrement = (envelopeValue - this.envelopeValue) / size;

    // Configure exciters.
    const brightnessFactor = 0.4 + 0.6 * patch.resonatorBrightness;
    this.bow.setTimbre(patch.exciterBowTimbre * brightnessFactor);
    this.blow.setParameter(patch.exciterBlowMeta);
    this.blow.setTimbre(patch.exciterBlowTimbre);
    const strikeMeta = patch.exciterStrikeMeta;
    this.strike.setMeta(
      strikeMeta <= 0.4 ? strikeMeta * 0.625 : strikeMeta * 1.25 - 0.25,
      EXCITER_MODEL_MALLET,
      EXCITER_MODEL_PARTICLES,
    );
    this.strike.setTimbre(patch.exciterStrikeTimbre);

    this.bow.process(flags, this.bowBuf, size);

    let blowLevel = patch.exciterBlowLevel * 1.5;
    const tubeLevel = blowLevel > 1 ? (blowLevel - 1) * 2 : 0;
    blowLevel = blowLevel < 1 ? blowLevel * 0.4 : 0.4;
    this.blow.process(flags, this.blowBuf, size);
    this.tube.process(
      frequency,
      envelopeValue,
      patch.resonatorDamping,
      tubeLevel,
      this.blowBuf,
      tubeLevel * 0.5,
      size,
    );
    for (let i = 0; i < size; i++) {
      this.blowBuf[i] = this.blowBuf[i]! * blowLevel + (blowIn ? blowIn[i]! : 0);
    }
    this.diffuser.process(this.blowBuf, size);
    this.strike.process(flags, this.strikeBuf, size);

    let strikeLevel = patch.exciterStrikeLevel * 1.25;
    const strikeBleed = strikeLevel > 1 ? (strikeLevel - 1) * 2 : 0;
    strikeLevel = strikeLevel < 1 ? strikeLevel : 1;
    strikeLevel *= 1.5;

    // Strength accent (256-scaled to match MI's accent LUT domain). We use a
    // smooth accent curve instead of the baked LUT.
    const strengthTarget = strength;
    const strengthIncrement = (strengthTarget - this.strength) / size;

    const raw = this.blowBuf; // reuse buffer family; build raw in a temp.
    // Use a dedicated raw accumulation to avoid clobbering blow before summed.
    // (blowBuf already holds the post-diffuser blow signal — used below.)

    // Sum all sources of excitation into a raw buffer.
    const rawBuf = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      this.strength += strengthIncrement;
      this.envelopeValue += envelopeIncrement;
      let e = this.envelopeValue;
      const accent = 0.25 + 0.75 * this.strength; // accent gain 0.25..1
      this.bowStrengthBuf[i] = e * patch.exciterBowLevel;
      this.strikeBuf[i] = this.strikeBuf[i]! * accent;
      e *= accent;
      let input = 0;
      input += this.bowBuf[i]! * this.bowStrengthBuf[i]! * 0.125 * accent;
      input += raw[i]! * e; // raw === blowBuf (post-diffuser blow signal)
      input += this.strikeBuf[i]! * strikeLevel;
      input += strikeIn ? strikeIn[i]! : 0;
      rawBuf[i] = input * 0.5;
    }

    // Exciter meter.
    for (let i = 0; i < size; i++) {
      const error = rawBuf[i]! * rawBuf[i]! - this.exciterLevel;
      this.exciterLevel += error * (error > 0 ? 0.5 : 0.001);
    }

    // Palm-mute damping from strike/bow on release.
    let damping = patch.resonatorDamping;
    damping -= this.strike.damping * strikeLevel * 0.125;
    damping -= (1 - this.bowStrengthBuf[0]!) * patch.exciterBowLevel * 0.0625;
    if (damping <= 0) damping = 0;

    // Configure + run modal resonator.
    this.resonator.frequency = frequency;
    this.resonator.geometry = patch.resonatorGeometry;
    this.resonator.brightness = patch.resonatorBrightness;
    this.resonator.position = patch.resonatorPosition;
    this.resonator.damping = damping;
    this.resonator.process(this.bowStrengthBuf, rawBuf, center, sides, size);

    // Raw mallet bleed-through.
    for (let i = 0; i < size; i++) {
      center[i] = center[i]! + strikeBleed * this.strikeBuf[i]!;
    }
  }
}

// ──────────────────────────────── Part ─────────────────────────────────────
// Top-level: SPACE-driven raw/spread/reverb mixdown into stereo main/aux.
export class ElementsPart {
  private voice: ElementsVoice;
  private reverb = new SpaceReverb();
  private rawBuffer: Float32Array;
  private centerBuffer: Float32Array;
  private sidesBuffer: Float32Array;
  private resonatorLevel = 0;
  sr: number;

  constructor(sr: number, maxBlock: number) {
    this.sr = sr;
    this.voice = new ElementsVoice(sr, maxBlock);
    this.rawBuffer = new Float32Array(maxBlock);
    this.centerBuffer = new Float32Array(maxBlock);
    this.sidesBuffer = new Float32Array(maxBlock);
  }

  reset(): void {
    this.voice.reset();
    this.resonatorLevel = 0;
  }

  process(
    patch: ElementsPatch,
    note: number, // MIDI note + V/oct (in semitones, A4 = 69)
    modulation: number, // additional semitones
    strength: number,
    gate: boolean,
    blowIn: Float32Array | null,
    strikeIn: Float32Array | null,
    main: Float32Array,
    aux: Float32Array,
    size: number,
  ): void {
    main.fill(0, 0, size);
    aux.fill(0, 0, size);

    // SPACE meta-parameter → raw_gain / spread / reverb (part.cc).
    let space = patch.space >= 1 ? 1 : patch.space;
    const rawGain = space <= 0.05 ? 1 : space <= 0.1 ? 2 - space * 20 : 0;
    space = space >= 0.1 ? space - 0.1 : 0;
    const spread = space <= 0.7 ? space : 0.7;
    const reverbAmount = space >= 0.5 ? space - 0.5 : 0;
    const reverbTime = 0.35 + 1.2 * reverbAmount;

    // MIDI pitch → normalised frequency.
    const midiPitch = note + modulation;
    let freq = (440 * Math.pow(2, (midiPitch - 69) / 12)) / this.sr;
    if (freq < 0.0001) freq = 0.0001;
    if (freq > 0.49) freq = 0.49;

    this.voice.process(
      patch,
      freq,
      strength,
      gate,
      blowIn,
      strikeIn,
      this.centerBuffer,
      this.sidesBuffer,
      size,
    );

    for (let j = 0; j < size; j++) {
      const side = this.sidesBuffer[j]! * spread;
      const r = this.centerBuffer[j]! - side;
      const l = this.centerBuffer[j]! + side;
      main[j] = r;
      aux[j] = l + (this.rawBuffer[j]! - l) * rawGain;
    }

    // Pre-clip soft-limit.
    for (let i = 0; i < size; i++) {
      main[i] = softLimit(main[i]!);
      aux[i] = softLimit(aux[i]!);
    }

    // Resonator meter (panic guard).
    let level = this.resonatorLevel;
    for (let i = 0; i < size; i++) {
      const error = main[i]! * main[i]! - level;
      level += error * (error > 0 ? 0.05 : 0.0005);
    }
    this.resonatorLevel = level;
    if (level >= 200) {
      this.reset();
    }

    // SPACE reverb (simplified).
    this.reverb.amount = reverbAmount;
    this.reverb.time = reverbTime;
    const freeze = patch.space >= 1.75;
    this.reverb.freeze = freeze;
    this.reverb.lp = freeze ? 1 : 0.7;
    this.reverb.inputGain = freeze ? 0 : 0.2;
    this.reverb.process(main, aux, size);
  }
}

// ───────────────────────────── AudioWorklet ────────────────────────────────
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  constructor(options?: unknown);
  readonly port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare function registerProcessor(name: string, ctor: new (options?: unknown) => AudioWorkletProcessor): void;

class ElementsProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'note',          defaultValue: 0,    minValue: -60, maxValue: 60, automationRate: 'k-rate' as const },
      { name: 'envShape',      defaultValue: 1,    minValue: 0,   maxValue: 1,  automationRate: 'k-rate' as const },
      { name: 'bowLevel',      defaultValue: 0,    minValue: 0,   maxValue: 1,  automationRate: 'k-rate' as const },
      { name: 'bowTimbre',     defaultValue: 0.5,  minValue: 0,   maxValue: 1,  automationRate: 'k-rate' as const },
      { name: 'blowLevel',     defaultValue: 0,    minValue: 0,   maxValue: 1,  automationRate: 'k-rate' as const },
      { name: 'blowMeta',      defaultValue: 0.5,  minValue: 0,   maxValue: 1,  automationRate: 'k-rate' as const },
      { name: 'blowTimbre',    defaultValue: 0.5,  minValue: 0,   maxValue: 1,  automationRate: 'k-rate' as const },
      { name: 'strikeLevel',   defaultValue: 0.8,  minValue: 0,   maxValue: 1,  automationRate: 'k-rate' as const },
      { name: 'strikeMeta',    defaultValue: 0.5,  minValue: 0,   maxValue: 1,  automationRate: 'k-rate' as const },
      { name: 'strikeTimbre',  defaultValue: 0.5,  minValue: 0,   maxValue: 1,  automationRate: 'k-rate' as const },
      { name: 'geometry',      defaultValue: 0.2,  minValue: 0,   maxValue: 1,  automationRate: 'k-rate' as const },
      { name: 'brightness',    defaultValue: 0.5,  minValue: 0,   maxValue: 1,  automationRate: 'k-rate' as const },
      { name: 'damping',       defaultValue: 0.25, minValue: 0,   maxValue: 1,  automationRate: 'k-rate' as const },
      { name: 'position',      defaultValue: 0.3,  minValue: 0,   maxValue: 1,  automationRate: 'k-rate' as const },
      { name: 'space',         defaultValue: 0.3,  minValue: 0,   maxValue: 2,  automationRate: 'k-rate' as const },
      { name: 'strength',      defaultValue: 0.5,  minValue: 0,   maxValue: 1,  automationRate: 'k-rate' as const },
    ];
  }

  private part: ElementsPart;

  constructor(options?: unknown) {
    super(options);
    this.part = new ElementsPart(sampleRate, 128);
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const main = outputs[0]?.[0];
    const aux = outputs[1]?.[0];
    if (!main || !aux) return true;
    const size = main.length;

    const blowIn = inputs[0]?.[0] ?? null; // external excitation / audio in
    const strikeIn = inputs[1]?.[0] ?? null;
    const pitchIn = inputs[2]?.[0] ?? null; // V/oct
    const gateIn = inputs[3]?.[0] ?? null;

    const p = (name: string): number => parameters[name]?.[0] ?? 0;

    // Pitch: A4=69 base + V/oct (12 semis/V) + note offset.
    const pitchV = pitchIn ? pitchIn[0]! : 0;
    const note = 69 + pitchV * 12;
    const modulation = p('note');
    const gate = gateIn ? gateIn[0]! >= 0.5 : false;

    const patch: ElementsPatch = {
      exciterEnvelopeShape: p('envShape'),
      exciterBowLevel: p('bowLevel'),
      exciterBowTimbre: p('bowTimbre'),
      exciterBlowLevel: p('blowLevel'),
      exciterBlowMeta: p('blowMeta'),
      exciterBlowTimbre: p('blowTimbre'),
      exciterStrikeLevel: p('strikeLevel'),
      exciterStrikeMeta: p('strikeMeta'),
      exciterStrikeTimbre: p('strikeTimbre'),
      resonatorGeometry: p('geometry'),
      resonatorBrightness: p('brightness'),
      resonatorDamping: p('damping'),
      resonatorPosition: p('position'),
      space: p('space'),
    };

    this.part.process(
      patch,
      note,
      modulation,
      p('strength'),
      gate,
      blowIn,
      strikeIn,
      main,
      aux,
      size,
    );
    return true;
  }
}

registerProcessor('elements', ElementsProcessor);
