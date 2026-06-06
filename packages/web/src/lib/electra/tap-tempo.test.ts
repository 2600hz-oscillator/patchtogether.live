// packages/web/src/lib/electra/tap-tempo.test.ts
import { describe, it, expect } from 'vitest';
import {
  TapTempo,
  bpmFromTaps,
  clampBpm,
  median,
  TAP_MIN_BPM,
  TAP_MAX_BPM,
} from './tap-tempo';

describe('median', () => {
  it('odd length returns the middle', () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  it('even length averages the middle two', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it('empty is 0', () => {
    expect(median([])).toBe(0);
  });
});

describe('clampBpm', () => {
  it('clamps to range', () => {
    expect(clampBpm(5)).toBe(TAP_MIN_BPM);
    expect(clampBpm(1000)).toBe(TAP_MAX_BPM);
    expect(clampBpm(120)).toBe(120);
  });
  it('NaN → min', () => {
    expect(clampBpm(NaN)).toBe(TAP_MIN_BPM);
  });
});

describe('bpmFromTaps (pure)', () => {
  it('needs at least 2 taps', () => {
    expect(bpmFromTaps([])).toBeNull();
    expect(bpmFromTaps([0])).toBeNull();
  });

  it('120 BPM = 500ms interval', () => {
    // 60000 / 500 = 120
    expect(bpmFromTaps([0, 500])).toBeCloseTo(120, 5);
    expect(bpmFromTaps([0, 500, 1000, 1500])).toBeCloseTo(120, 5);
  });

  it('uses the median so one bad tap is rejected', () => {
    // intervals: 500, 500, 900 (one late tap) → median 500 → 120 BPM.
    const taps = [0, 500, 1000, 1900];
    expect(bpmFromTaps(taps)).toBeCloseTo(120, 5);
  });

  it('resets on a gap > resetMs (only the trailing run counts)', () => {
    // First three at 250ms (240 BPM), then a 5s gap, then two at 500ms.
    const taps = [0, 250, 500, 5500, 6000];
    // Only [5500, 6000] survives → 60000/500 = 120.
    expect(bpmFromTaps(taps, { resetMs: 2000 })).toBeCloseTo(120, 5);
  });

  it('clamps fast taps to max and slow taps to min', () => {
    // 50ms interval = 1200 BPM → clamped to 300.
    expect(bpmFromTaps([0, 50])).toBe(TAP_MAX_BPM);
    // 10s interval = 6 BPM → clamped to 10 (within resetMs via override).
    expect(bpmFromTaps([0, 10000], { resetMs: 20000 })).toBe(TAP_MIN_BPM);
  });
});

describe('TapTempo (stateful)', () => {
  it('accumulates taps and converges to a stable BPM', () => {
    const t = new TapTempo();
    expect(t.tap(0)).toBeNull(); // 1 tap
    expect(t.tap(500)).toBeCloseTo(120, 5); // 2 taps
    expect(t.tap(1000)).toBeCloseTo(120, 5);
    expect(t.tap(1500)).toBeCloseTo(120, 5);
    expect(t.count).toBe(4);
  });

  it('a long gap restarts the count', () => {
    const t = new TapTempo({ resetMs: 2000 });
    t.tap(0);
    t.tap(500); // 120 BPM
    const after = t.tap(10000); // 9.5s gap → restart, only 1 tap now
    expect(after).toBeNull();
    expect(t.count).toBe(1);
  });

  it('ring buffer caps history', () => {
    const t = new TapTempo({ history: 3 });
    t.tap(0);
    t.tap(500);
    t.tap(1000);
    t.tap(1500);
    expect(t.count).toBe(3); // capped
  });

  it('reset() clears the buffer', () => {
    const t = new TapTempo();
    t.tap(0);
    t.tap(500);
    t.reset();
    expect(t.count).toBe(0);
    expect(t.tap(0)).toBeNull();
  });
});
