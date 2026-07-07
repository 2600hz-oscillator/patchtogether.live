// packages/web/src/lib/video/modules/tempest.test.ts
//
// Pure unit tests for the TEMPEST renderer's GL-free geometry builder (P1).

import { describe, expect, it } from 'vitest';
import { buildTempestLines, shapeOf, CLAW_SEGMENTS, TEMPEST_STRIDE } from './tempest';
import { DEFAULT_LANES, TUBE_SHAPES } from '$lib/video/tempest/tempest-core';

// One stroke (rim/lane/claw segment) is expanded into a glow QUAD: 2 triangles =
// 6 vertices, each TEMPEST_STRIDE (6) floats [x, y, across, r, g, b].
const VERTS_PER_SEG = 6;
const SEGS = 3 * DEFAULT_LANES + CLAW_SEGMENTS; // rim+pit+radial per lane, + claw

describe('shapeOf', () => {
  it('maps the discrete param to a tube shape, clamped', () => {
    expect(shapeOf(0)).toBe('circle');
    expect(shapeOf(1)).toBe('square');
    expect(shapeOf(2)).toBe('star');
    expect(shapeOf(99)).toBe(TUBE_SHAPES[TUBE_SHAPES.length - 1]);
    expect(shapeOf(-5)).toBe('circle');
  });
});

describe('buildTempestLines', () => {
  it('emits a flat interleaved [x,y,across,r,g,b] TRIANGLE list (6 floats/vert, vert triples)', () => {
    const v = buildTempestLines(0, 0, 1);
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBeGreaterThan(0);
    expect(v.length % TEMPEST_STRIDE).toBe(0); // 6 floats per vertex
    const verts = v.length / TEMPEST_STRIDE;
    expect(verts % 3).toBe(0); // TRIANGLES = vertex triples
    // every stroke (rim+pit+radial per lane, + the claw) → one 6-vertex quad.
    expect(verts).toBe(SEGS * VERTS_PER_SEG);
  });

  it('keeps every position finite + inside the NDC box (aspect-fit margin)', () => {
    for (const aspect of [1, 16 / 9, 4 / 3, 0.75]) {
      const v = buildTempestLines(0.3, 0, aspect);
      for (let i = 0; i < v.length; i += TEMPEST_STRIDE) {
        expect(Number.isFinite(v[i]!) && Number.isFinite(v[i + 1]!)).toBe(true);
        expect(Math.abs(v[i]!)).toBeLessThanOrEqual(1);
        expect(Math.abs(v[i + 1]!)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('the `across` attribute spans the stroke width in [-1,+1]; colours stay in [0,1]', () => {
    const v = buildTempestLines(0.25, 0, 16 / 9);
    let sawMinus = false, sawPlus = false;
    for (let i = 0; i < v.length; i += TEMPEST_STRIDE) {
      const across = v[i + 2]!;
      expect(across).toBeGreaterThanOrEqual(-1);
      expect(across).toBeLessThanOrEqual(1);
      if (across <= -1 + 1e-6) sawMinus = true;
      if (across >= 1 - 1e-6) sawPlus = true;
      for (let c = 3; c < 6; c++) {
        expect(v[i + c]!).toBeGreaterThanOrEqual(0);
        expect(v[i + c]!).toBeLessThanOrEqual(1);
      }
    }
    expect(sawMinus && sawPlus).toBe(true); // both edges of the expanded quads present
  });

  it('aspect>1 compresses X (round tube), aspect<1 compresses Y', () => {
    const wide = buildTempestLines(0, 0, 2); // x scaled by 1/2
    const tall = buildTempestLines(0, 0, 0.5); // y scaled by 0.5
    const maxX = (a: Float32Array) => Math.max(...[...a].filter((_, i) => i % TEMPEST_STRIDE === 0).map(Math.abs));
    const maxY = (a: Float32Array) => Math.max(...[...a].filter((_, i) => i % TEMPEST_STRIDE === 1).map(Math.abs));
    expect(maxX(wide)).toBeLessThan(maxY(wide)); // X squeezed
    expect(maxY(tall)).toBeLessThan(maxX(tall)); // Y squeezed
  });

  it('the claw colour (bright yellow) appears at the selected lane, and moves with the rim param', () => {
    const clawPts = (v: Float32Array): Set<string> => {
      const claw = new Set<string>();
      for (let i = 0; i < v.length; i += TEMPEST_STRIDE) {
        // claw verts are the only hot-yellow ones (r≈1, g≈0.85, b≈0.1); tube blue
        // is r≈0.25 / pit r≈0.1, so r>0.9 isolates the claw.
        if (v[i + 3]! > 0.9 && Math.abs(v[i + 4]! - 0.85) < 1e-3 && Math.abs(v[i + 5]! - 0.1) < 1e-3) {
          claw.add(`${v[i]!.toFixed(4)},${v[i + 1]!.toFixed(4)}`);
        }
      }
      return claw;
    };
    const a = clawPts(buildTempestLines(0, 0, 1));
    const b = clawPts(buildTempestLines(0.5, 0, 1)); // half-way around the rim
    expect(a.size).toBeGreaterThan(0);
    expect(b.size).toBeGreaterThan(0);
    // CLAW_SEGMENTS strokes × 6 verts are present (some corner verts coincide, so
    // assert a healthy lower bound rather than the exact unique-point count).
    expect(a.size).toBeGreaterThanOrEqual(CLAW_SEGMENTS);
    // the claw is at a different rim location → different vertex positions
    const same = [...a].every((p) => b.has(p));
    expect(same).toBe(false);
  });
});
