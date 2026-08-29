// packages/web/src/lib/audio/tempolock/tempolock-tracker.test.ts
//
// THE CANONICAL TEMPOLOCK FIXTURES, in the order the module was specified —
// fixture 1 is the owner's case verbatim and is the reason the module exists.
//
// The harness simulates the scheduler tick exactly the way the module runs the
// tracker: tick every `tickS`, onsets delivered as a per-tick edge count at
// the tick's own timestamp, look-ahead window `now + 0.2`. No AudioContext,
// no timers, no randomness outside a seeded LCG — a red run reproduces.

import { describe, expect, it } from 'vitest';
import {
  createTempolockTracker,
  tempolockEstimateBasePulse,
  tempolockFoldStrict,
  tempolockFoldWithHysteresis,
  TEMPOLOCK_BANDS,
  TEMPOLOCK_MIN_LOCK_INTERVALS,
  type TempolockTracker,
} from './tempolock-tracker';
import { TEMPOLOCK_OWNER_FIXTURE } from './tempolock-owner-fixture';

const BAND = TEMPOLOCK_BANDS[1]!; // 90–180, the shipped default

// ── harness ────────────────────────────────────────────────────────────────

interface RunResult {
  /** Every emitted clock rising edge, absolute seconds, ascending. */
  pulses: number[];
  /** Per-tick observations. */
  timeline: Array<{ t: number; bpm: number | null; locked: boolean }>;
  skippedTotal: number;
}

/** Drive a tracker through an onset train at scheduler-tick resolution. */
function runTrain(
  tracker: TempolockTracker,
  onsets: readonly number[],
  opts: { endS: number; tickS?: number },
): RunResult {
  const tickS = opts.tickS ?? 0.025;
  const sorted = [...onsets].sort((a, b) => a - b);
  const pulses: number[] = [];
  const timeline: RunResult['timeline'] = [];
  let skippedTotal = 0;
  let onsetIdx = 0;
  const steps = Math.ceil(opts.endS / tickS);
  for (let i = 1; i <= steps; i++) {
    const now = i * tickS;
    let count = 0;
    while (onsetIdx < sorted.length && sorted[onsetIdx]! <= now) {
      count++;
      onsetIdx++;
    }
    const res = tracker.tick({ nowS: now, onsets: count, winEnd: now + 0.2 });
    // The look-ahead means consecutive windows overlap; the cursor guarantees
    // each pulse is returned once. Assert that instead of trusting it.
    for (const p of res.pulses) {
      expect(p).toBeGreaterThan(pulses.length ? pulses[pulses.length - 1]! : -1);
      pulses.push(p);
    }
    skippedTotal += res.skipped;
    timeline.push({ t: now, bpm: res.bpm, locked: res.locked });
  }
  return { pulses, timeline, skippedTotal };
}

/** Onset times (s) for the owner's kick pattern — steps 1,5,7,9,13,15 of a
 *  16-step bar — repeated over `bars` bars at `bpm`. */
function ownerPattern(bpm: number, bars: number): number[] {
  const sixteenth = 60 / bpm / 4;
  const stepsInBar = [0, 4, 6, 8, 12, 14]; // 0-based sixteenth positions
  const out: number[] = [];
  for (let bar = 0; bar < bars; bar++) {
    for (const s of stepsInBar) out.push((bar * 16 + s) * sixteenth);
  }
  return out;
}

function fourOnFloor(bpm: number, beats: number, startS = 0): number[] {
  const q = 60 / bpm;
  return Array.from({ length: beats }, (_, i) => startS + i * q);
}

function deltas(xs: readonly number[]): number[] {
  return xs.slice(1).map((v, i) => v - xs[i]!);
}

/** Deterministic ±`amp` jitter (seeded LCG — no Math.random in this suite). */
function jittered(onsets: readonly number[], ampS: number, seed = 42): number[] {
  let s = seed >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  return onsets.map((t) => t + (next() * 2 - 1) * ampS);
}

function lockedAt(run: RunResult, t: number): boolean {
  const row = run.timeline.find((r) => r.t >= t);
  return row?.locked ?? false;
}

// ── FIXTURE 1 — the owner's case, verbatim ─────────────────────────────────
//
// 108 BPM, kicks on steps 1,5,7,9,13,15 of a 16-step bar → inter-onset gaps
// 555.6 / 277.8 / 277.8 / 555.6 / 277.8 / 277.8 ms. A last-interval follower
// flaps between 216 and 108; the tracker must say 108.0 and emit steady
// 555.6 ms quarter-note clocks with `locked` high.

