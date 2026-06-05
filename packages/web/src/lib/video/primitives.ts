// packages/web/src/lib/video/primitives.ts
//
// Procedural mesh generators for TOYBOX's built-in OBJ "models" — no asset
// files, zero license surface. Each returns the same interleaved-mesh shape
// (mesh.ts: [px,py,pz, nx,ny,nz, u,v] + Uint32 indices) the OBJ parser emits,
// PLUS the same `frame {center, scale}` so the render pass auto-frames them
// identically to loaded OBJs (all generators here are already centred at the
// origin and roughly unit-extent, so center≈0 and scale≈1).
//
// PURE: no GL, no DOM — unit-testable, runs in the render hot path.
//
//   cube()              — unit cube, 12 tris, flat per-face normals + box UVs.
//   sphere(segments)    — UV sphere; `segments` longitude divisions
//                          (latitude = segments/2), smooth (radial) normals.
//   torus()             — standard torus, smooth normals.
//   hypercube()         — a tesseract: the 4D unit cube projected to 3D, its
//                          32 edges built as thin triangulated tube segments
//                          so it renders as a solid (lit) wireframe.

import type { Mesh } from '$lib/video/mesh';

export interface PrimitiveMesh extends Mesh {
  /** Same auto-frame contract as ParsedMesh — generators are pre-centred so
   *  center is ~0 and scale ~1, but the field is present so the render pass
   *  treats primitives and OBJs through one code path. */
  frame: { center: [number, number, number]; scale: number };
  triangleCount: number;
}

/** A mutable interleaved-mesh builder shared by the generators. */
class MeshBuilder {
  private verts: number[] = [];
  private idx: number[] = [];
  private count = 0;

  /** Push one vertex; returns its index. */
  vertex(
    px: number, py: number, pz: number,
    nx: number, ny: number, nz: number,
    u: number, v: number,
  ): number {
    this.verts.push(px, py, pz, nx, ny, nz, u, v);
    return this.count++;
  }

  /** Push a triangle by three existing vertex indices. */
  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  build(frameScale = 1): PrimitiveMesh {
    return {
      interleaved: new Float32Array(this.verts),
      indices: new Uint32Array(this.idx),
      vertexCount: this.count,
      frame: { center: [0, 0, 0], scale: frameScale },
      triangleCount: this.idx.length / 3,
    };
  }
}

function normalize(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

// ---------------------------------------------------------------- cube ----

/** Unit cube centred at the origin, half-extent 1 (spans [-1,1]). Each face
 *  is two triangles with a single outward flat normal + 0..1 UVs. */
export function cube(): PrimitiveMesh {
  const b = new MeshBuilder();
  // 6 faces: [normal, and the 4 corners CCW seen from outside].
  const faces: Array<{
    n: [number, number, number];
    c: Array<[number, number, number]>;
  }> = [
    { n: [0, 0, 1],  c: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },     // +Z
    { n: [0, 0, -1], c: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] }, // -Z
    { n: [1, 0, 0],  c: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },     // +X
    { n: [-1, 0, 0], c: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] }, // -X
    { n: [0, 1, 0],  c: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },     // +Y
    { n: [0, -1, 0], c: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] }, // -Y
  ];
  const uvs: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (const f of faces) {
    const i: number[] = [];
    for (let k = 0; k < 4; k++) {
      const p = f.c[k]!;
      const uv = uvs[k]!;
      i.push(b.vertex(p[0], p[1], p[2], f.n[0], f.n[1], f.n[2], uv[0], uv[1]));
    }
    b.tri(i[0]!, i[1]!, i[2]!);
    b.tri(i[0]!, i[2]!, i[3]!);
  }
  return b.build(1);
}

// -------------------------------------------------------------- sphere ----

/** UV sphere of radius 1. `segments` = longitude divisions (rings of
 *  latitude = max(2, segments/2)). Smooth normals (position == normal on a
 *  unit sphere). UVs map longitude→u, latitude→v. */
