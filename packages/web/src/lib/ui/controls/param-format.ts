// packages/web/src/lib/ui/controls/param-format.ts
//
// The ONE numeric readout ladder for a param value, extracted so every surface
// that prints a param prints the SAME STRING.
//
// It was copy-pasted THREE times (Knob.svelte, KnobConic.svelte, Fader.svelte —
// each a private `function format(v, u)` with the identical k-suffix ladder).
// The Push 2 card is the fourth consumer, and a fourth copy is exactly the
// "a card silently disagrees with its def" divergence class CLAUDE.md warns
// about: the hardware screen and the on-screen dial would be free to drift
// apart digit by digit with no gate able to see it. `param-format.test.ts`
// additionally greps the three primitives so a future copy-paste fails loudly.
//
// PURE — no DOM, no Svelte. Node-testable.

/**
 * The param-value readout ladder: a k-suffix above 1000 and a precision that
 * shrinks as the magnitude grows, so a 20 kHz cutoff and a 0.35 mix both fit
 * the same narrow column.
 *
 *   |v| ≥ 10000 → `20.0k`     (1 decimal on the thousands)
 *   |v| ≥  1000 → `1.50k`     (2 decimals on the thousands)
 *   |v| ≥   100 → `440`       (integer)
 *   |v| ≥    10 → `12.5`      (1 decimal)
 *   otherwise   → `0.35`      (2 decimals)
 *
 * `units` is appended after a single space when non-empty (`440 Hz`).
 * Total: a non-finite input falls through to the last rung and prints
 * `NaN` / `Infinity` rather than throwing (this runs on every animation
 * frame while a value moves).
 */
export function formatParamNumber(v: number, units = ''): string {
  const abs = Math.abs(v);
  let str: string;
  if (abs >= 10000) str = `${(v / 1000).toFixed(1)}k`;
  else if (abs >= 1000) str = `${(v / 1000).toFixed(2)}k`;
  else if (abs >= 100) str = v.toFixed(0);
  else if (abs >= 10) str = v.toFixed(1);
  else str = v.toFixed(2);
  return units ? `${str} ${units}` : str;
}

/**
 * Does this param range straddle zero — i.e. is it an ATTENUVERTER / bipolar
 * control whose visual anchor is the CENTRE, not the left edge?
 *
 * Extracted from Fader.svelte's `isBipolar` so the fader's centre tick, the
 * Push card's bar origin and anything else that needs the answer agree by
 * construction. A bar drawn from the left edge for a `-1..1` attenuverter
 * resting at 0 reads as "half turned up" — the single most misleading thing a
 * value bar can do. PURE.
 */
export function isBipolarRange(min: number, max: number): boolean {
  return min < 0 && max > 0;
}
