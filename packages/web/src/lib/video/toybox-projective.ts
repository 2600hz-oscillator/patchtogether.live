// packages/web/src/lib/video/toybox-projective.ts
//
// TOYBOX Phase-7 PROJECTIVE surface mapping — PURE math helpers. No GL, no DOM.
// An OBJ layer in 'projective' surface mode projects its SURFACE source (another
// layer's rendered FBO) onto the mesh FROM A VIEWPOINT — the "video projector
// aimed at geometry" / projection-mapping look — instead of sampling by the
// mesh's own UVs.
//
// The render hot path (modules/toybox.ts) builds the projector view-projection
// with buildProjectorViewProj() and uploads it as a uniform; the OBJ fragment
// shader transforms each fragment's WORLD position into the projector's clip
// space, divides by w, and maps to [0,1] texture coords — with two guards:
//   - FRONT-FACING: the fragment normal must face the projector (dot(N, toProj)
//     > 0), so the image doesn't wrap onto back faces.
//   - IN-FRUSTUM: the projected point must be inside the projector's frustum
//     (0..1 in s,t and IN FRONT of the projector, w > 0), else no projection.
//
// This module mirrors that math on the CPU (projectFragment) so the projection
// is unit-testable without a GL context, and exposes buildProjectorViewProj()
// (used by both the GL pass and the tests) so they can't drift.

import { lookAt, multiply, perspective, type Mat4 } from './mat4';
import { resolveProjector, type ToyboxObjMaterial } from './toybox-content';

/** A projector: eye, look direction, vertical FOV, and the aspect of the
 *  projected image (the render aspect — the source FBO is engine-res). */
export interface Projector {
  eye: [number, number, number];
  /** Look DIRECTION (need not be normalised). */
  dir: [number, number, number];
  /** Vertical field-of-view, radians. */
  fov: number;
  /** Image aspect = width / height. */
  aspect: number;
}

/**
 * Build the projector view-projection matrix (proj · view). A fragment's world
 * position W maps to projector clip space as VP · vec4(W, 1); after the
 * perspective divide, x/w and y/w are in [-1,1] (→ [0,1] texcoords) and z/w in
 * [-1,1] when inside the near/far range. The near/far are fixed and generous
 * (0.05 .. 100) so a projector anywhere sensible has the whole scene in range.
 */
export function buildProjectorViewProj(p: Projector): Mat4 {
  const center: [number, number, number] = [
    p.eye[0] + p.dir[0],
    p.eye[1] + p.dir[1],
    p.eye[2] + p.dir[2],
  ];
  const view = lookAt(p.eye, center);
  const proj = perspective(p.fov, p.aspect || 1, 0.05, 100);
  return multiply(proj, view);
}

/** Resolve a Projector from an OBJ material + the render camera (used when
 *  material.projUseCamera is set) + the image aspect. PURE. The render camera
 *  is described by its eye + look dir (TOYBOX's camera is fixed at z=+3.2
 *  looking down -Z, but we pass it in so the math has no hidden constant). */
export function projectorFromMaterial(
  mat: ToyboxObjMaterial,
  camera: { eye: [number, number, number]; dir: [number, number, number] },
  aspect: number,
): Projector {
  const useCamera = typeof mat.projUseCamera === 'number' && mat.projUseCamera > 0.5;
  if (useCamera) {
    const { fov } = resolveProjector(mat);
    return { eye: [...camera.eye], dir: [...camera.dir], fov, aspect };
  }
  const { pos, dir, fov } = resolveProjector(mat);
  return { eye: pos, dir, fov, aspect };
}

/** Result of a CPU fragment projection. */
export interface ProjectedSample {
  /** Texture coords in [0,1] (only meaningful when `inFrustum`). */
  s: number;
  t: number;
  /** The clip-space w (perspective denominator). > 0 means in front of the
   *  projector. */
  w: number;
  /** True iff the point is in front of the projector AND s,t ∈ [0,1]. */
  inFrustum: boolean;
  /** True iff the fragment normal faces the projector (dot(N, eye-pos) > 0). */
  frontFacing: boolean;
  /** True iff the projection should be SAMPLED here (inFrustum && frontFacing).
   *  When false, the fragment falls back to the matcap / base. */
  projected: boolean;
}

/** Apply a column-major Mat4 to a vec4 (w=1 for a point); returns [x,y,z,w]. */
function applyMat4Point(
  m: Mat4,
  x: number,
  y: number,
  z: number,
): [number, number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
    m[3]! * x + m[7]! * y + m[11]! * z + m[15]!,
  ];
}

/**
 * CPU reference of the projective fragment math the OBJ shader runs. Given the
 * projector's view-projection, the projector eye, a fragment WORLD position +
 * WORLD normal, returns the projected texcoords + the front-facing / in-frustum
 * guards.
 *
 * This is the single source of truth the GL shader mirrors; the unit tests pin
 * the geometry (a point dead-centre in front of the projector lands at s,t≈0.5;
 * a point behind it is rejected; a back-facing normal is rejected).
 */
export function projectFragment(
  viewProj: Mat4,
  eye: [number, number, number],
  worldPos: [number, number, number],
  worldNormal: [number, number, number],
): ProjectedSample {
  const clip = applyMat4Point(viewProj, worldPos[0], worldPos[1], worldPos[2]);
  const w = clip[3];
  let s = 0;
  let t = 0;
  let inFrustum = false;
  if (w > 1e-6) {
    s = clip[0] / w * 0.5 + 0.5;
    t = clip[1] / w * 0.5 + 0.5;
    const z = clip[2] / w;
    inFrustum = s >= 0 && s <= 1 && t >= 0 && t <= 1 && z >= -1 && z <= 1;
  }
  // Front-facing: the surface normal must point toward the projector. toProj =
  // normalize(eye - worldPos); dot(N, toProj) > 0 means the projector "sees"
  // the front of the surface (so a sphere doesn't get its far side painted).
  const tx = eye[0] - worldPos[0];
  const ty = eye[1] - worldPos[1];
  const tz = eye[2] - worldPos[2];
  const dotN = worldNormal[0] * tx + worldNormal[1] * ty + worldNormal[2] * tz;
  const frontFacing = dotN > 0;
  return { s, t, w, inFrustum, frontFacing, projected: inFrustum && frontFacing };
}
