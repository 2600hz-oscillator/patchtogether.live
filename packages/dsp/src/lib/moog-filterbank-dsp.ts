// packages/dsp/src/lib/moog-filterbank-dsp.ts
//
// Shared FIXED-FILTER-BANK center frequencies + bandwidth for the Moog
// fixed-filter-bank family:
//   • 914 — "Extended Fixed Filter Bank" (Moog System 55). The full TWELVE
//     1/3-octave band centers plus separate fixed low-pass / high-pass
//     sections at the ends. The classic 914 layout.
//   • 907A — "Fixed Filter Bank" (Moog System 35). A standard-range subset
//     of the same 1/3-octave series (the System 35's smaller fixed bank).
//
// DATA-ONLY — no DSP class, no Web Audio. Both modules are PURE Web Audio
// (a fan of BiquadFilterNode('bandpass') → per-band GainNode → one summing
// GainNode, with bookend low-pass / high-pass biquads); the only thing they
// need to SHARE is this center-frequency table + the band Q, so 907A vs 914
// "differ only by data". Lives in `lib/` so the dsp dist build does NOT treat
// it as a worklet entry (that script reads top-level .ts files expecting each
// to call registerProcessor()).
//
// OWN DATA — the center frequencies are the standard 1/3-octave (ISO R10-ish)
// series rounded to the conventional fixed-filter-bank values; they are facts
// about a 1/3-octave grid, not a copyrightable schematic.
//
// ── 914 (full bank) ──
// The twelve classic Moog-914 1/3-octave band centers, in Hz:
//   125, 175, 250, 350, 500, 700, 1000, 1400, 2000, 2800, 4000, 5600
// (each step ≈ a 1/3-octave, ratio ~1.4 — the standard 1-2-3 / 1.25-1.6-2
// 1/3-octave decade pattern). These are the BANDPASS sections; the 914 also
// has a fixed low-pass below the lowest band and a fixed high-pass above the
// highest, which both modules model with bookend biquads.
//
// ── 907A (subset) ──
// OPEN QUESTION — the exact 907A (System 35) center frequencies are not
// pinned down in our reference material. The 907A is the smaller fixed bank,
// so we model it as a STANDARD-RANGE SUBSET of the same 1/3-octave series:
// the eight middle bands
//   250, 350, 500, 700, 1000, 1400, 2000, 2800
// (the 914 series with the two lowest + two highest bands dropped). This keeps
// 907A and 914 sharing one grid (they differ only by which slice of the same
// series they expose) and centers the 907A on the musically useful mid-band.
// Revisit if authoritative 907A band centers surface.

/** Bandpass Q shared by every band of both fixed filter banks. A 1/3-octave
 *  band has a fractional bandwidth of ~2^(1/3)−2^(−1/3) ≈ 0.46 of its center,
 *  i.e. Q ≈ 1/0.46 ≈ 2.2 for a "textbook" 1/3-octave filter. The classic Moog
 *  fixed-filter-bank bands are deliberately a touch NARROWER / more resonant
 *  than that (the bank's vocal, formant-y character), so we use Q = 4 — sharp
 *  enough to be expressive, broad enough that adjacent bands overlap into a
 *  continuous response. Used for every BiquadFilterNode('bandpass'). */
export const FILTERBANK_Q = 4;

/** The twelve classic Moog-914 1/3-octave band centers (Hz). */
export const FILTERBANK_914_CENTERS: number[] = [
  125, 175, 250, 350, 500, 700, 1000, 1400, 2000, 2800, 4000, 5600,
];

/** The 907A (System 35) fixed-filter-bank center frequencies (Hz) — the
 *  standard-range eight-band subset of the 914 series (see Open Question in
 *  the file header). */
export const FILTERBANK_907A_CENTERS: number[] = [
  250, 350, 500, 700, 1000, 1400, 2000, 2800,
];

/** Stable per-band param id for the Nth (1-based) bandpass band, e.g.
 *  band1, band2, … Used by both the module def's `params` array and the
 *  factory's gain map so the def + the wiring stay in lock-step (and so the
 *  907A vs 914 difference is purely "how many bandN params"). */
export function bandParamId(index1Based: number): string {
  return `band${index1Based}`;
}