describe('fixture 1 — owner pattern @108 (steps 1,5,7,9,13,15)', () => {
  const onsets = ownerPattern(108, 8); // 8 bars ≈ 17.8 s
  const tracker = createTempolockTracker({ band: BAND });
  const run = runTrain(tracker, onsets, { endS: 18, tickS: 0.005 });

  it('locks at 108.0, not 216', () => {
    const last = run.timeline[run.timeline.length - 1]!;
    expect(last.bpm).not.toBeNull();
    expect(last.bpm!).toBeGreaterThan(107.5);
    expect(last.bpm!).toBeLessThan(108.5);
  });

  it('locked is high once enough intervals arrived, and stays high', () => {
    // 5 onsets = 4 intervals = the lock threshold; the 5th onset lands at
    // 1.667 s. Give it one bar of slack, then require locked for the rest.
    for (const row of run.timeline.filter((r) => r.t > 2.3)) {
      expect(row.locked, `locked at t=${row.t.toFixed(3)}`).toBe(true);
    }
  });

  it('emits NO clock before the first lock (cold = silent)', () => {
    const fifthOnset = onsets[TEMPOLOCK_MIN_LOCK_INTERVALS]!;
    expect(run.pulses[0]!).toBeGreaterThanOrEqual(fifthOnset - 0.01);
  });

  it('emits steady 555.6 ms quarter-note clocks, never a passthrough of the input gaps', () => {
    const settled = run.pulses.filter((p) => p > 4);
    const ds = deltas(settled);
    expect(ds.length).toBeGreaterThan(20);
    for (const d of ds) {
      expect(d).toBeGreaterThan(0.5556 - 0.008);
      expect(d).toBeLessThan(0.5556 + 0.008);
    }
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    expect(Math.abs(mean - 60 / 108)).toBeLessThan(0.002);
  });

  it('NEGATIVE CONTROL — a last-interval follower over this train flaps 2x', () => {
    const ds = deltas(onsets);
    const inst = ds.map((d) => 60 / d);
    const ratio = Math.max(...inst) / Math.min(...inst);
    // 555.6 ms reads as 108, 277.8 ms reads as 216 — the flap the owner heard.
    expect(ratio).toBeGreaterThanOrEqual(1.99);
    expect(Math.round(Math.max(...inst))).toBe(216);
    expect(Math.round(Math.min(...inst))).toBe(108);
  });
});

// ── FIXTURE 2 — true four-on-the-floor @128 ───────────────────────────────

describe('fixture 2 — four-on-the-floor @128', () => {
  it('locks 128 with steady 468.75 ms clocks', () => {
    const tracker = createTempolockTracker({ band: BAND });
    const run = runTrain(tracker, fourOnFloor(128, 32), { endS: 16, tickS: 0.005 });
    const last = run.timeline[run.timeline.length - 1]!;
    expect(last.locked).toBe(true);
    expect(last.bpm!).toBeGreaterThan(127.5);
    expect(last.bpm!).toBeLessThan(128.5);
    const ds = deltas(run.pulses.filter((p) => p > 4));
    for (const d of ds) expect(Math.abs(d - 60 / 128)).toBeLessThan(0.008);
  });
});

// ── FIXTURE 3 — tempo ramp 108 → 120 ──────────────────────────────────────

describe('fixture 3 — ramp 108→120 follows within a few bars', () => {
  it('tracks the ramp smoothly and settles at 120', () => {
    // 4 bars at 108, then a linear ramp to 120 across 4 bars, then 6 bars at
    // 120 — built beat-by-beat so each interval is the instantaneous tempo.
    const onsets: number[] = [0];
    let bpm = 108;
    for (let beat = 0; beat < 56; beat++) {
      if (beat >= 16 && beat < 32) bpm = 108 + ((beat - 15) * (120 - 108)) / 16;
      onsets.push(onsets[onsets.length - 1]! + 60 / bpm);
    }
    const tracker = createTempolockTracker({ band: BAND });
    const end = onsets[onsets.length - 1]! + 0.5;
    const run = runTrain(tracker, onsets, { endS: end, tickS: 0.005 });

    // Settles at 120 by the end (well inside the 6 post-ramp bars)...
    const last = run.timeline[run.timeline.length - 1]!;
    expect(last.bpm!).toBeGreaterThan(118.8);
    expect(last.bpm!).toBeLessThan(121.2);
    // ...without ever unlocking or jumping outside the two endpoint tempi.
    for (const row of run.timeline.filter((r) => r.t > 3)) {
      expect(row.locked, `locked through the ramp at t=${row.t.toFixed(2)}`).toBe(true);
      expect(row.bpm!).toBeGreaterThan(106);
      expect(row.bpm!).toBeLessThan(122);
    }
    // No half-period or double-period pulse anywhere: every interval stays
    // within [0.7, 1.3] beats of the tempo envelope. (Inside an 11% ramp the
    // tracker is allowed its bounded quarter-beat phase repairs — the
    // re-anchor path, whose shift is capped at 0.25 beat by construction —
    // but a flap to 216 or a stall to 54 is a factor of 2 and must never
    // appear.)
    const ds = deltas(run.pulses);
    for (const d of ds) {
      expect(d).toBeGreaterThan(0.7 * (60 / 122));
      expect(d).toBeLessThan(1.3 * (60 / 106));
    }
  });
});

