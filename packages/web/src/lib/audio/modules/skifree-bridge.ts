// skifree-bridge.ts
//
// OWNERSHIP RULES for the `globalThis.__skifree` bridge — one object, TWO owners.
//
// THE BUG THIS EXISTS FOR (#1590, found by the #1583 card-unmount audit): SKIFREE's GATE
// output — the module's ONLY trigger source, per its own docs — went permanently dead
// after a single collapse-and-re-expand. Game, HUD, crash counter and video all came back
// looking perfectly healthy, so nothing pointed at the cause.
//
// The bridge has two owners writing DIFFERENT fields with DIFFERENT lifetimes:
//
//   * `onGate`     — set by the FACTORY, ONCE, at materialize (skifree.ts). Its lifetime
//                    is the NODE's.
//   * `controller` — set by the CARD when the bundle loads. Its lifetime is the CARD's.
//
// The factory already got this right: at dispose it clears ONLY `onGate`, and only if the
// value is still its own (`skifree.ts:341`, an identity check — so a re-materialize that
// already installed a newer callback is not clobbered).
//
// The CARD did not. Its `onDestroy` ran `delete globalThis.__skifree`, destroying the
// WHOLE object including the factory's `onGate`. Because the factory registers only at
// materialize and never runs again, the card's remount rebuilt the bridge with
// `onGate: null` — and no crash or yeti-eat could ever pulse the gate again for the life
// of that node. Only delete-and-re-add recovered it.
//
// Under the faceplate shell that is not an edge case: an un-migrated module's card exists
// only inside the dock full-view, so COLLAPSE unmounts it — and the dock also LRU-EVICTS a
// pane when a third module is expanded, killing GATE for a module the user never touched.
//
// THE RULE, and it is the general one: WHEN TWO OWNERS SHARE AN OBJECT, EACH CLEARS ONLY
// THE FIELDS IT SET, AND ONLY IF THE VALUE IS STILL ITS OWN. Neither may delete the
// container. This file is that rule, written once, so both sides call the same code
// instead of re-deriving it — which is how they came to disagree in the first place.
//
// STRUCTURAL GUARD: there is deliberately no `deleteBridge()` / `resetBridge()` export.
// The absence is the guard, as with the node registries' missing `dispose()`
// (#1531/#1574): removing the container has no spelling, so `tsc` refuses the regression
// before any test runs.
//
// ⚠ KNOWN, SEPARATE, NOT FIXED HERE: `__skifree` is a SINGLE GLOBAL with no node keying,
// so two SKIFREE nodes share one bridge (skifree.ts:140 acknowledges this). That is a
// distinct defect from the ownership bug and needs a node-keyed bridge to fix properly.
// Do not mistake this file for having solved it.

import type { SkifreeBridge } from './skifree';

/** Read the bridge without creating one. */
function peek(): SkifreeBridge | undefined {
  return (globalThis as unknown as { __skifree?: SkifreeBridge }).__skifree;
}

/**
 * Get the bridge, creating it if absent.
 *
 * Both owners call this, so neither can disagree about the initial shape — the two
 * hand-written copies of this literal were what let the fields drift apart.
 */
export function ensureSkifreeBridge(): SkifreeBridge {
  const w = globalThis as unknown as { __skifree?: SkifreeBridge };
  if (!w.__skifree) {
    w.__skifree = { controller: null, onGate: null, cvDriven: false };
  }
  return w.__skifree;
}

/**
 * CARD teardown. Releases ONLY the card-owned field.
 *
 * `onGate` (factory-owned, node-lifetime) and `cvDriven` (factory-written each tick) are
 * deliberately left alone — clearing them is exactly the #1590 regression.
 *
 * @param controller the controller this card published, so a card that has already been
 *   replaced by a newer mount cannot null out the newer one. Omit to clear unconditionally.
 */
export function releaseSkifreeCardState(controller?: SkifreeBridge['controller']): void {
  const b = peek();
  if (!b) return;
  if (controller !== undefined && b.controller !== controller) return;
  b.controller = null;
}

/**
 * FACTORY teardown. Releases ONLY the factory-owned callback, and only if it is still
 * the one this materialization installed.
 */
export function releaseSkifreeGate(onGate: SkifreeBridge['onGate']): void {
  const b = peek();
  if (!b) return;
  if (b.onGate !== onGate) return;
  b.onGate = null;
}
