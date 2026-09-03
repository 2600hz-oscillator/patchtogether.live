<script lang="ts">
  // packages/web/src/lib/ui/media/NodeVizSurfaceHost.svelte
  //
  // ONE node, ONE viz surface, for as long as the NODE exists — the mount half
  // of `./node-viz-surface-registry` (read that file's header first; it carries
  // the whole argument for why these producers are components rather than
  // `FrameProducer` callbacks, and why views ADOPT their canvases).
  //
  // ⚠ WHY THIS IS NOT `<HeadlessSourceHost>` WITH A DIFFERENT LIST. That host
  // parked a whole CARD inside a single-node `<SvelteFlow>`, because a card
  // reads `useStore()`, renders a PatchPanel and expects to be a flow node. A
  // viz surface reads the STORE and the ENGINE and nothing else — it takes a
  // `nodeId` and paints — so wrapping it in a flow provider would mount an
  // xyflow instance per node for no reason at all. It is also the point of the
  // extraction: the thing the node needs alive is the RENDERER, not a card.
  //
  // ⚠ PARKED OFF-SCREEN WITH REAL DIMENSIONS, never `display:none` — the same
  // constraint `HeadlessSourceHost` recorded. The 2-D blit reads the canvas
  // BACKING STORE (`width`/`height` attributes, set from the surface's props),
  // so a zero-size CSS box would not stop the render; parking at `left:-9999px`
  // keeps the element in the layout tree anyway, so a claim that arrives later
  // moves an element that has always had a box.
  //
  // ⚠ THE COMPONENT MAP LIVES HERE AND THE TYPE SET DOES NOT — `GroupCard`'s
  // `HOST_SURFACES` precedent. The roster in `./node-viz-surfaces` is the truth
  // (gates in `environment: 'node'` import it); this map is the RENDERING half,
  // kept in a `.svelte` file so the component edge stays visible to the subtree
  // walk in `dom-source-modules.test.ts`. `node-viz-surface-host.test.ts`
  // asserts the two agree in both directions.
  //
  // ── PER-CLAIMANT-KIND MOUNTS (cube, legacy-removal S1.5) ────────────────────
  //
  // wavesculpt's views show one canvas at ONE shape, so its mount is static and
  // the claims only decide WHERE the canvas shows. cube's two views mounted the
  // SAME renderer at DIFFERENT shapes — the legacy card at the surface's own
  // 320×260 defaults with no orbit, the faceplate hero at 300×210 with
  // drag-to-orbit — and both looks are owner-sensitive, while the surface's
  // bytes are attest-pinned so it cannot grow a resize path. So a type listed
  // in `KIND_MOUNTED_TYPES` is RE-MOUNTED (`{#key}`) when the WINNING claimant
  // kind changes, with the props `surfaceProps` gives that kind. The churn
  // lands exactly where the old design churned anyway: a dock full view opening
  // or closing used to mount/destroy a second whole surface, drawer steal and
  // all. The parked shape is `card`, which keeps the bridge picture's aspect
  // exactly what the old headless-hosted card gave `video_out`.
  //
  // ⚠ THE PUBLISHED ELEMENT IS A HOST-OWNED `display:contents` WRAPPER, NOT
  // THE SURFACE'S OWN ROOT — and the first cut got this wrong in a way worth
  // recording. Publishing the surface's root and re-keying it left the OLD
  // mount's DOM alive: a `{#key}` block's anchors live in ITS container, so
  // once the root had been adopted into a view (or parked back mid-flip) the
  // teardown removed nothing and TWO canvases carried one testid — measured on
  // the first build of this feature, dock open, `cube-3d-viz` count 2. With
  // the wrapper published instead, every Svelte anchor, teardown and creation
  // happens INSIDE the element the registry moves, wherever it currently
  // lives — so a re-key destroys and rebuilds the surface in place, in the
  // adopting view, with no park round-trip and no orphaned DOM. And
  // `display:contents` makes the wrapper layout-transparent, so adopting it is
  // visually identical to adopting the surface root directly.

  // RELATIVE, NOT $lib-ALIASED, AND THAT IS LOAD-BEARING. webgl-attest-
  // coverage.test.ts walks a module's RENDER TREE for a getContext('webgl')
  // to decide whether its rendersWebGL flag is stale, and it follows RELATIVE
  // .svelte imports only - deliberately, so a $lib control primitive does not
  // drag the whole component library into every scan. An aliased import here
  // would break that walk at exactly the hop that matters.
  import WavesculptVizSurface from '../modules/wavesculpt/WavesculptVizSurface.svelte';
  import CubeVizSurface from '../modules/cube/CubeVizSurface.svelte';
  import { CUBE_VIEW_SIZES, orbitCubeView } from '../modules/cube/cube-view-mounts';
  import { nodeVizSurfaces, NODE_VIZ_SURFACE_TYPES } from './node-viz-surfaces';
  import { VIZ_CLAIM_PRIORITY } from './node-viz-surface-registry';

  interface Props {
    /** The graph node whose surface this host owns. */
    nodeId: string;
    /** Its module type — the roster key. */
    type: string;
  }
  let { nodeId, type }: Props = $props();

  type HostSurface = typeof WavesculptVizSurface | typeof CubeVizSurface;
  const HOST_SURFACES: Record<string, HostSurface> = {
    wavesculpt: WavesculptVizSurface,
    cube: CubeVizSurface,
  };

  function componentForType(t: string) {
    if (!NODE_VIZ_SURFACE_TYPES.has(t)) return null;
    return HOST_SURFACES[t] ?? null;
  }

  /** Types whose mount SHAPE depends on the winning claimant kind. Everything
   *  else mounts once and never re-keys — wavesculpt's no-remount handoff
   *  guarantee is load-bearing (`node-viz-surface-registry.test.ts`). */
  const KIND_MOUNTED_TYPES = new Set(['cube']);

  type MountKind = 'card' | 'dock';
  let mountKind = $state<MountKind>('card');
  const kindOf = (p: number | null): MountKind =>
    p === VIZ_CLAIM_PRIORITY.dock ? 'dock' : 'card';

  /** The props each type mounts with. `ownsVideoOut` is NEVER passed: the node
   *  host is the only mount, so it must own the frame drawer and the DRS step
   *  seam (the surfaces default it true). Typed with the one prop every
   *  surface shares, so the spread satisfies the component's contract. */
  function surfaceProps(
    t: string,
    kind: MountKind,
    id: string,
  ): { nodeId: string } & Record<string, unknown> {
    if (t === 'cube') {
      const sizes = CUBE_VIEW_SIZES[kind];
      // Drag-to-orbit exists on the DOCK mount alone — the legacy card's canvas
      // historically had no orbit gesture, and giving it one as a side effect
      // of the extraction would be a behaviour change nobody reviewed.
      return kind === 'dock'
        ? { nodeId: id, ...sizes, onOrbit: (dx: number, dy: number) => orbitCubeView(id, dx, dy) }
        : { nodeId: id, ...sizes };
    }
    // wavesculpt: the per-frame listener list is the cadence guarantee the
    // card's camera poll rides (see the registry's `onFrame`).
    return { nodeId: id, onFrame: () => nodeVizSurfaces.emitFrame(id) };
  }

  let park = $state<HTMLDivElement | null>(null);
  let mountEl = $state<HTMLDivElement | null>(null);

  // The winner subscription — only for kind-mounted types. Nothing to park or
  // republish: the wrapper the views hold is stable, and the key flip rebuilds
  // the surface INSIDE it, wherever a claim has moved it.
  //
  // ⚠ THE WRITE IS DEFERRED, AND THAT IS LOAD-BEARING. `onWinner` fires
  // synchronously inside claim()/release(), i.e. inside the CLAIMING VIEW's
  // own `$effect` (or its teardown — a dock pane closing). A `$state` write
  // there is a cross-component mutation mid-flush: Svelte reported it
  // (`updated at …`) and the throw ABORTED the dock's teardown, so the pane
  // never closed — measured on the first build. A microtask lands after the
  // flush; consecutive winner moves queue in order and each re-checks, so the
  // last one wins.
  $effect(() => {
    if (!KIND_MOUNTED_TYPES.has(type)) return;
    return nodeVizSurfaces.onWinner(nodeId, (p) => {
      const kind = kindOf(p);
      if (kind === mountKind) return;
      queueMicrotask(() => {
        if (kind !== mountKind) mountKind = kind;
      });
    });
  });

  // PUBLISH the wrapper, and hand back the container to return it to. The
  // wrapper is HOST-OWNED (see the header), so no binding reaches into the
  // attest-pinned surfaces and a keyed remount never re-publishes anything.
  $effect(() => {
    const p = park;
    const el = mountEl;
    if (!p || !el) return;
    nodeVizSurfaces.publish(nodeId, el, p);
    // ⚠ RETRACT PARKS FIRST. This cleanup runs while the host is being
    // destroyed, and a framework removes a component's DOM from where it PUT
    // it — so a wrapper still adopted into a view has to come home before the
    // teardown, exactly as `GroupCard`'s portal hands its canvases back.
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
    data-mount-kind={KIND_MOUNTED_TYPES.has(type) ? mountKind : 'static'}
    aria-hidden="true"
    bind:this={park}
  >
    <!-- The ONE mount. It owns the cross-domain frame drawer and the DRS step
         seam (`ownsVideoOut` defaults true and nothing here overrides it),
         which is the property the module specs drive: the seam halts the rAF
         of the surface that is PHOTOGRAPHED, and after adoption the
         photographed element IS this surface's. -->
    <div class="viz-mount" bind:this={mountEl}>
      {#key KIND_MOUNTED_TYPES.has(type) ? mountKind : 'static'}
        <Surface {...surfaceProps(type, mountKind, nodeId)} />
      {/key}
    </div>
  </div>
{/if}

<style>
  /* Parked OFF-SCREEN with REAL dimensions — never display:none /
     visibility:hidden (see the header). pointer-events:none so it can never
     steal a click from the surface that adopted its canvas. */
  /* Layout-transparent: the views adopt THIS element, and its children lay out
     exactly as if it were not there (see the header for why it exists). */
  .viz-mount {
    display: contents;
  }
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
