// packages/web/src/lib/video/mesh.ts
//
// Shared interleaved-mesh shape used by TOYBOX's OBJ layer. Both the OBJ
// parser (obj-parse.ts) and the procedural generators (primitives.ts) emit
// this so the render pass uploads them through one code path. PURE type +
// tiny helper; no GL / DOM.
//
// Interleaved layout: 8 floats per vertex — [px,py,pz, nx,ny,nz, u,v].
//   stride        = 8 * 4 = 32 bytes
//   pos    offset = 0  (3 floats)
//   normal offset = 12 (3 floats)
//   uv     offset = 24 (2 floats)

export interface Mesh {
  /** Interleaved vertex data: [px,py,pz, nx,ny,nz, u,v] repeated. */
  interleaved: Float32Array;
  /** Triangle index buffer (UNSIGNED_INT in the draw call). */
  indices: Uint32Array;
  /** Number of distinct vertices (= interleaved.length / 8). */
  vertexCount: number;
}

/** Floats per interleaved vertex. */
export const MESH_FLOATS_PER_VERT = 8;
/** Byte stride of the interleaved layout. */
export const MESH_STRIDE_BYTES = MESH_FLOATS_PER_VERT * 4;
/** Byte offsets of each attribute within a vertex. */
export const MESH_OFFSET_POS = 0;
export const MESH_OFFSET_NORMAL = 12;
export const MESH_OFFSET_UV = 24;
