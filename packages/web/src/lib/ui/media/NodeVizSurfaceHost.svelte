<script lang="ts">
  // packages/web/src/lib/ui/media/NodeVizSurfaceHost.svelte
  //
  // ONE node, ONE viz surface, for as long as the NODE exists — the mount half
  // of `./node-viz-surface-registry` (read that file's header first; it carries
  // the whole argument for why wavesculpt's producer is a component rather than
  // a `FrameProducer` callback, and why views ADOPT its canvas).
  //
  // ⚠ WHY THIS IS NOT `<HeadlessSourceHost>` WITH A DIFFERENT LIST. That host
  // parks a whole CARD inside a single-node `<SvelteFlow>`, because a card reads
  // `useStore()`, renders a PatchPanel and expects to be a flow node. A viz
  // surface reads the STORE and the ENGINE and nothing else — it takes a
  // `nodeId` and paints — so wrapping it in a flow provider would mount an
  // xyflow instance per wavesculpt for no reason at all. It is also the point of
  // the extraction: the thing the node needs alive is the RENDERER, not a card.
  //
  // ⚠ PARKED OFF-SCREEN WITH REAL DIMENSIONS, never `display:none` — the same
  // constraint `HeadlessSourceHost` records. The 2-D blit reads the canvas
  // BACKING STORE (`displayCanvas.width/height`, set from the surface's props),
  // so a zero-size CSS box would not stop the render; parking at `left:-9999px`
  // keeps the element in the layout tree anyway, so a claim that arrives later
  // moves a canvas that has always had a box.
  //
  // ⚠ THE COMPONENT MAP LIVES HERE AND THE TYPE SET DOES NOT — `GroupCard`'s
  // `HOST_SURFACES` precedent. The roster in `./node-viz-surfaces` is the truth
  // (gates in `environment: 'node'` import it); this map is the RENDERING half,
  // kept in a `.svelte` file so the component edge stays visible to the subtree
  // walk in `dom-source-modules.test.ts`. `node-viz-surface-host.test.ts`
  // asserts the two agree in both directions.

  // RELATIVE, NOT $lib-ALIASED, AND THAT IS LOAD-BEARING. webgl-attest-
  // coverage.test.ts walks a module's RENDER TREE for a getContext('webgl')
  // to decide whether its rendersWebGL flag is stale, and it follows RELATIVE
  // .svelte imports only - deliberately, so a $lib control primitive does not
  // drag the whole component library into every scan. An aliased import here
  // would break that walk at exactly the hop that matters.
  import WavesculptVizSurface from '../modules/wavesculpt/WavesculptVizSurface.svelte';
  import { nodeVizSurfaces, NODE_VIZ_SURFACE_TYPES } from './node-viz-surfaces';

  interface Props {
    /** The graph node whose surface this host owns. */
    nodeId: string;
    /** Its module type — the roster key. */
    type: string;
  }
  let { nodeId, type }: Props = $props();

  const HOST_SURFACES: Record<string, typeof WavesculptVizSurface> = {
    wavesculpt: WavesculptVizSurface,
  };

  function componentForType(t: string) {
    if (!NODE_VIZ_SURFACE_TYPES.has(t)) return null;
    return HOST_SURFACES[t] ?? null;
  }

  let park = $state<HTMLDivElement | null>(null);

  // PUBLISH the surface's own canvas, and hand back the container to return it
  // to. `querySelector` rather than a `bind:this` reaching into the surface,
  // because the surface is in the WebGL ATTEST BASIS: its bytes must not move,
  // so it can neither expose a binding nor take a new prop. It renders exactly
  // one element and no wrapper, so this park div holds exactly one canvas.
  $effect(() => {
    const p = park;
    if (!p) return;
    const canvas = p.querySelector('canvas');
    if (!canvas) return;
    nodeVizSurfaces.publish(nodeId, canvas, p);
    // ⚠ RETRACT PARKS FIRST. This cleanup runs while the surface component is
    // being destroyed, and a framework removes a component's DOM from where it
    // PUT it — so a canvas still adopted into a card has to come home before
    // that teardown, exactly as `GroupCard`'s portal hands its canvases back.
    return () => nodeVizSurfaces.retract(nodeId);
  });
</script>

{#if componentForType(type)}
  {@const Surface = componentForType(type)!}
  <div
    class="node-viz-surface-park"
    data-testid="node-viz-surface"
    data-node-id={nodeId}
    data-node-type={type}
    aria-hidden="true"
    bind:this={park}
  >
    <!-- The ONE mount. It owns the cross-domain frame drawer and the DRS step
         seam (`ownsVideoOut` defaults true and nothing here overrides it),
         which is the property `wavesculpt.spec.ts` drives: the seam halts the
         rAF of the surface that is PHOTOGRAPHED, and after adoption the
         photographed canvas IS this surface's canvas. -->
    <Surface {nodeId} onFrame={() => nodeVizSurfaces.emitFrame(nodeId)} />
  </div>
{/if}

<style>
  /* Parked OFF-SCREEN with REAL dimensions — never display:none /
     visibility:hidden (see the header). pointer-events:none so it can never
     steal a click from the surface that adopted its canvas. */
  .node-viz-surface-park {
    position: fixed;
    left: -9999px;
    top: 0;
    width: 320px;
    height: 240px;
    overflow: hidden;
    pointer-events: none;
    z-index: -1;
  }
</style>
