<script lang="ts">
  // DockZoneContainer — the ONE container every docked card renders
  // through (see ./dock.ts for the model; P1 implements the 'bottom'
  // zone = the workflow M/E/C drawer).
  //
  // What it does:
  //  (a) PORTALS the card OUT of the main SvelteFlow coordinate space
  //      into a fixed overlay: the docked node never appears in Canvas's
  //      flowNodes (pinned nodes are filtered there); instead this
  //      container hosts the SAME card component in a STANDALONE
  //      single-node SvelteFlow instance. That keeps the card 100%
  //      functional — Handles, knobs, engine context (provided by Canvas,
  //      an ancestor) — while its position is fixed to the zone,
  //      independent of canvas pan/zoom.
  //  (b) Applies the per-dock content scale: `--dock-scale` is stamped on
  //      the zone element AND drives the host flow's fitView maxZoom, so
  //      a docked card renders at ≤ the zone scale (default 1, no UI for
  //      it yet) regardless of the main canvas zoom. Oversized cards
  //      scale DOWN to fit the zone (the FULL card is always visible).
  //
  // The host flow is deliberately inert as a CANVAS (no pan / zoom /
  // drag / connect / select) — interactivity belongs to the card's own
  // controls. It renders zero edges; cables stay a main-canvas concept.
  //
  // Dock state is LOCAL view state (dock-store.svelte.ts) — never synced.

  import { SvelteFlow } from '@xyflow/svelte';
  import type { ModuleNode } from '$lib/graph/types';
  import type { DockZone } from './dock';

  interface Props {
    zone: DockZone;
    /** The docked node (a live snapshot entry — `data` is the live proxy). */
    node: ModuleNode;
    /** The same glob-driven nodeTypes map the main canvas uses. */
    nodeTypes: Record<string, unknown>;
    /** Rack sizing for the card (Canvas's rackSizeByType entry), if any. */
    rackSize?: { size?: string; hp?: number };
    /** Zone content scale (dockStore.scaleFor(zone); default 1). */
    scale?: number;
    /** Drawer header label. */
    title: string;
    /** Close affordance (✕ button; ESC is handled by the Canvas keymap). */
    onClose: () => void;
  }
  let { zone, node, nodeTypes, rackSize, scale = 1, title, onClose }: Props = $props();

  // Build the single host FlowNode. Mirrors Canvas's flowNodes tagging so
  // the shared _module-card.css sizes the card identically (rack-sized +
  // --rack-u/--rack-hp), minus canvas-only affordances (drag/z-order).
  let hostNodes = $derived.by(() => {
    const u = rackSize?.size ? parseInt(rackSize.size, 10) || 1 : undefined;
    return [
      {
        id: node.id,
        type: node.type,
        position: { x: 0, y: 0 },
        draggable: false,
        data: { node },
        ...(u
          ? {
              class: 'rack-sized',
              style: `--rack-hp:${rackSize?.hp ?? 1};--rack-u:${u}`,
            }
          : {}),
      },
    ];
  });
</script>

<section
  class={`dock-zone dock-zone-${zone}`}
  style={`--dock-scale:${scale}`}
  data-testid={`dock-zone-${zone}`}
  data-dock-node={node.id}
  data-dock-type={node.type}
  aria-label={`${title} dock`}
>
  <header class="dock-header">
    <span class="dock-title">{title}</span>
    <span class="dock-hint">pinned — esc closes</span>
    <button
      class="dock-close"
      data-testid="dock-close"
      onclick={onClose}
      title="Close drawer (Esc)"
      aria-label="Close drawer"
    >✕</button>
  </header>
  <div class="dock-body">
    <!-- {#key} forces a clean host remount when the docked card swaps
         (M → E replaces the occupant) so fitView re-fits the new card. -->
    {#key node.id}
      <SvelteFlow
        nodes={hostNodes}
        edges={[]}
        nodeTypes={nodeTypes as never}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.06, maxZoom: scale }}
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
</section>

<style>
  .dock-zone {
    position: absolute;
    z-index: 30;
    display: flex;
    flex-direction: column;
    background: #14171c;
    border-top: 1px solid #2a2f3a;
    box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.45);
  }
  /* P1: the bottom zone. top/left/right land with their phases. */
  .dock-zone-bottom {
    left: 0;
    right: 0;
    bottom: 0;
    height: min(48vh, 560px);
  }
  .dock-header {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 12px;
    border-bottom: 1px solid #2a2f3a;
    font-size: 0.75rem;
  }
  .dock-title {
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text);
  }
  .dock-hint {
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    font-size: 0.65rem;
    flex: 1;
  }
  .dock-close {
    background: transparent;
    color: var(--text-dim);
    border: 1px solid #404652;
    border-radius: 3px;
    padding: 2px 8px;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.7rem;
  }
  .dock-close:hover {
    background: #2a2f3a;
    color: var(--text);
  }
  .dock-body {
    flex: 1 1 auto;
    min-height: 0;
    /* The standalone host flow fills the body; the card is fit-scaled to
       ≤ var(--dock-scale) by the flow viewport (see fitViewOptions). */
  }
  .dock-body :global(.svelte-flow) {
    width: 100%;
    height: 100%;
    background: #0e1116;
  }
  /* The host is a display surface, not a canvas: hide the attribution +
     never show the grab cursor. */
  .dock-body :global(.svelte-flow__pane) {
    cursor: default;
  }
</style>
