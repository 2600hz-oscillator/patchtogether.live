// packages/dsp/src/lib/seq-clock-core.test.ts
//
// Unit tests for the SEQ-CLOCK CORE — the sequencer's internal-clock step engine
// extracted for the AudioWorklet (so a canvas-drag main-thread stall can't drop
// steps). Pure + deterministic: every step boundary, gate width, swing offset and
// S&H hold is pinned at a fixed sampleRate/bpm.

import { describe, it, expect } from 'vitest';
import {
  SeqClockCore,
  midiToVoct,
  stepDurationSeconds,
  SEQ_C4_MIDI,
  type SeqStep,
} from './seq-clock-core';

const SR = 48000;

function on(midi: number): SeqStep {
  return { on: true, midi };
}
const REST: SeqStep = { on: false, midi: null };

/** Render n samples and return the pitch + gate buffers. */
function render(core: SeqClockCore, n: number): { pitch: Float32Array; gate: Float32Array } {
  const pitch = new Float32Array(n);
  const gate = new Float32Array(n);
  core.process(pitch, gate, n);
  return { pitch, gate };
}

describe('midiToVoct (C4=60 ⇒ 0 V, 1 V/oct)', () => {
  it('maps the reference notes', () => {
    expect(midiToVoct(SEQ_C4_MIDI)).toBe(0); // C4
    expect(midiToVoct(72)).toBeCloseTo(1); // C5 = +1 oct
    expect(midiToVoct(48)).toBeCloseTo(-1); // C3 = -1 oct
    expect(midiToVoct(63)).toBeCloseTo(0.25); // D#4 = +3 semis
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

describe('SeqClockCore step timing + gate + pitch', () => {
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

  it('emits each step at its 6000-sample boundary with the right pitch', () => {
    const core = new SeqClockCore(SR, baseCfg);
    const { pitch, gate } = render(core, 30000);
    // sample indices safely INSIDE each step (avoid float boundary fragility)
    expect(pitch[100]).toBeCloseTo(0); // step0 C4 = 0 V
    expect(gate[100]).toBe(1);
    expect(pitch[6100]).toBeCloseTo(4 / 12); // step1 E4
    expect(gate[6100]).toBe(1);
    expect(pitch[12100]).toBeCloseTo(4 / 12); // step2 REST → S&H holds E4
    expect(gate[12100]).toBe(0); // rest: gate stays low
    expect(pitch[18100]).toBeCloseTo(7 / 12); // step3 G4
    expect(gate[18100]).toBe(1);
    expect(pitch[24100]).toBeCloseTo(0); // wrapped back to step0 C4
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
    const { pitch } = render(core, 7000);
    expect(pitch[100]).toBeCloseTo(1); // C4 + 1 oct
    expect(pitch[6100]).toBeCloseTo(4 / 12 + 1); // E4 + 1 oct
  });

  it('wraps at the active length, not the steps array length', () => {
    // length 2 ⇒ only C4/E4 cycle; step index never reaches the rest/G4.
    const core = new SeqClockCore(SR, { ...baseCfg, length: 2 });
    const { pitch } = render(core, 13000);
    expect(pitch[100]).toBeCloseTo(0); // C4
    expect(pitch[6100]).toBeCloseTo(4 / 12); // E4
    expect(pitch[12100]).toBeCloseTo(0); // back to C4 (wrapped at 2)
  });

  it('respects swing in the sample positions of step boundaries', () => {
    // even step0 = 0.15625 s = 7500 samples; odd step1 = 0.09375 s = 4500.
    const core = new SeqClockCore(SR, { ...baseCfg, swing: 0.5 });
    const { pitch } = render(core, 13000);
    expect(pitch[100]).toBeCloseTo(0); // step0 C4 (lasts to ~7500)
    expect(pitch[7000]).toBeCloseTo(0); // still step0
    expect(pitch[7600]).toBeCloseTo(4 / 12); // step1 E4 (started ~7500)
    expect(pitch[12100]).toBeCloseTo(4 / 12); // step2 rest holds E4 (started ~12000)
  });
});

describe('SeqClockCore block-size invariance (scheduler drift)', () => {
  // BLIND SPOT: the coarse per-module behavioral metric is RMS/centroid over a
  // whole render — it can't see WHERE a pulse lands, only that energy exists.
  // A block-boundary bug (a step advanced a frame early/late depending on how
  // many samples the audio callback happened to hand us) leaves RMS untouched
  // yet shifts every downstream gate. This pins that the engine is a pure
  // function of ELAPSED SAMPLES, not of block segmentation: rendering one
  // 48000-sample block must be byte-identical to rendering 375×128-sample
  // blocks — same pitch, same gate, same rising-edge sample indices.
  const cfg = {
    bpm: 128, // step = 60/128/4 = 5625 samples → boundaries land MID-block
    length: 16,
    steps: [
      on(60), on(62), on(64), on(65), on(67), REST, on(69), on(71),
      on(72), REST, on(71), on(69), on(67), on(65), on(64), on(62),
    ],
    gateLength: 0.5,
    swing: 0,
    octave: 0,
    snh: true,
    running: true,
  };

  const TOTAL = 48000;
  const BLOCK = 128; // 375 * 128 = 48000 exactly

  function renderOneBlock(config: typeof cfg): { pitch: Float32Array; gate: Float32Array } {
    const core = new SeqClockCore(SR, config);
    return render(core, TOTAL);
  }

  function renderChunked(config: typeof cfg): { pitch: Float32Array; gate: Float32Array } {
    const core = new SeqClockCore(SR, config);
    const pitch = new Float32Array(TOTAL);
    const gate = new Float32Array(TOTAL);
    for (let off = 0; off < TOTAL; off += BLOCK) {
      // subarray VIEWS share the backing buffer — process() fills [0, BLOCK).
      core.process(pitch.subarray(off, off + BLOCK), gate.subarray(off, off + BLOCK), BLOCK);
    }
    return { pitch, gate };
  }

  /** Sample indices where the gate rises 0 → 1 (the audible pulse onsets). */
  function risingEdges(gate: Float32Array): number[] {
    const out: number[] = [];
    for (let i = 1; i < gate.length; i++) {
      if (gate[i - 1]! < 0.5 && gate[i]! >= 0.5) out.push(i);
    }
    return out;
  }

  it('one 48000-sample block === 375×128-sample blocks (pitch + gate byte-identical)', () => {
    const single = renderOneBlock(cfg);
    const chunked = renderChunked(cfg);
    expect(chunked.gate).toEqual(single.gate);
    expect(chunked.pitch).toEqual(single.pitch);
  });

  it('pulse onset sample-indices are identical under either segmentation', () => {
    const single = risingEdges(renderOneBlock(cfg).gate);
    const chunked = risingEdges(renderChunked(cfg).gate);
    // At 128 BPM, 14 gated steps/pattern over 1 s ≈ 8.53 steps → a handful of
    // onsets; the exact indices must match to the SAMPLE regardless of blocking.
    expect(chunked).toEqual(single);
    expect(single.length).toBeGreaterThan(4); // genuinely fired several pulses
  });

  it('still block-invariant with SWING (uneven step durations stress boundaries)', () => {
    // swing 0.5 → even steps 1.25×, odd 0.75×: boundaries fall at non-uniform
    // offsets, so any per-block accumulator reset would desync immediately.
    const swung = { ...cfg, swing: 0.5 };
    const single = renderOneBlock(swung);
    const chunked = renderChunked(swung);
    expect(chunked.gate).toEqual(single.gate);
    expect(chunked.pitch).toEqual(single.pitch);
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

  it('emits no gate while stopped (and holds pitch frozen)', () => {
    const core = new SeqClockCore(SR, cfg);
    const { gate } = render(core, 12000);
    expect(Array.from(gate).every((g) => g === 0)).toBe(true);
  });

  it('restarts from step 0 when transport starts', () => {
    const core = new SeqClockCore(SR, cfg);
    render(core, 3000); // stopped: no advance
    core.setConfig({ running: true });
    const { pitch, gate } = render(core, 1000);
    expect(pitch[10]).toBeCloseTo(0); // step 0 C4, fresh
    expect(gate[10]).toBe(1);
    expect(core.currentStep).toBe(0);
  });
});