// ── FIXTURE 4 — ±10 ms jittered onsets ────────────────────────────────────

describe('fixture 4 — ±10 ms jitter stays locked with bounded output jitter', () => {
  it('holds 108 within ±1 BPM and keeps pulse spacing within ±10 ms', () => {
    const onsets = jittered(ownerPattern(108, 12), 0.01);
    const tracker = createTempolockTracker({ band: BAND });
    const run = runTrain(tracker, onsets, { endS: 27, tickS: 0.005 });
    for (const row of run.timeline.filter((r) => r.t > 3)) {
      expect(row.locked, `locked at t=${row.t.toFixed(2)}`).toBe(true);
      expect(row.bpm!).toBeGreaterThan(107);
      expect(row.bpm!).toBeLessThan(109);
    }
    // The OUTPUT is steadier than the input: input gaps wobble by ±20 ms;
    // emitted quarters stay within ±10 ms of nominal.
    const ds = deltas(run.pulses.filter((p) => p > 5));
    for (const d of ds) expect(Math.abs(d - 60 / 108)).toBeLessThan(0.01);
  });
});

// ── FIXTURE 5 — two-bar dropout: free-run, then relock ────────────────────

describe('fixture 5 — dropout free-runs (never stops) and relocks', () => {
  const bpm = 120; // q = 0.5 s
  const onsets = [
    ...fourOnFloor(bpm, 8), // beats 0..7 (t = 0 .. 3.5)
    ...fourOnFloor(bpm, 8, 8.0), // resume at beat 16 (t = 8.0 .. 11.5)
  ];
  const tracker = createTempolockTracker({ band: BAND });
  const run = runTrain(tracker, onsets, { endS: 13, tickS: 0.005 });

  it('the clock keeps running through the silence — the rack may be synced to it', () => {
    const gapPulses = run.pulses.filter((p) => p > 4 && p < 8);
    expect(gapPulses.length).toBeGreaterThanOrEqual(7);
    for (const d of deltas(gapPulses)) expect(Math.abs(d - 0.5)).toBeLessThan(0.005);
    // No hole anywhere in the whole run either.
    for (const d of deltas(run.pulses)) expect(d).toBeLessThan(0.6);
  });

  it('locked drops after ~4 missed beats and comes back after resume', () => {
    expect(lockedAt(run, 3.6)).toBe(true); // still locked at the last onset
    expect(lockedAt(run, 6.2)).toBe(false); // 3.5 + 4·0.5 = 5.5 → down by 6.2
    expect(lockedAt(run, 9.5)).toBe(true); // two on-grid onsets after resume
  });

  it('relocks at the same tempo without a phase jump', () => {
    const last = run.timeline[run.timeline.length - 1]!;
    expect(last.bpm!).toBeGreaterThan(119);
    expect(last.bpm!).toBeLessThan(121);
  });
});

// ── FIXTURE 6 — the 216-vs-108 octave choice, pinned ──────────────────────

