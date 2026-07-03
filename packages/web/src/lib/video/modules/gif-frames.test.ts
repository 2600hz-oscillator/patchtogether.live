// packages/web/src/lib/video/modules/gif-frames.test.ts
//
// Pure frame-scheduler tests (node). The browser decode path (ImageDecoder →
// VideoFrame → ImageBitmap) is covered by the picturebox-gif e2e; here we lock
// the deterministic "which frame at time t" math + its loop/edge behaviour.

import { describe, expect, it } from 'vitest';
import { frameIndexAtTime, totalDurationMs } from './gif-frames';

describe('gif-frames — totalDurationMs', () => {
  it('sums positive finite durations', () => {
    expect(totalDurationMs([100, 100, 50])).toBe(250);
  });
  it('ignores non-positive / non-finite durations', () => {
    expect(totalDurationMs([100, 0, -5, NaN, Infinity, 40])).toBe(140);
  });
  it('is 0 for an empty list', () => {
    expect(totalDurationMs([])).toBe(0);
  });
});

describe('gif-frames — frameIndexAtTime', () => {
  it('always returns 0 for 0 or 1 frames', () => {
    expect(frameIndexAtTime([], 0)).toBe(0);
    expect(frameIndexAtTime([], 999)).toBe(0);
    expect(frameIndexAtTime([100], 50)).toBe(0);
    expect(frameIndexAtTime([100], 100_000)).toBe(0);
  });

  it('maps time to the containing frame window (uniform 100ms frames)', () => {
    const d = [100, 100, 100]; // total 300
    expect(frameIndexAtTime(d, 0)).toBe(0);
    expect(frameIndexAtTime(d, 50)).toBe(0);
    expect(frameIndexAtTime(d, 99.9)).toBe(0);
    expect(frameIndexAtTime(d, 100)).toBe(1);
    expect(frameIndexAtTime(d, 150)).toBe(1);
    expect(frameIndexAtTime(d, 200)).toBe(2);
    expect(frameIndexAtTime(d, 299.9)).toBe(2);
  });

  it('loops modulo the total duration', () => {
    const d = [100, 100, 100]; // total 300
    expect(frameIndexAtTime(d, 300)).toBe(0);
    expect(frameIndexAtTime(d, 350)).toBe(0);
    expect(frameIndexAtTime(d, 450)).toBe(1);
    expect(frameIndexAtTime(d, 3000)).toBe(0); // exactly 10 loops
    expect(frameIndexAtTime(d, 3050)).toBe(0);
  });

  it('honours non-uniform frame delays', () => {
    const d = [40, 200, 40]; // total 280
    expect(frameIndexAtTime(d, 0)).toBe(0);
    expect(frameIndexAtTime(d, 39)).toBe(0);
    expect(frameIndexAtTime(d, 40)).toBe(1);
    expect(frameIndexAtTime(d, 239)).toBe(1);
    expect(frameIndexAtTime(d, 240)).toBe(2);
    expect(frameIndexAtTime(d, 280)).toBe(0); // wrap
  });

  it('skips zero-duration frames (never shows them)', () => {
    const d = [100, 0, 100]; // frame 1 is instantaneous → total 200
    expect(frameIndexAtTime(d, 0)).toBe(0);
    expect(frameIndexAtTime(d, 99)).toBe(0);
    expect(frameIndexAtTime(d, 100)).toBe(2); // frame 1 collapsed
    expect(frameIndexAtTime(d, 199)).toBe(2);
    expect(frameIndexAtTime(d, 200)).toBe(0);
  });

  it('returns 0 when every duration is non-positive (static, no divide-by-zero)', () => {
    expect(frameIndexAtTime([0, 0, 0], 500)).toBe(0);
    expect(frameIndexAtTime([-1, 0], 12)).toBe(0);
  });

  it('clamps negative / non-finite time to 0', () => {
    const d = [100, 100];
    expect(frameIndexAtTime(d, -50)).toBe(0);
    expect(frameIndexAtTime(d, NaN)).toBe(0);
    expect(frameIndexAtTime(d, Infinity)).toBe(0);
  });
});
