// packages/dsp/src/lib/seq-clock-core.test.ts
//
// Unit tests for the SEQ-CLOCK CORE — the sequencer's internal-clock step engine
// extracted for the AudioWorklet (so a canvas-drag main-thread stall can't drop
// steps). Pure + deterministic: every step boundary, gate width, swing offset,
// S&H hold, POLY chord lane and CLOCK pulse is pinned at a fixed sampleRate/bpm.

import { describe, it, expect } from 'vitest';
import {
  SeqClockCore,
  midiToVOct,
  stepDurationSeconds,
  SEQ_C4_MIDI,
  SEQ_POLY_LANES,
  SEQ_CLOCK_PULSE_S,
  type SeqStep,
  type SeqClockOut,
} from './seq-clock-core';

const SR = 48000;

function on(midi: number): SeqStep {
  return { on: true, midi };
}
const REST: SeqStep = { on: false, midi: null };

/** Render n samples into a fresh poly output bundle. */
function render(core: SeqClockCore, n: number): Required<SeqClockOut> {
  const lanePitch = Array.from({ length: SEQ_POLY_LANES }, () => new Float32Array(n));
  const laneGate = Array.from({ length: SEQ_POLY_LANES }, () => new Float32Array(n));
  const gate = new Float32Array(n);
  const clock = new Float32Array(n);
  core.process({ lanePitch, laneGate, gate, clock }, n);
  return { lanePitch, laneGate, gate, clock };
}

describe('midiToVOct (C4=60 ⇒ 0 V, 1 V/oct)', () => {
  it('maps the reference notes', () => {
    expect(midiToVOct(SEQ_C4_MIDI)).toBe(0); // C4
    expect(midiToVOct(72)).toBeCloseTo(1); // C5 = +1 oct
    expect(midiToVOct(48)).toBeCloseTo(-1); // C3 = -1 oct
    expect(midiToVOct(63)).toBeCloseTo(0.25); // D#4 = +3 semis
  });
});

describe('stepDurationSeconds (16th-note base + swing by parity)', () => {
  it('is 60/bpm/4 with no swing', () => {
    expect(stepDurationSeconds(120, 0, 0)).toBeCloseTo(0.125);
    expect(stepDurationSeconds(120, 1, 0)).toBeCloseTo(0.125);
    expect(stepDurationSeconds(60, 0, 0)).toBeCloseTo(0.25);
  });
  it('lengthens even (on-beat) steps and shortens odd (off-beat) steps', () => {
    // swing 0.5 → even ×1.25, odd ×0.75 (matches sequencer.ts:722-724)
    expect(stepDurationSeconds(120, 0, 0.5)).toBeCloseTo(0.125 * 1.25);
    expect(stepDurationSeconds(120, 1, 0.5)).toBeCloseTo(0.125 * 0.75);
    // a swing pair sums to two straight steps (no net tempo drift)
    expect(stepDurationSeconds(120, 0, 0.5) + stepDurationSeconds(120, 1, 0.5)).toBeCloseTo(0.25);
  });
});

describe('SeqClockCore step timing + gate + pitch (mono lane 0)', () => {
  // bpm 120 ⇒ 0.125 s/step = 6000 samples @ 48 kHz; gate 0.5 ⇒ high for 3000.
  const baseCfg = {
    bpm: 120,
    length: 4,
    steps: [on(60), on(64), REST, on(67)], // C4, E4, rest, G4
    gateLength: 0.5,
    swing: 0,
    octave: 0,
    snh: true,
    running: true,
  };

  it('emits each step at its 6000-sample boundary with the right pitch on lane 0', () => {
    const core = new SeqClockCore(SR, baseCfg);
    const { lanePitch, gate } = render(core, 30000);
    const p = lanePitch[0];
    // sample indices safely INSIDE each step (avoid float boundary fragility)
    expect(p[100]).toBeCloseTo(0); // step0 C4 = 0 V
    expect(gate[100]).toBe(1);
    expect(p[6100]).toBeCloseTo(4 / 12); // step1 E4
    expect(gate[6100]).toBe(1);
    expect(p[12100]).toBeCloseTo(4 / 12); // step2 REST → S&H holds E4
    expect(gate[12100]).toBe(0); // rest: gate stays low
    expect(p[18100]).toBeCloseTo(7 / 12); // step3 G4
    expect(gate[18100]).toBe(1);
    expect(p[24100]).toBeCloseTo(0); // wrapped back to step0 C4
    expect(gate[24100]).toBe(1);
  });

  it('holds the gate for stepDur × gateLength then closes it', () => {
    const core = new SeqClockCore(SR, baseCfg);
    const { gate } = render(core, 6000);
    // gateOff = 0.0625 s = 3000 samples
    expect(gate[0]).toBe(1);
    expect(gate[2999]).toBe(1);
    expect(gate[3001]).toBe(0);
    expect(gate[5999]).toBe(0);
  });

  it('applies octave as whole V/oct shifts to every step', () => {
    const core = new SeqClockCore(SR, { ...baseCfg, octave: 1 });
    const { lanePitch } = render(core, 7000);
    expect(lanePitch[0][100]).toBeCloseTo(1); // C4 + 1 oct
    expect(lanePitch[0][6100]).toBeCloseTo(4 / 12 + 1); // E4 + 1 oct
  });

  it('wraps at the active length, not the steps array length', () => {
    // length 2 ⇒ only C4/E4 cycle; step index never reaches the rest/G4.
    const core = new SeqClockCore(SR, { ...baseCfg, length: 2 });
    const { lanePitch } = render(core, 13000);
    expect(lanePitch[0][100]).toBeCloseTo(0); // C4
    expect(lanePitch[0][6100]).toBeCloseTo(4 / 12); // E4
    expect(lanePitch[0][12100]).toBeCloseTo(0); // back to C4 (wrapped at 2)
  });

  it('respects swing in the sample positions of step boundaries', () => {
    // even step0 = 0.15625 s = 7500 samples; odd step1 = 0.09375 s = 4500.
    const core = new SeqClockCore(SR, { ...baseCfg, swing: 0.5 });
    const { lanePitch } = render(core, 13000);
    const p = lanePitch[0];
    expect(p[100]).toBeCloseTo(0); // step0 C4 (lasts to ~7500)
    expect(p[7000]).toBeCloseTo(0); // still step0
    expect(p[7600]).toBeCloseTo(4 / 12); // step1 E4 (started ~7500)
    expect(p[12100]).toBeCloseTo(4 / 12); // step2 rest holds E4 (started ~12000)
  });

  it('keeps lanes 1-4 silent for a mono step', () => {
    const core = new SeqClockCore(SR, baseCfg);
    const { laneGate } = render(core, 1000);
    expect(laneGate[0][100]).toBe(1); // mono voice on lane 0
    for (let l = 1; l < SEQ_POLY_LANES; l++) expect(laneGate[l][100]).toBe(0);
  });
});

