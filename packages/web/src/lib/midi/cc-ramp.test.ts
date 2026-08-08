// packages/web/src/lib/midi/cc-ramp.test.ts
//
// The rasterizer's job is to make a scheduled ramp AUDIBLE on a wire that has
// no ramps. The negative control that matters is the STEP case: if the
// rasterizer silently degenerated to "emit only the endpoint", every test that
// merely checks "the target value arrived" would still pass while the sweep had
// become a jump. So the interpolation tests assert the INTERMEDIATE points
// exist and are monotonic, not just that the last one is right.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RAMP_RATE_HZ,
  quantize14,
  quantize7,
  rasterizeCcRamp,
} from './cc-ramp';

describe('rasterizeCcRamp — the endpoint always lands', () => {
  it('a zero-delta ramp is a single point at the target time', () => {
    expect(rasterizeCcRamp({ from: 64, to: 64, fromTimeS: 0, toTimeS: 1 })).toEqual([
      { value: 64, atS: 1 },
    ]);
  });

  it('a zero-duration ramp is a single point (an immediate jump)', () => {
    expect(rasterizeCcRamp({ from: 0, to: 100, fromTimeS: 5, toTimeS: 5 })).toEqual([
      { value: 100, atS: 5 },
    ]);
  });

  it('a ramp scheduled in the PAST does not run backwards in time', () => {
    const pts = rasterizeCcRamp({ from: 0, to: 100, fromTimeS: 10, toTimeS: 9 });
    expect(pts).toEqual([{ value: 100, atS: 9 }]);
  });

  it('the final point is EXACTLY the target, never one step short', () => {
    // 0 → 127 over a window whose rate bound does not divide the range evenly.
    const pts = rasterizeCcRamp({ from: 0, to: 127, fromTimeS: 0, toTimeS: 0.35 });
    expect(pts.at(-1)).toEqual({ value: 127, atS: 0.35 });
  });
});

describe('rasterizeCcRamp — it really interpolates (the anti-step control)', () => {
  it('a slow full sweep emits one message per distinct 7-bit value', () => {
    const pts = rasterizeCcRamp({ from: 0, to: 127, fromTimeS: 0, toTimeS: 10 });
    // Resolution-bound: 127 steps, not 10 s × 120 Hz.
    expect(pts).toHaveLength(127);
    expect(pts[0]!.value).toBe(1);
    expect(pts.at(-1)!.value).toBe(127);
  });

  it('values are strictly monotonic with no duplicates (nothing for the suppressor to remove)', () => {
    const pts = rasterizeCcRamp({ from: 20, to: 90, fromTimeS: 0, toTimeS: 2 });
    const values = pts.map((p) => p.value);
    expect(values.length, 'a real train, not a single step').toBeGreaterThan(10);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!, `point ${i} advances`).toBeGreaterThan(values[i - 1]!);
    }
  });

  it('descends correctly too', () => {
    const pts = rasterizeCcRamp({ from: 100, to: 40, fromTimeS: 0, toTimeS: 2 });
    const values = pts.map((p) => p.value);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]!).toBeLessThan(values[i - 1]!);
    }
    expect(values.at(-1)).toBe(40);
  });

  it('times strictly increase and stay inside the window', () => {
    const pts = rasterizeCcRamp({ from: 0, to: 60, fromTimeS: 3, toTimeS: 4 });
    for (let i = 0; i < pts.length; i++) {
      expect(pts[i]!.atS).toBeGreaterThan(3);
      expect(pts[i]!.atS).toBeLessThanOrEqual(4);
      if (i > 0) expect(pts[i]!.atS).toBeGreaterThan(pts[i - 1]!.atS);
    }
  });
});

describe('rasterizeCcRamp — bandwidth ceiling', () => {
  it('a fast full sweep is RATE-bound, not resolution-bound', () => {
    // 127 units in 100 ms would want 1270 CC/s — above the whole DIN budget.
    const pts = rasterizeCcRamp({ from: 0, to: 127, fromTimeS: 0, toTimeS: 0.1 });
    expect(pts.length).toBeLessThanOrEqual(Math.floor(0.1 * DEFAULT_RAMP_RATE_HZ));
    // …and it still lands exactly.
    expect(pts.at(-1)!.value).toBe(127);
  });

  it('the effective message rate never exceeds the ceiling', () => {
    const toTimeS = 0.5;
    const pts = rasterizeCcRamp({ from: 0, to: 127, fromTimeS: 0, toTimeS });
    expect(pts.length / toTimeS).toBeLessThanOrEqual(DEFAULT_RAMP_RATE_HZ + 1);
  });

  it('a custom ceiling is honoured', () => {
    const pts = rasterizeCcRamp({ from: 0, to: 127, fromTimeS: 0, toTimeS: 1, maxRateHz: 10 });
    expect(pts.length).toBeLessThanOrEqual(10);
    expect(pts.at(-1)!.value).toBe(127);
  });

  it('a tiny move is RESOLUTION-bound even in a long window', () => {
    // 3 units over 10 s: 3 messages, not 1200.
    const pts = rasterizeCcRamp({ from: 10, to: 13, fromTimeS: 0, toTimeS: 10 });
    expect(pts.map((p) => p.value)).toEqual([11, 12, 13]);
  });
});

describe('quantizers', () => {
  it('quantize7 clamps to 0..127 and rounds', () => {
    expect(quantize7(-3)).toBe(0);
    expect(quantize7(200)).toBe(127);
    expect(quantize7(63.5)).toBe(64);
    expect(quantize7(Number.NaN)).toBe(0);
  });

  it('quantize14 clamps to 0..16383', () => {
    expect(quantize14(-1)).toBe(0);
    expect(quantize14(99999)).toBe(16383);
  });

  it('a 14-bit ramp gets far more steps than the same 7-bit move', () => {
    const window = { fromTimeS: 0, toTimeS: 10, maxRateHz: 10_000 };
    const coarse = rasterizeCcRamp({ from: 0, to: 127, ...window });
    const fine = rasterizeCcRamp({ from: 0, to: 16383, quantize: quantize14, ...window });
    expect(fine.length).toBeGreaterThan(coarse.length * 10);
    expect(fine.at(-1)!.value).toBe(16383);
  });
});
