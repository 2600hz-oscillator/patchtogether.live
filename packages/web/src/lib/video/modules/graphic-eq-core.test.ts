// packages/web/src/lib/video/modules/graphic-eq-core.test.ts
//
// Pure unit tests for the GRAPHIC EQ core — GL-free, deterministic.

import { describe, expect, it } from 'vitest';
import {
  BAND_COUNT,
  SEGMENTS,
  FFT_SIZE,
  F_MIN,
  F_MAX,
  styleFromParam,
  displayFromParam,
  bandBinRanges,
  foldBands,
  monoBands,
  quantizeSegments,
  columnsInRegion,
  layoutColumns,
  segmentRects,
  solidBarRects,
  colorAt,
  rotateHue,
  decayPeak,
} from './graphic-eq-core';

describe('style / display param mapping', () => {
  it('maps style param to bars / boxes', () => {
    expect(styleFromParam(0)).toBe('bars');
    expect(styleFromParam(0.4)).toBe('bars');
    expect(styleFromParam(1)).toBe('boxes');
    expect(styleFromParam(0.6)).toBe('boxes');
  });
  it('maps display param to mono / stereo', () => {
    expect(displayFromParam(0)).toBe('mono');
    expect(displayFromParam(1)).toBe('stereo');
  });
});

describe('bandBinRanges', () => {
  const SR = 48000;
  it('produces BAND_COUNT contiguous, log-widening ranges within the usable bins', () => {
    const r = bandBinRanges(SR, FFT_SIZE, BAND_COUNT, F_MIN, F_MAX);
    expect(r).toHaveLength(BAND_COUNT);
    const binCount = FFT_SIZE / 2;
    let prevWidth = 0;
    for (let b = 0; b < r.length; b++) {
      const [lo, hi] = r[b]!;
      expect(hi).toBeGreaterThan(lo); // each band has >= 1 bin
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(binCount);
      // Log spacing → each higher band spans at least as many bins as the last.
      const w = hi - lo;
      if (b > 0) expect(w).toBeGreaterThanOrEqual(prevWidth);
      prevWidth = w;
    }
  });
  it('starts near F_MIN and ends near F_MAX', () => {
    const r = bandBinRanges(SR, FFT_SIZE, BAND_COUNT, F_MIN, F_MAX);
    const binWidth = SR / FFT_SIZE;
    expect(r[0]![0] * binWidth).toBeLessThanOrEqual(F_MIN + binWidth);
    expect(r[BAND_COUNT - 1]![1] * binWidth).toBeGreaterThanOrEqual(F_MAX - binWidth * 2);
  });
});

describe('foldBands', () => {
  const SR = 48000;
  it('returns 0 for a silent spectrum', () => {
    const freq = new Uint8Array(FFT_SIZE / 2); // all zero
    const bands = foldBands(freq, { sampleRate: SR });
    expect(Array.from(bands)).toEqual(new Array(BAND_COUNT).fill(0));
  });
  it('returns 1 for a full spectrum', () => {
    const freq = new Uint8Array(FFT_SIZE / 2).fill(255);
    const bands = foldBands(freq, { sampleRate: SR });
    for (const v of bands) expect(v).toBeCloseTo(1, 5);
  });
  it('isolates energy to the band whose range covers the active bin', () => {
    const ranges = bandBinRanges(SR, FFT_SIZE, BAND_COUNT, F_MIN, F_MAX);
    const freq = new Uint8Array(FFT_SIZE / 2);
    // Light a single bin in the middle of band 5's range.
    const [lo, hi] = ranges[5]!;
    const mid = Math.floor((lo + hi) / 2);
    freq[mid] = 255;
    const bands = foldBands(freq, { sampleRate: SR, ranges });
    expect(bands[5]).toBeGreaterThan(0);
    // Bands whose range does not include `mid` stay 0.
    for (let b = 0; b < BAND_COUNT; b++) {
      const [bl, bh] = ranges[b]!;
      if (mid < bl || mid >= bh) expect(bands[b]).toBe(0);
    }
  });
  it('applies the gain multiplier and clamps to 1', () => {
    const freq = new Uint8Array(FFT_SIZE / 2).fill(64); // ~0.25 normalized
    const low = foldBands(freq, { sampleRate: SR, gain: 1 });
    const high = foldBands(freq, { sampleRate: SR, gain: 2 });
    expect(high[0]).toBeGreaterThan(low[0]!);
    const sat = foldBands(freq, { sampleRate: SR, gain: 100 });
    for (const v of sat) expect(v).toBe(1);
  });
});