export function sphere(segments = 24): PrimitiveMesh {
  const lon = Math.max(3, Math.floor(segments));
  const lat = Math.max(2, Math.floor(segments / 2));
  const b = new MeshBuilder();
  // Grid of (lat+1) × (lon+1) vertices.
  const grid: number[][] = [];
  for (let y = 0; y <= lat; y++) {
    const row: number[] = [];
    const theta = (y / lat) * Math.PI;       // 0..π (north→south)
    const st = Math.sin(theta);
    const ct = Math.cos(theta);
    for (let x = 0; x <= lon; x++) {
      const phi = (x / lon) * Math.PI * 2;    // 0..2π
      const sp = Math.sin(phi);
      const cp = Math.cos(phi);
      const px = st * cp;
      const py = ct;
      const pz = st * sp;
      row.push(b.vertex(px, py, pz, px, py, pz, x / lon, y / lat));
    }
    grid.push(row);
  }
  for (let y = 0; y < lat; y++) {
    for (let x = 0; x < lon; x++) {
      const a = grid[y]![x]!;
      const bb = grid[y]![x + 1]!;
      const c = grid[y + 1]![x]!;
      const d = grid[y + 1]![x + 1]!;
      b.tri(a, c, bb);
      b.tri(bb, c, d);
    }
  }
  return b.build(1);
}

// --------------------------------------------------------------- torus ----

/** Torus with major radius R (centre→tube centre) and minor radius r (tube).
 *  Smooth normals. `radial` = divisions around the major ring, `tubular` =
 *  divisions around the tube cross-section. Fits within ~unit by scaling at
 *  the frame level (R+r ≈ 1 here). */
export function torus(R = 0.7, r = 0.3, radial = 32, tubular = 16): PrimitiveMesh {
  const b = new MeshBuilder();
  const grid: number[][] = [];
  for (let i = 0; i <= radial; i++) {
    const u = (i / radial) * Math.PI * 2;
    const cu = Math.cos(u);
    const su = Math.sin(u);
    const row: number[] = [];
    for (let j = 0; j <= tubular; j++) {
      const v = (j / tubular) * Math.PI * 2;
      const cv = Math.cos(v);
      const sv = Math.sin(v);
      // Position on the torus surface.
      const px = (R + r * cv) * cu;
      const py = r * sv;
      const pz = (R + r * cv) * su;
      // Normal points from the tube-centre ring to the surface point.
      const cx = R * cu;
      const cz = R * su;
      const [nx, ny, nz] = normalize(px - cx, py, pz - cz);
      row.push(b.vertex(px, py, pz, nx, ny, nz, i / radial, j / tubular));
    }
    grid.push(row);
  }
  for (let i = 0; i < radial; i++) {
    for (let j = 0; j < tubular; j++) {
      const a = grid[i]![j]!;
      const bb = grid[i + 1]![j]!;
      const c = grid[i]![j + 1]!;
      const d = grid[i + 1]![j + 1]!;
      b.tri(a, bb, c);
      b.tri(c, bb, d);
    }
  }
  return b.build(1);
}

// ----------------------------------------------------------- hypercube ----

/**
 * Tesseract (4-cube): the 16 vertices of the 4D unit cube, perspective-
 * projected from 4D→3D (distance-from-4D-viewer), with its 32 edges built as
 * thin triangulated tubes so it renders as a SOLID lit wireframe (TRIANGLES,
 * matcap-shaded) rather than a line mesh that the depth/matcap pass can't
 * light. The classic "cube within a cube" silhouette.
 */
