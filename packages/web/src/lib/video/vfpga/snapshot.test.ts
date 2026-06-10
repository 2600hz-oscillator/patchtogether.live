// packages/web/src/lib/video/vfpga/snapshot.test.ts
//
// Unit tests for the pure SMPTE-bars CPU snapshot (the card preview math, a
// 1:1 mirror of SMPTE_FRAG). Deterministic + GL-free.

import { describe, expect, it } from 'vitest';
import { smptePixel, renderSmpteSnapshot, SNAPSHOT_W, SNAPSHOT_H } from './snapshot';

const FULL = { shift: 0, brightness: 0.5, saturation: 1 };

describe('smptePixel', () => {
  it('renders the seven top bars at 75% amplitude, left→right', () => {
    const y = 0.3; // top band
    // Sample the centre of each of the 7 columns.
    const colour = (i: number) => smptePixel((i + 0.5) / 7, y, FULL);
    expect(colour(0)).toEqual([0.75, 0.75, 0.75]); // grey
    expect(colour(1)).toEqual([0.75, 0.75, 0.0]);  // yellow
    expect(colour(2)).toEqual([0.0, 0.75, 0.75]);  // cyan
    expect(colour(3)).toEqual([0.0, 0.75, 0.0]);   // green
    expect(colour(4)).toEqual([0.75, 0.0, 0.75]);  // magenta
    expect(colour(5)).toEqual([0.75, 0.0, 0.0]);   // red
    expect(colour(6)).toEqual([0.0, 0.0, 0.75]);   // blue
  });

  it('SHIFT cyclically rotates the top bars left', () => {
    const y = 0.3;
    // With shift=1, column 0 should show what column 1 showed (yellow).
    expect(smptePixel(0.5 / 7, y, { ...FULL, shift: 1 })).toEqual([0.75, 0.75, 0.0]);
    // shift=7 is a full cycle → back to grey.
    expect(smptePixel(0.5 / 7, y, { ...FULL, shift: 7 })).toEqual([0.75, 0.75, 0.75]);
  });

  it('SATURATION=0 collapses every bar to its Rec.601 luma (greyscale)', () => {
    const y = 0.3;
    const yellow = smptePixel(1.5 / 7, y, { ...FULL, saturation: 0 });
    // luma of 75% yellow = 0.75*(0.299+0.587) = 0.6645; all 3 channels equal.
    expect(yellow[0]).toBeCloseTo(yellow[1], 6);
    expect(yellow[1]).toBeCloseTo(yellow[2], 6);
    expect(yellow[0]).toBeCloseTo(0.75 * (0.299 + 0.587), 4);
  });

  it('BRIGHTNESS=1.0 scales 75% bars up to 100% amplitude', () => {
    const grey = smptePixel(0.5 / 7, 0.3, { ...FULL, brightness: 1.0 });
    expect(grey[0]).toBeCloseTo(1.0, 5);
  });

  it('the middle band shows the reverse castellation row', () => {
    const y = 0.71; // 0.67..0.75 mid band
    expect(smptePixel(0.5 / 7, y, FULL)).toEqual([0.0, 0.0, 0.75]); // blue
    expect(smptePixel(1.5 / 7, y, FULL)).toEqual([0.0, 0.0, 0.0]);  // black
  });

  it('the bottom band shows the PLUGE row (100% white column)', () => {
    const y = 0.85; // bottom band
    // The 2nd sixth is 100% white.
    expect(smptePixel(1.5 / 6, y, FULL)).toEqual([1.0, 1.0, 1.0]);
    // The 4th sixth is black.
    expect(smptePixel(3.5 / 6, y, FULL)).toEqual([0.0, 0.0, 0.0]);
  });

  it('every channel stays within [0,1]', () => {
    for (let i = 0; i < 50; i++) {
      const x = i / 49;
      for (const y of [0.2, 0.71, 0.9]) {
        const c = smptePixel(x, y, { shift: 3, brightness: 1, saturation: 0.5 });
        for (const ch of c) {
          expect(ch).toBeGreaterThanOrEqual(0);
          expect(ch).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('renderSmpteSnapshot', () => {
  it('produces a full-resolution RGBA buffer with opaque alpha', () => {
    const snap = renderSmpteSnapshot(FULL);
    expect(snap.width).toBe(SNAPSHOT_W);
    expect(snap.height).toBe(SNAPSHOT_H);
    expect(snap.data.length).toBe(SNAPSHOT_W * SNAPSHOT_H * 4);
    // alpha column is fully opaque.
    for (let p = 3; p < snap.data.length; p += 4) {
      expect(snap.data[p]).toBe(255);
    }
  });

  it('is deterministic (same args → identical bytes)', () => {
    const a = renderSmpteSnapshot(FULL);
    const b = renderSmpteSnapshot(FULL);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it('a top-left pixel is the grey bar (75% → 191)', () => {
    const snap = renderSmpteSnapshot(FULL);
    // pixel (5, 5) — within the grey column of the top band.
    const p = (5 * SNAPSHOT_W + 5) * 4;
    expect(snap.data[p]).toBe(Math.round(0.75 * 255)); // 191
  });
});
