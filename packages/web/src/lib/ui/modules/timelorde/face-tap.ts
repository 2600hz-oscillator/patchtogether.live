// packages/web/src/lib/ui/modules/timelorde/face-tap.ts
//
// TAP TEMPO for the FACEPLATE's action cell.
//
// ⚠ THE CONTROLLER IS KEYED ON THE NODE, NOT HELD BY A COMPONENT, and that is
// the whole reason this file exists rather than a `new TapTempo()` inside a
// Svelte component. A tap series spans presses; a faceplate cell's component
// unmounts on dock collapse, on an LRU eviction and on a tab switch — the
// card-unmount-kills-node-lifetime-state class (#1531 / #1574 / #1583). A
// component-held controller would silently forget the series between the first
// tap and the second in exactly the cases a player would not notice, so tapping
// twice would set no tempo at all and look like a dead button.
//
// ⚠ AND IT IS THE SAME `TapTempo` THE CARD AND THE ELECTRA USE. Median of the
// recent intervals, 2-tap lock, ~2 s timeout reset, clamped to TIMELORDE's
// declared range — imported, never re-derived, so the face, the card, the
// Spacebar shortcut and the hardware pad cannot disagree about what a tap means.
// The result is written through `setNodeParam`, the SAME path the BPM control
// drives, so it persists and syncs with no new param and no worklet change.

import { TapTempo } from '$lib/electra/tap-tempo';
import { setNodeParam } from '$lib/graph/mutate';

const CONTROLLERS = new Map<string, TapTempo>();

/** The tap controller for one TIMELORDE node, created on first use. */
function controllerFor(nodeId: string): TapTempo {
  let c = CONTROLLERS.get(nodeId);
  if (!c) {
    c = new TapTempo();
    CONTROLLERS.set(nodeId, c);
  }
  return c;
}

/**
 * One tap. Returns the BPM it locked, or `null` when the series is still too
 * short to have an interval — which is EVERY first press, by design, and is why
 * the cell's probe declares two.
 *
 * ⚠ It does NOT reproduce the card's `hasExternalClock` early-return, and that
 * is deliberate rather than an oversight. The behaviour is identical either way:
 * with a clock cable patched, the follower overwrites `bpm` on its next
 * measurement, so a tap is a no-op whichever side refuses it. Reproducing the
 * refusal here would mean this file walking `patch.edges` — a second, drifting
 * copy of a fact the factory already owns — to buy nothing observable. What IS
 * lost is the card's greyed-out AFFORDANCE SIGNAL, because `ShellActionCell` has
 * no `disabled` predicate; the accessible name carries it instead.
 */
export function timelordeFaceTap(nodeId: string): number | null {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const bpm = controllerFor(nodeId).tap(now);
  if (bpm !== null) setNodeParam(nodeId, 'bpm', bpm);
  return bpm;
}

/** Test seam: forget every series. Never called by the app. */
export function __resetTimelordeFaceTaps(): void {
  CONTROLLERS.clear();
}
