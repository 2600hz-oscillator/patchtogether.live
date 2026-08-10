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

// ═══════════════════════════════════════════════════════════════════════════
// THE MULTIPLIER "DEFICIT" — WHAT IT ACTUALLY IS
// ═══════════════════════════════════════════════════════════════════════════
//
// A face spec measured 8 / 15 / 29 / 57 rising edges on 1x / 2x / 4x / 8x over
// a 4 s render at 120 bpm — short of 8x / 16 / 32 / 64 by exactly 1 / 3 / 7,
// IDENTICALLY at 60, 120 and 240 bpm — and read it as a one-master-period
// startup deficit ("start a patch on 8x and the first beat is missing seven
// pulses"). The worklet header agreed, in prose: "multiplier outputs lag by
// exactly one master period due to a predictor-style scheduler".
//
// Both were wrong, and every number in the table is reproducible. The window
// ENDS EXACTLY ON A MASTER PULSE — sample 191999 is both the 8th master and
// the last sample of a 192000-sample render — so that master's remaining
// (factor-1) sub-pulses are scheduled after the buffer ends and never get
// written. 57 = 7 complete masters x 8 + 1. The head is fine; the TAIL is
// clipped, and clipping the tail of a faster train costs more pulses, which is
// exactly why the shortfall scales as (factor - 1) and looks like arithmetic.
//
// These tests pin the START, which is what the claim was about, and keep the
// artifact itself on record as a permanent instrument leg.

describe('TIMELORDE multipliers are exact FROM THE FIRST MASTER (no startup deficit)', () => {
  const MULTS: [string, number, number][] = [['2x', OUT_2X, 2], ['4x', OUT_4X, 4], ['8x', OUT_8X, 8]];

  it('every multiplier fires its first pulse ON the 1x downbeat, to the sample', () => {
    const outs = render(MASTER * 4, params());
    const first1x = riseSamples(outs[OUT_1X]!)[0];
    expect(first1x, 'first 1x pulse (samples)').toBe(FIRST_MASTER);
    for (const [name, idx] of MULTS) {
      expect(
        riseSamples(outs[idx]!)[0],
        `${name} first pulse (samples) — a one-master-period predictor lag would put it at ${FIRST_MASTER + MASTER}`,
      ).toBe(first1x);
    }
  });

  it('the FIRST master period already carries all `factor` sub-pulses', () => {
    // The claim under test is specifically about the START, so measure the
    // first beat alone rather than a settled average: [first master, +1 period).
    const outs = render(MASTER * 4, params());
    for (const [name, idx, factor] of MULTS) {
      const inFirstBeat = riseSamples(outs[idx]!).filter(
        (s) => s >= FIRST_MASTER && s < FIRST_MASTER + MASTER,
      );
      expect(
        inFirstBeat.length,
        `${name} pulses inside the FIRST master period — the reported defect said 1 (short by ${factor - 1})`,
      ).toBe(factor);
    }
  });

  it('the sub-pulse spacing is exact from pulse 0 — no settling interval', () => {
    const outs = render(MASTER * 4, params());
    for (const [name, idx, factor] of MULTS) {
      const gaps = intervalsOf(riseSamples(outs[idx]!));
      expect(gaps.length, `${name}: not enough pulses to measure`).toBeGreaterThan(2);
      for (const [i, g] of gaps.entries()) {
        expect(g, `${name} gap ${i} (samples) — a settling multiplier would differ at i=0`).toBe(MASTER / factor);
      }
    }
  });

  it('NOTHING fires before the first master — the startup silence is UNIFORM, not per-output', () => {
    // The other half of the misreading: the clock's first pulse is one master
    // period after t=0 on EVERY output, 1x included. That is a property of the
    // phase accumulator (it has to reach a full period before it wraps), not
    // something the multipliers do. Left as-is deliberately: emitting an extra
    // downbeat at t=0 would add a pulse to every clocked patch in the rack.
    const outs = render(MASTER * 4, params());
    for (let o = 0; o < N_OUT; o++) {
      const early = riseSamples(outs[o]!).filter((s) => s < FIRST_MASTER);
      expect(early.length, `output ${o} fired ${early.length} times before the first master`).toBe(0);
    }
  });

  // PERMANENT INSTRUMENT LEG. This is the measurement that produced the false
  // finding, kept green on purpose: the same correct clock reads as a deficit
  // through a window that ends on a master, and as exact through one that does
  // not. A future agent who counts edges over a round number of seconds and
  // sees 57 has this test to read.
  it('INSTRUMENT: a window ending ON a master under-counts by (factor - 1); one ending between masters does not', () => {
    const FOUR_SECONDS = 4 * SR;            // 192000 — ends exactly on master 8
    expect(FOUR_SECONDS % MASTER, '4 s at 120 bpm is a whole number of master periods').toBe(0);

    const clipped = render(FOUR_SECONDS, params());
    const masters = pulseCount(clipped[OUT_1X]!);
    expect(masters, 'masters inside the 4 s window').toBe(8);
    for (const [name, idx, factor] of MULTS) {
      expect(
        pulseCount(clipped[idx]!),
        `${name} over a master-aligned window — (${masters - 1} whole masters x ${factor}) + 1 clipped`,
      ).toBe((masters - 1) * factor + 1);
    }

    // Same clock, window pulled back so it ends BETWEEN masters — after master
    // 7's last 8x sub-pulse (167999 + 7 x 3000 = 188999) and before master 8
    // (191999). Now every scheduled sub-pulse is inside the window and the
    // ratio is exact on all three multipliers at once.
    const whole = render(FOUR_SECONDS - 1000, params());
    const wholeMasters = pulseCount(whole[OUT_1X]!);
    for (const [name, idx, factor] of MULTS) {
      expect(
        pulseCount(whole[idx]!),
        `${name} over a window ending BETWEEN masters must be exactly ${factor}x 1x`,
      ).toBe(wholeMasters * factor);
    }
  });
});

