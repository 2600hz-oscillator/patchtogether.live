<script lang="ts">
  // ModuleShell — the RACKLINE shared skeleton (P0.3b re-spec). ONE frame every
  // MIGRATED module fills, built from the SHARED `.rl-tile` vocabulary
  // (_rackline-tile.css) so it is IDENTICAL BY CONSTRUCTION to the un-migrated
  // <ModuleShellPlaceholder>: a domain-colour spine, a bold-800 title + faint
  // type badge, one inline `.body` row (tier-curated knob columns LEFT + a live
  // glyph filling RIGHT), and the styled `.jacks` drill-down rail rendered by
  // PatchPanel's lane-rail variant. The module never touches the frame — it
  // declares a co-located `face` ranking (see ModuleFace) and the shell paints
  // the top-N controls for the current LOD tier.
  //
  // SEMANTIC ZOOM: it reads the current LOD tier from the shared getLodTier()
  // context (P0.2) and swaps only the INNER content across tiers — mini (glyph
  // only) → compact (~3 knobs + glyph) → full-in-lane (~8). The OUTER box stays
  // pinned to the UNIFORM RACKLINE tile height (_module-card.css forces
  // --shell-tile-h); a tier swap NEVER resizes the measured node box, so the
  // channel-column stack math never recomputes / thrashes (plan §3.1 / §9).
  //
  // In P0.3b NO real module carries a `face` yet (STRICT_FACES is empty), so the
  // curated-control path is exercised by a fixture, not a shipped module — the
  // whole shell is inert in production until the first P1 reskin. Rendered as a
  // flow node (type 'moduleShell') for migrated modules; the un-migrated tile is
  // ModuleShellPlaceholder.

  import { getModuleDef } from '$lib/audio/module-registry';
  import { getVideoModuleDef } from '$lib/video/module-registry';
  import { getMetaModuleDef } from '$lib/meta/module-registry';
  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { resolveDisplayName } from '$lib/multiplayer/module-naming';
  import { getLodTier } from '$lib/ui/canvas/workflow-zoom';
  import { dockStore } from '$lib/ui/dock/dock-store.svelte';
  import { cardParams, portsFromDef } from './card-kit';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { KnobConic, ScopeScreen, VuMeter } from '$lib/ui/controls';
  import { curatedFace, type FaceControl, type FaceTier } from '$lib/ui/workflow/curated-face';
  import { spineCableVar, laneFaceTier, type ShellDefLike } from '$lib/ui/workflow/module-shell-model';
  import type { ModuleNode, ParamDef, PortDef } from '$lib/graph/types';
  import type { Tier } from '$lib/ui/canvas/lod';

  interface Props {
    id: string;
    data: {
      node: ModuleNode;
      /** 'lane' (default) or 'dock-full' — the dock faceplate seam (P1). */
      view?: 'lane' | 'dock-full';
      /** Test/dock override of the LOD tier; else the getLodTier() context. */
      tier?: Tier;
    };
  }
  let { id, data }: Props = $props();

  let node = $derived(data.node);
  let view = $derived(data.view ?? 'lane');

  // LOD tier: the shared context store (falls back to the singleton when no
  // provider — e.g. a fixture/VRT mount), or an explicit override on `data`.
  const lodTierStore = getLodTier();
  let effTier: FaceTier = $derived(
    view === 'dock-full' ? 'dock' : laneFaceTier(data.tier ?? $lodTierStore),
  );

  function defLookup(type: string) {
    return getModuleDef(type) ?? getVideoModuleDef(type) ?? getMetaModuleDef(type);
  }
  let def = $derived(
    defLookup(node.type) as
      | (ShellDefLike & { label?: string; params?: readonly ParamDef[]; inputs?: readonly PortDef[]; outputs?: readonly PortDef[] })
      | undefined,
  );

  let displayName = $derived.by(() => {
    void nodeVersion(id);
    const live = patch.nodes[id] as ModuleNode | undefined;
    return resolveDisplayName(live ?? node, patch.nodes as Record<string, ModuleNode | undefined>);
  });

  let spine = $derived(spineCableVar(def));

  // Param plumbing (card-kit): identical closures every card carries, so the
  // shell's KnobConic cells are MIDI-assignable + live-motorized + right-click-
  // menu'd exactly like a hand-built card.
  const params = cardParams({ params: (def?.params ?? []) as readonly ParamDef[] }, () => id, () => node);

  // The tier-curated controls (top-N: mini=1 / compact=3 / full=8 / dock=all).
  let face = $derived(def ? curatedFace(def, effTier) : null);
  let controls = $derived<FaceControl[]>(face?.controls ?? []);
  let glyphKind = $derived(face?.glyph ?? 'none');

  function paramDef(pid: string): ParamDef | undefined {
    return (def?.params ?? []).find((p) => p.id === pid);
  }

  let ports = $derived(def ? { inputs: portsFromDef(def.inputs ?? []), outputs: portsFromDef(def.outputs ?? []) } : { inputs: [], outputs: [] });

  /** Signal-flow label (mock `.flow` "▶ ch1"): the module's lane membership. */
  let flowLabel = $derived.by(() => {
    const d = node.data as { channel?: number; sendSlot?: number } | undefined;
    if (d?.channel != null) return `▶ ch${d.channel}`;
    if (d?.sendSlot != null) return `▶ s${d.sendSlot}`;
    return '▶ out';
  });

  function expand(): void {
    dockStore.openFullView(id);
  }