describe('monoBands', () => {
  it('averages L and R per band', () => {
    const l = [0, 1, 0.5, 0.2];
    const r = [1, 0, 0.5, 0.8];
    const m = monoBands(l, r);
    expect(Array.from(m)).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
});

describe('quantizeSegments', () => {
  it('lights none at 0 and all at 1', () => {
    expect(quantizeSegments(0, SEGMENTS)).toBe(0);
    expect(quantizeSegments(1, SEGMENTS)).toBe(SEGMENTS);
  });
  it('rounds to the nearest rung', () => {
    expect(quantizeSegments(0.5, 16)).toBe(8);
    expect(quantizeSegments(0.49, 16)).toBe(8); // 7.84 → 8
    expect(quantizeSegments(0.03, 16)).toBe(0); // 0.48 → 0
    expect(quantizeSegments(0.1, 10)).toBe(1);
  });
  it('clamps out-of-range levels', () => {
    expect(quantizeSegments(-1, 16)).toBe(0);
    expect(quantizeSegments(5, 16)).toBe(16);
  });
});

describe('columnsInRegion', () => {
  it('lays N equal slots inside the region with inter-bar gaps', () => {
    const cols = columnsInRegion([0.1, 0.2, 0.3, 0.4], 0, 1, 'mono', 0.2);
    expect(cols).toHaveLength(4);
    // Slots are ordered left→right and stay inside [0,1].
    for (let i = 0; i < cols.length; i++) {
      expect(cols[i]!.x0).toBeGreaterThanOrEqual(0);
      expect(cols[i]!.x1).toBeLessThanOrEqual(1);
      expect(cols[i]!.x1).toBeGreaterThan(cols[i]!.x0);
      if (i > 0) expect(cols[i]!.x0).toBeGreaterThan(cols[i - 1]!.x1);
      expect(cols[i]!.level).toBeCloseTo([0.1, 0.2, 0.3, 0.4][i]!, 6);
      expect(cols[i]!.band).toBe(i);
    }
  });
});

describe('layoutColumns', () => {
  const L = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
  const R = new Float32Array([0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]);

  it('MONO: BAND_COUNT columns spanning the full width, fed by the L/R average', () => {
    const cols = layoutColumns(L, R, 'mono');
    expect(cols).toHaveLength(BAND_COUNT);
    expect(cols.every((c) => c.channel === 'mono')).toBe(true);
    // Whole [0,1] width is used.
    expect(Math.min(...cols.map((c) => c.x0))).toBeLessThan(0.05);
    expect(Math.max(...cols.map((c) => c.x1))).toBeGreaterThan(0.95);
    // Mono level = (L+R)/2 → all 0.45 here.
    for (const c of cols) expect(c.level).toBeCloseTo(0.45, 6);
  });

  it('STEREO: left channel on the LEFT half, right channel on the RIGHT half', () => {
    const cols = layoutColumns(L, R, 'stereo');
    expect(cols).toHaveLength(BAND_COUNT * 2);
    const leftCols = cols.filter((c) => c.channel === 'left');
    const rightCols = cols.filter((c) => c.channel === 'right');
    expect(leftCols).toHaveLength(BAND_COUNT);
    expect(rightCols).toHaveLength(BAND_COUNT);
    // Left channel meters live entirely in the left half (x < 0.5).
    for (const c of leftCols) expect(c.x1).toBeLessThanOrEqual(0.5);
    // Right channel meters live entirely in the right half (x > 0.5).
    for (const c of rightCols) expect(c.x0).toBeGreaterThanOrEqual(0.5);
    // Levels track their source channel (left-on-left / right-on-right).
    expect(leftCols[0]!.level).toBeCloseTo(0.1, 6);
    expect(rightCols[0]!.level).toBeCloseTo(0.8, 6);
  });
});

describe('segmentRects', () => {
  it('returns `segments` non-overlapping stacked rungs bottom→top', () => {
    const col = { x0: 0.1, x1: 0.2, level: 0.5, band: 0, channel: 'mono' as const };
    const { lit, rects } = segmentRects(col, 16);
    expect(rects).toHaveLength(16);
    expect(lit).toBe(8); // level 0.5 → 8 lit
    for (let i = 0; i < rects.length; i++) {
      expect(rects[i]!.y1).toBeGreaterThan(rects[i]!.y0);
      expect(rects[i]!.x0).toBe(col.x0);
      expect(rects[i]!.x1).toBe(col.x1);
      if (i > 0) expect(rects[i]!.y0).toBeGreaterThan(rects[i - 1]!.y1); // gap between rungs
    }
    expect(rects[0]!.y0).toBeGreaterThanOrEqual(0);
    expect(rects[15]!.y1).toBeLessThanOrEqual(1);
  });
});

describe('solidBarRects', () => {
  it('full-height track + a fill clamped to the level', () => {
    const col = { x0: 0.1, x1: 0.2, level: 0.3, band: 0, channel: 'mono' as const };
    const { track, fill } = solidBarRects(col);
    expect(track).toEqual({ x0: 0.1, y0: 0, x1: 0.2, y1: 1 });
    expect(fill.y1).toBeCloseTo(0.3, 6);
    expect(fill.y0).toBe(0);
  });
});

describe('colorAt', () => {
  it('green at the bottom, yellow in the middle, red at the top', () => {
    expect(colorAt(0)).toEqual([0, 1, 0]); // green
    const mid = colorAt(0.6);
    expect(mid[0]).toBeCloseTo(1, 5);
    expect(mid[1]).toBeCloseTo(1, 5); // yellow
    const top = colorAt(1);
    expect(top[0]).toBeCloseTo(1, 5);
    expect(top[1]).toBeCloseTo(0, 5); // red
  });
  it('hue rotation changes the colour', () => {
    const base = colorAt(0, 0);
    const rot = colorAt(0, 0.5); // 180°
    expect(rot).not.toEqual(base);
  });
});

describe('rotateHue', () => {
  it('is a no-op at 0° and 360°', () => {
    const c: [number, number, number] = [1, 0, 0];
    const a = rotateHue(c, 0);
    const b = rotateHue(c, 360);
    expect(a[0]).toBeCloseTo(b[0]!, 5);
    expect(a[1]).toBeCloseTo(b[1]!, 5);
    expect(a[2]).toBeCloseTo(b[2]!, 5);
  });
  it('keeps channels in [0,1]', () => {
    const r = rotateHue([1, 0.2, 0.7], 123);
    for (const v of r) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('decayPeak', () => {
  it('jumps up instantly to a higher level', () => {
    expect(decayPeak(0.2, 0.8, 0.9)).toBe(0.8);
  });
  it('decays toward a lower level by the decay factor', () => {
    expect(decayPeak(1, 0, 0.9)).toBeCloseTo(0.9, 6);
    expect(decayPeak(1, 0, 0.5)).toBeCloseTo(0.5, 6);
  });
  it('never falls below the live level', () => {
    expect(decayPeak(0.5, 0.4, 0.1)).toBe(0.4);
  });
  it('stays at 0 when silent', () => {
    expect(decayPeak(0, 0, 0.9)).toBe(0);
  });
});
