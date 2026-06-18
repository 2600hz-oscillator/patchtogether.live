// mappy-homography.ts — pure 2D projective (homography) math for the MAPPY
// projection mapper. No GL, no DOM: a 3×3 planar transform that warps one
// surface's source into a dragged quad on the projector output. Each MAPPY
// surface = one homography (the unit square → the surface's four draggable
// corners); the warp shader samples the source at the INVERSE map.
//
// A 4-point homography is a small linear solve (DLT) — we own it rather than
// pull a CV dependency for the v1 manual mapper. Kept pure so it's exhaustively
// unit-testable (round-trip, invert, compose) with no renderer.
//
// Conventions:
//   Vec2 = [x, y]
//   Quad = 4 corners; MAPPY uses TL, TR, BR, BL (clockwise from top-left).
//   Mat3 = 3×3, ROW-MAJOR: [m00,m01,m02, m10,m11,m12, m20,m21,m22], so a point
//          maps as x' = (m00 x + m01 y + m02) / (m20 x + m21 y + m22), etc.

export type Vec2 = readonly [number, number];
export type Quad = readonly [Vec2, Vec2, Vec2, Vec2];
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];

/** The unit square in MAPPY corner order (TL, TR, BR, BL). */
export const UNIT_QUAD: Quad = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Solve the homography mapping `src` → `dst` (4 correspondences) via the
 *  standard DLT: an 8×8 linear system (with m22 fixed to 1) solved by Gaussian
 *  elimination with partial pivoting. Returns row-major Mat3. */
export function solveHomography(src: Quad, dst: Quad): Mat3 {
  // 8 equations (2 per point): for (sx,sy)→(dx,dy):
  //   sx·m00 + sy·m01 + m02 − sx·dx·m20 − sy·dx·m21 = dx
  //   sx·m10 + sy·m11 + m12 − sx·dy·m20 − sy·dy·m21 = dy
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [sx, sy] = src[i];
    const [dx, dy] = dst[i];
    A.push([sx, sy, 1, 0, 0, 0, -sx * dx, -sy * dx]);
    b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -sx * dy, -sy * dy]);
    b.push(dy);
  }
  const h = solveLinear(A, b); // length 8
  return [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
}

/** Convenience: unit square → `dst` quad (the canonical MAPPY surface warp). */
export function unitToQuad(dst: Quad): Mat3 {
  return solveHomography(UNIT_QUAD, dst);
}

/** Apply `H` to a point (perspective divide). */
export function applyHomography(H: Mat3, p: Vec2): Vec2 {
  const [x, y] = p;
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

/** 3×3 matrix product A·B (row-major). */
export function multiply3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out as unknown as Mat3;
}

/** Inverse of a 3×3 (adjugate / determinant). Throws on a singular matrix. */
export function invertHomography(H: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    throw new Error('mappy-homography: singular matrix (degenerate quad?)');
  }
  const inv = 1 / det;
  return [
    A * inv,
    -(b * i - c * h) * inv,
    (b * f - c * e) * inv,
    B * inv,
    (a * i - c * g) * inv,
    -(a * f - c * d) * inv,
    C * inv,
    -(a * h - b * g) * inv,
    (a * e - b * d) * inv,
  ];
}

/** Flatten to COLUMN-MAJOR for a GLSL `mat3` uniform (WebGL is column-major). */
export function toColumnMajor(H: Mat3): number[] {
  return [H[0], H[3], H[6], H[1], H[4], H[7], H[2], H[5], H[8]];
}

// --- Gaussian elimination with partial pivoting (n×n) ---
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  // augmented copy
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    // pivot = largest |value| in this column at/below the diagonal
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    }
    if (Math.abs(M[piv]![col]!) < 1e-12) {
      throw new Error('mappy-homography: degenerate correspondence set');
    }
    if (piv !== col) {
      const tmp = M[col]!;
      M[col] = M[piv]!;
      M[piv] = tmp;
    }
    // eliminate below
    const pivVal = M[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const factor = M[r]![col]! / pivVal;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r]![c]! -= factor * M[col]![c]!;
    }
  }
  // back-substitute
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let c = r + 1; c < n; c++) s -= M[r]![c]! * x[c]!;
    x[r] = s / M[r]![r]!;
  }
  return x;
}