describe('fixture 6 — octave fold + hysteresis', () => {
  it('cold folds are strict into [90,180): 216→108, 432→108, 180→90', () => {
    expect(tempolockFoldStrict(216, BAND)).toBeCloseTo(108, 6);
    expect(tempolockFoldStrict(432, BAND)).toBeCloseTo(108, 6);
    expect(tempolockFoldStrict(180, BAND)).toBeCloseTo(90, 6);
    expect(tempolockFoldStrict(96, BAND)).toBeCloseTo(96, 6);
  });

  it('hysteresis keeps the octave nearest the current lock at the band edge', () => {
    // Locked at 176 and the pattern drifts up to 184: WITHOUT hysteresis the
    // strict fold says 92 — an octave flip mid-performance. With it, 184.
    expect(tempolockFoldWithHysteresis(184, 176, BAND)).toBeCloseTo(184, 6);
    // The same 184 estimate arriving with a lock near 92 stays down.
    expect(tempolockFoldWithHysteresis(184, 95, BAND)).toBeCloseTo(92, 6);
    // The owner's flap, resolved: an eighth-note run re-estimating 216 while
    // locked at 108 folds back onto 108 (216 is outside even the stretched
    // band), and with no lock at all 216 strictly folds to 108.
    expect(tempolockFoldWithHysteresis(216, 108, BAND)).toBeCloseTo(108, 6);
    expect(tempolockFoldWithHysteresis(216, null, BAND)).toBeCloseTo(108, 6);
  });

  it('a pure eighth-note train from cold reads as 108, and a mixed→eighths switch stays 108', () => {
    // Pure eighths (every IOI 277.8 ms): base pulse 277.8 → raw 216 → 108.
    const eighths = Array.from({ length: 40 }, (_, i) => i * (60 / 108 / 2));
    const t1 = createTempolockTracker({ band: BAND });
    const r1 = runTrain(t1, eighths, { endS: 12, tickS: 0.005 });
    expect(r1.timeline[r1.timeline.length - 1]!.bpm!).toBeCloseTo(108, 0);

    // Locked on the mixed owner pattern, then the drummer plays straight
    // eighths for four bars: the lock must not flip to 216.
    const mixed = ownerPattern(108, 4);
    const barLen = 16 * (60 / 108 / 4);
    const tail: number[] = [];
    for (let i = 0; i < 32; i++) tail.push(4 * barLen + i * (60 / 108 / 2));
    const t2 = createTempolockTracker({ band: BAND });
    const r2 = runTrain(t2, [...mixed, ...tail], { endS: 18, tickS: 0.005 });
    for (const row of r2.timeline.filter((r) => r.t > 3)) {
      expect(row.bpm!, `no octave flip at t=${row.t.toFixed(2)}`).toBeGreaterThan(100);
      expect(row.bpm!).toBeLessThan(116);
    }
  });
});

// ── FIXTURE 7 — silence from cold: no lock, NO CLOCK ──────────────────────
//
// Decided and pinned: a cold tracker emits NOTHING. The alternative — free-
// running at some default tempo from spawn — would inject a wrong clock into
// a rack the moment the module is patched, before any evidence arrived, and
// "a clock that is confidently wrong" is the exact defect this module
// replaces. Silence-until-evidence also makes the lock observable at the
// jacks: the first pulse IS the lock announcement. (Post-lock silence is the
// opposite case and free-runs forever — fixture 5.)

describe('fixture 7 — cold silence', () => {
  it('emits no clock, no bpm, no lock — and one lone onset is not evidence', () => {
    const tracker = createTempolockTracker({ band: BAND });
    const r1 = runTrain(tracker, [2.0], { endS: 10 });
    expect(r1.pulses).toEqual([]);
    const last = r1.timeline[r1.timeline.length - 1]!;
    expect(last.bpm).toBeNull();
    expect(last.locked).toBe(false);
  });
});

// ── FIXTURE 8 — THE OWNER'S REAL RECORDING, at scheduler-tick resolution ──
//
// The checked-in onset train extracted from the owner's actual 108 BPM
// recording by a replica of synesthesia's OnsetDetector (<200 Hz band). The
// IOIs sit on one sixteenth grid in a recurring 3-1-2-2 pattern — an extra
// low-band onset splits one quarter gap per bar — and the tracker must hold
// one lock through it. Onsets are delivered at 25 ms tick resolution, the
// worst case the module ever sees.
//
// ⚠ THE GROUND TRUTH IS 103.68 BPM = 108 × 24/25 — THE FILE PLAYS 4% SLOW,
// and this was established by validating the instrument, not by trusting
// either label (CLAUDE.md: a wrong metric reads exactly like a finding):
//
//   * The extraction's own blind fold said 107.72, from an absolute-grid
//     regression. On this train that instrument is INVALID: at its own best
//     fit the onset-phase residuals have σ ≈ 40 ms on a 139 ms grid, so its
//     integer grid-index assignment slips once per cycle and the iteration
//     converges on a self-consistent wrong answer. (Every interval here sits
//     within ~5% of BOTH the 108 and the 103.68 grids' multiples — interval
//     tolerance alone cannot separate the two hypotheses.)
//   * Two independent local instruments agree on 103.68 and are clean: (1)
//     the per-interval least-squares base pulse is 0.14479 s in EVERY 16-IOI
//     window (max residual 26 ms, mean −0.2 ms — versus a +12 ms SYSTEMATIC
//     residual against the 108 grid, which a true grid cannot produce); (2)
//     the recurring 3-1-2-2 cycle's own period, read off the >0.5 s marker
//     gaps, is 1.157 s = 8 sixteenths of 0.14466 s. Both fold to 103.6–103.7.
//   * 103.68 = 108 × 24/25 EXACTLY — the signature of a 25→24 fps-family
//     rate conversion on the mp4, not of a mis-tracking tracker. A tracker
//     that answered "108" to this file would be 4% off the audio actually
//     playing, and would drift a quarter-beat every ~6 beats against it.
//
// The stated-BPM provenance is still pinned: tracked × 25/24 must read 108.