</script>

<div
  class="module-shell rl-tile"
  class:dock-full={view === 'dock-full'}
  data-testid="module-shell"
  data-shell-node={id}
  data-shell-type={node.type}
  data-shell-tier={effTier}
  style={`--spine:${spine};--domain:${spine}`}
>
  <span class="rl-spine" aria-hidden="true"></span>

  <div class="tile-top">
    <span class="tile-name" title={displayName}>{displayName}</span>
    <span class="tile-badge">{node.type}</span>
  </div>

  <!-- One inline body row (mock .body): curated knob columns LEFT, the live
       glyph filling RIGHT; a lone glyph centres (.body.center). -->
  <div class="tile-body" class:center={controls.length === 0}>
    {#each controls as ctl (ctl.key)}
      {#if ctl.kind === 'param'}
        {@const pd = paramDef(ctl.paramId ?? ctl.key)}
        {#if pd}
          <div class="kcol">
            <KnobConic
              value={params.paramVal(pd.id)}
              min={pd.min}
              max={pd.max}
              defaultValue={pd.defaultValue}
              label={pd.label}
              units={pd.units ?? ''}
              curve={pd.curve}
              onchange={params.set(pd.id)}
              readLive={params.live(pd.id)}
              moduleId={id}
              paramId={pd.id}
              size={effTier === 'mini' ? 'lg' : 'md'}
              accent={spine}
            />
          </div>
        {/if}
      {:else}
        <!-- family / static cell — the shell frames + labels it; the rich
             grid/cluster/select render is a P1 per-module concern. -->
        <div class="kcol ms-cell-other" data-cell-kind={ctl.kind}>
          <span class="lab">{ctl.label}</span>
        </div>
      {/if}
    {/each}

    {#if glyphKind !== 'none'}
      <div class="tile-glyph" data-glyph-kind={glyphKind}>
        {#if glyphKind === 'meter'}
          <VuMeter />
        {:else}
          <ScopeScreen
            mode={glyphKind === 'envelope' ? 'envelope' : 'wave'}
            width={110}
            height={40}
            testid="shell-glyph"
          />
        {/if}
      </div>
    {/if}
  </div>

  <!-- Jack rail = PatchPanel (lane-rail variant): domain jack dots open the
       drill-down; the "⤢" more-affordance opens the dock full-view. -->
  <PatchPanel
    nodeId={id}
    inputs={ports.inputs}
    outputs={ports.outputs}
    variant="lane-rail"
    {flowLabel}
    onExpand={view === 'lane' ? expand : undefined}
  />
</div>

<style>
  /* Family / static curated cell (P1 render is per-module) — a small dashed
     placeholder inside the shared .kcol column. */
  .ms-cell-other {
    min-width: 44px;
    min-height: 40px;
    padding: 4px 6px;
    justify-content: center;
    border: 1px dashed var(--border, #2c3037);
    border-radius: 4px;
  }
</style>
