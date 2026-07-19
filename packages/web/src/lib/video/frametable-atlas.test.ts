// packages/web/src/lib/video/frametable-atlas.test.ts
//
// FRAMETABLE — the `.frametable.png` sprite-sheet ATLAS layout math. Pure (no
// WebGL / no DOM), so it pins the ONE source of truth the SAVE tiler + LOAD
// detiler share. The certifications:
//   • chrono↔layer mapping is a clean bijection AND the SAVE(head)→LOAD(head:=0)
//     workflow round-trips (the wavetable-parser round-trip analogue);
//   • the 60 tiles PARTITION the atlas exactly (no gap / no overlap / no blank);
//   • the detile LAYOUT is the exact inverse of the encode LAYOUT over 0..59;
//   • the Y-flip convention (flipRowsY is an involution + the tileUvTransform
//     grid-row flip) makes a saved tile reload to the SAME pixels;
//   • atlasGeometry validates the fixed-grid divisibility (the load-error gate).

import { describe, it, expect } from 'vitest';
import { FRAMETABLE_RING_FRAMES, wrapIndex } from './frametable-core';
import {
  FRAMETABLE_ATLAS_COLS,
  FRAMETABLE_ATLAS_ROWS,
  FRAMETABLE_ATLAS_TILES,
  FRAMETABLE_FILE_EXT,
  tileColRow,
  tileRect,
  tileUvTransform,
  chronoToLayer,
  layerToChrono,
  atlasGeometry,
  atlasDimensions,
  flipRowsY,
  frametableFileName,
} from './frametable-atlas';

const N = FRAMETABLE_RING_FRAMES; // 60

describe('FRAMETABLE atlas — grid constants', () => {
  it('is a fixed 10×6 = 60 grid matching the ring depth', () => {
    expect(FRAMETABLE_ATLAS_COLS).toBe(10);
    expect(FRAMETABLE_ATLAS_ROWS).toBe(6);
    expect(FRAMETABLE_ATLAS_TILES).toBe(60);
    // The grid MUST hold exactly the ring — a mismatch would drop/duplicate frames.
    expect(FRAMETABLE_ATLAS_TILES).toBe(N);
  });
});

describe('FRAMETABLE atlas — tileColRow (chronological, row 0 = top)', () => {
  it('maps the corners + a mid tile', () => {
    expect(tileColRow(0)).toEqual({ col: 0, row: 0 });
    expect(tileColRow(9)).toEqual({ col: 9, row: 0 });
    expect(tileColRow(10)).toEqual({ col: 0, row: 1 });
    expect(tileColRow(59)).toEqual({ col: 9, row: 5 });
    expect(tileColRow(34)).toEqual({ col: 4, row: 3 });
  });

  it('is a bijection onto the 60 grid cells (every cell hit exactly once)', () => {
    const seen = new Set<string>();
    for (let c = 0; c < FRAMETABLE_ATLAS_TILES; c++) {
      const { col, row } = tileColRow(c);
      expect(col).toBeGreaterThanOrEqual(0);
      expect(col).toBeLessThan(FRAMETABLE_ATLAS_COLS);
      expect(row).toBeGreaterThanOrEqual(0);
      expect(row).toBeLessThan(FRAMETABLE_ATLAS_ROWS);
      seen.add(`${col},${row}`);
    }
    expect(seen.size).toBe(FRAMETABLE_ATLAS_TILES);
  });
});

describe('FRAMETABLE atlas — tileRect partitions the atlas exactly', () => {
  it('60 non-overlapping tiles fully cover a tileW×tileH atlas (no gap/overlap)', () => {
    const tileW = 32, tileH = 24; // arbitrary tile size
    const { width, height } = atlasDimensions(tileW, tileH);
    expect(width).toBe(FRAMETABLE_ATLAS_COLS * tileW);
    expect(height).toBe(FRAMETABLE_ATLAS_ROWS * tileH);

    // Paint a coverage grid at tile granularity; every cell covered exactly once.
    const cover = new Int32Array((width / tileW) * (height / tileH));
    for (let c = 0; c < FRAMETABLE_ATLAS_TILES; c++) {
      const { sx, sy, sw, sh } = tileRect(c, tileW, tileH);
      expect(sw).toBe(tileW);
      expect(sh).toBe(tileH);
      expect(sx + sw).toBeLessThanOrEqual(width);
      expect(sy + sh).toBeLessThanOrEqual(height);
      const cx = sx / tileW, cy = sy / tileH;
      cover[cy * (width / tileW) + cx]! += 1;
    }
    for (let i = 0; i < cover.length; i++) expect(cover[i], `cell ${i} covered once`).toBe(1);
  });
});

