// packages/web/src/lib/ui/media/loopback-crop-pump.ts
//
// THE LOOPBACK CROP PUMP — the per-frame viewport measurement that windows a
// tab capture down to "just what I see", given a NODE-scoped home instead of a
// card-scoped one.
//
// ── What the pump is ────────────────────────────────────────────────────────
//
// LOOPBACK captures the whole browser TAB. To make its output "the active
// viewport" rather than "the tab plus all the surrounding app chrome", someone
// has to measure the canvas pane's on-screen rectangle EVERY FRAME (the user
// pans, zooms, resizes, opens the dock) and push it to the engine through the
// private `_cropU0`.._cropV1` setParam channel. Those four are deliberately NOT
// declared params: each collaborator's viewport is different, so the crop is
// per-viewer LOCAL render state and must never sync through the Y.Doc.
//
// ── Why it moved off the card (#1531 discipline) ────────────────────────────
//
// The pump used to be an `$effect` inside `LoopbackCard.svelte`, which tied a
// NODE-lifetime concern to a CARD lifetime. Two things end a card mount without
// ending the capture, and the stream deliberately survives both (it is
// node-owned via ./node-media-registry, because a getDisplayMedia capture
// cannot be restarted without a fresh user gesture):
//
//   * COLLAPSE / the dock's LRU eviction — the #1531 class outright;
//   * PROMOTION — the shell swaps the lane card for a faceplate and the real
//     card moves into `<HeadlessSourceHost>`.
//
// With the pump on the card, the first of those froze `_crop*` at whatever the
// last mounted frame measured. The capture kept running and kept feeding OUT,
// so nothing looked broken — the picture simply stopped tracking the viewport,
// which is the stuck-value shape rather than a visible failure.
//
// ── ⚠ AND WHY THE MEASUREMENT ITSELF WAS UNSAFE ─────────────────────────────
//
// ⚠ MEASURED, AND NOT WHAT IT LOOKS LIKE: this is a PRE-EXISTING defect that
// the promotion merely walks past, NOT one the promotion creates. It is worth
// being exact, because "the face broke the crop" and "the crop was already
// ambiguous" call for the same fix but a different story.
//
// The old reader was `document.querySelector('.svelte-flow')`, and the tempting
// account is "there used to be one flow in the document". There did not.
// `<HeadlessSourceHost>` mounts each hosted card inside ITS OWN `<SvelteFlow>`
// (it has to: PatchPanel and every `useStore()`-reading card need a real flow
// provider), and `needsHeadlessSourceMount` returns true for BOTH the
// 'placeholder' and the 'shell' lane kinds. LOOPBACK is in
// `DOM_SOURCE_LANE_TYPES`, so an UNFACED loopback already renders a
// placeholder in the lane and already runs its real card inside a second
// `.svelte-flow`, parked at `left:-9999px` with `width: 300px; height: 420px`.
// Promotion flips 'placeholder' → 'shell'. The number of flows does not move.
//
// `querySelector` returns the FIRST match in document order, and the canvas's
// flow is emitted before the host inside `<div class="flow">`, so the old
// selector happens to pick the right one. THAT IS A COINCIDENCE OF MARKUP
// ORDER, not a guarantee, and it is the exact class the fleet has been bitten
// by repeatedly: an off-screen host copy reading as the real thing. Had the
// order gone the other way the measured rect would be
// `{ x: -9999, y: 0, w: 300, h: 420 }`, which `computeCropUv` clamps to a
// collapsed region and therefore falls back to FULL_FRAME — so the failure
// presents as "the Crop control silently does nothing", with no error
// anywhere, on a module whose entire purpose is that crop.
//
// ⚠ AND NOTHING WOULD HAVE CAUGHT IT. `loopback.spec.ts` runs every test on
// `?shell=legacy`, where no host exists at all; its crop test drives `crop`
// through the engine under `__loopbackTestFrame`, whose `effectiveCrop()`
// derives the rectangle from the PARAM and never calls this reader. So the one
// spec named after the module is blind to its crop measurement by
// construction — which is why the fix ships with a pure unit test rather than
// with an assertion bolted onto that spec.
//
// So the pick is now EXPLICIT and TESTED: query every `.svelte-flow`, reject
// any that is inside a `.headless-source-host`, take the first survivor. See
// `pickCanvasViewport` — a pure predicate with a negative control in both
// directions, which is what the old selector could never have.
//
// HASH TRANSPARENCY: `lib/ui/**`, NOT `lib/video/**`. The crop MATH stays in
// `$lib/video/loopback-crop` (attest basis, untouched by this file); only the
// scheduling and the DOM reading live here. That split is deliberate and is a
// constraint on any future edit: moving this file into `lib/video/**` would put
// a rAF loop into the GPU attest basis.
//
// TESTABILITY: the rAF seam, the measurement and the push are all INJECTABLE,
// so the pump unit-tests with no DOM and no engine — the web package's vitest
// runs in `environment: 'node'`.