describe('fixture 8 — real owner recording (179 onsets, 54 s)', () => {
  const onsets = TEMPOLOCK_OWNER_FIXTURE.onsetsS;
  const tracker = createTempolockTracker({ band: BAND });
  const run = runTrain(tracker, onsets, {
    endS: onsets[onsets.length - 1]! + 0.3,
    tickS: 0.025,
  });

  it('locks the recording\'s true tempo (103.68 = 108 × 24/25) ±1 and never octave-flips', () => {
    for (const row of run.timeline.filter((r) => r.t > 3)) {
      expect(row.locked, `locked at t=${row.t.toFixed(2)}`).toBe(true);
      expect(row.bpm!, `bpm at t=${row.t.toFixed(2)}`).toBeGreaterThan(102.7);
      expect(row.bpm!, `bpm at t=${row.t.toFixed(2)}`).toBeLessThan(104.7);
    }
    // The session-tempo provenance: undo the 24/25 playback-rate shift and
    // the owner's stated 108 comes back within a third of a BPM.
    const tail = run.timeline.filter((r) => r.t > 10).map((r) => r.bpm!);
    const meanBpm = tail.reduce((a, b) => a + b, 0) / tail.length;
    expect(meanBpm * (25 / 24)).toBeGreaterThan(107.6);
    expect(meanBpm * (25 / 24)).toBeLessThan(108.4);
  });

  it('the emitted clock is steady to within one scheduler tick', () => {
    const settled = run.pulses.filter((p) => p > 5);
    const ds = deltas(settled);
    expect(ds.length).toBeGreaterThan(60);
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    for (const d of ds) {
      expect(Math.abs(d - mean), `pulse gap ${d.toFixed(4)} vs mean ${mean.toFixed(4)}`).toBeLessThan(0.03);
    }
    expect(60 / mean).toBeGreaterThan(102.7);
    expect(60 / mean).toBeLessThan(104.7);
  });

  it('NEGATIVE CONTROL — a last-two-edges follower over this train swings >2x', () => {
    const inst = deltas([...onsets]).map((d) => 60 / d);
    const ratio = Math.max(...inst) / Math.min(...inst);
    expect(ratio).toBeGreaterThan(2);
  });
});

// ── unit legs: the estimator and the late-tick skip counter ───────────────

describe('estimator + skip accounting', () => {
  it('recovers the base pulse from the owner IOI multiset', () => {
    const iois = [0.5556, 0.2778, 0.2778, 0.5556, 0.2778, 0.2778, 0.5556, 0.2778];
    const base = tempolockEstimateBasePulse(iois);
    expect(base).not.toBeNull();
    expect(base!).toBeCloseTo(0.2778, 3);
  });

  it('returns null on too-short or inconsistent histories', () => {
    expect(tempolockEstimateBasePulse([0.5, 0.5, 0.5])).toBeNull();
    expect(tempolockEstimateBasePulse([0.31, 0.47, 0.62, 0.9, 0.53, 0.71])).toBeNull();
  });

  it('counts pulses a late tick could not place instead of dropping them silently', () => {
    const tracker = createTempolockTracker({ band: BAND });
    runTrain(tracker, fourOnFloor(120, 8), { endS: 4, tickS: 0.005 });
    // A 2-second stall: the next tick arrives at t=6 with pulses long due.
    const res = tracker.tick({ nowS: 6, onsets: 0, winEnd: 6.2 });
    expect(res.skipped).toBeGreaterThan(2);
    // ...and the cursor caught up in one step: what it now emits is ahead.
    for (const p of res.pulses) expect(p).toBeGreaterThanOrEqual(6 - 0.005);
  });
});
