// packages/web/src/lib/video/modules/edges.test.ts
//
// EDGES module-def shape + the pure Sobel/threshold/thickness algorithm
// (no GL). The pure functions (edgesLuma / edgesSobelMagnitude / edgesPixel)
// are the EXACT CPU mirror of the GLSL shader's math — testing them here is
// the same source of truth the BACKDRAFT module uses for its shader logic.

import { describe, it, expect } from 'vitest';
import {
  edgesDef,
  edgesLuma,
  edgesSobelMagnitude,
  edgesPixel,
  EDGES_DEFAULTS,
  EDGES_MAX_THICKNESS,
  EDGES_LUMA_WEIGHTS,
  EDGES_SOBEL_NORM,
} from './edges';

describe('edgesDef shape', () => {
  it('threshold spans 0..1 (default 0.2)', () => {
    const t = edgesDef.params.find((p) => p.id === 'threshold');
    expect(t?.min).toBe(0);
    expect(t?.max).toBe(1);
    expect(t?.defaultValue).toBe(0.2);
    expect(t?.defaultValue).toBe(EDGES_DEFAULTS.threshold);
  });

  it('thickness spans 1..EDGES_MAX_THICKNESS px (default 2)', () => {
    const w = edgesDef.params.find((p) => p.id === 'thickness');
    expect(w?.min).toBe(1);
    expect(w?.max).toBe(EDGES_MAX_THICKNESS);
    expect(w?.defaultValue).toBe(2);
    expect(w?.units).toBe('px');
    expect(w?.defaultValue).toBe(EDGES_DEFAULTS.thickness);
  });

});

describe('edgesLuma — Rec. 601 luminance', () => {
  it('uses the documented weights', () => {
    expect(EDGES_LUMA_WEIGHTS).toEqual([0.299, 0.587, 0.114]);
  });
  it('black → 0, white → 1', () => {
    expect(edgesLuma(0, 0, 0)).toBe(0);
    expect(edgesLuma(1, 1, 1)).toBeCloseTo(1, 6);
  });
  it('weights green > red > blue', () => {
    expect(edgesLuma(0, 1, 0)).toBeGreaterThan(edgesLuma(1, 0, 0));
    expect(edgesLuma(1, 0, 0)).toBeGreaterThan(edgesLuma(0, 0, 1));
  });
});

describe('edgesSobelMagnitude — normalised gradient', () => {
  it('flat field has ZERO gradient (no edge)', () => {
    const mag = edgesSobelMagnitude(() => 0.5);
    expect(mag).toBe(0);
  });

  it('a full black→white vertical step normalises to ~1.0', () => {
    // Left column black (dx=-1), right column white (dx=+1), centre at the
    // boundary. Gx of a unit step = +4 (raw); /EDGES_SOBEL_NORM → 1.0.
    const luma = (dx: number): number => (dx > 0 ? 1 : dx < 0 ? 0 : 0.5);
    const mag = edgesSobelMagnitude((dx) => luma(dx));
    expect(mag).toBeCloseTo(1.0, 6);
    expect(EDGES_SOBEL_NORM).toBe(4.0);
  });

  it('a half-contrast step has half the magnitude', () => {
    const full = edgesSobelMagnitude((dx) => (dx > 0 ? 1 : dx < 0 ? 0 : 0.5));
    const half = edgesSobelMagnitude((dx) => (dx > 0 ? 0.5 : dx < 0 ? 0 : 0.25));
    expect(half).toBeCloseTo(full / 2, 6);
  });

  it('detects a horizontal step (Gy) as strongly as a vertical step (Gx)', () => {
    const vert = edgesSobelMagnitude((dx) => (dx > 0 ? 1 : dx < 0 ? 0 : 0.5));
    const horiz = edgesSobelMagnitude((_dx, dy) => (dy > 0 ? 1 : dy < 0 ? 0 : 0.5));
    expect(horiz).toBeCloseTo(vert, 6);
  });
});

