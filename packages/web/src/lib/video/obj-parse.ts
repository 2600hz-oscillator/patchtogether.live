// packages/web/src/lib/video/obj-parse.ts
//
// In-house ASCII Wavefront OBJ parser for TOYBOX's OBJ mesh layer. PURE: no
// GL, no DOM, no asset loading — it takes OBJ source text and returns an
// interleaved, indexed, auto-framed mesh ready to upload to a VBO/IBO. Lives
// outside the module factory so it unit-tests in jsdom and is reused by the
// procedural primitive generators (primitives.ts) via the shared Mesh shape.
//
// Supported:
//   v   x y z [w]        — vertex position (w ignored)
//   vn  x y z            — vertex normal
//   vt  u v [w]          — texture coord (w ignored)
//   f   a b c [d …]      — face; each token is `p`, `p/t`, `p//n`, or `p/t/n`
//                          (1-based indices, negative = relative-from-end).
//                          Faces with >3 vertices are FAN-triangulated.
// Ignored (skipped): comments (#), o, g, s, mtllib, usemtl, and any other
// directive — TOYBOX renders a single matcap-shaded mesh, so material/group
// structure is irrelevant.
//
// Output (ParsedMesh):
//   - interleaved Float32Array, 8 floats / vertex: [px,py,pz, nx,ny,nz, u,v]
//   - Uint32Array indices (triangles)
//   - bounds {min,max} of the RAW positions (pre-centering)
//   - frame {center, scale}: auto-center offset (= bounds center) and a
//     uniform scale that fits the model into a unit view (longest axis → ~1).
//     The render pass applies these so ANY model frames sanely regardless of
//     its authored units/origin.
//
// Normals: if a face's vertices carry no normal index (`p` or `p/t`), a FLAT
// per-face normal is computed from the edge cross product and assigned to all
// of that face's emitted vertices. A model with zero `vn` lines therefore
// still shades correctly (Spot's control mesh exercises this path).
//
// Vertex dedup: a unique (pos,normal,uv) combination → one emitted vertex,
// keyed by the face token string plus the computed-normal bucket, so shared
// corners reuse indices where the OBJ shares them.

import type { Mesh } from '$lib/video/mesh';

/** Axis-aligned bounds of the raw (un-centered) positions. */
export interface MeshBounds {
  min: [number, number, number];
  max: [number, number, number];
}

/** Auto-frame transform derived from the bounds: subtract `center`, then
 *  multiply by `scale`, to land the model in a unit-ish view. */
export interface MeshFrame {
  center: [number, number, number];
  scale: number;
}

export interface ParsedMesh extends Mesh {
  bounds: MeshBounds;
  frame: MeshFrame;
  /** Number of triangles (indices.length / 3). */
  triangleCount: number;
}

const FLOATS_PER_VERT = 8; // pos(3) + normal(3) + uv(2)

/** Resolve a 1-based / negative OBJ index against the current count → 0-based.
 *  Returns -1 for an out-of-range or unparseable index (caller skips). */
function resolveIndex(token: string, count: number): number {
  if (token === '') return -1;
  const n = parseInt(token, 10);
  if (!Number.isFinite(n) || n === 0) return -1;
  const idx = n > 0 ? n - 1 : count + n; // negative = relative from end
  return idx >= 0 && idx < count ? idx : -1;
}

/**
 * Parse ASCII OBJ source into an interleaved, indexed, auto-framed mesh.
 * Throws if the result has no triangles (empty / unsupported input) so the
 * caller can fall back rather than upload a degenerate buffer.
 */
