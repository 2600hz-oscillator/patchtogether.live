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

describe('SeqClockCore external clock mode', () => {
  // Same 4-step pattern, but the engine advances ONLY on externalTrigger().
  const cfg = {
    bpm: 120, // 6000 samples/step; gate 0.5 → 3000-sample gate window
    length: 4,
    steps: [on(60), on(64), REST, on(67)], // C4, E4, rest, G4
    gateLength: 0.5,
    swing: 0,
    octave: 0,
    snh: true,
    running: true,
    clockMode: 'external' as const,
  };

  it('holds silent until the first edge, then sounds step 0', () => {
    const core = new SeqClockCore(SR, cfg);
    // Before any edge: gate + clock low (parked past the envelope).
    let { gate, clock, lanePitch } = render(core, 500);
    expect(Array.from(gate).every((g) => g === 0)).toBe(true);
    expect(Array.from(clock).every((c) => c === 0)).toBe(true);
    // First edge sounds step 0 (C4).
    core.externalTrigger();
    ({ gate, clock, lanePitch } = render(core, 500));
    expect(lanePitch[0][10]).toBeCloseTo(0); // C4 = 0 V
    expect(gate[10]).toBe(1);
    expect(clock[10]).toBe(1); // a fresh clock pulse on the edge
    expect(core.currentStep).toBe(0);
  });

  it('advances exactly one step per edge and reports wrap at the loop end', () => {
    const core = new SeqClockCore(SR, cfg);
    core.externalTrigger(); // step 0
    expect(core.currentStep).toBe(0);
    let r = core.externalTrigger(); // step 1
    expect(core.currentStep).toBe(1);
    expect(r.wrapped).toBe(false);
    core.externalTrigger(); // step 2
    core.externalTrigger(); // step 3
    expect(core.currentStep).toBe(3);
    r = core.externalTrigger(); // wraps to step 0
    expect(core.currentStep).toBe(0);
    expect(r.wrapped).toBe(true);
  });

  it('process() never auto-advances in external mode', () => {
    const core = new SeqClockCore(SR, cfg);
    core.externalTrigger(); // step 0
    // Render far longer than a step duration — index must NOT move on its own.
    const adv = core.process(
      {
        lanePitch: Array.from({ length: SEQ_POLY_LANES }, () => new Float32Array(20000)),
        laneGate: Array.from({ length: SEQ_POLY_LANES }, () => new Float32Array(20000)),
        gate: new Float32Array(20000),
        clock: new Float32Array(20000),
      },
      20000,
    );
    expect(adv.advances).toBe(0);
    expect(core.currentStep).toBe(0);
  });

  it('derives gate width from BPM (closes after stepDur × gateLength)', () => {
    const core = new SeqClockCore(SR, cfg);
    render(core, 500); // consume the transport-running edge (process() → reset)
    core.externalTrigger(); // step 0
    const { gate } = render(core, 6000);
    expect(gate[0]).toBe(1);
    expect(gate[2999]).toBe(1); // gateOff = 3000 samples
    expect(gate[3001]).toBe(0);
  });
});

describe('SeqClockCore getters + advance count', () => {
  const cfg = {
    bpm: 120,
    length: 4,
    steps: [{ on: true, midi: 60, chord: 'maj' as const }, REST, on(64), REST],
    gateLength: 0.5,
    swing: 0,
    octave: 0,
    snh: true,
    running: true,
  };

  it('reports step-level gate + per-lane gate for the current step', () => {
    const core = new SeqClockCore(SR, cfg);
    render(core, 100); // inside step 0 (C maj)
    expect(core.currentGated()).toBe(true);
    expect(core.currentLaneGated(0)).toBe(true); // root
    expect(core.currentLaneGated(2)).toBe(true); // fifth
    expect(core.currentLaneGated(4)).toBe(false); // unused triad lane
  });

  it('process() returns the boundary + wrap counts crossed', () => {
    const core = new SeqClockCore(SR, cfg);
    // 4 steps × 6000 samples = 24000/loop. Render past the 6th boundary with a
    // margin (float-accumulated phase lands boundaries a sub-sample late, so an
    // exact 36000 window would clip the 6th — see the internal-timing tests).
    const N = 37000;
    const adv = core.process(
      {
        lanePitch: Array.from({ length: SEQ_POLY_LANES }, () => new Float32Array(N)),
        laneGate: Array.from({ length: SEQ_POLY_LANES }, () => new Float32Array(N)),
        gate: new Float32Array(N),
        clock: new Float32Array(N),
      },
      N,
    );
    expect(adv.advances).toBe(6); // 6 boundaries crossed (6×6000 = 36000 < 37000)
    expect(adv.wraps).toBe(1); // one full loop wrap (step 3→0) in the window
  });
});