describe('FRAMETABLE atlas — chrono ↔ layer mapping', () => {
  it('chronoToLayer / layerToChrono are inverse bijections for any head', () => {
    for (const head of [0, 1, 17, 40, 59]) {
      const layers = new Set<number>();
      for (let c = 0; c < N; c++) {
        const layer = chronoToLayer(head, c, N);
        expect(layer).toBeGreaterThanOrEqual(0);
        expect(layer).toBeLessThan(N);
        expect(layerToChrono(head, layer, N)).toBe(c); // round-trips
        layers.add(layer);
      }
      expect(layers.size, `head=${head}: 60 distinct layers`).toBe(N);
    }
  });

  it('chrono 0 = the OLDEST layer (= head); chrono N-1 = the NEWEST (= head-1)', () => {
    for (const head of [0, 12, 59]) {
      expect(chronoToLayer(head, 0, N)).toBe(wrapIndex(head, N)); // oldest
      expect(chronoToLayer(head, N - 1, N)).toBe(wrapIndex(head - 1, N)); // newest completed
    }
  });

  it('the SAVE(head)→LOAD(head:=0) workflow round-trips: tile c ⇒ layer c ⇒ chrono c', () => {
    // SAVE reads chrono frame c from layer chronoToLayer(head, c); LOAD writes
    // tile c straight into ring layer c and sets head=0, so with head=0 the ring
    // layer c IS chronological frame c → the atlas ordering is preserved.
    for (const head of [0, 7, 33, 59]) {
      for (let c = 0; c < N; c++) {
        // The bytes read for atlas tile c came from layer L = chronoToLayer(head,c).
        const L = chronoToLayer(head, c, N);
        expect(layerToChrono(head, L, N)).toBe(c);
        // After load (head=0), that atlas tile c reoccupies chronological slot c.
        expect(chronoToLayer(0, c, N)).toBe(c);
        expect(layerToChrono(0, c, N)).toBe(c);
      }
    }
  });
});

describe('FRAMETABLE atlas — atlasGeometry (load-error gate)', () => {
  it('accepts dimensions that divide the fixed grid exactly', () => {
    const g = atlasGeometry(FRAMETABLE_ATLAS_COLS * 512, FRAMETABLE_ATLAS_ROWS * 384);
    expect(g.valid).toBe(true);
    expect(g.cols).toBe(10);
    expect(g.rows).toBe(6);
    expect(g.tileW).toBe(512);
    expect(g.tileH).toBe(384);
    expect(g.frames).toBe(60);
  });

  it('accepts a differently-sized (16:9) atlas (resolution mismatch is free on load)', () => {
    const g = atlasGeometry(FRAMETABLE_ATLAS_COLS * 683, FRAMETABLE_ATLAS_ROWS * 384);
    expect(g.valid).toBe(true);
    expect(g.tileW).toBe(683);
    expect(g.tileH).toBe(384);
  });

  it('rejects non-divisible / zero / non-finite dimensions', () => {
    expect(atlasGeometry(101, 60).valid).toBe(false); // 101 not divisible by 10
    expect(atlasGeometry(100, 61).valid).toBe(false); // 61 not divisible by 6
    expect(atlasGeometry(0, 0).valid).toBe(false);
    expect(atlasGeometry(-100, 60).valid).toBe(false);
    expect(atlasGeometry(Number.NaN, 60).valid).toBe(false);
  });
});

