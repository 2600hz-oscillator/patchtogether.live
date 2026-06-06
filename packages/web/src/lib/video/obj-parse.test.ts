// packages/web/src/lib/video/obj-parse.test.ts
import { describe, it, expect } from 'vitest';
import { parseObj } from './obj-parse';
import { MESH_FLOATS_PER_VERT } from './mesh';

/** Pull vertex N's [px,py,pz, nx,ny,nz, u,v] out of the interleaved buffer. */
function vert(mesh: { interleaved: Float32Array }, n: number): number[] {
  const o = n * MESH_FLOATS_PER_VERT;
  return Array.from(mesh.interleaved.slice(o, o + MESH_FLOATS_PER_VERT));
}

function close(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) <= eps;
}

describe('parseObj — 2-triangle quad (pos/uv/normal)', () => {
  // A flat unit quad in the XY plane, two triangles, full p/t/n tokens.
  const QUAD = `
# a quad
o quad
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 0 1
f 1/1/1 2/2/1 3/3/1
f 1/1/1 3/3/1 4/4/1
`;
  const mesh = parseObj(QUAD);

  it('produces 2 triangles / 6 indices', () => {
    expect(mesh.triangleCount).toBe(2);
    expect(mesh.indices.length).toBe(6);
  });

  it('dedups shared corners → 4 unique vertices', () => {
    // verts 1 and 3 are shared between the two tris → 4 unique, not 6.
    expect(mesh.vertexCount).toBe(4);
  });

  it('carries the explicit normal +Z on every vertex', () => {
    for (let i = 0; i < mesh.vertexCount; i++) {
      const v = vert(mesh, i);
      expect(close(v[3]!, 0)).toBe(true);
      expect(close(v[4]!, 0)).toBe(true);
      expect(close(v[5]!, 1)).toBe(true);
    }
  });

  it('carries UVs', () => {
    // First indexed vertex (corner 1/1) has uv (0,0).
    const v0 = vert(mesh, mesh.indices[0]!);
    expect(close(v0[6]!, 0)).toBe(true);
    expect(close(v0[7]!, 0)).toBe(true);
  });

  it('reports correct bounds + a centred, unit-scaled frame', () => {
    expect(mesh.bounds.min).toEqual([0, 0, 0]);
    expect(mesh.bounds.max).toEqual([1, 1, 0]);
    expect(mesh.frame.center).toEqual([0.5, 0.5, 0]);
    // longest extent = 1 → scale = 2.
    expect(close(mesh.frame.scale, 2)).toBe(true);
  });
});

describe('parseObj — fan triangulation of an n-gon', () => {
  // A pentagon face → fan-triangulated into 3 triangles.
  const PENT = `
v 0 0 0
v 1 0 0
v 1.5 1 0
v 0.5 1.6 0
v -0.5 1 0
vn 0 0 1
f 1//1 2//1 3//1 4//1 5//1
`;
  const mesh = parseObj(PENT);

  it('fan-triangulates a 5-gon into 3 triangles', () => {
    expect(mesh.triangleCount).toBe(3);
    expect(mesh.indices.length).toBe(9);
  });

  it('every triangle of the fan shares vertex 0', () => {
    // The first index of each triangle in a fan is corner 0.
    const i = mesh.indices;
    expect(i[0]).toBe(i[3]);
    expect(i[3]).toBe(i[6]);
  });

  it('uses 5 unique vertices', () => {
    expect(mesh.vertexCount).toBe(5);
  });
});

