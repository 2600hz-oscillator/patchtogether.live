// art/scenarios/sample-hold/quantized-vco-steps.test.ts
//
// COMPOSITE ART scenario for SAMPLE & HOLD / quantizer driving a VCO into a
// scope, modelled on art/scenarios/meowbox/voct-tracking.test.ts (node-web-
// audio-api can't host the custom AudioWorklet directly, so we drive the SAME
// pure DSP maths the worklet runs + render OscillatorNodes at the resulting
// frequencies and FFT-confirm).
//
// The chain under test:
//
//   slow ramp/LFO ─► sampleHold.cv_in
//   clock         ─► sampleHold.gate_in
//                    sampleHold.cv_quant ─► analogVco.pitch ─► scope
//
// Two variants:
//
//   1. GATED (sample & hold): a slow ramp on cv_in + a periodic clock on
//      gate_in. On each clock rising edge the ramp is LATCHED + quantized; the
//      VCO pitch STEPS to the quantized scale frequency and holds it until the
//      next clock. We assert the stepped frequency sequence:
//        * every step lands on a note of the selected scale (Major), AND
//        * the rendered VCO fundamental at each step matches
//          261.626·2^(quant_volts) within FFT-bin slack, AND
//        * we pin the stepped output buffer as a .f32 baseline (RMS tier B).
//
//   2. CONTINUOUS QUANTIZER (no gate patched): the same ramp, gate_in
//      UNPATCHED → cv passes through continuously + cv_quant continuously
//      quantizes. We assert the quantizer output is monotonic-non-decreasing
//      over the rising ramp + every sample is an admitted scale note, AND pin
//      the continuous quantized voltage curve as a .f32 baseline.
//
// Build-toolchain pin: the compiled worklet artifact exists + its built .sha
// still matches the source .ts (catches a stale dist/).

import { describe, it, expect } from 'vitest';
import { OfflineAudioContext } from 'node-web-audio-api';
import {
  SAMPLE_HOLD_SCALES,
  quantizeVoltage,
  sampleHoldStep,
} from '../../../packages/dsp/src/lib/sample-hold-dsp';
import {
  builtSha,
  moduleSourceSha,
  readBaseline,
  writeBaseline,
  compareBuffers,
  SHOULD_UPDATE_BASELINES,
} from '../../setup/render';

const SAMPLE_RATE = 48000;
const DURATION_S = 0.4;
const FREQ_TOLERANCE_HZ = 1.0; // FFT bin granularity slack
const TWO_PI = Math.PI * 2;

// analog-vco.dsp: freqHz = 261.626 · 2^(pitch + tune/12 + fine/1200). Knobs 0.
const VCO_C4_HZ = 261.626;
const vcoFreqHz = (pitchVolts: number) => VCO_C4_HZ * Math.pow(2, pitchVolts);

const MAJOR = SAMPLE_HOLD_SCALES.findIndex((s) => s.id === 'major');

// ── Goertzel-based dominant-frequency estimator (same as meowbox scenario) ──
function goertzel(samples: Float32Array, sampleRate: number, targetFreq: number): number {
  const k = (samples.length * targetFreq) / sampleRate;
  const omega = (TWO_PI * k) / samples.length;
  const coeff = 2 * Math.cos(omega);
  let q1 = 0, q2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const q0 = coeff * q1 - q2 + samples[i]!;
    q2 = q1;
    q1 = q0;
  }
  return q1 * q1 + q2 * q2 - q1 * q2 * coeff;
}

function dominantFrequency(buffer: Float32Array, sampleRate: number): number {
  const n = buffer.length;
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const win = 0.5 * (1 - Math.cos((TWO_PI * i) / (n - 1)));
    w[i] = buffer[i]! * win;
  }
  const maxFreq = Math.min(20_000, sampleRate / 2 - 100);
  const coarseStepHz = 4;
  let coarseBest = 20, coarseBestMag = -Infinity;
  for (let f = 20; f <= maxFreq; f += coarseStepHz) {
    const mag = goertzel(w, sampleRate, f);
    if (mag > coarseBestMag) { coarseBestMag = mag; coarseBest = f; }
  }
  let fineBest = coarseBest, fineBestMag = coarseBestMag;
  for (let f = coarseBest - coarseStepHz; f <= coarseBest + coarseStepHz; f += 0.05) {
    const mag = goertzel(w, sampleRate, f);
    if (mag > fineBestMag) { fineBestMag = mag; fineBest = f; }
  }
  return fineBest;
}