import { computeCropUv, FULL_FRAME_CROP, type CropUv, type ElementRect } from '$lib/video/loopback-crop';

/** Every `<SvelteFlow>` root in the document carries this class. */
export const FLOW_ROOT_SELECTOR = '.svelte-flow';

/**
 * The off-screen host `<HeadlessSourceHost>` wraps each hosted card in. Kept as
 * an exported constant so the rejection below and the spec that proves it
 * cannot drift from the markup independently.
 */
export const HEADLESS_HOST_SELECTOR = '.headless-source-host';

/** The minimum a candidate must support for `pickCanvasViewport` to judge it.
 *  Structural on purpose: the unit test drives the predicate with plain objects
 *  rather than needing a DOM this package's vitest does not have. */
export interface ClosestLike {
  closest(selector: string): unknown;
}

/**
 * Pick the REAL canvas flow out of every `.svelte-flow` in the document.
 *
 * ⚠ THE REJECTION IS THE POINT, and it is why this is a function rather than a
 * cleverer CSS selector. A child-combinator selector (`.flow > .svelte-flow`)
 * would also exclude today's host, but it encodes the host's CURRENT nesting
 * depth — it silently stops excluding anything the day the host is wrapped in
 * one more div, and a selector that quietly matches nothing looks identical to
 * one that matches the right thing. Asking each candidate whether it is inside
 * a headless host names the actual property, and the property is what a test
 * can negative-control.
 *
 * Returns null when every candidate is hosted (or there are none) — a real
 * answer the caller must handle, never a silently-wrong element.
 */
export function pickCanvasViewport<T extends ClosestLike>(candidates: readonly T[]): T | null {
  for (const el of candidates) {
    if (el.closest(HEADLESS_HOST_SELECTOR)) continue;
    return el;
  }
  return null;
}

/** A measured app viewport: the pane's rect plus the layout viewport it sits
 *  in. Both are needed — `computeCropUv` is resolution-independent but not
 *  scale-independent. */
export interface ViewportMeasurement {
  rect: ElementRect;
  viewportW: number;
  viewportH: number;
}

/**
 * Measure the on-screen canvas pane. Returns null in a non-DOM runtime.
 *
 * Falls back to `documentElement` (the whole layout viewport) when no unhosted
 * flow exists — the same fallback the card always had, kept because it is the
 * honest answer for a rack that has not mounted its canvas yet, and because
 * "the whole tab" is a sane crop rather than a broken one.
 */
export function measureCanvasViewport(): ViewportMeasurement | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  const candidates = [...document.querySelectorAll(FLOW_ROOT_SELECTOR)];
  const el: Element | null = pickCanvasViewport(candidates) ?? document.documentElement ?? null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    rect: { x: r.left, y: r.top, width: r.width, height: r.height },
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
  };
}

/** What a pump needs from its owner. Everything reactive is a FUNCTION, read
 *  fresh each tick, so nothing here goes stale when the card that supplied it
 *  unmounts. */
export interface CropPumpDeps {
  /** Push the four bounds into the engine's private `_crop*` channel. */
  push(crop: CropUv): void;
  /**
   * Is crop-to-viewport on right now? ⚠ MUST read the GRAPH STORE, not a
   * card-local `$derived`: the pump outlives the card, and a captured
   * component-scoped value would freeze at the last mounted frame — the very
   * bug this file exists to remove.
   */
  cropEnabled(): boolean;
  /** Measurement seam. Defaults to the real DOM reader above. */
  measure?: () => ViewportMeasurement | null;
  /** rAF seam. Defaults to `requestAnimationFrame`. */
  schedule?: (fn: () => void) => number;
  /** rAF cancel seam. Defaults to `cancelAnimationFrame`. */
  cancel?: (handle: number) => void;
}