export function hypercube(): PrimitiveMesh {
  // 16 vertices in 4D (±1 on each axis).
  const v4: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 16; i++) {
    v4.push([
      i & 1 ? 1 : -1,
      i & 2 ? 1 : -1,
      i & 4 ? 1 : -1,
      i & 8 ? 1 : -1,
    ]);
  }
  // Project 4D→3D: simple perspective by the w-axis (viewer at w = WD).
  const WD = 2.5;
  const p3 = v4.map(([x, y, z, w]): [number, number, number] => {
    const k = 1 / (WD - w);
    return [x * k * WD, y * k * WD, z * k * WD];
  });
  // Edges: two vertices that differ in exactly one of the 4 bits.
  const edges: Array<[number, number]> = [];
  for (let a = 0; a < 16; a++) {
    for (let bit = 0; bit < 4; bit++) {
      const bIdx = a ^ (1 << bit);
      if (bIdx > a) edges.push([a, bIdx]);
    }
  }

  const b = new MeshBuilder();
  const TUBE_R = 0.035; // tube half-thickness (in projected units)
  const SIDES = 4;      // square cross-section → cheap solid edges

  for (const [ai, bi] of edges) {
    const A = p3[ai]!;
    const B = p3[bi]!;
    // Edge axis.
    let dx = B[0] - A[0];
    let dy = B[1] - A[1];
    let dz = B[2] - A[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    // Two perpendicular vectors spanning the cross-section.
    // Pick a helper not parallel to the axis.
    let hx = 0, hy = 1, hz = 0;
    if (Math.abs(dy) > 0.9) { hx = 1; hy = 0; hz = 0; }
    // u = normalize(cross(axis, helper)), v = cross(axis, u)
    let ux = dy * hz - dz * hy;
    let uy = dz * hx - dx * hz;
    let uz = dx * hy - dy * hx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = dy * uz - dz * uy;
    const vy = dz * ux - dx * uz;
    const vz = dx * uy - dy * ux;

    // Ring offsets for a square tube.
    const ring: Array<[number, number]> = [
      [1, 1], [-1, 1], [-1, -1], [1, -1],
    ];
    const startIdx: number[] = [];
    const endIdx: number[] = [];
    for (let s = 0; s < SIDES; s++) {
      const [ru, rv] = ring[s]!;
      const ox = (ux * ru + vx * rv) * TUBE_R;
      const oy = (uy * ru + vy * rv) * TUBE_R;
      const oz = (uz * ru + vz * rv) * TUBE_R;
      const [nx, ny, nz] = normalize(ox, oy, oz);
      startIdx.push(b.vertex(A[0] + ox, A[1] + oy, A[2] + oz, nx, ny, nz, s / SIDES, 0));
      endIdx.push(b.vertex(B[0] + ox, B[1] + oy, B[2] + oz, nx, ny, nz, s / SIDES, 1));
    }
    for (let s = 0; s < SIDES; s++) {
      const sn = (s + 1) % SIDES;
      const a0 = startIdx[s]!;
      const a1 = startIdx[sn]!;
      const b0 = endIdx[s]!;
      const b1 = endIdx[sn]!;
      b.tri(a0, b0, a1);
      b.tri(a1, b0, b1);
    }
  }
  // Projected tesseract spans roughly [-1.7, 1.7]; let the frame scale fit it.
  return b.build(0.6);
}

// ------------------------------------------------------ platonic solids ----

/** Build a flat-shaded mesh from a vertex/face list. Each face is a triangle of
 *  three positions; a single flat outward normal is computed per face (cross of
 *  two edges), and planar UVs are derived from the face's local basis so a
 *  surface texture isn't collapsed to one texel. Positions are assumed centred
 *  on the origin (the platonic generators below place them symmetrically). */
function flatPolyhedron(
  positions: Array<[number, number, number]>,
  faces: Array<[number, number, number]>,
  frameScale = 1,
): PrimitiveMesh {
  const b = new MeshBuilder();
  for (const [ia, ib, ic] of faces) {
    const A = positions[ia]!;
    const B = positions[ib]!;
    const C = positions[ic]!;
    // Face normal = normalize(cross(B-A, C-A)).
    const e1: [number, number, number] = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const e2: [number, number, number] = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const [nx, ny, nz] = normalize(
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    );
    // Planar UVs from a tangent basis on the face.
    const [tx, ty, tz] = normalize(e1[0], e1[1], e1[2]);
    const bx = ny * tz - nz * ty;
    const by = nz * tx - nx * tz;
    const bz = nx * ty - ny * tx;
    const uvOf = (P: [number, number, number]): [number, number] => [
      0.5 + 0.5 * (P[0] * tx + P[1] * ty + P[2] * tz),
      0.5 + 0.5 * (P[0] * bx + P[1] * by + P[2] * bz),
    ];
    const ua = uvOf(A), ub = uvOf(B), uc = uvOf(C);
    const va = b.vertex(A[0], A[1], A[2], nx, ny, nz, ua[0], ua[1]);
    const vb = b.vertex(B[0], B[1], B[2], nx, ny, nz, ub[0], ub[1]);
    const vc = b.vertex(C[0], C[1], C[2], nx, ny, nz, uc[0], uc[1]);
    b.tri(va, vb, vc);
  }
  return b.build(frameScale);
}

/** Regular tetrahedron inscribed in the unit cube (4 alternating cube corners),
 *  flat-shaded. 4 triangular faces. */
export function tetrahedron(): PrimitiveMesh {
  const k = 1 / Math.sqrt(3); // place corners on the unit sphere
  const positions: Array<[number, number, number]> = [
    [k, k, k],
    [k, -k, -k],
    [-k, k, -k],
    [-k, -k, k],
  ];
  const faces: Array<[number, number, number]> = [
    [0, 1, 2],
    [0, 3, 1],
    [0, 2, 3],
    [1, 3, 2],
  ];
  return flatPolyhedron(positions, faces, 1);
}