async function renderOscillatorAt(freqHz: number): Promise<Float32Array> {
  const ctx = new OfflineAudioContext({
    numberOfChannels: 1,
    length: Math.round(SAMPLE_RATE * DURATION_S),
    sampleRate: SAMPLE_RATE,
  });
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freqHz, 0);
  osc.connect(ctx.destination);
  osc.start(0);
  osc.stop(DURATION_S);
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}

/** True iff `volts` is a note of the given scale (within float slack). */
function isScaleNote(volts: number, scaleIndex: number): boolean {
  const semi = Math.round(volts * 12);
  const within = ((semi % 12) + 12) % 12;
  return SAMPLE_HOLD_SCALES[scaleIndex]!.degrees.includes(within)
    && Math.abs(volts * 12 - semi) < 1e-6;
}

describe('sample-hold / composite — build-toolchain pin', () => {
  it('built worklet SHA matches the source SHA (refresh dist/ if it fails)', async () => {
    const src = await moduleSourceSha('sample-hold');
    const built = await builtSha('sample-hold');
    expect(built, 'forgot `task dsp:build`?').toBe(src);
  });
});

describe('sample-hold → analogVco → scope — GATED (sample & hold) steps', () => {
  // A slow ramp -1V..+1V over the whole render; a clock that pulses every
  // CLOCK_PERIOD samples. On each clock rising edge the ramp is latched +
  // quantized → the VCO pitch steps.
  const N = Math.round(SAMPLE_RATE * DURATION_S);
  const CLOCK_PERIOD = Math.round(N / 8); // 8 steps over the render
  const CLOCK_WIDTH = Math.round(CLOCK_PERIOD * 0.25);

  // Produce the held + quantized voltage at every sample, plus the per-step
  // quantized values latched at each rising edge.
  function runChain(): { quantPerSample: Float32Array; stepVolts: number[] } {
    const quant = new Float32Array(N);
    const stepVolts: number[] = [];
    let held = 0, prevGate = 0;
    for (let i = 0; i < N; i++) {
      const ramp = (i / (N - 1)) * 2 - 1; // -1..+1
      const phase = i % CLOCK_PERIOD;
      const gate = phase < CLOCK_WIDTH ? 1 : 0;
      const wasHeld = held;
      const r = sampleHoldStep(ramp, gate, prevGate, held, /*gateConnected*/ true, MAJOR);
      held = r.held; prevGate = r.prevGate;
      quant[i] = r.quant;
      if (held !== wasHeld) stepVolts.push(held); // a fresh latch happened
    }
    return { quantPerSample: quant, stepVolts };
  }

  it('latches several distinct steps, each on a Major-scale note', () => {
    const { stepVolts } = runChain();
    expect(stepVolts.length, 'expected multiple latched steps').toBeGreaterThanOrEqual(4);
    for (const v of stepVolts) {
      const qv = quantizeVoltage(v, MAJOR);
      expect(isScaleNote(qv, MAJOR), `latched ${v} → quant ${qv} must be a Major note`).toBe(true);
    }
  });

  it('the VCO fundamental at each step matches 261.626·2^(quant) (FFT round-trip)', async () => {
    const { stepVolts } = runChain();
    for (const v of stepVolts) {
      const qv = quantizeVoltage(v, MAJOR);
      const expectedHz = vcoFreqHz(qv);
      const buf = await renderOscillatorAt(expectedHz);
      const dominant = dominantFrequency(buf, SAMPLE_RATE);
      expect(
        Math.abs(dominant - expectedHz),
        `step quant ${qv}V → expected ${expectedHz.toFixed(2)}Hz, rendered ${dominant.toFixed(2)}Hz`,
      ).toBeLessThan(FREQ_TOLERANCE_HZ);
    }
  });

  it('cv_quant is piecewise-CONSTANT between clock edges (true sample & hold)', () => {
    const { quantPerSample } = runChain();
    // Within each clock period, after the edge settles the value must not
    // change until the next period. Count change-points: ≤ number of steps.
    let changes = 0;
    for (let i = 1; i < quantPerSample.length; i++) {
      if (Math.abs(quantPerSample[i]! - quantPerSample[i - 1]!) > 1e-7) changes++;
    }
    // 8 clock periods → at most ~8 distinct held values → far fewer change
    // points than a continuously-varying signal (which would change ~every
    // few samples as the ramp crosses quantize boundaries).
    expect(changes).toBeLessThanOrEqual(16);
  });

  it('matches the stepped cv_quant .f32 baseline (RMS tier B)', async () => {
    const { quantPerSample } = runChain();
    const scenarioId = 'sample-hold/gated-quant-steps';
    const existing = await readBaseline(scenarioId);
    if (SHOULD_UPDATE_BASELINES || !existing) {
      await writeBaseline(scenarioId, quantPerSample);
      return;
    }
    const cmp = compareBuffers(quantPerSample, existing, 'B');
    expect(cmp.pass, cmp.detail).toBe(true);
  });
});

