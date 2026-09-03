// packages/dsp/src/lib/cv-clock-core.test.ts
//
// Unit tests for the CV-CLOCK CORE — CV Buddy's RUN + CLOCK generator moved
// onto the audio thread (the SPEEDERR-001 dropped-pulse fix). Pure +
// deterministic: every grid point, anchor, tempo change and drop is pinned at
// a fixed sampleRate.
//
// The invariants welded down here are the same three the #2324 suite pins on
// the main-thread path, restated for a per-sample renderer:
//   • never more edges than the grid demands,
//   • never two edges closer together than one period,
//   • every grid point is either EMITTED or COUNTED as skipped.
// Plus the property that is the whole point of the move: rendering with ZERO
// main-thread interaction (no setConfig calls at all) emits the complete grid,
// because the config channel is the only thing a stall can starve.

import { describe, it, expect } from 'vitest';
import { CvClockCore, cvPulsePeriodS, type CvClockConfig } from './cv-clock-core';

const SR = 48000;

// The SPEEDERR performance's own numbers (ledger item 10), so a regression is
// measured where it bit. Period ≈ 159.42 ms.
const BPM = 94.08761422877872;
const PPQN = 4;
const PERIOD = cvPulsePeriodS(BPM, PPQN);

const RUN_LEVEL = 0.5; // web GATE_HI
const PULSE_S = 0.005; // web CLOCK_PULSE_HIGH_S

function runningCfg(over?: Partial<CvClockConfig>): Partial<CvClockConfig> {
  return {
    bpm: BPM,
    ppqn: PPQN,
    offsetMs: 0,
    running: true,
    runLevel: RUN_LEVEL,
    pulseS: PULSE_S,
    ...over,
  };
}

/** Render `frames` samples in worklet-sized 128-frame quanta; returns the two
 *  signals concatenated. Quantized rendering matters: it is how the real
 *  worklet drives the core, so boundary bugs at quantum edges are visible. */
function render(core: CvClockCore, frames: number): { clock: Float32Array; run: Float32Array } {
  const clock = new Float32Array(frames);
  const run = new Float32Array(frames);
  const q = 128;
  for (let at = 0; at < frames; at += q) {
    const n = Math.min(q, frames - at);
    const c = new Float32Array(n);
    const r = new Float32Array(n);
    core.process(c, r, n);
    clock.set(c, at);
    run.set(r, at);
  }
  return { clock, run };
}

/** Sample indices of rising edges (0→1 crossings at the 0.5 threshold). */
function risingEdges(sig: Float32Array): number[] {
  const edges: number[] = [];
  let prev = 0;
  for (let i = 0; i < sig.length; i++) {
    const cur = sig[i]!;
    if (prev < 0.5 && cur >= 0.5) edges.push(i);
    prev = cur;
  }
  return edges;
}

/** ±1-sample edge comparison — a due time that is not binary-exact may cross
 *  the sample grid one sample late, which is not a timing defect at 48 kHz. */
function expectEdgesNear(edges: number[], expected: number[]): void {
  expect(edges.length, `edges ${edges.join(',')} vs ${expected.join(',')}`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(Math.abs(edges[i]! - expected[i]!), `edge ${i}: ${edges[i]} vs ${expected[i]}`)
      .toBeLessThanOrEqual(1);
  }
}

/** Every way a train violates the one-period floor, so a failure names the
 *  mode (the #2324 checker, in samples). */
function burstViolations(edges: number[], periodSamples: number): string[] {
  const bad: string[] = [];
  for (let i = 1; i < edges.length; i++) {
    const gap = edges[i]! - edges[i - 1]!;
    // ±2 samples of float-boundary slack on a >7600-sample period.
    if (gap < periodSamples - 2) {
      bad.push(`edge ${i} is ${gap} samples after its predecessor (< ${periodSamples})`);
    }
  }
  return bad;
}

describe('cvPulsePeriodS (the clock-math.ts law, restated)', () => {
  it('is 60/bpm/ppqn', () => {
    expect(cvPulsePeriodS(120, 24)).toBeCloseTo(60 / 120 / 24);
    expect(cvPulsePeriodS(BPM, PPQN)).toBeCloseTo(0.15942, 4);
  });
  it('degenerate inputs → Infinity (emit nothing, hold phase)', () => {
    for (const [b, p] of [
      [0, 24],
      [-1, 24],
      [NaN, 24],
      [120, 0],
      [120, -4],
      [120, NaN],
      [Infinity, 24],
    ] as const) {
      expect(cvPulsePeriodS(b, p)).toBe(Infinity);
    }
  });
});

