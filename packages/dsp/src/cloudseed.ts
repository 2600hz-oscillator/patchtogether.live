// packages/dsp/src/cloudseed.ts
//
// CLOUDSEED — exact algorithm port of Ghost Note Audio's CloudSeed reverb
// (https://github.com/GhostNoteAudio/CloudSeedCore, MIT-licensed,
// Copyright (c) 2024 Ghost Note Engineering Ltd). The C++ source lives at
// /Users/2600hz/Documents/workspace/CloudSeedCore/ (referenced during this
// port); attribution is preserved here per the MIT licence terms.
//
// Architecture (mirrors ReverbController + ReverbChannel verbatim):
//
//   stereo input → channel L / R cross-feed (cm * mix)
//   per channel:
//     HighPass (Hp1, 1-pole) → LowPass (Lp1, 1-pole) [pre-EQ]
//     → ModulatedDelay (pre-delay)
//     → MultitapDelay (early TAPS)
//     → AllpassDiffuser (EARLY DIFFUSION, up to 12 stages)
//     → 12 parallel DelayLine voices (LATE REFLECTIONS) each with:
//         ModulatedDelay → optional AllpassDiffuser (post) → optional
//         LowShelf biquad → HighShelf biquad → Lp1 (in-loop) → feedback
//     → dry + early + lineSum mixed to channel output
//
// Numerical primitives are 1:1 ports of:
//   DSP/Hp1.h, DSP/Lp1.h, DSP/Biquad.h+cpp,
//   DSP/ModulatedAllpass.h, DSP/ModulatedDelay.h,
//   DSP/AllpassDiffuser.h, DSP/MultitapDelay.h, DSP/DelayLine.h,
//   DSP/ReverbChannel.h, DSP/ReverbController.h,
//   DSP/LcgRandom.h, DSP/RandomBuffer.cpp.
//
// Sample-rate-driven safety constants. The C++ uses literal buffer sizes
// (DelayBufferSize = 192_000 * 2 in ModulatedDelay, 19_200 in
// ModulatedAllpass) sized for 192 kHz worst-case — we mirror those so the
// per-block heap allocation matches what the C++ does at construction.

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor(options?: { processorOptions?: unknown });
  process?(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(name: string, ctor: typeof AudioWorkletProcessor): void;

// Block-size constant — Web Audio worklets always call with 128-sample
// frames. The C++ uses BUFFER_SIZE=64 internally and chunks larger blocks.
// We match the Web Audio convention.
const BUFFER_SIZE = 128;

// ============================================================================
// LcgRandom + RandomBuffer (1:1 from DSP/LcgRandom.h + DSP/RandomBuffer.cpp)
// ============================================================================
//
// The C++ uses a 22695477 / 1 LCG (Borland-classic). Per-iteration state
// is computed as (a*x + c) & 0xFFFFFFFF — masked to uint32, then converted
// to a [0..1) float via division by UINT_MAX. We preserve that exactly so
// the seeded random delay-line lengths and the tap positions are
// bit-compatible with the reference implementation.

class LcgRandom {
  // Use BigInt for the inner multiply so the 64-bit intermediate doesn't
  // lose precision; coerce to a uint32 at the end. JavaScript number-mul
  // can lose the low bits past 2^53, which the Borland LCG actively
  // exercises.
  private x: bigint;
  private static readonly A = 22695477n;
  private static readonly C = 1n;
  private static readonly MASK32 = 0xffffffffn;

  constructor(seed: number) {
    this.x = BigInt(seed >>> 0);
  }

  nextUInt(): number {
    this.x = (LcgRandom.A * this.x + LcgRandom.C) & LcgRandom.MASK32;
    return Number(this.x);
  }
}

function randomBufferGenerate(seed: number, count: number): Float32Array {
  // Direct port of RandomBuffer::Generate(seed, count). Each value is
  // (uint32 / UINT_MAX) — note the C++ uses UINT_MAX not UINT32_MAX, and
  // in C++ UINT_MAX is typically 4294967295 (== UINT32_MAX on a 32-bit
  // unsigned int). Match the same divisor.
  const out = new Float32Array(count);
  const rng = new LcgRandom(seed);
  for (let i = 0; i < count; i++) out[i] = rng.nextUInt() / 4294967295;
  return out;
}

function randomBufferGenerateCrossSeed(
  seed: number,
  count: number,
  crossSeed: number,
): Float32Array {
  // Per RandomBuffer::Generate overload: blends two seeded series A + B
  // where B's seed is the bitwise-NOT of A. Implementing as the same
  // 32-bit complement so the seeds match the C++.
  const seedA = seed >>> 0;
  // C++: auto seedB = ~seed (operates on uint64_t but RandomBuffer only
  // uses the low 32 bits before passing to LcgRandom). The LcgRandom ctor
  // stores into a uint64_t but the multiply masks back to 32 — so what
  // matters is the low 32 bits of ~seed, which is the 32-bit complement.
  const seedB = ((~seedA) >>> 0);
  const a = randomBufferGenerate(seedA, count);
  const b = randomBufferGenerate(seedB, count);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = a[i]! * (1 - crossSeed) + b[i]! * crossSeed;
  return out;
}

// ============================================================================
// 1-pole filters Hp1 / Lp1 (1:1 ports of Hp1.h / Lp1.h)
// ============================================================================

class Lp1 {
  private fs: number;
  private b0 = 1;
  private a1 = 0;
  private cutoffHz = 1000;
  output = 0;

  constructor(fs: number) {
    this.fs = fs;
    this.update();
  }

  setSamplerate(fs: number): void { this.fs = fs; this.update(); }
  setCutoffHz(hz: number): void { this.cutoffHz = hz; this.update(); }

  clearBuffers(): void { this.output = 0; }

  private update(): void {
    if (this.cutoffHz >= this.fs * 0.5) this.cutoffHz = this.fs * 0.499;
    const x = (2 * Math.PI * this.cutoffHz) / this.fs;
    const nn = 2 - Math.cos(x);
    const alpha = nn - Math.sqrt(nn * nn - 1);
    this.a1 = alpha;
    this.b0 = 1 - alpha;
  }

  process(input: number): number {
    if (input === 0 && this.output < 1e-7) this.output = 0;
    else this.output = this.b0 * input + this.a1 * this.output;
    return this.output;
  }

  processBlock(input: Float32Array, output: Float32Array, len: number): void {
    for (let i = 0; i < len; i++) output[i] = this.process(input[i]!);
  }
}

class Hp1 {
  private fs: number;
  private b0 = 1;
  private a1 = 0;
  private lpOut = 0;
  private cutoffHz = 100;
  output = 0;

  constructor(fs: number) {
    this.fs = fs;
    this.update();
  }

  setSamplerate(fs: number): void { this.fs = fs; this.update(); }
  setCutoffHz(hz: number): void { this.cutoffHz = hz; this.update(); }

  clearBuffers(): void { this.lpOut = 0; this.output = 0; }

  private update(): void {
    if (this.cutoffHz >= this.fs * 0.5) this.cutoffHz = this.fs * 0.499;
    const x = (2 * Math.PI * this.cutoffHz) / this.fs;
    const nn = 2 - Math.cos(x);
    const alpha = nn - Math.sqrt(nn * nn - 1);
    this.a1 = alpha;
    this.b0 = 1 - alpha;
  }

  process(input: number): number {
    if (input === 0 && this.lpOut < 1e-6) {
      this.output = 0;
    } else {
      this.lpOut = this.b0 * input + this.a1 * this.lpOut;
      this.output = input - this.lpOut;
    }
    return this.output;
  }

  processBlock(input: Float32Array, output: Float32Array, len: number): void {
    for (let i = 0; i < len; i++) output[i] = this.process(input[i]!);
  }
}

// ============================================================================
// Biquad (1:1 from Biquad.h + Biquad.cpp). Only LowShelf + HighShelf are
// exercised by CloudSeed's late-line EQ; the full filter-type enum is
// included so the port is faithful + the unit test can verify the same
// formulas.
// ============================================================================

const enum BiquadType {
  LowPass6db = 0,
  HighPass6db,
  LowPass,
  HighPass,
  BandPass,
  Notch,
  Peak,
  LowShelf,
  HighShelf,
}

class Biquad {
  type: BiquadType;
  private fs: number;
  private fsInv: number;
  private gainDB = 0;
  private q = 0.5;
  // gain (linear) is tracked but not used outside SetGain
  // private gain = 1;
  private a1 = 0;
  private a2 = 0;
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y = 0;
  private y1 = 0;
  private y2 = 0;
  output = 0;
  frequency: number;

  constructor(type: BiquadType, fs: number) {
    this.type = type;
    this.fs = fs;
    this.fsInv = 1 / fs;
    this.frequency = fs * 0.25;
    this.update();
    this.clearBuffers();
  }

  setSamplerate(fs: number): void {
    this.fs = fs;
    this.fsInv = 1 / fs;
    this.update();
  }

  setGainDb(value: number): void {
    if (value < -60) value = -60;
    else if (value > 60) value = 60;
    this.gainDB = value;
  }

  setQ(value: number): void {
    if (value < 0.001) value = 0.001;
    this.q = value;
  }

  update(): void {
    const Fc = this.frequency;
    const V = Math.pow(10, Math.abs(this.gainDB) / 20);
    const K = Math.tan(Math.PI * Fc * this.fsInv);
    const Q = this.q;
    let norm = 1;
    switch (this.type) {
      case BiquadType.LowPass6db:
        this.a1 = -Math.exp(-2 * Math.PI * Fc * this.fsInv);
        this.b0 = 1 + this.a1;
        this.b1 = this.b2 = this.a2 = 0;
        break;
      case BiquadType.HighPass6db:
        this.a1 = -Math.exp(-2 * Math.PI * Fc * this.fsInv);
        this.b0 = this.a1;
        this.b1 = -this.a1;
        this.b2 = this.a2 = 0;
        break;
      case BiquadType.LowPass:
        norm = 1 / (1 + K / Q + K * K);
        this.b0 = K * K * norm;
        this.b1 = 2 * this.b0;
        this.b2 = this.b0;
        this.a1 = 2 * (K * K - 1) * norm;
        this.a2 = (1 - K / Q + K * K) * norm;
        break;
      case BiquadType.HighPass:
        norm = 1 / (1 + K / Q + K * K);
        this.b0 = 1 * norm;
        this.b1 = -2 * this.b0;
        this.b2 = this.b0;
        this.a1 = 2 * (K * K - 1) * norm;
        this.a2 = (1 - K / Q + K * K) * norm;
        break;
      case BiquadType.BandPass:
        norm = 1 / (1 + K / Q + K * K);
        this.b0 = (K / Q) * norm;
        this.b1 = 0;
        this.b2 = -this.b0;
        this.a1 = 2 * (K * K - 1) * norm;
        this.a2 = (1 - K / Q + K * K) * norm;
        break;
      case BiquadType.Notch:
        norm = 1 / (1 + K / Q + K * K);
        this.b0 = (1 + K * K) * norm;
        this.b1 = 2 * (K * K - 1) * norm;
        this.b2 = this.b0;
        this.a1 = this.b1;
        this.a2 = (1 - K / Q + K * K) * norm;
        break;
      case BiquadType.Peak:
        if (this.gainDB >= 0) {
          norm = 1 / (1 + (1 / Q) * K + K * K);
          this.b0 = (1 + (V / Q) * K + K * K) * norm;
          this.b1 = 2 * (K * K - 1) * norm;
          this.b2 = (1 - (V / Q) * K + K * K) * norm;
          this.a1 = this.b1;
          this.a2 = (1 - (1 / Q) * K + K * K) * norm;
        } else {
          norm = 1 / (1 + (V / Q) * K + K * K);
          this.b0 = (1 + (1 / Q) * K + K * K) * norm;
          this.b1 = 2 * (K * K - 1) * norm;
          this.b2 = (1 - (1 / Q) * K + K * K) * norm;
          this.a1 = this.b1;
          this.a2 = (1 - (V / Q) * K + K * K) * norm;
        }
        break;
      case BiquadType.LowShelf:
        if (this.gainDB >= 0) {
          norm = 1 / (1 + Math.sqrt(2) * K + K * K);
          this.b0 = (1 + Math.sqrt(2 * V) * K + V * K * K) * norm;
          this.b1 = 2 * (V * K * K - 1) * norm;
          this.b2 = (1 - Math.sqrt(2 * V) * K + V * K * K) * norm;
          this.a1 = 2 * (K * K - 1) * norm;
          this.a2 = (1 - Math.sqrt(2) * K + K * K) * norm;
        } else {
          norm = 1 / (1 + Math.sqrt(2 * V) * K + V * K * K);
          this.b0 = (1 + Math.sqrt(2) * K + K * K) * norm;
          this.b1 = 2 * (K * K - 1) * norm;
          this.b2 = (1 - Math.sqrt(2) * K + K * K) * norm;
          this.a1 = 2 * (V * K * K - 1) * norm;
          this.a2 = (1 - Math.sqrt(2 * V) * K + V * K * K) * norm;
        }
        break;
      case BiquadType.HighShelf:
        if (this.gainDB >= 0) {
          norm = 1 / (1 + Math.sqrt(2) * K + K * K);
          this.b0 = (V + Math.sqrt(2 * V) * K + K * K) * norm;
          this.b1 = 2 * (K * K - V) * norm;
          this.b2 = (V - Math.sqrt(2 * V) * K + K * K) * norm;
          this.a1 = 2 * (K * K - 1) * norm;
          this.a2 = (1 - Math.sqrt(2) * K + K * K) * norm;
        } else {
          norm = 1 / (V + Math.sqrt(2 * V) * K + K * K);
          this.b0 = (1 + Math.sqrt(2) * K + K * K) * norm;
          this.b1 = 2 * (K * K - 1) * norm;
          this.b2 = (1 - Math.sqrt(2) * K + K * K) * norm;
          this.a1 = 2 * (K * K - V) * norm;
          this.a2 = (V - Math.sqrt(2 * V) * K + K * K) * norm;
        }
        break;
    }
  }

  clearBuffers(): void {
    this.y = this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }

  process(x: number): number {
    this.y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.y2 = this.y1;
    this.x1 = x;
    this.y1 = this.y;
    this.output = this.y;
    return this.y;
  }

  processBlock(input: Float32Array, output: Float32Array, len: number): void {
    for (let i = 0; i < len; i++) output[i] = this.process(input[i]!);
  }
}

// ============================================================================
// ModulatedAllpass (1:1 from ModulatedAllpass.h)
// ============================================================================

class ModulatedAllpass {
  static readonly DelayBufferSize = 19200; // 100ms at 192Khz, matches C++
  static readonly ModulationUpdateRate = 8;

  private delayBuffer = new Float32Array(ModulatedAllpass.DelayBufferSize);
  private index = ModulatedAllpass.DelayBufferSize - 1;
  private samplesProcessed = 0;
  private modPhase: number;
  private delayA = 0;
  private delayB = 0;
  private gainA = 0;
  private gainB = 0;

  sampleDelay = 100;
  feedback = 0.5;
  modAmount = 0;
  modRate = 0;

  interpolationEnabled = true;
  modulationEnabled = true;

  constructor() {
    this.modPhase = 0.01 + 0.98 * Math.random();
    this.update();
  }

  clearBuffers(): void {
    this.delayBuffer.fill(0);
  }

  process(input: Float32Array, output: Float32Array, count: number): void {
    if (this.modulationEnabled) this.processWithMod(input, output, count);
    else this.processNoMod(input, output, count);
  }

  private processNoMod(input: Float32Array, output: Float32Array, count: number): void {
    const size = ModulatedAllpass.DelayBufferSize;
    let idx = this.index;
    let dIdx = idx - this.sampleDelay;
    if (dIdx < 0) dIdx += size;
    const fb = this.feedback;
    for (let i = 0; i < count; i++) {
      const bufOut = this.delayBuffer[dIdx]!;
      const inVal = input[i]! + bufOut * fb;
      this.delayBuffer[idx] = inVal;
      output[i] = bufOut - inVal * fb;
      idx++;
      dIdx++;
      if (idx >= size) idx -= size;
      if (dIdx >= size) dIdx -= size;
      this.samplesProcessed++;
    }
    this.index = idx;
  }

  private processWithMod(input: Float32Array, output: Float32Array, count: number): void {
    const size = ModulatedAllpass.DelayBufferSize;
    let idx = this.index;
    const fb = this.feedback;
    for (let i = 0; i < count; i++) {
      if (this.samplesProcessed >= ModulatedAllpass.ModulationUpdateRate) {
        this.update();
        this.samplesProcessed = 0;
      }
      let bufOut: number;
      if (this.interpolationEnabled) {
        let iA = idx - this.delayA;
        let iB = idx - this.delayB;
        if (iA < 0) iA += size;
        if (iB < 0) iB += size;
        bufOut = this.delayBuffer[iA]! * this.gainA + this.delayBuffer[iB]! * this.gainB;
      } else {
        let iA = idx - this.delayA;
        if (iA < 0) iA += size;
        bufOut = this.delayBuffer[iA]!;
      }
      const inVal = input[i]! + bufOut * fb;
      this.delayBuffer[idx] = inVal;
      output[i] = bufOut - inVal * fb;
      idx++;
      if (idx >= size) idx -= size;
      this.samplesProcessed++;
    }
    this.index = idx;
  }

  private update(): void {
    this.modPhase += this.modRate * ModulatedAllpass.ModulationUpdateRate;
    if (this.modPhase > 1) this.modPhase = this.modPhase % 1;
    const mod = Math.sin(this.modPhase * 2 * Math.PI);
    if (this.modAmount >= this.sampleDelay) this.modAmount = this.sampleDelay - 1;
    let totalDelay = this.sampleDelay + this.modAmount * mod;
    if (totalDelay <= 0) totalDelay = 1;
    this.delayA = totalDelay | 0;
    this.delayB = this.delayA + 1;
    const partial = totalDelay - this.delayA;
    this.gainA = 1 - partial;
    this.gainB = partial;
  }
}

// ============================================================================
// ModulatedDelay (1:1 from ModulatedDelay.h)
// ============================================================================

class ModulatedDelay {
  private static readonly ModulationUpdateRate = 8;
  // The C++ allocates 192000*2 floats (~1.5 MB). For browser worklets we
  // size the buffer based on the actual runtime sample rate — 4 seconds is
  // ample for CloudSeed's 0..500 ms predelay range.
  private delayBuffer: Float32Array;
  private bufSize: number;
  private writeIndex = 0;
  private readIndexA = 0;
  private readIndexB = 0;
  private samplesProcessed = 0;
  private modPhase: number;
  private gainA = 0;
  private gainB = 0;

  sampleDelay = 100;
  modAmount = 0;
  modRate = 0;

  constructor(maxSamples: number) {
    this.bufSize = Math.max(64, maxSamples);
    this.delayBuffer = new Float32Array(this.bufSize);
    this.modPhase = 0.01 + 0.98 * Math.random();
    this.update();
  }

  process(input: Float32Array, output: Float32Array, count: number): void {
    const size = this.bufSize;
    for (let i = 0; i < count; i++) {
      if (this.samplesProcessed >= ModulatedDelay.ModulationUpdateRate) {
        this.update();
        this.samplesProcessed = 0;
      }
      this.delayBuffer[this.writeIndex] = input[i]!;
      output[i] = this.delayBuffer[this.readIndexA]! * this.gainA
        + this.delayBuffer[this.readIndexB]! * this.gainB;
      this.writeIndex++;
      this.readIndexA++;
      this.readIndexB++;
      if (this.writeIndex >= size) this.writeIndex -= size;
      if (this.readIndexA >= size) this.readIndexA -= size;
      if (this.readIndexB >= size) this.readIndexB -= size;
      this.samplesProcessed++;
    }
  }

  clearBuffers(): void {
    this.delayBuffer.fill(0);
  }

  private update(): void {
    this.modPhase += this.modRate * ModulatedDelay.ModulationUpdateRate;
    if (this.modPhase > 1) this.modPhase = this.modPhase % 1;
    const mod = Math.sin(this.modPhase * 2 * Math.PI);
    const totalDelay = this.sampleDelay + this.modAmount * mod;
    const dA = totalDelay | 0;
    const dB = dA + 1;
    const partial = totalDelay - dA;
    this.gainA = 1 - partial;
    this.gainB = partial;
    let rA = this.writeIndex - dA;
    let rB = this.writeIndex - dB;
    if (rA < 0) rA += this.bufSize;
    if (rB < 0) rB += this.bufSize;
    this.readIndexA = rA;
    this.readIndexB = rB;
  }
}

// ============================================================================
// AllpassDiffuser (1:1 from AllpassDiffuser.h)
// ============================================================================

class AllpassDiffuser {
  static readonly MaxStageCount = 12;

  private samplerate: number;
  private filters: ModulatedAllpass[];
  private delay = 100;
  private modRate = 0;
  private seedValues: Float32Array;
  private seed = 23456;
  private crossSeed = 0;

  stages = 1;

  constructor(samplerate: number) {
    this.samplerate = samplerate;
    this.filters = [];
    for (let i = 0; i < AllpassDiffuser.MaxStageCount; i++) {
      this.filters.push(new ModulatedAllpass());
    }
    this.seedValues = new Float32Array(0);
    this.updateSeeds();
  }

  setSamplerate(sr: number): void {
    this.samplerate = sr;
    this.setModRate(this.modRate);
  }
  setSeed(seed: number): void { this.seed = seed; this.updateSeeds(); }
  setCrossSeed(cs: number): void { this.crossSeed = cs; this.updateSeeds(); }
  setModulationEnabled(v: boolean): void {
    for (const f of this.filters) f.modulationEnabled = v;
  }
  setInterpolationEnabled(v: boolean): void {
    for (const f of this.filters) f.interpolationEnabled = v;
  }
  setDelay(d: number): void { this.delay = d; this.update(); }
  setFeedback(fb: number): void {
    for (const f of this.filters) f.feedback = fb;
  }
  setModAmount(amount: number): void {
    for (let i = 0; i < AllpassDiffuser.MaxStageCount; i++) {
      this.filters[i]!.modAmount = amount * (0.85 + 0.3 * this.seedValues[AllpassDiffuser.MaxStageCount + i]!);
    }
  }
  setModRate(rate: number): void {
    this.modRate = rate;
    for (let i = 0; i < AllpassDiffuser.MaxStageCount; i++) {
      this.filters[i]!.modRate = rate * (0.85 + 0.3 * this.seedValues[AllpassDiffuser.MaxStageCount * 2 + i]!) / this.samplerate;
    }
  }

  process(input: Float32Array, output: Float32Array, count: number): void {
    // Match C++ semantics: filter[0] reads from `input`, then filters
    // [1..Stages-1] each chain-process tempBuffer in-place. If Stages==1
    // we copy filter[0]'s output to `output`.
    const temp = AllpassDiffuser._tempBlock;
    const tmp = temp.length >= count ? temp : (AllpassDiffuser._tempBlock = new Float32Array(count));
    this.filters[0]!.process(input, tmp, count);
    for (let i = 1; i < this.stages; i++) {
      this.filters[i]!.process(tmp, tmp, count);
    }
    for (let i = 0; i < count; i++) output[i] = tmp[i]!;
  }

  clearBuffers(): void {
    for (const f of this.filters) f.clearBuffers();
  }

  private update(): void {
    for (let i = 0; i < AllpassDiffuser.MaxStageCount; i++) {
      const r = this.seedValues[i]!;
      const d = Math.pow(10, r) * 0.1; // 0.1 .. 1.0
      this.filters[i]!.sampleDelay = (this.delay * d) | 0;
    }
  }

  private updateSeeds(): void {
    this.seedValues = randomBufferGenerateCrossSeed(this.seed, AllpassDiffuser.MaxStageCount * 3, this.crossSeed);
    this.update();
  }

  private static _tempBlock = new Float32Array(BUFFER_SIZE);
}

// ============================================================================
// MultitapDelay (1:1 from MultitapDelay.h)
// ============================================================================

class MultitapDelay {
  static readonly MaxTaps = 256;
  // C++ buffer is 192000*2; size at runtime by the caller's max length.
  private delayBuffer: Float32Array;
  private bufSize: number;
  private tapGains = new Float32Array(MultitapDelay.MaxTaps);
  private tapPosition = new Float32Array(MultitapDelay.MaxTaps);
  private seedValues: Float32Array;
  private writeIdx = 0;
  private seed = 0;
  private crossSeed = 0;
  private count = 1;
  private lengthSamples = 1000;
  private decay = 1;

  constructor(maxSamples: number) {
    this.bufSize = Math.max(64, maxSamples);
    this.delayBuffer = new Float32Array(this.bufSize);
    this.seedValues = new Float32Array(0);
    this.updateSeeds();
  }

  setSeed(seed: number): void { this.seed = seed; this.updateSeeds(); }
  setCrossSeed(cs: number): void { this.crossSeed = cs; this.updateSeeds(); }
  setTapCount(c: number): void {
    if (c < 1) c = 1;
    this.count = c;
    this.update();
  }
  setTapLength(samples: number): void {
    if (samples < 10) samples = 10;
    this.lengthSamples = samples;
    this.update();
  }
  setTapDecay(d: number): void { this.decay = d; }

  process(input: Float32Array, output: Float32Array, bufSize: number): void {
    const size = this.bufSize;
    const count = this.count;
    const lengthScaler = this.lengthSamples / count;
    let totalGain = 3.0 / Math.sqrt(1 + count);
    totalGain *= (1 + this.decay * 2);
    const decay = this.decay;
    const oneMinusDecay = 1 - decay;
    const invLen = 1 / this.lengthSamples;
    for (let i = 0; i < bufSize; i++) {
      this.delayBuffer[this.writeIdx] = input[i]!;
      let sum = 0;
      for (let j = 0; j < count; j++) {
        const offset = this.tapPosition[j]! * lengthScaler;
        const decayEffective = Math.exp(-offset * invLen * 3.3) * decay + oneMinusDecay;
        let readIdx = this.writeIdx - (offset | 0);
        if (readIdx < 0) readIdx += size;
        sum += this.delayBuffer[readIdx]! * this.tapGains[j]! * decayEffective * totalGain;
      }
      output[i] = sum;
      this.writeIdx = (this.writeIdx + 1) % size;
    }
  }

  clearBuffers(): void { this.delayBuffer.fill(0); }

  private update(): void {
    // Matches MultitapDelay::Update — for every potential tap, sample three
    // seeded random values (phase, gainDb, position-jitter). Strictly: tap j
    // consumes seedValues[3j], [3j+1], [3j+2].
    let s = 0;
    for (let i = 0; i < MultitapDelay.MaxTaps; i++) {
      const a = this.seedValues[s++]!;
      const b = this.seedValues[s++]!;
      const c = this.seedValues[s++]!;
      const phase = a < 0.5 ? 1 : -1;
      this.tapGains[i] = Math.pow(10, (-20 + b * 20) / 20) * phase; // DB2Gainf
      this.tapPosition[i] = i + c;
    }
  }

  private updateSeeds(): void {
    this.seedValues = randomBufferGenerateCrossSeed(this.seed, MultitapDelay.MaxTaps * 3, this.crossSeed);
    this.update();
  }
}

// ============================================================================
// DelayLine (1:1 from DelayLine.h). Each ReverbChannel runs 12 of these in
// parallel for the late-reflection field. CircularBuffer<2*BUFFER_SIZE> in
// the C++ holds the per-block feedback buffer — we use a length-2N
// Float32Array with explicit read/write counters.
// ============================================================================

class DelayLine {
  private delay: ModulatedDelay;
  private diffuser: AllpassDiffuser;
  private lowShelf: Biquad;
  private highShelf: Biquad;
  private lowPass: Lp1;
  // CircularBuffer<2*BUFFER_SIZE> — a 2-block ring used to pop the previous
  // block's tail and re-feed it as the next block's feedback. Direct port.
  private fbBuf: Float32Array;
  private fbRead = 0;
  private fbWrite = 0;
  private fbCount = 0;
  private feedback = 0;

  diffuserEnabled = false;
  lowShelfEnabled = false;
  highShelfEnabled = false;
  cutoffEnabled = false;
  tapPostDiffuser = false;

  constructor(samplerate: number, predelayMaxSamples: number) {
    this.delay = new ModulatedDelay(predelayMaxSamples);
    this.diffuser = new AllpassDiffuser(samplerate);
    this.lowShelf = new Biquad(BiquadType.LowShelf, samplerate);
    this.highShelf = new Biquad(BiquadType.HighShelf, samplerate);
    this.lowPass = new Lp1(samplerate);
    this.lowShelf.setGainDb(-20);
    this.lowShelf.frequency = 20;
    this.highShelf.setGainDb(-20);
    this.highShelf.frequency = 19000;
    this.lowPass.setCutoffHz(1000);
    this.lowShelf.update();
    this.highShelf.update();
    this.setDiffuserSeed(1, 0);
    this.fbBuf = new Float32Array(BUFFER_SIZE * 2);
  }

  setSamplerate(sr: number): void {
    this.diffuser.setSamplerate(sr);
    this.lowPass.setSamplerate(sr);
    this.lowShelf.setSamplerate(sr);
    this.highShelf.setSamplerate(sr);
  }

  setDiffuserSeed(seed: number, crossSeed: number): void {
    this.diffuser.setSeed(seed);
    this.diffuser.setCrossSeed(crossSeed);
  }

  setDelay(d: number): void { this.delay.sampleDelay = d; }
  setFeedback(fb: number): void { this.feedback = fb; }
  setDiffuserDelay(d: number): void { this.diffuser.setDelay(d); }
  setDiffuserFeedback(fb: number): void { this.diffuser.setFeedback(fb); }
  setDiffuserStages(s: number): void { this.diffuser.stages = s; }
  setLowShelfGain(g: number): void { this.lowShelf.setGainDb(g); this.lowShelf.update(); }
  setLowShelfFrequency(f: number): void { this.lowShelf.frequency = f; this.lowShelf.update(); }
  setHighShelfGain(g: number): void { this.highShelf.setGainDb(g); this.highShelf.update(); }
  setHighShelfFrequency(f: number): void { this.highShelf.frequency = f; this.highShelf.update(); }
  setCutoffFrequency(f: number): void { this.lowPass.setCutoffHz(f); }
  setLineModAmount(a: number): void { this.delay.modAmount = a; }
  setLineModRate(r: number): void { this.delay.modRate = r; }
  setDiffuserModAmount(a: number): void {
    this.diffuser.setModulationEnabled(a > 0);
    this.diffuser.setModAmount(a);
  }
  setDiffuserModRate(r: number): void { this.diffuser.setModRate(r); }
  setInterpolationEnabled(v: boolean): void { this.diffuser.setInterpolationEnabled(v); }

  process(input: Float32Array, output: Float32Array, bufSize: number): void {
    const temp = DelayLine._tempA;
    const tmp = temp.length >= bufSize ? temp : (DelayLine._tempA = new Float32Array(bufSize));
    // Pop bufSize from the feedback ring (zero-pad on underflow).
    for (let i = 0; i < bufSize; i++) {
      if (this.fbCount > 0) {
        tmp[i] = this.fbBuf[this.fbRead]!;
        this.fbRead = (this.fbRead + 1) % this.fbBuf.length;
        this.fbCount--;
      } else {
        tmp[i] = 0;
      }
    }
    for (let i = 0; i < bufSize; i++) tmp[i] = input[i]! + tmp[i]! * this.feedback;
    this.delay.process(tmp, tmp, bufSize);
    if (!this.tapPostDiffuser) {
      for (let i = 0; i < bufSize; i++) output[i] = tmp[i]!;
    }
    if (this.diffuserEnabled) this.diffuser.process(tmp, tmp, bufSize);
    if (this.lowShelfEnabled) this.lowShelf.processBlock(tmp, tmp, bufSize);
    if (this.highShelfEnabled) this.highShelf.processBlock(tmp, tmp, bufSize);
    if (this.cutoffEnabled) this.lowPass.processBlock(tmp, tmp, bufSize);
    // Push bufSize into feedback ring (overflow drops).
    for (let i = 0; i < bufSize; i++) {
      if (this.fbCount < this.fbBuf.length) {
        this.fbBuf[this.fbWrite] = tmp[i]!;
        this.fbWrite = (this.fbWrite + 1) % this.fbBuf.length;
        this.fbCount++;
      }
    }
    if (this.tapPostDiffuser) {
      for (let i = 0; i < bufSize; i++) output[i] = tmp[i]!;
    }
  }

  clearDiffuserBuffer(): void { this.diffuser.clearBuffers(); }

  clearBuffers(): void {
    this.delay.clearBuffers();
    this.diffuser.clearBuffers();
    this.lowShelf.clearBuffers();
    this.highShelf.clearBuffers();
    this.lowPass.clearBuffers();
    this.fbBuf.fill(0);
    this.fbRead = 0;
    this.fbWrite = 0;
    this.fbCount = 0;
  }

  private static _tempA = new Float32Array(BUFFER_SIZE);
}

// ============================================================================
// Parameter enum (1:1 from Parameters.h)
// ============================================================================
export const Param = {
  Interpolation: 0,
  LowCutEnabled: 1,
  HighCutEnabled: 2,
  InputMix: 3,
  LowCut: 4,
  HighCut: 5,
  DryOut: 6,
  EarlyOut: 7,
  LateOut: 8,
  TapEnabled: 9,
  TapCount: 10,
  TapDecay: 11,
  TapPredelay: 12,
  TapLength: 13,
  EarlyDiffuseEnabled: 14,
  EarlyDiffuseCount: 15,
  EarlyDiffuseDelay: 16,
  EarlyDiffuseModAmount: 17,
  EarlyDiffuseFeedback: 18,
  EarlyDiffuseModRate: 19,
  LateMode: 20,
  LateLineCount: 21,
  LateDiffuseEnabled: 22,
  LateDiffuseCount: 23,
  LateLineSize: 24,
  LateLineModAmount: 25,
  LateDiffuseDelay: 26,
  LateDiffuseModAmount: 27,
  LateLineDecay: 28,
  LateLineModRate: 29,
  LateDiffuseFeedback: 30,
  LateDiffuseModRate: 31,
  EqLowShelfEnabled: 32,
  EqHighShelfEnabled: 33,
  EqLowpassEnabled: 34,
  EqLowFreq: 35,
  EqHighFreq: 36,
  EqCutoff: 37,
  EqLowGain: 38,
  EqHighGain: 39,
  EqCrossSeed: 40,
  SeedTap: 41,
  SeedDiffusion: 42,
  SeedDelay: 43,
  SeedPostDiffusion: 44,
  COUNT: 45,
} as const;

// 1:1 port of ScaleParam from Parameters.h. Pure function; used to map
// the host-visible 0..1 knob value to the internal "scaled" engineering
// units the ReverbChannel sets.
const DEC1 = (10 / 9) * 0.1;
const DEC2 = (100 / 99) * 0.01;
const DEC3 = (1000 / 999) * 0.001;
const OCT2 = (4 / 3) * 0.25;
const OCT3 = (8 / 7) * 0.125;
const OCT4 = (16 / 15) * 0.0625;
function resp1dec(x: number): number { return (Math.pow(10, x) - 1) * DEC1; }
function resp2dec(x: number): number { return (Math.pow(10, 2 * x) - 1) * DEC2; }
function resp3dec(x: number): number { return (Math.pow(10, 3 * x) - 1) * DEC3; }
function resp2oct(x: number): number { return (Math.pow(2, 2 * x) - 1) * OCT2; }
function resp3oct(x: number): number { return (Math.pow(2, 3 * x) - 1) * OCT3; }
function resp4oct(x: number): number { return (Math.pow(2, 4 * x) - 1) * OCT4; }

export function scaleParam(val: number, index: number): number {
  switch (index) {
    case Param.Interpolation:
    case Param.LowCutEnabled:
    case Param.HighCutEnabled:
    case Param.TapEnabled:
    case Param.LateDiffuseEnabled:
    case Param.EqLowShelfEnabled:
    case Param.EqHighShelfEnabled:
    case Param.EqLowpassEnabled:
    case Param.EarlyDiffuseEnabled:
      return val < 0.5 ? 0 : 1;

    case Param.InputMix:
    case Param.EarlyDiffuseFeedback:
    case Param.TapDecay:
    case Param.LateDiffuseFeedback:
    case Param.EqCrossSeed:
      return val;

    case Param.SeedTap:
    case Param.SeedDiffusion:
    case Param.SeedDelay:
    case Param.SeedPostDiffusion:
      return Math.floor(val * 999.999);

    case Param.LowCut:    return 20 + resp4oct(val) * 980;
    case Param.HighCut:   return 400 + resp4oct(val) * 19600;
    case Param.DryOut:
    case Param.EarlyOut:
    case Param.LateOut:   return -30 + val * 30;

    case Param.TapCount:    return Math.floor(1 + val * 255);
    case Param.TapPredelay: return resp1dec(val) * 500;
    case Param.TapLength:   return 10 + val * 990;

    case Param.EarlyDiffuseCount:     return Math.floor(1 + val * 11.999);
    case Param.EarlyDiffuseDelay:     return 10 + val * 90;
    case Param.EarlyDiffuseModAmount: return val * 2.5;
    case Param.EarlyDiffuseModRate:   return resp2dec(val) * 5;

    case Param.LateMode:               return val < 0.5 ? 0 : 1;
    case Param.LateLineCount:          return Math.floor(1 + val * 11.999);
    case Param.LateDiffuseCount:       return Math.floor(1 + val * 7.999);
    case Param.LateLineSize:           return 20 + resp2dec(val) * 980;
    case Param.LateLineModAmount:      return val * 2.5;
    case Param.LateDiffuseDelay:       return 10 + val * 90;
    case Param.LateDiffuseModAmount:   return val * 2.5;
    case Param.LateLineDecay:          return 0.05 + resp3dec(val) * 59.95;
    case Param.LateLineModRate:        return resp2dec(val) * 5;
    case Param.LateDiffuseModRate:     return resp2dec(val) * 5;

    case Param.EqLowFreq:  return 20 + resp3oct(val) * 980;
    case Param.EqHighFreq: return 400 + resp4oct(val) * 19600;
    case Param.EqCutoff:   return 400 + resp4oct(val) * 19600;
    case Param.EqLowGain:  return -20 + val * 20;
    case Param.EqHighGain: return -20 + val * 20;
  }
  return 0;
}

// ============================================================================
// ReverbChannel (1:1 from ReverbChannel.h)
// ============================================================================

export type ChannelLR = 'L' | 'R';

export class ReverbChannel {
  static readonly TotalLineCount = 12;

  paramsScaled = new Float32Array(Param.COUNT);
  private samplerate: number;

  // The C++ DSP/ReverbChannel.h uses fixed buffers (192000*2 floats) for
  // pre-delay and 192000*2 for multitap. We size relative to the worklet's
  // sample-rate at construction time: 4 s of headroom covers max predelay
  // (500ms) and max tap length (1000ms) with margin.
  private preDelay: ModulatedDelay;
  private multitap: MultitapDelay;
  private diffuser: AllpassDiffuser;
  private lines: DelayLine[];
  private highPass: Hp1;
  private lowPass: Lp1;

  private delayLineSeed = 0;
  private postDiffusionSeed = 0;
  private lineCount = 8;
  private lowCutEnabled = false;
  private highCutEnabled = false;
  private multitapEnabled = false;
  private diffuserEnabled = false;
  // private inputMix = 0;
  dryOut = 0;
  earlyOut = 0;
  lineOut = 0;
  private crossSeed = 0;
  private channelLr: ChannelLR;

  constructor(samplerate: number, lr: ChannelLR) {
    this.channelLr = lr;
    this.samplerate = samplerate;
    const seconds4 = Math.floor(samplerate * 4);
    this.preDelay = new ModulatedDelay(seconds4);
    this.multitap = new MultitapDelay(seconds4);
    this.diffuser = new AllpassDiffuser(samplerate);
    this.diffuser.setInterpolationEnabled(true);
    this.lines = [];
    for (let i = 0; i < ReverbChannel.TotalLineCount; i++) {
      this.lines.push(new DelayLine(samplerate, seconds4));
    }
    this.highPass = new Hp1(samplerate);
    this.lowPass = new Lp1(samplerate);
    this.highPass.setCutoffHz(20);
    this.lowPass.setCutoffHz(20000);
  }

  setSamplerate(sr: number): void {
    this.samplerate = sr;
    this.highPass.setSamplerate(sr);
    this.lowPass.setSamplerate(sr);
    this.diffuser.setSamplerate(sr);
    for (const l of this.lines) l.setSamplerate(sr);
    this.reapplyAllParams();
    this.clearBuffers();
    this.updateLines();
  }

  reapplyAllParams(): void {
    for (let i = 0; i < Param.COUNT; i++) this.setParameter(i, this.paramsScaled[i]!);
  }

  private ms2Samples(ms: number): number { return (ms / 1000) * this.samplerate; }

  setParameter(para: number, scaled: number): void {
    this.paramsScaled[para] = scaled;
    switch (para) {
      case Param.Interpolation:
        for (const l of this.lines) l.setInterpolationEnabled(scaled >= 0.5);
        break;
      case Param.LowCutEnabled:
        this.lowCutEnabled = scaled >= 0.5;
        if (this.lowCutEnabled) this.highPass.clearBuffers();
        break;
      case Param.HighCutEnabled:
        this.highCutEnabled = scaled >= 0.5;
        if (this.highCutEnabled) this.lowPass.clearBuffers();
        break;
      case Param.InputMix:
        // inputMix is consumed at the controller layer (cross-feed mix).
        break;
      case Param.LowCut:
        this.highPass.setCutoffHz(scaled);
        break;
      case Param.HighCut:
        this.lowPass.setCutoffHz(scaled);
        break;
      case Param.DryOut:
        this.dryOut = scaled <= -30 ? 0 : Math.pow(10, scaled / 20);
        break;
      case Param.EarlyOut:
        this.earlyOut = scaled <= -30 ? 0 : Math.pow(10, scaled / 20);
        break;
      case Param.LateOut:
        this.lineOut = scaled <= -30 ? 0 : Math.pow(10, scaled / 20);
        break;

      case Param.TapEnabled: {
        const v = scaled >= 0.5;
        if (v !== this.multitapEnabled) this.multitap.clearBuffers();
        this.multitapEnabled = v;
        break;
      }
      case Param.TapCount:    this.multitap.setTapCount(scaled | 0); break;
      case Param.TapDecay:    this.multitap.setTapDecay(scaled); break;
      case Param.TapPredelay: this.preDelay.sampleDelay = this.ms2Samples(scaled) | 0; break;
      case Param.TapLength:   this.multitap.setTapLength(this.ms2Samples(scaled) | 0); break;

      case Param.EarlyDiffuseEnabled: {
        const v = scaled >= 0.5;
        if (v !== this.diffuserEnabled) this.diffuser.clearBuffers();
        this.diffuserEnabled = v;
        break;
      }
      case Param.EarlyDiffuseCount:     this.diffuser.stages = scaled | 0; break;
      case Param.EarlyDiffuseDelay:     this.diffuser.setDelay(this.ms2Samples(scaled) | 0); break;
      case Param.EarlyDiffuseModAmount:
        this.diffuser.setModulationEnabled(scaled > 0.5);
        this.diffuser.setModAmount(this.ms2Samples(scaled));
        break;
      case Param.EarlyDiffuseFeedback:  this.diffuser.setFeedback(scaled); break;
      case Param.EarlyDiffuseModRate:   this.diffuser.setModRate(scaled); break;

      case Param.LateMode:
        for (const l of this.lines) l.tapPostDiffuser = scaled >= 0.5;
        break;
      case Param.LateLineCount: this.lineCount = scaled | 0; break;
      case Param.LateDiffuseEnabled: {
        const v = scaled >= 0.5;
        for (const l of this.lines) {
          if (v !== l.diffuserEnabled) l.clearDiffuserBuffer();
          l.diffuserEnabled = v;
        }
        break;
      }
      case Param.LateDiffuseCount:
        for (const l of this.lines) l.setDiffuserStages(scaled | 0);
        break;
      case Param.LateLineSize:
      case Param.LateLineModAmount:
      case Param.LateDiffuseModAmount:
      case Param.LateLineDecay:
      case Param.LateLineModRate:
      case Param.LateDiffuseModRate:
        this.updateLines();
        break;
      case Param.LateDiffuseDelay:
        for (const l of this.lines) l.setDiffuserDelay(this.ms2Samples(scaled) | 0);
        break;
      case Param.LateDiffuseFeedback:
        for (const l of this.lines) l.setDiffuserFeedback(scaled);
        break;

      case Param.EqLowShelfEnabled:
        for (const l of this.lines) l.lowShelfEnabled = scaled >= 0.5; break;
      case Param.EqHighShelfEnabled:
        for (const l of this.lines) l.highShelfEnabled = scaled >= 0.5; break;
      case Param.EqLowpassEnabled:
        for (const l of this.lines) l.cutoffEnabled = scaled >= 0.5; break;
      case Param.EqLowFreq:
        for (const l of this.lines) l.setLowShelfFrequency(scaled); break;
      case Param.EqHighFreq:
        for (const l of this.lines) l.setHighShelfFrequency(scaled); break;
      case Param.EqCutoff:
        for (const l of this.lines) l.setCutoffFrequency(scaled); break;
      case Param.EqLowGain:
        for (const l of this.lines) l.setLowShelfGain(scaled); break;
      case Param.EqHighGain:
        for (const l of this.lines) l.setHighShelfGain(scaled); break;

      case Param.EqCrossSeed:
        this.crossSeed = this.channelLr === 'R' ? 0.5 * scaled : 1 - 0.5 * scaled;
        this.multitap.setCrossSeed(this.crossSeed);
        this.diffuser.setCrossSeed(this.crossSeed);
        this.updateLines();
        this.updatePostDiffusion();
        break;

      case Param.SeedTap:       this.multitap.setSeed(scaled | 0); break;
      case Param.SeedDiffusion: this.diffuser.setSeed(scaled | 0); break;
      case Param.SeedDelay:     this.delayLineSeed = scaled | 0; this.updateLines(); break;
      case Param.SeedPostDiffusion:
        this.postDiffusionSeed = scaled | 0; this.updatePostDiffusion(); break;
    }
  }

  /**
   * Get the C++ DECAY readout: lineDecaySamples / samplerate => seconds.
   * This is the "live DECAY readout" the UI footer shows (RT60 of late
   * field, derived from the LateLineDecay parameter).
   */
  getDecaySeconds(): number {
    const ms = this.paramsScaled[Param.LateLineDecay]! * 1000;
    return ms / 1000;
  }

  process(input: Float32Array, output: Float32Array, bufSize: number): void {
    const temp = ReverbChannel._temp;
    const early = ReverbChannel._early;
    const lineOut = ReverbChannel._lineOut;
    const lineSum = ReverbChannel._lineSum;
    if (temp.length < bufSize) {
      ReverbChannel._temp = new Float32Array(bufSize);
      ReverbChannel._early = new Float32Array(bufSize);
      ReverbChannel._lineOut = new Float32Array(bufSize);
      ReverbChannel._lineSum = new Float32Array(bufSize);
    }
    const t = ReverbChannel._temp;
    const e = ReverbChannel._early;
    const lo = ReverbChannel._lineOut;
    const ls = ReverbChannel._lineSum;
    for (let i = 0; i < bufSize; i++) t[i] = input[i]!;
    if (this.lowCutEnabled) this.highPass.processBlock(t, t, bufSize);
    if (this.highCutEnabled) this.lowPass.processBlock(t, t, bufSize);
    // Match C++ denormal scrub.
    for (let i = 0; i < bufSize; i++) {
      const n = t[i]!;
      if (n * n < 1e-9) t[i] = 0;
    }
    this.preDelay.process(t, t, bufSize);
    if (this.multitapEnabled) this.multitap.process(t, t, bufSize);
    if (this.diffuserEnabled) this.diffuser.process(t, t, bufSize);
    for (let i = 0; i < bufSize; i++) e[i] = t[i]!;
    ls.fill(0, 0, bufSize);
    for (let i = 0; i < this.lineCount; i++) {
      this.lines[i]!.process(t, lo, bufSize);
      for (let j = 0; j < bufSize; j++) ls[j] += lo[j]!;
    }
    const perLineGain = 1 / Math.sqrt(this.lineCount);
    for (let j = 0; j < bufSize; j++) ls[j] *= perLineGain;
    for (let i = 0; i < bufSize; i++) {
      output[i] = this.dryOut * input[i]!
        + this.earlyOut * e[i]!
        + this.lineOut * ls[i]!;
    }
  }

  clearBuffers(): void {
    this.lowPass.clearBuffers();
    this.highPass.clearBuffers();
    this.preDelay.clearBuffers();
    this.multitap.clearBuffers();
    this.diffuser.clearBuffers();
    for (const l of this.lines) l.clearBuffers();
  }

  private updateLines(): void {
    const lineDelaySamples = this.ms2Samples(this.paramsScaled[Param.LateLineSize]!) | 0;
    const lineDecaySeconds = this.paramsScaled[Param.LateLineDecay]!;
    const lineDecaySamples = lineDecaySeconds * this.samplerate;
    const lineModAmount = this.ms2Samples(this.paramsScaled[Param.LateLineModAmount]!);
    const lineModRate = this.paramsScaled[Param.LateLineModRate]!;
    const lateDiffusionModAmount = this.ms2Samples(this.paramsScaled[Param.LateDiffuseModAmount]!);
    const lateDiffusionModRate = this.paramsScaled[Param.LateDiffuseModRate]!;
    const seeds = randomBufferGenerateCrossSeed(this.delayLineSeed, ReverbChannel.TotalLineCount * 3, this.crossSeed);
    for (let i = 0; i < ReverbChannel.TotalLineCount; i++) {
      const modAmount = lineModAmount * (0.7 + 0.3 * seeds[i]!);
      const modRate = lineModRate * (0.7 + 0.3 * seeds[ReverbChannel.TotalLineCount + i]!) / this.samplerate;
      let delaySamples = (0.5 + 1.0 * seeds[ReverbChannel.TotalLineCount * 2 + i]!) * lineDelaySamples;
      if (delaySamples < modAmount + 2) delaySamples = modAmount + 2;
      const dbAfter1Iter = (delaySamples / lineDecaySamples) * -60;
      const gainAfter1Iter = Math.pow(10, dbAfter1Iter / 20);
      this.lines[i]!.setDelay(delaySamples | 0);
      this.lines[i]!.setFeedback(gainAfter1Iter);
      this.lines[i]!.setLineModAmount(modAmount);
      this.lines[i]!.setLineModRate(modRate);
      this.lines[i]!.setDiffuserModAmount(lateDiffusionModAmount);
      this.lines[i]!.setDiffuserModRate(lateDiffusionModRate);
    }
  }

  private updatePostDiffusion(): void {
    for (let i = 0; i < ReverbChannel.TotalLineCount; i++) {
      this.lines[i]!.setDiffuserSeed(this.postDiffusionSeed * (i + 1), this.crossSeed);
    }
  }

  private static _temp = new Float32Array(BUFFER_SIZE);
  private static _early = new Float32Array(BUFFER_SIZE);
  private static _lineOut = new Float32Array(BUFFER_SIZE);
  private static _lineSum = new Float32Array(BUFFER_SIZE);
}

// ============================================================================
// ReverbController — stereo dispatcher (1:1 from ReverbController.h)
// ============================================================================

export class ReverbController {
  parameters = new Float32Array(Param.COUNT);
  private samplerate: number;
  channelL: ReverbChannel;
  channelR: ReverbChannel;

  constructor(samplerate: number) {
    this.samplerate = samplerate;
    this.channelL = new ReverbChannel(samplerate, 'L');
    this.channelR = new ReverbChannel(samplerate, 'R');
  }

  setSamplerate(sr: number): void {
    this.samplerate = sr;
    this.channelL.setSamplerate(sr);
    this.channelR.setSamplerate(sr);
  }

  setParameter(id: number, value: number): void {
    this.parameters[id] = value;
    const scaled = scaleParam(value, id);
    this.channelL.setParameter(id, scaled);
    this.channelR.setParameter(id, scaled);
  }

  clearBuffers(): void {
    this.channelL.clearBuffers();
    this.channelR.clearBuffers();
  }

  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, bufSize: number): void {
    const inputMix = scaleParam(this.parameters[Param.InputMix]!, Param.InputMix);
    const cm = inputMix * 0.5;
    const cmi = 1 - cm;
    const tmpL = ReverbController._tmpL.length >= bufSize ? ReverbController._tmpL : (ReverbController._tmpL = new Float32Array(bufSize));
    const tmpR = ReverbController._tmpR.length >= bufSize ? ReverbController._tmpR : (ReverbController._tmpR = new Float32Array(bufSize));
    for (let i = 0; i < bufSize; i++) {
      tmpL[i] = inL[i]! * cmi + inR[i]! * cm;
      tmpR[i] = inR[i]! * cmi + inL[i]! * cm;
    }
    this.channelL.process(tmpL, outL, bufSize);
    this.channelR.process(tmpR, outR, bufSize);
  }

  private static _tmpL = new Float32Array(BUFFER_SIZE);
  private static _tmpR = new Float32Array(BUFFER_SIZE);
}

