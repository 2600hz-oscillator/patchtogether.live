// skifree-bridge.ts
//
// THE SKIFREE RUNTIME OWNER — the bundle loader plus the `globalThis.__skifree`
// publication seam. ONE owner: the FACTORY.
//
// ── WHAT THIS FILE USED TO BE, AND WHY THE CHANGE IS THE FIX ────────────────
//
// It was an ownership REFEREE. The bridge had two owners writing different
// fields with different lifetimes — `onGate` set by the FACTORY at materialize
// (node lifetime) and `controller` set by the CARD when it loaded the bundle
// (card lifetime) — and #1590 was the card's `onDestroy` deleting the whole
// object, taking the factory's `onGate` with it and killing GATE, this module's
// only trigger source, for the life of the node.
//
// That fix was correct and it treated a symptom. The DISEASE was that the game
// belonged to the card at all:
//
//   * `SkifreeCard.svelte` was the only place `window.SkiFree.create()` was
//     ever called, against the card's OWN `bind:this` canvas; and
//   * under the shipping shell an un-migrated module renders a PLACEHOLDER
//     tile, so the card exists only while the dock full-view is open.
//
// MEASURED on `/rack` with one skifree node and NOTHING expanded — the default
// state of any saved rack containing it, not a collapse edge case:
//
//     samples 45 / 368 ms · tick 0 -> 15 · distance 0 -> 0 · controller: false
//
// The scheduler tick advanced (so the node was materialized and the engine was
// running) and the skier never moved, because no controller existed at all.
// Expanding the dock started a game; collapsing it destroyed the run.
//
// ⚠ IT FAILED BLACK, NOT BROKEN, WHICH IS WHY IT SURVIVED. The factory's
// `drawFrame` reads `bridge?.controller?.canvas` and returns early when absent,
// so the `out` VIDEO port emitted a black frame rather than an error. A
// downstream VIDEO OUT looked plausible and nothing was logged.
//
// ── THE OWNERSHIP NOW ───────────────────────────────────────────────────────
//
// The game's lifetime is the NODE's, and the audio FACTORY already has exactly
// that lifetime — measured, not assumed: `reconciler.ts` adds a node only when
// its id enters the graph snapshot and removes it only when the id leaves, and
// `Canvas.svelte` boots the PatchEngine once and memoizes it (a latency change
// is documented as applying "on the next reload"). There is no path that
// re-materializes a live node, so factory lifetime IS node lifetime.
//
// So the factory owns the DETACHED canvas, the bundle load, the controller and
// `onGate`. THE CARD CREATES NOTHING AND DISPOSES NOTHING — it blits the
// controller's canvas into its own visible one and forwards mouse steering.
//
// ⚠ WHY NOT A NODE-KEYED REGISTRY, which is where the rest of this bug family
// (#1531 / #1574 / #1583) landed. Every one of those registries owns a resource
// the factory COULD NOT own: `node-media-registry` a media element the card
// acquires, the DOOM registry a netgame SESSION the card starts. DOOM's own
// header is the tell — it says the WASM RUNTIME needed no registry because it
// was factory-created and *"already had node lifetime"*. SKIFREE's controller
// is in the card only by accident of where it was written, so the registry
// would be new machinery standing in for a lifetime the factory already has.
//
// ⚠ WHY THE BUNDLE CAN LOAD OUTSIDE A COMPONENT AT ALL, measured on the
// vendored file rather than assumed: `skifree.bundle.js` contains ZERO
// `document.` references, so the canvas never needs a parent; its game loop is
// its own `requestAnimationFrame` inside the bundle, so it self-drives with no
// card and no registry ticker; and its two `getBoundingClientRect` calls are
// only on the pointer path, reached through the separate `enableMouse(el)`
// call — which is why mouse steering stays a card concern and takes the card's
// visible element. Guarded DOM in an audio factory is precedented
// (`spectrograph.ts`, `twotracks.ts`).
//
// ── ⚠ WHAT THIS DOES *NOT* FIX, stated so nobody reads it as solved ─────────
//
// `__skifree` is still a SINGLE GLOBAL with no node keying, so two SKIFREE
// nodes would share one publication. `maxInstances: 1` bounds it to one node
// per rack, and the seam is kept because it is how `skifree.spec.ts` reaches
// the controller to force a crash. The controller is ALSO reachable per-node
// through `engine.read(node, 'controller')`, which is what the card uses and
// what a future node-keyed fix would build on.
//
// STRUCTURAL GUARD: there is no `deleteBridge()`, no `resetBridge()`, and — the
// new one — NO WAY FOR A CARD TO RELEASE THE CONTROLLER. `releaseSkifreeCardState`
// is DELETED rather than deprecated, so the #1590 shape has no spelling and
// `tsc` refuses a future `onDestroy` that tries to re-introduce it, before any
// test runs. That is the same absence-is-the-guard discipline the node
// registries use (#1531 / #1574).
//
// LOCATION: deliberately NOT in `lib/audio/modules/` — `module-manifest.ts`
// globs `../audio/modules/*.ts` and treats every file there as a module DEF, so
// a helper parked beside the defs reddens the manifest gate.

