// packages/web/src/lib/video/mat4.ts
//
// Minimal column-major 4×4 / 3×3 matrix helpers for TOYBOX's OBJ mesh pass.
// PURE (no GL, no DOM) so it unit-tests in jsdom and runs identically in the
// render hot path. Column-major to match WebGL's `uniformMatrix4fv` (which
// uploads column-major and forbids the `transpose` flag in WebGL2 — so the
// math here produces exactly what the GPU expects, no transpose at upload).
//
// Convention: a Mat4 is a length-16 Float32Array laid out column-major, i.e.
//   index = col*4 + row.  multiply(a, b) returns a·b (a applied AFTER b when
// transforming a column vector v as a·b·v), matching the usual
//   gl_Position = uProj * uView * uModel * vec4(pos, 1)
// composition order (here we fold view into proj for a single perspective).

export type Mat4 = Float32Array;
export type Mat3 = Float32Array;

/** The 4×4 identity. Fresh array each call (callers mutate freely). */
export function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/**
 * Column-major matrix product a·b. Result transforms a vector as
 * (a·b)·v = a·(b·v): `b` is applied first. Allocates a new Mat4.
 */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        // a[row=r, col=k] * b[row=k, col=c]
        sum += a[k * 4 + r]! * b[c * 4 + k]!;
      }
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

/**
 * Right-handed perspective projection (maps +Z toward the viewer; the camera
 * looks down -Z), clip-space depth in [-1, 1] (WebGL convention).
 *
 * @param fovYRad vertical field-of-view in radians
 * @param aspect  width / height
 * @param near    near clip distance (> 0)
 * @param far     far clip distance (> near)
 */
