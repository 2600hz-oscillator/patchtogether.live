<script lang="ts">
  // ModuleShellPlaceholder — the UNIFORM styled lane tile every UN-MIGRATED
  // module shows in workflow mode under the shell preview (P0.3b). It is the
  // legacy-fallback bridge's lane half: a RACKLINE-framed placeholder (domain
  // spine + big name + type badge + a generic live glyph + an "open in dock"
  // affordance), with the FULL invisible corner-handle stack so every cable
  // stays natively attached — while the module's REAL, unchanged *Card.svelte
  // opens verbatim in the bottom dock full-view (Canvas + DockCardHost).
  //
  // It GENERALIZES DockStubCard (the docked-node stub): same handle-stack +
  // click-to-open contract, restyled to the uniform RACKLINE tile. Like the
  // stub, its root is deliberately NOT .mod-card/.card/.moog-panel so the
  // rear-view ("flip rack") CSS never mirrors/hides it (its cables must stay
  // traceable); Canvas stamps `no-flip` on the wrapper.
  //
  // Nothing here is persisted: "open in dock" sets the TRANSIENT dockStore
  // full-view occupancy (per-tab, ESC-closable), never a dock ENTRY — the
  // un-migrated fallback is pure view furniture (transient-dock doctrine).

  import { Handle, Position } from '@xyflow/svelte';
  import { getModuleDef } from '$lib/audio/module-registry';
  import { getVideoModuleDef } from '$lib/video/module-registry';
  import { getMetaModuleDef } from '$lib/meta/module-registry';
  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { resolveDisplayName } from '$lib/multiplayer/module-naming';
  import { dockStore } from '$lib/ui/dock/dock-store.svelte';
  import { spineCableVar, cableTypeForDef, type ShellDefLike } from '$lib/ui/workflow/module-shell-model';
  import type { ModuleNode } from '$lib/graph/types';

  interface Props {
    id: string;
    data: { node: ModuleNode };
  }
  let { id, data }: Props = $props();

  let node = $derived(data.node);

  // Live display name (re-derives on renames — same channel ModuleTitle uses).
  let displayName = $derived.by(() => {
    void nodeVersion(id);
    const live = patch.nodes[id] as ModuleNode | undefined;
    return resolveDisplayName(live ?? node, patch.nodes as Record<string, ModuleNode | undefined>);
  });

  function defLookup(type: string) {
    return getModuleDef(type) ?? getVideoModuleDef(type) ?? getMetaModuleDef(type);
  }
  let def = $derived(defLookup(node.type) as (ShellDefLike & { label?: string }) | undefined);
  let inputs = $derived(def?.inputs ?? []);
  let outputs = $derived(def?.outputs ?? []);

  /** Spine = the module's cable-domain hue (the reading-aid, not a new token). */
  let spine = $derived(spineCableVar(def));
  let badge = $derived(node.type);
  let glyphCable = $derived(cableTypeForDef(def));

  function cableColorVar(cable: string | undefined): string {
    return cable ? `var(--cable-${cable})` : 'var(--cable-audio)';
  }

  /** Open the module's REAL card in the bottom dock full-view (transient). */
  function openInDock(): void {
    dockStore.openFullView(id);
  }
</script>

<div
  class="module-shell-placeholder"
  data-testid="module-shell-placeholder"
  data-shell-node={id}
  data-shell-type={node.type}
  style={`--spine:${spine};--domain:${spine}`}
