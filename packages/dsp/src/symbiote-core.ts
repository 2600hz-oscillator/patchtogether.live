// packages/dsp/src/symbiote-core.ts
//
// SYMBIOTE core — Grids drum engine + TB-3PO acid sequencer.
//
// Clean-room TypeScript port of the "Symbiote" alt-firmware work for Mutable
// Instruments Marbles (clone/eurorack/marbles, branch grids-port). The Grids
// pattern generator and its drum-map / Euclidean LUTs are Copyright 2011/2012
// Émilie Gillet, GPLv3 (Grids origin) — compatible with patchtogether.live's
// AGPL. The TB-3PO algorithm is ported from the O&C / Hemisphere TB_3PO applet.
//
// Reference files mapped from:
//   marbles/grids/pattern_generator.{h,cc}  — drum-map + Euclidean engine
//   marbles/grids/grids_random.h            — 16-bit Galois LFSR
//   marbles/grids/grids_resources.cc        — node drum-maps + euclidean LUT
//   marbles/tb3po/tb3po_sequencer.{h,cc}    — acid sequencer
//
// Fidelity: the Grids `PatternGenerator` (drum-map bilinear interpolation,
// perturbation, Euclidean lookup + fill/rotation), the GridsRandom LFSR, and
// the entire TB3PoSequencer (density/pitch/slide/octave-jump walk, in-scale
// degree filter) are ported line-for-line. The shared static C++ state is
// modelled as instance fields here so MARBLES and SYMBIOTE can coexist.

import { GRIDS_EUCLIDEAN, GRIDS_NODES } from './grids-resources';
import { cellVoltage, type Scale } from './marbles-core';

