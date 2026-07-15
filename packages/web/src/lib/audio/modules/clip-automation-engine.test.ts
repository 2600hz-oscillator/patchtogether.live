// packages/web/src/lib/audio/modules/clip-automation-engine.test.ts
import { describe, it, expect } from 'vitest';
import type { AutomationEvent } from './clip-types';
import {
  stepRampPoints,
  trackInterp,
  RecordGate,
  QuantizedRecordWindow,
} from './clip-automation-engine';

describe('stepRampPoints — lookahead ramp scheduling', () => {
  const events: AutomationEvent[] = [
    { step: 0, value: 0.2 },
    { step: 2, value: 0.8 },
    { step: 4, value: 0.0 },
  ];

  it('linear: anchors at the step start + ramps to the next step value', () => {
    // step 0, laneDur 0.5s, emitAt 10 → value at step0=0.2, ramp to value at step1 (0.5).
    const pts = stepRampPoints(events, 0, 0.5, 10, 'linear');
    expect(pts[0]).toEqual({ value: 0.2, at: 10, ramp: false }); // anchor
    const last = pts[pts.length - 1]!;
    expect(last.at).toBeCloseTo(10.5, 9);
    expect(last.ramp).toBe(true);
    expect(last.value).toBeCloseTo(0.5, 9); // linear halfway 0.2→0.8 at step 1
  });

  it('linear: schedules a SUB-step breakpoint at its fractional audio time', () => {
    // a fast wiggle inside step 0: breakpoint at step 0.5.
    const ev: AutomationEvent[] = [
      { step: 0, value: 0.1 },
      { step: 0.5, value: 0.9 },
      { step: 1, value: 0.2 },
    ];
    const pts = stepRampPoints(ev, 0, 1.0, 100, 'linear');
    // expect a ramp point at time 100.5 with value 0.9
    const mid = pts.find((p) => Math.abs(p.at - 100.5) < 1e-9);
    expect(mid).toBeDefined();
    expect(mid!.value).toBeCloseTo(0.9, 9);
    expect(mid!.ramp).toBe(true);
  });

  it('hold: hard steps, no interpolation', () => {
    const pts = stepRampPoints(events, 0, 0.5, 10, 'hold');
    expect(pts.every((p) => p.ramp === false)).toBe(true);
    expect(pts[0]).toEqual({ value: 0.2, at: 10, ramp: false });
  });

  it('returns [] before the first breakpoint (leave live value)', () => {
    const later: AutomationEvent[] = [{ step: 5, value: 0.5 }];
    expect(stepRampPoints(later, 0, 0.5, 10, 'linear')).toEqual([]);
    expect(stepRampPoints([], 0, 0.5, 10, 'linear')).toEqual([]);
  });

  it('holds the final value past the last breakpoint', () => {
    const pts = stepRampPoints(events, 10, 0.5, 10, 'linear');
    expect(pts.length).toBeGreaterThan(0);
    expect(pts.every((p) => p.value === 0)).toBe(true); // past step 4 → holds 0.0
  });
});

describe('trackInterp', () => {
  it('honors an explicit track interp', () => {
    expect(trackInterp({ interp: 'hold' }, undefined)).toBe('hold');
    expect(trackInterp({ interp: 'linear' }, 'discrete')).toBe('linear');
  });
  it('defaults discrete params to hold, else linear', () => {
    expect(trackInterp({}, 'discrete')).toBe('hold');
    expect(trackInterp({}, 'log')).toBe('linear');
    expect(trackInterp({}, undefined)).toBe('linear');
  });
});

describe('RecordGate — decimation', () => {
  it('keeps the first sample, then only when value moves enough', () => {
    const g = new RecordGate({ minValueDelta: 0.1, maxStepGap: 999 });
    expect(g.sample(0, 0.5)).toBe(true); // first
    expect(g.sample(0.1, 0.52)).toBe(false); // +0.02 < 0.1
    expect(g.sample(0.2, 0.65)).toBe(true); // +0.15 ≥ 0.1
    expect(g.length).toBe(2);
  });
  it('emits on the time gap even if the value barely moves', () => {
    const g = new RecordGate({ minValueDelta: 0.5, maxStepGap: 1 });
    g.sample(0, 0.5); // first
    expect(g.sample(0.5, 0.5)).toBe(false); // gap 0.5 < 1, no move
    expect(g.sample(1.0, 0.5)).toBe(true); // gap 1.0 ≥ 1
  });
  it('close() appends the final sample (slow tail not clipped)', () => {
    const g = new RecordGate({ minValueDelta: 0.5, maxStepGap: 999 });
    g.sample(0, 0.5); // kept (first)
    g.sample(1, 0.55); // dropped
    g.sample(2, 0.6); // dropped (tail)
    const pts = g.close();
    expect(pts[pts.length - 1]).toEqual({ step: 2, value: 0.6 });
  });
  it('discrete unitDelta gate does not swallow single-unit moves', () => {
    // 0..127 param → one unit ≈ 1/127 ≈ 0.00787.
    const unit = 1 / 127;
    const g = new RecordGate({ unitDelta: unit });
    g.sample(0, 0); // first
    expect(g.sample(1, unit)).toBe(true); // exactly one unit → kept
  });
  it('returns step-sorted points', () => {
    const g = new RecordGate({ minValueDelta: 0, maxStepGap: 0 });
    g.sample(2, 0.2);
    g.sample(1, 0.1);
    const pts = g.close();
    expect(pts.map((p) => p.step)).toEqual([1, 2]);
  });
});

describe('QuantizedRecordWindow — arm → punch-in at wrap → punch-out one loop later', () => {
  it('the owner workflow: arm, start recording when the playhead wraps, stop at loop end', () => {
    const w = new QuantizedRecordWindow();
    // playing mid-loop, not armed yet
    expect(w.advance(3)).toBeNull();
    expect(w.advance(5)).toBeNull();
    w.arm();
    expect(w.state).toBe('armed');
    // still climbing — no punch-in until the loop wraps
    expect(w.advance(7)).toBeNull();
    // wrap (7 → 0): PUNCH IN
    expect(w.advance(0)).toBe('punch-in');
    expect(w.state).toBe('recording');
    // one full loop of climbing
    expect(w.advance(2)).toBeNull();
    expect(w.advance(6)).toBeNull();
    // next wrap: PUNCH OUT (one loop elapsed)
    expect(w.advance(0)).toBe('punch-out');
    expect(w.state).toBe('done');
    // further advances do nothing
    expect(w.advance(3)).toBeNull();
  });

  it('disarm resets to idle', () => {
    const w = new QuantizedRecordWindow();
    w.arm();
    w.advance(5);
    w.advance(0); // punch-in
    expect(w.state).toBe('recording');
    w.disarm();
    expect(w.state).toBe('idle');
    // re-arming works cleanly
    w.arm();
    w.advance(4);
    expect(w.advance(0)).toBe('punch-in');
  });

  it('does not punch in until armed (a wrap while idle is ignored)', () => {
    const w = new QuantizedRecordWindow();
    expect(w.advance(6)).toBeNull();
    expect(w.advance(0)).toBeNull(); // wrap while idle — nothing
    expect(w.state).toBe('idle');
  });
});