// ── EXTERNAL CLOCK: the ONE beat that genuinely cannot be predicted ────────
//
// A period needs two edges. On the FIRST external beat there is nothing to
// measure, so the sub-pulses are laid out at the DECLARED bpm — a rate error
// during lock-in, never a missing pulse, and unavoidable at any price.
//
// The SECOND beat is not unavoidable and used to be wrong too: the subdivision
// period was resolved once per BLOCK from state captured before the block ran,
// and the second external edge writes `lastMeasuredPeriod` mid-block, so the
// measurement was invisible for the rest of that beat. Resolving it at FIRE
// time recovers the beat.
//
// MEASURED, 150 bpm external against a 120 bpm knob, 2x gaps in samples:
//   before  12000, 7200, 12000, 7200, 9600, 9600 …
//   after   12000, 7200, 9600, 9600, 9600 …
describe('TIMELORDE external clock locks its multipliers after ONE beat, not two', () => {
  const EXT_PERIOD = 19200; // 150 bpm at 48 kHz
  const KNOB_PERIOD = MASTER; // 120 bpm — deliberately WRONG, so the two are separable

  /** Render with rising edges on input 0 every EXT_PERIOD samples. */
  function renderExternal(masters: number): Float32Array[] {
    const total = (masters + 1) * EXT_PERIOD;
    const core = new TimelordeClockCore();
    const bufs = Array.from({ length: N_OUT }, () => new Float32Array(total));
    const p = params({ bpm: 120, hasExternalClock: 1 });
    const clock = new Float32Array(total);
    for (let e = 1; e <= masters; e++) {
      const at = e * EXT_PERIOD;
      for (let s = at; s < Math.min(at + 480, total); s++) clock[s] = 1;
    }
    for (let off = 0; off < total; off += 128) {
      const len = Math.min(128, total - off);
      core.process(
        [[clock.subarray(off, off + len)]],
        bufs.map((b) => [b.subarray(off, off + len)]),
        p, SR, () => {},
      );
    }
    return bufs;
  }

  it('1x follows the external edges exactly (the follower itself is sound)', () => {
    const rises = riseSamples(renderExternal(7)[OUT_1X]!);
    expect(rises.length).toBeGreaterThanOrEqual(6);
    for (const g of intervalsOf(rises)) expect(g, 'external 1x interval (samples)').toBe(EXT_PERIOD);
  });

  it('beat 1 is laid out at the DECLARED tempo — unavoidable, a period needs two edges', () => {
    const gaps = intervalsOf(riseSamples(renderExternal(7)[OUT_2X]!));
    expect(gaps[0], '2x gap 0 (samples) = the declared 120 bpm half-period').toBe(KNOB_PERIOD / 2);
    expect(gaps[1], '2x gap 1 (samples) = the remainder of the first EXTERNAL period').toBe(
      EXT_PERIOD - KNOB_PERIOD / 2,
    );
  });

  it('beat 2 ONWARD uses the measured external period (this is the beat the fix recovers)', () => {
    const gaps = intervalsOf(riseSamples(renderExternal(7)[OUT_2X]!));
    // Before the fix these read 12000, 7200 again — the block-level snapshot
    // could not see a measurement written mid-block.
    for (let i = 2; i < gaps.length; i++) {
      expect(
        gaps[i],
        `2x gap ${i} (samples) — before the fire-time fix gaps 2 and 3 were ${KNOB_PERIOD / 2} / ${EXT_PERIOD - KNOB_PERIOD / 2}`,
      ).toBe(EXT_PERIOD / 2);
    }
  });

  it('4x and 8x are locked and perfectly even once beat 1 has drained', () => {
    // ⚠ Beat 1 is laid out at the DECLARED period, which here is LONGER than
    // the real one (24000 vs 19200), so its tail SPILLS past the second master:
    // 8x schedules 19200 + k x 3000 up to 40200, and the second external edge
    // lands at 38400. One stale sub-pulse from beat 1 therefore falls inside
    // beat 2 and the gaps around the seam are irregular (measured 1800 / 600).
    // That is inherent to laying a whole beat out in advance at the best period
    // known when it started — the tail cannot be un-scheduled by a measurement
    // that does not exist yet. The train is clean from the THIRD edge on.
    const outs = renderExternal(7);
    const SETTLED = 3 * EXT_PERIOD;
    for (const [name, idx, factor] of [['4x', OUT_4X, 4], ['8x', OUT_8X, 8]] as const) {
      const locked = intervalsOf(riseSamples(outs[idx]!).filter((s) => s >= SETTLED));
      expect(locked.length, `${name}: not enough pulses after sample ${SETTLED}`).toBeGreaterThan(2);
      for (const g of locked) expect(g, `${name} locked interval (samples)`).toBe(EXT_PERIOD / factor);
    }
  });

  // NEGATIVE CONTROL ON THE INSTRUMENT, every run: the harness must be able to
  // report the WRONG period. With the knob set to the external tempo the two
  // candidate answers coincide and every assertion above would pass vacuously.
  it('NEGATIVE CONTROL: the declared-tempo layout is VISIBLY different from the measured one', () => {
    expect(KNOB_PERIOD / 2, 'declared half-period').not.toBe(EXT_PERIOD / 2);
    const gaps = intervalsOf(riseSamples(renderExternal(7)[OUT_2X]!));
    expect(new Set(gaps).size, 'if the harness only ever produced one gap value it would prove nothing')
      .toBeGreaterThan(1);
  });
});

