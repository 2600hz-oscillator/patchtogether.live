// packages/web/src/lib/ui/controls/selector-model.ts
//
// PURE option-list logic for Selector.svelte (the RACKLINE `.selector` /
// `.preset-pick` dropdown). Handles BOTH the param case (a discrete numeric
// param whose 0..N options are filter modes / clock sources) and the
// non-param case (a named list like DX7's preset roster, values arbitrary).
// The component is a thin shell: it renders `.selector` + a popup list and
// calls these to resolve the current option, cycle with the wheel, and map an
// inbound MIDI-CC fraction onto an option.

/** One dropdown entry. `value` is what onchange emits (a param number, or an
 *  arbitrary key for a non-param list); `label` is the shown text. */
export interface SelectorOption<T extends number | string = number | string> {
  value: T;
  label: string;
  title?: string;
}

/** Index of the option whose value === `value`, else -1. */
export function findOptionIndex<T extends number | string>(
  value: T,
  options: readonly SelectorOption<T>[],
): number {
  for (let i = 0; i < options.length; i++) {
    if (options[i]!.value === value) return i;
  }
  return -1;
}

/** The currently-selected option, or the first option as a fallback (so the
 *  chip never renders blank for a stale/unknown value), or undefined if empty. */
export function currentOption<T extends number | string>(
  value: T,
  options: readonly SelectorOption<T>[],
): SelectorOption<T> | undefined {
  if (options.length === 0) return undefined;
  const i = findOptionIndex(value, options);
  return i >= 0 ? options[i]! : options[0]!;
}

/** The label to show for `value` (falls back to the first option's label, then
 *  the raw value string). */
export function selectorLabel<T extends number | string>(
  value: T,
  options: readonly SelectorOption<T>[],
): string {
  return currentOption(value, options)?.label ?? String(value);
}

/**
 * Cycle from the current value by `dir` (+1 next / -1 prev), wrapping. Returns
 * the new option's value. Used by wheel + arrow-key stepping. An unknown
 * current value starts the step from index 0.
 */
export function cycleOptionValue<T extends number | string>(
  value: T,
  options: readonly SelectorOption<T>[],
  dir: number,
): T {
  if (options.length === 0) return value;
  const cur = findOptionIndex(value, options);
  const base = cur < 0 ? 0 : cur;
  const step = dir >= 0 ? 1 : -1;
  const next = (base + step + options.length) % options.length;
  return options[next]!.value;
}

/**
 * Map an inbound MIDI-CC fraction [0,1] to an option value by index (evenly
 * quantized across the roster), so a learned CC sweeps the whole list. Works
 * for non-numeric option values too (it's index-based, not value-based).
 */
export function ccFractionToOptionValue<T extends number | string>(
  frac: number,
  options: readonly SelectorOption<T>[],
): T | undefined {
  if (options.length === 0) return undefined;
  const f = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  const idx = Math.min(options.length - 1, Math.round(f * (options.length - 1)));
  return options[idx]!.value;
}

/**
 * The numeric [min,max] span of an option roster whose values are all numbers
 * (for wiring makeMidiAssignable's CC scaling), or null when any value is a
 * string (a non-param preset list — MIDI-assign is disabled there).
 */
export function numericOptionRange(
  options: readonly SelectorOption[],
): { min: number; max: number } | null {
  if (options.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const o of options) {
    if (typeof o.value !== 'number' || !Number.isFinite(o.value)) return null;
    if (o.value < min) min = o.value;
    if (o.value > max) max = o.value;
  }
  return { min, max };
}
