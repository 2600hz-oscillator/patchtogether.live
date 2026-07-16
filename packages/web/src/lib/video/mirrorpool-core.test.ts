// packages/web/src/lib/video/mirrorpool-core.test.ts
//
// Pure-unit coverage for the MIRRORPOOL physics core — the algebra the GLSL
// shader mirrors, verified outside WebGL (jsdom can't render). Locks the
// adversarial-review fixes: normal sign convention (#1), single brightness
// path is a shader concern, Mirror ceiling (#7), world-scale slopes (#4),
// one-shot deterministic rain (#6), CFL clamp, camera clamps.

import { describe, it, expect } from 'vitest';
import {
  schlickFresnel,
  surfaceReflectivity,
  heightToNormal,
  swellField,
  clampCfl,
  rainLambda,
  dropAmplitude,
  spawnDrops,
  cameraBasis,
  WATER_F0,
  WATER_ETA,
  CAM_BOX,
  TILT_CLAMP,
  CAM_POS_REACH,
  POOL_RADIUS,
} from './mirrorpool-core';

describe('optics: Schlick Fresnel', () => {
  it('equals F0 at normal incidence and → 1 at grazing', () => {
    expect(schlickFresnel(1)).toBeCloseTo(WATER_F0, 6);
    expect(schlickFresnel(0)).toBeCloseTo(1, 6);
  });
  it('F0 ≈ 0.02 (water) and ETA ≈ 0.7519', () => {
    expect(WATER_F0).toBeCloseTo(0.0201, 3);
    expect(WATER_ETA).toBeCloseTo(0.7519, 4);
  });
  it('is monotonic decreasing in cosTheta', () => {
    let prev = Infinity;
    for (let c = 0; c <= 1.00001; c += 0.05) {
      const f = schlickFresnel(c);
      expect(f).toBeLessThanOrEqual(prev + 1e-9);
      prev = f;
    }
  });
});

describe('surfaceReflectivity: Refract↔Mirror blend', () => {
  it('mode=0 is the raw Fresnel term', () => {
    for (const F of [0.02, 0.2, 0.6, 0.95]) {
      expect(surfaceReflectivity(F, 0)).toBeCloseTo(F, 6);
    }
  });
  it('mode=1 is a near-full mirror even at normal incidence (>0.98, review #7)', () => {
    // At normal incidence F≈0.02: old design bled ~15% pool; new ceiling ≥0.98.
    expect(surfaceReflectivity(0.02, 1)).toBeGreaterThan(0.98);
  });
  it('is monotonic in the mode scalar', () => {
    const F = 0.05;
    let prev = -Infinity;
    for (let m = 0; m <= 1.00001; m += 0.1) {
      const r = surfaceReflectivity(F, m);
      expect(r).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = r;
    }
  });
});

describe('heightToNormal: sign convention (review #1)', () => {
  it('flat field → straight up', () => {
    const [nx, ny, nz] = heightToNormal(0, 0);
    expect(nx).toBeCloseTo(0, 12);
    expect(ny).toBe(1);
    expect(nz).toBeCloseTo(0, 12);
  });
  it('a surface rising toward +x tilts its normal toward −x', () => {
    const [nx, ny, nz] = heightToNormal(0.5, 0);
    expect(nx).toBeLessThan(0);
    expect(ny).toBeGreaterThan(0);
    expect(nz).toBeCloseTo(0, 12);
  });
  it('a surface rising toward +z tilts its normal toward −z', () => {
    const [nx, , nz] = heightToNormal(0, 0.5);
    expect(nx).toBeCloseTo(0, 12);
    expect(nz).toBeLessThan(0);
  });
  it('returns a unit vector', () => {
    const n = heightToNormal(0.3, -0.7);
    expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 6);
  });
});

describe('swellField: bigger ripples are taller/faster', () => {
  it('windSpeed 0 → flat', () => {
    const s = swellField(0.3, -0.2, 0.7, 0, 1.1);
    expect(s.height).toBe(0);
    expect(s.dhdx).toBe(0);
    expect(s.dhdz).toBe(0);
  });
  it('gradient sign matches heightToNormal convention (same +∂h/∂x)', () => {
    // Numerically differentiate the height to confirm dhdx sign/magnitude.
    const eps = 1e-4;
    const args = [0.11, -0.07, 0.4, 0.8, 0.6] as const;
    const h0 = swellField(args[0], args[1], args[2], args[3], args[4]).height;
    const hx = swellField(args[0] + eps, args[1], args[2], args[3], args[4]).height;
    const numeric = (hx - h0) / eps;
    const analytic = swellField(args[0], args[1], args[2], args[3], args[4]).dhdx;
    expect(analytic).toBeCloseTo(numeric, 2);
  });
  it('taller amplitude does not blow up the per-wave slope (review #4)', () => {
    // Amplitude ∝ wavelength keeps A·k wavelength-independent, so the summed
    // world slope stays in a believable band (< ~0.4 ⇒ ~22°) at full wind.
    let maxSlope = 0;
    for (let x = -1; x <= 1; x += 0.13) {
      for (let z = -1; z <= 1; z += 0.13) {
        const s = swellField(x, z, 0.5, 1, 3.3);
        maxSlope = Math.max(maxSlope, Math.hypot(s.dhdx, s.dhdz));
      }
    }
    expect(maxSlope).toBeLessThan(0.5);
    expect(maxSlope).toBeGreaterThan(0.05); // but not degenerate/flat
  });
});