// ── STOP vs MUTE: the DSP genuinely cannot tell them apart, and that is PINNED
//
// MEASURED, 4 s at 120 bpm, all 13 gate outputs: `running = 0`,
// `muteOutputs = 1` and both together are BYTE-IDENTICAL — zero edges, zero
// peak, zero DC — while `running` alone differs. They are different things
// (one halts the phase, the other gates the writes) and from a patch cable
// there is no difference at all.
//
// The fix for that is a NAMED TRANSPORT STATE the player can read
// (timelordeTransportState in packages/web/src/lib/audio/modules), NOT a
// change to what a jack emits: keeping one output alive under MUTE would start
// sending pulses into patches that are relying on MUTE to silence everything.
// This test pins the decision — if a future change makes a jack distinguish the
// two, it goes red and that has to be a deliberate, reviewed choice.
describe('TIMELORDE STOP and MUTE are indistinguishable AT THE JACKS (pinned decision)', () => {
  const WINDOW = 4 * SR;
  const signature = (outs: Float32Array[]): string =>
    outs.map((b) => {
      let peak = 0, sum = 0;
      for (const v of b) { peak = Math.max(peak, Math.abs(v)); sum += v; }
      return `${pulseCount(b)}/${peak}/${sum}`;
    }).join(',');

  const SILENT: [string, Record<string, number>][] = [
    ['STOPPED', { running: 0 }],
    ['MUTED', { muteOutputs: 1 }],
    ['STOPPED + MUTED', { running: 0, muteOutputs: 1 }],
  ];

  it('all three silent states are byte-identical on every one of the 13 gate outputs', () => {
    const sigs = SILENT.map(([, over]) => signature(render(WINDOW, params(over))));
    for (let i = 1; i < sigs.length; i++) {
      expect(
        sigs[i],
        `${SILENT[i]![0]} differs from ${SILENT[0]![0]} at the jacks — a jack now distinguishes them, which changes what existing patches receive`,
      ).toBe(sigs[0]);
    }
  });

  // The positive control the identity assertion needs: a signature that could
  // not tell any two states apart would satisfy the test above trivially.
  it('POSITIVE CONTROL: the same signature DOES separate the running state', () => {
    expect(signature(render(WINDOW, params()))).not.toBe(signature(render(WINDOW, params({ running: 0 }))));
  });

  // bpm is the face spec's named negative control for the transport state, and
  // it holds at the DSP too: tempo changes how many pulses a running clock
  // emits and changes nothing about a silent one.
  it('NEGATIVE CONTROL: bpm does not move any silent state', () => {
    for (const [name, over] of SILENT) {
      const at60 = signature(render(WINDOW, params({ ...over, bpm: 60 })));
      const at240 = signature(render(WINDOW, params({ ...over, bpm: 240 })));
      expect(at240, `${name} moved with bpm`).toBe(at60);
    }
    expect(
      signature(render(WINDOW, params({ bpm: 60 }))),
      'bpm must move a RUNNING clock, or the control above is vacuous',
    ).not.toBe(signature(render(WINDOW, params({ bpm: 240 }))));
  });
});

