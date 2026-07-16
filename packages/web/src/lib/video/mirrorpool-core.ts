// packages/web/src/lib/video/mirrorpool-core.ts
//
// MIRRORPOOL — pure, off-GL physics core (jsdom-testable; the GLSL shader in
// mirrorpool.ts mirrors these exact functions so the algebra is verified
// outside WebGL, which jsdom can't render). NOTHING in here touches `gl`.
//
// The module is a hemisphere pool of liquid in a box, viewed by a full-PTZ
// camera. A real height field (wind-driven swell + one-shot rain-impact
// impulses) drives a single composite surface NORMAL, which in turn drives a
// Schlick Fresnel reflect/refract split (Refract mode) blended toward a
// near-full mirror (Mirror mode). This file owns the CPU-side maths:
//
//   - schlickFresnel / WATER_F0 / WATER_ETA — the optical constants.
//   - surfaceReflectivity — the continuous Refract↔Mirror blend.
//   - heightToNormal — height-field slope → surface normal (ONE sign
//     convention, shared with the analytic swell so the two never cancel;
//     see the adversarial-review fix #1).
//   - swellField — the wind-driven directional wave set with EXACT analytic
//     gradients (amplitude ∝ wavelength ⇒ "bigger ripples are taller/faster";
//     per-wave slope is wavelength-independent, which bounds steepening —
//     review fix #4).
//   - clampCfl — the explicit wave-eq stability clamp (C2 < 0.5).
//   - rainLambda / dropAmplitude / spawnDrops — the deterministic (seeded)
//     Poisson rain scheduler; each drop is a ONE-SHOT velocity impulse
//     (review fix #6), amplitude scaling drizzle→downpour.
//   - cameraBasis — the PTZ camera → ray basis (box-clamped, gimbal-safe).

// ── Geometry constants ────────────────────────────────────────────────────
/** Pool hemisphere radius (unit hemisphere, rim on y=0, pole at y=-1). */
export const POOL_RADIUS = 1;
/** World extent per height-field UV unit. The height field spans the pool
 *  disk [-R,R]² mapped to uv [0,1]², so one uv unit = 2R world units. Used to
 *  convert a texel-space slope into a true (dimensionless) world slope so the
 *  reconstructed normal is physically scaled (review fix #4). */
export const WORLD_SCALE = 2 * POOL_RADIUS;

/** Camera box (AABB) the PTZ eye is clamped into — sits above/around the rim. */
export const CAM_BOX = {
  x: [-1.6, 1.6] as const,
  y: [0.15, 2.2] as const,
  z: [-1.6, 1.6] as const,
};
/** Tilt clamp (±~85°) dodges the straight-down gimbal degeneracy. */
export const TILT_CLAMP = 1.48;

/** Full-scale reach (world units) of each bipolar camera-POSITION axis. The
 *  pool surface is 10 ft across (radius R = 5 ft), so 1 unit of R = 5 ft; the
 *  camera must be able to travel 10 ft (= 2R) from the surface in EVERY
 *  direction, INCLUDING straight up out of the pool. So a normalized pos_* of
 *  ±1 maps to a ±2R world translation of the eye. The translation is CLAMPED
 *  to ±2R (`clamp(pos, -1, 1) · CAM_POS_REACH`) so a hot CV can't fling the
 *  eye arbitrarily far ("don't allow too far"). posY > 0 lifts the eye ABOVE
 *  the water plane (y > 0), out of the pool. */
export const CAM_POS_REACH = 2 * POOL_RADIUS;

// ── Optics ─────────────────────────────────────────────────────────────────
/** Water reflectance at normal incidence: ((1.33-1)/(1.33+1))² ≈ 0.0201. */
export const WATER_F0 = 0.02;
/** Refraction ratio air→water = 1 / 1.33 ≈ 0.7519 (no TIR entering water). */
export const WATER_ETA = 1 / 1.33;

/**
 * Schlick's Fresnel reflectance. Monotonic in the incidence angle: equals
 * `f0` at normal incidence (cosTheta=1) and → 1 at grazing (cosTheta=0).
 * @param cosTheta clamped dot(N, V) ∈ [0,1]
 */
