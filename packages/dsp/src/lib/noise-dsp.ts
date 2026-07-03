// packages/dsp/src/lib/noise-dsp.ts
//
// NOISE — the pure noise-flavor generators (extracted from the NOISE module
// def, packages/web/src/lib/audio/modules/noise.ts, for the ART audio-profile
// backfill batch 5 — the plan's §5 "when a module needs a mirror, extract a
// core instead" rule). The def's factory pre-generates a 2 s looping
// AudioBuffer per flavor from EXACTLY these functions; the ART profile
// renders the same functions with a pinned seed (the seed seam batch 4
// verified — DETERMINISM.md "Random seed (ART audio profiles)").
//
// Three flavors on three independent generators:
//   white  — full-spectrum white noise (flat spectrum), uniform in [-1, +1].
//   pink   — 1/f pink noise (-3 dB/oct). Voss-McCartney algorithm.
//   brown  — 1/f² brown noise (-6 dB/oct). Leaky-integrated white.
//
// Seeding: every generator takes an optional `seed`; when given, samples come
// from mulberry32(seed) (bit-identical run-to-run), else from Math.random
// (the live-module path, where determinism doesn't matter).

/** Pure noise generators. Exposed for unit tests + the ART audio profile so
 *  the flavors can be validated / pinned without spinning up Web Audio. */
export const noiseGenerators = {
  /** White noise: uniform in [-1, +1]. Mean 0, variance 1/3, std-dev ≈ 0.5774. */
  white(n: number, seed?: number): Float32Array {
    const out = new Float32Array(n);
    const rand = seed === undefined ? Math.random : mulberry32(seed);
    for (let i = 0; i < n; i++) out[i] = rand() * 2 - 1;
    return out;
  },

  /** Pink noise (1/f) via Voss-McCartney. Each row updates only when its
   *  bit position changes (LSB toggles every sample, MSB toggles every
   *  2^15 samples), so the long-term spectrum has the characteristic
   *  -3 dB/oct slope. */
  pink(n: number, seed?: number): Float32Array {
    const out = new Float32Array(n);
    const rand = seed === undefined ? Math.random : mulberry32(seed);
    const ROWS = 16;
    const rows = new Float32Array(ROWS);
    let runningSum = 0;
    let counter = 0;
    for (let i = 0; i < n; i++) {
      counter++;
      // Find the lowest set bit of counter — that's the row to update.
      // (counter & -counter) isolates the LSB; Math.log2 gives the row index.
      const lsb = counter & -counter;
      const row = Math.log2(lsb);
      if (row < ROWS) {
        runningSum -= rows[row]!;
        rows[row] = rand() * 2 - 1;
        runningSum += rows[row]!;
      }
      // Add a fresh white sample on top so the high frequencies aren't
      // attenuated to silence (Voss-McCartney without this sounds dull).
      const white = rand() * 2 - 1;
      // Sum of ROWS rows + 1 white sample is in [-(ROWS+1), +(ROWS+1)];
      // normalise to ~[-1, +1] by dividing by ROWS+1.
      out[i] = (runningSum + white) / (ROWS + 1);
    }
    return out;
  },

  /** Brown noise (1/f²) via leaky integration of white noise. The leak
   *  coefficient (0.99) prevents DC drift on long runs while keeping
   *  the -6 dB/oct slope across the audible range. The integrator
   *  steady-state RMS is ~3.5 with the params below; we scale by 1/8
   *  so peak excursions stay comfortably under ±1 over arbitrary
   *  buffer lengths (verified to ~64k samples). */
  brown(n: number, seed?: number): Float32Array {
    const out = new Float32Array(n);
    const rand = seed === undefined ? Math.random : mulberry32(seed);
    let last = 0;
    const LEAK = 0.99;
    const NORM = 1 / 8;
    for (let i = 0; i < n; i++) {
      const w = rand() * 2 - 1;
      last = LEAK * last + 0.5 * w;
      out[i] = last * NORM;
    }
    return out;
  },
};

/** Tiny seeded PRNG — same one used elsewhere in the codebase
 *  (sync/prng.ts). Inlined here so the generators don't pull in the
 *  whole sync module. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
