// packages/dsp/src/lib/mandelbulb-de.ts
//
// MANDELBULB distance estimate (DE) — the single source of truth for the
// Mandelbulb iteration math, shared by:
//   • the WebGL GLSL generator + the pure-TS DE reference (web mandelbulb.ts,
//     which RE-EXPORTS these so its mandelbulb-math.test.ts import path holds),
//   • the bulb-slice readout lib (mandelbulb-slice.ts),
//   • the mandelbulb-osc worklet (via the slice lib).
//
// It lives under lib/ for the same two reasons cube-dsp.ts does:
//   1. esbuild inlines lib/ files into the worklet entry at build time, so a
//      lib/ file MAY `export` freely (worklet entries must NOT top-level-export
//      or they leak into the ESM bundle + break ART's classic-script eval).
//   2. It is pure + deterministic, so it is unit-testable here and reusable
//      verbatim by node-ART (no GL / AudioContext needed).
//
// Algebra is byte-identical to the GLSL `mandelbulbDE` in the web module — the
// only port is syntax (Math.* vs GLSL builtins). The DE was previously defined
// inline in packages/web/src/lib/video/modules/mandelbulb.ts; it was moved here
// (re-exported from there) so the slice readout + the audio worklet share the
// exact same function the GLSL shader mirrors.

/** Mandelbulb escape radius. A point whose iterate exceeds this is treated as
 *  escaped (outside the set). 2.5 per the royvanrijn/mandelbulb.js reference. */
export const MANDELBULB_BAILOUT = 2.5;

/**
 * Mandelbulb distance estimate at point p=(px,py,pz).
 *   - power:   the fractal exponent (8 = the classic Mandelbulb).
 *   - iters:   fractal iteration budget (~20).
 * Standard DE: 0.5 * log(r) * r / dr.
 *
 * The exact origin (0,0,0) is the polar singularity (acos(z/r), r=0) and
 * returns NaN in BOTH this reference and the GLSL port — callers that march a
 * field through the bulb (the slice readout) must guard NaN → 0 (the origin is
 * never sampled by the GL raymarch in practice; the fixed-step slice march can
 * land exactly on it).
 */
export function jsDistanceEstimate(
  px: number,
  py: number,
  pz: number,
  power: number,
  iters: number,
): number {
  let zx = px;
  let zy = py;
  let zz = pz;
  let dr = 1.0;
  let r = 0.0;
  for (let i = 0; i < iters; i++) {
    r = Math.sqrt(zx * zx + zy * zy + zz * zz);
    if (r > MANDELBULB_BAILOUT) break;
    // Convert to polar.
    let theta = Math.acos(zz / r);
    let phi = Math.atan2(zy, zx);
    dr = Math.pow(r, power - 1.0) * power * dr + 1.0;
    // Scale + rotate the point.
    const zr = Math.pow(r, power);
    theta *= power;
    phi *= power;
    // Convert back to cartesian + translate by the original point.
    const sinTheta = Math.sin(theta);
    zx = zr * sinTheta * Math.cos(phi) + px;
    zy = zr * sinTheta * Math.sin(phi) + py;
    zz = zr * Math.cos(theta) + pz;
  }
  // 0.5 * log(r) * r / dr. Guard r=0 (a point exactly at origin never
  // escapes; log(0) = -inf) by clamping r to a tiny epsilon.
  const rr = Math.max(r, 1e-12);
  return (0.5 * Math.log(rr) * rr) / dr;
}
