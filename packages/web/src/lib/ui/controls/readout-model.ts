// packages/web/src/lib/ui/controls/readout-model.ts
//
// PURE formatting for Readout.svelte (the RACKLINE `.readout` / `.value-chip`
// / `.ctl-val` mono display value). Reproduces the Knob/Fader numeric
// formatter (k-suffix at ≥1000, decimals that tighten as the magnitude grows)
// so a value shown under a knob and the same value in a standalone readout
// render identically — with an optional precision override for chips that want
// a fixed decimal count (e.g. "0.40") and a string pass-through for label-style
// readouts ("ALG 05", "unipolar").

export interface ReadoutFormatOptions {
  /** Appended after the number with a space (e.g. "Hz", "dB"). */
  units?: string;
  /** Force a fixed number of decimals instead of the magnitude-based default. */
  precision?: number;
}

/**
 * Format a display value. Strings pass through untouched (only units appended);
 * numbers get the shared k-suffix/magnitude formatting, or a fixed `precision`
 * when given. Non-finite numbers render as an em dash.
 */
export function formatReadout(
  value: number | string,
  opts: ReadoutFormatOptions = {},
): string {
  const { units, precision } = opts;
  const withUnits = (s: string): string => (units ? `${s} ${units}` : s);

  if (typeof value === 'string') return withUnits(value);
  if (!Number.isFinite(value)) return withUnits('—');

  if (typeof precision === 'number') {
    return withUnits(value.toFixed(Math.max(0, precision)));
  }

  const abs = Math.abs(value);
  let s: string;
  if (abs >= 10000) s = `${(value / 1000).toFixed(1)}k`;
  else if (abs >= 1000) s = `${(value / 1000).toFixed(2)}k`;
  else if (abs >= 100) s = value.toFixed(0);
  else if (abs >= 10) s = value.toFixed(1);
  else s = value.toFixed(2);
  return withUnits(s);
}
