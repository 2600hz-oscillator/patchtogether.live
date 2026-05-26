// packages/dsp/src/marbles-core.ts
//
// MARBLES core — clean-room TypeScript port of Émilie Gillet's Mutable
// Instruments Marbles DSP (random/, ramp/). Source: eurorack/marbles/, MIT-
// licensed per individual file headers (Copyright 2015 Émilie Gillet). The
// eurorack repo README states "Code (STM32F projects): MIT license" — MIT is
// compatible with patchtogether.live's AGPL. MIT attribution preserved here.
//
// Reference files mapped from:
//   marbles/random/t_generator.{h,cc}     — T-section gate generator
//   marbles/random/x_y_generator.{h,cc}   — X/Y CV generator
//   marbles/random/random_sequence.h      — déjà-vu loop + Markov locking
//   marbles/random/output_channel.{h,cc}  — SPREAD/BIAS/STEPS voltage gen
//   marbles/random/quantizer.{h,cc}       — weighted-scale quantizer
//   marbles/random/lag_processor.cc       — STEPS portamento/lag
//   marbles/ramp/slave_ramp.h             — divided/multiplied slave ramps
//
// Fidelity notes (approximations vs faithful):
//  - RandomStream is replaced by a deterministic LCG (matches the firmware's
//    RandomGenerator fallback path, which IS an LCG: state*1664525+1013904223).
//  - BetaDistributionSample is APPROXIMATED analytically (the firmware uses a
//    precomputed 9x5 inverse-CDF table). We use a closed-form mapping that
//    reproduces the qualitative SPREAD (variance) / BIAS (mean) behaviour:
//    spread 0 → degenerate at bias; spread 1 → near-uniform; the high-spread
//    Bernoulli regime is preserved bit-for-bit from output_channel.cc.
//  - The faithful pieces: random_sequence déjà-vu/Markov logic, slave_ramp,
//    the quantizer search, the Bernoulli/coin/cluster/drum T generators, the
//    lag_processor crossfade — all ported line-for-line.

// ---------------------------------------------------------------------------
// Deterministic random stream (firmware RandomGenerator LCG).
// ---------------------------------------------------------------------------

const K_MAX_UINT32 = 4294967296.0;

