// packages/dsp/src/symbiote.ts
//
// SYMBIOTE — Marbles core + Grids drum engine (T-section) + TB-3PO acid
// sequencer (X-section). Always-on Symbiote mode: there is no hardware-style
// T MODEL long-press or déjà-vu-button sub-mode toggle — the Drums/Euclidean
// sub-mode and all TB-3PO controls are exposed as normal module params.
//
// Reuses the Marbles internal clock (TGenerator master phase) purely as the
// tempo source. The T-section runs Grids (BD/SD/HH on T1/T2/T3) and the
// X-section runs TB-3PO (X1 clock, X2 pitch 1V/oct, X3 gate, Y accent).
//
// DSP cores: marbles-core.ts (clock), symbiote-core.ts (Grids + TB-3PO).
//
// I/O outputs: t1(BD) t2(SD) t3(HH) | x1(clk) x2(pitch CV) x3(gate) y(accent)
//
// Clocking (matches docs/MEMORY.md): one Grids step = K_PULSES_PER_STEP master
// wraps... here we drive the pattern clock once per master-phase wrap and run
// TB-3PO at an 8th-note rate (2 Grids steps). The step ramp gives TB-3PO a
// musical clock decoupled from the BD/SD/HH gate patterns.

import { RandomStream, TGenerator, PRESET_SCALES } from './marbles-core';
import {
  GridsRandom,
  PatternGenerator,
  TB3PoSequencer,
  OUTPUT_MODE_DRUMS,
  OUTPUT_MODE_EUCLIDEAN,
} from './symbiote-core';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  constructor(options?: unknown);
  readonly port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare function registerProcessor(name: string, ctor: new (options?: unknown) => AudioWorkletProcessor): void;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

const K_PULSES_PER_STEP = 3;
// 2 Grids steps per TB-3PO step (8th-note rate) → 6 master wraps per X1 cycle.
const MASTER_WRAPS_PER_X_STEP = K_PULSES_PER_STEP * 2;

class SymbioteProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Tempo / clock
      { name: 'rate', defaultValue: 0, minValue: -60, maxValue: 60, automationRate: 'a-rate' as const },
      // Grids T-section
      { name: 'sub_mode', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const }, // 0=Drums 1=Euclidean
      { name: 'map_x', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const }, // BIAS → drum map X
      { name: 'map_y', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const }, // JITTER → drum map Y
      { name: 'bd_density', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'sd_density', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'hh_density', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'chaos', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'a-rate' as const }, // DEJA VU bipolar
      { name: 'euclid_length', defaultValue: 16, minValue: 1, maxValue: 16, automationRate: 'a-rate' as const },
      // TB-3PO X-section
      { name: 'acid_density', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
      { name: 'transpose', defaultValue: 0, minValue: -18, maxValue: 18, automationRate: 'a-rate' as const },
      { name: 'acid_length', defaultValue: 16, minValue: 1, maxValue: 32, automationRate: 'a-rate' as const },
      { name: 'scale', defaultValue: 0, minValue: 0, maxValue: 5, automationRate: 'a-rate' as const },
      { name: 'seed_lock', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' as const },
    ];
  }

  private stream = new RandomStream(0x12345678);
  private t = new TGenerator(this.stream, sampleRate);
  private rng = new GridsRandom();
  private grids = new PatternGenerator(this.rng);
  private tb3po = new TB3PoSequencer(this.rng);

  private gateBuf: boolean[] = [false, false];
  private slavePhaseBuf: number[] = [0, 0];

  private prevMasterPhase = 0;
  private gridsPulse = 0; // 0..MASTER_WRAPS_PER_X_STEP-1
  private prevSeedLock = false;
  private prevScale = -1;
  private prevSubMode = -1;

  // Latched drum gate flags for the duration between master wraps.
  private bd = false;
  private sd = false;
  private hh = false;

  constructor(options?: unknown) {
    super(options);
    this.t.reset();
    this.t.model = 2; // DRUMS slot — irrelevant, we override gates with Grids.
    this.tb3po.setScale(PRESET_SCALES[0]!);
    this.prevScale = 0;
  }

  private feedGrids(
    subMode: number,
    mapX: number,
    mapY: number,
    bdD: number,
    sdD: number,
    hhD: number,
    chaos: number,
    euclidLen: number,
  ): void {
    const euclidean = subMode >= 0.5;
    this.grids.setOutputMode(euclidean ? OUTPUT_MODE_EUCLIDEAN : OUTPUT_MODE_DRUMS);
    const s = this.grids.settings;
    s.density[0] = clamp(Math.round(bdD * 255), 0, 255);
    s.density[1] = clamp(Math.round(sdD * 255), 0, 255);
    s.density[2] = clamp(Math.round(hhD * 255), 0, 255);
    if (euclidean) {
      const len = clamp(Math.round(euclidLen), 1, 16);
      const enc = (len - 1) * 8;
      s.euclideanLength[0] = enc;
      s.euclideanLength[1] = enc;
      s.euclideanLength[2] = enc;
      // Bipolar DEJA VU (chaos): CCW → SD fills; CW → rotation.
      s.euclideanFillT2 = chaos < 0 ? clamp(Math.round(-chaos * 255), 0, 255) : 0;
      s.euclideanRotation = chaos > 0 ? clamp(Math.round(chaos * 255), 0, 255) : 0;
    } else {
      s.drums.x = clamp(Math.round(mapX * 255), 0, 255);
      s.drums.y = clamp(Math.round(mapY * 255), 0, 255);
      // Drums chaos uses |chaos| (CCW or CW → randomness).
      s.drums.randomness = clamp(Math.round(Math.abs(chaos) * 255), 0, 255);
    }
  }

  process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const t1 = outputs[0]?.[0]; // BD
    const t2 = outputs[1]?.[0]; // SD
    const t3 = outputs[2]?.[0]; // HH
    const x1 = outputs[3]?.[0]; // clock
    const x2 = outputs[4]?.[0]; // pitch CV (1V/oct → /5)
    const x3 = outputs[5]?.[0]; // gate
    const y = outputs[6]?.[0]; // accent
    if (!t1 || !t2 || !t3 || !x1 || !x2 || !x3 || !y) return true;

    const n = t1.length;
    const p = (name: string, i: number): number => {
      const a = parameters[name]!;
      return a.length > 1 ? a[i]! : a[0]!;
    };

    for (let i = 0; i < n; i++) {
      const rate = p('rate', i);
      const subMode = p('sub_mode', i);
      const mapX = clamp(p('map_x', i), 0, 1);
      const mapY = clamp(p('map_y', i), 0, 1);
      const bdD = clamp(p('bd_density', i), 0, 1);
      const sdD = clamp(p('sd_density', i), 0, 1);
      const hhD = clamp(p('hh_density', i), 0, 1);
      const chaos = clamp(p('chaos', i), -1, 1);
      const euclidLen = clamp(Math.round(p('euclid_length', i)), 1, 16);
      const acidDensity = clamp(p('acid_density', i), 0, 1);
      const transpose = clamp(p('transpose', i), -18, 18);
      const acidLength = clamp(Math.round(p('acid_length', i)), 1, 32);
      const scaleIdx = clamp(Math.round(p('scale', i)), 0, PRESET_SCALES.length - 1);
      const seedLock = p('seed_lock', i) >= 0.5;

      // --- block-ish param feed (per sample is cheap) ---
      this.t.setRate(rate);
      this.feedGrids(subMode, mapX, mapY, bdD, sdD, hhD, chaos, euclidLen);

      // TB-3PO controls
      this.tb3po.setDensity(Math.round(acidDensity * 14), 0);
      this.tb3po.setTranspose(transpose);
      this.tb3po.setLength(acidLength);
      if (scaleIdx !== this.prevScale) {
        this.tb3po.setScale(PRESET_SCALES[scaleIdx]!);
        this.prevScale = scaleIdx;
      }
      // Seed lock edge: OFF→ON commits + locks; ON→OFF reseeds.
      if (seedLock !== this.prevSeedLock) {
        this.tb3po.setLockSeed(seedLock);
        if (!seedLock) this.tb3po.reseed();
        this.prevSeedLock = seedLock;
      }

      // --- advance the master clock (tempo only) ---
      const masterPhase = this.t.processSample(2.0, this.gateBuf, this.slavePhaseBuf);

      // Detect a master-phase wrap (1→0).
      const wrapped = masterPhase < this.prevMasterPhase;
      this.prevMasterPhase = masterPhase;

      if (wrapped) {
        // Advance the Grids pattern one step per master wrap.
        this.grids.tickClock(1);
        const state = this.grids.getState();
        this.bd = (state & 0x01) !== 0;
        this.sd = (state & 0x02) !== 0;
        this.hh = (state & 0x04) !== 0;

        this.gridsPulse = (this.gridsPulse + 1) % MASTER_WRAPS_PER_X_STEP;
      }

      // Step-level ramp for TB-3PO: cycles 0→1 over MASTER_WRAPS_PER_X_STEP.
      const stepRamp = (this.gridsPulse + masterPhase) / MASTER_WRAPS_PER_X_STEP;

      // Rising X1 edge (stepRamp wraps): TB-3PO Tick.
      // Falling X1 edge (stepRamp crosses 0.5): TickHalfCycle.
      if (wrapped && this.gridsPulse === 0) {
        this.tb3po.tick(false);
      } else if (wrapped && this.gridsPulse === Math.floor(MASTER_WRAPS_PER_X_STEP / 2)) {
        this.tb3po.tickHalfCycle();
      }
      this.tb3po.stepSlide();

      // Outputs
      t1[i] = this.bd ? 1 : 0;
      t2[i] = this.sd ? 1 : 0;
      t3[i] = this.hh ? 1 : 0;
      x1[i] = stepRamp < 0.5 ? 1 : 0;
      x2[i] = clamp(this.tb3po.getPitchVolts() / 5, -1, 1);
      x3[i] = this.tb3po.gate() ? 1 : 0;
      y[i] = this.tb3po.accent() ? 1 : 0;
    }
    return true;
  }
}

registerProcessor('symbiote', SymbioteProcessor);