function constrain(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

// ---------------------------------------------------------------------------
// GridsRandom — 16-bit Galois LFSR (grids_random.h). Shared between the
// pattern generator and TB-3PO; an instance so multiple modules don't collide.
// ---------------------------------------------------------------------------

export class GridsRandom {
  private state = 0x1234;
  update(): void {
    // x^16 + x^14 + x^13 + x^11. Period 65535.
    this.state = ((this.state >>> 1) ^ (-(this.state & 1) & 0xb400)) & 0xffff;
  }
  getState(): number {
    return this.state & 0xffff;
  }
  seed(s: number): void {
    this.state = s & 0xffff;
  }
  stateMsb(): number {
    return (this.state >>> 8) & 0xff;
  }
  getByte(): number {
    this.update();
    return this.stateMsb();
  }
  getWord(): number {
    this.update();
    return this.getState();
  }
}

// ---------------------------------------------------------------------------
// PatternGenerator (pattern_generator.{h,cc}).
// ---------------------------------------------------------------------------

const K_NUM_PARTS = 3;
const K_PULSES_PER_STEP = 3; // 24 ppqn
const K_STEPS_PER_PATTERN = 32;

export const OUTPUT_MODE_EUCLIDEAN = 0;
export const OUTPUT_MODE_DRUMS = 1;

// drum_map[5][5] — indices into GRIDS_NODES (pattern_generator.cc).
const DRUM_MAP: number[][] = [
  [10, 8, 0, 9, 11],
  [15, 7, 13, 12, 6],
  [18, 14, 4, 5, 3],
  [23, 16, 21, 1, 2],
  [24, 19, 17, 20, 22],
];

function u8Mix(a: number, b: number, balance: number): number {
  const partA = a * (255 - balance);
  const partB = b * balance;
  return (partA + partB) >>> 8;
}
function u8MulShift8(a: number, b: number): number {
  return ((a * b) >>> 8) & 0xff;
}

export interface DrumsSettings {
  x: number;
  y: number;
  randomness: number;
}
export interface PatternGeneratorSettings {
  drums: DrumsSettings;
  euclideanLength: number[]; // [3]
  density: number[]; // [3]
  euclideanFillT2: number;
  euclideanRotation: number;
}

export class PatternGenerator {
  private rng: GridsRandom;
  private outputMode = OUTPUT_MODE_DRUMS;
  private pulse = 0;
  private step = 0;
  private euclideanStep = new Uint8Array(K_NUM_PARTS);
  private firstBeat = false;
  private beat = false;
  private state = 0;
  private partPerturbation = new Uint8Array(K_NUM_PARTS);
  settings: PatternGeneratorSettings = {
    drums: { x: 128, y: 128, randomness: 0 },
    euclideanLength: [16, 16, 16],
    density: [128, 128, 128],
    euclideanFillT2: 0,
    euclideanRotation: 0,
  };

  constructor(rng: GridsRandom) {
    this.rng = rng;
    this.reset();
  }

  setOutputMode(mode: number): void {
    this.outputMode = mode;
  }
  reset(): void {
    this.step = 0;
    this.pulse = 0;
    this.euclideanStep.fill(0);
  }
  getState(): number {
    return this.state;
  }
  getStep(): number {
    return this.step;
  }

  private readDrumMap(step: number, instrument: number, x: number, y: number): number {
    const i = x >> 6;
    const j = y >> 6;
    const aMap = GRIDS_NODES[DRUM_MAP[i]![j]!]!;
    const bMap = GRIDS_NODES[DRUM_MAP[i + 1]![j]!]!;
    const cMap = GRIDS_NODES[DRUM_MAP[i]![j + 1]!]!;
    const dMap = GRIDS_NODES[DRUM_MAP[i + 1]![j + 1]!]!;
    const offset = instrument * K_STEPS_PER_PATTERN + step;
    const a = aMap[offset]!;
    const b = bMap[offset]!;
    const c = cMap[offset]!;
    const d = dMap[offset]!;
    return u8Mix(u8Mix(a, b, (x << 2) & 0xff), u8Mix(c, d, (x << 2) & 0xff), (y << 2) & 0xff);
  }

  private evaluateDrums(): void {
    if (this.step === 0) {
      for (let i = 0; i < K_NUM_PARTS; i++) {
        const randomness = this.settings.drums.randomness >> 2;
        this.partPerturbation[i] = u8MulShift8(this.rng.getByte(), randomness);
      }
    }
    let instrumentMask = 1;
    const x = this.settings.drums.x;
    const y = this.settings.drums.y;
    for (let i = 0; i < K_NUM_PARTS; i++) {
      let level = this.readDrumMap(this.step, i, x, y);
      if (level < 255 - this.partPerturbation[i]!) {
        level += this.partPerturbation[i]!;
      } else {
        level = 255;
      }
      const threshold = ~this.settings.density[i]! & 0xff;
      if (level > threshold) {
        this.state |= instrumentMask;
      }
      instrumentMask <<= 1;
    }
  }

  private evaluateEuclidean(): void {
    if (this.step & 1) return;
    let instrumentMask = 1;
    for (let i = 0; i < K_NUM_PARTS; i++) {
      const length = (this.settings.euclideanLength[i]! >> 3) + 1;
      const density = this.settings.density[i]! >> 3;
      const address = (length - 1) * 32 + density;
      while (this.euclideanStep[i]! >= length) {
        this.euclideanStep[i]! -= length;
      }
      let stepForLookup = this.euclideanStep[i]!;
      if (this.settings.euclideanRotation) {
        const rot = (this.settings.euclideanRotation * length) >> 8;
        stepForLookup = (stepForLookup + rot) % length;
      }
      const stepMask = (1 << stepForLookup) >>> 0;
      const patternBits = GRIDS_EUCLIDEAN[address % 1024]!;
      const hit = (patternBits & stepMask) !== 0;
      if (hit) {
        this.state |= instrumentMask;
      } else if (i === 1 && this.settings.euclideanFillT2) {
        if (this.rng.getByte() < this.settings.euclideanFillT2) {
          this.state |= instrumentMask;
        }
      }
      instrumentMask <<= 1;
    }
  }

  private evaluate(): void {
    this.state = 0;
    this.rng.update();
    // Refresh only at step changes.
    if (this.pulse !== 0) return;
    if (this.outputMode === OUTPUT_MODE_EUCLIDEAN) {
      this.evaluateEuclidean();
    } else {
      this.evaluateDrums();
    }
  }

  tickClock(numPulses: number): void {
    this.evaluate();
    this.beat = (this.step & 0x7) === 0;
    this.firstBeat = this.step === 0;
    this.pulse += numPulses;
    while (this.pulse >= K_PULSES_PER_STEP) {
      this.pulse -= K_PULSES_PER_STEP;
      if (!(this.step & 1)) {
        for (let i = 0; i < K_NUM_PARTS; i++) this.euclideanStep[i]!++;
      }
      this.step++;
    }
    if (this.step >= K_STEPS_PER_PATTERN) this.step -= K_STEPS_PER_PATTERN;
  }
}

// ---------------------------------------------------------------------------
// TB3PoSequencer (tb3po_sequencer.{h,cc}).
// ---------------------------------------------------------------------------

const TB_MAX_STEPS = 32;
const TB_MAX_SCALE_DEGREES = 16;
const K_SLIDE_COEF = 0.003;
const K_OCTAVE_OFFSET = 4;
const K_OCTAVE_JUMP_PROB = 80;
const K_OCTAVE_JUMP_RANGE = 200;

export class TB3PoSequencer {
  private rng: GridsRandom;
  private seedV = 0;
  private lockSeed = false;
  private numSteps = 16;
  private currentPatternDensity = 0xff;
  private currentPatternScaleSize = 0;

  private gates = 0;
  private slides = 0;
  private accents = 0;
  private octUps = 0;
  private octDowns = 0;
  private notes = new Uint8Array(TB_MAX_STEPS);

  private densityEncoder = 7;
  private densityCv = 0;
  private density = 7;
  private transpose = 0;
  private scale: Scale | null = null;
  private scaleSize = 0;

  private activeIdx = new Uint8Array(TB_MAX_SCALE_DEGREES);
  private activeCount = 0;

  private step = 0;
  private gateV = false;
  private accentV = false;
  private gateOffPending = false;

  private pitchVolts = 0;
  private slideTarget = 0;
  private slideStart = 0;

  constructor(rng: GridsRandom) {
    this.rng = rng;
  }

  setDensity(encoder: number, cv: number): void {
    encoder = constrain(encoder, 0, 14);
    cv = constrain(cv, -7, 7);
    this.densityEncoder = encoder;
    this.densityCv = cv;
    this.density = constrain(encoder + cv, 0, 14);
  }
  setTranspose(scaleDegrees: number): void {
    this.transpose = scaleDegrees;
  }
  setLength(steps: number): void {
    this.numSteps = constrain(steps, 1, TB_MAX_STEPS);
  }
  setLockSeed(locked: boolean): void {
    this.lockSeed = locked;
  }
  setScale(scale: Scale | null): void {
    const changed = scale !== this.scale;
    this.scale = scale;
    if (scale) {
      let n = scale.numDegrees;
      if (n <= 0) n = 1;
      if (n > TB_MAX_SCALE_DEGREES) n = TB_MAX_SCALE_DEGREES;
      this.scaleSize = n;
    } else {
      this.scaleSize = 12;
    }
    this.buildActiveDegrees();
    if (changed) this.currentPatternDensity = 0xff;
  }

  private buildActiveDegrees(): void {
    this.activeCount = 0;
    if (!this.scale || this.scaleSize === 0) return;
    let threshold = 0;
    if (this.scaleSize >= 12) {
      let maxW = 0;
      for (let i = 0; i < this.scaleSize; i++) {
        if (this.scale.degree[i]!.weight > maxW) maxW = this.scale.degree[i]!.weight;
      }
      threshold = maxW >> 2;
      if (threshold === 0) threshold = 1;
    }
    for (let i = 0; i < this.scaleSize; i++) {
      if (this.scale.degree[i]!.weight >= threshold) {
        this.activeIdx[this.activeCount++] = i;
      }
    }
    if (this.activeCount === 0) this.activeIdx[this.activeCount++] = 0;
  }

  seed(): number {
    return this.seedV;
  }
  setSeed(s: number): void {
    this.seedV = s & 0xffff;
    this.currentPatternDensity = 0xff;
    this.currentPatternScaleSize = 0;
    this.regenerateAll();
  }
  reseed(): void {
    this.rng.update();
    this.seedV = this.rng.getState();
    if (this.seedV === 0) this.seedV = 1;
    this.currentPatternDensity = 0xff;
    this.currentPatternScaleSize = 0;
    this.regenerateAll();
  }

  tick(reset: boolean): void {
    this.regenerateIfDirty();
    let prevStep: number;
    if (reset) {
      this.step = 0;
      prevStep = 0;
    } else {
      prevStep = this.step;
      this.step = this.getNextStep(this.step);
    }
    if (this.stepIsSlid(prevStep)) {
      this.slideStart = this.pitchVolts;
      this.slideTarget = this.pitchForStep(this.step);
    } else if (this.stepIsGated(this.step)) {
      const p = this.pitchForStep(this.step);
      this.pitchVolts = p;
      this.slideStart = p;
      this.slideTarget = p;
    }
    if (this.stepIsGated(this.step) || this.stepIsSlid(prevStep)) {
      this.gateV = true;
      this.accentV = this.stepIsAccent(this.step);
      this.gateOffPending = true;
    }
  }
  tickHalfCycle(): void {
    if (this.gateOffPending) {
      this.gateOffPending = false;
      if (!this.stepIsSlid(this.step)) {
        this.gateV = false;
        this.accentV = false;
      }
    }
  }
  forceGateOff(): void {
    this.gateV = false;
    this.accentV = false;
    this.gateOffPending = false;
  }
  stepSlide(): void {
    if (this.pitchVolts === this.slideTarget) return;
    this.pitchVolts += K_SLIDE_COEF * (this.slideTarget - this.pitchVolts);
    if (this.slideStart < this.slideTarget) {
      if (this.pitchVolts > this.slideTarget) this.pitchVolts = this.slideTarget;
    } else {
      if (this.pitchVolts < this.slideTarget) this.pitchVolts = this.slideTarget;
    }
  }
  getPitchVolts(): number {
    return this.pitchVolts;
  }
  gate(): boolean {
    return this.gateV;
  }
  accent(): boolean {
    return this.accentV && this.gateV;
  }
  getStep(): number {
    return this.step;
  }

  private regenerateIfDirty(): void {
    if (this.density !== this.currentPatternDensity || this.activeCount !== this.currentPatternScaleSize) {
      this.regenerateAll();
    }
  }
  private regenerateAll(): void {
    const saved = this.rng.getState();
    this.rng.seed(this.seedV === 0 ? 0xace1 : this.seedV);
    this.regeneratePitches();
    this.applyDensity();
    this.currentPatternDensity = this.density;
    this.currentPatternScaleSize = this.activeCount;
    this.rng.seed(saved);
  }

  private randRange(range: number): number {
    if (range <= 0) return 0;
    return this.rng.getWord() % range;
  }
  private randBit(prob: number): boolean {
    return this.rng.getWord() % 100 < prob;
  }
  private getNextStep(step: number): number {
    step++;
    if (step >= this.numSteps) return 0;
    return step;
  }
  private getOnOffDensity(): number {
    return Math.abs(this.density - 7);
  }
  private getPitchChangeDensity(): number {
    return constrain(this.density, 0, 8);
  }

  private regeneratePitches(): void {
    const pitchChangeDens = this.getPitchChangeDensity();
    let availablePitches = 0;
    if (this.activeCount > 0) {
      if (pitchChangeDens > 7) {
        availablePitches = this.activeCount - 1;
      } else if (pitchChangeDens < 2) {
        availablePitches = pitchChangeDens;
      } else {
        let rangeFromScale = this.activeCount - 3;
        if (rangeFromScale < 4) rangeFromScale = 4;
        availablePitches = 3 + Math.trunc(((pitchChangeDens - 3) * rangeFromScale) / 4);
        availablePitches = constrain(availablePitches, 1, this.activeCount - 1);
      }
      availablePitches = constrain(availablePitches, 0, this.activeCount - 1);
    }
    this.octUps = 0;
    this.octDowns = 0;
    for (let s = 0; s < TB_MAX_STEPS; s++) {
      const forceRepeatProb = 50 - pitchChangeDens * 6;
      if (s > 0 && this.randBit(forceRepeatProb)) {
        this.notes[s] = this.notes[s - 1]!;
      } else {
        const rank = this.randRange(availablePitches + 1);
        this.notes[s] = rank & 0xff;
        this.octUps = (this.octUps << 1) >>> 0;
        this.octDowns = (this.octDowns << 1) >>> 0;
        const coinflip = this.randRange(K_OCTAVE_JUMP_RANGE);
        if (coinflip < K_OCTAVE_JUMP_PROB) {
          if (coinflip & 1) {
            this.octUps = (this.octUps | 1) >>> 0;
          } else {
            this.octDowns = (this.octDowns | 1) >>> 0;
          }
        }
      }
    }
  }

  private applyDensity(): void {
    let latestSlide = 0;
    let latestAccent = 0;
    const onOffDens = this.getOnOffDensity();
    const gateProb = 10 + onOffDens * 14;
    this.gates = 0;
    this.slides = 0;
    this.accents = 0;
    for (let i = 0; i < TB_MAX_STEPS; i++) {
      this.gates = (this.gates << 1) >>> 0;
      this.gates = (this.gates | (this.randBit(gateProb) ? 1 : 0)) >>> 0;
      this.slides = (this.slides << 1) >>> 0;
      latestSlide = this.randBit(latestSlide ? 10 : 18) ? 1 : 0;
      this.slides = (this.slides | latestSlide) >>> 0;
      this.accents = (this.accents << 1) >>> 0;
      latestAccent = this.randBit(latestAccent ? 7 : 16) ? 1 : 0;
      this.accents = (this.accents | latestAccent) >>> 0;
    }
  }

  private stepIsGated(s: number): boolean {
    return (this.gates & (1 << s)) !== 0;
  }
  private stepIsSlid(s: number): boolean {
    return (this.slides & (1 << s)) !== 0;
  }
  private stepIsAccent(s: number): boolean {
    return (this.accents & (1 << s)) !== 0;
  }
  private stepIsOctUp(s: number): boolean {
    return (this.octUps & (1 << s)) !== 0;
  }
  private stepIsOctDown(s: number): boolean {
    return (this.octDowns & (1 << s)) !== 0;
  }

  private pitchForStep(s: number): number {
    if (!this.scale || this.activeCount === 0 || this.scaleSize === 0) return 0;
    const rank = this.notes[s]!;
    const transposeInt = Math.trunc(this.transpose + (this.transpose >= 0 ? 0.5 : -0.5));
    let total = rank + transposeInt + K_OCTAVE_OFFSET * this.activeCount;
    if (this.stepIsOctUp(s)) total += this.activeCount;
    else if (this.stepIsOctDown(s)) total -= this.activeCount;
    let octave = Math.trunc(total / this.activeCount);
    let within = total % this.activeCount;
    if (within < 0) {
      within += this.activeCount;
      --octave;
    }
    if (octave < 0) octave = 0;
    if (octave > 16) octave = 16;
    const idx = octave * this.scaleSize + this.activeIdx[within]!;
    return cellVoltage(this.scale, idx);
  }
}