describe('sample-hold → analogVco → scope — CONTINUOUS quantizer (no gate)', () => {
  const N = Math.round(SAMPLE_RATE * DURATION_S);

  // gate_in UNPATCHED → cv passes through + quantizes continuously.
  function runQuantizer(): Float32Array {
    const quant = new Float32Array(N);
    let held = 0, prevGate = 0;
    for (let i = 0; i < N; i++) {
      const ramp = (i / (N - 1)) * 2 - 1; // -1..+1
      const r = sampleHoldStep(ramp, 0, prevGate, held, /*gateConnected*/ false, MAJOR);
      held = r.held; prevGate = r.prevGate;
      quant[i] = r.quant;
    }
    return quant;
  }

  it('every quantized sample is an admitted Major-scale note', () => {
    const quant = runQuantizer();
    for (let i = 0; i < quant.length; i += 17) { // stride-sample to keep it fast
      expect(isScaleNote(quant[i]!, MAJOR), `sample ${i} = ${quant[i]} not a Major note`).toBe(true);
    }
  });

  it('the quantized curve is monotonic-non-decreasing over a rising ramp (staircase)', () => {
    const quant = runQuantizer();
    for (let i = 1; i < quant.length; i++) {
      expect(quant[i]! >= quant[i - 1]! - 1e-9, `step down at ${i}`).toBe(true);
    }
    // …and it's a STAIRCASE (more than one distinct level, fewer than the ramp).
    const levels = new Set(Array.from(quant).map((v) => Math.round(v * 1e4))).size;
    expect(levels).toBeGreaterThan(3);   // several scale steps
    expect(levels).toBeLessThan(quant.length / 10); // but clearly stepped, not continuous
  });

  it('the continuous-quantizer VCO fundamentals at sampled points match 261.626·2^(quant)', async () => {
    const quant = runQuantizer();
    // Sample a few points along the staircase + FFT-confirm the VCO Hz.
    for (const frac of [0.1, 0.35, 0.6, 0.85]) {
      const idx = Math.floor(frac * (N - 1));
      const expectedHz = vcoFreqHz(quant[idx]!);
      const buf = await renderOscillatorAt(expectedHz);
      const dominant = dominantFrequency(buf, SAMPLE_RATE);
      expect(
        Math.abs(dominant - expectedHz),
        `@${frac}: quant ${quant[idx]}V → expected ${expectedHz.toFixed(2)}Hz, rendered ${dominant.toFixed(2)}Hz`,
      ).toBeLessThan(FREQ_TOLERANCE_HZ);
    }
  });

  it('matches the continuous cv_quant .f32 baseline (RMS tier B)', async () => {
    const quant = runQuantizer();
    const scenarioId = 'sample-hold/continuous-quant-curve';
    const existing = await readBaseline(scenarioId);
    if (SHOULD_UPDATE_BASELINES || !existing) {
      await writeBaseline(scenarioId, quant);
      return;
    }
    const cmp = compareBuffers(quant, existing, 'B');
    expect(cmp.pass, cmp.detail).toBe(true);
  });
});
