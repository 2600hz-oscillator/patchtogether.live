// packages/web/src/lib/audio/modules/rasterize-map.test.ts
//
// Table-driven unit tests for the RASTERIZE raster-mapping math
// (rasterize-map.ts). Covers: sample → luminance, cursor normalisation,
// per-frame mapping (count + raster order), cursor advance + WRAP vs
// CLAMP, gain, and the scanlines-per-frame helper.

import { describe, it, expect } from 'vitest';
import {
  sampleToLuminance,
  normalizeCursor,
  mapRasterFrame,
  scanlinesPerFrame,
  wrapModeFromParam,
  type RasterFrameParams,
} from './rasterize-map';

describe('sampleToLuminance', () => {
  it.each([
    [-1, 0],
    [0, 128],
    [1, 255],
    [-0.5, 64],
    [0.5, 191],
  ])('maps %d → %d', (sample, expected) => {
    expect(sampleToLuminance(sample)).toBe(expected);
  });

  it('saturates (hard-clips) out-of-range values — no limiter', () => {
    expect(sampleToLuminance(-2)).toBe(0);
    expect(sampleToLuminance(5)).toBe(255);
    expect(sampleToLuminance(100)).toBe(255);
  });
});

describe('wrapModeFromParam', () => {
  it('maps the discrete 0/1 knob to wrap | clamp', () => {
    expect(wrapModeFromParam(0)).toBe('wrap');
    expect(wrapModeFromParam(0.4)).toBe('wrap');
    expect(wrapModeFromParam(0.5)).toBe('clamp');
    expect(wrapModeFromParam(1)).toBe('clamp');
  });
});

describe('normalizeCursor', () => {
  it.each([
    [0, 100, 0],
    [50, 100, 50],
    [100, 100, 0],
    [150, 100, 50],
    [-1, 100, 99],
    [-100, 100, 0],
    [-150, 100, 50],
    [12.9, 100, 12], // fractional floors before wrap
  ])('normalizeCursor(%d, %d) → %d', (cursor, total, expected) => {
    expect(normalizeCursor(cursor, total)).toBe(expected);
  });

  it('returns 0 for a degenerate (0-pixel) frame', () => {
    expect(normalizeCursor(7, 0)).toBe(0);
  });
});

describe('mapRasterFrame — basic raster order + count', () => {
  const base: Omit<RasterFrameParams, 'cursor'> = {
    width: 4,
    height: 4, // 16 pixels total
    samplesPerFrame: 4,
    gain: 1,
    wrap: 'wrap',
  };

  it('paints one pixel per sample in increasing raster index order', () => {
    const samples = [0, 0, 0, 0]; // all mid-grey (128)
    const { writes } = mapRasterFrame(samples, { ...base, cursor: 0 });
    expect(writes.map((w) => w.index)).toEqual([0, 1, 2, 3]);
    expect(writes.every((w) => w.luminance === 128)).toBe(true);
  });

  it('starts at the scan cursor offset', () => {
    const { writes } = mapRasterFrame([0, 0, 0, 0], { ...base, cursor: 5 });
    expect(writes.map((w) => w.index)).toEqual([5, 6, 7, 8]);
  });

  it('paints min(samples.length, samplesPerFrame) pixels', () => {
    // samplesPerFrame larger than the buffer → bounded by buffer length.
    const { writes } = mapRasterFrame([0.1, 0.2], { ...base, cursor: 0, samplesPerFrame: 10 });
    expect(writes).toHaveLength(2);
    // buffer larger than samplesPerFrame → bounded by samplesPerFrame.
    const { writes: w2 } = mapRasterFrame([0, 0, 0, 0, 0, 0], {
      ...base,
      cursor: 0,
      samplesPerFrame: 3,
    });
    expect(w2).toHaveLength(3);
  });
});