describe('CvClockCore — grid timing', () => {
  it('anchors on start: the first pulse fires immediately, then every period', () => {
    const core = new CvClockCore(SR, runningCfg());
    const { clock } = render(core, SR); // 1 s
    const edges = risingEdges(clock);
    expect(edges[0]).toBe(0); // the train begins WITH the transport
    const periodSamples = PERIOD * SR;
    for (let i = 0; i < edges.length; i++) {
      expect(Math.abs(edges[i]! - i * periodSamples)).toBeLessThanOrEqual(1);
    }
    // exactly the grid: floor(1s / period) + 1 pulses in [0, 1s)
    expect(edges.length).toBe(Math.floor(SR / periodSamples) + 1);
    expect(core.skipped).toBe(0);
  });

  it('each pulse is a pulseS-wide square at amplitude 1', () => {
    const core = new CvClockCore(SR, runningCfg());
    const { clock } = render(core, 24000);
    const high = Math.round(PULSE_S * SR); // 240 samples
    expect(clock[0]).toBe(1);
    expect(clock[high - 1]).toBe(1);
    expect(clock[high]).toBe(0);
  });

  it('RUN holds runLevel while running and 0 while stopped; stop re-anchors', () => {
    const core = new CvClockCore(SR, runningCfg());
    const a = render(core, 4800);
    expect(a.run.every((v) => v === RUN_LEVEL)).toBe(true);

    core.setConfig({ running: false });
    const b = render(core, 4800);
    expect(b.run.every((v) => v === 0)).toBe(true);
    expect(b.clock.every((v) => v === 0)).toBe(true); // line drops at once

    core.setConfig({ running: true });
    const c = render(core, 4800);
    expect(risingEdges(c.clock)[0]).toBe(0); // re-anchored: starts WITH play (anchor is exact)
  });

  it('a mid-pulse stop drops the clock line immediately (stopClock parity)', () => {
    const core = new CvClockCore(SR, runningCfg());
    const head = new Float32Array(100); // inside the 240-sample pulse
    const run = new Float32Array(100);
    core.process(head, run, 100);
    expect(head[99]).toBe(1);
    core.setConfig({ running: false });
    const tail = new Float32Array(100);
    core.process(tail, run, 100);
    expect(tail[0]).toBe(0);
  });
});

describe('CvClockCore — live config (the accumulator semantics)', () => {
  it('a tempo change alters the INTERVAL from the next pulse onward — no teleport', () => {
    const core = new CvClockCore(SR, runningCfg({ bpm: 120, ppqn: 24 }));
    // 120 BPM / 24 PPQN → period 20.833 ms = 1000 samples.
    const a = render(core, 2500); // pulses at 0, 1000, 2000; next due 3000
    expectEdgesNear(risingEdges(a.clock), [0, 1000, 2000]);
    core.setConfig({ bpm: 60 }); // period doubles to 2000 samples
    const b = render(core, 6000);
    // The pulse already due at 3000 (i.e. 500 into this render) stays put —
    // the NEW interval applies after it. A grid re-anchored to the tempo
    // change would move it; the accumulator must not.
    expectEdgesNear(risingEdges(b.clock), [500, 2500, 4500]);
    expect(core.skipped).toBe(0);
  });

  it('an offset trim moves the pulses by exactly the trim delta', () => {
    const core = new CvClockCore(SR, runningCfg({ bpm: 120, ppqn: 24, offsetMs: 0 }));
    // 2400 frames: past the 240-sample tail of the pulse at 2000, so the line
    // is LOW at the render boundary and the second detector pass starts clean.
    const a = render(core, 2400);
    expectEdgesNear(risingEdges(a.clock), [0, 1000, 2000]);
    core.setConfig({ offsetMs: 10 }); // +480 samples, applied at emit
    const b = render(core, 3000);
    // next unshifted grid points: 3000, 4000 (local 600, 1600) → +480
    expectEdgesNear(risingEdges(b.clock), [600 + 480, 1600 + 480]);
  });

  it('a degenerate tempo emits nothing and HOLDS the phase for recovery', () => {
    const core = new CvClockCore(SR, runningCfg({ bpm: 120, ppqn: 24 }));
    render(core, 1500); // pulses at 0, 1000; next due 2000
    core.setConfig({ bpm: NaN });
    const b = render(core, 1000); // covers the 2000 grid point
    expect(risingEdges(b.clock)).toEqual([]);
    core.setConfig({ bpm: 120 });
    const c = render(core, 1000);
    // The held `next` (2000, i.e. 500 in the past on recovery) is DROPPED and
    // counted, and the grid resumes on the original phase — never a burst.
    const edges = risingEdges(c.clock);
    expectEdgesNear(edges, [500]); // 3000 on the original grid
    expect(core.skipped).toBe(1); // the 2000 point, counted not flushed
  });
});