export function parseObj(src: string): ParsedMesh {
  const positions: Array<[number, number, number]> = [];
  const normals: Array<[number, number, number]> = [];
  const uvs: Array<[number, number]> = [];

  // Each emitted vertex's source: a position index, an optional uv index, and
  // either an explicit normal index (≥0) or a flat normal we computed.
  interface FaceCorner {
    p: number;
    t: number; // uv index or -1
    n: number; // normal index or -1 (→ flat)
  }
  // Per-face corner lists (already triangulated via fan), collected first so
  // we can compute flat normals for faces lacking explicit normals.
  const triFaces: FaceCorner[][] = [];

  const lines = src.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!;
    // Fast bail on blanks / comments before tokenizing.
    if (line.length === 0) continue;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed[0] === '#') continue;

    const sp = trimmed.indexOf(' ');
    const tag = sp === -1 ? trimmed : trimmed.slice(0, sp);
    if (tag === 'v') {
      const t = trimmed.split(/\s+/);
      positions.push([parseFloat(t[1]!) || 0, parseFloat(t[2]!) || 0, parseFloat(t[3]!) || 0]);
    } else if (tag === 'vn') {
      const t = trimmed.split(/\s+/);
      normals.push([parseFloat(t[1]!) || 0, parseFloat(t[2]!) || 0, parseFloat(t[3]!) || 0]);
    } else if (tag === 'vt') {
      const t = trimmed.split(/\s+/);
      uvs.push([parseFloat(t[1]!) || 0, parseFloat(t[2]!) || 0]);
    } else if (tag === 'f') {
      const toks = trimmed.split(/\s+/).slice(1);
      const corners: FaceCorner[] = [];
      for (const tok of toks) {
        if (tok === '') continue;
        const parts = tok.split('/');
        const p = resolveIndex(parts[0] ?? '', positions.length);
        if (p < 0) continue; // bad position index → skip this corner
        const t = parts.length > 1 ? resolveIndex(parts[1] ?? '', uvs.length) : -1;
        const n = parts.length > 2 ? resolveIndex(parts[2] ?? '', normals.length) : -1;
        corners.push({ p, t, n });
      }
      if (corners.length < 3) continue; // not a polygon
      // Fan-triangulate: (0, i, i+1) for i in 1..len-2.
      for (let i = 1; i + 1 < corners.length; i++) {
        triFaces.push([corners[0]!, corners[i]!, corners[i + 1]!]);
      }
    }
    // All other tags (o, g, s, mtllib, usemtl, …) are intentionally ignored.
  }

  // ---- Build interleaved buffer + index buffer with dedup ----
  const interleavedList: number[] = [];
  const indices: number[] = [];
  const keyToIndex = new Map<string, number>();
  let nextIndex = 0;

  /** Compute the flat normal of a triangle from its position indices. */
  function flatNormal(a: number, b: number, c: number): [number, number, number] {
    const pa = positions[a]!;
    const pb = positions[b]!;
    const pc = positions[c]!;
    const ux = pb[0] - pa[0];
    const uy = pb[1] - pa[1];
    const uz = pb[2] - pa[2];
    const vx = pc[0] - pa[0];
    const vy = pc[1] - pa[1];
    const vz = pc[2] - pa[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-12) {
      nx /= len;
      ny /= len;
      nz /= len;
    } else {
      nx = 0; ny = 0; nz = 1; // degenerate triangle → arbitrary up-facing
    }
    return [nx, ny, nz];
  }

  for (const tri of triFaces) {
    // Resolve the normal source for this triangle: explicit per-corner if all
    // present, else a single computed flat normal shared by all 3 corners.
    const hasExplicitNormals = tri.every((c) => c.n >= 0);
    let flat: [number, number, number] | null = null;
    if (!hasExplicitNormals) {
      flat = flatNormal(tri[0]!.p, tri[1]!.p, tri[2]!.p);
    }

    for (const corner of tri) {
      const nrm =
        corner.n >= 0 && normals[corner.n]
          ? normals[corner.n]!
          : flat ?? [0, 0, 1];
      const uv = corner.t >= 0 && uvs[corner.t] ? uvs[corner.t]! : [0, 0];
      // Dedup key includes the flat-normal bucket (rounded) so two faces
      // sharing a position but with different flat normals don't collapse.
      const key = `${corner.p}/${corner.t}/${
        corner.n >= 0 ? `n${corner.n}` : `f${nrm[0].toFixed(4)},${nrm[1].toFixed(4)},${nrm[2].toFixed(4)}`
      }`;
      let idx = keyToIndex.get(key);
      if (idx === undefined) {
        const pos = positions[corner.p]!;
        interleavedList.push(
          pos[0], pos[1], pos[2],
          nrm[0], nrm[1], nrm[2],
          uv[0], uv[1],
        );
        idx = nextIndex++;
        keyToIndex.set(key, idx);
      }
      indices.push(idx);
    }
  }

  if (indices.length === 0) {
    throw new Error('parseObj: no triangles produced (empty or unsupported OBJ)');
  }

  // ---- Bounds + auto-frame ----
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < interleavedList.length; i += FLOATS_PER_VERT) {
    for (let a = 0; a < 3; a++) {
      const v = interleavedList[i + a]!;
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  const center: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  const ext = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  // Fit the longest axis into ~2 units (a [-1,1] cube), so combined with the
  // render pass's fixed camera every model frames sanely. Guard zero-extent.
  const scale = ext > 1e-9 ? 2 / ext : 1;

  // ---- Planar-UV fallback for OBJs with ZERO authored `vt` lines ----
  // Models with no texture coords (teapot/chess-pawn) emit every vertex with
  // uv (0,0) above, so a surface-texture lookup would sample a single texel.
  // Synthesize a deterministic planar XY projection over the model bounds:
  // u = (px - min.x)/extX, v = (py - min.y)/extY. This is a pure function of
  // position, so it does NOT affect dedup correctness (identical pos → identical
  // synthesized uv). Models WITH `vt` (spot) are untouched — the matcap path
  // ignores uv entirely, so adding planar uv to these models is harmless to the
  // existing matcap baselines. The projection emits a top-origin v (1 - rawV)
  // so it matches the OBJ-v flip the surface shader applies (which un-flips
  // authored bottom-origin uv); the planar fallback therefore looks upright.
  if (uvs.length === 0) {
    const extX = max[0] - min[0];
    const extY = max[1] - min[1];
    const invX = extX > 1e-9 ? 1 / extX : 0;
    const invY = extY > 1e-9 ? 1 / extY : 0;
    for (let i = 0; i < interleavedList.length; i += FLOATS_PER_VERT) {
      const px = interleavedList[i]!;
      const py = interleavedList[i + 1]!;
      const u = (px - min[0]) * invX;
      const v = (py - min[1]) * invY;
      interleavedList[i + 6] = u;
      // Emit top-origin v so the shader's 1.0 - v flip lands it upright.
      interleavedList[i + 7] = 1 - v;
    }
  }

  return {
    interleaved: new Float32Array(interleavedList),
    indices: new Uint32Array(indices),
    vertexCount: nextIndex,
    bounds: { min, max },
    frame: { center, scale },
    triangleCount: indices.length / 3,
  };
}
