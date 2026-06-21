// packages/web/src/lib/video/recorderbox-cfr-deficit.test.ts
//
// REGRESSION: SUSTAINED-deficit A/V desync. Under a render PERSISTENTLY below
// ~10 fps the old planCfrEmit (maxCatchup=2 → ≤3 frames/tick) let the video
// frameCount lag the 30 fps grid FOREVER (the grid advances >3 slots/tick when
// rendering <10 fps), so the video track ended SHORTER than the sample-accurate
// audio → growing desync.
//
// The fix: a SUSTAINED deficit (deficitStreak ≥ SUSTAINED_DEFICIT_TICKS) relaxes
// the per-tick catch-up cap so frameCount tracks `due` → video DURATION tracks
// wall-clock — while staying MONOTONIC + on the even 1/fps grid (no slow-mo
// regression) and WITHOUT a single visible burst (the catch-up spreads across the
// slow ticks). A transient one-off hitch must NOT trip the ramp.
//
// PURE — CI-safe, no encoder.

import { describe, it, expect } from 'vitest';
import {
  CfrClock,
  planCfrEmit,
  DEFICIT_SLACK_FRAMES,
  SUSTAINED_DEFICIT_TICKS,
  SUSTAINED_MAX_CATCHUP,
} from './recorderbox-cfr';

const FPS = 30;

/** Simulate the recorder's frame() CFR loop: per tick, bump/reset the deficit
 *  streak (slack-gated, exactly like RecorderboxRecorder.frame) then planCfrEmit
 *  with it. Returns the emitted PTS sequence + the final emitted count + peak
 *  frames-per-tick. */
function runLoop(opts: {
  fps: number;
  /** rAF tick times in seconds. */
  ticks: number[];
}) {
  const c = new CfrClock(opts.fps);
  let emitted = 0;
  let deficitStreak = 0;
  const pts: number[] = [];
  let peakPerTick = 0;
  for (const elapsed of opts.ticks) {
    const due = c.framesDue(elapsed);
    deficitStreak = due - emitted > DEFICIT_SLACK_FRAMES ? deficitStreak + 1 : 0;
    const plan = planCfrEmit(c, emitted, elapsed, 2, deficitStreak);
    if (plan.length > peakPerTick) peakPerTick = plan.length;
    for (const idx of plan) {
      pts.push(c.ptsForFrame(idx));
      emitted++;
    }
  }
  return { emitted, pts, peakPerTick };
}

describe('planCfrEmit — sustained-deficit ramp', () => {
  it('a TRANSIENT deficit (streak below threshold) keeps the small cap (no burst)', () => {
    const c = new CfrClock(FPS);
    // Far behind but only a few consecutive behind-ticks → transient cap (≤3).
    for (let streak = 0; streak < SUSTAINED_DEFICIT_TICKS; streak++) {
      expect(planCfrEmit(c, 0, 30 / 30, 2, streak)).toEqual([0, 1, 2]); // 1+maxCatchup
    }
  });

  it('a SUSTAINED deficit (streak ≥ threshold) relaxes the cap so frameCount can track the grid', () => {
    const c = new CfrClock(FPS);
    // 2 s elapsed, 0 emitted → grid wants 60 (> SUSTAINED_MAX_CATCHUP). Transient
    // limit = 3; sustained limit lets us emit up to SUSTAINED_MAX_CATCHUP this tick.
    const sustained = planCfrEmit(c, 0, 2, 2, SUSTAINED_DEFICIT_TICKS);
    expect(sustained.length).toBe(SUSTAINED_MAX_CATCHUP);
    expect(sustained).toEqual(Array.from({ length: SUSTAINED_MAX_CATCHUP }, (_, i) => i));
  });

  it('stays contiguous + on the even grid in BOTH regimes (no slow-mo, no dup PTS)', () => {
    const c = new CfrClock(FPS);
    for (const streak of [0, 3, SUSTAINED_DEFICIT_TICKS, SUSTAINED_DEFICIT_TICKS + 5]) {
      const out = planCfrEmit(c, 12, 20 / 30, 2, streak);
      // contiguous starting at `emitted`
      out.forEach((idx, i) => expect(idx).toBe(12 + i));
      // PTS strictly increasing + exactly 1/fps apart
      for (let i = 1; i < out.length; i++) {
        expect(c.ptsForFrame(out[i]) - c.ptsForFrame(out[i - 1])).toBeCloseTo(1 / FPS, 12);
      }
    }
  });
});