/** Regular octahedron (6 axis vertices, 8 triangular faces), flat-shaded. */
export function octahedron(): PrimitiveMesh {
  const positions: Array<[number, number, number]> = [
    [1, 0, 0], [-1, 0, 0],
    [0, 1, 0], [0, -1, 0],
    [0, 0, 1], [0, 0, -1],
  ];
  // Faces oriented CCW outward.
  const faces: Array<[number, number, number]> = [
    [0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4],
    [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5],
  ];
  return flatPolyhedron(positions, faces, 1);
}

/** Regular icosahedron (12 golden-ratio vertices, 20 triangular faces),
 *  flat-shaded — the classic "d20". Vertices normalised to the unit sphere. */
export function icosahedron(): PrimitiveMesh {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw: Array<[number, number, number]> = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const positions = raw.map((p) => normalize(p[0], p[1], p[2]));
  const faces: Array<[number, number, number]> = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  return flatPolyhedron(positions, faces, 1);
}

// ----------------------------------------------------- cylinder / cone ----

/** Right circular cylinder, radius r, half-height h, `segments` around the
 *  axis. Smooth radial side normals + flat cap normals, capped top + bottom. */
export function cylinder(r = 0.6, h = 0.9, segments = 32): PrimitiveMesh {
  const seg = Math.max(3, Math.floor(segments));
  const b = new MeshBuilder();
  // Side wall: a ring of quads with radial normals.
  const top: number[] = [];
  const bot: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const cx = Math.cos(a), cz = Math.sin(a);
    top.push(b.vertex(r * cx, h, r * cz, cx, 0, cz, i / seg, 1));
    bot.push(b.vertex(r * cx, -h, r * cz, cx, 0, cz, i / seg, 0));
  }
  for (let i = 0; i < seg; i++) {
    b.tri(bot[i]!, bot[i + 1]!, top[i]!);
    b.tri(top[i]!, bot[i + 1]!, top[i + 1]!);
  }
  // Caps (centre fan, flat normals).
  const tc = b.vertex(0, h, 0, 0, 1, 0, 0.5, 0.5);
  const bc = b.vertex(0, -h, 0, 0, -1, 0, 0.5, 0.5);
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const t0 = b.vertex(r * Math.cos(a0), h, r * Math.sin(a0), 0, 1, 0, 0.5 + 0.5 * Math.cos(a0), 0.5 + 0.5 * Math.sin(a0));
    const t1 = b.vertex(r * Math.cos(a1), h, r * Math.sin(a1), 0, 1, 0, 0.5 + 0.5 * Math.cos(a1), 0.5 + 0.5 * Math.sin(a1));
    b.tri(tc, t0, t1);
    const u0 = b.vertex(r * Math.cos(a0), -h, r * Math.sin(a0), 0, -1, 0, 0.5 + 0.5 * Math.cos(a0), 0.5 + 0.5 * Math.sin(a0));
    const u1 = b.vertex(r * Math.cos(a1), -h, r * Math.sin(a1), 0, -1, 0, 0.5 + 0.5 * Math.cos(a1), 0.5 + 0.5 * Math.sin(a1));
    b.tri(bc, u1, u0);
  }
  return b.build(1);
}

/** Right circular cone, base radius r, half-height h, `segments` around the
 *  axis. The side normal is the true slanted cone normal (radial tilted up by
 *  the slope), the base cap is flat. */
export function cone(r = 0.6, h = 0.95, segments = 32): PrimitiveMesh {
  const seg = Math.max(3, Math.floor(segments));
  const b = new MeshBuilder();
  // Slope: the side normal tilts up by atan(r / (2h)) from horizontal.
  const slope = r / (2 * h);
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const am = (a0 + a1) * 0.5;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);
    const cm = Math.cos(am), sm = Math.sin(am);
    const [n0x, n0y, n0z] = normalize(c0, slope, s0);
    const [n1x, n1y, n1z] = normalize(c1, slope, s1);
    const [nmx, nmy, nmz] = normalize(cm, slope, sm);
    const apex = b.vertex(0, h, 0, nmx, nmy, nmz, (i + 0.5) / seg, 1);
    const v0 = b.vertex(r * c0, -h, r * s0, n0x, n0y, n0z, i / seg, 0);
    const v1 = b.vertex(r * c1, -h, r * s1, n1x, n1y, n1z, (i + 1) / seg, 0);
    b.tri(apex, v0, v1);
  }
  // Base cap.
  const bc = b.vertex(0, -h, 0, 0, -1, 0, 0.5, 0.5);
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const u0 = b.vertex(r * Math.cos(a0), -h, r * Math.sin(a0), 0, -1, 0, 0.5 + 0.5 * Math.cos(a0), 0.5 + 0.5 * Math.sin(a0));
    const u1 = b.vertex(r * Math.cos(a1), -h, r * Math.sin(a1), 0, -1, 0, 0.5 + 0.5 * Math.cos(a1), 0.5 + 0.5 * Math.sin(a1));
    b.tri(bc, u1, u0);
  }
  return b.build(1);
}

