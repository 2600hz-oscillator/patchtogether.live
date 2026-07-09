// packages/web/src/lib/video/modules/mapper.test.ts
//
// MAPPER module-def shape + the pure keyer algorithm (no GL). The pure
// functions (mapperLuma / mapperMask / mapperPixel) are the EXACT CPU
// mirror of the GLSL shader's math — testing them here is the same source
// of truth EDGES / BACKDRAFT use for their shader logic. MAPPER generalises
// OUTLINES' `mapped` output: show the video input only where the key is
// active (key luma ≥ threshold), black elsewhere.

import { describe, it, expect } from 'vitest';
import {
  mapperDef,
  mapperLuma,
  mapperMask,
  mapperPixel,
  MAPPER_DEFAULTS,
  MAPPER_LUMA_WEIGHTS,
  MAPPER_EDGE,
} from './mapper';

describe('mapperDef shape', () => {
  it('threshold spans 0..1 (default 0.5)', () => {
    const t = mapperDef.params.find((p) => p.id === 'threshold');
    expect(t?.min).toBe(0);
    expect(t?.max).toBe(1);
    expect(t?.defaultValue).toBe(0.5);
    expect(t?.defaultValue).toBe(MAPPER_DEFAULTS.threshold);
  });

});

describe('mapperLuma — Rec. 601 luminance', () => {
  it('uses the documented weights (same as EDGES / LUMA / LUMAKEY)', () => {
    expect(MAPPER_LUMA_WEIGHTS).toEqual([0.299, 0.587, 0.114]);
  });
  it('black → 0, white → 1', () => {
    expect(mapperLuma(0, 0, 0)).toBe(0);
    expect(mapperLuma(1, 1, 1)).toBeCloseTo(1, 6);
  });
  it('weights green > red > blue', () => {
    expect(mapperLuma(0, 1, 0)).toBeGreaterThan(mapperLuma(1, 0, 0));
    expect(mapperLuma(1, 0, 0)).toBeGreaterThan(mapperLuma(0, 0, 1));
  });
});

describe('mapperMask — smoothstep key around the threshold', () => {
  it('a key luma WELL ABOVE threshold → mask 1 (crisp pass)', () => {
    // White key (luma 1) vs threshold 0.5: well above the soft band → 1.
    expect(mapperMask(1, 1, 1, 0.5)).toBeCloseTo(1, 6);
  });

  it('a key luma WELL BELOW threshold → mask 0 (matte out)', () => {
    // Black key (luma 0) vs threshold 0.5: well below the soft band → 0.
    expect(mapperMask(0, 0, 0, 0.5)).toBe(0);
  });

  it('a key luma EXACTLY at threshold → mask 0.5 (the soft midpoint)', () => {
    // smoothstep(t-EDGE, t+EDGE, t) == 0.5.
    expect(mapperMask(0.5, 0.5, 0.5, 0.5)).toBeCloseTo(0.5, 6);
  });

  it('the soft band is small (effectively crisp): EDGE is sub-pixel-small', () => {
    expect(MAPPER_EDGE).toBeLessThan(0.05);
    // Just inside the band on either side is monotone around 0.5.
    const justBelow = mapperMask(0.5 - MAPPER_EDGE * 0.5, 0.5 - MAPPER_EDGE * 0.5, 0.5 - MAPPER_EDGE * 0.5, 0.5);
    const justAbove = mapperMask(0.5 + MAPPER_EDGE * 0.5, 0.5 + MAPPER_EDGE * 0.5, 0.5 + MAPPER_EDGE * 0.5, 0.5);
    expect(justBelow).toBeLessThan(0.5);
    expect(justAbove).toBeGreaterThan(0.5);
  });

  it('mask is monotone non-decreasing in key luma', () => {
    let prev = -1;
    for (let l = 0; l <= 1.0001; l += 0.05) {
      const m = mapperMask(l, l, l, 0.5);
      expect(m).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = m;
    }
  });
});

