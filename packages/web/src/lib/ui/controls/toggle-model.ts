// packages/web/src/lib/ui/controls/toggle-model.ts
//
// PURE 0/1 logic for Toggle.svelte (the RACKLINE `.switch` / `.toggle-ctl`).
// A toggle is a discrete param with min=0 max=1 (kickdrum HARD, and the
// checkbox cards). `looksLikeToggle` — the detector a card uses to pick Toggle
// over Knob — is re-exported from the ONE canonical definition in
// graph/group-controls so the auto-expose bar and the primitive agree.

export { looksLikeToggle } from '$lib/graph/group-controls';

/** A value at/above this reads as ON. Matches the drum-card convention
 *  (`hard >= 0.5`). */
export const TOGGLE_ON_THRESHOLD = 0.5;

/** Is this toggle currently ON? (>= 0.5, so a stored 1 or a mid-scale CV both
 *  latch on.) */
export function isToggleOn(value: number): boolean {
  return value >= TOGGLE_ON_THRESHOLD;
}

/** The value to commit when the toggle is flipped from its current value. */
export function toggledValue(value: number): 0 | 1 {
  return isToggleOn(value) ? 0 : 1;
}

/** Snap any incoming value (e.g. a scaled MIDI CC) to a clean 0/1. */
export function coerceToggle(value: number): 0 | 1 {
  return isToggleOn(value) ? 1 : 0;
}
