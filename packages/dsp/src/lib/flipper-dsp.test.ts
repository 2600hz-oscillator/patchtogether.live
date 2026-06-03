import { describe, it, expect } from 'vitest';
import { FlipperState, FLIPPER_THRESHOLD } from './flipper-dsp';

// Drive a gate sequence (per-sample [in1, in2]) and collect which output
// fired on each RISING edge.
function firesOn(seq: Array<[number, number]>): Array<'flip' | 'flop' | null> {
  const st = new FlipperState();
  const out: Array<'flip' | 'flop' | null> = [];
  let prevHigh = false;
  for (const [a, b] of seq) {
    const [f, g] = st.step(a, b);
    const high = Math.max(a, b) >= FLIPPER_THRESHOLD;
    if (high && !prevHigh) out.push(f > 0 ? 'flip' : g > 0 ? 'flop' : null);
    prevHigh = high;
  }
  return out;
}

// Helper: a gate pulse (high then low) on the chosen input.
function pulse(input: 1 | 2): Array<[number, number]> {
  return input === 1 ? [[1, 0], [0, 0]] : [[0, 1], [0, 0]];
}

describe('FlipperState', () => {
  it('alternates FLIP, FLOP, FLIP, FLOP on successive gates (input 1)', () => {
    const seq = [...pulse(1), ...pulse(1), ...pulse(1), ...pulse(1)];
    expect(firesOn(seq)).toEqual(['flip', 'flop', 'flip', 'flop']);
  });

  it('first gate fires FLIP', () => {
    expect(firesOn(pulse(1))).toEqual(['flip']);
  });

  it('a gate on EITHER input advances the same alternation', () => {
    const seq = [...pulse(1), ...pulse(2), ...pulse(1), ...pulse(2)];
    expect(firesOn(seq)).toEqual(['flip', 'flop', 'flip', 'flop']);
  });

  it('mirrors the gate to the selected output for its whole high duration', () => {
    const st = new FlipperState();
    expect(st.step(1, 0)).toEqual([1, 0]); // rising → FLIP
    expect(st.step(1, 0)).toEqual([1, 0]); // still high → still FLIP
    expect(st.step(1, 0)).toEqual([1, 0]);
    expect(st.step(0, 0)).toEqual([0, 0]); // low → silent
    expect(st.step(1, 0)).toEqual([0, 1]); // next gate → FLOP
    expect(st.step(0, 0)).toEqual([0, 0]);
  });

  it('does not re-trigger until the gate goes low first', () => {
    const st = new FlipperState();
    st.step(1, 0); // rising → FLIP armed
    st.step(1, 0); // held high, no new edge
    // the OTHER input going high while already high is NOT a new edge
    expect(st.step(1, 1)).toEqual([1, 0]); // stays FLIP
    expect(st.step(0, 0)).toEqual([0, 0]);
  });

  it('passes the gate amplitude through (not a fixed 1.0)', () => {
    const st = new FlipperState();
    expect(st.step(0.8, 0)).toEqual([0.8, 0]);
  });

  it('treats sub-threshold inputs as low (no trigger)', () => {
    const below = FLIPPER_THRESHOLD - 0.01;
    expect(firesOn([[below, 0], [0, 0], [below, below], [0, 0]])).toEqual([]);
  });

  it('reset() re-arms FLIP for the next gate', () => {
    const st = new FlipperState();
    st.step(1, 0); st.step(0, 0); // FLIP
    st.step(1, 0); st.step(0, 0); // FLOP
    st.reset();
    expect(st.step(1, 0)).toEqual([1, 0]); // FLIP again
  });
});