describe('CvClockCore — drop-not-flush (#2324 restated on the audio thread)', () => {
  /** Render phases with a config change between each, then detect edges over
   *  the CONCATENATED signal — per-phase detection would fabricate a rising
   *  edge whenever a pulse is still high across a phase boundary. */
  function renderPhases(
    core: CvClockCore,
    phases: Array<{ frames: number; cfg?: Partial<CvClockConfig> }>,
  ): Float32Array {
    const total = phases.reduce((s, p) => s + p.frames, 0);
    const clock = new Float32Array(total);
    let at = 0;
    for (const p of phases) {
      if (p.cfg) core.setConfig(p.cfg);
      const r = render(core, p.frames);
      clock.set(r.clock, at);
      at += p.frames;
    }
    return clock;
  }

  it('a config jump that moves pulses into the past DROPS them, never clumps', () => {
    const core = new CvClockCore(SR, runningCfg({ bpm: 300, ppqn: 24, offsetMs: 20 }));
    // period = 60/300/24 s = 400 samples; offset +20 ms = +960 samples.
    // Slamming the trim to -20 ms moves every due time 1920 samples earlier —
    // ~4.8 periods of backlog appear "in the past" at once.
    const clock = renderPhases(core, [
      { frames: 5000 },
      { frames: 5000, cfg: { offsetMs: -20 } },
    ]);
    expect(burstViolations(risingEdges(clock), 400)).toEqual([]);
    expect(core.skipped).toBeGreaterThan(0);
  });

  it('CONSERVATION: emitted + skipped account for the grid exactly', () => {
    const core = new CvClockCore(SR, runningCfg({ bpm: 300, ppqn: 24, offsetMs: 20 }));
    const clock = renderPhases(core, [
      { frames: 5000 },
      { frames: 5000, cfg: { offsetMs: -20 } },
      { frames: 5000, cfg: { offsetMs: 20 } },
    ]);
    expect(burstViolations(risingEdges(clock), 400)).toEqual([]);
    // 15000 samples at a 400-sample period, anchored at 0: grid points due in
    // [0, 15000) shifted by the live offset — emitted + skipped must cover the
    // span within the ±1 half-open boundary the #2324 suite allows.
    const spanned = Math.floor(15000 / 400) + 1;
    expect(Math.abs(core.pulses + core.skipped - spanned)).toBeLessThanOrEqual(1);
  });
});

describe('CvClockCore — STALL IMMUNITY (the reason this core exists)', () => {
  it('rendering 2 s with ZERO setConfig traffic emits the complete grid', () => {
    // The main-thread analogue of this window (a 400 ms stall against a
    // 200 ms lookahead) drops exactly one pulse — reproduced as the positive
    // control in cv-buddy-clock-worklet.test.ts against the real scheduler.
    // Here the config channel goes completely silent (the worst stall
    // imaginable) and the train must not care.
    const core = new CvClockCore(SR, runningCfg());
    const frames = 2 * SR;
    const { clock } = render(core, frames);
    const edges = risingEdges(clock);
    const periodSamples = PERIOD * SR;
    expect(edges.length).toBe(Math.floor(frames / periodSamples) + 1);
    expect(burstViolations(edges, periodSamples)).toEqual([]);
    expect(core.skipped).toBe(0);
    // and every edge sits ON the anchored grid (no re-phasing)
    for (let i = 0; i < edges.length; i++) {
      expect(Math.abs(edges[i]! - i * periodSamples)).toBeLessThanOrEqual(1);
    }
  });
});
