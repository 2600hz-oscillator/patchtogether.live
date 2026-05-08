// packages/web/src/lib/sync/prng.ts
//
// mulberry32 — chosen as the rack-wide deterministic PRNG (decision #1 in
// .myrobots/plans/shared-state-sync.md). 32-bit state, only +, |, ^, >>>,
// Math.imul, all operating on signed 32-bit integers under the JS spec, so
// output is byte-identical across V8 / SpiderMonkey / JSC / Hermes.
//
// Reference: bryc/code (https://github.com/bryc/code/blob/master/jshash/PRNGs.md).

/**
 * Construct a mulberry32 generator from a 32-bit seed.
 *
 * Returns a thunk that yields successive numbers in [0, 1). The state is
 * captured in the closure; calling the same seed twice produces the same
 * sequence. Two clients with the same seed produce identical sequences,
 * sample-for-sample, regardless of JS engine.
 */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * splitmix32 — derive a per-module seed from a parent rack seed and a
 * per-instance discriminator (e.g., FNV-1a of the module id). Mixing the
 * two through one mulberry32 step gives every instance a decorrelated
 * sub-stream while the rack-level seed remains the only true entropy
 * source.
 */
export function splitSeed(rackSeed: number, instanceHash: number): number {
  const next = mulberry32((rackSeed ^ instanceHash) | 0);
  // Pull two values and re-pack to a u32 — the first 32 bits of mulberry32
  // already contain the full state perturbation; one extra round whitens
  // adjacent (rack, instance) pairs that differ only in the low bits.
  next();
  return Math.floor(next() * 0x100000000) | 0;
}

/** FNV-1a 32-bit hash. Fast, deterministic, good for short ids. */
export function fnv1a32(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