export interface LoopbackCropPumpRegistry {
  /**
   * Start (or restart) the pump for a node. IDEMPOTENT while running: a card
   * remount re-asserting the pump must not stack a second rAF loop on one node,
   * because two loops would both push every frame and double the engine writes
   * for no benefit.
   */
  start(nodeId: string, deps: CropPumpDeps): void;
  /** Stop the pump for a node. Idempotent. */
  stop(nodeId: string): void;
  /** Is a pump running for this node? */
  running(nodeId: string): boolean;
  /**
   * How many frames this node's pump has pushed.
   *
   * ⚠ THE ONLY OBSERVABLE THIS THING HAS. The pump writes to a PRIVATE param
   * channel that `readParam` does not expose and that nothing in the graph
   * mirrors, so "the pump is running" and "the pump was never started" are
   * otherwise indistinguishable from outside — the same structural blindness
   * that makes the acquire command report its delivery. Survives `stop()` so a
   * test can assert a pump DID run before it was torn down.
   */
  ticks(nodeId: string): number;
  /** Drop every pump whose node is not in `liveIds`. The graph is the
   *  authority — this is what ends a pump for a DELETED node. */
  sweep(liveIds: Iterable<string>): void;
}

interface Pump {
  handle: number | null;
  ticks: number;
  cancel: (handle: number) => void;
}

/** Build a registry. Pure apart from the scheduler the caller injects. */
export function createLoopbackCropPumpRegistry(): LoopbackCropPumpRegistry {
  const pumps = new Map<string, Pump>();

  function stopPump(nodeId: string): void {
    const p = pumps.get(nodeId);
    if (!p) return;
    if (p.handle !== null) p.cancel(p.handle);
    p.handle = null;
  }

  return {
    start(nodeId, deps) {
      const existing = pumps.get(nodeId);
      if (existing && existing.handle !== null) return; // already pumping

      const measure = deps.measure ?? measureCanvasViewport;
      const schedule =
        deps.schedule ??
        ((fn: () => void) =>
          typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : 0);
      const cancel =
        deps.cancel ??
        ((h: number) => {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(h);
        });

      const pump: Pump = { handle: null, ticks: existing?.ticks ?? 0, cancel };
      pumps.set(nodeId, pump);

      const tick = (): void => {
        // ⚠ RE-READ EVERYTHING EVERY FRAME. The crop toggle, the pane's rect
        // and the window size all change under the pump, and a value hoisted
        // out of this closure is a value that stops tracking.
        let crop: CropUv = FULL_FRAME_CROP;
        if (deps.cropEnabled()) {
          const m = measure();
          if (m) crop = computeCropUv(m.rect, m.viewportW, m.viewportH);
        }
        try {
          deps.push(crop);
        } catch {
          // A push that throws (engine torn down mid-frame) must never kill the
          // loop — the same "never nuke the rAF" discipline every preview body
          // in this tree uses.
        }
        pump.ticks++;
        pump.handle = schedule(tick);
      };

      pump.handle = schedule(tick);
    },

    stop: stopPump,

    running(nodeId) {
      return pumps.get(nodeId)?.handle != null;
    },

    ticks(nodeId) {
      return pumps.get(nodeId)?.ticks ?? 0;
    },

    sweep(liveIds) {
      const live = liveIds instanceof Set ? liveIds : new Set(liveIds);
      for (const nodeId of [...pumps.keys()]) {
        // ⚠ THE LOCAL FUNCTION, NEVER `this.stop` — see the identical note in
        // ./camera-status-registry: a `this`-dependent method breaks the first
        // time someone destructures the registry, in a teardown path.
        if (!live.has(nodeId)) {
          stopPump(nodeId);
          pumps.delete(nodeId);
        }
      }
    },
  };
}

/**
 * The process-wide crop-pump registry.
 *
 * `LoopbackCard.svelte` starts it when a capture begins and stops it on an
 * explicit stop; `Canvas.svelte` sweeps it beside every other node-keyed
 * registry. NODE-keyed, so a card unmount does not touch it.
 */
export const loopbackCropPump: LoopbackCropPumpRegistry = createLoopbackCropPumpRegistry();