export function perspective(fovYRad: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovYRad / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

/**
 * Right-handed look-at VIEW matrix: positions a camera/projector at `eye`
 * looking toward `center`, with `up` the rough up direction. Maps world space
 * into the eye's view space (eye at origin, looking down -Z). Used to build a
 * projector's view-projection for TOYBOX projective surface mapping.
 *
 * Degenerate inputs (eye == center, or `up` parallel to the look direction)
 * fall back to a stable basis so the matrix is never NaN.
 */
export function lookAt(
  eye: [number, number, number],
  center: [number, number, number],
  up: [number, number, number] = [0, 1, 0],
): Mat4 {
  // Forward = normalize(eye - center) (points AWAY from the target; +Z of view).
  let fx = eye[0] - center[0];
  let fy = eye[1] - center[1];
  let fz = eye[2] - center[2];
  let fl = Math.hypot(fx, fy, fz);
  if (!fl || !Number.isFinite(fl)) {
    fx = 0; fy = 0; fz = 1; fl = 1;
  }
  fx /= fl; fy /= fl; fz /= fl;

  // Right = normalize(cross(up, forward)).
  let rx = up[1] * fz - up[2] * fy;
  let ry = up[2] * fx - up[0] * fz;
  let rz = up[0] * fy - up[1] * fx;
  let rl = Math.hypot(rx, ry, rz);
  if (!rl || !Number.isFinite(rl)) {
    // `up` is parallel to the look direction → pick an alternate up that
    // can't be parallel (axis least aligned with forward) and redo cross.
    const altUp: [number, number, number] = Math.abs(fy) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    rx = altUp[1] * fz - altUp[2] * fy;
    ry = altUp[2] * fx - altUp[0] * fz;
    rz = altUp[0] * fy - altUp[1] * fx;
    rl = Math.hypot(rx, ry, rz) || 1;
  }
  rx /= rl; ry /= rl; rz /= rl;

  // True up = cross(forward, right).
  const ux = fy * rz - fz * ry;
  const uy = fz * rx - fx * rz;
  const uz = fx * ry - fy * rx;

  // View = R^T with translation -R^T·eye. Column-major.
  const m = new Float32Array(16);
  m[0] = rx; m[4] = ry; m[8] = rz;
  m[1] = ux; m[5] = uy; m[9] = uz;
  m[2] = fx; m[6] = fy; m[10] = fz;
  m[12] = -(rx * eye[0] + ry * eye[1] + rz * eye[2]);
  m[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
  m[14] = -(fx * eye[0] + fy * eye[1] + fz * eye[2]);
  m[15] = 1;
  return m;
}

/** Translation matrix. */
export function translation(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
}

/** Uniform/anisotropic scale matrix. */
export function scaling(x: number, y: number, z: number): Mat4 {
  const m = new Float32Array(16);
  m[0] = x;
  m[5] = y;
  m[10] = z;
  m[15] = 1;
  return m;
}

/** Rotation about X (radians). */
export function rotationX(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = identity();
  m[5] = c;
  m[6] = s;
  m[9] = -s;
  m[10] = c;
  return m;
}

/** Rotation about Y (radians). */
export function rotationY(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = identity();
  m[0] = c;
  m[2] = -s;
  m[8] = s;
  m[10] = c;
  return m;
}

/** Rotation about Z (radians). */
export function rotationZ(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = identity();
  m[0] = c;
  m[1] = s;
  m[4] = -s;
  m[5] = c;
  return m;
}

/**
 * Compose a model matrix: scale, then rotate (Z·Y·X order), then translate.
 * Equivalent to T · Rz · Ry · Rx · S applied to a column vector.
 */
export function modelMatrix(
  rotX: number,
  rotY: number,
  rotZ: number,
  scale: number,
  tx = 0,
  ty = 0,
  tz = 0,
): Mat4 {
  const s = scaling(scale, scale, scale);
  const rx = rotationX(rotX);
  const ry = rotationY(rotY);
  const rz = rotationZ(rotZ);
  const t = translation(tx, ty, tz);
  // T · Rz · Ry · Rx · S
  return multiply(t, multiply(rz, multiply(ry, multiply(rx, s))));
}

/**
 * Normal matrix (3×3) = transpose(inverse(upper-left 3×3 of model)). Returned
 * column-major as a length-9 Float32Array for `uniformMatrix3fv`. For pure
 * rotations this equals the rotation itself; for non-uniform scales it keeps
 * normals perpendicular to the deformed surface.
 *
 * Falls back to the upper-left 3×3 (un-inverted) if the matrix is singular.
 */
export function normalMatrix(model: Mat4): Mat3 {
  // Extract upper-left 3×3 (column-major within the 4×4).
  const a00 = model[0]!, a01 = model[4]!, a02 = model[8]!;
  const a10 = model[1]!, a11 = model[5]!, a12 = model[9]!;
  const a20 = model[2]!, a21 = model[6]!, a22 = model[10]!;

  // Cofactors / determinant of the 3×3.
  const b01 = a22 * a11 - a12 * a21;
  const b11 = -a22 * a10 + a12 * a20;
  const b21 = a21 * a10 - a11 * a20;
  const det = a00 * b01 + a01 * b11 + a02 * b21;

  const out = new Float32Array(9);
  if (!det || !Number.isFinite(det)) {
    // Singular → just hand back the upper-left 3×3 (column-major).
    out[0] = a00; out[1] = a10; out[2] = a20;
    out[3] = a01; out[4] = a11; out[5] = a21;
    out[6] = a02; out[7] = a12; out[8] = a22;
    return out;
  }
  const id = 1 / det;

  // inverse(3×3) entries (row-major math), then transpose into column-major.
  const i00 = b01 * id;
  const i01 = (-a22 * a01 + a02 * a21) * id;
  const i02 = (a12 * a01 - a02 * a11) * id;
  const i10 = b11 * id;
  const i11 = (a22 * a00 - a02 * a20) * id;
  const i12 = (-a12 * a00 + a02 * a10) * id;
  const i20 = b21 * id;
  const i21 = (-a21 * a00 + a01 * a20) * id;
  const i22 = (a11 * a00 - a01 * a10) * id;

  // transpose(inverse): store column-major. (transpose of inverse, packed
  // column-major, is exactly the inverse packed row-major.)
  out[0] = i00; out[1] = i01; out[2] = i02;
  out[3] = i10; out[4] = i11; out[5] = i12;
  out[6] = i20; out[7] = i21; out[8] = i22;
  return out;
}
