<script lang="ts">
  // HeadlessSourceHost — keeps a DOM-SOURCE video module's REAL card mounted
  // when the `?shell=1` lane swapped it for a <ModuleShell>/<ModuleShellPlaceholder>.
  //
  // WHY (the owner P0 "no video at all under ?shell=1"): a minority of video
  // modules get their pixels from a DOM media element their own card creates and
  // hands to the engine (`VideoEngine.attachExternalSource`) — see
  // ./dom-source-modules for the full rationale. Node REGISTRATION is graph-
  // driven and already UI-independent; SOURCE ATTACHMENT was not. With the card
  // swapped away, those nodes emit a blank texture and every consumer downstream
  // is black. This host restores the invariant: for the same rack, the engine's
  // node AND source set is identical in shell mode and preview-off.
  //
  // WHY OFF-SCREEN AND NOT `display:none` — verbatim the constraint the workflow
  // camera manager already documents (./CameraSurface): "an off-screen video
  // element is the same scenario as a canvas card scrolled out of view — decode
  // + rVFC keep running, where a non-rendered one could freeze the engine's
  // texture." So each host parks at `left:-9999px` with real dimensions.
  //
  // WHY A SINGLE-NODE <SvelteFlow> PER CARD — the same proven pattern
  // CameraSurface/AudioIoSurface use: the card mounts inside a real flow
  // provider (its own, zoom 1), so `useStore()`-reading cards, PatchPanel and
  // the handle stack all behave exactly as they do on the canvas. All
  // interaction is off (no drag / no zoom / no selection): this host exists to
  // run a LIFECYCLE, never to be used.
  //
  // PERF: it mounts ONLY the DOM-source modules the shell actually swapped
  // (typically 0-2 in a rack), never the whole graph, and it does NOT create a
  // render root — pull-eval visibility gating is untouched, so an unobserved
  // chain still costs zero draws. It only makes the chain ABLE to run.

  import { SvelteFlow } from '@xyflow/svelte';
  import type { ModuleNode } from '$lib/graph/types';

  interface Props {
    /** The nodes whose real card must stay alive (Canvas-derived via
     *  `needsHeadlessSourceMount`). Empty ⇒ this renders nothing at all. */
    nodes: readonly ModuleNode[];
    /** The same glob-driven nodeTypes map the main canvas + CameraSurface use. */
    nodeTypes: Record<string, unknown>;
  }
  let { nodes, nodeTypes }: Props = $props();

  /** One-node flow payload for a hosted card (mirrors CameraSurface.hostNodesFor). */
  function hostNodesFor(node: ModuleNode) {
    return [
      {
        id: node.id,
        type: node.type,
        position: { x: 0, y: 0 },
        data: { node },
        draggable: false,
        selectable: false,
        connectable: false,
      },
    ];
  }
</script>

{#each nodes as node (node.id)}
  <div
    class="headless-source-host"
    data-testid="headless-source-host"
    data-node-id={node.id}
    data-node-type={node.type}
    aria-hidden="true"
  >
    {#key node.id}
      <SvelteFlow
        nodes={hostNodesFor(node)}
        edges={[]}
        nodeTypes={nodeTypes as never}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.04, maxZoom: 1 }}
        minZoom={0.05}
        maxZoom={4}
        panOnDrag={false}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        preventScrolling={false}
      />
    {/key}
  </div>
{/each}

<style>
  /* Parked OFF-SCREEN with REAL dimensions — never display:none/visibility:hidden
     (see the header: a non-rendered <video> can stall the engine's texture
     upload). pointer-events:none so it can never steal a click. */
  .headless-source-host {
    position: fixed;
    left: -9999px;
    top: 0;
    width: 300px;
    height: 420px;
    overflow: hidden;
    pointer-events: none;
    z-index: -1;
  }
</style>
