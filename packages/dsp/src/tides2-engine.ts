// packages/dsp/src/tides2-engine.ts
//
// TIDES2 — tidal modulator / poly-slope generator (Mutable Instruments
// Tides 2018 archetype, Émilie Gillet, MIT-licensed). Clean-room TypeScript
// interpretation of eurorack/tides2: poly_slope_generator.{h,cc},
// ramp_generator.h, ramp_shaper.h, ramp/ramp_extractor.{h,cc}.
//
// Imported by BOTH the AudioWorklet wrapper (packages/dsp/src/tides2.ts)
// AND the host-side module def + vitest pass (packages/web/src/lib/audio/
// modules/tides2-engine.ts — a byte-identical mirror) so the math is the
// same on both surfaces. Keep this file FREE of AudioWorkletGlobalScope
// references (no `sampleRate`, no `registerProcessor`) — the worklet wrapper
// passes the sample rate explicitly to the constructor.
//
// IF YOU EDIT THIS FILE, also edit the web-side mirror at
// packages/web/src/lib/audio/modules/tides2-engine.ts.
//
// -----------------------------------------------------------------------------
// FIDELITY NOTES (read before changing the DSP)
//
// num_channels = 4: Tides has FOUR related slope outputs. The four output
// modes are exactly MI's OutputMode enum:
//   GATES (0)      — out0=main slope*shift, out1=unipolar/bipolar variant,
//                    out2=EOA (end-of-attack) pulse, out3=EOR (end-of-rise).
//   AMPLITUDE (1)  — the four outs are amplitude-stepped copies of the main
//                    slope: a triangular gain window sweeps across the four
//                    channels as SHIFT moves, so SHIFT acts as a 4-way pan.
//   SLOPE/PHASE(2) — the four outs are progressively phase-shifted (CONTROL)
//                    copies of the same waveform; SHIFT sets the phase spread.
//   FREQUENCY (3)  — the four outs run at quantized frequency RATIOS of the
//                    master (1, 2, 3, ... harmonic/subharmonic series chosen
//                    by SHIFT), i.e. frequency-divided / multiplied.
//
// The MI firmware drives shape morphing through a 16 KiB int16 wavetable
// (`lut_wavetable`) with 6 "phasor" shapes and 4 "envelope" shapes. We do
// NOT ship that binary table; instead `shapeMorph()` reproduces the same
// perceptual morph procedurally (sine → triangle → ramp-ish → expo) — see
// its docstring. This is the one intentional deviation from bit-exactness.
//
// The ramp extractor (external-clock PLL) is ported as a moving-average
// period predictor (RampExtractor::ProcessInternal's averaging branch). The
// rhythmic-pattern + constant-pulse-width predictors from the original are
// summarized into the moving average; documented as a simplification.

// ---------------------------------------------------------------------------
// Enums — kept in sync with the module def + card.
// ---------------------------------------------------------------------------

export const TIDES2_NUM_CHANNELS = 4;

// RampMode — eurorack/tides2/ramp_generator.h enum RampMode.
export const RAMP_MODE_AD = 0;
export const RAMP_MODE_LOOPING = 1;
export const RAMP_MODE_AR = 2;
export const RAMP_MODE_LAST = 3;

// OutputMode — enum OutputMode.
export const OUTPUT_MODE_GATES = 0;
export const OUTPUT_MODE_AMPLITUDE = 1;
export const OUTPUT_MODE_SLOPE_PHASE = 2;
export const OUTPUT_MODE_FREQUENCY = 3;
export const OUTPUT_MODE_LAST = 4;

// Range — enum Range.
export const RANGE_CONTROL = 0;
export const RANGE_AUDIO = 1;
export const RANGE_LAST = 2;

export const TIDES2_RAMP_MODE_NAMES = ['AD', 'LOOP', 'AR'] as const;
export const TIDES2_OUTPUT_MODE_NAMES = ['GATES', 'AMP', 'PHASE', 'FREQ'] as const;
export const TIDES2_RANGE_NAMES = ['LFO', 'AUDIO', 'TEMPO'] as const;

export const TRIG_THRESHOLD = 0.5;

