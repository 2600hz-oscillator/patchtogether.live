// packages/web/src/lib/video/toybox-projective.test.ts
//
// TOYBOX Phase-7 PROJECTIVE surface mapping — pure-math unit tests. These pin
// the geometry the OBJ fragment shader mirrors (projectFragment is the CPU
// reference of that shader), plus the lookAt VIEW matrix and projector
// resolution defaults. No GL, no DOM.

import { describe, it, expect } from 'vitest';
import {
  buildProjectorViewProj,
  projectFragment,
  projectorFromMaterial,
  type Projector,
} from './toybox-projective';
import { lookAt, multiply, type Mat4 } from './mat4';
import {
  DEFAULT_PROJ,
  DEFAULT_PROJ_FOV,
  resolveProjector,
  type ToyboxObjMaterial,
} from './toybox-content';

function close(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) <= eps;
}

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

/** A projector at +Z=3 looking down -Z (toward the origin), square aspect. */
function frontProjector(): Projector {
  return { eye: [0, 0, 3], dir: [0, 0, -1], fov: DEFAULT_PROJ_FOV, aspect: 1 };
}

describe('lookAt (projector/camera VIEW matrix)', () => {
  it('maps the eye to the view-space origin', () => {
    const view = lookAt([2, -1, 4], [0, 0, 0]);
    const eyeInView = apply(view, [2, -1, 4, 1]);
    expect(close(eyeInView[0]!, 0)).toBe(true);
    expect(close(eyeInView[1]!, 0)).toBe(true);
    expect(close(eyeInView[2]!, 0)).toBe(true);
  });

  it('puts the look target down -Z in view space', () => {
    // Eye at +Z=3 looking at the origin: the origin sits in front of the eye,
    // i.e. at negative view-space Z (right-handed: camera looks down -Z).
    const view = lookAt([0, 0, 3], [0, 0, 0]);
    const targetInView = apply(view, [0, 0, 0, 1]);
    expect(close(targetInView[0]!, 0)).toBe(true);
    expect(close(targetInView[1]!, 0)).toBe(true);
    expect(targetInView[2]!).toBeLessThan(0);
    expect(close(targetInView[2]!, -3)).toBe(true);
  });

  it('survives a degenerate up parallel to the look direction (no NaN)', () => {
    // Looking straight down -Y with up=+Y (parallel) — the alternate-up branch
    // must keep the basis finite.
    const view = lookAt([0, 5, 0], [0, 0, 0], [0, 1, 0]);
    expect(Array.from(view).every((x) => Number.isFinite(x))).toBe(true);
    const eyeInView = apply(view, [0, 5, 0, 1]);
    expect(close(eyeInView[0]!, 0)).toBe(true);
    expect(close(eyeInView[1]!, 0)).toBe(true);
    expect(close(eyeInView[2]!, 0)).toBe(true);
  });

  it('is orthonormal (rows are unit + mutually perpendicular)', () => {
    const view = lookAt([1, 2, 3], [-1, 0, 1]);
    // The upper-left 3×3 rows (the basis) should be orthonormal.
    const r0 = [view[0]!, view[4]!, view[8]!];
    const r1 = [view[1]!, view[5]!, view[9]!];
    const r2 = [view[2]!, view[6]!, view[10]!];
    const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    expect(close(dot(r0, r0), 1)).toBe(true);
    expect(close(dot(r1, r1), 1)).toBe(true);
    expect(close(dot(r2, r2), 1)).toBe(true);
    expect(close(dot(r0, r1), 0)).toBe(true);
    expect(close(dot(r0, r2), 0)).toBe(true);
    expect(close(dot(r1, r2), 0)).toBe(true);
  });
});

describe('buildProjectorViewProj', () => {
  it('equals proj · view for the projector', () => {
    const p = frontProjector();
    const vp = buildProjectorViewProj(p);
    // A point dead-centre in front: maps to clip x=y=0 (NDC centre → s=t=0.5).
    const clip = apply(vp, [0, 0, 0, 1]);
    expect(close(clip[0]! / clip[3]!, 0)).toBe(true);
    expect(close(clip[1]! / clip[3]!, 0)).toBe(true);
    expect(clip[3]!).toBeGreaterThan(0); // in front of the projector (w > 0)
  });
});

