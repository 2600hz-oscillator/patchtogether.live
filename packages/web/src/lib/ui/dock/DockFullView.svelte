<script lang="ts">
  // DockFullView — the bottom-drawer EXPANDED FULL-VIEW (P0.3b re-spec).
  //
  // The owner-approved RACKLINE dock faceplate (fullcard-mocks kit §3/§4 +
  // ux-fullview.html Section B): ONE full-width module faceplate that OWNS the
  // bottom drawer — NOT one more card in DockRail's horizontal card flex. Domain
  // accent lip + glow, grip, title bar (badge + name + "<label> · lane N" sub) +
  // a window-control trio (undock / collapse-to-lane / close), a tab-rail seam
  // (single "MODULE" tab for legacy content — real per-op tabs are P1), and a
  // .page > .editor that mounts the CONTENT at NATIVE scale:
  //   * un-migrated → the module's VERBATIM legacy *Card.svelte via
  //     nodeTypes[node.type], with the SAME plain-mount contract DockCardHost
  //     uses (self-gating PatchPanel outside the flow provider) — carrying the
  //     data-dock-card / data-dock-card-frame anchors + node.id keying so
  //     PickupCable / cardRectOf + the patch menu keep working.
  //   * migrated → <ModuleShell view="dock-full"> (effTier 'dock').
  //
  // PLAIN-MOUNT SAFETY (verbatim from DockCardHost): the card is the SAME
  // component the canvas mounts, fed the same `{ id, data: { node } }`. PatchPanel
  // self-gates outside the provider (guarded useStore): no <Handle> stack mounts
  // here, so the node's ONLY handles + only `.svelte-flow__node[data-id]` element
  // live on its canvas tile — PickupCable + sweep contracts stay unambiguous. The
  // patch MENU still works from the drawer (port rows dispatch document-level
  // events Canvas owns). Rack sizing is replicated by a classed wrapper
  // (dock-rack-sized) that mirrors .svelte-flow__node.rack-sized WITHOUT the
  // .svelte-flow__node class. NO transform/ResizeObserver zoom — native scale.
  //
  // Close / collapse-to-lane both call dockStore.closeFullView() (the module's
  // lane placeholder/shell stays in place — Option #1). ESC closes it first
  // (Canvas's dock-key handler). Transient: never a persisted dock ENTRY.

  import './_dock-faceplate.css';
  import type { Component } from 'svelte';
  import type { ModuleNode, PortDef } from '$lib/graph/types';
  import { getModuleDef } from '$lib/audio/module-registry';
  import { getVideoModuleDef } from '$lib/video/module-registry';
  import { getMetaModuleDef } from '$lib/meta/module-registry';
  import { domainClassForDef, type ShellDefLike } from '$lib/ui/workflow/module-shell-model';
  import ModuleShell from '$lib/ui/modules/ModuleShell.svelte';

  interface Props {
    /** The full-view node (live snapshot entry — `data` is the live proxy). */
    node: ModuleNode;
    /** The shared glob-driven nodeTypes map (Canvas's). */
    nodeTypes: Record<string, unknown>;
    /** Rack sizing (Canvas's rackSizeByType entry), if the type declares one. */
    rackSize?: { size?: string; hp?: number };
    /** True ⇒ mount the migrated <ModuleShell>; else the verbatim legacy card. */
    migrated: boolean;
    /** Header display name. */
    title: string;
    /** Close the full-view (✕ / ESC). */
    onClose: () => void;
    /** Collapse to lane (keeps the lane tile; same as close in P0.3b). */
    onCollapse: () => void;
    /** Undock → promote to a persisted entry. Omitted in P0.3b (the full-view
     *  was never a persisted entry); shown disabled-free when it lands. */
    onUndock?: () => void;
  }
  let { node, nodeTypes, rackSize, migrated, title, onClose, onCollapse, onUndock }: Props = $props();

  function defLookup(type: string) {
    return getModuleDef(type) ?? getVideoModuleDef(type) ?? getMetaModuleDef(type);
  }
  let def = $derived(
    defLookup(node.type) as (ShellDefLike & { label?: string; inputs?: readonly PortDef[] }) | undefined,
  );

  /** Kit domain class (.audio/.cv/.gate/.video/.poly) — paints the whole face. */
  let domain = $derived(domainClassForDef(def));

  /** Badge initials from the type id (curated def.badge reads better; P1). */
  let badge = $derived(node.type.replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || '??');

  /** Mono sub: "<def label> · lane N" (mock "FM synthesizer · lane 3"). */
  let sub = $derived.by(() => {
    const label = def?.label ?? node.type;
    const d = node.data as { channel?: number; sendSlot?: number } | undefined;
    if (d?.channel != null) return `${label} · lane ${d.channel}`;
    if (d?.sendSlot != null) return `${label} · send ${d.sendSlot}`;
    return label;
  });

  let CardComponent = $derived(nodeTypes[node.type] as Component | undefined);
  let rackU = $derived(rackSize?.size ? parseInt(rackSize.size, 10) || 1 : null);
  let rackHp = $derived(rackSize?.hp ?? 1);