// Frequency-divider ratios indexed by a 21-entry quantizer (SHIFT). Matches
// the spirit of tides2's audio_ratio_table_ / control_ratio_table_: the
// center index is unison, indices below are sub-harmonics, above are
// harmonics. Per-channel within a ratio entry the four outs are
// {ratio, ratio, ratio, ratio} multiplied by the simple integer multiples
// 1..4 of the base. We expose the simple "first 4 of the series" mapping.
export const RATIO_SEQUENCE: ReadonlyArray<number> = [
  1 / 8, 1 / 7, 1 / 6, 1 / 5, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 4 / 5,
  1, 5 / 4, 4 / 3, 3 / 2, 2, 3, 4, 5, 6, 7, 8,
];

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Map FREQUENCY knob [0,1] + V/oct (octaves) to a normalized frequency
 *  (cycles per sample fraction, i.e. phase increment). RANGE_CONTROL is an
 *  LFO band (≈0.001 Hz-ish .. a few Hz); RANGE_AUDIO reaches audio rates.
 *  Faithful to MI's "frequency_" being a per-sample phase increment clamped
 *  to 0.25 (Nyquist/2 with headroom). */
export function freqKnobToIncrement(
  knob: number,
  voctOctaves: number,
  range: number,
  sampleRate: number,
): number {
  const k = clamp(knob, 0, 1);
  // Base Hz at knob center, per range.
  // CONTROL: ~0.03 Hz .. ~30 Hz (LFO/envelope band).
  // AUDIO:   ~8 Hz .. ~8 kHz.
  let baseHz: number;
  if (range === RANGE_AUDIO) {
    baseHz = 8 * Math.pow(1000, k); // 8 .. 8000 Hz
  } else {
    baseHz = 0.03 * Math.pow(1000, k); // 0.03 .. 30 Hz
  }
  const hz = baseHz * Math.pow(2, voctOctaves);
  return clamp(hz / sampleRate, 0, 0.25);
}

/**
 * Procedural replacement for MI's `lut_wavetable` shape morph.
 *
 * Input `phase` is the post-slope unipolar ramp value in [0,1]. `shape` is a
 * morph position in [0, nShapes]: integer part selects a base wave, fractional
 * part crossfades to the next. We morph through a perceptual bank:
 *   0: linear ramp (identity)
 *   1: raised-cosine S-curve (sine-like attack/decay)
 *   2: triangle (folded ramp)
 *   3: exponential-ish (squared)
 *   4: logarithmic-ish (sqrt)
 *   5: steep expo (cubed)
 * The integer index is clamped; the fractional crossfade reproduces the
 * smooth wavetable scan of the original.
 */
export function shapeMorph(phase: number, shape: number): number {
  const p = clamp(phase, 0, 1);
  const tables = SHAPE_TABLE_FNS;
  const maxIdx = tables.length - 1;
  let s = clamp(shape, 0, maxIdx);
  const i0 = Math.floor(s);
  const frac = s - i0;
  const i1 = Math.min(i0 + 1, maxIdx);
  const y0 = tables[i0]!(p);
  const y1 = tables[i1]!(p);
  return y0 + (y1 - y0) * frac;
}

const SHAPE_TABLE_FNS: ReadonlyArray<(p: number) => number> = [
  (p) => p, // linear ramp
  (p) => 0.5 - 0.5 * Math.cos(Math.PI * p), // raised cosine S
  (p) => (p < 0.5 ? 2 * p : 2 - 2 * p), // triangle
  (p) => p * p, // expo-ish
  (p) => Math.sqrt(p), // log-ish
  (p) => p * p * p, // steep expo
];

/**
 * Wavefolder (MI PolySlopeGenerator::Fold). `unipolar` in [0,1], `foldAmount`
 * in [0,1]. AR/AD use a unipolar fold; LOOPING uses a bipolar fold. We
 * reproduce the perceptual shape with sin-based folding instead of the LUTs.
 */
export function fold(unipolar: number, foldAmount: number, loopMode: boolean): number {
  if (loopMode) {
    const bipolar = 2 * unipolar - 1;
    if (foldAmount <= 0) return bipolar;
    const drive = 1 + foldAmount * 6;
    const folded = Math.sin(bipolar * drive * Math.PI * 0.5);
    return bipolar + (folded - bipolar) * foldAmount;
  } else {
    if (foldAmount <= 0) return unipolar;
    const drive = 1 + foldAmount * 6;
    const folded = 0.5 + 0.5 * Math.sin((unipolar - 0.5) * drive * Math.PI);
    return unipolar + (folded - unipolar) * foldAmount;
  }
}