// ---------------------------------------------------------------------------
// Full per-texel decision: a synthetic input with a KNOWN edge → the output
// has the edge; THRESHOLD gates it; THICKNESS widens it. (The headline spec
// assertions.)
// ---------------------------------------------------------------------------
describe('edgesPixel — Sobel + threshold + thickness on a known edge', () => {
  // A 9×9 luma grid: left half black, right half white, with a vertical
  // black→white boundary between columns 3 and 4. Column 4 is the first
  // white column, so the strongest Sobel response sits at column 3/4.
  const W = 9;
  const H = 9;
  const grid: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      grid.push(x >= 4 ? 1 : 0);
    }
  }
  const BOUNDARY_X = 3; // the texel just left of the step (strong gradient)
  const FLAT_LEFT_X = 0; // deep in the black field (no gradient)
  const FLAT_RIGHT_X = 8; // deep in the white field (no gradient)
  const midY = 4;

  it('a synthetic input with a known edge → output is WHITE on the edge', () => {
    expect(
      edgesPixel(W, H, grid, BOUNDARY_X, midY, 0.2, 1),
      'the boundary texel is detected as an edge',
    ).toBe(1);
  });

  it('flat regions (no gradient) → output BLACK', () => {
    expect(edgesPixel(W, H, grid, FLAT_LEFT_X, midY, 0.2, 1)).toBe(0);
    expect(edgesPixel(W, H, grid, FLAT_RIGHT_X, midY, 0.2, 1)).toBe(0);
  });

  it('THRESHOLD gates the edge: a threshold above the edge magnitude blacks it out', () => {
    // The full-contrast vertical step normalises to ~1.0, so a threshold of
    // 0.2 passes it but a threshold of 1.5 (impossible for any real gradient)
    // gates it to black.
    expect(edgesPixel(W, H, grid, BOUNDARY_X, midY, 0.2, 1)).toBe(1);
    expect(
      edgesPixel(W, H, grid, BOUNDARY_X, midY, 1.5, 1),
      'threshold above the gradient magnitude → no edge',
    ).toBe(0);
  });

  it('THRESHOLD gates faint vs strong gradients', () => {
    // A HALF-contrast version of the same grid (step 0→0.5) → magnitude ~0.5.
    const faint = grid.map((v) => v * 0.5);
    // A low threshold passes the faint edge…
    expect(edgesPixel(W, H, faint, BOUNDARY_X, midY, 0.2, 1)).toBe(1);
    // …a threshold above its (halved) magnitude gates it.
    expect(edgesPixel(W, H, faint, BOUNDARY_X, midY, 0.8, 1)).toBe(0);
    // …while the full-contrast edge still passes at that higher threshold.
    expect(edgesPixel(W, H, grid, BOUNDARY_X, midY, 0.8, 1)).toBe(1);
  });

  it('raising THRESHOLD reduces the number of edge pixels (monotone)', () => {
    const countEdges = (threshold: number): number => {
      // Use the faint grid so there is a spread of gradient magnitudes to gate.
      const faint = grid.map((v) => v * 0.5);
      let n = 0;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
          n += edgesPixel(W, H, faint, x, y, threshold, 1);
      return n;
    };
    const low = countEdges(0.2);
    const high = countEdges(0.8);
    expect(low, 'low threshold detects edge pixels').toBeGreaterThan(0);
    expect(high, 'high threshold detects fewer (or equal)').toBeLessThanOrEqual(low);
    expect(high, 'high threshold gates the faint edge entirely').toBe(0);
  });

  it('THICKNESS widens the rendered edge (dilation)', () => {
    // At thickness=1 only the boundary column(s) are white; at thickness=3
    // the dilation paints neighbours up to 2 texels away white too. So a
    // column that is BLACK at thickness=1 but within 2px of the edge becomes
    // WHITE at thickness=3.
    const farFromEdge = 1; // 2 columns left of the boundary texel (x=3)
    const thin = edgesPixel(W, H, grid, farFromEdge, midY, 0.2, 1);
    const thick = edgesPixel(W, H, grid, farFromEdge, midY, 0.2, 3);
    expect(thin, 'thin: this texel is not on the edge').toBe(0);
    expect(thick, 'thick: dilation reaches this texel').toBe(1);
  });

  it('raising THICKNESS increases the number of edge pixels (monotone)', () => {
    const countEdges = (thickness: number): number => {
      let n = 0;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
          n += edgesPixel(W, H, grid, x, y, 0.2, thickness);
      return n;
    };
    const c1 = countEdges(1);
    const c3 = countEdges(3);
    const c5 = countEdges(5);
    expect(c1).toBeGreaterThan(0);
    expect(c3).toBeGreaterThan(c1);
    expect(c5).toBeGreaterThan(c3);
  });

  it('thickness is clamped to EDGES_MAX_THICKNESS (CV-safe)', () => {
    // A wildly out-of-range thickness must not throw / index out of bounds;
    // it dilates at most EDGES_MAX_THICKNESS px. The result at an absurd value
    // equals the result at the max.
    const atMax = edgesPixel(W, H, grid, 0, midY, 0.2, EDGES_MAX_THICKNESS);
    const beyond = edgesPixel(W, H, grid, 0, midY, 0.2, 9999);
    expect(beyond).toBe(atMax);
  });
});
