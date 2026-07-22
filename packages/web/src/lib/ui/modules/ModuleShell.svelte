<script lang="ts">
  // ModuleShell — the RACKLINE shared skeleton (P0.3b §3.1). ONE frame every
  // MIGRATED module fills, instead of ~193 cards redrawing freehand: a
  // domain-colour spine, a big legible title + type badge, a tier-curated
  // control grid, a live glyph, and the PatchPanel jack rail. The module never
  // touches the frame — it declares a co-located `face` ranking (see ModuleFace)
  // and the shell paints the top-N controls for the current LOD tier.
  //
  // SEMANTIC ZOOM: it reads the current LOD tier from the shared getLodTier()
  // context (P0.2) and swaps only the INNER content across tiers — mini (1 hero
  // + glyph) → compact (~3) → full-in-lane (~8). The OUTER box stays pinned to
  // the tier-invariant rack-sized wrapper (the rack-sizing CSS forces
  // --rack-hp × --rack-u); a tier swap NEVER resizes the measured node box, so
  // the channel-column stack math never recomputes / thrashes (plan §3.1 / §9).
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
  import { spineCableVar, cableTypeForDef, laneFaceTier, type ShellDefLike } from '$lib/ui/workflow/module-shell-model';
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
  let glyphCable = $derived(cableTypeForDef(def));

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

  function expand(): void {
    dockStore.openFullView(id);
  }
</script>

<div
  class="module-shell"
  class:dock-full={view === 'dock-full'}
  data-testid="module-shell"
  data-shell-node={id}
  data-shell-type={node.type}
  data-shell-tier={effTier}
  style={`--spine:${spine};--domain:${spine}`}
>
  <span class="ms-spine" aria-hidden="true"></span>

  <div class="ms-body">
    <div class="ms-header">
      <span class="ms-name title" title={displayName}>{displayName}</span>
      <span class="ms-badge">{node.type}</span>
      {#if view === 'lane'}
        <button
          class="ms-expand"
          data-testid="shell-expand"
          type="button"
          onclick={expand}
          title={`Open ${displayName} full view in the dock`}
        >⤢</button>
      {/if}
    </div>

    {#if controls.length}
      <div class="ms-grid" data-testid="shell-control-grid">
        {#each controls as ctl (ctl.key)}
          {#if ctl.kind === 'param'}
            {@const pd = paramDef(ctl.paramId ?? ctl.key)}
            {#if pd}
              <div class="ms-cell">
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
            <div class="ms-cell ms-cell-other" data-cell-kind={ctl.kind}>
              <span class="ms-cell-label">{ctl.label}</span>
            </div>
          {/if}
        {/each}
      </div>
    {/if}

    {#if glyphKind !== 'none'}
      <div class="ms-glyph" data-glyph-kind={glyphKind}>
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

    <div class="ms-jacks">
      <PatchPanel nodeId={id} inputs={ports.inputs} outputs={ports.outputs} />
    </div>
  </div>
</div>

<style>
  .module-shell {
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
  .ms-spine {
    flex: 0 0 auto;
    width: var(--spine-w, 4px);
    background: var(--_spine);
  }
  .ms-body {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding: 8px 9px 6px;
    gap: 7px;
  }
  .ms-header {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }
  .ms-name {
    flex: 1 1 auto;
    min-width: 0;
    font-size: var(--t-title-compact, 14.5px);
    font-weight: 650;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ms-badge {
    flex: 0 0 auto;
    font-family: var(--mono, ui-monospace, monospace);
    font-size: var(--t-badge, 8.5px);
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--_spine);
    opacity: 0.85;
  }
  .ms-expand {
    flex: 0 0 auto;
    background: transparent;
    border: 1px solid var(--border-strong, #3a3f47);
    border-radius: 4px;
    color: var(--text-dim, #9aa2ad);
    font-size: 11px;
    line-height: 1;
    padding: 2px 5px;
    cursor: pointer;
  }
  .ms-expand:hover {
    color: var(--text, #eef1f5);
    border-color: var(--_spine);
  }
  .ms-grid {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 9px;
  }
  .ms-cell {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .ms-cell-other {
    min-width: 44px;
    min-height: 40px;
    padding: 4px 6px;
    border: 1px dashed var(--border, #2c3037);
    border-radius: 4px;
  }
  .ms-cell-label {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: var(--t-label-compact, 10px);
    color: var(--text-dim, #9aa2ad);
    text-align: center;
  }
  .ms-glyph {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--module-bg-deep, #0a0c0f);
    border-radius: 4px;
    padding: 2px;
  }
  .ms-jacks {
    margin-top: auto;
  }
</style>