describe('parseObj — normal-less cube (computed flat normals + winding)', () => {
  // Unit cube [0,1]^3 with NO vn lines and NO vt. Triangulated faces, CCW
  // outward winding. Exercises the flat-normal computation path.
  const CUBE = `
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
v 0 0 1
v 1 0 1
v 1 1 1
v 0 1 1
# -Z face (outward normal -Z): CCW seen from -Z
f 1 4 3
f 1 3 2
# +Z face (outward +Z)
f 5 6 7
f 5 7 8
# -Y face (outward -Y)
f 1 2 6
f 1 6 5
# +Y face (outward +Y)
f 4 8 7
f 4 7 3
# -X face (outward -X)
f 1 5 8
f 1 8 4
# +X face (outward +X)
f 2 3 7
f 2 7 6
`;
  const mesh = parseObj(CUBE);

  it('produces 12 triangles (6 quads → 2 tris each)', () => {
    expect(mesh.triangleCount).toBe(12);
  });

  it('computes a flat normal for every vertex (none left at zero length)', () => {
    for (let i = 0; i < mesh.vertexCount; i++) {
      const v = vert(mesh, i);
      const len = Math.hypot(v[3]!, v[4]!, v[5]!);
      expect(close(len, 1)).toBe(true);
    }
  });

  it('the +Z face vertices got outward +Z normal (correct winding)', () => {
    // Find a vertex at z=1 — its computed flat normal should be (0,0,+1)
    // for the +Z face (CCW seen from outside → cross product points +Z).
    let found = false;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const v = vert(mesh, i);
      if (close(v[2]!, 1) && close(v[5]!, 1) && close(v[3]!, 0) && close(v[4]!, 0)) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('the -Z face got outward -Z normal', () => {
    let found = false;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const v = vert(mesh, i);
      if (close(v[2]!, 0) && close(v[5]!, -1) && close(v[3]!, 0) && close(v[4]!, 0)) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('does NOT dedup across faces (per-face flat normals differ)', () => {
    // Corner (1,1,1) appears on the +Z, +Y and +X faces with 3 different flat
    // normals → 3 distinct emitted vertices for that position.
    let countAt111 = 0;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const v = vert(mesh, i);
      if (close(v[0]!, 1) && close(v[1]!, 1) && close(v[2]!, 1)) countAt111++;
    }
    expect(countAt111).toBeGreaterThanOrEqual(3);
  });

  it('frame centres the cube at (0.5,0.5,0.5)', () => {
    expect(mesh.frame.center.map((c) => Number(c.toFixed(3)))).toEqual([0.5, 0.5, 0.5]);
    expect(close(mesh.frame.scale, 2)).toBe(true); // extent 1 → scale 2
  });
});

describe('parseObj — quad faces (pos/uv only, no normals)', () => {
  // Mimics Spot's control mesh: quad faces, p/t tokens, no vn lines.
  const QUADMESH = `
v 0 0 0
v 2 0 0
v 2 2 0
v 0 2 0
vt 0 0
vt 1 0
vt 1 1
vt 0 1
f 1/1 2/2 3/3 4/4
`;
  const mesh = parseObj(QUADMESH);

  it('fan-triangulates a quad into 2 triangles', () => {
    expect(mesh.triangleCount).toBe(2);
  });
  it('computes flat normals (perpendicular to the XY plane)', () => {
    for (let i = 0; i < mesh.vertexCount; i++) {
      const v = vert(mesh, i);
      expect(close(Math.abs(v[5]!), 1)).toBe(true);
    }
  });
  it('keeps the UVs from the p/t tokens', () => {
    const v = vert(mesh, mesh.indices[1]!); // second corner → vt 2 = (1,0)
    expect(close(v[6]!, 1)).toBe(true);
    expect(close(v[7]!, 0)).toBe(true);
  });
});

describe('parseObj — UV round-trip (distinct per-corner vt)', () => {
  // A unit quad whose four corners carry the four distinct uv corners. Proves
  // each unique (u,v) lands on the right interleaved vertex via MESH_OFFSET_UV
  // (floats [6],[7]).
  const QUAD = `
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 0 1
f 1/1/1 2/2/1 3/3/1 4/4/1
`;
  const mesh = parseObj(QUAD);

  it('maps each distinct corner uv to the vertex at that position', () => {
    // For each of the 4 unique vertices, the uv must equal the position's xy
    // (this quad was authored so vt == position.xy).
    for (let i = 0; i < mesh.vertexCount; i++) {
      const v = vert(mesh, i);
      expect(close(v[6]!, v[0]!)).toBe(true); // u == px
      expect(close(v[7]!, v[1]!)).toBe(true); // v == py
    }
  });
});

describe('parseObj — planar-UV fallback for zero-vt models', () => {
  // A unit quad in XY with NO `vt` lines. Before the fallback every vertex got
  // uv (0,0); the fallback synthesizes a planar XY projection over the bounds.
  // bounds: x∈[0,2], y∈[0,2]. Emitted v is top-origin (1 - rawV) so the surface
  // shader's 1.0 - v flip lands it upright.
  const NOVT = `
v 0 0 0
v 2 0 0
v 2 2 0
v 0 2 0
vn 0 0 1
f 1//1 2//1 3//1 4//1
`;
  const mesh = parseObj(NOVT);

  it('no longer collapses every uv to (0,0)', () => {
    let distinct = new Set<string>();
    for (let i = 0; i < mesh.vertexCount; i++) {
      const v = vert(mesh, i);
      distinct.add(`${v[6]!.toFixed(3)},${v[7]!.toFixed(3)}`);
    }
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('min-XY corner → u 0 (and max-XY corner → u 1) over the bounds', () => {
    // The vertex at (0,0) maps to u=0; the vertex at (2,2) maps to u=1.
    const at = (px: number, py: number) => {
      for (let i = 0; i < mesh.vertexCount; i++) {
        const v = vert(mesh, i);
        if (close(v[0]!, px) && close(v[1]!, py)) return v;
      }
      return null;
    };
    const minV = at(0, 0)!;
    const maxV = at(2, 2)!;
    expect(minV).not.toBeNull();
    expect(maxV).not.toBeNull();
    expect(close(minV[6]!, 0)).toBe(true); // u at min-x = 0
    expect(close(maxV[6]!, 1)).toBe(true); // u at max-x = 1
    // v is top-origin: min-y → v 1, max-y → v 0 (so the shader flip lands upright).
    expect(close(minV[7]!, 1)).toBe(true);
    expect(close(maxV[7]!, 0)).toBe(true);
  });
});

describe('parseObj — models WITH vt are NOT touched by the fallback', () => {
  // Authored uv that is NOT a planar projection of position — proves the
  // fallback does not overwrite real vt.
  const WITHVT = `
v 0 0 0
v 1 0 0
v 1 1 0
vt 0.25 0.75
vt 0.5 0.5
vt 0.9 0.1
vn 0 0 1
f 1/1/1 2/2/1 3/3/1
`;
  const mesh = parseObj(WITHVT);

  it('keeps the authored uv (does not synthesize a planar projection)', () => {
    const at = (px: number, py: number) => {
      for (let i = 0; i < mesh.vertexCount; i++) {
        const v = vert(mesh, i);
        if (close(v[0]!, px) && close(v[1]!, py)) return v;
      }
      return null;
    };
    const v0 = at(0, 0)!;
    expect(close(v0[6]!, 0.25)).toBe(true);
    expect(close(v0[7]!, 0.75)).toBe(true);
  });
});

describe('parseObj — robustness', () => {
  it('ignores comments / o / g / s / mtllib / usemtl', () => {
    const src = `
mtllib foo.mtl
o thing
g grp
s 1
usemtl mat
# comment
v 0 0 0
v 1 0 0
v 0 1 0
vn 0 0 1
f 1//1 2//1 3//1
`;
    const mesh = parseObj(src);
    expect(mesh.triangleCount).toBe(1);
  });

  it('supports negative (relative) indices', () => {
    const src = `
v 0 0 0
v 1 0 0
v 0 1 0
f -3 -2 -1
`;
    const mesh = parseObj(src);
    expect(mesh.triangleCount).toBe(1);
    expect(mesh.vertexCount).toBe(3);
  });

  it('throws on empty / triangle-less input', () => {
    expect(() => parseObj('# nothing\nv 0 0 0\n')).toThrow();
  });
});
