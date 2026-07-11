<script lang="ts">
  // DockRail — one dock ZONE's chrome (P2.5a): 'top' rail (horizontal,
  // reserved-space flex sibling ABOVE the canvas), 'left' rail (vertical,
  // flex sibling BESIDE the canvas — this IS the owner's workflow left
  // toolbar, per answer Q5), and the 'bottom' drawer (overlay, generalized
  // from P1 to hold docked cards ALONGSIDE the pinned M/E/C occupant).
  //
  // Rails are flex siblings of .flow, NOT overlays inside .svelte-flow —
  // the transformed-ancestor trap (recommendation §2.3): nothing here is
  // ever positioned against the xyflow viewport transform, and wheel/drag
  // inside a rail never reaches d3-zoom.
  //
  // EMPTY rails render ZERO pixels (top/bottom) so dawless and empty
  // workflow racks stay pixel-identical; the LEFT rail keeps the landed
  // P1 44px scaffold strip as its empty state (the workflow shell's
  // geometry — its contents are now the docked cards).
  //
  // SNAP-TO-COLLAPSE GRABBER (VS Code pattern): drag the rail's inner edge
  // to resize; releasing under the snap threshold collapses the rail to a
  // slim strip (persisted per rackspace). Clicking the strip re-expands.

  import type { ModuleNode } from '$lib/graph/types';
  import type { DockZone } from './dock';
  import { dockStore } from './dock-store.svelte';
  import DockCardHost from './DockCardHost.svelte';

  /** One card slot: a docked entry, or the bottom drawer's pinned occupant. */
  interface DockRailCard {
    node: ModuleNode;
    title: string;
    pinned: boolean;
  }

  interface Props {
    zone: DockZone;
    cards: DockRailCard[];
    nodeTypes: Record<string, unknown>;
    rackSizeByType: Record<string, { size?: string; hp?: number }>;
    onUndock: (nodeId: string) => void;
    /** Close the pinned drawer occupant (bottom zone's ✕ / Esc). */
    onClosePinned?: () => void;
    /** Canvas's rear-view ("flip rack") toggle. The flip's CSS is gated on a
     *  `.rear-view` ANCESTOR; the bottom drawer inherits it from `.flow`, but
     *  the top/left rails are flex siblings OUTSIDE `.flow` — stamping the
     *  class here makes docked cards flip with the rack in every zone. */
    rearView?: boolean;
  }
  let { zone, cards, nodeTypes, rackSizeByType, onUndock, onClosePinned, rearView = false }: Props = $props();

  let collapsed = $derived(dockStore.railCollapsed(zone));
  let railSize = $derived(dockStore.railSize(zone));
  let horizontal = $derived(zone === 'top' || zone === 'bottom');

  /** Snap threshold: releasing a resize below this collapses the rail. */
  const SNAP_COLLAPSE_PX = 80;

  let railEl: HTMLElement | null = $state(null);
  let dragSize = $state<number | null>(null);

  function grabberPointerDown(e: PointerEvent): void {
    if (!railEl) return;
    e.preventDefault();
    const start = horizontal ? e.clientY : e.clientX;
    const box = railEl.getBoundingClientRect();
    const startSize = horizontal ? box.height : box.width;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const onMove = (me: PointerEvent) => {
      const cur = horizontal ? me.clientY : me.clientX;
      // Dragging the inner edge: top rail grows downward, left rail grows
      // rightward, bottom drawer grows upward.
      const delta = zone === 'bottom' ? start - cur : cur - start;
      dragSize = Math.max(0, startSize + delta);
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      const finalSize = dragSize;
      dragSize = null;
      if (finalSize == null) return;
      if (finalSize < SNAP_COLLAPSE_PX) {
        dockStore.setRailCollapsed(zone, true); // snap-to-collapse
      } else {
        dockStore.setRailCollapsed(zone, false);
        dockStore.setRailSize(zone, finalSize);
      }
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
  }

  function expand(): void {
    dockStore.setRailCollapsed(zone, false);
  }

  // Stub click → focus this rail's card: expand if collapsed, scroll the
  // card into view, flash it. Document-level so the stub (inside the flow)
  // needs no wiring to the rail.
  $effect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail as { nodeId: string; zone: DockZone } | null;
      if (!detail || detail.zone !== zone) return;
      dockStore.setRailCollapsed(zone, false);
      requestAnimationFrame(() => {
        const el = railEl?.querySelector<HTMLElement>(`[data-dock-card="${CSS.escape(detail.nodeId)}"]`);
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        el.classList.add('dock-flash');
        setTimeout(() => el.classList.remove('dock-flash'), 1200);
      });
    };
    document.addEventListener('dockstub:open', onOpen);
    return () => document.removeEventListener('dockstub:open', onOpen);
  });

  /** Inline size override while resizing / when a persisted size exists. */
  let sizeStyle = $derived.by(() => {
    const s = dragSize ?? railSize;
    if (s == null || collapsed) return undefined;
    return horizontal ? `height:${Math.round(s)}px` : `width:${Math.round(s)}px`;
  });

  let pinnedCard = $derived(cards.find((c) => c.pinned) ?? null);
</script>