describe('SeqClockCore main-thread-stall immunity (the PR-B regression lock)', () => {
  // THE BUG: the old sequencer refilled a 200ms lookahead from a MAIN-THREAD
  // tick; a canvas drag pinned the main thread, the lookahead drained, and steps
  // were dropped → audible tempo freeze. The worklet runs THIS core on the AUDIO
  // thread, where process() advances purely by its own sample counter — no
  // main-thread tick, setConfig, or message is needed between blocks.
  //
  // This test models a FROZEN main thread: we render block-by-block (the audio
  // thread's render quantum) with ZERO interaction in between (no setConfig, no
  // externalTrigger) and assert the gate fires the tempo-correct number of times.
  // If anyone reintroduces a main-thread dependency into the advance, the count
  // drifts and this fails.
  it('emits the tempo-correct gate count when the main thread never touches it', () => {
    // length 1, all-on at 120bpm → one gate per 16th = 8 gates/sec.
    const core = new SeqClockCore(SR, {
      bpm: 120,
      length: 1,
      steps: [on(60)],
      gateLength: 0.5,
      swing: 0,
      octave: 0,
      snh: true,
      running: true,
    });
    const BLOCK = 128; // the worklet render quantum
    const SECONDS = 1;
    const totalFrames = SR * SECONDS;
    const lanePitch = Array.from({ length: SEQ_POLY_LANES }, () => new Float32Array(BLOCK));
    const laneGate = Array.from({ length: SEQ_POLY_LANES }, () => new Float32Array(BLOCK));
    const gate = new Float32Array(BLOCK);
    const clock = new Float32Array(BLOCK);
    let prev = 0;
    let risingEdges = 0;
    let rendered = 0;
    while (rendered < totalFrames) {
      // NO setConfig / externalTrigger here — a stalled main thread does nothing.
      core.process({ lanePitch, laneGate, gate, clock }, BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        const cur = gate[i]!;
        if (prev < 0.5 && cur >= 0.5) risingEdges++;
        prev = cur;
      }
      rendered += BLOCK;
    }
    // 120bpm 16th-notes → 8 steps/sec. Allow ±1 for the window's edge alignment.
    expect(risingEdges).toBeGreaterThanOrEqual(7);
    expect(risingEdges).toBeLessThanOrEqual(8);
  });
});

describe('SeqClockCore long patterns (no 16-step truncation — adversarial-review #6)', () => {
  // SEQ_MAX_STEPS must equal the sequencer's STEP_COUNT (128). A smaller cap
  // (it was 16) makes clampLength wrap a long pattern early once the worklet
  // drives the audio — a 32-step sequence would loop at step 16. Drive a length-32
  // pattern PAST step 16 and assert the playhead actually reaches the high steps.
  it('length 32: the playhead advances past step 16 (does not wrap at 16)', () => {
    const steps = Array.from({ length: 32 }, (_, i) => on(60 + (i % 24)));
    const core = new SeqClockCore(SR, {
      bpm: 120, // 6000 samples/step
      length: 32,
      steps,
      gateLength: 0.5,
      swing: 0,
      octave: 0,
      snh: true,
      running: true,
    });
    // 20 steps × 6000 = 120000 samples; render a margin past it.
    render(core, 6000 * 20 + 3000);
    // With the bug (cap 16) this wrapped and currentStep would be ~4; fixed it's ~20.
    expect(core.currentStep).toBeGreaterThan(16);
    expect(core.currentStep).toBeLessThanOrEqual(32);
    // The held lane-0 pitch matches the CURRENT (high) step's note — all-on +
    // S&H means lane 0 holds the latest gated step's pitch.
    expect(core.lanePitch(0)).toBeCloseTo(midiToVOct(60 + (core.currentStep % 24)), 5);
  });

  it('length 128: reaches the last page (step > 100)', () => {
    const steps = Array.from({ length: 128 }, (_, i) => on(36 + (i % 60)));
    const core = new SeqClockCore(SR, {
      bpm: 600, // fast: 60/600/4 = 0.025 s = 1200 samples/step
      length: 128,
      steps,
      gateLength: 0.5,
      swing: 0,
      octave: 0,
      snh: true,
      running: true,
    });
    render(core, 1200 * 110 + 600); // ~110 steps in
    expect(core.currentStep).toBeGreaterThan(100);
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
