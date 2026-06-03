import { describe, it, expect } from 'vitest';
import {
  Moog962Switch,
  moog962NextSelector,
  moog962ClampStages,
  MOOG962_THRESHOLD,
  MOOG962_MAX_STAGES,
  MOOG962_MIN_STAGES,
} from './moog962-dsp';

// Drive a SHIFT-gate sequence and collect which 0-based input index is
// selected on each sample (after that sample's edge handling).
function selectedOver(
  sw: Moog962Switch,
  inputs: ArrayLike<number>,
  shiftSeq: number[],
): number[] {
  // `inputs` here is a tag table: input[i] === i so the output sample
  // directly reveals the selected index.
  return shiftSeq.map((g) => sw.step(inputs, g));
}

// A SHIFT gate pulse (high then low).
const PULSE = [1, 0];

describe('moog962ClampStages', () => {
  it('clamps to the 2..3 range and rounds', () => {
    expect(moog962ClampStages(1)).toBe(MOOG962_MIN_STAGES);
    expect(moog962ClampStages(2)).toBe(2);
    expect(moog962ClampStages(3)).toBe(3);
    expect(moog962ClampStages(4)).toBe(MOOG962_MAX_STAGES);
    expect(moog962ClampStages(2.4)).toBe(2);
    expect(moog962ClampStages(2.6)).toBe(3);
  });

  it('defaults a non-finite value to MAX_STAGES', () => {
    expect(moog962ClampStages(NaN)).toBe(MOOG962_MAX_STAGES);
    expect(moog962ClampStages(Infinity)).toBe(MOOG962_MAX_STAGES);
  });
});

describe('moog962NextSelector', () => {
  it('cycles 0→1→2→0 for stages=3', () => {
    expect(moog962NextSelector(0, 3)).toBe(1);
    expect(moog962NextSelector(1, 3)).toBe(2);
    expect(moog962NextSelector(2, 3)).toBe(0);
  });

  it('cycles 0↔1 for stages=2', () => {
    expect(moog962NextSelector(0, 2)).toBe(1);
    expect(moog962NextSelector(1, 2)).toBe(0);
  });

  it('normalises an out-of-range or non-integer current index', () => {
    // index 2 is past the end for stages=2 → normalises to 0 then advances.
    expect(moog962NextSelector(2, 2)).toBe(1);
    expect(moog962NextSelector(1.4, 3)).toBe(2);
  });
});

describe('Moog962Switch (stages=3)', () => {
  const tag = [0, 1, 2]; // input[i] === i

  it('starts on input 1 (index 0)', () => {
    const sw = new Moog962Switch(3);
    expect(sw.selected()).toBe(0);
    expect(sw.step(tag, 0)).toBe(0); // no shift → input 1 passes
  });

  it('advances one position on each SHIFT rising edge, wrapping 3→1', () => {
    const sw = new Moog962Switch(3);
    const seq = [...PULSE, ...PULSE, ...PULSE, ...PULSE];
    // Each PULSE's first sample is the rising edge → advances THEN selects.
    // start idx0 → edge→1, low→1, edge→2, low→2, edge→0, low→0, edge→1, low→1
    expect(selectedOver(sw, tag, seq)).toEqual([1, 1, 2, 2, 0, 0, 1, 1]);
  });

  it('does NOT re-advance while SHIFT is held high (needs a low first)', () => {
    const sw = new Moog962Switch(3);
    expect(sw.step(tag, 1)).toBe(1); // rising → idx1
    expect(sw.step(tag, 1)).toBe(1); // held high → still idx1
    expect(sw.step(tag, 1)).toBe(1); // still held → still idx1
    expect(sw.step(tag, 0)).toBe(1); // low → still idx1
    expect(sw.step(tag, 1)).toBe(2); // new rising edge → idx2
  });

  it('treats a sub-threshold SHIFT as low (no advance)', () => {
    const sw = new Moog962Switch(3);
    const below = MOOG962_THRESHOLD - 0.01;
    expect(sw.step(tag, below)).toBe(0); // no edge
    expect(sw.step(tag, below)).toBe(0);
    expect(sw.selected()).toBe(0);
  });

  it('passes the SELECTED input through (others muted)', () => {
    const sw = new Moog962Switch(3);
    const sig = [0.11, 0.22, 0.33];
    expect(sw.step(sig, 0)).toBeCloseTo(0.11, 6); // idx0 → in1
    expect(sw.step(sig, 1)).toBeCloseTo(0.22, 6); // rising → idx1 → in2
    expect(sw.step(sig, 0)).toBeCloseTo(0.22, 6); // held selection
    expect(sw.step(sig, 1)).toBeCloseTo(0.33, 6); // rising → idx2 → in3
  });

  it('returns 0 for an unpatched (missing) selected input', () => {
    const sw = new Moog962Switch(3);
    const sig = [0.5]; // only in1 patched
    expect(sw.step(sig, 1)).toBe(0); // advanced to idx1 which is missing
  });
});

describe('Moog962Switch (stages=2)', () => {
  const tag = [0, 1, 2];

  it('only cycles between inputs 1 and 2 (in3 skipped)', () => {
    const sw = new Moog962Switch(2);
    const seq = [...PULSE, ...PULSE, ...PULSE];
    // idx0 → edge→1, low→1, edge→0, low→0, edge→1, low→1
    expect(selectedOver(sw, tag, seq)).toEqual([1, 1, 0, 0, 1, 1]);
  });
});

describe('Moog962Switch.setStages', () => {
  it('wraps a now-out-of-range selector back into range when stages shrinks', () => {
    const sw = new Moog962Switch(3);
    sw.step([0, 1, 2], 1); // → idx1
    sw.step([0, 1, 2], 0);
    sw.step([0, 1, 2], 1); // → idx2
    expect(sw.selected()).toBe(2);
    sw.setStages(2); // idx2 is now past the end → wraps to 0
    expect(sw.selected()).toBe(0);
  });

  it('leaves an in-range selector untouched when stages grows', () => {
    const sw = new Moog962Switch(2);
    sw.step([0, 1, 2], 1); // → idx1
    expect(sw.selected()).toBe(1);
    sw.setStages(3);
    expect(sw.selected()).toBe(1);
    // and now in3 becomes reachable.
    sw.step([0, 1, 2], 0);
    expect(sw.step([0, 1, 2], 1)).toBe(2); // idx1 → idx2 reachable
  });
});

describe('Moog962Switch.reset', () => {
  it('returns to input 1 and clears the edge detector', () => {
    const sw = new Moog962Switch(3);
    sw.step([0, 1, 2], 1);
    sw.step([0, 1, 2], 0);
    sw.step([0, 1, 2], 1); // → idx2
    expect(sw.selected()).toBe(2);
    sw.reset();
    expect(sw.selected()).toBe(0);
    // After reset a held-high gate is treated as a fresh rising edge.
    expect(sw.step([0, 1, 2], 1)).toBe(1);
  });
});
