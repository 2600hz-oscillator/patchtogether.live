// packages/web/src/lib/ui/media/node-viz-surfaces.ts
//
// THE ROSTER + THE REAL-DOM SINGLETON for node-lifetime viz surfaces. See
// ./node-viz-surface-registry for the mechanism and for why wavesculpt's
// producer is a MOUNTED COMPONENT rather than a `FrameProducer` callback.
//
// ⚠ THE COMPONENT MAP IS NOT HERE, AND THAT IS DELIBERATE. It lives in
// `NodeVizSurfaceHost.svelte`, for the reason `GroupCard`'s `HOST_SURFACES`
// records: a `.ts` module that imported a `.svelte` file could not be read by
// the gates that run in the web package's `environment: 'node'` vitest, and
// `dom-source-modules.test.ts` has to import this roster to make an extraction
// atomic. `node-viz-surface-host.test.ts` parses the host's source instead and
// checks every roster member has a real, directly-imported surface component.

import {
  createNodeVizSurfaceRegistry,
  vizSurfaceTypes,
  type VizSurfaceProducer,
} from './node-viz-surface-registry';

/**
 * WAVESCULPT — the 4-voice WebGL2 room, and the last card-producer to leave.
 *
 * ⚠ WHAT THE CARD WAS ACTUALLY HOLDING, because "the card runs an rAF" undersells
 * it: `WavesculptVizSurface` installs the node's cross-domain frame drawer
 * (`installWavesculptFrameDrawer`), and with NO drawer registered the module's
 * own `drawFrame` fills the bridge canvas SOLID BLACK. So a rack saved with
 * `WAVESCULPT.video_out → VIDEO OUT` was black on load until somebody happened
 * to open the right surface — #1587, an owner P0 — and it went black again the
 * moment they closed it.
 *
 * ⚠ AND ITS DEAD STATE IS BLACK RATHER THAN STALE, which is the opposite of
 * timelorde's and is what makes this module cheap to gate: "not black" really is
 * evidence here, because the fallback is a literal `fillRect('#000')` and not the
 * last frame anyone pushed.
 */
export const VIZ_SURFACE_PRODUCERS: readonly VizSurfaceProducer[] = [
  {
    type: 'wavesculpt',
    why:
      'its producer is a WebGL2 renderer with a persistent GL context, per-node framebuffers, a ' +
      'presentation canvas and the `installWavesculptFrameDrawer` closure over all of it — none ' +
      'of which is expressible as a per-frame callback, and all of which lives in a file whose ' +
      'BYTES are pinned by the WebGL attest basis. With no drawer installed the module\'s own ' +
      'drawFrame fills solid black, so a card that owned this owned whether video_out carried a ' +
      'picture at all (#1587).',
  },
];

/**
 * The module TYPES whose per-frame producer is a NODE-MOUNTED SURFACE.
 *
 * DERIVED from the roster above — never a second literal. `dom-source-modules`
 * asserts this is DISJOINT from `CARD_PRODUCER_LANE_TYPES` and that every
 * departure from that set is owned by SOME node registry, so this half of an
 * extraction cannot land without the other.
 */
export const NODE_VIZ_SURFACE_TYPES: ReadonlySet<string> =
  vizSurfaceTypes(VIZ_SURFACE_PRODUCERS);

/**
 * The real-DOM registry. Both ops are element MOVES guarded on the current
 * parent, so a resolve that changes nothing touches no DOM — a re-parent of a
 * live `<canvas>` is cheap but not free, and doing it on every render would
 * make the picture flicker under devtools' layout tracing.
 */
export const nodeVizSurfaces = createNodeVizSurfaceRegistry<HTMLElement, HTMLElement>({
  mount(el, host) {
    if (el.parentElement !== host) host.appendChild(el);
  },
  park(el, park) {
    if (el.parentElement !== park) park.appendChild(el);
  },
});
