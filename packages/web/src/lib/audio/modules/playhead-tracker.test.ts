// packages/web/src/lib/audio/modules/playhead-tracker.test.ts
//
// Unit tests for the playhead tracker — the small helper every lookahead-
// scheduling sequencer uses to derive "sounding now" from the queue of
// scheduled future step events.

import { describe, it, expect } from 'vitest';
import {
  createPlayheadTracker,
  createPlayheadTrackerOf,
} from './playhead-tracker';

describe('createPlayheadTracker', () => {
  it('returns 0 before anything has been scheduled', () => {
    const p = createPlayheadTracker();
    expect(p.currentAt(0)).toBe(0);
    expect(p.currentAt(100)).toBe(0);
  });

  it('returns 0 when scheduled events are all in the future', () => {
    const p = createPlayheadTracker();
    p.schedule(0, 10);
    p.schedule(1, 10.5);
    // Read at t=5 — both events are still in the future.
    expect(p.currentAt(5)).toBe(0);
  });

  it('returns the most recent step whose atTime has passed', () => {
    const p = createPlayheadTracker();
    p.schedule(0, 1.0);
    p.schedule(1, 1.5);
    p.schedule(2, 2.0);
    p.schedule(3, 2.5);

    // t=0.5: nothing has played yet.
    expect(p.currentAt(0.5)).toBe(0);
    // t=1.0: exactly step 0's start time.
    expect(p.currentAt(1.0)).toBe(0);
    // t=1.4: still on step 0; step 1 hasn't started yet.
    expect(p.currentAt(1.4)).toBe(0);
    // t=1.5: step 1 just started.
    expect(p.currentAt(1.5)).toBe(1);
    // t=2.25: step 2 sounding (step 3 not yet).
    expect(p.currentAt(2.25)).toBe(2);
    // t=10: well past the end of the queue; sticks on the last-sounding.
    expect(p.currentAt(10)).toBe(3);
  });

  it('reproduces the off-by-one scenario: lookahead schedules step 1 ahead, highlight stays at step 0 until step 1 starts sounding', () => {
    // Simulate the polyseqz scheduler-clock pattern: at audio-time t=0 the
    // module is just starting; the lookahead window is 200ms; at 60 BPM
    // 16th-notes that's 250ms/step → 1 step in the lookahead window.
    const p = createPlayheadTracker();
    const stepDur = 0.25;
    // At t=0, the scheduler queues step 0 at t=0 and step 1 at t=0.25 (within
    // LOOKAHEAD).
    p.schedule(0, 0.0);
    p.schedule(1, 0.25);

    // Before the legacy fix, currentStep would be set to 1 here (the
    // scheduler's stepIndex AFTER the loop). The tracker correctly reports
    // step 0 because that's what's sounding at t=0.
    expect(p.currentAt(0.0)).toBe(0);

    // At t=0.1 (40 ms in) the user looks at the highlight — should still
    // show step 0, NOT the next-scheduled step 1.
    expect(p.currentAt(0.1)).toBe(0);

    // At t=0.25 step 1 starts sounding.
    expect(p.currentAt(0.25)).toBe(1);
  });

  it('reset() clears the queue and resets the last-sounding step', () => {
    const p = createPlayheadTracker();
    p.schedule(0, 0);
    p.schedule(1, 0.5);
    p.schedule(2, 1.0);
    expect(p.currentAt(1.5)).toBe(2);
    p.reset();
    expect(p.currentAt(0)).toBe(0);
    expect(p.__peek().length).toBe(0);
  });

  it('GCs stale entries past the leading edge', () => {
    const p = createPlayheadTracker();
    for (let i = 0; i < 10; i++) p.schedule(i, i * 0.1);
    expect(p.__peek().length).toBe(10);
    // Read at t=0.95 — everything up to step 9 has played. The first 9
    // entries get GCed; only the leading-edge entry (idx=9, atTime=0.9)
    // remains so future reads stick on it.
    expect(p.currentAt(0.95)).toBe(9);
    expect(p.__peek().length).toBe(1);
  });

  it('caps queue length at MAX_ENTRIES even if reset is forgotten', () => {
    const p = createPlayheadTracker();
    // Schedule far more than MAX_ENTRIES (64) in the future.
    for (let i = 0; i < 200; i++) p.schedule(i, 100 + i);
    expect(p.__peek().length).toBeLessThanOrEqual(64);
    // Entries kept should be the most recent ones (oldest dropped).
    const peek = p.__peek();
    expect(peek[peek.length - 1]!.idx).toBe(199);
  });

  it('handles multiple scheduled entries with the same atTime gracefully (last write wins)', () => {
    const p = createPlayheadTracker();
    p.schedule(0, 1.0);
    p.schedule(5, 1.0); // duplicate timestamp (legitimate at sequence wrap)
    p.schedule(1, 1.5);
    // At t=1.0, both step-0 and step-5 are eligible; the tracker walks in
    // schedule order and returns the LAST one whose atTime <= now → step 5.
    expect(p.currentAt(1.0)).toBe(5);
    expect(p.currentAt(1.5)).toBe(1);
  });

  it('frozen-clock determinism: repeat reads at the same `now` are bit-identical', () => {
    // This is the property that the e2e suspend/resume helper
    // (e2e/tests/_scheduler-control.ts → freezeAudioClock) relies on:
    // while AudioContext is suspended, ctx.currentTime is held constant, so
    // every engine.read('currentStep') call returns the same answer.
    //
    // This test pins that contract at the tracker level (the e2e suspend
    // does the real freezing in-browser). If a future "optimization" tries
    // to e.g. extrapolate based on wall-clock between calls, this test will
    // fail and force the author to revisit the determinism guarantee.
    const p = createPlayheadTracker();
    p.schedule(0, 0.0);
    p.schedule(1, 0.5);
    p.schedule(2, 1.0);
    p.schedule(3, 1.5);

    // Pick a "now" between scheduled events. Read 10 times — every read
    // must return the same step.
    const now = 1.2; // step 2 is sounding (started at 1.0); step 3 still future
    const reads: number[] = [];
    for (let i = 0; i < 10; i++) reads.push(p.currentAt(now));
    for (const r of reads) expect(r).toBe(2);

    // Even after a read advances the internal queue (GC of stale entries),
    // a subsequent read at the same `now` is still 2.
    expect(p.currentAt(now)).toBe(2);
    expect(p.currentAt(now)).toBe(2);
  });

  it('frozen-clock determinism: scheduling new entries past `now` does not change the read at `now`', () => {
    // Models what the lookahead scheduler does while AudioContext is
    // suspended: tick() may continue to fire (Worker is unsuspended), but
    // because ctx.currentTime is frozen the scheduler's
    // playhead.schedule() calls always queue entries with atTime > now.
    // The visual playhead must stay put.
    const p = createPlayheadTracker();
    p.schedule(0, 0.0);
    p.schedule(1, 0.5);
    const now = 0.6;
    expect(p.currentAt(now)).toBe(1);

    // While "suspended" at now=0.6, the scheduler queues several future
    // entries (atTime > now). The read at the same now MUST stay 1.
    p.schedule(2, 1.0);
    p.schedule(3, 1.5);
    p.schedule(4, 2.0);
    expect(p.currentAt(now)).toBe(1);
    expect(p.currentAt(now)).toBe(1);
  });
});

describe('createPlayheadTrackerOf<T>', () => {
  it('returns the `initial` value when nothing has played', () => {
    const p = createPlayheadTrackerOf<string | null>();
    expect(p.currentAt(0, null)).toBe(null);
    expect(p.currentAt(0, 'fallback')).toBe('fallback');
  });

  it('returns the most recent payload whose atTime has passed', () => {
    const p = createPlayheadTrackerOf<string>();
    p.schedule('note-a', 1.0);
    p.schedule('note-b', 2.0);
    expect(p.currentAt(0.5, '')).toBe('');
    expect(p.currentAt(1.0, '')).toBe('note-a');
    expect(p.currentAt(2.5, '')).toBe('note-b');
  });

  it('reset() clears the queue and last-sounding payload', () => {
    const p = createPlayheadTrackerOf<string>();
    p.schedule('x', 0);
    expect(p.currentAt(0.5, 'init')).toBe('x');
    p.reset();
    expect(p.currentAt(1.0, 'init')).toBe('init');
  });
});
