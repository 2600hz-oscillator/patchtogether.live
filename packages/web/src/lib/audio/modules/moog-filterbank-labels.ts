// packages/web/src/lib/audio/modules/moog-filterbank-labels.ts
//
// The ONE place a Moog fixed-filter-bank section is turned into a CONTROL
// LABEL — shared by the 907A and the 914 defs (and read back, never re-typed,
// by the faceplate model in $lib/ui/modules/moog-filterbank-face-model).
//
// WHY IT IS ITS OWN FILE, twice over:
//
//  1. It kills a duplication that was already live. Both defs carried the SAME
//     inline `freq >= 1000 ? `${freq/1000}k` : freq` expression, and the face
//     needed a THIRD and FOURTH use (the two end shelves), which is the point
//     at which four copies of a formatter stop being a coincidence.
//
//  2. ⚠ IT MUST NOT LIVE IN `packages/dsp/src/lib/moog-filterbank-dsp.ts` OR IN
//     `moog-filterbank-factory.ts`. Those two files ARE the ART audio pin for
//     both modules — `art/scenarios/moog914/profile.test.ts` hashes them with
//     `repoSourceSha`, which is RAW BYTES, not the docs-stripped basis. Adding a
//     label helper (or even a comment) to either one moves
//     `art/baselines/moog914/audio.sha` and `…/moog907a/audio.sha` and demands
//     an audio re-pin for a change that cannot reach a sample. This file is
//     outside that pin by construction.
//
// PURE data → string. No DOM, no engine, no Web Audio.

/**
 * A filter-bank frequency as the control prints it: `125`, `1.4k`, `7.5k`.
 *
 * The k-form starts at 1 kHz because that is where the four-digit form stops
 * fitting a 46 px lane knob column, and it keeps one significant fraction
 * (`5.6k`, not `5.60k`) because every value on both grids has at most one.
 */
export function filterbankHzLabel(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : `${hz}`;
}

/**
 * The LOW-PASS end section's label — `LP 100` (914) / `LP 175` (907A).
 *
 * ⚠ THE CORNER IS IN THE LABEL BECAUSE THE FACE RANKS BY FREQUENCY. Every
 * bandpass cell already prints the Hz it sits at, so a bare `LP` / `HP` was the
 * only pair of cells on the whole faceplate that did not say where it was on
 * the axis the rank is built from — and the two shelves are exactly the cells
 * whose position a player cannot guess, because they differ between the two
 * modules (100 vs 175 Hz at the bottom, 7.5 vs 6.6 kHz at the top).
 */
export function filterbankLpLabel(lpHz: number): string {
  return `LP ${filterbankHzLabel(lpHz)}`;
}

/** The HIGH-PASS end section's label — `HP 7.5k` (914) / `HP 6.6k` (907A). */
export function filterbankHpLabel(hpHz: number): string {
  return `HP ${filterbankHzLabel(hpHz)}`;
}
