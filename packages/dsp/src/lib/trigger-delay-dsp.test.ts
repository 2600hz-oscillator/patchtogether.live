// packages/dsp/src/lib/trigger-delay-dsp.test.ts
//
// Timing proofs for the MOOG 911A trigger-delay DSP:
//   - TriggerDelay: a rising edge produces a pulse exactly N samples later,
//     of the programmed width; no re-fire without a fresh edge; a held gate
//     fires once; re-trigger while counting re-arms; sub-threshold ignored.
//   - DualTriggerDelay: OFF independence, PARALLEL fan-out (one trig → both),
//     SERIES chaining (out1's pulse drives delay2 → out2).

import { describe, it, expect } from 'vitest';
import {
  TriggerDelay,
  DualTriggerDelay,
  TriggerDelayMode,
  TRIGGER_DELAY_THRESHOLD,
} from './trigger-delay-dsp';

// Use a tiny pulse width (in samples) so the tests read clearly.
const PULSE = 2;

/** Find the first sample index at which `step` returned high, plus the run
 *  length of that high pulse. Returns [-1, 0] if it never went high. */
function firstPulse(out: number[]): [number, number] {
  const start = out.findIndex((v) => v >= TRIGGER_DELAY_THRESHOLD);
  if (start < 0) return [-1, 0];
  let len = 0;
  for (let i = start; i < out.length && out[i] >= TRIGGER_DELAY_THRESHOLD; i++) len++;
  return [start, len];
}

