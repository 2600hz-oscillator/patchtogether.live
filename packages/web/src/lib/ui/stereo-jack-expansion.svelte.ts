// packages/web/src/lib/ui/stereo-jack-expansion.svelte.ts
//
// WHICH COLLAPSED STEREO JACKS THE USER HAS UN-COLLAPSED — the state half of
// the right-click "expand to L / R jacks" gesture.
//
// A collapsed jack is the right DEFAULT (one cable, one gesture, both legs),
// but it hides the two legs the def actually declares, so a per-leg patch has
// no hole to point at and a landed cable's side is unreadable. Expanding a
// pair renders its two legs as two ordinary rows; every other pair on the card
// stays collapsed.
//
// SCOPE — VIEW STATE, NOT GRAPH STATE. Expanding a jack changes what the panel
// DRAWS and nothing else: no edge is written, moved or removed, and the def is
// untouched. Both legs already have their own hidden xyflow handle whether or
// not the pair is expanded (PatchPanel's `handleInputs`/`handleOutputs` are the
// RAW lists precisely so a per-leg cable always has somewhere to land), so
// expansion adds no anchor and removes none. That is why this lives in a
// module-scoped rune rather than in the Y.Doc:
//
//   * it is PER-VIEWER — one collaborator wanting to see CH1's two legs is not
//     a statement about the patch, and syncing it would yank another user's
//     layout around mid-edit;
//   * it is NOT UNDOABLE — "expand" landing in the undo stack between two real
//     edits is noise, and worse, it would make ⌘Z ambiguous;
//   * it cannot desync from anything, because nothing reads it but the render.
//
// The cost is that it does not survive a reload, which is the accepted trade:
// the expansion exists to MAKE a patch, and the cables it helps you make are
// the part that persists.
//
// KEYING is `(nodeId, direction, leftPortId)`. Per-NODE, not per-type: two
// MIXMSTRS on one rack expand independently, which is what "expand this jack"
// means when you are looking at one card. The pair's LEFT port id names the
// pair — the same identity `collapseStereoPorts` gives a collapsed row, so the
// two agree by construction rather than by convention.

import { SvelteSet } from 'svelte/reactivity';
import type { PortDirection } from '$lib/graph/stereo-pairs';

/** The composite key for one expandable jack.
 *
 *  A NUL separator can never occur in a node or port id, so a key cannot be
 *  forged by an id that happens to contain the delimiter — the same reasoning
 *  (and the same escape-not-a-raw-byte rule, so git keeps the file textual) as
 *  `cable-leg-groups`' LEG_KEY_SEP. */
const KEY_SEP = '\u0000';

export function expansionKey(
  nodeId: string,
  direction: PortDirection,
  leftPortId: string,
): string {
  return [nodeId, direction, leftPortId].join(KEY_SEP);
}

/** The live set of expanded jacks. Module-scoped: one per app instance. */
const expanded = new SvelteSet<string>();

/** Is this pair currently rendered as two rows? */
export function isJackExpanded(
  nodeId: string,
  direction: PortDirection,
  leftPortId: string,
): boolean {
  return expanded.has(expansionKey(nodeId, direction, leftPortId));
}

/** Flip one pair between collapsed and expanded. Returns the NEW state. */
export function toggleJackExpanded(
  nodeId: string,
  direction: PortDirection,
  leftPortId: string,
): boolean {
  const key = expansionKey(nodeId, direction, leftPortId);
  if (expanded.has(key)) {
    expanded.delete(key);
    return false;
  }
  expanded.add(key);
  return true;
}

/** Explicitly set one pair's state (the menu rows, which say which way they go
 *  rather than toggling blind). */
export function setJackExpanded(
  nodeId: string,
  direction: PortDirection,
  leftPortId: string,
  value: boolean,
): void {
  const key = expansionKey(nodeId, direction, leftPortId);
  if (value) expanded.add(key);
  else expanded.delete(key);
}

/**
 * The LEFT port ids expanded on `(nodeId, direction)` — exactly the shape
 * `collapseStereoPorts` takes as its `expandedLeftIds` argument.
 *
 * Returns a fresh Set each call, and READS the reactive set, so a Svelte
 * `$derived` over it re-runs when any jack toggles. Callers must not mutate it.
 */
export function expandedLeftIdsFor(
  nodeId: string,
  direction: PortDirection,
): ReadonlySet<string> {
  const prefix = expansionKey(nodeId, direction, '');
  const out = new Set<string>();
  for (const key of expanded) {
    if (key.startsWith(prefix)) out.add(key.slice(prefix.length));
  }
  return out;
}

/** Drop every expansion for a node — called when the node leaves the rack, so
 *  a re-added node with a recycled id does not inherit a stale layout. */
export function clearNodeExpansions(nodeId: string): void {
  const prefix = nodeId + KEY_SEP;
  for (const key of [...expanded]) {
    if (key.startsWith(prefix)) expanded.delete(key);
  }
}

/** TEST SEAM ONLY — reset the module-scoped set between cases. */
export function __resetJackExpansions(): void {
  expanded.clear();
}
