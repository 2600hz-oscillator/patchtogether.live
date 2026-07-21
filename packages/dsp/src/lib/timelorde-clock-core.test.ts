// packages/dsp/src/lib/timelorde-clock-core.test.ts
//
// P0 BLIND-SPOT coverage for the TIMELORDE clock engine (extracted pure core).
//
// TIMELORDE is behavioral-EXEMPT: a clock emits short gate pulses whose RMS is
// tiny and whose "spectrum" is meaningless, so the coarse per-module metric
// tells us nothing about whether the divide/multiply ratios are CORRECT. An
// off-by-one in a divisor counter, or the `Int32Array(12→13)` swing-drop bug
// (a TypedArray out-of-bounds write is a silent no-op, so the swing gate read 0
// forever), is completely invisible to RMS/centroid.
//
// This pins the ratios at the level that matters: EXACT output pulse COUNTS for
// every divide + multiply output over a fixed internal-clock window. If any
// counter drifts, a count changes and this goes red.
//
// The core is a behavior-preserving extraction of the worklet's engine (the
// worklet now delegates to it); these counts therefore also document the exact
// timing contract the real module ships.

import { describe, it, expect } from 'vitest';
import {
  TimelordeClockCore,
  OUT_1X, OUT_8X, OUT_4X, OUT_2X,
  OUT_HALF, OUT_THIRD, OUT_QTR, OUT_8TH, OUT_12TH, OUT_16TH, OUT_32ND, OUT_64TH,
  OUT_SWING,
} from './timelorde-clock-core';

const SR = 48000;
const N_OUT = 13;

function params(over: Record<string, number> = {}): Record<string, Float32Array> {
  const base: Record<string, number> = {
    bpm: 120,
    swingAmount: 0,
    swingSource: 0,
    muteOutputs: 0,
    running: 1,
    hasExternalClock: 0,
  };
  Object.assign(base, over);
  const out: Record<string, Float32Array> = {};
  for (const [k, v] of Object.entries(base)) out[k] = new Float32Array([v]);
  return out;
}

/** Render `totalSamples` of the internal clock in `block`-sized chunks, no
 *  external input. Returns one concatenated Float32Array per output (13). */
function render(
  totalSamples: number,
  p: Record<string, Float32Array>,
  block = 128,
): Float32Array[] {
  const core = new TimelordeClockCore();
  const bufs = Array.from({ length: N_OUT }, () => new Float32Array(totalSamples));
  const post = () => {}; // no external clock → no measuredBpm posts anyway
  for (let off = 0; off < totalSamples; off += block) {
    const len = Math.min(block, totalSamples - off);
    // 13 output channels, each a VIEW into the per-output accumulator.
    const outputs = bufs.map((b) => [b.subarray(off, off + len)]);
    core.process([], outputs, p, SR, post);
  }
  return bufs;
}

/** Count rising edges (0 → ≥0.5) in a gate buffer = the number of pulses. */
function pulseCount(gate: Float32Array): number {
  let n = 0;
  for (let i = 1; i < gate.length; i++) {
    if (gate[i - 1]! < 0.5 && gate[i]! >= 0.5) n++;
  }
  return n;
}

describe('TIMELORDE clock core: exact divide/multiply pulse counts', () => {
  // At 120 BPM the master (1x) period is 60/120 * 48000 = 24000 samples.
  // We render a window sized to contain EXACTLY 12 master pulses plus all of
  // their multiplier sub-pulses, and to stop BEFORE the 13th master:
  //   master k fires at ≈ k*24000; pulse 12 ≈ 288000, pulse 13 ≈ 312000.
  //   the last 8x sub-pulse of master 12 lands at ≈ 309000.
  //   309000 < 310016 < 312000  → 12 masters, no 13th, all sub-pulses included.
  const TOTAL = 310016; // 2422 × 128, a whole number of 128-sample blocks

  it('12 masters → exact counts on every output (divisors, multipliers, swing)', () => {
    const outs = render(TOTAL, params());
    const count = (idx: number) => pulseCount(outs[idx]!);

    // ── Master + multipliers (M pulses / sub-pulses per master period) ──
    expect(count(OUT_1X)).toBe(12); // 1× master
    expect(count(OUT_2X)).toBe(24); // ×2 → 2 per master
    expect(count(OUT_4X)).toBe(48); // ×4 → 4 per master
    expect(count(OUT_8X)).toBe(96); // ×8 → 8 per master

    // ── Divisors (every Nth master pulse; counter starts at 1) ──
    expect(count(OUT_HALF)).toBe(6); //  /2  → masters 2,4,6,8,10,12
    expect(count(OUT_THIRD)).toBe(4); // /3  → masters 3,6,9,12
    expect(count(OUT_QTR)).toBe(3); //  /4  → masters 4,8,12
    expect(count(OUT_8TH)).toBe(1); //  /8  → master 8
    expect(count(OUT_12TH)).toBe(1); // /12 → master 12
    expect(count(OUT_16TH)).toBe(0); // /16 → never reached in 12 masters
    expect(count(OUT_32ND)).toBe(0);
    expect(count(OUT_64TH)).toBe(0);

    // ── Swing: default source = 1x, amount 0 → a zero-lag copy of 1x. This is
    //    also the direct guard for the Int32Array(12→13) swing-drop bug: if the
    //    pulse-end array were sized 12, every swing write would be a silent
    //    out-of-bounds no-op and this would read 0.
    expect(count(OUT_SWING)).toBe(12);
  });

  it('multiplier ratios are exact relative to 1x (×2 = 2×, ×4 = 4×, ×8 = 8×)', () => {
    const outs = render(TOTAL, params());
    const base = pulseCount(outs[OUT_1X]!);
    expect(pulseCount(outs[OUT_2X]!)).toBe(base * 2);
    expect(pulseCount(outs[OUT_4X]!)).toBe(base * 4);
    expect(pulseCount(outs[OUT_8X]!)).toBe(base * 8);
  });

  it('counts are independent of audio block size (whole-block vs 128-frame)', () => {
    // The engine is a function of ELAPSED SAMPLES, not block segmentation:
    // rendering one big block must yield identical pulse counts to 128-frame
    // blocks. (The window is a multiple of 128, so both segmentations cover the
    // same sample span exactly.)
    const chunked = render(TOTAL, params(), 128);
    const oneBig = render(TOTAL, params(), TOTAL);
    for (let o = 0; o < N_OUT; o++) {
      expect(pulseCount(oneBig[o]!), `output ${o}`).toBe(pulseCount(chunked[o]!));
    }
  });

  it('running=0 halts the clock: no pulses on any output', () => {
    const outs = render(TOTAL, params({ running: 0 }));
    for (let o = 0; o < N_OUT; o++) expect(pulseCount(outs[o]!)).toBe(0);
  });

  it('muteOutputs=1 silences the audible gates (clock still runs internally)', () => {
    // The engine keeps counting (LIVECODE tick subscribers need it), but the
    // written gate level is 0 — so nothing reads as a pulse downstream.
    const outs = render(TOTAL, params({ muteOutputs: 1 }));
    for (let o = 0; o < N_OUT; o++) expect(pulseCount(outs[o]!)).toBe(0);
  });
});
