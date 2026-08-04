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
  SWING_SOURCES,
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

    // ── Divisors — FIRST master of each group, i.e. (n-1) % ratio === 0 ──
    //
    // ⚠ THIS BLOCK PINNED THE DEFECT. Until 2026-08-03 it asserted
    //     /2 → masters 2,4,6,8,10,12   /4 → 4,8,12   /8 → 8   /16,/32,/64 → 0
    // and it was GREEN, because the engine tested `masterCount % ratio === 0`,
    // which fires on the LAST master of each group. Every divider was late by
    // (ratio - 1) beats: a "/4 bar clock" landed on beat 4 instead of beat 1
    // and /64 needed 32 s before its first pulse. The comment right above the
    // code asserted the conventional first-of-group behaviour the whole time.
    // Four of the eight ratios have the SAME COUNT either way (/2, /3, /4,
    // /12 over this window), which is exactly why a count-only pin could hold
    // a phase bug for months — see the phase test below, which cannot.
    expect(count(OUT_HALF)).toBe(6); //  /2  → masters 1,3,5,7,9,11
    expect(count(OUT_THIRD)).toBe(4); // /3  → masters 1,4,7,10
    expect(count(OUT_QTR)).toBe(3); //  /4  → masters 1,5,9
    expect(count(OUT_8TH)).toBe(2); //  /8  → masters 1,9
    expect(count(OUT_12TH)).toBe(1); // /12 → master 1
    expect(count(OUT_16TH)).toBe(1); // /16 → master 1 (the downbeat always fires)
    expect(count(OUT_32ND)).toBe(1);
    expect(count(OUT_64TH)).toBe(1);

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

// ── PHASE and SHAPE, the two things a pulse COUNT cannot see ──────────────
//
// The count battery above is a real gate and it stayed green through both
// defects fixed on 2026-08-03, because a count is invariant to WHEN inside the
// window the pulses land and to how they are SPACED. A divider late by three
// beats has the same count. A swing output with a uniform phase offset has the
// same count AND the same spacing as a straight one. Both were measured only
// once someone read the pulse POSITIONS.

/** Sample indices of every rising edge in a gate buffer. */
function riseSamples(gate: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 1; i < gate.length; i++) {
    if (gate[i - 1]! < 0.5 && gate[i]! >= 0.5) out.push(i);
  }
  return out;
}
const intervalsOf = (rises: number[]): number[] =>
  rises.slice(1).map((v, i) => v - rises[i]!);

// 120 BPM → master period 24000 samples; the first master lands at 23999
// (the internal phase counter has to reach a full period before it wraps).
const MASTER = 24000;
const FIRST_MASTER = MASTER - 1;

describe('TIMELORDE dividers fire on the FIRST master of each group (defect 5)', () => {
  // BEFORE @120 BPM: 1x [23999, 47999, 71999…] but /2 [47999, 95999…],
  //                  /4 [95999, 191999…], /8 [191999…], /16 [383999]
  // AFTER:           every divider's FIRST pulse is 23999, coincident with 1x.
  const RATIOS: [string, number, number][] = [
    ['1/2', OUT_HALF, 2], ['1/3', OUT_THIRD, 3], ['1/4', OUT_QTR, 4],
    ['1/8', OUT_8TH, 8], ['1/12', OUT_12TH, 12], ['1/16', OUT_16TH, 16],
    ['1/32', OUT_32ND, 32], ['1/64', OUT_64TH, 64],
  ];

  it('every divider lands its FIRST pulse on the 1x downbeat', () => {
    // Long enough for /64 (64 masters = 32 s) to have fired at least once.
    const outs = render(MASTER * 70, params());
    const oneX = riseSamples(outs[OUT_1X]!)[0]!;
    expect(oneX, 'first 1x pulse (samples)').toBe(FIRST_MASTER);
    for (const [name, idx, ratio] of RATIOS) {
      const first = riseSamples(outs[idx]!)[0];
      expect(
        first,
        `${name} first pulse (samples) — defect put it ${ratio - 1} master periods late at ${FIRST_MASTER + (ratio - 1) * MASTER}`,
      ).toBe(oneX);
    }
  });

  it('every divider then fires exactly every ratio master periods', () => {
    const outs = render(MASTER * 70, params());
    for (const [name, idx, ratio] of RATIOS) {
      const rises = riseSamples(outs[idx]!);
      expect(rises.length, `${name} pulse count over 70 masters`).toBe(Math.floor((70 - 1) / ratio) + 1);
      for (const gap of intervalsOf(rises)) {
        expect(gap, `${name} interval (samples)`).toBe(ratio * MASTER);
      }
    }
  });

  // NEGATIVE CONTROL ON THE INSTRUMENT, every run: riseSamples must be able to
  // report a LATE first pulse, or "first == oneX" proves nothing. 2x's second
  // sub-pulse is a known-offset event we can check the reader against.
  it('NEGATIVE CONTROL: riseSamples reports an offset train as offset', () => {
    const outs = render(MASTER * 4, params());
    const twoX = riseSamples(outs[OUT_2X]!);
    expect(twoX[0], '2x sub-pulse 0 is master-coincident').toBe(FIRST_MASTER);
    expect(twoX[1], '2x sub-pulse 1 is half a master later').toBe(FIRST_MASTER + MASTER / 2);
    expect(twoX[1]).not.toBe(twoX[0]);
  });
});

