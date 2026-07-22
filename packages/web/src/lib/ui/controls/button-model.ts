// packages/web/src/lib/ui/controls/button-model.ts
//
// PURE press/edge semantics for Button.svelte (the RACKLINE `.btn` — strike /
// reset / load / SAVE). A card button is one of two behaviours:
//   • TRIGGER (default) — fires ONCE on the press edge (a strike, a reset, a
//     load). The release does nothing.
//   • MOMENTARY — fires true while held, false on release (a gate the user
//     holds, e.g. an audition/hold pad).
// This mirrors MidiAssignButton's momentary-vs-toggle branch so a screen press
// and a learned MIDI NOTE resolve to the SAME action. The component is a thin
// shell that calls buttonPointerFire (pointer down/up) + buttonGateFire (MIDI
// note on/off) and dispatches per the result.

/** Pointer edges the button reacts to. */
export type ButtonPointerEdge = 'down' | 'up';

/** What a given edge should dispatch. `null` = nothing fires on this edge. */
export type ButtonFire = 'trigger' | 'press' | 'release' | null;

/**
 * Resolve a POINTER edge to an action.
 *   momentary:  down → 'press'   (gate high), up → 'release' (gate low)
 *   trigger:    down → 'trigger' (one-shot),  up → null
 */
export function buttonPointerFire(momentary: boolean, edge: ButtonPointerEdge): ButtonFire {
  if (momentary) return edge === 'down' ? 'press' : 'release';
  return edge === 'down' ? 'trigger' : null;
}

/**
 * Resolve a MIDI NOTE gate edge to an action (the note-driven mirror of
 * buttonPointerFire).
 *   momentary:  high → 'press', low → 'release'
 *   trigger:    high → 'trigger', low → null (a one-shot ignores note-off)
 */
export function buttonGateFire(momentary: boolean, high: boolean): ButtonFire {
  if (momentary) return high ? 'press' : 'release';
  return high ? 'trigger' : null;
}