export function schlickFresnel(cosTheta: number, f0: number = WATER_F0): number {
  const c = Math.max(0, Math.min(1, cosTheta));
  return f0 + (1 - f0) * Math.pow(1 - c, 5);
}

/**
 * Continuous Refract↔Mirror blend. `surfaceMode` 0 = pure Fresnel (Refract),
 * 1 = a near-full angle-independent mirror. The mirror ceiling is 0.98 (not
 * 1.0) so a sliver of energy still transmits — but high enough that the pool
 * no longer visibly bleeds through at mode=1 (review fix #7).
 */
export function surfaceReflectivity(fresnel: number, surfaceMode: number): number {
  const m = Math.max(0, Math.min(1, surfaceMode));
  const mirror = fresnel + (1 - fresnel) * 0.98; // = mix(F, 1.0, 0.98)
  return fresnel + (mirror - fresnel) * m;
}

/**
 * Reconstruct the unit surface normal from WORLD-space height-field slopes.
 * `dhdx`/`dhdz` are ∂h/∂x and ∂h/∂z already in world units (the shader
 * converts its texel-space finite differences to world slope by dividing by
 * `2·texel·WORLD_SCALE` BEFORE calling the equivalent line), so N =
 * normalize(-dhdx, 1, -dhdz).
 *
 * SIGN CONVENTION (the review-fix #1 crux): callers pass ∂h/∂x with the
 * SAME sign as {@link swellField} returns (a rising surface toward +x has
 * dhdx > 0), so the sim field and the analytic swell add coherently instead
 * of cancelling. A surface tilting UP toward +x tilts its normal toward −x.
 */
