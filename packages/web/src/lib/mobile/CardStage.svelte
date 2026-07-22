<script lang="ts" module>
  // Lazy nodeTypes memo (module-level so 2 stages share one map). Built on
  // first component init — by then the registry barrels (imported below for
  // belt-and-suspenders, and by mobile-host) have populated the registries.
  import type { Component } from 'svelte';
  let cachedNodeTypes: Record<string, Component> | null = null;
  let cachedRackByType: Record<string, { size?: string; hp?: number }> | null = null;
</script>

<script lang="ts">
  // CardStage — a SINGLE-NODE real <SvelteFlow> host for the mobile views.
  //
  // DECISION (spec §2): cards CANNOT mount bare — PatchPanel (inside nearly
  // every card) calls xyflow's useStore() and renders <Handle>s, both of
  // which throw outside a flow. A one-node flow reuses all ~185 cards
  // UNMODIFIED: zero edits under lib/ui/modules/** (WebGL attest basis),
  // zero desktop risk.
  //
  //   - 1:1 rendering ALWAYS (no fitView scale-down — scaling shrinks the
  //     sequencer's 22px targets + its 16px inputs under the iOS zoom floor).
  //     Cards wider than the phone h-scroll inside the stage (edge-fade hint).
  //   - Interactions off: no drag, no pan, no zoom; preventScrolling=false so
  //     page scroll works over non-control card chrome.
  //   - Host-scoped CSS hides the PatchPanel corner patch-trigger (its
  //     patchpanel:* CustomEvents have no listener outside Canvas — patching
  //     is matrix-only on mobile).
  import { SvelteFlow, type Node as FlowNode } from '@xyflow/svelte';
  import { buildNodeTypes } from '$lib/ui/modules-card-map';
  import { listModuleDefs } from '$lib/audio/module-registry';
  import { listVideoModuleDefs } from '$lib/video/module-registry';
  import { listMetaModuleDefs } from '$lib/meta/module-registry';
  import { RACK_SIZE_DEFAULTS } from '$lib/ui/rack-sizes';
  import type { ModuleNode } from '$lib/graph/types';
  import '$lib/audio/modules';
  import '$lib/video/modules';
  import '$lib/meta/modules';

  let { node }: { node: ModuleNode } = $props();

  if (!cachedNodeTypes) {
    cachedNodeTypes = buildNodeTypes([
      ...listModuleDefs(),
      ...listVideoModuleDefs(),
      ...listMetaModuleDefs(),
    ]);
  }
  if (!cachedRackByType) {
    cachedRackByType = {};
    for (const d of [...listModuleDefs(), ...listVideoModuleDefs(), ...listMetaModuleDefs()]) {
      const r = d as { type: string; size?: string; hp?: number };
      const fallback = RACK_SIZE_DEFAULTS[r.type];
      const size = r.size ?? fallback?.size;
      if (size) cachedRackByType[r.type] = { size, hp: r.hp ?? fallback?.hp };
    }
  }
  const nodeTypes = cachedNodeTypes;
  const rackByType = cachedRackByType;

  const PAD = 8; // breathing room around the card inside the stage
  const RACK_UNIT = 180;

  /** Resolved stage box for the current node: the rack tier when declared,
   *  else the card's own persisted dims (bentbox), else a safe default. */
  let box = $derived.by(() => {
    const rack = rackByType[node.type];
    if (rack?.size) {
      const u = parseInt(rack.size, 10) || 1;
      const hp = rack.hp ?? 1;
      return { w: hp * RACK_UNIT, h: u * RACK_UNIT, rack: { u, hp } };
    }
    const d = node.data as { width?: number; height?: number } | undefined;
    return { w: d?.width ?? 540, h: d?.height ?? 540, rack: null };
  });

  let flowNodes = $derived.by(() => {
    const fn: FlowNode = {
      id: node.id,
      type: node.type,
      position: { x: PAD, y: PAD },
      data: { node },
      draggable: false,
      selectable: false,
      deletable: false,
    };
    if (box.rack) {
      fn.class = 'rack-sized';
      fn.style = `--rack-hp:${box.rack.hp};--rack-u:${box.rack.u}`;
    }
    return [fn];
  });
</script>

<div class="cardstage" data-testid="cardstage" data-node-type={node.type}>
  <div class="stage-inner" style="width:{box.w + PAD * 2}px;height:{box.h + PAD * 2}px">
    <SvelteFlow
      nodes={flowNodes}
      edges={[]}
      {nodeTypes}
      colorMode="dark"
      nodesDraggable={false}
      panOnDrag={false}
      panOnScroll={false}
      zoomOnScroll={false}
      zoomOnPinch={false}
      zoomOnDoubleClick={false}
      preventScrolling={false}
      minZoom={1}
      maxZoom={1}
    />
  </div>
</div>

<style>
  .cardstage {
    /* Oversize cards h-scroll at 1:1; vertical page scroll stays with the
       page. touch-action pan lets the browser own the scroll gesture on
       non-control chrome (card controls carry their own touch-action:none). */
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    /* Edge-fade scroll hint on the right edge. */
    mask-image: linear-gradient(to right, #000 0, #000 calc(100% - 18px), rgba(0, 0, 0, 0.25) 100%);
    -webkit-mask-image: linear-gradient(
      to right,
      #000 0,
      #000 calc(100% - 18px),
      rgba(0, 0, 0, 0.25) 100%
    );
  }
  .stage-inner {
    position: relative;
  }
  /* The flow fills the (card-sized) inner box; the flow itself never pans. */
  .stage-inner :global(.svelte-flow) {
    width: 100%;
    height: 100%;
    background: transparent;
  }
  /* Patching is matrix-only on mobile — hide PatchPanel's corner patch
     triggers (their CustomEvents have no listener outside Canvas). */
  .cardstage :global(.patch-trigger) {
    display: none !important;
  }
  /* xyflow paints selection/hover chrome we don't want on a static stage. */
  .cardstage :global(.svelte-flow__attribution) {
    opacity: 0.4;
  }
</style>