// ============================================================================
// AudioWorklet integration
// ============================================================================

// The 7 normalized macro params we expose as AudioParams (so they accept
// CV connections from cv inputs through web-audio AudioParam summing).
// The remaining 38 CloudSeed parameters (toggles, integer counts, seeds)
// are mutated via postMessage from the main thread — see the message
// handler below + cloudseed.ts in audio/modules.
//
// The split is intentional: only the macros that benefit from a-rate /
// k-rate CV summing are AudioParams; toggles + integer-quantized knobs
// stay on the main thread. This matches the pattern used by WARPS for
// its algorithm-index parameter.

const MACRO_PARAMS = [
  'dry_out',         // → DryOut
  'early_out',       // → EarlyOut
  'late_out',        // → LateOut
  'input_mix',       // → InputMix
  'low_cut',         // → LowCut
  'high_cut',        // → HighCut
  'cross_seed',      // → EqCrossSeed
] as const;

class CloudseedProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return MACRO_PARAMS.map((name) => ({
      name, defaultValue: 0.5, minValue: 0, maxValue: 1,
      automationRate: 'k-rate' as const,
    }));
  }

  reverb = new ReverbController(sampleRate);

  constructor() {
    super();
    // Initialize with sane defaults so the reverb is audible out of the
    // box. The host's module-def setParam path also fires on factory init
    // to set the user's saved values; this just ensures no NaN/zero out.
    for (let i = 0; i < Param.COUNT; i++) this.reverb.setParameter(i, 0.5);
    // Make the dry path audible by default.
    this.reverb.setParameter(Param.DryOut, 0.87);
    this.reverb.setParameter(Param.LateOut, 0.66);
    this.reverb.setParameter(Param.EarlyOut, 0);
    this.reverb.setParameter(Param.LowCutEnabled, 1);
    this.reverb.setParameter(Param.LateDiffuseEnabled, 1);
    this.reverb.setParameter(Param.EqHighShelfEnabled, 1);
    this.port.onmessage = (ev: MessageEvent): void => {
      const data = ev.data as { type?: string; id?: number; value?: number };
      if (!data) return;
      if (data.type === 'setParam' && typeof data.id === 'number' && typeof data.value === 'number') {
        this.reverb.setParameter(data.id, data.value);
      } else if (data.type === 'clearBuffers') {
        this.reverb.clearBuffers();
      }
    };
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const inL = inputs[0]?.[0];
    const inR = inputs[1]?.[0];
    const outL = outputs[0]?.[0];
    const outR = outputs[1]?.[0];
    if (!outL || !outR) return true;
    // Pull AudioParam values + push into the reverb (k-rate, so we just
    // need [0]). Values that don't move trigger no re-derivation; the
    // ScaleParam call is a small switch.
    const dry = parameters['dry_out']?.[0];
    const early = parameters['early_out']?.[0];
    const late = parameters['late_out']?.[0];
    const mix = parameters['input_mix']?.[0];
    const lo = parameters['low_cut']?.[0];
    const hi = parameters['high_cut']?.[0];
    const xs = parameters['cross_seed']?.[0];
    if (typeof dry === 'number') this.reverb.setParameter(Param.DryOut, dry);
    if (typeof early === 'number') this.reverb.setParameter(Param.EarlyOut, early);
    if (typeof late === 'number') this.reverb.setParameter(Param.LateOut, late);
    if (typeof mix === 'number') this.reverb.setParameter(Param.InputMix, mix);
    if (typeof lo === 'number') this.reverb.setParameter(Param.LowCut, lo);
    if (typeof hi === 'number') this.reverb.setParameter(Param.HighCut, hi);
    if (typeof xs === 'number') this.reverb.setParameter(Param.EqCrossSeed, xs);

    const bs = outL.length;
    // If only one input channel is patched, mirror it onto the other so
    // mono inputs still get stereo reverb decorrelation via the cross-seed.
    const silentL = !inL || inL.length === 0;
    const silentR = !inR || inR.length === 0;
    const left = silentL ? (silentR ? CloudseedProcessor.zeros(bs) : inR!) : inL!;
    const right = silentR ? (silentL ? CloudseedProcessor.zeros(bs) : inL!) : inR!;
    this.reverb.process(left, right, outL, outR, bs);
    return true;
  }

  private static _zeros = new Float32Array(BUFFER_SIZE);
  private static zeros(n: number): Float32Array {
    if (CloudseedProcessor._zeros.length < n) CloudseedProcessor._zeros = new Float32Array(n);
    return CloudseedProcessor._zeros.subarray(0, n);
  }
}

registerProcessor('cloudseed', CloudseedProcessor);