describe('SeqClockCore POLY chord lanes', () => {
  // A single C-major triad step: lane0=C4(0), lane1=E4(4/12), lane2=G4(7/12),
  // lane3=C5(1), lane4 silent — all gated within the gate window.
  const cfg = {
    bpm: 120,
    length: 1,
    steps: [{ on: true, midi: 60, chord: 'maj' as const }],
    gateLength: 0.5,
    swing: 0,
    octave: 0,
    snh: true,
    running: true,
  };

  it('spreads a maj chord across lanes 0-3 with lane 4 silent', () => {
    const core = new SeqClockCore(SR, cfg);
    const { lanePitch, laneGate, gate } = render(core, 1000);
    expect(lanePitch[0][100]).toBeCloseTo(0); // C4
    expect(lanePitch[1][100]).toBeCloseTo(4 / 12); // E4 (major third)
    expect(lanePitch[2][100]).toBeCloseTo(7 / 12); // G4 (fifth)
    expect(lanePitch[3][100]).toBeCloseTo(1); // C5 (root + octave)
    for (let l = 0; l < 4; l++) expect(laneGate[l][100]).toBe(1);
    expect(laneGate[4][100]).toBe(0); // 4th lane unused by a triad
    expect(gate[100]).toBe(1); // mono gate high while ANY lane is gated
  });

  it('uses a minor third for a min chord', () => {
    const core = new SeqClockCore(SR, { ...cfg, steps: [{ on: true, midi: 60, chord: 'min' as const }] });
    const { lanePitch } = render(core, 1000);
    expect(lanePitch[1][100]).toBeCloseTo(3 / 12); // Eb4 (minor third)
  });
});

describe('SeqClockCore clock pulse', () => {
  const cfg = {
    bpm: 120, // 6000 samples/step @ 48 kHz
    length: 2,
    steps: [on(60), on(64)],
    gateLength: 0.5,
    swing: 0,
    octave: 0,
    snh: true,
    running: true,
  };

  it('pulses high at each step boundary, then low for the rest of the step', () => {
    // pulse width = SEQ_CLOCK_PULSE_S = 0.01 s = 480 samples.
    expect(SEQ_CLOCK_PULSE_S).toBe(0.01);
    const core = new SeqClockCore(SR, cfg);
    const { clock } = render(core, 13000);
    expect(clock[100]).toBe(1); // step0 pulse
    expect(clock[479]).toBe(1); // still within the 480-sample pulse
    expect(clock[3000]).toBe(0); // mid-step: pulse over
    expect(clock[6100]).toBe(1); // step1 pulse
    expect(clock[9000]).toBe(0); // mid-step1: pulse over
    expect(clock[12100]).toBe(1); // wrapped to step0 again
  });
});

describe('SeqClockCore transport', () => {
  const cfg = {
    bpm: 120,
    length: 4,
    steps: [on(60), on(64), REST, on(67)],
    gateLength: 0.5,
    swing: 0,
    octave: 0,
    snh: true,
    running: false,
  };

  it('emits no gate or clock while stopped (and holds pitch frozen)', () => {
    const core = new SeqClockCore(SR, cfg);
    const { gate, clock } = render(core, 12000);
    expect(Array.from(gate).every((g) => g === 0)).toBe(true);
    expect(Array.from(clock).every((c) => c === 0)).toBe(true);
  });

  it('restarts from step 0 when transport starts', () => {
    const core = new SeqClockCore(SR, cfg);
    render(core, 3000); // stopped: no advance
    core.setConfig({ running: true });
    const { lanePitch, gate } = render(core, 1000);
    expect(lanePitch[0][10]).toBeCloseTo(0); // step 0 C4, fresh
    expect(gate[10]).toBe(1);
    expect(core.currentStep).toBe(0);
  });
});
