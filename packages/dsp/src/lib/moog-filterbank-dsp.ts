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
// Frequencies below are the documented Moog values (confirmed against the
// modularsynthesis.com Moog archive + multiple 914/907A clone references —
// the modularsynthesis 907 service notes give the shelf corners, and the
// 914/907A clone makers agree on the band grid). Not a guess.
//
// ── 914 (full bank, System 55) ──
// The twelve classic Moog-914 1/3-octave bandpass centers, in Hz:
//   125, 175, 250, 350, 500, 700, 1000, 1400, 2000, 2800, 4000, 5600
// plus a fixed LOW-PASS shelf at 100 Hz (passes below the lowest band) and a
// fixed HIGH-PASS shelf at 7.5 kHz (passes above the highest band).
//
// ── 907A (System 35) ──
// EIGHT bandpass centers — the standard-range middle of the same grid:
//   250, 350, 500, 700, 1000, 1400, 2000, 2800
// plus a low shelf with max output ~175 Hz and a high shelf with max output
// ~6.6 kHz (per the modularsynthesis 907 service notes). 907A and 914 share
// one grid + factory; they differ only by which slice + the shelf corners.

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
 *  documented eight-band standard range (250 Hz … 2.8 kHz). */
export const FILTERBANK_907A_CENTERS: number[] = [
  250, 350, 500, 700, 1000, 1400, 2000, 2800,
];

/** End-shelf corner frequencies (Hz). The fixed filter bank bookends its
 *  bandpass cells with a LOW-PASS shelf below the lowest band and a HIGH-PASS
 *  shelf above the highest band. Documented Moog values:
 *    914 — LP 100 Hz, HP 7.5 kHz   (extended range)
 *    907A — LP ~175 Hz, HP ~6.6 kHz (standard range) */
export const FILTERBANK_914_LP_HZ = 100;
export const FILTERBANK_914_HP_HZ = 7500;
export const FILTERBANK_907A_LP_HZ = 175;
export const FILTERBANK_907A_HP_HZ = 6600;

/** Stable per-band param id for the Nth (1-based) bandpass band, e.g.
 *  band1, band2, … Used by both the module def's `params` array and the
 *  factory's gain map so the def + the wiring stay in lock-step (and so the
 *  907A vs 914 difference is purely "how many bandN params"). */
export function bandParamId(index1Based: number): string {
  return `band${index1Based}`;
}
