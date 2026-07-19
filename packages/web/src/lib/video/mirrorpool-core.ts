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
//   - cameraBasis — the ORBIT + FREE-LOOK camera → ray basis. The eye rides a
//     sphere around the pool centre (azimuth × elevation × distance), aimed at
//     the centre by default, with a yaw/pitch free-look offset so it can look
//     ANY direction. Elevation may go NEGATIVE to drop the eye BELOW the water
//     plane (the underwater Snell's-window view the render shader handles).

// ── Geometry constants ────────────────────────────────────────────────────
/** Pool hemisphere radius (unit hemisphere, rim on y=0, pole at y=-1). */
export const POOL_RADIUS = 1;
/** World extent per height-field UV unit. The height field spans the pool
 *  disk [-R,R]² mapped to uv [0,1]², so one uv unit = 2R world units. Used to
 *  convert a texel-space slope into a true (dimensionless) world slope so the
 *  reconstructed normal is physically scaled (review fix #4). */
export const WORLD_SCALE = 2 * POOL_RADIUS;

/** Orbit distance clamp (world units) — how far the eye sits from the pool
 *  centre. Min < R so the camera can dive INSIDE the water volume for a truly
 *  submerged look; max = a wide framing that keeps the whole rim in view. */
export const ORBIT_DIST_MIN = 0.4;
export const ORBIT_DIST_MAX = 5;
/** Elevation clamp (±~83°) — keeps the eye off the exact vertical pole above /
 *  below the centre, where the aim-at-centre forward becomes parallel to world
 *  up and the camera frame degenerates. NEGATIVE elevation = BELOW the surface
 *  plane (the underwater Snell's-window view the render shader handles). */
export const EL_CLAMP = 1.45;
/** Free-look pitch clamp (±~83°) — the same gimbal guard for the look offset. */
export const LOOK_PITCH_CLAMP = 1.45;

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

// ── Orbit + free-look camera ─────────────────────────────────────────────────
export interface CameraParams {
  /** Azimuth around the pool centre (radians). 0 ⇒ the eye sits on +z (front),
   *  aiming toward −z at the centre. */
  az: number;
  /** Elevation above / below the surface plane (radians). +EL ⇒ ABOVE (toward
   *  a straight-overhead bird's-eye); 0 ⇒ level with the rim; NEGATIVE ⇒ BELOW
   *  the water plane (the underwater view). Clamped to ±{@link EL_CLAMP}. */
  el: number;
  /** Distance of the eye from the pool centre (world units). Clamped to
   *  [{@link ORBIT_DIST_MIN}, {@link ORBIT_DIST_MAX}]. */
  dist: number;
  /** Free-look YAW offset (radians) from the aim-at-centre direction — rotate
   *  the view left/right so the camera can look AWAY from the pool. 0 ⇒ aim at
   *  the centre. */
  lookYaw: number;
  /** Free-look PITCH offset (radians) from the aim-at-centre direction — rotate
   *  the view up/down. 0 ⇒ aim at the centre. Clamped to ±{@link LOOK_PITCH_CLAMP}. */
  lookPitch: number;
  zoom: number; // 0..1 → fov 70°..20°
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

/** normalize a 3-vector (returns the input direction, or +x on a zero vector). */
function norm3(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (l < 1e-9) return [1, 0, 0];
  return [v[0] / l, v[1] / l, v[2] / l];
}
function cross3(
  a: [number, number, number],
  b: [number, number, number],
): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * Build the camera ray basis for the ORBIT + FREE-LOOK camera.
 *
 * POSITION — the eye rides a sphere of radius `dist` (clamped) around the pool
 * centre (the origin), parameterised by azimuth `az` and elevation `el`:
 *   eye = dist·(cos el·sin az, sin el, cos el·cos az)
 * so `az` orbits the eye around the vertical axis and `el` raises it from below
 * the water plane (el<0 ⇒ y<0, underwater) up to nearly overhead. This is the
 * "sit ABOVE / BELOW / LEFT / RIGHT of the pool" control.
 *
 * LOOK — the base forward AIMS AT THE POOL CENTRE (so the default framing
 * always shows the pool, never the void), and the free-look offset (`lookYaw`,
 * `lookPitch`) rotates that aim within the camera's own frame so the view can
 * point ANY direction. lookYaw/lookPitch = 0 ⇒ look straight at the centre.
 *
 * `zoom` maps linearly to a 70°→20° vertical FOV (zoom in = narrower). The
 * elevation + look-pitch are clamped off the exact vertical pole so the
 * aim-at-centre frame never degenerates. Matrix-inverse-free (mirrors the
 * mandelbulb look-at basis); the render shader consumes eye/forward/right/up
 * directly, so an underwater eye is a pure input change (no shader camera math).
 */
export function cameraBasis(p: CameraParams): CameraBasis {
  const el = clamp(p.el, -EL_CLAMP, EL_CLAMP);
  const dist = clamp(p.dist, ORBIT_DIST_MIN, ORBIT_DIST_MAX);
  const ce = Math.cos(el);
  const se = Math.sin(el);
  const sa = Math.sin(p.az);
  const ca = Math.cos(p.az);
  // Eye on the orbit sphere around the pool centre (origin).
  const eye: [number, number, number] = [dist * ce * sa, dist * se, dist * ce * ca];

  // Base forward: aim at the pool centre (origin) ⇒ −eye direction.
  const f0 = norm3([-eye[0], -eye[1], -eye[2]]);
  // Camera frame around f0 for the free-look offset. worldUp = (0,1,0); the
  // EL/PITCH clamps keep f0 off vertical, but guard the degenerate cross.
  let right0 = cross3(f0, [0, 1, 0]);
  if (Math.hypot(right0[0], right0[1], right0[2]) < 1e-5) right0 = [1, 0, 0];
  right0 = norm3(right0);
  const up0 = cross3(right0, f0);

  // Free-look: yaw sweeps within the (f0, right0) plane, pitch lifts toward up0.
  // At (0,0) the forward IS f0 (aim at centre); otherwise it tilts off it.
  const yaw = p.lookYaw;
  const pitch = clamp(p.lookPitch, -LOOK_PITCH_CLAMP, LOOK_PITCH_CLAMP);
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const forward = norm3([
    f0[0] * cp * cy + right0[0] * cp * sy + up0[0] * sp,
    f0[1] * cp * cy + right0[1] * cp * sy + up0[1] * sp,
    f0[2] * cp * cy + right0[2] * cp * sy + up0[2] * sp,
  ]);

  // right/up from the FINAL forward + worldUp (the render basis convention).
  let right = cross3(forward, [0, 1, 0]);
  if (Math.hypot(right[0], right[1], right[2]) < 1e-5) right = [1, 0, 0];
  right = norm3(right);
  const up = cross3(right, forward);

  const fovY = (70 - 50 * clamp(p.zoom, 0, 1)) * DEG; // 70°..20°
  return { eye, forward, right, up, tanHalf: Math.tan(fovY / 2), fovY };
}