// ── SWING IS MEASURED IN INTERVALS. NEVER IN COUNTS. ──────────────────────
//
// The face spec's first pass counted swing edges, read 7 at swingAmount = 45
// and 7 at swingAmount = 90, and concluded the control did nothing. It does:
// swing moves WHEN an edge lands, never HOW MANY, so a metric that integrates
// over the window is blind to it BY CONSTRUCTION. The counter even had a
// passing negative control (8 -> 7 when swing engaged at all) and was still
// the wrong instrument.
//
// This block is the permanent guard against repeating that: it asserts the
// COUNT is invariant — so nobody can read a count change as a swing regression
// — and pins the intervals in MILLISECONDS against the measured table.
describe('SWING: a pulse COUNT is blind to it; the observable is the INTERVAL', () => {
  const WINDOW = MASTER * 8;
  const swingRises = (amount: number): number[] =>
    riseSamples(render(WINDOW, params({ swingAmount: amount }))[OUT_SWING]!);
  const msOf = (samples: number) => (samples / SR) * 1000;

  it('the COUNT cannot see the AMOUNT — 15, 45, 70 and 90 deg all read the same', () => {
    // This is verbatim the reading that produced "the amount does nothing":
    // 7 edges at 45 and 7 at 90. It is correct, and it is uninformative.
    const AMOUNTS = [15, 45, 70, 90];
    const counts = AMOUNTS.map((a) => swingRises(a).length);
    for (const [i, c] of counts.entries()) {
      expect(
        c,
        `swing ${AMOUNTS[i]} deg pulse count — a COUNT is invariant to swing by construction; if this ever moves, the cause is the window edge, not the shuffle`,
      ).toBe(counts[0]);
    }
  });

  it('the one step a COUNT does show (0 -> engaged) is the WINDOW EDGE, not a rate change', () => {
    // Amount 0 reads 8 and every non-zero amount reads 7, and that single step
    // is the same master-aligned-window artifact as the multiplier "deficit":
    // the last on-beat sits exactly on the final sample, and holding the
    // off-beats back pushes the trailing pulse out of the buffer. It is NOT
    // evidence that swing drops pulses — the straight and swung trains have the
    // same number of ON-BEATS inside the window.
    expect(swingRises(0).length, 'straight swing train (amount 0)').toBe(8);
    expect(swingRises(90).length, 'swung train, master-aligned window').toBe(7);
    const onBeats = (a: number) => swingRises(a).filter((_, i) => i % 2 === 0).length;
    expect(onBeats(90), 'on-beats are untouched by the lag').toBe(onBeats(0));
  });

  it('the INTERVALS move exactly as 125 ms x (swing / 90) at 120 bpm (SRC = 1x)', () => {
    // Measured table (face spec §3), in ms: 0 -> 500/500, 15 -> 520.8/479.2,
    // 45 -> 562.5/437.5, 70 -> 597.2/402.8, 90 -> 625/375.
    for (const amount of [0, 15, 45, 70, 90]) {
      const offsetMs = 125 * (amount / 90);
      const gaps = intervalsOf(swingRises(amount)).slice(0, 4);
      expect(gaps.length, `swing ${amount}: not enough pulses`).toBeGreaterThanOrEqual(3);
      for (const [i, g] of gaps.entries()) {
        const want = i % 2 === 0 ? 500 + offsetMs : 500 - offsetMs;
        expect(
          msOf(g),
          `swing ${amount} deg, interval ${i} — UNITS ARE ms (swingAmount is in DEGREES)`,
        ).toBeCloseTo(want, 1);
      }
    }
  });

  it('90 deg is the 625 / 375 ms pair — a 5 : 3 long-short ratio', () => {
    const [a, b] = intervalsOf(swingRises(90));
    expect(msOf(a!), 'long interval (ms)').toBeCloseTo(625, 3);
    expect(msOf(b!), 'short interval (ms)').toBeCloseTo(375, 3);
    expect(a! / b!, 'long : short').toBeCloseTo(5 / 3, 6);
  });
});
