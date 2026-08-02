// packages/web/src/lib/audio/adsr-stage-format.ts
//
// PURE readout arithmetic for the ADSR stage controls — the model behind
// `ParamDef.format` (PF-3) on adsr's attack / decay / release / sustain.
// No DOM, no engine: the def declares the formatter, KnobConic renders the
// string, and the number→text law is unit-testable on its own.
//
// WHY THIS EXISTS AT ALL. KnobConic's built-in fallback formatter is
// magnitude-banded and bottoms out at two decimals (`KnobConic.svelte:219-228`:
// `abs < 10 → v.toFixed(2)`), which is fine for a 0..1 level and useless for a
// LOG-SCALED time that spans 0.001..10 s: the module's own attack DEFAULT
// (0.005 s) prints as "0.01 s", and the whole bottom decade — 1 ms to 9 ms, a
// third of the dial's travel and the entire difference between a click and a
// pluck — collapses onto "0.00 s" / "0.01 s". The knob cannot say what it is
// set to in the range it exists to provide.
//
// So the law here is: SHOW THE UNIT THE VALUE IS ACTUALLY IN.
//   1 ms … 9.9 ms  → "5 ms"     (one decimal, trailing ".0" trimmed)
//   10 ms … 999 ms → "220 ms"   (whole milliseconds)
//   1 s … 9.99 s   → "1.20 s"
//   10 s           → "10.0 s"
// Every band carries 2–3 significant figures, and the band edges are chosen so
// the text never lies by rounding across a unit (0.9996 s reads "1.00 s", never
// "1000 ms"). Matches the dock mock's stage readouts verbatim (8 ms / 220 ms /
// 0.62 / 480 ms).
//
// TOTALITY IS A REQUIREMENT, NOT A COURTESY. `format` is called on EVERY
// animation frame while a value moves (KnobConic's readLive tick) and its
// output is also the dial's `aria-valuetext`, so it must be pure, allocate
// little, never throw, and never return an empty string. Non-finite input
// formats to a visible placeholder rather than "NaN ms".

/** What a non-finite value reads as. Visible, never empty (see totality). */
export const NON_FINITE_READOUT = '—';

/** Strip a trailing ".0" so 8.0 ms reads "8 ms" (the mock's text) while 1.5 ms
 *  keeps its decimal. */
function trimPointZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/**
 * A stage TIME in seconds → the knob's persistent readout.
 *
 * Unit-banded (see the header): sub-10 ms keeps one decimal, the rest of the
 * sub-second range is whole milliseconds, and a second or more is seconds.
 * Monotonic: reading two values back never inverts their order, which is the
 * property that makes the readout usable as a dial scale rather than decoration.
 */
export function formatStageTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return NON_FINITE_READOUT;
  const v = seconds > 0 ? seconds : 0;
  const ms = v * 1000;
  // Band edges are the ROUNDING midpoints of the band above, so a value that
  // would round up out of its band is printed in the band it rounds INTO —
  // never "10.0 ms" and never "1000 ms".
  if (ms < 9.95) return `${trimPointZero(ms.toFixed(1))} ms`;
  if (ms < 999.5) return `${Math.round(ms)} ms`;
  if (v < 9.995) return `${v.toFixed(2)} s`;
  return `${v.toFixed(1)} s`;
}

/**
 * The sustain LEVEL (0..1) → the knob's persistent readout.
 *
 * Deliberately plain two decimals, and deliberately WITHOUT a unit: sustain is
 * the one stage that is a level rather than a time, and printing it next to
 * three time readouts is what says so at a glance. (This is the mock's `0.62`.)
 */
export function formatSustainLevel(level: number): string {
  if (!Number.isFinite(level)) return NON_FINITE_READOUT;
  return level.toFixed(2);
}