describe('FRAMETABLE atlas — Y-flip convention', () => {
  it('flipRowsY reverses row order and is an involution', () => {
    const w = 2, h = 3; // rows: [0,0, 1,1] etc. per row a distinct value
    const src = new Uint8Array([
      10, 10, 10, 255, 10, 10, 10, 255, // row 0
      20, 20, 20, 255, 20, 20, 20, 255, // row 1
      30, 30, 30, 255, 30, 30, 30, 255, // row 2
    ]);
    const f = flipRowsY(src, w, h);
    // stride = w*4 = 8: row0 @0, row1 @8, row2 @16. Flip: row0↔row2, row1 fixed.
    expect(f[0]).toBe(30); // row 0 ← old row 2
    expect(f[8]).toBe(20); // row 1 unchanged (middle)
    expect(f[16]).toBe(10); // row 2 ← old row 0
    // involution: flip twice = identity
    const back = flipRowsY(f, w, h);
    expect(Array.from(back)).toEqual(Array.from(src));
  });

  it('tileUvTransform folds the grid-row flip in (top atlas row → texture-v top)', () => {
    const t0 = tileUvTransform(0); // grid (0,0) top-left
    expect(t0.sx).toBeCloseTo(1 / 10, 12);
    expect(t0.sy).toBeCloseTo(1 / 6, 12);
    expect(t0.ox).toBeCloseTo(0, 12);
    // grid row 0 (top) with UNPACK_FLIP_Y=true → the TOP texture-v band.
    expect(t0.oy).toBeCloseTo((6 - 1 - 0) / 6, 12);
    const t59 = tileUvTransform(59); // grid (9,5) bottom-right
    expect(t59.ox).toBeCloseTo(9 / 10, 12);
    expect(t59.oy).toBeCloseTo((6 - 1 - 5) / 6, 12); // = 0, the BOTTOM texture-v band
    // every tile's UV window stays inside [0,1].
    for (let c = 0; c < FRAMETABLE_ATLAS_TILES; c++) {
      const t = tileUvTransform(c);
      expect(t.ox).toBeGreaterThanOrEqual(0);
      expect(t.ox + t.sx).toBeLessThanOrEqual(1 + 1e-9);
      expect(t.oy).toBeGreaterThanOrEqual(0);
      expect(t.oy + t.sy).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('detile LAYOUT is the exact inverse of the SAVE tiler over 0..59 (grid round-trip)', () => {
    // Build a synthetic atlas where each tile is filled with its chrono index,
    // placed at tileRect(c) (the SAVE layout). Then the detile transform for
    // tile c must sample back the SAME grid cell it was written to.
    const tileW = 4, tileH = 3;
    const { width, height } = atlasDimensions(tileW, tileH);
    // A cell-granularity atlas: value = chrono index at that grid cell.
    const atlasCell = new Int32Array(FRAMETABLE_ATLAS_COLS * FRAMETABLE_ATLAS_ROWS).fill(-1);
    for (let c = 0; c < FRAMETABLE_ATLAS_TILES; c++) {
      const { sx, sy } = tileRect(c, tileW, tileH);
      atlasCell[(sy / tileH) * FRAMETABLE_ATLAS_COLS + sx / tileW] = c;
    }
    // Detile: the UV transform picks the grid cell (ox*COLS, mapped-row). With
    // UNPACK_FLIP_Y the sampled grid-row is (ROWS-1 - oy*ROWS).
    for (let c = 0; c < FRAMETABLE_ATLAS_TILES; c++) {
      const t = tileUvTransform(c);
      const col = Math.round(t.ox * FRAMETABLE_ATLAS_COLS);
      const row = FRAMETABLE_ATLAS_ROWS - 1 - Math.round(t.oy * FRAMETABLE_ATLAS_ROWS);
      expect(atlasCell[row * FRAMETABLE_ATLAS_COLS + col], `tile ${c} round-trips its cell`).toBe(c);
    }
    void width; void height;
  });
});

describe('FRAMETABLE atlas — file name', () => {
  it('produces a stamped .frametable.png name', () => {
    const name = frametableFileName(new Date(Date.UTC(2026, 6, 19, 3, 5, 9)));
    expect(name.endsWith(FRAMETABLE_FILE_EXT)).toBe(true);
    expect(name.startsWith('frametable-')).toBe(true);
    // 8-digit date + '-' + 6-digit time (local — assert the shape, not the tz).
    expect(name).toMatch(/^frametable-\d{8}-\d{6}\.frametable\.png$/);
  });
});
