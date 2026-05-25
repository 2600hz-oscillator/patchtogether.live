// packages/web/src/lib/video/modules/videovarispeed-transport.test.ts
//
// Pure transport math for VIDEOVARISPEED: the varispeed knob map, CV summing,
// START/END window logic + END-CV normalling, loop-vs-one-shot edge action,
// and the throttled reverse-scrub step (the perf-critical part).

import { describe, expect, it } from 'vitest';
import {
  speedKnobToMultiplier,
  effectiveSpeedKnob,
  effectiveStartFraction,
  effectiveEndFraction,
  resolveWindow,
  decideEdgeAction,
  reverseScrubStep,
  REVERSE_SCRUB_INTERVAL_MS,
} from './videovarispeed-transport';

describe('speedKnobToMultiplier — analog-clock varispeed map', () => {
  it('hits exactly -4 / +1 / +4 at 0 / 0.5 / 1', () => {
    expect(speedKnobToMultiplier(0)).toBeCloseTo(-4, 12);
    expect(speedKnobToMultiplier(0.5)).toBeCloseTo(1, 12);
    expect(speedKnobToMultiplier(1)).toBeCloseTo(4, 12);
  });

  it('is monotonic increasing across the range', () => {
    let prev = -Infinity;
    for (let k = 0; k <= 1.0001; k += 0.01) {
      const v = speedKnobToMultiplier(k);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('left half spans -4..+1 (steeper) and right half +1..+4 (shallower)', () => {
    expect(speedKnobToMultiplier(0.25)).toBeCloseTo(-1.5, 12);
    expect(speedKnobToMultiplier(0.75)).toBeCloseTo(2.5, 12);
    const leftSlope = speedKnobToMultiplier(0.5) - speedKnobToMultiplier(0);
    const rightSlope = speedKnobToMultiplier(1) - speedKnobToMultiplier(0.5);
    expect(leftSlope).toBeCloseTo(5, 12);
    expect(rightSlope).toBeCloseTo(3, 12);
  });

  it('clamps knob input to [0, 1]', () => {
    expect(speedKnobToMultiplier(-1)).toBeCloseTo(-4, 12);
    expect(speedKnobToMultiplier(2)).toBeCloseTo(4, 12);
  });

  it('crosses zero (the "stop" point) in the left half at knob 0.4', () => {
    expect(speedKnobToMultiplier(0.4)).toBeCloseTo(0, 12);
  });
});

describe('effectiveSpeedKnob — CV sums into the knob (bipolar ±1 = full sweep)', () => {
  it('cv=0 leaves the knob untouched', () => {
    expect(effectiveSpeedKnob(0.5, 0)).toBeCloseTo(0.5, 12);
  });
  it('cv=+1 from centre pushes to full-forward; cv=-1 to full-reverse', () => {
    expect(effectiveSpeedKnob(0.5, 1)).toBeCloseTo(1, 12);
    expect(effectiveSpeedKnob(0.5, -1)).toBeCloseTo(0, 12);
  });
  it('clamps the summed knob to [0, 1]', () => {
    expect(effectiveSpeedKnob(0.8, 1)).toBe(1);
    expect(effectiveSpeedKnob(0.2, -1)).toBe(0);
  });
});

describe('effectiveStartFraction — START CV normals to 0', () => {
  it('unpatched: slider rules, CV ignored', () => {
    expect(effectiveStartFraction(0.3, 0.9, false)).toBeCloseTo(0.3, 12);
  });
  it('patched: CV adds to the slider', () => {
    expect(effectiveStartFraction(0.3, 0.2, true)).toBeCloseTo(0.5, 12);
    expect(effectiveStartFraction(0.3, -0.5, true)).toBeCloseTo(0, 12);
  });
});

describe('effectiveEndFraction — END CV normals to +1', () => {
  it('UNPATCHED end stays at the slider default (1 = full duration)', () => {
    expect(effectiveEndFraction(1, -0.7, false)).toBeCloseTo(1, 12);
    expect(effectiveEndFraction(1, 0, false)).toBeCloseTo(1, 12);
  });
  it('patched NEGATIVE CV pulls the END point leftward (earlier)', () => {
    expect(effectiveEndFraction(1, -0.4, true)).toBeCloseTo(0.6, 12);
    expect(effectiveEndFraction(1, -2, true)).toBeCloseTo(0, 12);
  });
  it('patched positive CV is clamped at 1 (already full)', () => {
    expect(effectiveEndFraction(1, 0.5, true)).toBe(1);
  });
});

describe('resolveWindow — [start, end] in seconds + empty-window guard', () => {
  it('maps fractions to seconds against duration', () => {
    const w = resolveWindow(10, 0.2, 0.8);
    expect(w.startSec).toBeCloseTo(2, 12);
    expect(w.endSec).toBeCloseTo(8, 12);
    expect(w.hasWindow).toBe(true);
  });
  it('START dragged past END → no playback (empty window)', () => {
    expect(resolveWindow(10, 0.8, 0.3).hasWindow).toBe(false);
  });
  it('START == END → no playback (empty window)', () => {
    expect(resolveWindow(10, 0.5, 0.5).hasWindow).toBe(false);
  });
  it('zero / non-finite duration → no window', () => {
    expect(resolveWindow(0, 0, 1).hasWindow).toBe(false);
    expect(resolveWindow(NaN, 0, 1).hasWindow).toBe(false);
  });
  it('default window (0..1) covers the whole clip', () => {
    const w = resolveWindow(12, 0, 1);
    expect(w.startSec).toBe(0);
    expect(w.endSec).toBe(12);
    expect(w.hasWindow).toBe(true);
  });
});

describe('decideEdgeAction — loop vs one-shot at the window edge', () => {
  const w = resolveWindow(10, 0.2, 0.8); // start=2s, end=8s

  it('forward, before END → no action', () => {
    expect(decideEdgeAction(5, w, true, true).kind).toBe('none');
  });
  it('forward at END, LOOP → jump back to START', () => {
    const a = decideEdgeAction(8, w, true, true);
    expect(a.kind).toBe('loop');
    if (a.kind === 'loop') expect(a.seekTo).toBeCloseTo(2, 12);
  });
  it('forward at END, ONE-SHOT → stop at END', () => {
    const a = decideEdgeAction(8.1, w, true, false);
    expect(a.kind).toBe('stop');
    if (a.kind === 'stop') expect(a.clampTo).toBeCloseTo(8, 12);
  });
  it('reverse at START, LOOP → jump to END', () => {
    const a = decideEdgeAction(2, w, false, true);
    expect(a.kind).toBe('loop');
    if (a.kind === 'loop') expect(a.seekTo).toBeCloseTo(8, 12);
  });
  it('reverse at START, ONE-SHOT → stop at START', () => {
    const a = decideEdgeAction(1.9, w, false, false);
    expect(a.kind).toBe('stop');
    if (a.kind === 'stop') expect(a.clampTo).toBeCloseTo(2, 12);
  });
  it('empty window → never acts', () => {
    const empty = resolveWindow(10, 0.8, 0.2);
    expect(decideEdgeAction(5, empty, true, true).kind).toBe('none');
  });
});

describe('reverseScrubStep — THROTTLED reverse scrub (the perf fix)', () => {
  it('does NOT seek before the throttle interval elapses', () => {
    const step = reverseScrubStep(5, 2, REVERSE_SCRUB_INTERVAL_MS - 1, 0);
    expect(step.seek).toBe(false);
    expect(step.toSec).toBe(5); // unchanged
  });

  it('seeks once the throttle interval elapses, moving back by |speed|*dt', () => {
    // 200ms accumulated at 2x reverse → back 0.4s.
    const step = reverseScrubStep(5, 2, 200, 0);
    expect(step.seek).toBe(true);
    expect(step.toSec).toBeCloseTo(5 - 0.4, 6);
  });

  it('clamps the scrub target to the window start', () => {
    const step = reverseScrubStep(0.1, 4, 200, 0.5);
    expect(step.seek).toBe(true);
    expect(step.toSec).toBe(0.5); // would have gone negative; clamped to start
  });

  it('throttle interval is the documented ~10 Hz cadence', () => {
    expect(REVERSE_SCRUB_INTERVAL_MS).toBe(100);
  });
});
