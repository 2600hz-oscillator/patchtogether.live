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
  ORBIT_DIST_MIN,
  ORBIT_DIST_MAX,
  EL_CLAMP,
  LOOK_PITCH_CLAMP,
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

const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('cameraBasis: orbit POSITION (azimuth × elevation × distance)', () => {
  // A neutral orbit pose (front, level, mid distance) the tests vary from.
  const base = { az: 0, el: 0, dist: 2.5, lookYaw: 0, lookPitch: 0, zoom: 0.5 } as const;

  it('az=0, el=0 puts the eye in FRONT (+z), aiming toward −z at the centre', () => {
    const c = cameraBasis(base);
    expect(c.eye[0]).toBeCloseTo(0, 6);
    expect(c.eye[1]).toBeCloseTo(0, 6);
    expect(c.eye[2]).toBeCloseTo(2.5, 6);
    // aim-at-centre ⇒ forward = −eye direction = (0,0,−1)
    expect(c.forward[0]).toBeCloseTo(0, 6);
    expect(c.forward[1]).toBeCloseTo(0, 6);
    expect(c.forward[2]).toBeCloseTo(-1, 6);
  });

  it('the eye rides a sphere of radius `dist` around the pool centre', () => {
    for (const p of [
      { ...base, az: 0.7, el: 0.3 },
      { ...base, az: -2.1, el: -0.8, dist: 3.2 },
      { ...base, az: 1.9, el: 1.2, dist: 1.0 },
    ]) {
      const c = cameraBasis(p);
      const r = Math.hypot(c.eye[0], c.eye[1], c.eye[2]);
      expect(r).toBeCloseTo(Math.min(ORBIT_DIST_MAX, Math.max(ORBIT_DIST_MIN, p.dist)), 6);
    }
  });

  it('positive elevation lifts the eye ABOVE the water plane; negative drops it BELOW (underwater)', () => {
    expect(cameraBasis({ ...base, el: 0.9 }).eye[1]).toBeGreaterThan(0);
    const under = cameraBasis({ ...base, el: -0.9 });
    expect(under.eye[1]).toBeLessThan(0); // below the surface ⇒ underwater view
  });

  it('azimuth orbits the eye around the vertical axis (y unchanged at fixed el)', () => {
    const front = cameraBasis({ ...base, az: 0 }).eye;
    const side = cameraBasis({ ...base, az: Math.PI / 2 }).eye;
    // az=+90° swings the eye onto +x, leaving +z, at the same height.
    expect(side[0]).toBeCloseTo(2.5, 6);
    expect(side[2]).toBeCloseTo(0, 6);
    expect(side[1]).toBeCloseTo(front[1], 6);
  });

  it('clamps distance into [ORBIT_DIST_MIN, ORBIT_DIST_MAX]', () => {
    expect(Math.hypot(...cameraBasis({ ...base, dist: 99 }).eye)).toBeCloseTo(ORBIT_DIST_MAX, 6);
    expect(Math.hypot(...cameraBasis({ ...base, dist: -5 }).eye)).toBeCloseTo(ORBIT_DIST_MIN, 6);
  });

  it('clamps elevation to ±EL_CLAMP (never the exact vertical pole)', () => {
    const up = cameraBasis({ ...base, el: Math.PI }); // asks for straight overhead
    // |eye.y| = dist·sin(EL_CLAMP) < dist (a true pole would give |eye.y| = dist)
    expect(Math.abs(up.eye[1])).toBeLessThan(2.5);
    expect(up.eye[1]).toBeCloseTo(2.5 * Math.sin(EL_CLAMP), 6);
  });
});

describe('cameraBasis: free-LOOK offset (yaw × pitch) + framing', () => {
  const base = { az: 0, el: 0.5, dist: 2.5, lookYaw: 0, lookPitch: 0, zoom: 0.5 } as const;

  it('lookYaw=lookPitch=0 AIMS AT THE POOL CENTRE (forward = −eye direction)', () => {
    const c = cameraBasis(base);
    const aim = [-c.eye[0], -c.eye[1], -c.eye[2]];
    const l = Math.hypot(aim[0], aim[1], aim[2]);
    expect(c.forward[0]).toBeCloseTo(aim[0] / l, 6);
    expect(c.forward[1]).toBeCloseTo(aim[1] / l, 6);
    expect(c.forward[2]).toBeCloseTo(aim[2] / l, 6);
  });

  it('lookYaw rotates the view horizontally away from the centre-aim', () => {
    const aim = cameraBasis(base);
    const yawed = cameraBasis({ ...base, lookYaw: 0.6 });
    // The view direction changed (no longer aims at centre).
    const cosAngle = dot3(aim.forward, yawed.forward);
    expect(cosAngle).toBeLessThan(0.9999);
    // A pure horizontal yaw off a level-ish aim mostly swings the forward's x/z.
    expect(yawed.forward[0]).not.toBeCloseTo(aim.forward[0], 3);
  });

  it('lookPitch>0 lifts the view UP relative to the centre-aim', () => {
    const aim = cameraBasis(base);
    const up = cameraBasis({ ...base, lookPitch: 0.7 });
    expect(up.forward[1]).toBeGreaterThan(aim.forward[1]);
  });

  it('clamps lookPitch to ±LOOK_PITCH_CLAMP', () => {
    const a = cameraBasis({ ...base, lookPitch: 9 });
    const b = cameraBasis({ ...base, lookPitch: LOOK_PITCH_CLAMP });
    for (let i = 0; i < 3; i++) expect(a.forward[i]).toBeCloseTo(b.forward[i], 6);
  });

  it('zoom maps to a narrowing FOV (70°→20°) with an orthonormal basis', () => {
    const wide = cameraBasis({ ...base, zoom: 0 });
    const tight = cameraBasis({ ...base, zoom: 1 });
    expect(wide.fovY).toBeGreaterThan(tight.fovY);
    expect(tight.fovY).toBeCloseTo((20 * Math.PI) / 180, 6);
    for (const c of [wide, tight]) {
      for (const v of [c.forward, c.right, c.up]) {
        expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(1, 6);
      }
      expect(dot3(c.forward, c.right)).toBeCloseTo(0, 6);
      expect(dot3(c.right, c.up)).toBeCloseTo(0, 6);
      expect(dot3(c.forward, c.up)).toBeCloseTo(0, 6);
    }
  });

  it('the default framing keeps the pool below the eye (above-water, looking down)', () => {
    // az=0, el>0 default ⇒ eye above +z, forward aims down at the centre.
    const c = cameraBasis({ az: 0, el: 0.55, dist: 2.6, lookYaw: 0, lookPitch: 0, zoom: 0.5 });
    expect(c.eye[1]).toBeGreaterThan(0);       // above the water
    expect(c.forward[1]).toBeLessThan(0);      // looking DOWN onto the pool
    void POOL_RADIUS;
  });
});
