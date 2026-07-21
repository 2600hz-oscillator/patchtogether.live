// packages/web/src/lib/audio/modules/clip-launch-quantize.test.ts
//
// Pins the PURE launch-quantization boundary math (the Deluge model): a queued
// launch snaps to the next loop wrap of the LONGEST currently-playing clip, not
// any single lane's own sooner wrap, and null when nothing is playing (→ the
// scheduler launches immediately). No engine — deterministic + fast.

import { describe, it, expect } from 'vitest';
import { nextLaunchBoundary, type PlayingLaneClock } from './clip-launch-quantize';

describe('nextLaunchBoundary (Deluge launch quantization)', () => {
  it('returns null when NOTHING is playing (caller launches immediately)', () => {
    expect(nextLaunchBoundary([], 0)).toBeNull();
  });

  it('a single playing clip MID-loop → the remaining steps to its next wrap', () => {
    // 16-step clip, its NEXT step to emit is step 5 at t=1.0, 0.1 s/step.
    // Next wrap = 1.0 + (16-5)*0.1 = 2.1.
    const p: PlayingLaneClock = { lenSteps: 16, laneStepDur: 0.1, nextStepTime: 1.0, stepIndex: 5 };
    expect(nextLaunchBoundary([p], 0.9)).toBeCloseTo(2.1, 9);
  });

  it('a lane PARKED at step 0 (imminent wrap) → the wrap is nextStepTime itself, NOT a full loop later', () => {
    // The scheduler parks a lane at stepIndex 0 with nextStepTime = the not-yet-
    // emitted wrap once it sits just past the lookahead. That wrap is 0.5 — the
    // `% len` guard must NOT overshoot to 0.5 + 4*0.1 = 0.9.
    const p: PlayingLaneClock = { lenSteps: 4, laneStepDur: 0.1, nextStepTime: 0.5, stepIndex: 0 };
    expect(nextLaunchBoundary([p], 0.4)).toBeCloseTo(0.5, 9);
  });

  it('LONG + SHORT playing → the LONG clip’s next wrap, NOT the short one’s sooner wrap', () => {
    // Both phase-aligned mid-loop, same step duration.
    const long: PlayingLaneClock = { lenSteps: 16, laneStepDur: 0.1, nextStepTime: 1.0, stepIndex: 5 }; // wrap 2.1
    const short: PlayingLaneClock = { lenSteps: 4, laneStepDur: 0.1, nextStepTime: 1.0, stepIndex: 1 }; // wrap 1.3
    const b = nextLaunchBoundary([long, short], 0.9);
    expect(b).toBeCloseTo(2.1, 9); // the LONG clip's wrap (16 * 0.1 = 1.6 s loop)
    expect(b).not.toBeCloseTo(1.3, 9); // NOT the short one's sooner 1.3 s wrap
    // Longest wins regardless of array order.
    expect(nextLaunchBoundary([short, long], 0.9)).toBeCloseTo(2.1, 9);
  });

  it('picks the longest by DURATION even when the shorter loop has MORE steps', () => {
    // 4 steps @ 0.5 s/step = 2.0 s loop BEATS 16 steps @ 0.1 s/step = 1.6 s loop.
    const fewLongSteps: PlayingLaneClock = { lenSteps: 4, laneStepDur: 0.5, nextStepTime: 1.0, stepIndex: 1 }; // wrap 2.5, dur 2.0
    const manyShortSteps: PlayingLaneClock = { lenSteps: 16, laneStepDur: 0.1, nextStepTime: 1.0, stepIndex: 5 }; // wrap 2.1, dur 1.6
    expect(nextLaunchBoundary([manyShortSteps, fewLongSteps], 0.9)).toBeCloseTo(2.5, 9);
  });

  it('ties on loop duration → the FIRST (lowest) lane’s wrap', () => {
    const a: PlayingLaneClock = { lenSteps: 8, laneStepDur: 0.1, nextStepTime: 0.2, stepIndex: 1 }; // wrap 0.9
    const b: PlayingLaneClock = { lenSteps: 8, laneStepDur: 0.1, nextStepTime: 0.3, stepIndex: 1 }; // wrap 1.0
    expect(nextLaunchBoundary([a, b], 0)).toBeCloseTo(0.9, 9); // first lane's wrap, not the later one's
  });

  it('rolls a slipped (past) boundary forward to strictly after now', () => {
    // Computed wrap 0.0 + (4-0)*0.1 = 0.4 sits before now=0.55 → roll one loop → 0.8.
    const p: PlayingLaneClock = { lenSteps: 4, laneStepDur: 0.1, nextStepTime: 0.0, stepIndex: 0 };
    expect(nextLaunchBoundary([p], 0.55)).toBeCloseTo(0.8, 9);
  });

  it('ignores a lane with a non-positive step duration (can’t anchor a bar)', () => {
    const bad: PlayingLaneClock = { lenSteps: 8, laneStepDur: 0, nextStepTime: 0.1, stepIndex: 0 };
    const good: PlayingLaneClock = { lenSteps: 4, laneStepDur: 0.1, nextStepTime: 0.1, stepIndex: 1 }; // wrap 0.4
    expect(nextLaunchBoundary([bad, good], 0)).toBeCloseTo(0.4, 9);
    expect(nextLaunchBoundary([bad], 0)).toBeNull();
  });
});
