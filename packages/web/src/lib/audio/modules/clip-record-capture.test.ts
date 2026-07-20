// packages/web/src/lib/audio/modules/clip-record-capture.test.ts
//
// DETERMINISTIC record-capture math (redesign §4.1). Pins the two fixes for
// owner problem 1a: NEAREST-step rounding (a note played a hair early lands on
// the intended step, never floored onto the previous one) and clock-projected
// capture (driven by the event's own time, so fast tempo can't skip it).

import { describe, it, expect } from 'vitest';
import {
  eventFracStep,
  quantizeStep,
  captureStep,
  RECORD_GRID_STEPS_DEFAULT,
  type LaneCapturePhase,
} from './clip-record-capture';

// A phase whose ctx↔perf offset is exactly 0 (ctxTime s == perfNow/1000), so
// eventAudioTime == eventMs/1000 — keeps the arithmetic legible.
function phase(over: Partial<LaneCapturePhase> = {}): LaneCapturePhase {
  return {
    anchorStep: 2,
    anchorTime: 100, // audio seconds
    laneDur: 0.125, // 120 bpm, 1/16
    lengthSteps: 8,
    ctxTime: 100,
    perfNow: 100_000, // ms → /1000 = 100 s ⇒ offset 0
    ...over,
  };
}

describe('quantizeStep — nearest-step rounding + wrap', () => {
  it('rounds to the NEAREST step, not the floor', () => {
    expect(quantizeStep(2.96, 8, 1)).toBe(3); // a hair before step 3 → step 3
    expect(quantizeStep(3.04, 8, 1)).toBe(3);
    expect(quantizeStep(3.0, 8, 1)).toBe(3);
    expect(quantizeStep(2.49, 8, 1)).toBe(2);
    expect(quantizeStep(2.5, 8, 1)).toBe(3); // half rounds up (Math.round)
  });
  it('wraps into [0, lengthSteps)', () => {
    expect(quantizeStep(8.2, 8, 1)).toBe(0); // just past the loop end → step 0
    expect(quantizeStep(-0.3, 8, 1)).toBe(0); // anticipating step 0 → step 0 (not 7)
    expect(quantizeStep(-0.6, 8, 1)).toBe(7); // clearly closer to the last step
  });
  it('snaps to a coarser grid', () => {
    expect(quantizeStep(5.4, 16, 4)).toBe(4); // nearest 1/4 (every 4 steps)
    expect(quantizeStep(6.1, 16, 4)).toBe(8);
    expect(quantizeStep(15.9, 16, 4)).toBe(0); // round 16 → wrap 0
  });
  it('never returns out of range for any grid', () => {
    for (let f = -20; f <= 40; f += 0.37) {
      const s = quantizeStep(f, 8, 1);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(8);
    }
  });
});

describe('eventFracStep — clock projection', () => {
  it('an event AT the anchor projects to the anchor step', () => {
    expect(eventFracStep(100_000, phase())).toBeCloseTo(2, 6);
  });
  it('a note played 5 ms BEFORE the next step boundary projects just under it', () => {
    // step 3 boundary = anchorTime + laneDur = 100.125 s → 100_125 ms.
    const frac = eventFracStep(100_120, phase())!; // 5 ms early
    expect(frac).toBeCloseTo(2.96, 6);
    // ...and captureStep rounds it UP to step 3 (the anticipation fix).
    expect(captureStep(100_120, phase())).toBe(3);
  });
  it('honours a non-zero ctx↔perf offset', () => {
    // offset = ctxTime - perfNow/1000 = 100 - 90 = 10 s. Event at perf 90_500 ms
    // → audio 90.5 + 10 = 100.5 s → delta (100.5-100)/0.125 = 4 → step 6.
    const p = phase({ ctxTime: 100, perfNow: 90_000 });
    expect(eventFracStep(90_500, p)).toBeCloseTo(6, 6);
  });
  it('returns null (→ caller falls back) when the lane is silent or bogus', () => {
    expect(eventFracStep(100_000, phase({ anchorStep: -1 }))).toBeNull();
    expect(eventFracStep(100_000, phase({ laneDur: 0 }))).toBeNull();
    expect(eventFracStep(100_000, phase({ lengthSteps: 0 }))).toBeNull();
    expect(eventFracStep(100_000, null)).toBeNull();
    // A wildly stale event (a backgrounded-tab burst) projects far outside a
    // loop → null.
    expect(eventFracStep(50_000, phase())).toBeNull();
  });
});

describe('captureStep — end to end + fast tempo has no skip', () => {
  it('falls back (null) when no phase is published', () => {
    expect(captureStep(100_000, null)).toBeNull();
    expect(captureStep(100_000, phase({ anchorStep: -1 }))).toBeNull();
  });
  it('defaults to the 1/16 (=1 step) grid', () => {
    expect(RECORD_GRID_STEPS_DEFAULT).toBe(1);
  });
  it('at FAST tempo, successive events land on DISTINCT expected steps (no poll-skip)', () => {
    // 1/32 @ 180 bpm 2× ≈ 0.0208 s/step — sub-tick steps. Events spaced one
    // step apart from the anchor must map to consecutive steps deterministically,
    // because capture is driven by the EVENT time (not the 25 ms poll).
    const laneDur = 0.0208;
    const p = phase({ anchorStep: 0, anchorTime: 100, laneDur, lengthSteps: 16 });
    const got: number[] = [];
    for (let k = 0; k < 6; k++) {
      // event k lands right on step k (+ a tiny +0.2-step jitter that must round back)
      const eventMs = (100 + (k + 0.2) * laneDur) * 1000;
      got.push(captureStep(eventMs, p)!);
    }
    expect(got).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