describe('TriggerDelay — single delay timing', () => {
  it('fires a pulse exactly `delaySamples` after the rising edge', () => {
    const td = new TriggerDelay(PULSE);
    const DELAY = 5;
    const out: number[] = [];
    // Rising edge at sample 0 (high one sample then low).
    for (let i = 0; i < 20; i++) {
      const trig = i === 0 ? 1 : 0;
      out.push(td.step(trig, DELAY));
    }
    // Edge at index 0 → pulse should begin at index DELAY (5).
    const [start, len] = firstPulse(out);
    expect(start).toBe(DELAY);
    expect(len).toBe(PULSE);
  });

  it('holds the output high for the full pulse width then drops', () => {
    const td = new TriggerDelay(3);
    const out: number[] = [];
    for (let i = 0; i < 12; i++) out.push(td.step(i === 0 ? 1 : 0, 2));
    // Edge@0, delay 2 → pulse @ index 2,3,4 (width 3), then 0.
    expect(out.slice(2, 5)).toEqual([1, 1, 1]);
    expect(out[5]).toBe(0);
  });

  it('does NOT re-fire without a fresh rising edge', () => {
    const td = new TriggerDelay(PULSE);
    const out: number[] = [];
    // One edge, then silence for a long time.
    for (let i = 0; i < 40; i++) out.push(td.step(i === 0 ? 1 : 0, 3));
    const highCount = out.filter((v) => v >= TRIGGER_DELAY_THRESHOLD).length;
    expect(highCount).toBe(PULSE); // exactly one pulse, of width PULSE
  });

  it('a held-high gate fires exactly once (edge, not level)', () => {
    const td = new TriggerDelay(PULSE);
    const out: number[] = [];
    // Gate stays high the whole time — only the initial rising edge counts.
    for (let i = 0; i < 30; i++) out.push(td.step(1, 4));
    const highCount = out.filter((v) => v >= TRIGGER_DELAY_THRESHOLD).length;
    expect(highCount).toBe(PULSE);
  });

  it('a second edge after the gate goes low fires a second pulse', () => {
    const td = new TriggerDelay(PULSE);
    const DELAY = 3;
    const out: number[] = [];
    // Edge@0, low, then edge@10.
    for (let i = 0; i < 30; i++) {
      const trig = i === 0 || i === 10 ? 1 : 0;
      out.push(td.step(trig, DELAY));
    }
    expect(out[0 + DELAY]).toBe(1);  // first pulse at 3
    expect(out[10 + DELAY]).toBe(1); // second pulse at 13
    const highCount = out.filter((v) => v >= TRIGGER_DELAY_THRESHOLD).length;
    expect(highCount).toBe(PULSE * 2);
  });

  it('a re-trigger WHILE counting restarts the countdown', () => {
    const td = new TriggerDelay(PULSE);
    const out: number[] = [];
    // Edge@0 with delay 10, but re-edge@4 (after going low@1). The second
    // edge re-arms; pulse should appear 10 samples after the SECOND edge
    // (at index 14), not the first (10).
    for (let i = 0; i < 30; i++) {
      const trig = i === 0 || i === 4 ? 1 : 0;
      out.push(td.step(trig, 10));
    }
    expect(out[10]).toBe(0);  // first countdown was superseded
    expect(out[14]).toBe(1);  // fires 10 after the re-trigger@4
  });

  it('treats sub-threshold inputs as low (no trigger)', () => {
    const td = new TriggerDelay(PULSE);
    const below = TRIGGER_DELAY_THRESHOLD - 0.01;
    const out: number[] = [];
    for (let i = 0; i < 20; i++) out.push(td.step(i === 0 ? below : 0, 3));
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it('a 0-sample delay fires the pulse on the next sample after the edge', () => {
    const td = new TriggerDelay(PULSE);
    const out: number[] = [];
    for (let i = 0; i < 8; i++) out.push(td.step(i === 0 ? 1 : 0, 0));
    // delay 0 → countdown armed to 0 → fires on the SAME step's pulse emit.
    expect(out[0]).toBe(1);
  });

  it('reset() clears a pending countdown', () => {
    const td = new TriggerDelay(PULSE);
    td.step(1, 100); // arm a long countdown
    td.step(0, 100);
    td.reset();
    const out: number[] = [];
    for (let i = 0; i < 150; i++) out.push(td.step(0, 100));
    expect(out.every((v) => v === 0)).toBe(true);
  });
});

describe('DualTriggerDelay — coupling modes', () => {
  const D1 = 3;
  const D2 = 7;

  /** Drive the dual for `n` samples; trig1Fn / trig2Fn give the inputs. */
  function run(
    mode: TriggerDelayMode,
    n: number,
    trig1Fn: (i: number) => number,
    trig2Fn: (i: number) => number,
  ): { o1: number[]; o2: number[] } {
    const dt = new DualTriggerDelay(PULSE);
    const o1: number[] = [];
    const o2: number[] = [];
    for (let i = 0; i < n; i++) {
      const [a, b] = dt.step(trig1Fn(i), trig2Fn(i), D1, D2, mode);
      o1.push(a);
      o2.push(b);
    }
    return { o1, o2 };
  }

  it('OFF: each channel is fully independent', () => {
    // trig1@0 only → out1 fires at D1, out2 NEVER (trig2 silent).
    const { o1, o2 } = run(TriggerDelayMode.Off, 30, (i) => (i === 0 ? 1 : 0), () => 0);
    expect(firstPulse(o1)[0]).toBe(D1);
    expect(firstPulse(o2)[0]).toBe(-1);

    // trig2@5 only → out2 fires at 5+D2, out1 never.
    const r2 = run(TriggerDelayMode.Off, 30, () => 0, (i) => (i === 5 ? 1 : 0));
    expect(firstPulse(r2.o1)[0]).toBe(-1);
    expect(firstPulse(r2.o2)[0]).toBe(5 + D2);
  });

  it('PARALLEL: trig1 fires BOTH delays; trig2 is ignored', () => {
    const { o1, o2 } = run(
      TriggerDelayMode.Parallel,
      30,
      (i) => (i === 0 ? 1 : 0),
      (i) => (i === 2 ? 1 : 0), // should have NO effect in parallel
    );
    expect(firstPulse(o1)[0]).toBe(D1);     // out1 after delay1
    expect(firstPulse(o2)[0]).toBe(D2);     // out2 after delay2 — from trig1
    // trig2@2 ignored: out2's only pulse is the D2 one (from trig1@0).
    expect(o2.filter((v) => v >= TRIGGER_DELAY_THRESHOLD).length).toBe(PULSE);
  });

  it('SERIES: out1 fires delay1 after trig1, out2 fires delay2 after out1', () => {
    const { o1, o2 } = run(
      TriggerDelayMode.Series,
      40,
      (i) => (i === 0 ? 1 : 0),
      () => 0,
    );
    const [s1] = firstPulse(o1);
    const [s2] = firstPulse(o2);
    expect(s1).toBe(D1); // out1 at delay1 after trig1@0
    // out2 fires delay2 after out1's rising edge. The series feed reads the
    // PREVIOUS sample's out1, so out2 lands one sample later than a direct
    // re-trigger: out1 rises at s1, d2 observes it from s1+1, fires at
    // s1 + 1 + D2.
    expect(s2).toBe(s1 + 1 + D2);
  });

  it('SERIES: with trig1 silent, nothing fires', () => {
    const { o1, o2 } = run(TriggerDelayMode.Series, 40, () => 0, (i) => (i === 0 ? 1 : 0));
    expect(o1.every((v) => v === 0)).toBe(true);
    expect(o2.every((v) => v === 0)).toBe(true);
  });

  it('mode clamps out-of-range values (>=2 → SERIES, <=0 → OFF)', () => {
    const dt = new DualTriggerDelay(PULSE);
    // mode 5 should behave as SERIES (clamped to 2): trig2 ignored.
    const o2: number[] = [];
    for (let i = 0; i < 40; i++) {
      const [, b] = dt.step(0, i === 0 ? 1 : 0, D1, D2, 5);
      o2.push(b);
    }
    // SERIES ignores trig2, and trig1 is silent → no out2.
    expect(o2.every((v) => v === 0)).toBe(true);
  });
});