describe('CFR A/V-desync regression — sustained sub-fps render tracks real time', () => {
  it('video frameCount/duration does NOT permanently lag wall-clock at ~5 fps', () => {
    // 30 fps grid, but the renderer ticks only ~5 fps (200 ms steps) for 10 s.
    // Old behavior (cap 3/tick, 5 ticks/s) → ≤15 frames/s vs a 30 fps grid → the
    // video falls ~half a frame-rate behind every second → ends at ~half real
    // time. The fix must let it track real time.
    const STEP = 0.2; // 5 fps
    const DURATION = 10; // s
    const ticks: number[] = [];
    for (let t = STEP; t <= DURATION + 1e-9; t += STEP) ticks.push(t);

    const { emitted, pts, peakPerTick } = runLoop({ fps: FPS, ticks });

    // Video DURATION (last PTS + a frame) should track real elapsed time, not lag
    // it. Grid wants ~300 frames over 10 s @ 30 fps; allow a small tail tolerance.
    const lastElapsed = ticks[ticks.length - 1];
    const gridDue = Math.floor(lastElapsed * FPS);
    const videoDurationS = pts.length > 0 ? pts[pts.length - 1] + 1 / FPS : 0;

    // (a) frameCount tracks the grid within a couple frames (NOT ~half of it).
    expect(emitted).toBeGreaterThanOrEqual(gridDue - 2);
    expect(emitted).toBeLessThanOrEqual(gridDue + 1);
    // (b) video duration ≈ real time (within ~0.1 s), not slow-mo-stretched.
    expect(videoDurationS).toBeGreaterThanOrEqual(lastElapsed - 0.1);
    expect(videoDurationS).toBeLessThanOrEqual(lastElapsed + 0.1);
    // (c) MONOTONIC + EVEN grid preserved (no duplicate PTS, no slow-mo stretch).
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i]).toBeGreaterThan(pts[i - 1]);
      expect(pts[i] - pts[i - 1]).toBeCloseTo(1 / FPS, 9);
    }
    pts.forEach((p, i) => expect(p).toBeCloseTo(i / FPS, 9));
    // (d) No single tick dumps an unbounded burst (the ramp is bounded).
    expect(peakPerTick).toBeLessThanOrEqual(SUSTAINED_MAX_CATCHUP);
  });

  it('an even slower ~3 fps render still tracks real time (within the bounded cap)', () => {
    const STEP = 1 / 3; // ~3 fps → grid advances 10 slots/tick
    const DURATION = 9;
    const ticks: number[] = [];
    for (let t = STEP; t <= DURATION + 1e-9; t += STEP) ticks.push(t);
    const { emitted, pts } = runLoop({ fps: FPS, ticks });
    const lastElapsed = ticks[ticks.length - 1];
    const gridDue = Math.floor(lastElapsed * FPS);
    // 3 fps → 10 grid-slots/tick; SUSTAINED cap (1+11=12) covers it → tracks time.
    expect(emitted).toBeGreaterThanOrEqual(gridDue - 2);
    const videoDurationS = pts[pts.length - 1] + 1 / FPS;
    expect(videoDurationS).toBeGreaterThanOrEqual(lastElapsed - 0.2);
    expect(videoDurationS).toBeLessThanOrEqual(lastElapsed + 0.1);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i] - pts[i - 1]).toBeCloseTo(1 / FPS, 9);
    }
  });

  it('a healthy ~30 fps render is unaffected (no ramp, no extra/dup frames)', () => {
    // 33.3 ms steps for 5 s → on-pace, streak never crosses the threshold.
    const STEP = 1 / 30;
    const ticks: number[] = [];
    for (let t = STEP; t <= 5 + 1e-9; t += STEP) ticks.push(t);
    const { emitted, pts, peakPerTick } = runLoop({ fps: FPS, ticks });
    // ~150 frames over 5 s, one per tick — NOT a duplicated burst.
    expect(emitted).toBeGreaterThanOrEqual(148);
    expect(emitted).toBeLessThanOrEqual(151);
    expect(peakPerTick).toBe(1); // exactly one frame per on-pace tick
    pts.forEach((p, i) => expect(p).toBeCloseTo(i / FPS, 9));
  });

  it('a TRANSIENT hitch (brief stall, then recovery) does NOT trip the sustained ramp', () => {
    // Steady 30 fps, ONE brief stall (~0.13 s gap ≈ 4 grid frames — a realistic
    // GC/layout hitch, above the slack so it registers but short enough to drain
    // within a couple transient ticks), then steady again. The catch-up after the
    // hitch must use the SMALL transient cap (no big burst): the deficit drains
    // (net 2/tick) before the streak reaches SUSTAINED_DEFICIT_TICKS, so the ramp
    // never engages.
    const ticks: number[] = [];
    for (let t = 1 / 30; t < 0.3; t += 1 / 30) ticks.push(t); // steady ~9 frames
    ticks.push(0.3 + 4 / 30); // a single ~0.13 s stall (one tick jumps ~4 ahead)
    for (let t = 0.3 + 5 / 30; t <= 1.0 + 1e-9; t += 1 / 30) ticks.push(t); // steady again
    const { peakPerTick, pts } = runLoop({ fps: FPS, ticks });
    // The hitch is absorbed by the transient cap → at most 1+maxCatchup(2)=3 in a
    // single tick (NOT a relaxed-ramp burst).
    expect(peakPerTick).toBeLessThanOrEqual(3);
    // Still a clean even grid.
    pts.forEach((p, i) => expect(p).toBeCloseTo(i / FPS, 9));
  });
});
