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
//   brown  — leaky-integrated white. NOT a flat -6 dB/oct tilt: it is a
//            one-pole low-pass, flat below ~77 Hz (at 48 kHz) and -6 dB/oct
//            above. See the correction on `brown` below.
//
// ⚠ THE THREE ARE NOT LEVEL-MATCHED, and nothing downstream matches them: RMS
// at unity is white 0.5774 (-4.77 dBFS), brown 0.2558 (-11.84), pink 0.1400
// (-17.08). One LEVEL knob scales all three, so brown leaves 7.1 dB and pink
// 12.3 dB below white.
//
// ⚠ QUOTE THE STEADY STATE, and quote the table deficit SEPARATELY. Pink's
// shipped 2 s table measures 0.1362 (-17.32), 0.24 dB under the steady state,
// because Voss row 15 only updates every 32 768 samples and starts at zero —
// so the slow rows are still filling for the first third of the table. Both
// numbers are true and they are NOT interchangeable: the faceplate prints the
// closed form, so prose that quotes the measurement instead contradicts the
// readout sitting two inches from it. (It did: the sidebar said "pink -12.5 dB"
// beside a hero showing a 12.3 dB spread.) One number is the headline; the
// deficit is its own stated fact.
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

  /** Brown noise via leaky integration of white noise. The leak coefficient
   *  (0.99) prevents DC drift on long runs; we scale the integrator by 1/8.
   *
   *  ⚠ TWO CLAIMS THIS COMMENT USED TO MAKE, BOTH MEASURED WRONG 2026-08-10
   *  (against these exact generators, at the 96 000-sample table `noise.ts`
   *  actually ships — the numbers are re-derived on every run by
   *  `packages/web/src/lib/ui/modules/noise-face-model.test.ts`):
   *
   *  1 · "keeping the -6 dB/oct slope across the audible range". It does NOT.
   *      `a = 0.99` is a ONE-POLE LOW-PASS with a -3 dB corner at
   *      `fs·acos((1+a²-2(1-a)²)/2a)/2π` = 76.78 Hz at 48 kHz, so this tap is
   *      FLAT below the corner (measured -1.9 dB/oct over 20-100 Hz) and
   *      -6 dB/oct only above it (-5.6 over 100 Hz-1 kHz). ⚠ And `a` carries no
   *      `sampleRate` term, so the corner MOVES WITH THE INTERFACE: 70.5 Hz at
   *      44.1 k, 153.6 Hz at 96 k. Fixing that is a real DSP change (it moves
   *      the ART baselines) and is deliberately not folded into a UI PR.
   *
   *  2 · "the integrator steady-state RMS is ~3.5 … so peak excursions stay
   *      comfortably under ±1 over arbitrary buffer lengths (verified to ~64k
   *      samples)". The integrator's steady-state RMS is 2.0464
   *      (`√(0.5²·⅓/(1-a²))`, and measured 2.045), not ~3.5 — so the 1/8 was
   *      sized against a figure 1.7× too large. And the peak claim is false at
   *      the length that ships: over 200 seeded 96 000-sample tables, 118 PEAK
   *      ABOVE 1.0 (median 1.021, p95 1.167, worst 1.362). The qualifier
   *      "verified to ~64k samples" is the tell — a leaky integrator's extreme
   *      value grows with the window, and nobody re-checked at ship length.
   *      White and pink are hard-bounded by construction; brown is not. */
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