describe('TIMELORDE SWING actually swings (defect 4)', () => {
  // BEFORE @120 BPM, SRC = 2x: intervals [12000, 12000, 12000, 12000] at swing
  //   amount 0, 30, 60 AND 90 — only the train's absolute offset moved
  //   (+2000 / +4000 / +6000). Identical story at SRC = 1x and SRC = /2.
  // AFTER, SRC = 2x: 0 → [12000 ×4]; 30 → [13000, 11000, …];
  //   60 → [14000, 10000, …]; 90 → [15000, 9000, …].
  //
  // The lag is a fraction of the SOURCE train's own interval (see the core),
  // so for SRC = 2x (sub-period 12000) amount 30 is 30/360 * 12000 = 1000 and
  // the pair reads 12000+1000 / 12000-1000.
  const swingRises = (amount: number, source: number, masters = 14): number[] =>
    riseSamples(render(MASTER * masters, params({ swingAmount: amount, swingSource: source }))[OUT_SWING]!);

  const CASES: { src: number; name: string; interval: number; masters: number }[] = [
    { src: 0, name: '1x', interval: MASTER, masters: 10 },
    { src: 3, name: '2x', interval: MASTER / 2, masters: 8 },
    { src: 2, name: '4x', interval: MASTER / 4, masters: 6 },
    { src: 4, name: '1/2', interval: MASTER * 2, masters: 16 },
  ];

  it('amount 0 is a dead-straight duplicate of the source (perfect normaling)', () => {
    for (const c of CASES) {
      const gaps = intervalsOf(swingRises(0, c.src, c.masters)).slice(0, 4);
      expect(gaps.length, `SRC ${c.name}: not enough swing pulses to measure`).toBeGreaterThanOrEqual(3);
      for (const g of gaps) expect(g, `SRC ${c.name} interval at swing 0 (samples)`).toBe(c.interval);
    }
  });

  it('a non-zero amount makes the intervals ALTERNATE long-short', () => {
    for (const c of CASES) {
      for (const amount of [30, 60, 90]) {
        const lag = Math.round((amount / 360) * c.interval);
        const gaps = intervalsOf(swingRises(amount, c.src, c.masters)).slice(0, 4);
        expect(gaps.length, `SRC ${c.name}: not enough swing pulses`).toBeGreaterThanOrEqual(3);
        for (let i = 0; i < gaps.length; i++) {
          const want = i % 2 === 0 ? c.interval + lag : c.interval - lag;
          expect(
            gaps[i],
            `SRC ${c.name} @ ${amount}°: interval ${i} (samples) — the defect made every one of these ${c.interval}`,
          ).toBe(want);
        }
      }
    }
  });

  it('the on-beats stay put — swing delays the OFF-beats, it does not shift the train', () => {
    for (const c of CASES) {
      const straight = swingRises(0, c.src, c.masters);
      for (const amount of [30, 90]) {
        const swung = swingRises(amount, c.src, c.masters);
        // Every even-indexed pulse must be exactly where it was at amount 0.
        for (let i = 0; i < Math.min(4, straight.length, swung.length); i += 2) {
          expect(
            swung[i],
            `SRC ${c.name} @ ${amount}°: on-beat ${i} moved — the defect shifted the whole train by ${Math.round((amount / 360) * MASTER)} samples`,
          ).toBe(straight[i]);
        }
      }
    }
  });

  it('swung pulses never overtake the pulse that follows them (strictly increasing)', () => {
    // The lag caps at 90/360 = 25% of the SOURCE interval, so this holds by
    // construction — which is the reason the lag is source-relative and not
    // master-relative. Measured off the master period, an 8x source at 90°
    // lagged 6000 samples into a 3000-sample sub-period.
    for (const src of [0, 1, 2, 3, 4, 6, 9]) {
      const rises = swingRises(90, src, 20);
      for (const gap of intervalsOf(rises)) {
        expect(gap, `SRC index ${src} @ 90°: non-increasing swing train`).toBeGreaterThan(0);
      }
    }
  });

  // NEGATIVE CONTROL ON THE INSTRUMENT, every run: `intervalsOf` must read a
  // uniform train as uniform. If it reported alternation on straight input the
  // alternation assertions above would be meaningless.
  it('NEGATIVE CONTROL: intervalsOf reads the STRAIGHT 1x train as perfectly even', () => {
    const rises = riseSamples(render(MASTER * 10, params())[OUT_1X]!);
    for (const g of intervalsOf(rises)) expect(g).toBe(MASTER);
  });
});

describe('TIMELORDE swingSource reaches every declared source (defect 6)', () => {
  // SWING_SOURCES has 12 entries (1x .. 1/64) and the core clamps to 11, but
  // the def / worklet descriptor / card all declared max 10, so index 11 —
  // 1/64 — was unreachable from the UI, from a saved patch, and from CV. The
  // card's own SRC_LABELS listed all twelve.
  it('SWING_SOURCES has 12 entries and index 11 is 1/64', () => {
    expect(SWING_SOURCES.length).toBe(12);
    expect(SWING_SOURCES[11]).toBe(OUT_64TH);
  });

  it('every source index 0..11 produces swing pulses aligned with that output', () => {
    for (let src = 0; src < SWING_SOURCES.length; src++) {
      const target = SWING_SOURCES[src]!;
      // 70 masters covers /64 (first pulse on master 1, second on master 65).
      const outs = render(MASTER * 70, params({ swingSource: src }));
      const swing = riseSamples(outs[OUT_SWING]!);
      const source = riseSamples(outs[target]!);
      expect(swing.length, `swingSource ${src}: swing pulse count`).toBeGreaterThan(0);
      expect(swing, `swingSource ${src}: at amount 0 SWING must duplicate output ${target}`).toEqual(source);
    }
  });
});