describe('mapRasterFrame — gain', () => {
  it('applies gain before the luminance map', () => {
    // sample 0.25 × gain 2 = 0.5 → luminance 191
    const { writes } = mapRasterFrame([0.25], {
      width: 4,
      height: 4,
      cursor: 0,
      samplesPerFrame: 1,
      gain: 2,
      wrap: 'wrap',
    });
    expect(writes[0]!.luminance).toBe(sampleToLuminance(0.5));
    expect(writes[0]!.luminance).toBe(191);
  });

  it('lets gain push past ±1 into saturation (untamed)', () => {
    const { writes } = mapRasterFrame([0.8, -0.8], {
      width: 4,
      height: 4,
      cursor: 0,
      samplesPerFrame: 2,
      gain: 4, // 0.8*4 = 3.2 → white; -3.2 → black
      wrap: 'wrap',
    });
    expect(writes[0]!.luminance).toBe(255);
    expect(writes[1]!.luminance).toBe(0);
  });
});

describe('mapRasterFrame — WRAP mode cursor advance', () => {
  const base: Omit<RasterFrameParams, 'cursor'> = {
    width: 4,
    height: 4, // 16 total
    samplesPerFrame: 6,
    gain: 1,
    wrap: 'wrap',
  };

  it('advances nextCursor by samplesPerFrame', () => {
    const { nextCursor } = mapRasterFrame(new Float32Array(6), { ...base, cursor: 0 });
    expect(nextCursor).toBe(6);
  });

  it('wraps the painted run toroidally when it passes the last pixel', () => {
    // total 16, cursor 13, 6 samples → indices 13,14,15, then wrap 0,1,2
    const { writes, nextCursor } = mapRasterFrame(new Float32Array(6), { ...base, cursor: 13 });
    expect(writes.map((w) => w.index)).toEqual([13, 14, 15, 0, 1, 2]);
    expect(nextCursor).toBe(3);
  });

  it('drifts smoothly across many frames (no reset to 0)', () => {
    let cursor = 0;
    const seen: number[] = [];
    for (let f = 0; f < 5; f++) {
      const r = mapRasterFrame(new Float32Array(6), { ...base, cursor });
      seen.push(cursor);
      cursor = r.nextCursor;
    }
    // 0,6,12,(18%16=2),(8) — drifts, wraps modulo, never hard-resets.
    expect(seen).toEqual([0, 6, 12, 2, 8]);
  });
});

describe('mapRasterFrame — CLAMP mode', () => {
  const base: Omit<RasterFrameParams, 'cursor'> = {
    width: 4,
    height: 4, // 16 total
    samplesPerFrame: 6,
    gain: 1,
    wrap: 'clamp',
  };

  it('truncates the run at the frame boundary (no toroidal continue)', () => {
    // cursor 13, 6 samples, clamp → only 13,14,15 painted; rest dropped.
    const { writes, nextCursor } = mapRasterFrame(new Float32Array(6), { ...base, cursor: 13 });
    expect(writes.map((w) => w.index)).toEqual([13, 14, 15]);
    // Next frame restarts at the top.
    expect(nextCursor).toBe(0);
  });

  it('advances linearly while inside the frame', () => {
    const { writes, nextCursor } = mapRasterFrame(new Float32Array(6), { ...base, cursor: 0 });
    expect(writes.map((w) => w.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(nextCursor).toBe(6);
  });
});

describe('mapRasterFrame — degenerate frames', () => {
  it('returns no writes for a 0-pixel frame', () => {
    const { writes, nextCursor } = mapRasterFrame([0.1, 0.2], {
      width: 0,
      height: 10,
      cursor: 0,
      samplesPerFrame: 2,
      gain: 1,
      wrap: 'wrap',
    });
    expect(writes).toEqual([]);
    expect(nextCursor).toBe(0);
  });

  it('handles an empty sample buffer', () => {
    const { writes, nextCursor } = mapRasterFrame([], {
      width: 4,
      height: 4,
      cursor: 0,
      samplesPerFrame: 6,
      gain: 1,
      wrap: 'wrap',
    });
    expect(writes).toEqual([]);
    expect(nextCursor).toBe(0);
  });
});

describe('scanlinesPerFrame', () => {
  it('reports ~1.25 scanlines/frame at the spec default (800 samp / 640 px)', () => {
    expect(scanlinesPerFrame(800, 640)).toBeCloseTo(1.25, 5);
  });
  it('is 0 for a 0-width frame', () => {
    expect(scanlinesPerFrame(800, 0)).toBe(0);
  });
});
