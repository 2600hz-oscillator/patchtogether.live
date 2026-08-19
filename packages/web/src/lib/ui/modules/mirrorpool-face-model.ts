// packages/web/src/lib/ui/modules/mirrorpool-face-model.ts
//
// The PURE model behind the MIRRORPOOL faceplate — WHERE THE EYE IS STANDING,
// which is the one thing about this module no single dial can tell you.
//
// WHY IT EXISTS. mirrorpool's camera rides a sphere around the pool, and two
// different dials decide where that puts you relative to the water:
//
//   eye = dist·(cos el·sin az,  sin el,  cos el·cos az)   (mirrorpool-core)
//
// so the eye's HEIGHT is `dist·sin el` and its HORIZONTAL RADIUS is
// `dist·cos el`. Three placements matter, because two of them change what is
// rendered rather than merely where it is seen from:
//
//   UNDER    — `eye.y < 0`. The underwater Snell's-window branch. A whole
//              render path, entered by dropping ONE pad axis below its centre.
//   OVER     — above the water and INSIDE the bowl's rim
//              (`radius < POOL_RADIUS`): looking down into the pool from
//              within it.
//   OUTSIDE  — above the water and beyond the rim. The shipped default, and
//              the framing the module was designed around.
//
// ⚠ WHY THIS IS A DERIVED READOUT AND `eye-side` WOULD NOT HAVE BEEN. The
// queue's §25.4 proposed an ABOVE/BELOW readout and called it "genuinely
// underivable from any single knob". MEASURED, it is not: `dist` is clamped to
// [0.4, 5] and is therefore strictly positive, so `sign(eye.y) === sign(el)`
// EXACTLY — a sweep of 729 camera settings (3 each of az/dist/lookYaw/
// lookPitch/zoom × 3 elevations) produced **zero** disagreements with
// `sign(orbit_el)`. An above/below readout is `orbit_el`'s sign relabelled,
// which is the one thing a derived readout must not be, and no honest negative
// control could have been written for it.
//
// The RADIUS is what makes the join real: `radius = dist·cos el` moves with
// BOTH dials, so a readback of either one is blind to the other. Measured at
// `el = 0.55` (the shipped default): `dist = 0.4` → radius 0.3410 and
// `dist = 1` → radius 0.8525, both INSIDE `POOL_RADIUS = 1` — the "distance"
// dial puts the camera inside the bowl over its bottom fifth — while
// `dist = 2.6` → 2.2166, outside. Hold `dist` at 1 and the same camera is
// inside at `el = 0.55` and exactly ON the rim at `el = 0`.
//
// ⚠ IT CALLS `cameraBasis`, THE MODULE'S OWN FUNCTION, rather than re-deriving
// the trigonometry. The same rule spirographs' readouts follow: the faceplate
// cannot describe a camera the module stopped rendering, because it is asking
// the renderer's own arithmetic. A re-typed copy here would be the card/def
// divergence class one layer up.
//
// PURE: no DOM, no engine, no store, no fs.

import { cameraBasis, POOL_RADIUS } from '$lib/video/mirrorpool-core';
import { MIRRORPOOL_DEFAULTS } from '$lib/video/modules/mirrorpool';

/** Where the eye is standing, as a NAME. Three states, no number — the picture
 *  is the module's readout for everything continuous. */
export type MirrorpoolEyePlace = 'UNDER' | 'OVER' | 'OUTSIDE';

/** A face readout's only window onto the node: param id → value, or undefined
 *  on a fresh node that has not written that key yet. */
type Read = (paramId: string) => number | undefined;

/**
 * Every camera param, with the def's own default substituted for anything the
 * node has not written and for any non-finite value.
 *
 * ⚠ THE NON-FINITE GUARD IS NOT DEFENSIVE PADDING. A readout function runs on
 * EVERY render, so a throw — or a silently NaN-propagating comparison — takes
 * the faceplate down mid-drag. `cameraBasis`'s clamps do not stop NaN
 * (`Math.max(0.4, Math.min(5, NaN))` is NaN), and a NaN eye would compare
 * false against every branch and quietly report OUTSIDE, which is a WRONG
 * ANSWER rather than a missing one.
 */
export function mirrorpoolCameraParams(read: Read) {
  const num = (id: string, fallback: number): number => {
    const v = read(id);
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  return {
    az: num('orbit_az', MIRRORPOOL_DEFAULTS.orbit_az),
    el: num('orbit_el', MIRRORPOOL_DEFAULTS.orbit_el),
    dist: num('orbit_dist', MIRRORPOOL_DEFAULTS.orbit_dist),
    lookYaw: num('look_yaw', MIRRORPOOL_DEFAULTS.look_yaw),
    lookPitch: num('look_pitch', MIRRORPOOL_DEFAULTS.look_pitch),
    zoom: num('zoom', MIRRORPOOL_DEFAULTS.zoom),
  };
}

/**
 * Where the eye is, from the eye the renderer would actually use.
 *
 * ⚠ THE `eye.y < 0` TEST IS STRICT, AND THE BOUNDARY IS THE INTERESTING PART.
 * At `orbit_el = 0` the eye sits exactly ON the water plane and
 * `eye.y === 0` BIT-EXACTLY (`dist·sin(0)`), which takes the ABOVE path — so a
 * readout written with `<=` would say UNDER while the shader renders the
 * above-water branch. One ten-thousandth of a radian below (`el = -0.0001`,
 * `eye.y = -0.00026000` at the default distance) it really is underwater.
 * Both boundaries are pinned in the test beside this file.
 *
 * The rim test is strict for the mirroring reason: at `el = 0, dist = 1` the
 * radius is exactly `POOL_RADIUS`, which is ON the rim, not inside it.
 */
export function mirrorpoolEyePlace(read: Read): MirrorpoolEyePlace {
  const basis = cameraBasis(mirrorpoolCameraParams(read));
  const [x, y, z] = basis.eye;
  if (y < 0) return 'UNDER';
  return Math.hypot(x, z) < POOL_RADIUS ? 'OVER' : 'OUTSIDE';
}

/** The hero readout's text. A NAME for a placement, never a coordinate — the
 *  owner ruling removed resting decimals from faces, and "you are underwater"
 *  is exactly the kind of thing a number would fail to say. */
export function mirrorpoolEyePlaceText(read: Read): string {
  return mirrorpoolEyePlace(read);
}
