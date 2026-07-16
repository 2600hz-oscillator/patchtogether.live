// packages/web/src/lib/audio/modules/clip-automation-engine.test.ts
import { describe, it, expect } from 'vitest';
import type { AutomationEvent } from './clip-types';
import {
  stepRampPoints,
  trackInterp,
  RecordGate,
  QuantizedRecordWindow,
  SEAM_GLIDE_S,
  quantizeStopStep,
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

describe('stepRampPoints — SEAM GLIDE (loop-wrap / clip-switch de-zipper)', () => {
  const events: AutomationEvent[] = [
    { step: 0, value: 0.2 },
    { step: 2, value: 0.8 },
    { step: 4, value: 0.0 },
  ];

  it('default (seamGlideS=0): the step-0 anchor is a HARD STEP (regression guard)', () => {
    const pts = stepRampPoints(events, 0, 0.5, 10, 'linear');
    expect(pts[0]).toEqual({ value: 0.2, at: 10, ramp: false });
  });

  it('WRAP seam: the step-0 anchor becomes a RAMP (not a step), offset by the glide', () => {
    // The last-step→step-0 transition: with a glide the anchor is a short
    // linearRamp reaching v0 at emitAt+glide instead of a hard setValueAtTime.
    const pts = stepRampPoints(events, 0, 0.5, 10, 'linear', SEAM_GLIDE_S);
    expect(pts[0]!.ramp).toBe(true); // a RAMP, not a step → no wrap click
    expect(pts[0]!.value).toBeCloseTo(0.2, 9);
    expect(pts[0]!.at).toBeCloseTo(10 + SEAM_GLIDE_S, 9);
  });

  it('HOLD/discrete tracks ignore the seam glide (steps are intentional)', () => {
    const pts = stepRampPoints(events, 0, 0.5, 10, 'hold', SEAM_GLIDE_S);
    expect(pts[0]).toEqual({ value: 0.2, at: 10, ramp: false }); // still a hard step
  });

  it('clamps the glide below a fast step + the earliest sub-step breakpoint', () => {
    // laneDur 0.01s → glide clamps to laneDur*0.5 = 0.005 (< SEAM_GLIDE_S=0.012),
    // so the anchor never overruns the next-step boundary on a fast clock.
    const pts = stepRampPoints(events, 0, 0.01, 10, 'linear', SEAM_GLIDE_S);
    expect(pts[0]!.ramp).toBe(true);
    expect(pts[0]!.at).toBeLessThanOrEqual(10 + 0.005 + 1e-9);
    // A sub-step breakpoint very early in the step further clamps the glide so
    // the anchor time stays before it (points scheduled in order).
    const dense: AutomationEvent[] = [
      { step: 0, value: 0.2 },
      { step: 0.02, value: 0.6 }, // sub-step at 0.02*laneDur into the step
      { step: 1, value: 0.4 },
    ];
    const dp = stepRampPoints(dense, 0, 1.0, 100, 'linear', SEAM_GLIDE_S);
    const anchorTime = dp[0]!.at;
    const subTime = dp.find((p) => Math.abs(p.value - 0.6) < 1e-9)!.at;
    expect(anchorTime).toBeLessThan(subTime); // anchor before the sub-step point
  });
});

describe('quantizeStopStep — multiplayer-convergent stop position', () => {
  it('collapses peer-local playhead jitter onto the shared integer step grid', () => {
    // Two peers stop the same clip; their audible fractional playheads differ by
    // scheduler jitter (≪ half a step). Both resolve to the SAME integer step →
    // the same hold-last-value resting recompute.
    expect(quantizeStopStep(3.4, 8)).toBe(3);
    expect(quantizeStopStep(3.2, 8)).toBe(3);
    expect(quantizeStopStep(3.4, 8)).toBe(quantizeStopStep(3.2, 8));
  });
  it('rounds to nearest (not floor) and clamps to [0, len]', () => {
    expect(quantizeStopStep(3.6, 8)).toBe(4);
    expect(quantizeStopStep(7.9, 8)).toBe(8); // loop end
    expect(quantizeStopStep(9.3, 8)).toBe(8); // clamped
    expect(quantizeStopStep(0.2, 8)).toBe(0);
  });
  it('is defensive about invalid playheads (negative / NaN → step 0)', () => {
    expect(quantizeStopStep(-1, 8)).toBe(0);
    expect(quantizeStopStep(Number.NaN, 8)).toBe(0);
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

describe('QuantizedRecordWindow — continuous overdub (arm → punch-in → wrap every loop → manual stop)', () => {
  it('the owner workflow: arm, punch in at the clip’s own wrap, then EVERY wrap is a pass — no auto-stop', () => {
    const w = new QuantizedRecordWindow();
    // playing mid-loop, not armed yet
    expect(w.advance(3)).toBeNull();
    expect(w.advance(5)).toBeNull();
    w.arm();
    expect(w.state).toBe('armed');
    // still climbing — no punch-in until the loop wraps
    expect(w.advance(7)).toBeNull();
    // wrap (7 → 0): PUNCH IN (clean first pass)
    expect(w.advance(0)).toBe('punch-in');
    expect(w.state).toBe('recording');
    // one full loop of climbing
    expect(w.advance(2)).toBeNull();
    expect(w.advance(6)).toBeNull();
    // next wrap: a pass boundary — 'wrap', and recording CONTINUES (no 'done')
    expect(w.advance(0)).toBe('wrap');
    expect(w.state).toBe('recording');
    // and again — overdub keeps going every loop until disarm
    expect(w.advance(5)).toBeNull();
    expect(w.advance(0)).toBe('wrap');
    expect(w.state).toBe('recording');
  });

  it('disarm returns whether a pass was in flight, and resets to idle', () => {
    const w = new QuantizedRecordWindow();
    w.arm();
    w.advance(5);
    w.advance(0); // punch-in
    expect(w.state).toBe('recording');
    expect(w.disarm()).toBe(true); // was recording → caller commits the partial pass
    expect(w.state).toBe('idle');
    // disarm while merely armed (never punched in) → false (nothing to commit)
    w.arm();
    w.advance(4);
    expect(w.disarm()).toBe(false);
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

  it('CLIP-RELATIVE / polymetric: a coprime 7-step automation clip loops on its OWN period, drifting against a 16-step clip (never realigns to a bar)', () => {
    // Shared base-step timeline. The automation clip's OWN fractional-step
    // playhead is `baseStep mod 7`; a lockstep note clip would be `baseStep mod
    // 16`. The window keys off the automation clip's own playhead, so it wraps
    // every 7 base steps — NOT every 16, NOT at any shared "bar". This preserves
    // the intended generative desync (owner: the drift IS the feature).
    const AUTO_LEN = 7;
    const NOTE_LEN = 16;
    const w = new QuantizedRecordWindow();
    w.arm();
    const autoWraps: number[] = [];
    const noteWraps: number[] = [];
    let prevNote = -1;
    for (let base = 0; base <= 112; base++) {
      const autoStep = base % AUTO_LEN;
      const t = w.advance(autoStep);
      if (t === 'punch-in' || t === 'wrap') autoWraps.push(base);
      const noteStep = base % NOTE_LEN;
      if (prevNote >= 0 && noteStep < prevNote) noteWraps.push(base);
      prevNote = noteStep;
    }
    // Automation wraps land on ITS OWN 7-grid (7,14,21,…): every wrap ≡ 0 mod 7.
    expect(autoWraps.length).toBeGreaterThan(10);
    for (const b of autoWraps) expect(b % AUTO_LEN).toBe(0);
    // The note clip wraps on the 16-grid; they only ever coincide at LCM(7,16)=112
    // — i.e. the automation does NOT realign to the note clip's bar in between.
    const coincidences = autoWraps.filter((b) => noteWraps.includes(b));
    expect(coincidences).toEqual([112]);
  });
});