</script>

<div class="dock-faceplate" data-testid="dock-full-view" data-fullview-node={node.id}>
  <div class="faceplate-scroll">
    <div class={`faceplate ${domain}`} data-fullview-domain={domain}>
      <span class="spine" aria-hidden="true"></span>

      <div class="faceplate-grip" data-testid="faceplate-grip" aria-hidden="true"></div>

      <div class="faceplate-bar">
        <div class="face-id">
          <span class="face-badge" aria-hidden="true">{badge}</span>
          <div class="face-who">
            <div class="face-name" title={title}>{title}</div>
            <div class="face-sub">{sub}</div>
          </div>
        </div>
        <div class="face-spacer"></div>
        <div class="win-ctrls" data-testid="faceplate-win-ctrls">
          {#if onUndock}
            <button type="button" data-testid="faceplate-undock" title="Undock" aria-label="Undock" onclick={onUndock}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
            </button>
          {/if}
          <button type="button" data-testid="faceplate-collapse" title="Collapse to lane" aria-label="Collapse to lane" onclick={onCollapse}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>
          </button>
          <button type="button" data-testid="faceplate-close" title="Close" aria-label="Close" onclick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>

      <!-- Tab-rail seam: legacy content is one active "MODULE" tab; real per-op
           / per-section tabs are P1. -->
      <div class="tabrail" data-testid="faceplate-tabrail">
        <div class="tab on" data-testid="faceplate-tab"><span class="t1">MODULE</span></div>
      </div>

      <div class="page">
        <div class="editor" data-testid="faceplate-editor">
          {#if migrated}
            <ModuleShell id={node.id} data={{ node, view: 'dock-full' }} />
          {:else}
            <!-- Verbatim legacy card, plain-mount (data-dock-card* anchors +
                 node.id keying carried so PickupCable/cardRectOf + patch menu
                 resolve; PatchPanel self-gates outside the provider). -->
            <section class="fp-card-mount" data-dock-card={node.id} data-dock-type={node.type} data-dock-full="true">
              <div class="fp-card-frame" data-dock-card-frame>
                <div
                  class={rackU != null ? 'dock-rack-sized' : 'dock-natural-sized'}
                  style={rackU != null ? `--rack-hp:${rackHp};--rack-u:${rackU}` : undefined}
                >
                  {#if CardComponent}
                    <CardComponent id={node.id} data={{ node }} />
                  {:else}
                    <div class="fp-missing">unknown module type: {node.type}</div>
                  {/if}
                </div>
              </div>
            </section>
          {/if}
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  /* The full-view faceplate OWNS the bottom drawer: a full-width overlay pinned
     to the canvas bottom, above the flow. Sits alongside DockRail's bottom zone
     (which now holds only pinned + docked thumbnails). */
  .dock-faceplate {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 31;
    max-height: min(60vh, 680px);
    display: flex;
    padding: 0 8px 8px;
  }
  .faceplate-scroll {
    flex: 1 1 auto;
    min-width: 0;
    max-height: min(60vh, 680px);
    overflow-y: auto;
  }
  .faceplate {
    width: 100%;
  }
  .fp-card-frame {
    position: relative;
    width: max-content;
    max-width: 100%;
  }
  .dock-natural-sized,
  :global(.dock-faceplate .dock-rack-sized) {
    position: relative;
    width: max-content;
  }
  .fp-missing {
    padding: 12px;
    color: var(--text-dim);
    font-size: 0.75rem;
  }
</style>