// ---------------------------------------------------------------------------
// Full per-texel decision: a synthetic VIDEO + KEY → the output shows the
// video only where the key is active; the threshold raises/lowers the keyed
// area. (The headline spec assertions — the CPU mirror of OUTLINES.mapped
// generalised to an arbitrary key.)
// ---------------------------------------------------------------------------
describe('mapperPixel — video × key-mask on a synthetic source', () => {
  const VIDEO: [number, number, number] = [0.8, 0.4, 0.2]; // a distinctive RGB
  const KEY_ON: [number, number, number] = [1, 1, 1]; // bright key (luma 1)
  const KEY_OFF: [number, number, number] = [0, 0, 0]; // dark key (luma 0)

  it('key ACTIVE (luma ≥ threshold) → output shows the VIDEO', () => {
    const out = mapperPixel(VIDEO, KEY_ON, 0.5);
    // mask ≈ 1 → video passes through ~unchanged.
    expect(out[0]).toBeCloseTo(VIDEO[0], 5);
    expect(out[1]).toBeCloseTo(VIDEO[1], 5);
    expect(out[2]).toBeCloseTo(VIDEO[2], 5);
  });

  it('key INACTIVE (luma < threshold) → output is BLACK', () => {
    const out = mapperPixel(VIDEO, KEY_OFF, 0.5);
    expect(out).toEqual([0, 0, 0]);
  });

  it('a half-patched MAPPER (missing video OR key) → BLACK', () => {
    expect(mapperPixel(VIDEO, KEY_ON, 0.5, /*hasVideo*/ false, /*hasKey*/ true)).toEqual([0, 0, 0]);
    expect(mapperPixel(VIDEO, KEY_ON, 0.5, /*hasVideo*/ true, /*hasKey*/ false)).toEqual([0, 0, 0]);
  });

  it('THRESHOLD gates a MID-luma key: raising it past the key blacks the video out', () => {
    const midKey: [number, number, number] = [0.5, 0.5, 0.5]; // luma 0.5
    // A low threshold (well below the key luma) → key active → video shows.
    const low = mapperPixel(VIDEO, midKey, 0.2);
    expect(low[0]).toBeCloseTo(VIDEO[0], 5);
    // A high threshold (well above the key luma) → key inactive → black.
    const high = mapperPixel(VIDEO, midKey, 0.9);
    expect(high).toEqual([0, 0, 0]);
  });

  it('RAISING the threshold shrinks the keyed area (monotone over a key ramp)', () => {
    // A 1-D key luminance RAMP (0 → 1) against a constant white video. Count
    // the texels that show ANY video (mask > 0.5 ≈ "keyed") at low vs high
    // threshold. Higher threshold ⇒ fewer keyed texels.
    const WHITE: [number, number, number] = [1, 1, 1];
    const N = 64;
    const keyedCount = (threshold: number): number => {
      let n = 0;
      for (let i = 0; i < N; i++) {
        const l = i / (N - 1); // key luma 0..1
        const out = mapperPixel(WHITE, [l, l, l], threshold);
        if (out[0] > 0.5) n++; // showing (most of) the video
      }
      return n;
    };
    const low = keyedCount(0.25);
    const high = keyedCount(0.75);
    expect(low, 'low threshold keys a large area').toBeGreaterThan(0);
    expect(high, 'high threshold keys fewer texels').toBeLessThan(low);
  });

  it('LOWERING the threshold grows the keyed area', () => {
    const WHITE: [number, number, number] = [1, 1, 1];
    const N = 64;
    const keyedCount = (threshold: number): number => {
      let n = 0;
      for (let i = 0; i < N; i++) {
        const l = i / (N - 1);
        if (mapperPixel(WHITE, [l, l, l], threshold)[0] > 0.5) n++;
      }
      return n;
    };
    // Sweep downward — each lower threshold keys at least as many texels.
    const t90 = keyedCount(0.9);
    const t50 = keyedCount(0.5);
    const t10 = keyedCount(0.1);
    expect(t50).toBeGreaterThanOrEqual(t90);
    expect(t10).toBeGreaterThanOrEqual(t50);
    expect(t10).toBeGreaterThan(t90);
  });

  it('threshold is clamped to 0..1 (CV-safe)', () => {
    const midKey: [number, number, number] = [0.5, 0.5, 0.5];
    // Below 0 clamps to 0 (everything keyed); above 1 clamps to 1 (nothing).
    const belowZero = mapperPixel([1, 1, 1], midKey, -5);
    const aboveOne = mapperPixel([1, 1, 1], midKey, 5);
    expect(belowZero[0]).toBeCloseTo(1, 5); // key luma 0.5 ≥ 0 → full video
    expect(aboveOne).toEqual([0, 0, 0]);     // key luma 0.5 < 1 → black
  });
});
