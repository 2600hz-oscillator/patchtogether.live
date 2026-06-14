// packages/web/src/lib/video/vfpga/cells/bend-seed.ts
//
// SHARED seeded-pseudorandom GLSL for the circuit-bent VFPGA family (the ratified
// OWNER DECISION, design §3 + Q6): every bend's "random" feel comes from a
// DETERMINISTIC frame-index + uv seeded hash — NOT genuine non-determinism — so
// the look is VRT-safe and re-rollable by a gate (a GIN reseed trigger advances
// the host's edge COUNT, which a bend cell reads as `uSeed` to roll a fresh,
// still-deterministic pattern). The `uSeed` knob is what a bend cell binds to a
// gate role's `countUniform`; `uTime` is the always-host-provided fabric clock.
//
// Kept as ONE shared string so every bend cell hashes IDENTICALLY (no per-cell
// drift in the rng → consistent grain across the catalog, and a single place to
// audit determinism). The hash is the classic sin-fract integer-ish hash, robust
// on both a real GPU and CI's SwiftShader software renderer (no precision-only
// asserts ride on it — bend e2e assert STRUCTURE, not exact pixels).

/** GLSL helpers a bend kernel includes verbatim: `bendHash(vec2)` → [0,1), plus
 *  `bendHash3(vec3)` for a per-(x,y,channel/line) roll. Both fold in a `uSeed`
 *  offset so a reseed-gate edge re-rolls the whole field deterministically. */
export const BEND_SEED_GLSL = `
float bendHash(vec2 p) {
  // sin-fract hash; large irrational multipliers decorrelate x/y.
  float h = dot(p, vec2(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}
float bendHash3(vec3 p) {
  float h = dot(p, vec3(127.1, 311.7, 74.7));
  return fract(sin(h) * 43758.5453123);
}`;

/** The uniform a bend cell reads the re-rollable seed from (bound to a gate
 *  role's `countUniform`). A single source of truth shared by every bend cell
 *  + its docs, so the seed plumbing never drifts. */
export const BEND_SEED_UNIFORM = 'uSeed';
