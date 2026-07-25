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
  // context (P0.2) and swaps only the INNER content across tiers — mini (hero
  // knob + glyph) → compact (row) → full-in-lane (row or plate grid). The
  // rendered cell count per tier is fit-PLANNED (laneBodyPlan): only WHOLE
  // cells ever render inside the fixed tile — never a clipped one. The OUTER box stays
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
  import {
    spineCableVar,
    laneFaceTier,
    laneBodyPlan,
    roleLineForDef,
    DOCK_HERO_GLYPH_W,
    type ShellDefLike,
  } from '$lib/ui/workflow/module-shell-model';
  import {
    glyphBinding,
    createShellGlyphTap,
    type ShellGlyphTap,
  } from '$lib/ui/workflow/shell-glyph-live';
  import {
    sineWaveSamples,
    burstWaveSamples,
    triMorphWaveSamples,
  } from '$lib/ui/controls/scope-screen-model';
  import type { ModuleNode, ParamDef, PortDef } from '$lib/graph/types';
  import type { Tier } from '$lib/ui/canvas/lod';

  // Static FALLBACK glyph traces — only for a face whose glyph has no live
  // seam yet (glyphBinding 'static'): 'waveform' draws a generic single-cycle
  // sine, 'scope' a decaying burst. The P1 batch-1 faces all bind LIVE (an
  // analyser tap on the primary audio output, or a param-reactive curve).
  const SINE_TRACE = sineWaveSamples();
  const BURST_TRACE = burstWaveSamples();

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

  // ── LIVE glyph binding (owner P1 feedback: "LIVE, not static") ──
  // Resolved PURELY from the def: an analyser tap on the primary audio output
  // (tidyVco/kickdrum trace, vca/cloudseed RMS), a param-reactive envelope
  // (adsr) or wave-morph (lfo) curve, else the deterministic static fallback.
  let binding = $derived(glyphBinding(def));

  // The LANE body plan — the no-clip guarantee (fixed 192×180 tile ⇒ fit is a
  // design-time constant): which layout (row/plate), how many WHOLE cells, and
  // whether the glyph fits. Lane views only — the dock faceplate wraps freely
  // and always shows everything.
  let lanePlan = $derived(
    view === 'lane' ? laneBodyPlan(controls.length, glyphKind !== 'none', effTier) : null,
  );

  // Whether the glyph cell RENDERS in the current view/tier — the dock hero
  // always shows it; the lane obeys the fit plan. Mirrors the render branches
  // below; the live tap's lifecycle is keyed to this (mount face → mount tap).
  let glyphShown = $derived(glyphKind !== 'none' && (view === 'dock-full' || (lanePlan?.glyph ?? true)));

  // The live-audio tap: created when a live-bound glyph cell mounts, disposed
  // when it unmounts (tier drop / dock close). While mounted, actual analyser
  // ATTACH is lazy + visibility-driven (reads arrive via the IO-gated shared
  // meter frame) and the tap self-releases after an idle window off-screen —
  // see shell-glyph-live.ts (the stated perf policy).
  let tap = $state<ShellGlyphTap | null>(null);
  $effect(() => {
    if (!glyphShown || binding.kind !== 'live-audio') return;
    const t = createShellGlyphTap(() => params.engineCtx.get(), id, binding.portId);
    tap = t;
    return () => {
      t.dispose();
      tap = null;
    };
  });

  // Param-REACTIVE glyph data (adsr envelope / lfo wave morph): recomputed on
  // the node's version tick, so a knob move or remote param change redraws.
  let envParams = $derived.by(() => {
    if (binding.kind !== 'env-params') return null;
    void nodeVersion(id);
    return {
      attack: params.paramVal(binding.attack),
      decay: params.paramVal(binding.decay),
      sustain: params.paramVal(binding.sustain),
      release: params.paramVal(binding.release),
    };
  });
  let morphTrace = $derived.by(() => {
    if (binding.kind !== 'wave-morph') return null;
    void nodeVersion(id);
    const shape = params.paramVal(binding.shapeParamId);
    // depth 0.5 = unity ±1 swing (the lfo law); display clamps at full scale.
    const amp = binding.depthParamId ? Math.min(1, 2 * params.paramVal(binding.depthParamId)) : 1;
    return triMorphWaveSamples(shape, amp);
  });

  // Header row 2 — the ROLE line for a migrated face (the def's own concise
  // category metadata), not a repeat of the type the name row already shows.
  let roleLine = $derived(roleLineForDef(def) ?? node.type);

  // Dock faceplate SECTION BANDS (P1): at the 'dock' tier the curated face
  // resolves the declared `face.pages`; the full-view renders one labeled band
  // per page. Any ranked control NOT claimed by a page falls into a trailing
  // un-labeled band so the dock still shows EVERY control (dock = all).
  let pages = $derived(view === 'dock-full' ? (face?.pages ?? null) : null);
  let unpaged = $derived.by<FaceControl[]>(() => {
    if (!pages || !pages.length) return [];
    const claimed = new Set(pages.flatMap((p) => p.controls.map((c) => c.key)));
    return controls.filter((c) => !claimed.has(c.key));
  });

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

  /** TRUE while THIS module occupies the dock full-view — the rail pill flips
   *  to "✕ CLOSE" (reactive on dockStore.fullViewNodeId). */
  let isExpanded = $derived(dockStore.fullViewNodeId === id);

  /** EXPAND ↔ CLOSE toggle: open this module's dock full-view; when it is
   *  already the occupant, close it instead. */
  function expand(): void {
    if (dockStore.fullViewNodeId === id) dockStore.closeFullView();
    else dockStore.openFullView(id);
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

  <!-- Header redesign: row 1 = domain-colour rule ── gap ── full-width NAME
       (no truncation for long names); row 2 = the faint ROLE line (the def's
       concise category — the type would just repeat the name row). -->
  <div class="tile-top">
    <span class="tile-rule" aria-hidden="true"></span>
    <span class="tile-name" title={displayName}>{displayName}</span>
  </div>
  <div class="tile-kind">
    <span class="tile-badge">{roleLine}</span>
  </div>

  {#snippet controlCell(ctl: FaceControl, knobSize: 'sm' | 'md' = 'md')}
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
            size={effTier === 'mini' ? 'lg' : knobSize}
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
  {/snippet}

  <!-- The glyph sizes to its CELL (fluid width — never a fixed canvas clipped
       by a shrinking host) and strokes in the module's DOMAIN hue (the spine
       cable colour). LIVE per the resolved binding: an analyser trace / RMS
       meter off the module's primary audio output, or a param-reactive
       envelope / wave-morph curve; static traces only as the last-resort
       fallback for a face with no live seam. -->
  {#snippet glyphCell()}
    <div class="tile-glyph" data-glyph-kind={glyphKind} data-glyph-binding={binding.kind}>
      {#if glyphKind === 'meter'}
        <VuMeter
          getLevel={tap ? tap.getLevel : undefined}
          orientation={view === 'dock-full' ? 'horizontal' : 'vertical'}
          length={view === 'dock-full' ? DOCK_HERO_GLYPH_W : 84}
          thickness={view === 'dock-full' ? 16 : 12}
          testid="shell-glyph-meter"
        />
      {:else if glyphKind === 'envelope'}
        <ScopeScreen
          mode="envelope"
          attack={envParams?.attack}
          decay={envParams?.decay}
          sustain={envParams?.sustain}
          release={envParams?.release}
          fluid
          height={view === 'dock-full' ? 64 : 40}
          color={spine}
          testid="shell-glyph"
        />
      {:else if binding.kind === 'live-audio'}
        <ScopeScreen
          mode="waveform"
          getSamples={tap ? tap.getSamples : undefined}
          fluid
          height={view === 'dock-full' ? 64 : 40}
          color={spine}
          testid="shell-glyph"
        />
      {:else}
        <ScopeScreen
          mode="wave"
          waveform={morphTrace ?? (glyphKind === 'waveform' ? SINE_TRACE : BURST_TRACE)}
          fluid
          height={view === 'dock-full' ? 64 : 40}
          color={spine}
          testid="shell-glyph"
        />
      {/if}
    </div>
  {/snippet}

  {#if pages && pages.length}
    <!-- DOCK FACEPLATE (view='dock-full' + declared pages): the glyph is the
         hero band, then one labeled SECTION BAND per curated page, then a
         trailing band for any ranked-but-unpaged controls (dock = all).
         The hero glyph is CAPPED to the first four knob columns of the
         control grid (owner feedback), left-aligned with blank space right. -->
    {#if glyphKind !== 'none'}
      <div class="tile-body dock-hero" style={`--dock-hero-glyph-w:${DOCK_HERO_GLYPH_W}px`}>
        {@render glyphCell()}
      </div>
    {/if}
    <div class="dock-pages" data-testid="face-pages">
      {#each pages as page (page.id)}
        <section class="dock-page" data-testid="face-page" data-face-page={page.id}>
          <h4 class="page-label">{page.label}</h4>
          <div class="page-controls">
            {#each page.controls as ctl (ctl.key)}
              {@render controlCell(ctl)}
            {/each}
          </div>
        </section>
      {/each}
      {#if unpaged.length}
        <section class="dock-page" data-testid="face-page" data-face-page="__unpaged">
          <h4 class="page-label">more</h4>
          <div class="page-controls">
            {#each unpaged as ctl (ctl.key)}
              {@render controlCell(ctl)}
            {/each}
          </div>
        </section>
      {/if}
    </div>
  {:else}
    <!-- The lane body, FIT-PLANNED (laneBodyPlan — the no-clip guarantee):
         either the mock .body row (whole knob columns LEFT + the fluid glyph
         filling RIGHT; a lone glyph centres) or, at the full tier when the
         face outgrows the row, the mock full-'plate' 3-col grid — WHOLE cells
         only, anything that can't fit entirely is not rendered in-lane (the
         dock faceplate has everything). -->
    {@const cells = lanePlan ? controls.slice(0, lanePlan.cellCount) : controls}
    {@const showGlyph = glyphKind !== 'none' && (lanePlan ? lanePlan.glyph : true)}
    <div
      class="tile-body"
      class:center={cells.length === 0}
      class:plate={lanePlan?.layout === 'plate'}
      data-body-layout={lanePlan?.layout ?? 'row'}
    >
      {#each cells as ctl (ctl.key)}
        {@render controlCell(ctl, lanePlan?.knobSize ?? 'md')}
      {/each}

      {#if showGlyph}
        {@render glyphCell()}
      {/if}
    </div>
  {/if}

  <!-- Jack rail = PatchPanel (lane-rail variant): domain jack dots open the
       drill-down; the "⤢" more-affordance opens the dock full-view. -->
  <PatchPanel
    nodeId={id}
    inputs={ports.inputs}
    outputs={ports.outputs}
    variant="lane-rail"
    {flowLabel}
    onExpand={view === 'lane' ? expand : undefined}
    expanded={view === 'lane' && isExpanded}
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

  /* Dock faceplate SECTION BANDS (view='dock-full'): the glyph hero, then one
     labeled band per curated page. Bands stack; controls wrap inside a band.
     The hero glyph does NOT span the faceplate: it is capped to the first
     four knob columns (--dock-hero-glyph-w, module-shell-model.ts) and
     left-aligned on the .dock-pages 10px grid edge — blank space to its
     right (the gallery-mock proportion). */
  .dock-hero {
    flex: 0 0 auto;
    justify-content: flex-start;
    padding: 4px 10px 0;
  }
  .dock-hero .tile-glyph {
    flex: 0 0 auto;
    width: min(var(--dock-hero-glyph-w, 214px), 100%);
    min-width: 0;
  }
  .dock-pages {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 4px 10px 10px;
    min-width: 0;
  }
  .dock-page {
    border-top: 1px solid var(--border, #2c3037);
    padding-top: 6px;
  }
  .page-label {
    margin: 0 0 6px;
    font-size: 0.62rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim, #9aa3ad);
  }
  .page-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 8px 10px;
  }
</style>