// ---------------------------------------------------------------------------
// RampShaper — eurorack/tides2/ramp_shaper.h. Converts a phase counter into
// a variable-slope waveform plus EOA/EOR pulses. We use the non-band-limited
// SkewedRamp form (the BLEP path is an anti-aliasing nicety for the audio
// range; the perceptual slope is identical and our oversampling-free worklet
// doesn't need the BLEP correction at LFO rates).
// ---------------------------------------------------------------------------

export class RampShaper {
  /** SkewedRamp: unipolar ramp with a pulse-width "break" at pw. */
  skewedRamp(phase: number, phaseShift: number, pw: number): number {
    let ph = phase + phaseShift;
    if (ph >= 1) ph -= 1;
    else if (ph < 0) ph += 1;
    const w = clamp(pw, 0.001, 0.999);
    const slopeUp = 0.5 / w;
    const slopeDown = 0.5 / (1 - w);
    return ph < w ? ph * slopeUp : (ph - w) * slopeDown + 0.5;
  }

  /** AR mode: phase is already the shaped trapezoid value. */
  slope(rampMode: number, phase: number, phaseShift: number, pw: number): number {
    if (rampMode === RAMP_MODE_AR) return clamp(phase, 0, 1);
    return this.skewedRamp(phase, phaseShift, pw);
  }

  /** EOA — end-of-attack pulse. */
  eoa(rampMode: number, phase: number, pw: number): number {
    if (rampMode === RAMP_MODE_AR) return phase >= 0.5 ? 1 : 0;
    return phase >= pw ? 1 : 0;
  }

  /** EOR — end-of-rise / cycle-complete pulse. */
  eor(rampMode: number, phase: number, frequency: number): number {
    if (rampMode === RAMP_MODE_LOOPING) {
      const pw = Math.min(0.5, 96 * frequency);
      return phase < pw ? 1 : 0;
    }
    return phase >= 1 ? 1 : 0;
  }
}

// ---------------------------------------------------------------------------
// RampWaveshaper — applies the shape morph. AR mode has the breakpoint logic
// from ramp_shaper.h::RampWaveshaper::Shape (so the trapezoid doesn't jump
// at the attack→release transition).
// ---------------------------------------------------------------------------

export class RampWaveshaper {
  private previousInput = 0;
  private previousOutput = 0;
  private breakpoint = 0;

  init(): void {
    this.previousInput = 0;
    this.previousOutput = 0;
    this.breakpoint = 0;
  }

  shape(rampMode: number, input: number, shapeMorphPos: number): number {
    let output = shapeMorph(input, shapeMorphPos);
    if (rampMode !== RAMP_MODE_AR) return output;

    if (this.previousInput <= 0.5 && input > 0.5) {
      this.breakpoint = this.previousOutput;
    } else if (this.previousInput > 0.5 && input < 0.5) {
      this.breakpoint = this.previousOutput;
    } else if (input === 1.0) {
      this.breakpoint = 1.0;
    } else if (input === 0.5) {
      this.breakpoint = 0.0;
    }
    if (input <= 0.5) {
      output = this.breakpoint + (1 - this.breakpoint) * output;
    } else {
      output = this.breakpoint * output;
    }
    this.previousInput = input;
    this.previousOutput = output;
    return output;
  }
}

// ---------------------------------------------------------------------------
// RampGenerator — eurorack/tides2/ramp_generator.h. Holds the master phase
// and per-channel phases. Each tick advances the phase(s) per the ramp mode.
// ---------------------------------------------------------------------------

export class RampGenerator {
  masterPhase = 0;
  phase: Float32Array;
  frequency: Float32Array;
  wrapCounter: Int32Array;
  ratio: Float32Array; // per-channel ratio multiplier
  ratioQ: Int32Array; // quantization period q for each channel
  nextRatio: Float32Array;
  nextRatioQ: Int32Array;

  constructor() {
    const n = TIDES2_NUM_CHANNELS;
    this.phase = new Float32Array(n);
    this.frequency = new Float32Array(n);
    this.wrapCounter = new Int32Array(n);
    this.ratio = new Float32Array(n).fill(1);
    this.ratioQ = new Int32Array(n).fill(1);
    this.nextRatio = new Float32Array(n).fill(1);
    this.nextRatioQ = new Int32Array(n).fill(1);
  }