// ----------------------------------------------------------- torus-knot ----

/** A (p,q) torus knot: a tube swept along the knot curve on the surface of a
 *  torus, smooth normals (radial from the tube centreline). The default (2,3)
 *  is the classic trefoil. `tubular` = samples along the curve, `radial` =
 *  cross-section divisions. */
export function torusKnot(
  p = 2,
  q = 3,
  tubeR = 0.18,
  tubular = 160,
  radial = 12,
): PrimitiveMesh {
  const b = new MeshBuilder();
  // Knot curve point at parameter u (0..2pi).
  const curve = (u: number): [number, number, number] => {
    const cu = Math.cos(u), su = Math.sin(u);
    const cq = Math.cos((q / p) * u);
    const r = 0.6 + 0.25 * cq;
    return [r * cu, 0.25 * Math.sin((q / p) * u), r * su];
  };
  const grid: number[][] = [];
  for (let i = 0; i <= tubular; i++) {
    const u = (i / tubular) * Math.PI * 2 * p;
    const cur = curve(u);
    // Tangent via finite difference.
    const nxt = curve(u + 0.001);
    let tx = nxt[0] - cur[0], ty = nxt[1] - cur[1], tz = nxt[2] - cur[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    // A stable normal/binormal frame (helper = world up, guarded).
    let hx = 0, hy = 1, hz = 0;
    if (Math.abs(ty) > 0.9) { hx = 1; hy = 0; hz = 0; }
    let nx = ty * hz - tz * hy;
    let ny = tz * hx - tx * hz;
    let nz = tx * hy - ty * hx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const bx = ty * nz - tz * ny;
    const by = tz * nx - tx * nz;
    const bz = tx * ny - ty * nx;
    const row: number[] = [];
    for (let j = 0; j <= radial; j++) {
      const v = (j / radial) * Math.PI * 2;
      const cv = Math.cos(v), sv = Math.sin(v);
      const ox = (nx * cv + bx * sv);
      const oy = (ny * cv + by * sv);
      const oz = (nz * cv + bz * sv);
      const px = cur[0] + tubeR * ox;
      const py = cur[1] + tubeR * oy;
      const pz = cur[2] + tubeR * oz;
      const [nnx, nny, nnz] = normalize(ox, oy, oz);
      row.push(b.vertex(px, py, pz, nnx, nny, nnz, i / tubular, j / radial));
    }
    grid.push(row);
  }
  for (let i = 0; i < tubular; i++) {
    for (let j = 0; j < radial; j++) {
      const a = grid[i]![j]!;
      const bb = grid[i + 1]![j]!;
      const c = grid[i]![j + 1]!;
      const d = grid[i + 1]![j + 1]!;
      b.tri(a, bb, c);
      b.tri(c, bb, d);
    }
  }
  return b.build(1);
}

/** Builtin primitive ids the manifest/factory expose as "models" with no
 *  file. Keep in sync with the manifest's `models[].builtin` values. */
export type BuiltinPrimitive =
  | 'cube'
  | 'sphere'
  | 'torus'
  | 'hypercube'
  | 'tetrahedron'
  | 'octahedron'
  | 'icosahedron'
  | 'cylinder'
  | 'cone'
  | 'torus-knot';

/** Generate a builtin primitive mesh by id. */
export function makePrimitive(id: BuiltinPrimitive): PrimitiveMesh {
  switch (id) {
    case 'cube': return cube();
    case 'sphere': return sphere(24);
    case 'torus': return torus();
    case 'hypercube': return hypercube();
    case 'tetrahedron': return tetrahedron();
    case 'octahedron': return octahedron();
    case 'icosahedron': return icosahedron();
    case 'cylinder': return cylinder();
    case 'cone': return cone();
    case 'torus-knot': return torusKnot();
  }
}