export function heightToNormal(
  dhdx: number,
  dhdz: number,
): [number, number, number] {
  const nx = -dhdx;
  const ny = 1;
  const nz = -dhdz;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

// ── Wind-driven swell (directional wave set) ─────────────────────────────────
export interface SwellSample {
  height: number;
  dhdx: number;
  dhdz: number;
}

/** The 4 base wavelengths (world units) of the directional swell set. Longer
 *  first so the dominant swell is the tallest/fastest. */
const SWELL_WAVELENGTHS = [2.0, 1.3, 0.8, 0.5];
/** Angular spread (radians) of each wave off the wind direction. */
const SWELL_SPREAD = [0, 0.5, -0.35, 0.8];
/** Amplitude-per-wavelength coefficient. Amplitude = A0·windSpeed·λ, so a
 *  wave's slope A·k = A0·windSpeed·2π is WAVELENGTH-INDEPENDENT — bigger
 *  ripples get taller WITHOUT their slope (and hence the normal tilt / mirror
 *  shatter) running away (review fix #4). Kept small so 4 summed waves stay in
 *  a believable slope band (~≤20°). */
const SWELL_A0 = 0.012;
/** Gravity constant for the deep-water dispersion ω = √(g·k) (scaled for look,
 *  not SI — longer waves travel faster, matching real swell). */
const SWELL_G = 3.0;

/**
 * Sum the directional swell height + its EXACT analytic gradient at world
 * point (x,z). Deterministic in (windDir, windSpeed, time). windSpeed 0 ⇒ a
 * flat field.
 */
export function swellField(
  x: number,
  z: number,
  windDir: number,
  windSpeed: number,
  time: number,
): SwellSample {
  const spd = Math.max(0, Math.min(1, windSpeed));
  let height = 0;
  let dhdx = 0;
  let dhdz = 0;
  if (spd <= 0) return { height, dhdx, dhdz };
  for (let i = 0; i < SWELL_WAVELENGTHS.length; i++) {
    const lambda = SWELL_WAVELENGTHS[i];
    const k = (2 * Math.PI) / lambda;
    const omega = Math.sqrt(SWELL_G * k);
    const amp = SWELL_A0 * spd * lambda;
    const ang = windDir + SWELL_SPREAD[i];
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    const phase = k * (dx * x + dz * z) - omega * time + i * 1.7;
    const s = Math.sin(phase);
    const c = Math.cos(phase);
    height += amp * s;
    // ∂/∂x sin(k(dx·x+dz·z) - ωt) = k·dx·cos(...)
    dhdx += amp * k * dx * c;
    dhdz += amp * k * dz * c;
  }
  return { height, dhdx, dhdz };
}

// ── Wave-equation stability ─────────────────────────────────────────────────
/**
 * Clamp the squared Courant number C² = c²·dt²/dx² for the explicit 2D wave
 * integrator to the stable band. CFL for the 2D 5-point Laplacian requires
 * C² < 0.5; we clamp to [0, 0.49] so a CV can never push the sim unstable.
 */
export function clampCfl(c2: number): number {
  if (!Number.isFinite(c2)) return 0;
  return Math.max(0, Math.min(0.49, c2));
}

// ── Rain scheduler (deterministic, seeded) ───────────────────────────────────
export interface RainDrop {
  /** Impact centre in height-field UV space [0,1]². */
  x: number;
  y: number;
  /** Signed velocity-impulse amplitude (negative = a downward dimple). */
  amp: number;
}

/** Mean drops-per-frame as a function of the rain knob (0..1):
 *  0 = none, → drizzle (sparse) → rainy → downpour (dense). */
export function rainLambda(rain: number): number {
  const r = Math.max(0, Math.min(1, rain));
  if (r <= 0) return 0;
  // Quadratic ramp so the low end stays a believable drizzle and the top is a
  // dense downpour. ~0.05 drops/frame at r=0.1, ~6 drops/frame at r=1.
  return 6 * r * r + 0.2 * r;
}

/** Drop impulse amplitude as a function of rain intensity: drizzle spawns
 *  small shallow dimples, a downpour spawns wider/taller craters. Signed
 *  negative (a raindrop pushes the surface DOWN, then the wave eq rebounds it
 *  into an expanding ring). */
export function dropAmplitude(rain: number, jitter: number): number {
  const r = Math.max(0, Math.min(1, rain));
  const base = 0.008 + 0.03 * r; // deeper craters as it pours
  const j = 0.6 + 0.8 * Math.max(0, Math.min(1, jitter)); // 0.6..1.4 size spread
  return -base * j;
}

/** Deterministic 32-bit PRNG (mulberry32). Same seed ⇒ same stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Spawn the rain drops for a single frame. DETERMINISTIC in (rain, seed,
 * frameIndex): the PRNG is derived from seed+frame so replaying a frozen
 * scene reproduces the exact impacts (VRT determinism). Returns up to `cap`
 * drops (default 12). Each is a ONE-SHOT impulse — the caller injects it into
 * the height field ONCE, on this frame, and lets the wave eq propagate the
 * ring (review fix #6).
 */
export function spawnDrops(
  rain: number,
  seed: number,
  frameIndex: number,
  cap: number = 12,
): RainDrop[] {
  const lambda = rainLambda(rain);
  if (lambda <= 0) return [];
  const rng = mulberry32((seed ^ (frameIndex * 0x9e3779b1)) >>> 0);
  // Poisson(lambda) via Knuth's algorithm.
  const L = Math.exp(-lambda);
  let count = 0;
  let p = 1;
  do {
    count++;
    p *= rng();
  } while (p > L);
  count -= 1;
  count = Math.min(count, cap);
  const drops: RainDrop[] = [];
  for (let i = 0; i < count; i++) {
    // Keep impacts inside the disk (rejection-free: sample a radius with
    // sqrt for uniform area, so drops don't clump at the centre).
    const ang = rng() * Math.PI * 2;
    const rad = Math.sqrt(rng()) * 0.48; // < 0.5 so the splat stays on the pool
    const x = 0.5 + Math.cos(ang) * rad;
    const y = 0.5 + Math.sin(ang) * rad;
    drops.push({ x, y, amp: dropAmplitude(rain, rng()) });
  }
  return drops;
}

// ── PTZ camera ───────────────────────────────────────────────────────────────
export interface CameraParams {
  camX: number;
  camY: number;
  camZ: number;
  pan: number;
  tilt: number;
  zoom: number; // 0..1 → fov 70°..20°
  /** Bipolar position offsets. Each normalized ±1 TRANSLATES the eye ±2R
   *  (= ±{@link CAM_POS_REACH}) in world space ON TOP of the PTZ framing, so
   *  the camera becomes fully movable in a box around the pool. Optional and
   *  default 0 (⇒ the eye is exactly the PTZ eye, so existing patches are
   *  unchanged). posY > 0 lifts the eye ABOVE the water plane. */
  posX?: number;
  posY?: number;
  posZ?: number;
}
export interface CameraBasis {
  eye: [number, number, number];
  forward: [number, number, number];
  right: [number, number, number];
  up: [number, number, number];
  tanHalf: number;
  fovY: number; // radians
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

const DEG = Math.PI / 180;

/**
 * Build the camera ray basis from the PTZ params PLUS the bipolar position
 * offsets. The PTZ eye is clamped into CAM_BOX, then TRANSLATED by
 * (posX,posY,posZ)·2R (each axis clamped to ±2R) so the eye can move anywhere
 * in a box around the pool — including ABOVE the water plane (posY>0 ⇒ y>0).
 * pan/tilt/zoom still ORIENT the camera (forward is PTZ-derived, unchanged by
 * position — the eye moves, PTZ aims), so an above-surface eye with the
 * default downward tilt looks DOWN onto the water. Tilt is clamped into
 * ±TILT_CLAMP (gimbal-safe); zoom maps linearly to a 70°→20° vertical FOV
 * (zoom in = narrower); pan=0,tilt=0 looks along −z. With posX/Y/Z=0 the eye
 * is exactly the PTZ eye, so existing behaviour is unchanged at default.
 * Matrix-inverse-free (mirrors the mandelbulb look-at basis).
 */
export function cameraBasis(p: CameraParams): CameraBasis {
  // PTZ eye (box-clamped) + bipolar position translation (each axis ±2R). The
  // translation rides ON TOP of the box clamp so position can carry the eye
  // out of CAM_BOX (e.g. above the y=2.2 ceiling), which is the point of a
  // fully-movable camera. clamp(pos,-1,1) caps the reach at ±2R.
  const eye: [number, number, number] = [
    clamp(p.camX, CAM_BOX.x[0], CAM_BOX.x[1]) + clamp(p.posX ?? 0, -1, 1) * CAM_POS_REACH,
    clamp(p.camY, CAM_BOX.y[0], CAM_BOX.y[1]) + clamp(p.posY ?? 0, -1, 1) * CAM_POS_REACH,
    clamp(p.camZ, CAM_BOX.z[0], CAM_BOX.z[1]) + clamp(p.posZ ?? 0, -1, 1) * CAM_POS_REACH,
  ];
  const tilt = clamp(p.tilt, -TILT_CLAMP, TILT_CLAMP);
  const pan = p.pan;
  const fovY = (70 - 50 * clamp(p.zoom, 0, 1)) * DEG; // 70°..20°
  const ct = Math.cos(tilt);
  const forward: [number, number, number] = [
    -ct * Math.sin(pan),
    Math.sin(tilt),
    -ct * Math.cos(pan),
  ];
  // right = normalize(cross(forward, worldUp)) with worldUp=(0,1,0).
  let rx = forward[2] * 1 - forward[1] * 0;
  let ry = forward[0] * 0 - forward[2] * 0;
  let rz = forward[0] * 0 - forward[0] * 1; // = -forward[0]
  // The general cross(forward,(0,1,0)) = (forward.z, 0, -forward.x).
  rx = forward[2];
  ry = 0;
  rz = -forward[0];
  const rlen = Math.hypot(rx, ry, rz) || 1;
  const right: [number, number, number] = [rx / rlen, ry / rlen, rz / rlen];
  // up = cross(right, forward)
  const up: [number, number, number] = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ];
  return { eye, forward, right, up, tanHalf: Math.tan(fovY / 2), fovY };
}