describe('clampCfl', () => {
  it('clamps into the stable [0, 0.49] band', () => {
    expect(clampCfl(0.24)).toBe(0.24);
    expect(clampCfl(5)).toBe(0.49);
    expect(clampCfl(-1)).toBe(0);
    expect(clampCfl(NaN)).toBe(0);
  });
});

describe('rain scheduler', () => {
  it('rainLambda is 0 at rain 0 and rises monotonically', () => {
    expect(rainLambda(0)).toBe(0);
    let prev = -1;
    for (let r = 0; r <= 1.0001; r += 0.1) {
      const l = rainLambda(r);
      expect(l).toBeGreaterThanOrEqual(prev);
      prev = l;
    }
    expect(rainLambda(1)).toBeGreaterThan(rainLambda(0.5));
  });
  it('dropAmplitude is a downward impulse that deepens with intensity', () => {
    expect(dropAmplitude(0.1, 0.5)).toBeLessThan(0);
    expect(Math.abs(dropAmplitude(1, 0.5))).toBeGreaterThan(Math.abs(dropAmplitude(0.1, 0.5)));
  });
  it('spawnDrops is deterministic in (rain, seed, frame)', () => {
    const a = spawnDrops(0.6, 42, 7);
    const b = spawnDrops(0.6, 42, 7);
    expect(a).toEqual(b);
  });
  it('a different seed OR frame yields a different stream', () => {
    const base = JSON.stringify(spawnDrops(0.6, 42, 7));
    expect(JSON.stringify(spawnDrops(0.6, 43, 7))).not.toBe(base);
    expect(JSON.stringify(spawnDrops(0.6, 42, 8))).not.toBe(base);
  });
  it('rain 0 spawns nothing; drops land inside the pool disk', () => {
    expect(spawnDrops(0, 1, 1)).toEqual([]);
    for (let f = 0; f < 40; f++) {
      for (const d of spawnDrops(1, 9, f)) {
        const r = Math.hypot(d.x - 0.5, d.y - 0.5);
        expect(r).toBeLessThan(0.5);
      }
    }
  });
  it('respects the impact cap', () => {
    for (let f = 0; f < 60; f++) {
      expect(spawnDrops(1, 3, f, 12).length).toBeLessThanOrEqual(12);
    }
  });
});

describe('cameraBasis: PTZ clamps + gimbal safety', () => {
  it('pan=0, tilt=0 looks along −z', () => {
    const c = cameraBasis({ camX: 0, camY: 1, camZ: 1, pan: 0, tilt: 0, zoom: 0.5 });
    expect(c.forward[0]).toBeCloseTo(0, 6);
    expect(c.forward[1]).toBeCloseTo(0, 6);
    expect(c.forward[2]).toBeCloseTo(-1, 6);
  });
  it('clamps the eye into the camera box', () => {
    const c = cameraBasis({ camX: 99, camY: -99, camZ: 99, pan: 0, tilt: 0, zoom: 0 });
    expect(c.eye[0]).toBe(CAM_BOX.x[1]);
    expect(c.eye[1]).toBe(CAM_BOX.y[0]);
    expect(c.eye[2]).toBe(CAM_BOX.z[1]);
  });
  it('clamps tilt to ±TILT_CLAMP (no straight-down gimbal)', () => {
    const c = cameraBasis({ camX: 0, camY: 1, camZ: 1, pan: 0, tilt: -Math.PI, zoom: 0 });
    // forward.y = sin(clampedTilt) — must not reach the straight-down −1.
    expect(c.forward[1]).toBeGreaterThan(Math.sin(-TILT_CLAMP) - 1e-6);
    expect(c.forward[1]).toBeCloseTo(Math.sin(-TILT_CLAMP), 6);
  });
  it('zoom maps to a narrowing FOV (70°→20°) with orthonormal basis', () => {
    const wide = cameraBasis({ camX: 0, camY: 1, camZ: 1, pan: 0.3, tilt: -0.4, zoom: 0 });
    const tight = cameraBasis({ camX: 0, camY: 1, camZ: 1, pan: 0.3, tilt: -0.4, zoom: 1 });
    expect(wide.fovY).toBeGreaterThan(tight.fovY);
    expect(tight.fovY).toBeCloseTo((20 * Math.PI) / 180, 6);
    // basis orthonormal
    for (const v of [wide.forward, wide.right, wide.up]) {
      expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(1, 6);
    }
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(dot(wide.forward, wide.right)).toBeCloseTo(0, 6);
    expect(dot(wide.right, wide.up)).toBeCloseTo(0, 6);
  });
});