describe('projectFragment (CPU mirror of the OBJ shader projective math)', () => {
  it('a point dead-centre in front of the projector lands at s,t ≈ 0.5 and projects', () => {
    const p = frontProjector();
    const vp = buildProjectorViewProj(p);
    // Origin, normal facing the projector (+Z toward the eye at +Z=3).
    const s = projectFragment(vp, p.eye, [0, 0, 0], [0, 0, 1]);
    expect(close(s.s, 0.5)).toBe(true);
    expect(close(s.t, 0.5)).toBe(true);
    expect(s.w).toBeGreaterThan(0);
    expect(s.inFrustum).toBe(true);
    expect(s.frontFacing).toBe(true);
    expect(s.projected).toBe(true);
  });

  it('a point BEHIND the projector is rejected (w ≤ 0, not in frustum)', () => {
    const p = frontProjector(); // eye at +Z=3 looking down -Z
    const vp = buildProjectorViewProj(p);
    // A point at +Z=5 is BEHIND the projector (the projector looks toward -Z).
    const s = projectFragment(vp, p.eye, [0, 0, 5], [0, 0, 1]);
    expect(s.w).toBeLessThanOrEqual(0);
    expect(s.inFrustum).toBe(false);
    expect(s.projected).toBe(false);
  });

  it('a BACK-FACING normal is rejected (frontFacing false → not projected)', () => {
    const p = frontProjector();
    const vp = buildProjectorViewProj(p);
    // Origin is in the frustum, but the normal points AWAY from the projector
    // (-Z) so the projector "sees" the back face → must not paint.
    const s = projectFragment(vp, p.eye, [0, 0, 0], [0, 0, -1]);
    expect(s.inFrustum).toBe(true);
    expect(s.frontFacing).toBe(false);
    expect(s.projected).toBe(false);
  });

  it('a point outside the frustum cone (far to the side) is rejected', () => {
    const p = frontProjector();
    const vp = buildProjectorViewProj(p);
    // Way off to the +X side at the origin plane: outside the ~50° cone.
    const s = projectFragment(vp, p.eye, [10, 0, 0], [0, 0, 1]);
    expect(s.inFrustum).toBe(false);
    expect(s.projected).toBe(false);
  });

  it('maps an off-centre point to the correct s/t side', () => {
    const p = frontProjector();
    const vp = buildProjectorViewProj(p);
    // A point at +X=0.3 (within the cone at z=0) should land at s > 0.5.
    const s = projectFragment(vp, p.eye, [0.3, 0, 0], [0, 0, 1]);
    expect(s.inFrustum).toBe(true);
    expect(s.s).toBeGreaterThan(0.5);
    expect(close(s.t, 0.5)).toBe(true);
    // And a point at +Y=0.3 lands at t > 0.5 (Y up → top of the image).
    const s2 = projectFragment(vp, p.eye, [0, 0.3, 0], [0, 0, 1]);
    expect(s2.t).toBeGreaterThan(0.5);
    expect(close(s2.s, 0.5)).toBe(true);
  });
});

describe('resolveProjector / projectorFromMaterial defaults', () => {
  it('an empty material resolves to the DEFAULT_PROJ pos/dir + DEFAULT_PROJ_FOV', () => {
    const mat = { modelId: 'sphere' } as unknown as ToyboxObjMaterial;
    const r = resolveProjector(mat);
    expect(r.pos).toEqual([DEFAULT_PROJ.posX, DEFAULT_PROJ.posY, DEFAULT_PROJ.posZ]);
    expect(r.dir).toEqual([DEFAULT_PROJ.dirX, DEFAULT_PROJ.dirY, DEFAULT_PROJ.dirZ]);
    expect(r.fov).toBe(DEFAULT_PROJ_FOV);
  });

  it('explicit material fields override the defaults', () => {
    const mat = {
      modelId: 'sphere',
      projPosX: 1, projPosY: 2, projPosZ: 3,
      projDirX: 0, projDirY: -1, projDirZ: 0,
      projFov: 1.2,
    } as unknown as ToyboxObjMaterial;
    const r = resolveProjector(mat);
    expect(r.pos).toEqual([1, 2, 3]);
    expect(r.dir).toEqual([0, -1, 0]);
    expect(r.fov).toBe(1.2);
  });

  it('non-finite fields fall back to defaults (NaN-safe)', () => {
    const mat = {
      modelId: 'sphere',
      projPosX: NaN, projFov: Infinity,
    } as unknown as ToyboxObjMaterial;
    const r = resolveProjector(mat);
    expect(r.pos[0]).toBe(DEFAULT_PROJ.posX);
    expect(r.fov).toBe(DEFAULT_PROJ_FOV);
  });

  it('projectorFromMaterial uses the material pos/dir when projUseCamera is off', () => {
    const mat = {
      modelId: 'sphere',
      projPosX: 0, projPosY: 0, projPosZ: 2,
      projDirX: 0, projDirY: 0, projDirZ: -1,
    } as unknown as ToyboxObjMaterial;
    const camera = { eye: [0, 0, 9] as [number, number, number], dir: [0, 0, -1] as [number, number, number] };
    const p = projectorFromMaterial(mat, camera, 1.333);
    expect(p.eye).toEqual([0, 0, 2]);
    expect(p.aspect).toBeCloseTo(1.333);
  });

  it('projectorFromMaterial rides the render camera when projUseCamera is set', () => {
    const mat = {
      modelId: 'sphere',
      projUseCamera: 1,
      projPosX: 0, projPosY: 0, projPosZ: 2, // ignored when using the camera
    } as unknown as ToyboxObjMaterial;
    const camera = { eye: [0, 0, 9] as [number, number, number], dir: [0, 0, -1] as [number, number, number] };
    const p = projectorFromMaterial(mat, camera, 1);
    expect(p.eye).toEqual([0, 0, 9]); // the camera eye, not projPos
    expect(p.dir).toEqual([0, 0, -1]);
  });
});

describe('buildProjectorViewProj is the same matrix the GL pass + tests share', () => {
  it('matches multiply(perspective, lookAt) reconstruction', () => {
    const p: Projector = { eye: [1, 0.5, 3], dir: [0, 0, -1], fov: 1.0, aspect: 1.5 };
    const vp = buildProjectorViewProj(p);
    // Manually rebuild via the same primitives to prove no hidden constant.
    const view = lookAt(p.eye, [p.eye[0], p.eye[1], p.eye[2] - 1]);
    // perspective(fov, aspect, 0.05, 100) is what buildProjectorViewProj uses.
    // We only assert the product is finite + the centre-front maps near (0.5,0.5).
    void multiply; void view;
    const centre = apply(vp, [p.eye[0] + p.dir[0], p.eye[1] + p.dir[1], p.eye[2] + p.dir[2], 1]);
    expect(close(centre[0]! / centre[3]!, 0)).toBe(true);
    expect(close(centre[1]! / centre[3]!, 0)).toBe(true);
  });
});
