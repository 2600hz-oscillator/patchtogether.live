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
  import VideoTileThumb from './VideoTileThumb.svelte';
  import { portsFromDef } from './card-kit';
  import { spineCableVar, laneFaceTier, hasVideoSurface, laneFlowLabel, type ShellDefLike } from '$lib/ui/workflow/module-shell-model';
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

  /** VIDEO-domain module → the glyph slot shows a LIVE THUMBNAIL of its actual
   *  output (the legacy preview seam via VideoTileThumb) instead of the generic
   *  static wave, which read as fake on a video module and left no video
   *  visible anywhere under the shell (the owner regression). */
  let videoThumb = $derived(hasVideoSurface(def));

  // The lane FaceTier for the live LOD zoom (mini|compact|full), stamped as
  // `data-shell-tier`. The OUTER box is TIER-INVARIANT (--shell-tile-h,
  // _module-card.css — the zoom-reposition fix): the tier only keys what renders
  // INSIDE the fixed box, exactly like the migrated <ModuleShell>. Reads the
  // shared context store (falls back to the singleton for a standalone mount).
  const lodTierStore = getLodTier();
  let effTier = $derived(laneFaceTier($lodTierStore));
  /** The type-kind badge (raw type id for now; a curated `def.badge` reads like
   *  the mock "osc"/"filter" once modules migrate). */
  let badge = $derived(node.type);

  /** Signal-flow label (mock `.flow` "▶ ch1"): the module's lane membership.
   *
   *  ⚠ THE DERIVATION MOVED TO `laneFlowLabel` BECAUSE IT THREW HERE. It read
   *  `data.channel != null` and interpolated it, on a `{ channel?: number }`
   *  cast that was a claim rather than a fact — `node.data` is an open record
   *  each module owns its own shape of, and `tvLibrarian` writes `data.channel`
   *  as a `TvChannelMeta` OBJECT. `Cannot convert object to primitive value`
   *  inside a `$derived` takes the whole xyflow node down, so a TUNED
   *  tvLibrarian had a broken lane tile on load. The model function type-checks
   *  instead of coercing, and its unit test pins both shapes. */
  let flowLabel = $derived(laneFlowLabel(node.data as Readonly<Record<string, unknown>> | undefined));

  /** TRUE while THIS module occupies a dock full-view pane — the rail pill
   *  flips to "✕ CLOSE" (reactive on dockStore.fullViewNodeIds; per-module
   *  presence in the side-by-side split). */
  let isExpanded = $derived(dockStore.isFullView(id));

  /** EXPAND ↔ CLOSE toggle: open the module's REAL card in a bottom dock
   *  full-view pane (transient); when it already occupies one, close JUST
   *  that pane. */
  function openInDock(): void {
    if (dockStore.isFullView(id)) dockStore.closeFullView(id);
    else dockStore.openFullView(id);
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

  <!-- Header redesign: row 1 = domain-colour rule ── gap ── full-width NAME
       (no truncation for long names); row 2 = the faint type badge. -->
  <div class="tile-top">
    <span class="tile-rule" aria-hidden="true"></span>
    <span class="tile-name" title={displayName}>{displayName}</span>
  </div>
  <div class="tile-kind">
    <span class="tile-badge">{badge}</span>
  </div>

  <!-- Un-migrated body. VIDEO-domain modules: a LIVE THUMBNAIL of the module's
       actual output in the scope well (the legacy preview seam — visibility-
       gated + thumb-res, see VideoTileThumb). Everything else keeps the
       per-frame-free, domain-tinted signal line in the mock `.scope` well — a
       placeholder renders for EVERY un-migrated module, so no per-node
       analyser tap. -->
  <div class="tile-body center">
    {#if videoThumb}
      <div class="tile-scope video-thumb-well">
        <VideoTileThumb nodeId={id} />
      </div>
    {:else}
      <div class="tile-scope" aria-hidden="true">
        <svg viewBox="0 0 100 40" preserveAspectRatio="none">
          <path class="tile-wave" d="M0 20 Q 8 4 16 20 T 32 20 T 48 20 T 64 20 T 80 20 T 100 20" />
        </svg>
      </div>
    {/if}
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
    expanded={isExpanded}
  />
</div>
