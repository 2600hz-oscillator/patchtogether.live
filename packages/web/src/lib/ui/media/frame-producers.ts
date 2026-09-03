// packages/web/src/lib/ui/media/frame-producers.ts
//
// THE NODE-LIFETIME PER-FRAME PRODUCERS (legacy-removal S1). See
// ./node-frame-producer-registry for the mechanism, the shared ticker, and why
// this is a registry rather than a permanent off-screen card mount.
//
// Each producer here is the rAF body that used to live on a `*Card.svelte`,
// with the CARD-SPECIFIC half left behind. That split is the whole edit, and it
// is worth naming precisely because the two halves look alike:
//
//   PRODUCE — reading the engine's own live state (a CV tap, an analyser
//   window, an upstream module's frame) and writing a derivation of it back
//   into the module handle. Engine-visible; every consumer of the module sees
//   it; it must run while the NODE exists.
//
//   PAINT — putting a picture on a surface someone is looking at. View-scoped;
//   it must run while the SURFACE exists and stop when it does not.
//
// The cards ran both in one loop, so `PRODUCE` inherited `PAINT`'s lifetime and
// a module went dark, silent or stale whenever no card was mounted (#1587).
// Here the two are separate by construction: nothing in this file can paint —
// it has no element to paint on.
//
// ⚠ EVERY import here is READ-ONLY on `$lib/audio/**` / `$lib/video/**`, the
// same discipline `extras-producers.ts` records: `lib/video/**` is hashed
// WHOLESALE for the WebGL attest, so importing is free and editing is not.

import { scopeDef } from '$lib/audio/modules/scope';
import { frameProducerTypes, type FrameProducer } from './node-frame-producer-registry';

/**
 * SCOPE — the combined (knob + CV) draw parameters.
 *
 * ⚠ THIS IS HOW A SAME-DOMAIN CV CABLE REACHES A DISPLAY PARAM AT ALL, which is
 * why it is a producer and not a repaint detail. `AudioEngine.addEdge` connects
 * a cv cable to the AudioParam and never calls `setParam`, and the per-frame CV
 * bridge exists only on the video side (#1664). So the module's nine display
 * params have no path from a patched cable to `drawFrame` except this push:
 * `readParam` returns the knob PLUS the engine's own per-port tap, and
 * `write(node,'cvCombined')` folds it into the module's own CV shadows — the
 * single source of truth BOTH render paths read (`read('drawParams')` for a
 * surface, `drawFrame` for `out`).
 *
 * ⚠ AND THE FAILURE WITHOUT IT IS A LATCH, NOT A FALLBACK. `$lib/audio/cv-shadow`
 * `read()` returns `combined ?? knobValue`, and `combined` is cleared ONLY by a
 * knob move. Stop the push and every param that was under CV stays frozen at
 * whatever value the modulator happened to be at — indefinitely, on a picture
 * that keeps moving, so nothing about it looks broken. `dom-source-modules.ts`
 * records the correction that first got this wrong in the other direction
 * ("degrades to the knob" — a self-limiting failure it does not have).
 *
 * ⚠ TWO SURFACES USED TO RUN THIS PUSH, AND THAT IS WHY IT MOVED RATHER THAN
 * BEING DELETED FROM ONE OF THEM. `ScopeCard.svelte` ran it inside its
 * `onMeterFrame` body and `scope/ScopeScreenBody.svelte` ran a second copy
 * inside its own, each with the same loop over `scopeDef.params` and the same
 * comment explaining why. Two writers of one engine channel is not a bug while
 * they agree, and they agreed exactly because one was pasted from the other —
 * which is the condition under which they stop agreeing silently. There is one
 * writer now, and it is not a surface.
 */
export const SCOPE_FRAME_PRODUCER: FrameProducer = {
  type: 'scope',
  why:
    'the module owns no AnalyserNode per port, so its nine display params reach `drawFrame` ' +
    'only through `write(node,"cvCombined")` — the inverse of `read("drawParams")`. With no ' +
    'writer, a param under CV LATCHES at its last modulated value forever (cv-shadow clears ' +
    '`combined` only on a knob move), so the trace and `out` keep moving on stale numbers.',
  frame({ node, engine }) {
    // ⚠ ALL NINE, EVERY FRAME, AND UNCONDITIONALLY. Sampling only the patched
    // ports would need an edge scan per frame to decide which those are, and it
    // would be WRONG the frame a cable is pulled: the shadow keeps the last
    // combined value until someone overwrites it, so a param whose cable has
    // just gone away has to be re-written with the bare knob to come back.
    // `readParam` costs a map lookup per param when nothing is patched.
    const combined: Record<string, number> = {};
    for (const p of scopeDef.params) {
      const v = engine.readParam(node, p.id);
      if (typeof v === 'number' && Number.isFinite(v)) combined[p.id] = v;
    }
    engine.write(node, 'cvCombined', combined);
  },
};

/**
 * The producers this seam owns.
 *
 * ⚠ ORDER IS NOT SIGNIFICANT and membership is DERIVED, never re-typed: both
 * `NODE_FRAME_PRODUCER_TYPES` (./node-frame-producers) and the disjointness gate
 * in `dom-source-modules.test.ts` read this array, so a producer added here
 * enters every consumer at once and cannot be half-registered.
 */
export const FRAME_PRODUCERS: readonly FrameProducer[] = [SCOPE_FRAME_PRODUCER];

/**
 * The module TYPES whose per-frame producer is owned by the NODE.
 *
 * DERIVED from the list above — never a second literal. `dom-source-modules.ts`
 * asserts this set is DISJOINT from `CARD_PRODUCER_LANE_TYPES` and that every
 * departure from that set is owned here, so a producer extraction cannot land
 * half-done in either direction.
 *
 * ⚠ EXPORTED FROM *THIS* FILE, NOT FROM THE REAL-DOM SINGLETON, and that is a
 * dependency decision rather than tidiness: a gate that only wants to ask "who
 * owns this module" should not have to import `$lib/graph/store` and the engine
 * adapters to find out. `./node-frame-producers` re-exports it for callers that
 * already hold the singleton.
 */
export const NODE_FRAME_PRODUCER_TYPES: ReadonlySet<string> =
  frameProducerTypes(FRAME_PRODUCERS);