import type { SkiFreeGlobal, SkifreeBridge } from './modules/skifree';
import { SKIFREE_BUNDLE_SRC } from './modules/skifree';

/** Read the bridge without creating one. */
function peek(): SkifreeBridge | undefined {
  return (globalThis as unknown as { __skifree?: SkifreeBridge }).__skifree;
}

/**
 * Get the bridge, creating it if absent.
 *
 * Still shared rather than inlined: the factory writes it and the card + the
 * e2e read it, so one literal keeps the initial shape from drifting.
 */
export function ensureSkifreeBridge(): SkifreeBridge {
  const w = globalThis as unknown as { __skifree?: SkifreeBridge };
  if (!w.__skifree) {
    w.__skifree = { controller: null, onGate: null, cvDriven: false };
  }
  return w.__skifree;
}

/** In-flight bundle load, so two nodes (or a reload race) share one fetch. */
let bundleLoad: Promise<SkiFreeGlobal> | null = null;

/**
 * Load the vendored bundle and hand back `window.SkiFree`.
 *
 * Idempotent and memoized: `window.SkiFree` surviving a node's disposal is
 * deliberate — the bundle is CODE, not state, so a re-added node reuses it with
 * no second network round trip. Rejects (rather than resolving with a missing
 * global) so the caller can report a real failure instead of a silent black
 * frame.
 */
export function ensureSkifreeBundle(): Promise<SkiFreeGlobal> {
  const w = globalThis as unknown as { SkiFree?: SkiFreeGlobal };
  if (w.SkiFree) return Promise.resolve(w.SkiFree);
  if (bundleLoad) return bundleLoad;
  bundleLoad = new Promise<SkiFreeGlobal>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('SKIFREE: no document — the bundle needs a browser'));
      return;
    }
    const s = document.createElement('script');
    s.src = SKIFREE_BUNDLE_SRC;
    s.async = false;
    s.onload = () => {
      const g = (globalThis as unknown as { SkiFree?: SkiFreeGlobal }).SkiFree;
      if (g) resolve(g);
      else reject(new Error('SKIFREE: window.SkiFree missing after load'));
    };
    s.onerror = () => reject(new Error('SKIFREE bundle failed to load (404?)'));
    document.head.appendChild(s);
  }).catch((e: unknown) => {
    // A failed load must not poison every later attempt — a re-added node gets
    // a genuine second try rather than inheriting the first one's rejection.
    bundleLoad = null;
    throw e;
  });
  return bundleLoad;
}

/**
 * FACTORY teardown for the gate callback. Releases it only if it is still the
 * one this materialization installed, so a re-materialize that already
 * installed a newer callback is not clobbered.
 */
export function releaseSkifreeGate(onGate: SkifreeBridge['onGate']): void {
  const b = peek();
  if (!b) return;
  if (b.onGate !== onGate) return;
  b.onGate = null;
}

/**
 * FACTORY teardown for the controller — the same identity check, for the same
 * reason.
 *
 * ⚠ NAMED FOR THE FACTORY, AND THERE IS DELIBERATELY NO CARD-FACING TWIN. The
 * deleted `releaseSkifreeCardState` was exactly that twin, and its existence is
 * what let a card's `onDestroy` reach the shared object at all.
 */
export function releaseSkifreeController(controller: SkifreeBridge['controller']): void {
  const b = peek();
  if (!b) return;
  if (b.controller !== controller) return;
  b.controller = null;
}
