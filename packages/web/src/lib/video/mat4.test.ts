// packages/web/src/lib/video/mat4.test.ts
import { describe, it, expect } from 'vitest';
import {
  identity,
  multiply,
  perspective,
  translation,
  scaling,
  rotationX,
  rotationY,
  rotationZ,
  modelMatrix,
  normalMatrix,
  type Mat4,
} from './mat4';

/** Apply a column-major Mat4 to a column vec4 → vec4. */
function apply(m: Mat4, v: [number, number, number, number]): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let c = 0; c < 4; c++) s += m[c * 4 + r]! * v[c]!;
    out[r] = s;
  }
  return out;
}

function close(a: number, b: number, eps = 1e-5): boolean {
  return Math.abs(a - b) <= eps;
}

describe('mat4 identity', () => {
  it('is the 4×4 identity', () => {
    const m = identity();
    expect(Array.from(m)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });
  it('leaves vectors unchanged', () => {
    const v = apply(identity(), [3, -2, 5, 1]);
    expect(v).toEqual([3, -2, 5, 1]);
  });
});

describe('mat4 multiply', () => {
  it('I·A = A and A·I = A', () => {
    const a = modelMatrix(0.3, -0.7, 1.1, 2, 1, 2, 3);
    const ia = multiply(identity(), a);
    const ai = multiply(a, identity());
    for (let i = 0; i < 16; i++) {
      expect(close(ia[i]!, a[i]!)).toBe(true);
      expect(close(ai[i]!, a[i]!)).toBe(true);
    }
  });

  it('composes T·S so S is applied first (right-to-left)', () => {
    const t = translation(10, 0, 0);
    const s = scaling(2, 2, 2);
    // (T·S)·v scales v then translates. v=(1,0,0,1) → (2,0,0,1) → (12,0,0,1).
    const ts = multiply(t, s);
    expect(apply(ts, [1, 0, 0, 1])).toEqual([12, 0, 0, 1]);
    // (S·T)·v translates then scales: (1,0,0,1)→(11,0,0,1)→(22,0,0,1).
    const st = multiply(s, t);
    expect(apply(st, [1, 0, 0, 1])).toEqual([22, 0, 0, 1]);
  });

  it('matches a hand-computed product', () => {
    // A = scale(2,3,4), B = translate(1,1,1). A·B applied to (0,0,0,1) = (2,3,4,1).
    const ab = multiply(scaling(2, 3, 4), translation(1, 1, 1));
    expect(apply(ab, [0, 0, 0, 1])).toEqual([2, 3, 4, 1]);
  });
});

describe('mat4 rotations', () => {
  it('rotateX 90° sends +Y → +Z', () => {
    const r = rotationX(Math.PI / 2);
    const v = apply(r, [0, 1, 0, 1]);
    expect(close(v[0]!, 0)).toBe(true);
    expect(close(v[1]!, 0)).toBe(true);
    expect(close(v[2]!, 1)).toBe(true);
  });
  it('rotateY 90° sends +Z → +X', () => {
    const r = rotationY(Math.PI / 2);
    const v = apply(r, [0, 0, 1, 1]);
    expect(close(v[0]!, 1)).toBe(true);
    expect(close(v[2]!, 0)).toBe(true);
  });
  it('rotateZ 90° sends +X → +Y', () => {
    const r = rotationZ(Math.PI / 2);
    const v = apply(r, [1, 0, 0, 1]);
    expect(close(v[0]!, 0)).toBe(true);
    expect(close(v[1]!, 1)).toBe(true);
  });
  it('rotation preserves length', () => {
    const r = multiply(rotationX(0.6), multiply(rotationY(1.2), rotationZ(-0.3)));
    const v = apply(r, [1, 2, -2, 1]);
    const len = Math.hypot(v[0]!, v[1]!, v[2]!);
    expect(close(len, Math.hypot(1, 2, -2))).toBe(true);
  });
});

describe('mat4 perspective', () => {
  it('produces the canonical projection layout (col-major)', () => {
    const fov = Math.PI / 3;
    const aspect = 16 / 9;
    const near = 0.1;
    const far = 100;
    const m = perspective(fov, aspect, near, far);
    const f = 1 / Math.tan(fov / 2);
    expect(close(m[0]!, f / aspect)).toBe(true);
    expect(close(m[5]!, f)).toBe(true);
    expect(close(m[10]!, (far + near) / (near - far))).toBe(true);
    expect(m[11]).toBe(-1); // perspective divide row
    expect(close(m[14]!, (2 * far * near) / (near - far))).toBe(true);
    expect(m[15]).toBe(0);
  });
  it('maps the near plane to NDC z = -1', () => {
    const near = 0.5;
    const m = perspective(Math.PI / 2, 1, near, 50);
    // A point on the near plane (looking down -Z): z = -near.
    const clip = apply(m, [0, 0, -near, 1]);
    const ndcZ = clip[2]! / clip[3]!;
    expect(close(ndcZ, -1)).toBe(true);
  });
  it('maps the far plane to NDC z = +1', () => {
    const far = 50;
    const m = perspective(Math.PI / 2, 1, 0.5, far);
    const clip = apply(m, [0, 0, -far, 1]);
    const ndcZ = clip[2]! / clip[3]!;
    expect(close(ndcZ, 1)).toBe(true);
  });
});

describe('normalMatrix', () => {
  it('equals the rotation for a pure rotation', () => {
    const r = rotationY(0.9);
    const n = normalMatrix(r);
    // upper-left 3×3 of r, column-major.
    const expected = [r[0]!, r[1]!, r[2]!, r[4]!, r[5]!, r[6]!, r[8]!, r[9]!, r[10]!];
    for (let i = 0; i < 9; i++) expect(close(n[i]!, expected[i]!)).toBe(true);
  });

  it('keeps normals perpendicular under non-uniform scale', () => {
    // Scale x by 4: a surface normal that was (1,0,0) on a face whose tangent
    // is (0,1,0) must stay perpendicular to the (scaled) tangent.
    const model = scaling(4, 1, 1);
    const n = normalMatrix(model);
    // Transform normal (0,1,0): with scale x4 on x, an inverse-transpose
    // shrinks x; normal (0,1,0) is unaffected (no x-component) → stays (0,1,0).
    const tn = [
      n[0]! * 0 + n[3]! * 1 + n[6]! * 0,
      n[1]! * 0 + n[4]! * 1 + n[7]! * 0,
      n[2]! * 0 + n[5]! * 1 + n[8]! * 0,
    ];
    expect(close(tn[0]!, 0)).toBe(true);
    expect(close(tn[1]!, 1)).toBe(true);
    // A normal originally (1,0,0) should map to (0.25,0,0) (inverse-transpose
    // of diag(4,1,1) is diag(1/4,1,1)).
    const tx = [n[0]! * 1, n[1]! * 1, n[2]! * 1];
    expect(close(tx[0]!, 0.25)).toBe(true);
  });

  it('falls back gracefully on a singular matrix', () => {
    const m = scaling(0, 0, 0); // determinant 0
    const n = normalMatrix(m);
    expect(n.length).toBe(9);
    expect(Array.from(n).every((x) => Number.isFinite(x))).toBe(true);
  });
});

describe('modelMatrix', () => {
  it('with no rotation is scale-then-translate', () => {
    const m = modelMatrix(0, 0, 0, 3, 5, 6, 7);
    // (1,1,1) → scale*3 → (3,3,3) → +T → (8,9,10).
    expect(apply(m, [1, 1, 1, 1])).toEqual([8, 9, 10, 1]);
  });
  it('translation column holds the translation', () => {
    const m = modelMatrix(0.5, 0.5, 0.5, 2, 11, 22, 33);
    expect(close(m[12]!, 11)).toBe(true);
    expect(close(m[13]!, 22)).toBe(true);
    expect(close(m[14]!, 33)).toBe(true);
  });
});