  init(): void {
    this.masterPhase = 0;
    this.phase.fill(0);
    this.frequency.fill(0);
    this.wrapCounter.fill(0);
    this.ratio.fill(1);
    this.ratioQ.fill(1);
    this.nextRatio.fill(1);
    this.nextRatioQ.fill(1);
  }

  /** SHIFT-driven frequency ratios for FREQUENCY output mode. The four
   *  channels get the base index and the next three series entries. */
  setRatioFromShift(shift01: number): void {
    const baseIdx = Math.round(clamp(shift01, 0, 1) * (RATIO_SEQUENCE.length - 1));
    for (let i = 0; i < TIDES2_NUM_CHANNELS; i++) {
      const idx = clamp(baseIdx + i, 0, RATIO_SEQUENCE.length - 1);
      const r = RATIO_SEQUENCE[idx]!;
      this.nextRatio[i] = r;
      // Quantization period: number of master cycles per channel cycle for
      // sub-harmonics (denominator of the ratio).
      this.nextRatioQ[i] = r < 1 ? Math.max(1, Math.round(1 / r)) : 1;
    }
  }

  /**
   * Step one sample.
   * @param f0 master per-sample phase increment (normalized frequency)
   * @param pw per-channel pulse-width array (length num_channels, or [pw])
   * @param rising true on a gate/clock rising edge this sample
   * @param high true while a gate is held high (AR mode)
   * @param rampMode RAMP_MODE_*
   * @param outputMode OUTPUT_MODE_*
   */
  step(
    f0: number,
    pw: ArrayLike<number>,
    rising: boolean,
    high: boolean,
    rampMode: number,
    outputMode: number,
  ): void {
    const n =
      outputMode === OUTPUT_MODE_FREQUENCY ||
      (outputMode === OUTPUT_MODE_SLOPE_PHASE && rampMode === RAMP_MODE_AR)
        ? TIDES2_NUM_CHANNELS
        : 1;

    if (rampMode === RAMP_MODE_AD) {
      if (rising) {
        for (let i = 0; i < n; i++) this.phase[i] = 0;
      }
      for (let i = 0; i < n; i++) {
        this.frequency[i] = Math.min(f0 * this.nextRatio[i]!, 0.25);
        this.phase[i] = Math.min(this.phase[i]! + this.frequency[i]!, 1);
      }
    } else if (rampMode === RAMP_MODE_AR) {
      if (outputMode === OUTPUT_MODE_SLOPE_PHASE) {
        for (let i = 0; i < n; i++) this.frequency[i] = f0;
      } else {
        for (let i = 0; i < n; i++) {
          this.frequency[i] = Math.min(f0 * this.nextRatio[i]!, 0.25);
        }
      }
      const shouldRampUp = high;
      const clipAt = shouldRampUp ? 0.5 : 1.0;
      for (let i = 0; i < n; i++) {
        if (this.phase[i]! < 0.5 && !shouldRampUp) {
          this.phase[i] = 0.5;
        } else if (this.phase[i]! > 0.5 && shouldRampUp) {
          this.phase[i] = 0.0;
        }
        const thisPw = outputMode === OUTPUT_MODE_FREQUENCY ? pw[0]! : pw[i]!;
        const slope =
          this.phase[i]! < 0.5
            ? 0.5 / (1e-6 + thisPw)
            : 0.5 / (1.0 + 1e-6 - thisPw);
        this.phase[i] = Math.min(this.phase[i]! + this.frequency[i]! * slope, clipAt);
      }
    } else if (rampMode === RAMP_MODE_LOOPING) {
      let reset = false;
      if (rising) {
        this.masterPhase = 0;
        for (let i = 0; i < n; i++) {
          this.ratio[i] = this.nextRatio[i]!;
          this.ratioQ[i] = this.nextRatioQ[i]!;
          this.wrapCounter[i] = 0;
        }
        reset = true;
      }
      for (let i = 0; i < n; i++) {
        this.frequency[i] = Math.min(f0 * this.ratio[i]!, 0.25);
      }
      if (!reset) this.masterPhase += f0;
      if (this.masterPhase >= 1) {
        this.masterPhase -= 1;
        for (let i = 0; i < n; i++) {
          this.wrapCounter[i]!++;
          if (this.wrapCounter[i]! >= this.ratioQ[i]!) {
            this.ratio[i] = this.nextRatio[i]!;
            this.ratioQ[i] = this.nextRatioQ[i]!;
            this.wrapCounter[i] = 0;
          }
        }
      }
      for (let i = 0; i < n; i++) {
        let multPhase = (this.masterPhase + this.wrapCounter[i]!) * this.ratio[i]!;
        multPhase -= Math.floor(multPhase);
        this.phase[i] = multPhase;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// RampExtractor — eurorack/tides2/ramp/ramp_extractor.cc. Recovers a 0..1
// phase ramp from an external clock by predicting the next edge interval
// (moving-average predictor — the rhythmic-pattern + constant-PW predictors
// from the original are summarized here; documented as a simplification).
// ---------------------------------------------------------------------------

export class RampExtractor {
  private sampleRate = 48000;
  private trainPhase = 0;
  private frequency = 0; // predicted per-sample phase increment
  private targetFrequency = 0;
  private lpCoefficient = 0.5;
  private lastEdgeSample = 0;
  private sampleCounter = 0;
  private intervals: number[] = [];
  private maxInterval = 16;

  init(sampleRate: number): void {
    this.sampleRate = sampleRate;
    this.reset();
  }

  reset(): void {
    this.trainPhase = 0;
    this.frequency = 0;
    this.targetFrequency = 0;
    this.lastEdgeSample = 0;
    this.sampleCounter = 0;
    this.intervals = [];
  }

  /** Advance one sample. `rising` true on a clock rising edge. Returns the
   *  recovered phase ramp in [0,1). */
  process(rising: boolean): number {
    this.sampleCounter++;
    if (rising) {
      const interval = this.sampleCounter - this.lastEdgeSample;
      this.lastEdgeSample = this.sampleCounter;
      if (interval > 1 && interval < this.sampleRate * 4) {
        this.intervals.push(interval);
        if (this.intervals.length > this.maxInterval) this.intervals.shift();
        let sum = 0;
        for (const v of this.intervals) sum += v;
        const avgInterval = sum / this.intervals.length;
        this.targetFrequency = 1 / avgInterval;
      }
      // Re-anchor phase on each edge so we stay locked.
      this.trainPhase = 0;
    }
    // One-pole smoothing toward the predicted frequency.
    this.frequency += (this.targetFrequency - this.frequency) * this.lpCoefficient;
    this.trainPhase += this.frequency;
    if (this.trainPhase >= 1) this.trainPhase -= 1;
    return this.trainPhase;
  }

  /** Predicted normalized frequency (per-sample phase increment). */
  predictedFrequency(): number {
    return this.frequency;
  }
}

// ---------------------------------------------------------------------------
// Two-pole one-pole smoothing filter (SMOOTHNESS < 0.5). Per-channel.
// ---------------------------------------------------------------------------

class SmoothFilter {
  private lp1 = new Float32Array(TIDES2_NUM_CHANNELS);
  private lp2 = new Float32Array(TIDES2_NUM_CHANNELS);
  init(): void {
    this.lp1.fill(0);
    this.lp2.fill(0);
  }
  process(ch: number, input: number, coef: number): number {
    this.lp1[ch]! += (input - this.lp1[ch]!) * coef;
    this.lp2[ch]! += (this.lp1[ch]! - this.lp2[ch]!) * coef;
    return this.lp2[ch]!;
  }
}

// ---------------------------------------------------------------------------
// PolySlopeGenerator — the top-level engine. Holds the ramp generator,
// shapers, waveshapers, smoothing filter, and renders the four outputs per
// output mode. Mirrors PolySlopeGenerator::RenderInternal.
// ---------------------------------------------------------------------------

export interface Tides2Params {
  frequency: number; // FREQ knob [0,1]
  voct: number; // V/oct, octaves
  shape: number; // SHAPE knob [0,1]
  slope: number; // SLOPE / pulse-width knob [0,1] (=pw)
  smoothness: number; // SMOOTHNESS knob [0,1]
  shift: number; // SHIFT / LEVEL knob [0,1]
  rampMode: number; // RAMP_MODE_*
  outputMode: number; // OUTPUT_MODE_*
  range: number; // RANGE_*
}

export class PolySlopeGenerator {
  sr: number;
  rampGen = new RampGenerator();
  shapers: RampShaper[] = [];
  waveshapers: RampWaveshaper[] = [];
  private filter = new SmoothFilter();
  private rampExtractor = new RampExtractor();

  // Edge tracking.
  private lastGate = 0;
  private lastClock = 0;

  // Output scratch.
  out = new Float32Array(TIDES2_NUM_CHANNELS);

  constructor(sr: number) {
    this.sr = sr;
    for (let i = 0; i < TIDES2_NUM_CHANNELS; i++) {
      this.shapers.push(new RampShaper());
      this.waveshapers.push(new RampWaveshaper());
      this.waveshapers[i]!.init();
    }
    this.filter.init();
    this.rampExtractor.init(sr);
  }

  reset(): void {
    this.rampGen.init();
    for (const w of this.waveshapers) w.init();
    this.filter.init();
    this.rampExtractor.reset();
    this.lastGate = 0;
    this.lastClock = 0;
  }

  /**
   * Render one sample. `gate` / `clock` are 0..1 trigger inputs. Returns the
   * four output channel values (written into `this.out`, also returned).
   *
   * @param p parameters (see Tides2Params)
   * @param gate gate/trigger level (AD/AR); rising edge resets/attacks
   * @param clock external clock level (drives the ramp extractor when in
   *              tempo-sync / external-ramp mode)
   * @param useClock if true, lock the master phase to the external clock
   */
  render(
    p: Tides2Params,
    gate: number,
    clock: number,
    useClock: boolean,
  ): Float32Array {
    const gateRising = this.lastGate < TRIG_THRESHOLD && gate >= TRIG_THRESHOLD;
    const gateHigh = gate >= TRIG_THRESHOLD;
    this.lastGate = gate;
    const clockRising = this.lastClock < TRIG_THRESHOLD && clock >= TRIG_THRESHOLD;
    this.lastClock = clock;

    const range = p.range;
    const outputMode = p.outputMode;
    const rampMode = p.rampMode;

    // --- Parameter conditioning (from PolySlopeGenerator::Render). ---
    let pw = clamp(p.slope, 0, 1);
    if (range === RANGE_CONTROL && pw < 0.5) {
      pw = 0.5 + (0.6 * (pw - 0.5)) / (Math.abs(pw - 0.5) + 0.1);
    }

    // Master frequency increment.
    let f0: number;
    if (useClock) {
      const ramp = this.rampExtractor.process(clockRising);
      f0 = this.rampExtractor.predictedFrequency();
      // External ramp directly drives master phase in LOOPING/AD via the
      // extractor; we still advance the ramp generator with f0 so the
      // per-channel ratios + shapers work uniformly.
      this.rampGen.masterPhase = ramp;
    } else {
      f0 = freqKnobToIncrement(p.frequency, p.voct, range, this.sr);
    }
    f0 = Math.min(f0, 0.25);

    if (useClock && rampMode === RAMP_MODE_AR) {
      f0 *= 1 + 2 * Math.abs(pw - 0.5);
    }

    // SHAPE morph position. Phasor modes scan 0..6 (6 shapes); envelope
    // (AR/AD non-looping audio) scans 0..4.
    const isPhasor = !(range === RANGE_AUDIO && rampMode === RAMP_MODE_LOOPING);
    const shapeMorphPos = isPhasor
      ? clamp(p.shape, 0, 1) * (SHAPE_TABLE_FNS.length - 1.001)
      : clamp(p.shape, 0, 1) * 3.999;

    const foldAmount = Math.max(2 * (clamp(p.smoothness, 0, 1) - 0.5), 0);
    const loopMode = rampMode === RAMP_MODE_LOOPING;

    // SHIFT in bipolar [-1, 1].
    const shift = 2 * clamp(p.shift, 0, 1) - 1;
    const step = shift / (TIDES2_NUM_CHANNELS - 1);
    const partialStep = shift / TIDES2_NUM_CHANNELS;

    // Per-channel pulse widths (AD spreads pw across channels by SHIFT).
    const perChannelPw = new Float32Array(TIDES2_NUM_CHANNELS);
    const pwIncrement = (shift > 0 ? 1 - pw : pw) * step;
    for (let j = 0; j < TIDES2_NUM_CHANNELS; j++) {
      perChannelPw[j] = clamp(pw + pwIncrement * j, 0.001, 0.999);
    }

    // FREQUENCY mode quantizes SHIFT into ratios.
    if (outputMode === OUTPUT_MODE_FREQUENCY) {
      this.rampGen.setRatioFromShift(p.shift);
    } else {
      // Reset ratios to unison for non-frequency modes.
      this.rampGen.nextRatio.fill(1);
      this.rampGen.nextRatioQ.fill(1);
    }

    // --- Advance the ramp generator. ---
    const rising = useClock ? clockRising : gateRising;
    this.rampGen.step(f0, perChannelPw, rising, gateHigh, rampMode, outputMode);

    // --- Compute outputs per output mode. ---
    if (outputMode === OUTPUT_MODE_GATES) {
      const phase = this.rampGen.phase[0]!;
      const frequency = this.rampGen.frequency[0]!;
      const raw = this.shapers[0]!.slope(rampMode, phase, 0, pw);
      const slopeVal = this.waveshapers[0]!.shape(rampMode, raw, shapeMorphPos);

      this.out[0] = fold(slopeVal, foldAmount, loopMode) * shift;
      const ch1 = isPhasor
        ? this.waveshapers[1]!.shape(rampMode, raw, 0) // unipolar variant
        : raw;
      this.out[1] = loopMode ? 10 * ch1 - 5 : 8 * ch1;
      this.out[2] = this.shapers[2]!.eoa(rampMode, phase, pw) * 8;
      this.out[3] = this.shapers[3]!.eor(rampMode, phase, frequency) * 8;
    } else if (outputMode === OUTPUT_MODE_AMPLITUDE) {
      const phase = this.rampGen.phase[0]!;
      const raw = this.shapers[0]!.slope(rampMode, phase, 0, pw);
      const shaped = this.waveshapers[0]!.shape(rampMode, raw, shapeMorphPos);
      const slopeVal = fold(shaped, foldAmount, loopMode) * (shift < 0 ? -1 : 1);
      const channelIndex = Math.abs(shift * 5.1);
      for (let j = 0; j < TIDES2_NUM_CHANNELS; j++) {
        const channel = j + 1;
        const gain = Math.max(1 - Math.abs(channel - channelIndex), 0);
        const equalPow = range === RANGE_AUDIO;
        this.out[j] = slopeVal * gain * (equalPow ? 2 - gain : 1);
      }
    } else if (outputMode === OUTPUT_MODE_SLOPE_PHASE) {
      let phaseShift = 0;
      for (let j = 0; j < TIDES2_NUM_CHANNELS; j++) {
        const source = rampMode === RAMP_MODE_AR ? j : 0;
        const ph = this.rampGen.phase[source]!;
        const raw = this.shapers[j]!.slope(
          rampMode,
          ph,
          phaseShift,
          rampMode === RAMP_MODE_AD ? perChannelPw[j]! : pw,
        );
        const shaped = this.waveshapers[j]!.shape(rampMode, raw, shapeMorphPos);
        this.out[j] = fold(shaped, foldAmount, loopMode);
        phaseShift -= range === RANGE_AUDIO ? step : partialStep;
      }
    } else {
      // OUTPUT_MODE_FREQUENCY — each channel is its own ratio.
      for (let j = 0; j < TIDES2_NUM_CHANNELS; j++) {
        const ph = this.rampGen.phase[j]!;
        const raw = this.shapers[j]!.slope(rampMode, ph, 0, pw);
        const shaped = this.waveshapers[j]!.shape(rampMode, raw, shapeMorphPos);
        this.out[j] = fold(shaped, foldAmount, loopMode);
      }
    }

    // --- SMOOTHNESS < 0.5 → low-pass smoothing. ---
    const smoothness = clamp(p.smoothness, 0, 1);
    if (smoothness < 0.5) {
      let ratio = smoothness * 2;
      ratio *= ratio;
      ratio *= ratio;
      const lastChannel = outputMode === OUTPUT_MODE_GATES ? 1 : TIDES2_NUM_CHANNELS;
      for (let j = 0; j < lastChannel; j++) {
        const source = outputMode === OUTPUT_MODE_FREQUENCY ? j : 0;
        let coef = this.rampGen.frequency[source]! * 0.5;
        coef += (1 - coef) * ratio;
        coef = clamp(coef, 0, 1);
        this.out[j] = this.filter.process(j, this.out[j]!, coef);
      }
    }

    return this.out;
  }
}