describe('cameraBasis: bipolar POSITION translates the eye (±2R)', () => {
  const R = POOL_RADIUS;
  // A canonical mid-box PTZ eye the position tests translate from.
  const base = { camX: 0, camY: 1.3, camZ: 1.6, pan: 0, tilt: -0.6, zoom: 0.5 } as const;

  it('the reach constant is 2R (2 pool-radii = 10 ft, pool being 5 ft in radius)', () => {
    expect(CAM_POS_REACH).toBeCloseTo(2 * R, 12);
  });

  it('default position (0,0,0) leaves the eye exactly at the PTZ eye', () => {
    const ptz = cameraBasis(base);
    const withZero = cameraBasis({ ...base, posX: 0, posY: 0, posZ: 0 });
    expect(withZero.eye[0]).toBeCloseTo(ptz.eye[0], 12);
    expect(withZero.eye[1]).toBeCloseTo(ptz.eye[1], 12);
    expect(withZero.eye[2]).toBeCloseTo(ptz.eye[2], 12);
    // Omitting the fields entirely (back-compat PTZ-only caller) is identical.
    expect(cameraBasis(base).eye).toEqual(ptz.eye);
  });

  it('full-scale on each axis shifts the eye by exactly ±2R (and no other axis)', () => {
    const ptz = cameraBasis(base).eye;
    const px = cameraBasis({ ...base, posX: 1 }).eye;
    expect(px[0] - ptz[0]).toBeCloseTo(2 * R, 12); // +2R on x
    expect(px[1]).toBeCloseTo(ptz[1], 12);
    expect(px[2]).toBeCloseTo(ptz[2], 12);

    const nz = cameraBasis({ ...base, posZ: -1 }).eye;
    expect(nz[2] - ptz[2]).toBeCloseTo(-2 * R, 12); // −2R on z
    expect(nz[0]).toBeCloseTo(ptz[0], 12);
    expect(nz[1]).toBeCloseTo(ptz[1], 12);
  });

  it('pos_y=+1 lifts the eye above the water plane (y>0) by ~2R and still looks DOWN', () => {
    // Start from the lowest PTZ height (clamps to CAM_BOX.y[0]=0.15) so the lift
    // is measured from just above the surface: 0.15 + 2R ≈ 2R above y=0.
    const low = { ...base, camY: 0 } as const; // clamps to 0.15
    const lifted = cameraBasis({ ...low, posY: 1 });
    expect(lifted.eye[1]).toBeGreaterThan(0);            // above the water plane
    expect(lifted.eye[1]).toBeCloseTo(CAM_BOX.y[0] + 2 * R, 6);
    expect(lifted.eye[1]).toBeGreaterThan(2 * R - 0.2);  // ~2R above the surface
    // PTZ still orients: default tilt is negative → forward points DOWN onto
    // the water even though the eye moved up. Position does NOT re-aim.
    expect(lifted.forward[1]).toBeLessThan(0);
  });

  it('position moves ONLY the eye — orientation stays PTZ-derived (unchanged)', () => {
    const ptz = cameraBasis(base);
    const moved = cameraBasis({ ...base, posX: -0.7, posY: 0.9, posZ: 0.3 });
    for (const key of ['forward', 'right', 'up'] as const) {
      for (let i = 0; i < 3; i++) {
        expect(moved[key][i]).toBeCloseTo(ptz[key][i], 12);
      }
    }
    expect(moved.tanHalf).toBeCloseTo(ptz.tanHalf, 12);
    // But the eye actually moved.
    expect(moved.eye[1]).toBeGreaterThan(ptz.eye[1]);
  });

  it('caps the mapped translation at ±2R (a hot CV cannot fling the eye further)', () => {
    const ptz = cameraBasis(base).eye;
    const overX = cameraBasis({ ...base, posX: 5 }).eye;   // clamps to +1 → +2R
    const overY = cameraBasis({ ...base, posY: -9 }).eye;  // clamps to −1 → −2R
    expect(overX[0] - ptz[0]).toBeCloseTo(2 * R, 12);
    expect(overY[1] - ptz[1]).toBeCloseTo(-2 * R, 12);
  });

  it('position can carry the eye OUT of CAM_BOX (above the y=2.2 ceiling)', () => {
    // From the top of the box (camY=99 clamps to 2.2), +2R lifts well past it.
    const high = cameraBasis({ ...base, camY: 99, posY: 1 }).eye;
    expect(high[1]).toBeGreaterThan(CAM_BOX.y[1]);
    expect(high[1]).toBeCloseTo(CAM_BOX.y[1] + 2 * R, 6);
  });
});