{#if cards.length > 0 || zone === 'left'}
  {#if collapsed && cards.length > 0}
    <!-- Collapsed strip: zero-cost reopen affordance. -->
    <button
      class={`dock-rail-collapsed dock-rail-collapsed-${zone}`}
      data-testid={`dock-rail-${zone}-collapsed`}
      onclick={expand}
      title={`Show ${zone === 'bottom' ? 'drawer' : `${zone} rail`} (${cards.length} docked)`}
    >
      ⇱ {cards.length}
    </button>
  {:else if cards.length > 0}
    <section
      bind:this={railEl}
      class={`dock-rail dock-rail-${zone}`}
      class:dock-rail-horizontal={horizontal}
      class:rear-view={rearView}
      style={sizeStyle}
      data-testid={zone === 'bottom' ? 'dock-zone-bottom' : `dock-rail-${zone}`}
      data-dock-count={cards.length}
      data-dock-node={pinnedCard?.node.id}
      data-dock-type={pinnedCard?.node.type}
      aria-label={`${zone} dock`}
    >
      {#if zone === 'left'}
        <!-- The left rail is ALSO the workflow left toolbar (owner Q5):
             keep the P1 scaffold's testid on an inner marker so the shell
             e2e contract holds with cards docked. -->
        <span class="dock-leftbar-marker" data-testid="workflow-leftbar" aria-hidden="true"></span>
      {/if}
      <div class="dock-rail-cards">
        {#each cards as card (card.node.id)}
          <DockCardHost
            node={card.node}
            {nodeTypes}
            rackSize={rackSizeByType[card.node.type]}
            scale={dockStore.scaleOf(card.node.id)}
            title={card.title}
            onStepScale={(dir) => dockStore.stepScaleOf(card.node.id, dir)}
            onResetScale={() => dockStore.setScaleOf(card.node.id, 1)}
            onUndock={card.pinned ? undefined : () => onUndock(card.node.id)}
            onClose={card.pinned ? onClosePinned : undefined}
          />
        {/each}
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class={`dock-grabber dock-grabber-${zone}`}
        data-testid={`dock-grabber-${zone}`}
        onpointerdown={grabberPointerDown}
        title="Drag to resize — snap closed"
      ></div>
    </section>
  {:else}
    <!-- LEFT rail, empty: the P1 workflow-leftbar scaffold strip (pixel-
         compatible with the landed shell; contents pend on docked cards). -->
    <nav class="workflow-leftbar" data-testid="workflow-leftbar" aria-label="Workflow dock rail (empty)">
      <span class="rail-hint" title="Left dock rail — right-click a module → Dock to left rail">···</span>
    </nav>
  {/if}
{/if}

<style>
  .dock-rail {
    position: relative;
    display: flex;
    background: #12151b;
    z-index: 16;
  }
  /* TOP rail: reserved-space flex sibling ABOVE the canvas row. */
  .dock-rail-top {
    flex: 0 0 auto;
    flex-direction: row;
    border-bottom: 1px solid #232833;
    max-height: 48vh;
  }
  /* LEFT rail: reserved-space flex sibling BESIDE the canvas. */
  .dock-rail-left {
    flex: 0 0 auto;
    flex-direction: column;
    border-right: 1px solid #232833;
    max-width: 44vw;
  }
  /* BOTTOM drawer: overlay pinned to the canvas bottom (P1 geometry). */
  .dock-rail-bottom {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 30;
    flex-direction: row;
    border-top: 1px solid #2a2f3a;
    box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.45);
    background: #14171c;
    max-height: min(48vh, 620px);
  }
  .dock-rail-cards {
    display: flex;
    flex: 1 1 auto;
    gap: 8px;
    padding: 8px;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    align-items: flex-start;
  }
  .dock-rail-left .dock-rail-cards {
    flex-direction: column;
  }
  /* Grabbers: slim hit-areas on the rail's inner edge. */
  .dock-grabber {
    position: absolute;
    background: transparent;
    z-index: 2;
  }
  .dock-grabber:hover {
    background: rgba(0, 240, 255, 0.18);
  }
  .dock-grabber-top {
    left: 0;
    right: 0;
    bottom: -3px;
    height: 7px;
    cursor: ns-resize;
  }
  .dock-grabber-bottom {
    left: 0;
    right: 0;
    top: -3px;
    height: 7px;
    cursor: ns-resize;
  }
  .dock-grabber-left {
    top: 0;
    bottom: 0;
    right: -3px;
    width: 7px;
    cursor: ew-resize;
  }
  /* Collapsed strips. */
  .dock-rail-collapsed {
    background: #12151b;
    color: var(--text-dim);
    border: none;
    font-family: ui-monospace, monospace;
    font-size: 0.65rem;
    cursor: pointer;
    z-index: 16;
  }
  .dock-rail-collapsed:hover {
    color: var(--accent, #00f0ff);
  }
  .dock-rail-collapsed-top {
    flex: 0 0 auto;
    height: 18px;
    border-bottom: 1px solid #232833;
  }
  .dock-rail-collapsed-left {
    flex: 0 0 auto;
    width: 22px;
    border-right: 1px solid #232833;
    writing-mode: vertical-rl;
  }
  .dock-rail-collapsed-bottom {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 18px;
    z-index: 30;
    border-top: 1px solid #2a2f3a;
  }
  .dock-leftbar-marker {
    position: absolute;
    inset: 0 auto 0 0;
    width: 1px;
  }
  /* Focus flash (stub click → rail card). */
  :global(.dock-card.dock-flash) {
    outline: 2px solid var(--accent, #00f0ff);
    outline-offset: 1px;
    transition: outline-color 200ms ease-out;
  }
  /* Empty LEFT rail: the P1 scaffold strip, verbatim geometry. */
  .workflow-leftbar {
    flex: 0 0 auto;
    width: 44px;
    z-index: 15;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: 12px;
    background: #12151b;
    border-right: 1px solid #232833;
  }
  .rail-hint {
    color: var(--text-dim);
    opacity: 0.5;
    font-size: 0.9rem;
    letter-spacing: 2px;
    writing-mode: vertical-rl;
    user-select: none;
  }
</style>
