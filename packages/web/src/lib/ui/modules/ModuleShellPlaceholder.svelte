<script lang="ts">
  // ModuleShellPlaceholder — the UNIFORM RACKLINE lane tile every UN-MIGRATED
  // module shows in workflow mode under the shell preview (P0.3b re-spec). It is
  // a REAL RACKLINE tile, not a stub: the mock `.mod` skeleton (domain spine +
  // bold-800 name + faint type badge + a live domain glyph filling `.body.center`
  // + the styled `.jacks` drill-down rail) built from the SHARED `.rl-tile`
  // vocabulary (_rackline-tile.css) — so it is IDENTICAL BY CONSTRUCTION to the
  // migrated <ModuleShell>, differing only in the body (no ranked knobs until the
  // module gets a `face`). The module's REAL, unchanged *Card.svelte opens
  // verbatim in the bottom dock full-view (DockFullView).
  //
  // The `.jacks` rail IS PatchPanel (lane-rail variant) — honouring the
  // "new modules use PatchPanel" standard: the jack dots open the same drill-down
  // menu, the "⤢" more-affordance opens the dock full-view. PatchPanel also
  // mounts the invisible handle stack (inside the provider), so every cable stays
  // natively attached. Its root is deliberately NOT .mod-card/.card/.moog-panel so
  // the rear-view ("flip rack") CSS never mirrors/hides it (cables must stay
  // traceable); Canvas stamps `no-flip` on the wrapper.
  //
  // Nothing here is persisted: "open in dock" sets the TRANSIENT dockStore
  // full-view occupancy (per-tab, ESC-closable), never a dock ENTRY.

  import { getModuleDef } from '$lib/audio/module-registry';
  import { getVideoModuleDef } from '$lib/video/module-registry';
  import { getMetaModuleDef } from '$lib/meta/module-registry';
  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { resolveDisplayName } from '$lib/multiplayer/module-naming';
  import { dockStore } from '$lib/ui/dock/dock-store.svelte';
  import { getLodTier } from '$lib/ui/canvas/workflow-zoom';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { portsFromDef } from './card-kit';
  import { spineCableVar, laneFaceTier, type ShellDefLike } from '$lib/ui/workflow/module-shell-model';
  import type { ModuleNode, PortDef } from '$lib/graph/types';

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
  let def = $derived(
    defLookup(node.type) as
      | (ShellDefLike & { label?: string; inputs?: readonly PortDef[]; outputs?: readonly PortDef[] })
      | undefined,
  );
  let ports = $derived(
    def
      ? { inputs: portsFromDef((def.inputs ?? []) as readonly PortDef[]), outputs: portsFromDef((def.outputs ?? []) as readonly PortDef[]) }
      : { inputs: [], outputs: [] },
  );

  /** Spine = the module's cable-domain hue (the reading-aid, not a new token). */
  let spine = $derived(spineCableVar(def));

  // The lane FaceTier for the live LOD zoom (mini|compact|full) — drives the tile's
  // per-tier HEIGHT via `data-shell-tier` (_module-card.css), so the un-migrated
  // placeholder grows as you zoom in exactly like the migrated <ModuleShell>. Reads
  // the shared context store (falls back to the singleton for a standalone mount).
  const lodTierStore = getLodTier();
  let effTier = $derived(laneFaceTier($lodTierStore));
  /** The type-kind badge (raw type id for now; a curated `def.badge` reads like
   *  the mock "osc"/"filter" once modules migrate). */
  let badge = $derived(node.type);

  /** Signal-flow label (mock `.flow` "▶ ch1"): the module's lane membership. */
  let flowLabel = $derived.by(() => {
    const d = node.data as { channel?: number; sendSlot?: number } | undefined;
    if (d?.channel != null) return `▶ ch${d.channel}`;
    if (d?.sendSlot != null) return `▶ s${d.sendSlot}`;
    return '▶ out';
  });

  /** Open the module's REAL card in the bottom dock full-view (transient). */
  function openInDock(): void {
    dockStore.openFullView(id);
  }
</script>

<div
  class="module-shell-placeholder rl-tile"
  data-testid="module-shell-placeholder"
  data-shell-node={id}
  data-shell-type={node.type}
  data-shell-tier={effTier}
  style={`--spine:${spine};--domain:${spine}`}
>
  <span class="rl-spine" aria-hidden="true"></span>

  <div class="tile-top">
    <span class="tile-name" title={displayName}>{displayName}</span>
    <span class="tile-badge">{badge}</span>
  </div>

  <!-- Un-migrated body: just the domain glyph filling the centred body (no ranked
       knobs until the module gets a `face`). A per-frame-free, domain-tinted
       signal line in the mock `.scope` well — a placeholder renders for EVERY
       un-migrated module, so no per-node analyser tap. -->
  <div class="tile-body center">
    <div class="tile-scope" aria-hidden="true">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none">
        <path class="tile-wave" d="M0 20 Q 8 4 16 20 T 32 20 T 48 20 T 64 20 T 80 20 T 100 20" />
      </svg>
    </div>
  </div>

  <!-- Jack rail = PatchPanel (lane-rail variant): domain jack dots open the
       drill-down; the "⤢" more-affordance opens the dock full-view; the mono
       flow label right-aligns. PatchPanel mounts the invisible handle stack. -->
  <PatchPanel
    nodeId={id}
    inputs={ports.inputs}
    outputs={ports.outputs}
    variant="lane-rail"
    {flowLabel}
    onExpand={openInDock}
  />
</div>