>
  <!-- Invisible corner handle stack — the node's ONE cable anchor set (mirrors
       DockStubCard / PatchPanel; ids are the real port ids). -->
  <div class="msp-handle-stack" aria-hidden="true">
    {#each inputs as port (port.id)}
      <Handle
        type="target"
        position={Position.Left}
        id={port.id}
        style={`--handle-color: ${cableColorVar(port.type)};`}
      />
    {/each}
    {#each outputs as port (port.id)}
      <Handle
        type="source"
        position={Position.Right}
        id={port.id}
        style={`--handle-color: ${cableColorVar(port.type)};`}
      />
    {/each}
  </div>

  <span class="msp-spine" aria-hidden="true"></span>

  <div class="msp-body">
    <div class="msp-top">
      <span class="msp-name title" title={displayName}>{displayName}</span>
      <span class="msp-badge">{badge}</span>
    </div>

    <!-- Generic domain-tinted glyph: a cheap CSS-animated signal line (no
         per-node analyser tap — the live output-tapped glyph is a follow-up;
         a placeholder renders for EVERY un-migrated module, so the glyph must
         stay per-frame-free). -->
    <div class="msp-glyph" data-glyph-cable={glyphCable} aria-hidden="true">
      <svg viewBox="0 0 100 28" preserveAspectRatio="none">
        <path
          class="msp-wave"
          d="M0 14 Q 8 2 16 14 T 32 14 T 48 14 T 64 14 T 80 14 T 100 14"
          fill="none"
        />
      </svg>
    </div>

    <button
      class="msp-open"
      data-testid="shell-open-dock"
      type="button"
      onclick={openInDock}
      title={`Open ${displayName} in the dock`}
    >
      ⇱ open in dock
    </button>
  </div>
</div>

<style>
  .module-shell-placeholder {
    --_spine: var(--spine, var(--cable-audio));
    position: relative;
    display: flex;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    min-width: 150px;
    min-height: 88px;
    overflow: hidden;
    background: linear-gradient(180deg, var(--surface-3, #262a31), var(--module-bg, #1c1f24));
    border: 1px solid var(--border-strong, #33383f);
    border-radius: var(--r-tile, 8px);
    box-shadow: var(--shadow-tile, 0 2px 5px rgba(0, 0, 0, 0.35));
    color: var(--text, #eef1f5);
    font-family: var(--font, sans-serif);
  }
  .msp-spine {
    flex: 0 0 auto;
    width: var(--spine-w, 4px);
    background: var(--_spine);
  }
  .msp-body {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: 8px 9px 7px;
    gap: 6px;
  }
  .msp-top {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }
  .msp-name {
    flex: 1 1 auto;
    min-width: 0;
    font-size: var(--t-title-compact, 14.5px);
    font-weight: 650;
    letter-spacing: 0.01em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .msp-badge {
    flex: 0 0 auto;
    font-family: var(--mono, ui-monospace, monospace);
    font-size: var(--t-badge, 8.5px);
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--_spine);
    opacity: 0.85;
    max-width: 46%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .msp-glyph {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2px 0;
    background: var(--module-bg-deep, #0a0c0f);
    border-radius: 4px;
  }
  .msp-glyph svg {
    width: 100%;
    height: 100%;
    max-height: var(--glyph-h, 52px);
  }
  .msp-wave {
    stroke: var(--_spine);
    stroke-width: 2;
    stroke-linecap: round;
    opacity: 0.85;
    filter: drop-shadow(0 0 3px var(--_spine));
    stroke-dasharray: 6 5;
    animation: msp-scan 2.4s linear infinite;
  }
  @keyframes msp-scan {
    to {
      stroke-dashoffset: -22;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .msp-wave {
      animation: none;
    }
  }
  .msp-open {
    flex: 0 0 auto;
    align-self: flex-start;
    background: transparent;
    border: 1px solid var(--border-strong, #3a3f47);
    border-radius: 4px;
    color: var(--text-dim, #9aa2ad);
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 9.5px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 3px 8px;
    cursor: pointer;
  }
  .msp-open:hover {
    color: var(--text, #eef1f5);
    border-color: var(--_spine);
    background: color-mix(in srgb, var(--_spine) 12%, transparent);
  }
  .msp-open:focus-visible {
    outline: 2px solid var(--_spine);
    outline-offset: 1px;
  }
  /* Handle stack: identical mechanics to DockStubCard's — stacked, hidden,
     inert; cables anchor at the tile's top-left corner. */
  .msp-handle-stack {
    position: absolute;
    top: 4px;
    left: 4px;
    width: 0;
    height: 0;
    pointer-events: none;
  }
  .msp-handle-stack :global(.svelte-flow__handle) {
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
