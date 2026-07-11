<script lang="ts">
  // DockStubCard — the canvas-side STUB for a docked module (P2.5a; the
  // Max/MSP dual-rect model's patching-rect projection, recommendation
  // §2.5). When a module docks, Canvas's flowNodes derivation swaps its
  // card for THIS node component — SAME node id — so:
  //
  //  * every edge keeps its real endpoint ids and renders natively (zero
  //    edge rewriting; drag/click-connect, isValidConnection, hover/
  //    select/delete all keep working against the stub's handles);
  //  * the `.svelte-flow__node[data-id]` + `[data-handleid]` DOM contracts
  //    (PickupCable lookup, per-port sweep) resolve HERE and only here —
  //    the rail card's PatchPanel self-gates its handle stack off.
  //
  // The stub mounts the full invisible corner-handle stack (the shipped
  // PatchPanel pattern: every declared port, stacked + hidden at the
  // top-left corner) and a small face: module name + a "docked" tag.
  // Clicking it focuses the rail card (dockstub:open — Canvas owns the
  // scroll/flash). Right-click opens the node context menu (Undock).
  //
  // The root class is deliberately NOT one of .mod-card/.card/.moog-panel:
  // the rear-view ("flip rack") CSS keys off those roots, so the stub does
  // not mirror or hide in rear view (its cables must stay traceable).
  // Canvas also stamps `no-flip` on the node wrapper.

  import { Handle, Position } from '@xyflow/svelte';
  import { getModuleDef } from '$lib/audio/module-registry';
  import { getVideoModuleDef } from '$lib/video/module-registry';
  import { getMetaModuleDef } from '$lib/meta/module-registry';
  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { resolveDisplayName } from '$lib/multiplayer/module-naming';
  import type { ModuleNode } from '$lib/graph/types';
  import type { DockZone } from './dock';

  interface Props {
    id: string;
    data: { node: ModuleNode; dockZone?: DockZone };
  }
  let { id, data }: Props = $props();

  let node = $derived(data.node);
  let zone = $derived(data.dockZone ?? 'top');

  // Display name — live (re-derives on renames, same channel ModuleTitle
  // uses). nodeVersion subscribes this card to its node's subtree.
  let displayName = $derived.by(() => {
    void nodeVersion(id);
    const live = patch.nodes[id] as ModuleNode | undefined;
    return resolveDisplayName(live ?? node, patch.nodes as Record<string, ModuleNode | undefined>);
  });

  function defLookup(type: string) {
    return getModuleDef(type) ?? getVideoModuleDef(type) ?? getMetaModuleDef(type);
  }
  let def = $derived(defLookup(node.type));
  let inputs = $derived(def?.inputs ?? []);
  let outputs = $derived(def?.outputs ?? []);

  function cableColorVar(cable: string | undefined): string {
    return cable ? `var(--cable-${cable})` : 'var(--cable-audio)';
  }

  /** Focus the rail card: Canvas listens document-level (expands the rail
   *  if collapsed, scrolls the card into view + flashes it). */
  function openRail(): void {
    document.dispatchEvent(
      new CustomEvent('dockstub:open', { detail: { nodeId: id, zone } }),
    );
  }
</script>

<div
  class="dock-stub-face"
  data-testid="dock-stub"
  data-stub-node={id}
  data-stub-zone={zone}
  role="button"
  tabindex="0"
  title={`${displayName} is docked to the ${zone === 'bottom' ? 'bottom drawer' : `${zone} rail`} — click to show it`}
  onclick={openRail}
  onkeydown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openRail();
    }
  }}
>
  <!-- Invisible corner handle stack — the node's ONE cable anchor set
       (mirrors PatchPanel's .handle-stack; ids are the real port ids). -->
  <div class="stub-handle-stack" aria-hidden="true">
    {#each inputs as port (port.id)}
      <Handle
        type="target"
        position={Position.Left}
        id={port.id}
        style={`--handle-color: ${cableColorVar(port.type as string)};`}
      />
    {/each}
    {#each outputs as port (port.id)}
      <Handle
        type="source"
        position={Position.Right}
        id={port.id}
        style={`--handle-color: ${cableColorVar(port.type as string)};`}
      />
    {/each}
  </div>
  <span class="stub-glyph" aria-hidden="true">⇱</span>
  <span class="stub-text">
    <span class="stub-name">{displayName}</span>
    <span class="stub-tag">docked · {zone}</span>
  </span>
</div>

<style>
  .dock-stub-face {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 158px;
    min-height: 44px;
    box-sizing: border-box;
    padding: 6px 10px;
    background: var(--module-bg-deep, #0b0e13);
    border: 1px dashed var(--accent-dim, #1d5f66);
    border-radius: 4px;
    color: var(--text);
    cursor: pointer;
    font-family: ui-monospace, monospace;
  }
  .dock-stub-face:hover {
    border-color: var(--accent, #00f0ff);
    background: rgba(0, 240, 255, 0.06);
  }
  .stub-glyph {
    color: var(--accent, #00f0ff);
    font-size: 0.9rem;
    flex: 0 0 auto;
  }
  .stub-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .stub-name {
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .stub-tag {
    font-size: 0.58rem;
    color: var(--text-dim);
    letter-spacing: 0.04em;
  }
  /* Handle stack: identical mechanics to PatchPanel's — stacked, hidden,
     inert; cables anchor at the stub's top-left corner. */
  .stub-handle-stack {
    position: absolute;
    top: 4px;
    left: 4px;
    width: 0;
    height: 0;
    pointer-events: none;
  }
  .stub-handle-stack :global(.svelte-flow__handle) {
    position: absolute !important;
    top: 6px !important;
    left: 6px !important;
    right: auto !important;
    bottom: auto !important;
    transform: none !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }
</style>
