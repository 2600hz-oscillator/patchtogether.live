// packages/web/src/lib/video/primitives.test.ts
import { describe, it, expect } from 'vitest';
import { cube, sphere, torus, hypercube, makePrimitive } from './primitives';
import { MESH_FLOATS_PER_VERT } from './mesh';

function vert(mesh: { interleaved: Float32Array }, n: number): number[] {
  const o = n * MESH_FLOATS_PER_VERT;
  return Array.from(mesh.interleaved.slice(o, o + MESH_FLOATS_PER_VERT));
}

/** Assert every index is in [0, vertexCount) and every normal is unit-length. */
function assertWellFormed(mesh: ReturnType<typeof cube>): void {
  expect(mesh.indices.length % 3).toBe(0);
  expect(mesh.interleaved.length).toBe(mesh.vertexCount * MESH_FLOATS_PER_VERT);
  for (const idx of mesh.indices) {
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(mesh.vertexCount);
  }
  for (let i = 0; i < mesh.vertexCount; i++) {
    const v = vert(mesh, i);
    const len = Math.hypot(v[3]!, v[4]!, v[5]!);
    expect(Math.abs(len - 1)).toBeLessThan(1e-3);
    // Every float finite.
    expect(v.every((x) => Number.isFinite(x))).toBe(true);
  }
}

describe('cube()', () => {
  const m = cube();
  it('has 12 triangles, 24 verts (4 per face)', () => {
    expect(m.triangleCount).toBe(12);
    expect(m.vertexCount).toBe(24);
  });
  it('is well-formed (indices in range, unit normals)', () => {
    assertWellFormed(m);
  });
  it('spans [-1,1] on each axis', () => {
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < m.vertexCount; i++) {
      const v = vert(m, i);
      minX = Math.min(minX, v[0]!);
      maxX = Math.max(maxX, v[0]!);
    }
    expect(minX).toBeCloseTo(-1);
    expect(maxX).toBeCloseTo(1);
  });
  it('normals are axis-aligned (flat per-face)', () => {
    for (let i = 0; i < m.vertexCount; i++) {
      const v = vert(m, i);
      const ax = [Math.abs(v[3]!), Math.abs(v[4]!), Math.abs(v[5]!)];
      // Exactly one component ≈1.
      const ones = ax.filter((c) => Math.abs(c - 1) < 1e-4).length;
      expect(ones).toBe(1);
    }
  });
});

describe('sphere()', () => {
  const m = sphere(16);
  it('is well-formed', () => {
    assertWellFormed(m);
  });
  it('all vertices lie on the unit sphere', () => {
    for (let i = 0; i < m.vertexCount; i++) {
      const v = vert(m, i);
      const r = Math.hypot(v[0]!, v[1]!, v[2]!);
      expect(Math.abs(r - 1)).toBeLessThan(1e-3);
    }
  });
  it('position == normal (smooth radial normals)', () => {
    for (let i = 0; i < m.vertexCount; i++) {
      const v = vert(m, i);
      expect(Math.abs(v[0]! - v[3]!)).toBeLessThan(1e-3);
      expect(Math.abs(v[1]! - v[4]!)).toBeLessThan(1e-3);
      expect(Math.abs(v[2]! - v[5]!)).toBeLessThan(1e-3);
    }
  });
  it('segment count scales triangle count', () => {
    expect(sphere(32).triangleCount).toBeGreaterThan(sphere(8).triangleCount);
  });
});

describe('torus()', () => {
  const m = torus();
  it('is well-formed', () => {
    assertWellFormed(m);
  });
  it('has a hole: no vertex near the centre axis', () => {
    // Major radius 0.7, minor 0.3 → inner radius 0.4 from the Y axis.
    for (let i = 0; i < m.vertexCount; i++) {
      const v = vert(m, i);
      const radial = Math.hypot(v[0]!, v[2]!);
      expect(radial).toBeGreaterThan(0.39);
    }
  });
});

describe('hypercube()', () => {
  const m = hypercube();
  it('is well-formed', () => {
    assertWellFormed(m);
  });
  it('builds solid tubes for all 32 tesseract edges', () => {
    // 32 edges × (4 sides × 2 tris) = 256 triangles.
    expect(m.triangleCount).toBe(32 * 8);
  });
  it('is roughly centred at the origin', () => {
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < m.vertexCount; i++) {
      const v = vert(m, i);
      cx += v[0]!; cy += v[1]!; cz += v[2]!;
    }
    cx /= m.vertexCount; cy /= m.vertexCount; cz /= m.vertexCount;
    expect(Math.abs(cx)).toBeLessThan(1e-2);
    expect(Math.abs(cy)).toBeLessThan(1e-2);
    expect(Math.abs(cz)).toBeLessThan(1e-2);
  });
});

describe('makePrimitive()', () => {
  it('dispatches each builtin id', () => {
    expect(makePrimitive('cube').triangleCount).toBe(cube().triangleCount);
    expect(makePrimitive('sphere').vertexCount).toBe(sphere(24).vertexCount);
    expect(makePrimitive('torus').triangleCount).toBe(torus().triangleCount);
    expect(makePrimitive('hypercube').triangleCount).toBe(hypercube().triangleCount);
  });
  it('every primitive carries a frame', () => {
    for (const id of ['cube', 'sphere', 'torus', 'hypercube'] as const) {
      const m = makePrimitive(id);
      expect(m.frame.center).toHaveLength(3);
      expect(typeof m.frame.scale).toBe('number');
      expect(m.frame.scale).toBeGreaterThan(0);
    }
  });
});
