// packages/web/src/lib/ui/workflow/panels/stereo-crossover-model.ts
//
// PURE geometry for the STEREO CROSSOVER sidebar panel — where the split sits
// on a log frequency ruler, and how far the side bars open at a given WIDTH.
//
// Extracted for the usual reason this repo extracts: the interesting cases (a
// split below the ruler's floor, width 0, a non-finite param read) are
// arithmetic, and arithmetic checked in a screenshot is arithmetic nobody
// checks. The component is a thin <svg> over these.

/** The ruler's span. 20 Hz–20 kHz is the audible decade set; a kick's split
 *  sits near its low end, which is exactly where it should read as "low". */
export const XOVER_MIN_HZ = 20;
export const XOVER_MAX_HZ = 20000;

/**
 * Normalized LOG position [0,1] of a frequency on the ruler. Log because a
 * crossover an octave up should move a fixed distance whatever octave it
 * started in — on a linear ruler a 120 Hz split and a 60 Hz split would sit
 * indistinguishably at the far left, which is the one thing this picture
 * exists to show. Out-of-range clamps to the ends.
 */
export function xoverFrac(hz: number): number {
  if (!Number.isFinite(hz)) return 0;
  const f = Math.max(XOVER_MIN_HZ, Math.min(XOVER_MAX_HZ, hz));
  return Math.log(f / XOVER_MIN_HZ) / Math.log(XOVER_MAX_HZ / XOVER_MIN_HZ);
}

/** The vertical HALF-SPREAD (0..1 of the panel's half-height) the L/R traces
 *  separate by at a given width. width 0 ⇒ 0 ⇒ L and R drawn coincident,
 *  which is literally true of the DSP (`width=0 → L == R exactly`). */
export function xoverSpread(width: number): number {
  if (!Number.isFinite(width)) return 0;
  return Math.max(0, Math.min(1, width));
}

/** The panel's caption for a split: `120 Hz` / `1.20k Hz`, through the shared
 *  ladder rather than a local toFixed. */
export { formatParamNumber as xoverHzText } from '$lib/ui/controls/param-format';