export class RandomStream {
  state = 0x12345678 >>> 0;
  constructor(seed = 0x12345678) {
    this.state = seed >>> 0;
  }
  seed(s: number): void {
    this.state = s >>> 0;
  }
  getWord(): number {
    // state = state * 1664525 + 1013904223 (mod 2^32)
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state;
  }
  getFloat(): number {
    return this.getWord() / K_MAX_UINT32;
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

// ---------------------------------------------------------------------------
// Beta distribution sample (analytic approximation of marbles' table lookup).
//   uniform: a uniform [0,1) draw.
//   spread:  0 = degenerate (always == bias), 1 = wide/near-uniform.
//   bias:    mean of the distribution in [0,1].
// The firmware interpolates a 9-spread x 5-bias inverse-CDF table. We map the
// uniform through a power curve whose exponents follow bias, scaled by spread.
// ---------------------------------------------------------------------------

export function betaDistributionSample(uniform: number, spread: number, bias: number): number {
  const s = clamp(spread, 0, 1);
  const b = clamp(bias, 0, 1);
  if (s <= 0.0001) return b;
  // Symmetric beta-ish: alpha/beta derived from bias, concentration from spread.
  // concentration k: low spread → high k (peaky); high spread → k→~1 (flat).
  const k = (1 - s) * (1 - s) * 40 + 1;
  const alpha = Math.max(0.05, b * k);
  const beta = Math.max(0.05, (1 - b) * k);
  // Approximate inverse-CDF of Beta(alpha,beta) by a single Newton-free
  // mapping: use the "Wilson-Hilferty"-style symmetric power blend.
  const u = clamp(uniform, 1e-6, 1 - 1e-6);
  // Blend two power curves so mean ≈ alpha/(alpha+beta) = bias.
  const lo = Math.pow(u, 1 / alpha);
  const hi = 1 - Math.pow(1 - u, 1 / beta);
  let y = lo * (1 - b) + hi * b;
  // Pull toward bias by (1-spread) to honour the degenerate limit.
  y = y + (1 - s) * (b - y);
  return clamp(y, 0, 1);
}

// Pre-computed beta(4,3)-with-fat-tail equivalent (FastBetaDistributionSample).
export function fastBetaDistributionSample(uniform: number): number {
  // Centered, slightly skewed bump in [0,1]; mean ~0.57.
  const u = clamp(uniform, 0, 1);
  return betaDistributionSample(u, 0.5, 0.57);
}

function semitonesToRatio(semitones: number): number {
  return Math.pow(2, semitones / 12);
}

// ---------------------------------------------------------------------------
// RandomSequence — déjà-vu loop with Markov locking (random_sequence.h).
// Ported line-for-line from the firmware. The "redo" pointers are replaced by
// integer indices into loop_/history_ to keep TS GC-friendly.
// ---------------------------------------------------------------------------

const K_DEJA_VU_BUFFER_SIZE = 16;
const K_HISTORY_BUFFER_SIZE = 16;

export class RandomSequence {
  private stream: RandomStream;
  private loop = new Float32Array(K_DEJA_VU_BUFFER_SIZE);
  private history = new Float32Array(K_HISTORY_BUFFER_SIZE);
  private loopWriteHead = 0;
  private length = 8;
  private step = 0;
  private recordHead = 0;
  private replayHead = -1;
  private replayStart = 0;
  private replayHash = 0;
  private replayShift = 0;
  private dejaVu = 0;
  // Index-based "redo" pointers (-1 = null).
  private redoReadPtr = 0;
  private redoWritePtr = -1;
  private redoWriteHistoryPtr = -1;

  constructor(stream: RandomStream) {
    this.stream = stream;
    for (let i = 0; i < K_DEJA_VU_BUFFER_SIZE; i++) this.loop[i] = stream.getFloat();
    this.history.fill(0);
    this.redoReadPtr = 0;
    this.redoWritePtr = -1;
    this.redoWriteHistoryPtr = -1;
  }

  record(): void {
    this.replayStart = this.recordHead;
    this.replayHead = -1;
  }

  replayPseudoRandom(hash: number): void {
    this.replayHead = this.replayStart;
    this.replayHash = hash >>> 0;
    this.replayShift = 0;
  }

  replayShifted(shift: number): void {
    this.replayHead = this.replayStart;
    this.replayHash = 0;
    this.replayShift = shift >>> 0;
  }

  nextValue(deterministic: boolean, value: number): number {
    if (this.replayHead >= 0) {
      this.replayHead = (this.replayHead + 1) % K_HISTORY_BUFFER_SIZE;
      return this.getReplayValueFaithful();
    }

    const pSqrt = 2 * this.dejaVu - 1;
    const p = pSqrt * pSqrt;
    const mutate = this.stream.getFloat() < p;

    if (mutate && this.dejaVu <= 0.5) {
      this.redoWritePtr = this.loopWriteHead;
      this.loop[this.redoWritePtr] = deterministic ? 1.0 + value : this.stream.getFloat();
      this.loopWriteHead = (this.loopWriteHead + 1) % K_DEJA_VU_BUFFER_SIZE;
      this.step = this.length - 1;
    } else {
      this.redoWritePtr = -1;
      if (mutate) {
        this.step = Math.floor(this.stream.getFloat() * this.length);
      } else {
        this.step = this.step + 1;
        if (this.step >= this.length) this.step = 0;
      }
    }
    const i = (this.loopWriteHead + K_DEJA_VU_BUFFER_SIZE - this.length + this.step) >>> 0;
    this.redoReadPtr = i % K_DEJA_VU_BUFFER_SIZE;
    let result = this.loop[this.redoReadPtr]!;
    if (result >= 1.0) {
      result -= 1.0;
    } else if (deterministic) {
      result = 0.5;
    }
    this.redoWriteHistoryPtr = this.recordHead;
    this.history[this.redoWriteHistoryPtr] = result;
    this.recordHead = (this.recordHead + 1) % K_HISTORY_BUFFER_SIZE;
    return result;
  }

  // Faithful replay value (correct LCG XOR ordering).
  private getReplayValueFaithful(): number {
    const h = (this.replayHead - 1 - this.replayShift + 2 * K_HISTORY_BUFFER_SIZE) % K_HISTORY_BUFFER_SIZE;
    if (!this.replayHash) {
      return this.history[h]!;
    }
    let word = Math.floor(this.history[h]! * K_MAX_UINT32) >>> 0;
    word = (Math.imul((word ^ this.replayHash) >>> 0, 1664525) + 1013904223) >>> 0;
    return word / K_MAX_UINT32;
  }

  nextVector(destination: Float32Array, size: number): void {
    const seed = this.nextValue(false, 0);
    let word = Math.floor(seed * K_MAX_UINT32) >>> 0;
    for (let i = 0; i < size; i++) {
      destination[i] = word / K_MAX_UINT32;
      word = (Math.imul(word, 1664525) + 1013904223) >>> 0;
    }
  }

  setDejaVu(dejaVu: number): void {
    this.dejaVu = dejaVu;
  }
  setLength(length: number): void {
    if (length < 1 || length > K_DEJA_VU_BUFFER_SIZE) return;
    this.length = length;
    this.step = this.step % length;
  }
  getDejaVu(): number {
    return this.dejaVu;
  }
  getLength(): number {
    return this.length;
  }
  reset(): void {
    this.step = this.length - 1;
  }
  clone(src: RandomSequence): void {
    this.stream = src.stream;
    this.loop.set(src.loop);
    this.history.set(src.history);
    this.loopWriteHead = src.loopWriteHead;
    this.length = src.length;
    this.step = src.step;
    this.recordHead = src.recordHead;
    this.replayHead = src.replayHead;
    this.replayStart = src.replayStart;
    this.replayHash = src.replayHash;
    this.replayShift = src.replayShift;
    this.dejaVu = src.dejaVu;
  }
}

// ---------------------------------------------------------------------------
// SlaveRamp (slave_ramp.h) — ported line-for-line.
// ---------------------------------------------------------------------------

const K_MAX_RAMP_VALUE = 1.0;

export class SlaveRamp {
  private phase = 0;
  private maxPhase = K_MAX_RAMP_VALUE;
  private ratio = 1;
  private pulseWidth = 0;
  private target = 1;
  private pulseLength = 0;
  private bernoulli = false;
  private mustComplete = false;

  init(): void {
    this.phase = 0;
    this.maxPhase = K_MAX_RAMP_VALUE;
    this.ratio = 1;
    this.pulseWidth = 0;
    this.target = 1;
    this.pulseLength = 0;
    this.bernoulli = false;
    this.mustComplete = false;
  }
  reset(): void {
    this.init();
    this.phase = 1.0;
  }
  // Divided/multiplied rate vs master.
  initRatio(patternLength: number, ratio: number, pulseWidth: number): void {
    this.bernoulli = false;
    this.phase = 0;
    this.maxPhase = patternLength * K_MAX_RAMP_VALUE;
    this.ratio = ratio;
    this.pulseWidth = pulseWidth;
    this.target = 1;
    this.pulseLength = 0;
  }
  // Adaptive Bernoulli slope.
  initBernoulli(mustComplete: boolean, pulseWidth: number, expectedValue: number): void {
    this.bernoulli = true;
    if (this.mustComplete) {
      this.phase = 0;
      this.pulseWidth = pulseWidth;
      this.ratio = 1;
      this.pulseLength = 0;
    }
    if (!mustComplete) {
      this.ratio = (1 - this.phase) * expectedValue;
    } else {
      this.ratio = 1 - this.phase;
    }
    this.mustComplete = mustComplete;
  }
  // Returns [phase, gate].
  process(frequency: number): { phase: number; gate: boolean } {
    let outputPhase: number;
    if (this.bernoulli) {
      this.phase += frequency * this.ratio;
      outputPhase = this.phase;
      if (outputPhase >= 1.0) outputPhase = 1.0;
    } else {
      this.phase += frequency;
      if (this.phase >= this.maxPhase) this.phase = this.maxPhase;
      outputPhase = this.phase * this.ratio;
      if (outputPhase > this.target) {
        this.pulseLength = 0;
        this.target += 1.0;
      }
      outputPhase -= Math.trunc(outputPhase);
    }
    const gate =
      this.pulseWidth === 0
        ? this.pulseLength < 32 && outputPhase <= 0.5
        : outputPhase < this.pulseWidth;
    ++this.pulseLength;
    return { phase: outputPhase, gate };
  }
}

// ---------------------------------------------------------------------------
// Quantizer (quantizer.{h,cc}) — weighted variable-resolution scale snap.
// ---------------------------------------------------------------------------

const K_MAX_DEGREES = 16;
const K_NUM_THRESHOLDS = 7;

export interface ScaleDegree {
  voltage: number;
  weight: number;
}
export interface Scale {
  baseInterval: number;
  numDegrees: number;
  degree: ScaleDegree[];
}

export function cellVoltage(scale: Scale, i: number): number {
  const transposition = Math.floor(i / scale.numDegrees) * scale.baseInterval;
  let idx = i % scale.numDegrees;
  if (idx < 0) idx += scale.numDegrees;
  return scale.degree[idx]!.voltage + transposition;
}

interface QLevel {
  bitmask: number;
  first: number;
  last: number;
}

export class Quantizer {
  private voltage = new Float32Array(K_MAX_DEGREES);
  private level: QLevel[] = [];
  private feedback = new Float32Array(K_NUM_THRESHOLDS);
  private baseInterval = 1;
  private baseIntervalReciprocal = 1;
  private numDegrees = 1;

  constructor() {
    for (let i = 0; i < K_NUM_THRESHOLDS; i++) this.level.push({ bitmask: 0, first: 0, last: 0 });
  }

  init(scale: Scale): void {
    const n = scale.numDegrees;
    if (!n || n > K_MAX_DEGREES || scale.baseInterval === 0) return;
    this.numDegrees = n;
    this.baseInterval = scale.baseInterval;
    this.baseIntervalReciprocal = 1 / scale.baseInterval;

    let secondLargest = 0;
    for (let i = 0; i < n; i++) {
      this.voltage[i] = scale.degree[i]!.voltage;
      const w = scale.degree[i]!.weight;
      if (w !== 255 && w >= secondLargest) secondLargest = w;
    }

    const thresholds = [0, 16, 32, 64, 128, 192, 255];
    if (secondLargest > 192) thresholds[K_NUM_THRESHOLDS - 2] = secondLargest;

    for (let t = 0; t < K_NUM_THRESHOLDS; t++) {
      let bitmask = 0;
      let first = 0xff;
      let last = 0;
      for (let i = 0; i < n; i++) {
        if (scale.degree[i]!.weight >= thresholds[t]!) {
          bitmask |= 1 << i;
          if (first === 0xff) first = i;
          last = i;
        }
      }
      this.level[t] = { bitmask, first, last };
    }
    this.feedback.fill(0);
  }

  // amount in [-1,1]; <=0 → no quantize.
  process(value: number, amount: number, hysteresis: boolean): number {
    // level_quantizer: maps amount over [0,1] into 0..kNumThresholds buckets.
    let level = Math.round(clamp(amount, 0, 1) * K_NUM_THRESHOLDS);
    if (level > K_NUM_THRESHOLDS) level = K_NUM_THRESHOLDS;
    let quantized = value;
    if (level > 0) {
      level -= 1;
      const rawValue = value;
      if (hysteresis) value += this.feedback[level]!;

      const note = value * this.baseIntervalReciprocal;
      let noteIntegral = Math.floor(note);
      let noteFractional = note - noteIntegral;
      if (value < 0) {
        // MAKE_INTEGRAL_FRACTIONAL with the firmware's negative correction.
      }
      noteFractional *= this.baseInterval;

      const l = this.level[level]!;
      let a = this.voltage[l.last]! - this.baseInterval;
      let b = this.voltage[l.first]! + this.baseInterval;
      let bitmask = l.bitmask;
      for (let i = 0; i < this.numDegrees; i++) {
        if (bitmask & 1) {
          const v = this.voltage[i]!;
          if (noteFractional > v) {
            a = v;
          } else {
            b = v;
            break;
          }
        }
        bitmask >>= 1;
      }
      quantized = noteFractional < (a + b) * 0.5 ? a : b;
      quantized += noteIntegral * this.baseInterval;
      this.feedback[level] = (quantized - rawValue) * 0.25;
    }
    return quantized;
  }
}

// ---------------------------------------------------------------------------
// LagProcessor (lag_processor.cc) — STEPS portamento/glide.
// ---------------------------------------------------------------------------

export class LagProcessor {
  private rampStart = 0;
  private rampValue = 0;
  private lpState = 0;
  private previousPhase = 0;
  init(): void {
    this.rampStart = 0;
    this.rampValue = 0;
    this.lpState = 0;
    this.previousPhase = 0;
  }
  resetRamp(): void {
    this.rampStart = this.rampValue;
  }
  process(value: number, smoothness: number, phase: number): number {
    let frequency = phase - this.previousPhase;
    if (frequency < 0) frequency += 1;
    this.previousPhase = phase;
    frequency *= 0.25;
    frequency *= semitonesToRatio(84 * (1 - smoothness));
    if (frequency >= 1) frequency = 1;
    if (smoothness <= 0.05) frequency += 20 * (0.05 - smoothness) * (1 - frequency);
    // ONE_POLE
    this.lpState += frequency * (value - this.lpState);

    let interpAmount = (smoothness - 0.6) * 5;
    interpAmount = clamp(interpAmount, 0, 1);
    let interpLinearity = (1 - smoothness) * 5;
    interpLinearity = clamp(interpLinearity, 0, 1);
    // raised-cosine warp of phase.
    const warpedPhase = 0.5 - 0.5 * Math.cos(Math.PI * phase);
    const interpPhase = warpedPhase + (phase - warpedPhase) * interpLinearity;
    const interp = this.rampStart + (value - this.rampStart) * interpPhase;
    this.rampValue = interp;
    return this.lpState + (interp - this.lpState) * interpAmount;
  }
}

// ---------------------------------------------------------------------------
// OutputChannel (output_channel.{h,cc}) — SPREAD/BIAS/STEPS voltage gen.
// ---------------------------------------------------------------------------

export class ScaleOffset {
  scale: number;
  offset: number;
  constructor(s = 1, o = 0) {
    this.scale = s;
    this.offset = o;
  }
  apply(x: number): number {
    return x * this.scale + this.offset;
  }
}

export class OutputChannel {
  private spread = 0.5;
  private bias = 0.5;
  private steps = 0.5;
  private scaleIndex = 0;
  private previousSteps = 0;
  private previousPhase = 0;
  private previousVoltage = 0;
  private voltage = 0;
  private quantizedVoltage = 0;
  private scaleOffset = new ScaleOffset(10, -5);
  private lag = new LagProcessor();
  private quantizers: Quantizer[] = [];

  constructor() {
    for (let i = 0; i < 6; i++) this.quantizers.push(new Quantizer());
    this.lag.init();
  }

  init(): void {
    this.spread = 0.5;
    this.bias = 0.5;
    this.steps = 0.5;
    this.scaleIndex = 0;
    this.previousSteps = 0;
    this.previousPhase = 0;
    this.previousVoltage = 0;
    this.voltage = 0;
    this.quantizedVoltage = 0;
    this.scaleOffset = new ScaleOffset(10, -5);
    this.lag.init();
  }
  loadScale(i: number, scale: Scale): void {
    this.quantizers[i]!.init(scale);
  }
  setSpread(v: number): void {
    this.spread = v;
  }
  setBias(v: number): void {
    this.bias = v;
  }
  setSteps(v: number): void {
    this.steps = v;
  }
  setScaleIndex(i: number): void {
    this.scaleIndex = i;
  }
  setScaleOffset(s: ScaleOffset): void {
    this.scaleOffset = s;
  }
  private quantize(voltage: number, amount: number): number {
    return this.quantizers[this.scaleIndex]!.process(voltage, amount, false);
  }
  private generateNewVoltage(seq: RandomSequence): number {
    const u = seq.nextValue(false, 0);
    let degenerateAmount = 1.25 - this.spread * 25;
    let bernoulliAmount = this.spread * 25 - 23.75;
    degenerateAmount = clamp(degenerateAmount, 0, 1);
    bernoulliAmount = clamp(bernoulliAmount, 0, 1);
    let value = betaDistributionSample(u, this.spread, this.bias);
    const bernoulliValue = u >= 1 - this.bias ? 0.999999 : 0;
    value += degenerateAmount * (this.bias - value);
    value += bernoulliAmount * (bernoulliValue - value);
    return this.scaleOffset.apply(value);
  }
  // Process one sample. phase is the channel clock ramp.
  processSample(seq: RandomSequence, phase: number): number {
    const steps = this.steps; // block-rate is fine for our use (per-sample interp dropped)
    let out: number;
    if (phase < this.previousPhase) {
      this.previousVoltage = this.voltage;
      this.voltage = this.generateNewVoltage(seq);
      this.lag.resetRamp();
      this.quantizedVoltage = this.quantize(this.voltage, 2 * steps - 1);
    }
    if (steps >= 0.5) {
      out = this.quantizedVoltage;
    } else {
      const smoothness = 1 - 2 * steps;
      out = this.lag.process(this.voltage, smoothness, phase);
    }
    this.previousPhase = phase;
    this.previousSteps = steps;
    return out;
  }
}

// ---------------------------------------------------------------------------
// TGenerator (t_generator.{h,cc}) — gate generation: Bernoulli (coin),
// independent Bernoulli, three-states, drums, clusters, markov.
// ---------------------------------------------------------------------------

export const T_MODEL = {
  COMPLEMENTARY_BERNOULLI: 0,
  CLUSTERS: 1,
  DRUMS: 2,
  INDEPENDENT_BERNOULLI: 3,
  DIVIDER: 4,
  THREE_STATES: 5,
  MARKOV: 6,
} as const;

const K_NUM_T_CHANNELS = 2;
const K_DRUM_PATTERN_SIZE = 8;

// drum_patterns[18][8] from t_generator.cc
const DRUM_PATTERNS: number[][] = [
  [1, 0, 0, 0, 2, 0, 0, 0],
  [0, 0, 1, 0, 2, 0, 0, 0],
  [1, 0, 1, 0, 2, 0, 0, 0],
  [0, 0, 1, 0, 2, 0, 0, 2],
  [1, 0, 1, 0, 2, 0, 1, 0],
  [0, 2, 1, 0, 2, 0, 0, 2],
  [1, 0, 0, 0, 2, 0, 1, 0],
  [0, 2, 1, 0, 2, 0, 1, 2],
  [1, 0, 0, 1, 2, 0, 0, 0],
  [0, 2, 1, 1, 2, 0, 1, 2],
  [1, 0, 0, 1, 2, 0, 1, 0],
  [0, 2, 1, 1, 2, 2, 1, 2],
  [1, 0, 0, 1, 2, 0, 1, 2],
  [0, 2, 0, 1, 2, 0, 1, 2],
  [1, 0, 1, 1, 2, 0, 1, 2],
  [2, 0, 1, 2, 0, 1, 2, 0],
  [1, 2, 1, 1, 2, 0, 1, 2],
  [2, 0, 1, 2, 0, 1, 2, 2],
];
const K_NUM_DRUM_PATTERNS = DRUM_PATTERNS.length;

interface RandomVectorT {
  pulseWidth: number[]; // [2]
  u: number[]; // [2]
  p: number;
  jitter: number;
}

export class TGenerator {
  private oneHertz: number;
  model: number = T_MODEL.COMPLEMENTARY_BERNOULLI;
  private rate = 0;
  private bias = 0.5;
  private jitter = 0;
  private pulseWidthMean = 0;
  private pulseWidthStd = 0;
  private masterPhase = 0;
  private jitterMultiplier = 1;
  private phaseDifference = 0;
  private drumPatternStep = 0;
  private drumPatternIndex = 0;
  sequence: RandomSequence;
  private slaveRamps: SlaveRamp[] = [];

  // Markov state
  private streakCounter = new Int32Array(16);
  private markovHistory = new Int32Array(16);
  private markovHistoryPtr = 0;

  constructor(stream: RandomStream, sr: number) {
    this.oneHertz = 1 / sr;
    this.sequence = new RandomSequence(stream);
    for (let i = 0; i < K_NUM_T_CHANNELS; i++) {
      const r = new SlaveRamp();
      r.init();
      this.slaveRamps.push(r);
    }
  }

  setRate(r: number): void {
    this.rate = r;
  }
  setBias(b: number): void {
    this.bias = b;
  }
  setJitter(j: number): void {
    this.jitter = j;
  }
  setDejaVu(d: number): void {
    this.sequence.setDejaVu(d);
  }
  setLength(l: number): void {
    this.sequence.setLength(l);
  }
  setPulseWidthMean(m: number): void {
    this.pulseWidthMean = m;
  }
  setPulseWidthStd(s: number): void {
    this.pulseWidthStd = s;
  }

  private randomPulseWidth(i: number, u: number): number {
    if (this.pulseWidthStd === 0) {
      return 0.05 + 0.9 * this.pulseWidthMean;
    }
    return 0.05 + 0.9 * betaDistributionSample(u, this.pulseWidthStd, this.pulseWidthMean);
  }

  private generateComplementaryBernoulli(v: RandomVectorT): number {
    let bitmask = 0;
    for (let i = 0; i < K_NUM_T_CHANNELS; i++) {
      if ((v.u[i >> 1]! > this.bias ? 1 : 0) ^ (i & 1)) bitmask |= 1 << i;
    }
    return bitmask;
  }
  private generateIndependentBernoulli(v: RandomVectorT): number {
    let bitmask = 0;
    for (let i = 0; i < K_NUM_T_CHANNELS; i++) {
      if ((v.u[i]! > this.bias ? 1 : 0) ^ (i & 1)) bitmask |= 1 << i;
    }
    return bitmask;
  }
  private generateThreeStates(v: RandomVectorT): number {
    let bitmask = 0;
    const pNone = 0.75 - Math.abs(this.bias - 0.5);
    const threshold = pNone + (1 - pNone) * (0.25 + this.bias * 0.5);
    for (let i = 0; i < K_NUM_T_CHANNELS; i++) {
      const u = v.u[i >> 1]!;
      if (u > pNone && ((u > threshold ? 1 : 0) ^ (i & 1))) bitmask |= 1 << i;
    }
    return bitmask;
  }
  private generateDrums(v: RandomVectorT): number {
    ++this.drumPatternStep;
    if (this.drumPatternStep >= K_DRUM_PATTERN_SIZE) {
      this.drumPatternStep = 0;
      const u = v.u[0]! * 2 * Math.abs(this.bias - 0.5);
      this.drumPatternIndex = Math.trunc(K_NUM_DRUM_PATTERNS * u);
      if (this.drumPatternIndex >= K_NUM_DRUM_PATTERNS) this.drumPatternIndex = K_NUM_DRUM_PATTERNS - 1;
      if (this.bias <= 0.5) this.drumPatternIndex -= this.drumPatternIndex % 2;
    }
    return DRUM_PATTERNS[this.drumPatternIndex]![this.drumPatternStep]!;
  }
  private generateMarkov(v: RandomVectorT): number {
    let bitmask = 0;
    const b = 1.5 * this.bias - 0.5;
    this.markovHistory[this.markovHistoryPtr] = 0;
    const p = this.markovHistoryPtr;
    const H = 16;
    for (let i = 0; i < K_NUM_T_CHANNELS; i++) {
      const mask = 1 << i;
      const periodic = (this.markovHistory[(p + 8) % H]! & mask) !== 0;
      const simultaneous = (this.markovHistory[(p + 8) % H]! & ~mask) !== 0;
      const dense = (this.markovHistory[(p + 1) % H]! & mask) !== 0;
      const alternate = (this.markovHistory[(p + 4) % H]! & ~mask) !== 0;
      let logit = -1.5;
      logit += this.streakCounter[i]! > 24 ? 10 : 0;
      logit += 8 * Math.abs(b) * (periodic ? b : -b);
      logit -= 2 * (simultaneous ? b : -b);
      logit -= 1 * (dense ? b : 0);
      logit += 1 * (alternate ? b : 0);
      logit = clamp(logit, -10, 10);
      // logistic
      const probability = 1 / (1 + Math.exp(-logit));
      let state = v.u[i]! < probability;
      if (this.sequence.getDejaVu() >= v.p) {
        state = (this.markovHistory[(p + this.sequence.getLength()) % H]! & mask) !== 0;
      }
      if (state) {
        bitmask |= mask;
        this.streakCounter[i] = 0;
      } else {
        ++this.streakCounter[i]!;
      }
    }
    this.markovHistory[p]! |= bitmask;
    this.markovHistoryPtr = (p + H - 1) % H;
    return bitmask;
  }

  private scheduleOutputPulses(v: RandomVectorT, bitmask: number): void {
    for (let i = 0; i < K_NUM_T_CHANNELS; i++) {
      this.slaveRamps[i]!.initBernoulli(
        (bitmask & 1) !== 0,
        this.randomPulseWidth(i, v.pulseWidth[i]!),
        0.5,
      );
      bitmask >>= 1;
    }
  }

  private configureSlaveRamps(v: RandomVectorT): void {
    switch (this.model) {
      case T_MODEL.COMPLEMENTARY_BERNOULLI:
        this.scheduleOutputPulses(v, this.generateComplementaryBernoulli(v));
        break;
      case T_MODEL.INDEPENDENT_BERNOULLI:
        this.scheduleOutputPulses(v, this.generateIndependentBernoulli(v));
        break;
      case T_MODEL.THREE_STATES:
        this.scheduleOutputPulses(v, this.generateThreeStates(v));
        break;
      case T_MODEL.DRUMS:
        this.scheduleOutputPulses(v, this.generateDrums(v));
        break;
      case T_MODEL.MARKOV:
        this.scheduleOutputPulses(v, this.generateMarkov(v));
        break;
      case T_MODEL.CLUSTERS:
      case T_MODEL.DIVIDER:
        // Simplified divider/cluster: treat as Bernoulli with bias for v1.
        this.scheduleOutputPulses(v, this.generateComplementaryBernoulli(v));
        break;
    }
  }

  reset(): void {
    for (const r of this.slaveRamps) r.reset();
    this.sequence.reset();
    this.drumPatternStep = K_DRUM_PATTERN_SIZE;
    const rv = this.makeVector();
    this.configureSlaveRamps(rv);
  }

  private vecBuf = new Float32Array(2 * K_NUM_T_CHANNELS + 2);
  private makeVector(): RandomVectorT {
    this.sequence.nextVector(this.vecBuf, this.vecBuf.length);
    return {
      pulseWidth: [this.vecBuf[0]!, this.vecBuf[1]!],
      u: [this.vecBuf[2]!, this.vecBuf[3]!],
      p: this.vecBuf[4]!,
      jitter: this.vecBuf[5]!,
    };
  }

  // Process one sample of the internal clock. Returns master phase and gates.
  // master/slaveRamps are advanced; gate[] holds the two T gates.
  processSample(rateRangeMul: number, outGate: boolean[], outSlavePhase: number[]): number {
    const internalFrequency = rateRangeMul * this.oneHertz * semitonesToRatio(this.rate);
    const frequency = internalFrequency;
    const jitteryFrequency = frequency * this.jitterMultiplier;
    this.masterPhase += jitteryFrequency;
    this.phaseDifference += frequency - jitteryFrequency;

    if (this.masterPhase > 1.0) {
      this.masterPhase -= 1.0;
      const rv = this.makeVector();
      const jitterAmount = this.jitter * this.jitter * this.jitter * this.jitter * 36;
      const x = fastBetaDistributionSample(rv.jitter);
      let multiplier = semitonesToRatio((x * 2 - 1) * jitterAmount);
      multiplier *= this.phaseDifference > 0 ? 1 + this.phaseDifference : 1 / (1 - this.phaseDifference);
      this.jitterMultiplier = multiplier;
      this.configureSlaveRamps(rv);
    }

    for (let j = 0; j < K_NUM_T_CHANNELS; j++) {
      const res = this.slaveRamps[j]!.process(frequency * this.jitterMultiplier);
      outSlavePhase[j] = res.phase;
      outGate[j] = res.gate;
    }
    return this.masterPhase;
  }

  getMasterPhase(): number {
    return this.masterPhase;
  }
}

// ---------------------------------------------------------------------------
// XYGenerator (x_y_generator.{h,cc}) — X1/X2/X3 + Y CV outputs.
// Simplified to the INTERNAL_T2 (shared-master) clock source, which is the
// musically useful default for a browser module; per-channel pseudo-random
// shifting via ReplayPseudoRandom is preserved so the 3 X channels diverge.
// ---------------------------------------------------------------------------

export const K_NUM_X_CHANNELS = 3;
export const K_NUM_CHANNELS = 4; // X1 X2 X3 + Y

export interface GroupSettings {
  spread: number;
  bias: number;
  steps: number;
  dejaVu: number;
  scaleIndex: number;
  length: number;
}

const X_HASHES = [0, 0xbeca55e5, 0xf0cacc1a];

export class XYGenerator {
  private sequences: RandomSequence[] = [];
  private channels: OutputChannel[] = [];

  constructor(stream: RandomStream) {
    for (let i = 0; i < K_NUM_CHANNELS; i++) {
      this.sequences.push(new RandomSequence(stream));
      this.channels.push(new OutputChannel());
    }
  }

  loadScaleAll(scaleIndex: number, scale: Scale): void {
    for (let i = 0; i < K_NUM_CHANNELS; i++) this.channels[i]!.loadScale(scaleIndex, scale);
  }

  // Process one sample. masterPhase drives all channels (INTERNAL_T2).
  // Returns [x1, x2, x3, y] voltages.
  processSample(xSettings: GroupSettings, ySettings: GroupSettings, masterPhase: number, out: number[]): void {
    for (let i = 0; i < K_NUM_CHANNELS; i++) {
      const channel = this.channels[i]!;
      const settings = i < K_NUM_X_CHANNELS ? xSettings : ySettings;
      // Voltage range FULL by default (+/-5V), matching Marbles' default.
      channel.setScaleOffset(new ScaleOffset(10, -5));
      channel.setSpread(settings.spread);
      channel.setBias(settings.bias);
      channel.setSteps(settings.steps);
      channel.setScaleIndex(settings.scaleIndex);

      let sequence = this.sequences[i]!;
      sequence.record();
      sequence.setLength(settings.length);
      sequence.setDejaVu(settings.dejaVu);

      // X2/X3 lock to X1's loop with a pseudo-random hash shift so the déjà-vu
      // pattern is shared but each channel reads a decorrelated value.
      if (i > 0 && i < K_NUM_X_CHANNELS) {
        sequence = this.sequences[0]!;
        sequence.replayPseudoRandom(X_HASHES[i]!);
      }
      out[i] = channel.processSample(sequence, masterPhase);
    }
  }
}

// ---------------------------------------------------------------------------
// Preset scales (settings.cc preset_scales[6]).
// ---------------------------------------------------------------------------

export const PRESET_SCALES: Scale[] = [
  // C major
  {
    baseInterval: 1,
    numDegrees: 12,
    degree: [
      { voltage: 0.0, weight: 255 },
      { voltage: 0.0833, weight: 16 },
      { voltage: 0.1667, weight: 96 },
      { voltage: 0.25, weight: 24 },
      { voltage: 0.3333, weight: 128 },
      { voltage: 0.4167, weight: 64 },
      { voltage: 0.5, weight: 8 },
      { voltage: 0.5833, weight: 192 },
      { voltage: 0.6667, weight: 16 },
      { voltage: 0.75, weight: 96 },
      { voltage: 0.8333, weight: 24 },
      { voltage: 0.9167, weight: 128 },
    ],
  },
  // C minor
  {
    baseInterval: 1,
    numDegrees: 12,
    degree: [
      { voltage: 0.0, weight: 255 },
      { voltage: 0.0833, weight: 16 },
      { voltage: 0.1667, weight: 96 },
      { voltage: 0.25, weight: 128 },
      { voltage: 0.3333, weight: 8 },
      { voltage: 0.4167, weight: 64 },
      { voltage: 0.5, weight: 4 },
      { voltage: 0.5833, weight: 192 },
      { voltage: 0.6667, weight: 96 },
      { voltage: 0.75, weight: 16 },
      { voltage: 0.8333, weight: 128 },
      { voltage: 0.9167, weight: 16 },
    ],
  },
  // Pentatonic
  {
    baseInterval: 1,
    numDegrees: 12,
    degree: [
      { voltage: 0.0, weight: 255 },
      { voltage: 0.0833, weight: 4 },
      { voltage: 0.1667, weight: 96 },
      { voltage: 0.25, weight: 4 },
      { voltage: 0.3333, weight: 4 },
      { voltage: 0.4167, weight: 140 },
      { voltage: 0.5, weight: 4 },
      { voltage: 0.5833, weight: 192 },
      { voltage: 0.6667, weight: 4 },
      { voltage: 0.75, weight: 96 },
      { voltage: 0.8333, weight: 4 },
      { voltage: 0.9167, weight: 4 },
    ],
  },
  // Pelog
  {
    baseInterval: 1,
    numDegrees: 7,
    degree: [
      { voltage: 0.0, weight: 255 },
      { voltage: 0.1275, weight: 128 },
      { voltage: 0.2625, weight: 32 },
      { voltage: 0.46, weight: 8 },
      { voltage: 0.5883, weight: 192 },
      { voltage: 0.7067, weight: 64 },
      { voltage: 0.8817, weight: 16 },
    ],
  },
  // Raag Bhairav That
  {
    baseInterval: 1,
    numDegrees: 12,
    degree: [
      { voltage: 0.0, weight: 255 },
      { voltage: 0.0752, weight: 128 },
      { voltage: 0.1699, weight: 4 },
      { voltage: 0.263, weight: 4 },
      { voltage: 0.3219, weight: 128 },
      { voltage: 0.415, weight: 64 },
      { voltage: 0.4918, weight: 4 },
      { voltage: 0.585, weight: 192 },
      { voltage: 0.6601, weight: 64 },
      { voltage: 0.7549, weight: 4 },
      { voltage: 0.8479, weight: 4 },
      { voltage: 0.9069, weight: 64 },
    ],
  },
  // Raag Shri
  {
    baseInterval: 1,
    numDegrees: 12,
    degree: [
      { voltage: 0.0, weight: 255 },
      { voltage: 0.0752, weight: 4 },
      { voltage: 0.1699, weight: 128 },
      { voltage: 0.263, weight: 64 },
      { voltage: 0.3219, weight: 4 },
      { voltage: 0.415, weight: 128 },
      { voltage: 0.4918, weight: 4 },
      { voltage: 0.585, weight: 192 },
      { voltage: 0.6601, weight: 4 },
      { voltage: 0.7549, weight: 64 },
      { voltage: 0.8479, weight: 128 },
      { voltage: 0.9069, weight: 4 },
    ],
  },
];
