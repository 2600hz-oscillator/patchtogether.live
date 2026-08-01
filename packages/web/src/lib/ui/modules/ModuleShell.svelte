<script lang="ts" module>
  // THE SHELL LAYER's test-hook publish (PF-14). The panel operability probes
  // are SHELL metadata — how the shell renders + how to poke a bespoke panel —
  // so they ride their own `window.__shellPanelProbes` global rather than
  // `__moduleSpecs`: `$lib/dev/module-specs` projects the MODULE REGISTRY and
  // is imported by the registration barrels, so publishing from there would
  // create a live cycle (audio/modules/index → dev/module-specs →
  // workflow/shell-cells → ui/modules/dx7-patch-actions → audio/modules/dx7).
  // Module scope: runs ONCE, when the shell itself is first imported.
  import { exposeShellPanelProbesForTests } from '$lib/ui/workflow/shell-cells';
  exposeShellPanelProbesForTests();
</script>

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
  import VideoTileThumb from './VideoTileThumb.svelte';
  // The one module-specific import in the shell, and it rides the seam that
  // already declares itself special: `glyphBinding`'s 'algorithm' kind is
  // hard-wired to the `algorithm` param (see its ⚠ note). A second topology
  // module would generalise BOTH at once — until then a registry indirection
  // here would be one indirection serving one caller.
  import Dx7AlgorithmGlyph from './dx7/Dx7AlgorithmGlyph.svelte';
  import { Button, KnobConic, ParamGrid, ScopeScreen, Segmented, Selector, Toggle, VuMeter } from '$lib/ui/controls';
  import { curatedFace, dockFacePlan, type FaceControl, type FaceTier } from '$lib/ui/workflow/curated-face';
  import { shellCellFor } from '$lib/ui/workflow/shell-cells';
  import { gridParamIds, momentaryParamIds, momentaryValue, paramCellKind } from '$lib/ui/workflow/shell-control-kind';
  import {
    spineCableVar,
    laneFaceTier,
    laneBodyPlan,
    roleLineForDef,
    DOCK_HERO_GLYPH_W,
    hasVideoSurface,
    type ShellDefLike,
  } from '$lib/ui/workflow/module-shell-model';
  import {
    glyphBinding,
    createShellGlyphTap,
    createLiveWaveSource,
    type ShellGlyphTap,
  } from '$lib/ui/workflow/shell-glyph-live';
  import {
    sineWaveSamples,
    burstWaveSamples,
    triMorphWaveSamples,
    sawPulseMixWaveSamples,
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

  // The tier-curated controls (top-N: mini=1 / compact=2 with a glyph, 3
  // without / full=8 / dock=all — faceTierCap, reconciled with laneBodyPlan).
  let face = $derived(def ? curatedFace(def, effTier) : null);
  let controls = $derived<FaceControl[]>(face?.controls ?? []);
  let glyphKind = $derived(face?.glyph ?? 'none');

  // ── LIVE glyph binding (owner P1 feedback: "LIVE, not static") ──
  // Resolved PURELY from the def: an analyser tap on the primary audio output
  // (tidyVco/kickdrum trace, vca/cloudseed RMS), a param-reactive envelope
  // (adsr) or wave-morph (lfo) curve, else the deterministic static fallback.
  let binding = $derived(glyphBinding(def));

  // VIDEO-domain module → the glyph slot shows a LIVE THUMBNAIL of its actual
  // output (the legacy preview seam via VideoTileThumb), never a static trace:
  // a migrated video face gets the same live picture the placeholder tiles do.
  let videoThumb = $derived(hasVideoSurface(def));
  let hasGlyph = $derived(glyphKind !== 'none' || videoThumb);

  // The LANE body plan — the no-clip guarantee (fixed 192×180 tile ⇒ fit is a
  // design-time constant): which layout (row/plate), how many WHOLE cells, and
  // whether the glyph fits. Lane views only — the dock faceplate wraps freely
  // and always shows everything.
  let lanePlan = $derived(
    view === 'lane' ? laneBodyPlan(controls.length, hasGlyph, effTier) : null,
  );

  // Whether the glyph cell RENDERS in the current view/tier — the dock hero
  // always shows it; the lane obeys the fit plan. Mirrors the render branches
  // below; the live tap's lifecycle is keyed to this (mount face → mount tap).
  let glyphShown = $derived(glyphKind !== 'none' && (view === 'dock-full' || (lanePlan?.glyph ?? true)));

  // DUAL glyph (owner spec — tidyVco): the param-derived STATIC CORE WAVEFORM
  // is the identity and renders EVERYWHERE the glyph fits; the live analyser
  // trace rides ALONGSIDE it only where BOTH panes fit WHOLE — the dock hero
  // band (split inside the 4-knob-column cap) and the full-in-lane plate's
  // full-width strip. A lane ROW cell shows just the morph (the compact tile
  // prefers the identity; two 40px-floor wells can't both fit next to the
  // knob columns — the no-clip rule).
  let dualShowsTrace = $derived(
    binding.kind === 'dual' && (view === 'dock-full' || lanePlan?.layout === 'plate'),
  );

  // The live-audio tap: created when a live-trace glyph cell mounts, disposed
  // when it unmounts (tier drop / dock close / dual tile without the trace
  // pane). While mounted, actual analyser ATTACH is lazy + visibility-driven
  // (reads arrive via the IO-gated shared meter frame) and the tap
  // self-releases after an idle window off-screen — see shell-glyph-live.ts
  // (the stated perf policy).
  let tapWanted = $derived(
    glyphShown && (binding.kind === 'live-audio' || dualShowsTrace),
  );
  let tap = $state<ShellGlyphTap | null>(null);
  $effect(() => {
    const b = binding;
    if (!tapWanted || (b.kind !== 'live-audio' && b.kind !== 'dual')) return;
    const t = createShellGlyphTap(() => params.engineCtx.get(), id, b.portId);
    tap = t;
    return () => {
      t.dispose();
      tap = null;
    };
  });

  // Param-REACTIVE glyph data (adsr envelope): recomputed on the node's
  // version tick, so a knob move or remote param change redraws.
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

  // ── LIVE-WHILE-TWISTING param waves (dual + lfo wave-morph) ──
  // Knob gestures write TRANSIENT-FIRST (the durable node.params commit
  // coalesces behind the gesture), so a display derived from COMMITTED params
  // looks dead mid-drag. These read the SAME live seam the motorized knobs
  // read — cardParams.live → engine.readParam (committed paramVal fallback
  // while the engine isn't booted, keeping the ungated VRT scenes at the
  // deterministic defaults) — and are POLLED by ScopeScreen's shared-frame
  // wave mode. createLiveWaveSource memoizes on the tuple: identity only
  // changes when a value moved, so idle frames repaint nothing.
  const liveParam = (pid: string): number => params.live(pid)() ?? params.paramVal(pid);
  let liveWave = $derived.by<(() => Float32Array) | null>(() => {
    const b = binding;
    if (b.kind === 'dual') {
      const w = b.wave;
      return createLiveWaveSource(
        () => [
          liveParam(w.shape1),
          w.shape2 ? liveParam(w.shape2) : 0,
          w.pw ? liveParam(w.pw) : 0.5,
          w.mix ? liveParam(w.mix) : 0,
        ],
        (v) => sawPulseMixWaveSamples(v[0] ?? 0, v[1], v[2], v[3]),
      );
    }
    if (b.kind === 'wave-morph') {
      return createLiveWaveSource(
        () => [
          liveParam(b.shapeParamId),
          // The module's own DEPTH → gain law, carried on the binding
          // (`depthGain`) rather than re-typed here — the shell has no business
          // knowing a particular worklet's multiplier. Clamped to the screen's
          // ±1 box, which is why the drawn cycle saturates at unity while the
          // real swing keeps growing (see lfoGlyphAmp / the depth doc).
          b.depthParamId ? Math.min(1, b.depthGain * liveParam(b.depthParamId)) : 1,
        ],
        (v) => triMorphWaveSamples(v[0] ?? 0, v[1]),
      );
    }
    return null;
  });

  // TOPOLOGY glyph caption (PF-15): the bound param's CURRENT state, read
  // through the same live/transient seam the motorized knobs use so it tracks a
  // gesture rather than waiting for the durable commit. Named by the def's own
  // vocabulary when it declares one (`format` / `options`), else the raw step.
  // The topology glyph's VALUE — the ONE reader the diagram and its caption
  // both go through, so they cannot drift apart.
  //
  // ⚠ READS THE DURABLE PARAM, **NOT** `liveParam`, and that is a FIX, not an
  // oversight. `liveParam` is `params.live(id)() ?? params.paramVal(id)`, and
  // `params.live` asks the ENGINE. For dx7, `algorithm` is not an AudioParam,
  // so `readParam` hands back the host's `currentAlgo` shadow — which only
  // moves once an audio engine is actually running. With no engine started the
  // shadow sits at its construction value forever, the `??` fallback never
  // fires because a number is not nullish, and the plate renders a topology
  // the patch abandoned. Measured: the picker committed algorithm 22, the chip
  // read "ALGORITHM 22", and BOTH the diagram and the caption still said 5.
  //
  // That was a PRE-EXISTING defect in the caption (shipped in PR 2, which had
  // no test opening the control); PR 4 only made it visible by giving the
  // plate a second, bigger thing to render wrong. Reading durable state is
  // also simply correct here: `algorithm` is discrete, has no CV input on this
  // module, and MIDI-learn commits through `setNodeParam` like everything
  // else — so there is no live-only value for the engine to know about.
  // Regression-locked by dx7-algorithm-picker.spec.ts.
  let topologyValue = $derived.by(() => {
    const b = binding;
    if (b.kind !== 'algorithm') return 0;
    void nodeVersion(id);
    return params.paramVal(b.paramId);
  });

  let topologyLabel = $derived.by(() => {
    const b = binding;
    if (b.kind !== 'algorithm') return '';
    void nodeVersion(id);
    const pd = paramDef(b.paramId);
    const v = topologyValue;
    if (pd?.format) return pd.format(v);
    const named = pd?.options?.find((o) => o.value === v)?.label;
    return named ?? String(Math.round(v));
  });

  // Header row 2 — the ROLE line for a migrated face (the def's own concise
  // category metadata), not a repeat of the type the name row already shows.
  let roleLine = $derived(roleLineForDef(def) ?? node.type);

  // Dock faceplate SECTION BANDS (P1): the PURE dockFacePlan seam — one band
  // per declared `face.pages` page + the '__unpaged' defensive tail (or the
  // single '__all' band for a page-less face), so the dock still shows EVERY
  // control (dock = all). The render-parity gates (module-face-lint unit +
  // the faces-parity e2e) pin this plan to the def's full control surface —
  // the tidyVco tune-cluster loss class can't silently recur at this seam.
  let dockBands = $derived(view === 'dock-full' && def ? dockFacePlan(def) : null);

  function paramDef(pid: string): ParamDef | undefined {
    return (def?.params ?? []).find((p) => p.id === pid);
  }

  // ── CELL PLUMBING (the P1 batch-2 INERT-CELL fix) ───────────────────────
  //
  // Three cell kinds, all REAL controls. `param` is generic (KnobConic, or a
  // momentary Button for a DECLARED press-pad); `family`/`static` resolve to a
  // declarative spec in shell-cells.ts and paint with the shared primitive
  // library. A family/static key with NO registered spec renders an explicitly
  // INERT cell — which module-face-lint and the faces-parity e2e both FAIL on,
  // so a dead label can never quietly ship again.

  /** Declared momentary (press-pad) params — see ModuleFace.momentary. */
  let momentary = $derived(momentaryParamIds(def as { face?: { momentary?: readonly string[] } } | undefined));

  /** Declared `'grid'` param cells — see ModuleFace.paramCells (PF-15). */
  let gridCells = $derived(
    gridParamIds(def as { face?: { paramCells?: Readonly<Record<string, 'grid'>> } } | undefined),
  );

  /**
   * The LIVE node (the Y.Doc entry, not the flow-node snapshot) + its version
   * tick, so a cell reading `node.data` (a preset roster, an imported bank)
   * re-derives on a local OR remote change exactly like the legacy card.
   *
   * The version is CARRIED IN THE RESULT on purpose: `patch.nodes[id]` is a
   * stable SyncedStore proxy, so a derived that returns it bare is `===` to its
   * previous value and Svelte suppresses the invalidation — the cell would
   * never see a `data` change (the DX7 preset chip kept showing E.PIANO 1 after
   * loading another voice). Returning a fresh wrapper makes the tick the
   * identity, so reading `.n` re-runs the cell's projection every bump.
   */
  let liveCell = $derived.by<{ v: number; n: ModuleNode | undefined }>(() => ({
    v: nodeVersion(id),
    n: (patch.nodes[id] as ModuleNode | undefined) ?? node,
  }));

  /**
   * Fire a MOMENTARY press-param: high on press, back to REST on release. Same
   * two writes the legacy pad does (TomtomCard/ClapCard) — the durable param so
   * the state is shared + the UI reflects the hold, and a direct engine push so
   * the hit is immediate rather than waiting on the commit path. Because the
   * release always writes REST back, nothing latched survives in the Y.Doc.
   */
  function firePressParam(pd: ParamDef, high: boolean): void {
    const v = momentaryValue(high, pd.defaultValue);
    params.set(pd.id)(v);
    const e = params.engineCtx.get();
    const live = patch.nodes[id] as ModuleNode | undefined;
    if (e && live) e.setParam(live, pd.id, v);
  }

  /** Per-cell status/error line for a FILE cell (keyed by the face key). */
  let cellStatus = $state<Record<string, { status: string | null; error: string | null }>>({});

  async function onCellFile(
    ctlKey: string,
    load: (nodeId: string, file: File) => Promise<{ status: string | null; error: string | null }>,
    ev: Event,
  ): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    cellStatus = { ...cellStatus, [ctlKey]: { status: 'parsing...', error: null } };
    const res = await load(id, file);
    cellStatus = { ...cellStatus, [ctlKey]: res };
    try { input.value = ''; } catch { /* some browsers disallow the reset */ }
  }

  /** A stable, collision-free test id for a family/static cell's interactive
   *  element. Deliberately NOT the family's own `testidPrefix` (that id belongs
   *  to the legacy card and is grep-pinned to it by the docs gate). */
  function cellTestId(ctl: FaceControl): string {
    return `shell-cell-${ctl.familyId ?? ctl.key.replace(/[{}]/g, '')}`;
  }

  let ports = $derived(def ? { inputs: portsFromDef(def.inputs ?? []), outputs: portsFromDef(def.outputs ?? []) } : { inputs: [], outputs: [] });

  /** Signal-flow label (mock `.flow` "▶ ch1"): the module's lane membership. */
  let flowLabel = $derived.by(() => {
    const d = node.data as { channel?: number; sendSlot?: number } | undefined;
    if (d?.channel != null) return `▶ ch${d.channel}`;
    if (d?.sendSlot != null) return `▶ s${d.sendSlot}`;
    return '▶ out';
  });

  /** TRUE while THIS module occupies a dock full-view pane — the rail pill
   *  flips to "✕ CLOSE" (reactive on dockStore.fullViewNodeIds; per-module
   *  presence in the side-by-side split). */
  let isExpanded = $derived(dockStore.isFullView(id));

  /** EXPAND ↔ CLOSE toggle: open this module's dock full-view pane; when it
   *  already occupies one, close JUST that pane. */
  function expand(): void {
    if (dockStore.isFullView(id)) dockStore.closeFullView(id);
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
        {@const cellKind = paramCellKind(pd, momentary, view === 'dock-full' ? 'dock' : 'lane', gridCells)}
        {#if cellKind === 'momentary'}
          <!-- MOMENTARY press-pad (declared on face.momentary): fires on the
               press edge and RETURNS TO REST on release. It must never be a
               rotary — dragging a latching knob to 1 held the pad down, masked
               the module's own TRIG jack and persisted the stuck value. -->
          <div class="kcol ms-cell-act" data-cell-kind="param" data-cell-control="momentary" data-cell-key={ctl.key}>
            <Button
              label={pd.label}
              momentary
              variant={view === 'dock-full' ? 'accent' : 'sm'}
              title={`${pd.label}: hold to fire (the press edge is the hit)`}
              onGate={(high) => firePressParam(pd, high)}
              moduleId={id}
              paramId={pd.id}
            />
          </div>
        {:else if cellKind === 'toggle'}
          <!-- LATCHING 0/1 SWITCH → the shared <Toggle> `.switch`, the same
               primitive the legacy card paints for it. As a KnobConic it read
               "0.00" and needed a full-arc drag to change one of two states.
               Toggle emits role="switch" + `control-<paramId>`, so the param
               multiset + MIDI-learn are unchanged; only the primitive moves. -->
          <div class="kcol ms-cell-act" data-cell-kind="param" data-cell-control="toggle" data-cell-key={ctl.key}>
            <Toggle
              value={params.paramVal(pd.id)}
              label={pd.label}
              onchange={params.set(pd.id)}
              readLive={params.live(pd.id)}
              moduleId={id}
              paramId={pd.id}
            />
          </div>
        {:else if cellKind === 'segmented'}
          <!-- NAMED DISCRETE STATES at the DOCK (PF-1 `ParamDef.options`, ≤6):
               the inline `.seg` button row. The states a module HAS are the
               thing a faceplate should say out loud — the legacy cards said it
               with hardcoded markup the migrated shell could not see, so a
               filter's LP/HP/BP arrived here as a rotary printing "0.00".
               Segmented emits `control-<paramId>` on its radiogroup and is
               MIDI-assignable, so the param multiset + MIDI-learn are
               unchanged; only the primitive moves. `snapActive` because a
               PARAM always has a value (see the prop's note). -->
          <div class="kcol ms-cell-sel" data-cell-kind="param" data-cell-control="segmented" data-cell-key={ctl.key}>
            <Segmented
              value={params.paramVal(pd.id)}
              segments={pd.options ?? []}
              label={pd.label}
              onchange={(v) => params.set(pd.id)(Number(v))}
              readLive={params.live(pd.id)}
              moduleId={id}
              paramId={pd.id}
              snapActive
            />
          </div>
        {:else if cellKind === 'grid'}
          <!-- DECLARED PICTURE-STATES (PF-15 `face.paramCells`): a chip plus a
               PORTALED, viewport-clamped grid popover. The one param primitive
               that is TIER-INDEPENDENT — the grid does not live in this cell's
               column, so a 32-cell diagram chart is as reachable from a 46px
               lane knob column as from the dock faceplate. The CHIP carries
               `control-<paramId>` (the portaled grid is outside the dock shell,
               so a testid there would drop the param out of faces-parity's
               multiset and read as a LOST control). -->
          <div class="kcol ms-cell-sel" data-cell-kind="param" data-cell-control="grid" data-cell-key={ctl.key}>
            <ParamGrid
              value={params.paramVal(pd.id)}
              min={pd.min}
              max={pd.max}
              options={pd.options}
              label={pd.label}
              format={pd.format}
              onchange={params.set(pd.id)}
              readLive={params.live(pd.id)}
              moduleId={id}
              paramId={pd.id}
              hero={view === 'dock-full'}
              compact={view !== 'dock-full'}
              cell={binding.kind === 'algorithm' && pd.id === binding.paramId
                ? algorithmCell
                : undefined}
            />
          </div>
        {:else if cellKind === 'selector'}
          <!-- The SAME roster past the button-row budget (≥7 states): a
               portaled, viewport-clamped dropdown. Selector derives
               `control-<paramId>` itself when no explicit testid is given. -->
          <div class="kcol ms-cell-sel" data-cell-kind="param" data-cell-control="selector" data-cell-key={ctl.key}>
            <Selector
              value={params.paramVal(pd.id)}
              options={pd.options ?? []}
              label={pd.label}
              onchange={(v) => params.set(pd.id)(Number(v))}
              readLive={params.live(pd.id)}
              moduleId={id}
              paramId={pd.id}
              hero={view === 'dock-full'}
            />
          </div>
        {:else}
          <div class="kcol" data-cell-kind="param" data-cell-control="knob" data-cell-key={ctl.key}>
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
              options={pd.options}
              landmarks={pd.landmarks}
              format={pd.format}
            />
          </div>
        {/if}
      {/if}
    {:else}
      <!-- FAMILY / STATIC cell — a REAL control from the shared primitive
           library, driven by the module's declarative spec (shell-cells.ts) so
           it runs the SAME action/state the legacy card runs. -->
      {@const cell = shellCellFor(node.type, ctl)}
      {#if cell?.kind === 'selector'}
        <div class="kcol ms-cell-sel" data-cell-kind={ctl.kind} data-cell-control="selector" data-cell-key={ctl.key}>
          <Selector
            value={cell.value(liveCell.n)}
            options={cell.options(liveCell.n)}
            onchange={(v) => cell.onchange(id, String(v))}
            label={view === 'dock-full' ? cell.tag : ctl.label}
            compact={view !== 'dock-full'}
            hero={view === 'dock-full'}
            testid={cellTestId(ctl)}
          />
          {#if view === 'dock-full'}<span class="cell-cap">{ctl.label}</span>{/if}
        </div>
      {:else if cell?.kind === 'toggle'}
        <div class="kcol ms-cell-act" data-cell-kind={ctl.kind} data-cell-control="toggle" data-cell-key={ctl.key}>
          <Toggle
            value={cell.value(liveCell.n) ? 1 : 0}
            label={cell.label}
            onchange={(v) => cell.onchange(id, v >= 0.5)}
            testid={cellTestId(ctl)}
          />
        </div>
      {:else if cell?.kind === 'action'}
        <div class="kcol ms-cell-act" data-cell-kind={ctl.kind} data-cell-control="action" data-cell-key={ctl.key}>
          <Button
            label={view === 'dock-full' ? cell.label : '▸'}
            title={cell.title ?? cell.label}
            variant={view === 'dock-full' ? 'default' : 'sm'}
            onTrigger={() => cell.onFire(id)}
            testid={cellTestId(ctl)}
          />
        </div>
      {:else if cell?.kind === 'file'}
        <div class="kcol ms-cell-act" data-cell-kind={ctl.kind} data-cell-control="file" data-cell-key={ctl.key}>
          <label class="file-btn" title={cell.title ?? cell.label}>
            <input
              type="file"
              accept={cell.accept}
              data-testid={cellTestId(ctl)}
              onchange={(e) => onCellFile(ctl.key, cell.onFile, e)}
            />
            <span>{view === 'dock-full' ? cell.label : '⇩'}</span>
          </label>
          {#if view === 'dock-full' && cellStatus[ctl.key]}
            <span
              class="cell-cap"
              class:err={!!cellStatus[ctl.key]?.error}
              data-testid={`${cellTestId(ctl)}-status`}
            >{cellStatus[ctl.key]?.error ?? cellStatus[ctl.key]?.status}</span>
          {/if}
        </div>
      {:else if cell?.kind === 'panel'}
        <!-- BESPOKE PANEL (PF-14): the module's own component — a live SVG
             map, a draggable envelope editor — for a control that is not one
             of the shared primitives. It edits `node.data`, so it emits NO
             `control-<paramId>` testid (that would read as an unbacked extra
             control and fail faces-parity's exact param multiset), and it
             declares an operability PROBE instead of relying on a natural
             interaction the sweep could guess.
             DOCK-ONLY, held by a face-lint rule rather than by this render:
             a 280px panel selected into a 46px lane knob column is an
             authoring bug, and the lint says so by name. -->
        {@const Panel = cell.component}
        <div
          class="kcol ms-cell-panel"
          data-cell-kind={ctl.kind}
          data-cell-control="panel"
          data-cell-key={ctl.key}
          style={`--panel-min-w:${cell.minWidth}px`}
        >
          <Panel nodeId={id} />
          {#if view === 'dock-full'}<span class="cell-cap">{cell.label}</span>{/if}
        </div>
      {:else}
        <!-- NO registered cell spec → an explicitly INERT cell. Both gates
             (module-face-lint's shell-cell coverage + the faces-parity e2e)
             FAIL on `data-cell-inert`, so this is a loud placeholder for a
             missing hook, never a shippable render. -->
        <div
          class="kcol ms-cell-other"
          data-cell-kind={ctl.kind}
          data-cell-control="inert"
          data-cell-inert="true"
          data-cell-key={ctl.key}
        >
          <span class="lab">{ctl.label}</span>
        </div>
      {/if}
    {/if}
  {/snippet}

  <!-- The glyph sizes to its CELL (fluid width — never a fixed canvas clipped
       by a shrinking host) and strokes in the module's DOMAIN hue (the spine
       cable colour). LIVE per the resolved binding: an analyser trace / RMS
       meter off the module's primary audio output, or a param-reactive
       envelope / wave-morph curve; static traces only as the last-resort
       fallback for a face with no live seam. -->
  {#snippet glyphCell()}
    <div
      class="tile-glyph"
      data-glyph-kind={videoThumb ? 'video' : glyphKind}
      data-glyph-binding={binding.kind}
    >
      {#if videoThumb}
        <!-- LIVE video thumbnail — the legacy preview seam (visibility-gated,
             thumb-res; see VideoTileThumb). -->
        <VideoTileThumb nodeId={id} />
      {:else if glyphKind === 'meter'}
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
      {:else if binding.kind === 'dual'}
        <!-- DUAL DISPLAY (owner spec): the param-derived STATIC core waveform
             (always visible — no gate needed) + the LIVE output trace side by
             side where both fit whole (dock hero / plate strip); a lane row
             shows the morph alone (the identity). Both live-update: the morph
             re-derives from the TRANSIENT param stream while a knob twists
             (ScopeScreen's polled wave mode), the trace off the analyser tap. -->
        <div class="dual-glyph" data-testid="shell-glyph-dual">
          <div class="dual-pane">
            <ScopeScreen
              mode="wave"
              getWaveform={liveWave ?? undefined}
              fluid
              height={view === 'dock-full' ? 64 : 40}
              color={spine}
              testid="shell-glyph-wave"
              ariaLabel="core waveform (from shape controls)"
            />
          </div>
          {#if dualShowsTrace}
            <div class="dual-pane">
              <ScopeScreen
                mode="waveform"
                getSamples={tap ? tap.getSamples : undefined}
                fluid
                height={view === 'dock-full' ? 64 : 40}
                color={spine}
                testid="shell-glyph"
                ariaLabel="live output trace"
              />
            </div>
          {/if}
        </div>
      {:else if binding.kind === 'algorithm'}
        <!-- TOPOLOGY glyph (PF-15): DATA-DERIVED, so it is always live — an FM
             synth's 64px scope trace looks the same for every patch and
             flatlines whenever nothing is gated, which is most of the time you
             are looking at a rack. PR 4 (here) fills the body with the derived
             routing diagram; the binding, the slot and this DOM contract are
             what PR 2 pinned for it.
             The DIAGRAM is the glyph and the number is its caption — an FM
             patch is identified by its shape long before anyone reads "ALG 5",
             and the shape is the only part that says which operators are
             carriers. Both render: the caption stays the accessible, greppable
             value, and it is what a motorized/CV-driven sweep visibly tracks.
             ⚠ NOT A GENERAL PRECEDENT — see GlyphBinding's 'algorithm' note. -->
        <div class="topo-glyph" data-testid="shell-glyph-topology" data-topology-param={binding.paramId}>
          <!-- SAME height contract as every other glyph in this slot (see the
               ScopeScreen branches: dock 64 / lane 40). Without an explicit
               height the SVG's `height: 100%` resolves against a `1fr` row and
               the plate grows to ~180px, swallowing the faceplate. -->
          <div
            class="topo-diagram"
            style:color={spine}
            style:height="{view === 'dock-full' ? 64 : 40}px"
          >
            <Dx7AlgorithmGlyph num={topologyValue} testid="shell-glyph-algorithm" />
          </div>
          <span class="topo-val">{topologyLabel}</span>
        </div>
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
          getWaveform={liveWave ?? undefined}
          waveform={liveWave ? undefined : glyphKind === 'waveform' ? SINE_TRACE : BURST_TRACE}
          fluid
          height={view === 'dock-full' ? 64 : 40}
          color={spine}
          testid="shell-glyph"
        />
      {/if}
    </div>
  {/snippet}

  {#if dockBands}
    <!-- DOCK FACEPLATE (view='dock-full'): the glyph is the hero band, then
         the dockFacePlan SECTION BANDS — one labeled band per curated page +
         the '__unpaged' tail for any ranked-but-unpaged controls (dock = all;
         a page-less face renders one unlabeled '__all' band). The hero glyph
         is CAPPED to the first four knob columns of the control grid (owner
         feedback), left-aligned with blank space right; a video face's
         thumbnail rides the same capped hero band. -->
    {#if hasGlyph}
      <div class="tile-body dock-hero" style={`--dock-hero-glyph-w:${DOCK_HERO_GLYPH_W}px`}>
        {@render glyphCell()}
      </div>
    {/if}
    <div class="dock-pages" data-testid="face-pages">
      {#each dockBands as band (band.id)}
        <section class="dock-page" data-testid="face-page" data-face-page={band.id}>
          {#if band.label}
            <h4 class="page-label">{band.label}</h4>
          {/if}
          {#if band.controls.length}
            <div class="page-controls">
              {#each band.controls as ctl (ctl.key)}
                {@render controlCell(ctl)}
              {/each}
            </div>
          {/if}
          <!-- CLUSTER SUB-HEADERS (ModuleFacePage.clusters — the front-side
               mirror of the rear card's): two same-idea groups inside ONE band
               (a filter EG beside an amp EG) for a ~14px caption instead of the
               ~81px a second page band costs. Membership still lives in
               page.controls; curated-face just pulls these cells aside. -->
          {#each band.clusters as cluster (cluster.label)}
            <div class="page-cluster" data-testid="face-cluster" data-face-cluster={cluster.label}>
              <h5 class="cluster-label">{cluster.label}</h5>
              <div class="page-controls">
                {#each cluster.controls as ctl (ctl.key)}
                  {@render controlCell(ctl)}
                {/each}
              </div>
            </div>
          {/each}
        </section>
      {/each}
    </div>
  {:else}
    <!-- The lane body, FIT-PLANNED (laneBodyPlan — the no-clip guarantee):
         either the mock .body row (whole knob columns LEFT + the fluid glyph
         filling RIGHT; a lone glyph centres) or, at the full tier when the
         face outgrows the row, the mock full-'plate' 3-col grid — WHOLE cells
         only, anything that can't fit entirely is not rendered in-lane (the
         dock faceplate has everything). -->
    {@const cells = lanePlan ? controls.slice(0, lanePlan.cellCount) : controls}
    {@const showGlyph = hasGlyph && (lanePlan ? lanePlan.glyph : true)}
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
       drill-down; the "⤢" more-affordance opens the dock full-view.
       LANE ONLY. The dock full-view has its OWN, better patch surface — the
       RearCard jack field on the TAB flip (DockFullView.svelte) — so down here
       the rail was a duplicate: a second, dot-only patch affordance with its
       EXPAND button already suppressed (onExpand is undefined at view
       'dock-full'), eating ~23px off the faceplate's fold budget and printing a
       "▶ out" flow label the title bar already says. -->
  {#if view === 'lane'}
    <PatchPanel
      nodeId={id}
      inputs={ports.inputs}
      outputs={ports.outputs}
      variant="lane-rail"
      {flowLabel}
      onExpand={expand}
      expanded={isExpanded}
    />
  {/if}
</div>

<!-- The 32-entry algorithm picker's per-cell picture. ParamGrid exists because
     this roster's entries ARE diagrams — rendering them as the numbers 1..32
     would make the grid a worse Selector. Operator numbers are suppressed at
     this size: a cell is ~26px, so the digits would be sub-2px mush.
     Only reachable when the shell already resolved an 'algorithm' binding. -->
{#snippet algorithmCell(c: { value: number; label: string; selected: boolean })}
  <span class="grid-alg" class:selected={c.selected}>
    <Dx7AlgorithmGlyph num={c.value} numbers={false} />
    <span class="grid-alg-num">{c.label}</span>
  </span>
{/snippet}

<style>
  /* INERT family/static cell — a family/static face key with NO registered
     shell-cell spec (shell-cells.ts). It is a LOUD FAILURE MARKER, not a
     render: `data-cell-inert` fails module-face-lint's coverage gate and the
     faces-parity e2e, so this dashed box only ever appears mid-development. */
  .ms-cell-other {
    min-width: 44px;
    min-height: 40px;
    padding: 4px 6px;
    justify-content: center;
    border: 1px dashed var(--border, #2c3037);
    border-radius: 4px;
  }

  /* BESPOKE PANEL cell (PF-14). It carries its OWN design floor (`minWidth` on
     the spec → `--panel-min-w`) rather than the shared knob-column width: a
     panel is a picture you edit, not a control column.
     It never negotiates with the lane's 46px cap, for two independent reasons —
     the cap is scoped to `.rl-tile .tile-body .kcol` (the LANE body; a dock band
     is `.page-controls`), AND the face-lint rule keeps a panel from ever being
     SELECTED at a lane tier. `max-width` still yields to the band so a 560px
     panel wraps inside the faceplate instead of overflowing it. */
  .ms-cell-panel {
    min-width: var(--panel-min-w, 240px);
    max-width: 100%;
    align-items: stretch;
    gap: 4px;
  }

  /* TOPOLOGY glyph plate (PF-15) — a data-derived glyph, so it needs no canvas
     and no analyser. PR 4 filled the body with the routing diagram.
     The diagram takes the free space and the caption sits under it on its own
     row, so the plate keeps working at the 40px lane height (where the diagram
     is a few px tall and reads as a silhouette) and at the dock's 64px. */
  .topo-glyph {
    display: grid;
    grid-template-rows: 1fr auto;
    place-items: center;
    gap: 2px;
    padding: 3px 2px 2px;
    min-height: 40px;
    width: 100%;
    border: 1px solid var(--border, #2c3037);
    border-radius: 4px;
    background: var(--module-bg-deep, #0a0c0f);
  }
  .topo-diagram {
    display: block;
    width: 100%;
    min-height: 0; /* let the 1fr row actually shrink the SVG */
    height: 100%;
  }

  /* One algorithm-picker cell: the diagram takes the room, the number labels
     it. Colour flows to the SVG's `currentColor`, so selection re-tints the
     whole picture rather than just the caption. */
  .grid-alg {
    display: grid;
    grid-template-rows: 1fr auto;
    align-items: center;
    justify-items: center;
    gap: 1px;
    width: 100%;
    height: 100%;
    min-height: 26px;
    color: var(--text-dim, #8a9099);
  }
  .grid-alg.selected {
    color: var(--accent, #6cf);
  }
  .grid-alg-num {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 8px;
    line-height: 1;
    opacity: 0.85;
  }
  .topo-val {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 12px;
    letter-spacing: 0.06em;
    color: var(--domain, var(--accent));
  }

  /* SELECTOR + ACTION cells: the shared .kcol column, but sized to the control
     rather than to a knob. In the LANE both stay INSIDE the 46px --kcol-max
     cap (the no-clip rule — the chip ellipsizes and its dropdown is portaled);
     the dock faceplate lets them take their natural width. */
  .ms-cell-sel,
  .ms-cell-act {
    justify-content: center;
    min-width: 0;
  }
  .rl-tile.dock-full .ms-cell-sel,
  .rl-tile.dock-full .ms-cell-act {
    max-width: none;
    align-items: flex-start;
    gap: 4px;
  }

  /* The cell's own caption under a dock-tier selector/import (the DECLARED
     ControlFamily label — "Preset / voice selector", never the humanized id). */
  .cell-cap {
    font-size: 0.55rem;
    letter-spacing: 0.04em;
    color: var(--text-dim, #9aa3ad);
    max-width: 220px;
  }
  .cell-cap.err { color: #ff6b6b; }

  /* File-import cell: a real <input type="file"> inside a styled label, the
     same affordance the legacy card carries (so the picker, the accept filter
     and drag-drop all behave identically). */
  .file-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    background: var(--surface-2, #20262f);
    color: var(--text, #eef1f5);
    border: 1px solid var(--border-strong, #333b48);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    cursor: pointer;
    white-space: nowrap;
  }
  .file-btn:hover { border-color: var(--domain, var(--accent)); }
  .file-btn input[type='file'] { display: none; }
  .rl-tile:not(.dock-full) .file-btn { padding: 2px 4px; font-size: 10px; }

  /* DUAL glyph (param-wave + live trace, owner spec): the two screens split
     the glyph cell — the dock hero's 4-knob-column cap or the plate strip —
     side by side on the dock page-grid gap; each pane is fluid and floors at
     the 40px scope minimum (both always WHOLE — the no-clip rule). A lane row
     renders the morph pane alone, so it just fills the cell. */
  .dual-glyph {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-width: 0;
  }
  .dual-pane {
    flex: 1 1 0;
    min-width: 40px;
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

  /* CLUSTER inside a band (ModuleFacePage.clusters): a quieter, SMALLER
     caption than .page-label and NO top rule — the point of a cluster is that
     it costs a caption (~14px) rather than a whole band (~81px: rule + header +
     row + the .dock-pages gap). Two clusters in one band read as "the same
     idea, twice"; two bands read as "two different ideas". */
  .page-cluster + .page-cluster,
  .page-controls + .page-cluster {
    margin-top: 6px;
  }
  .cluster-label {
    margin: 0 0 3px;
    font-size: 0.55rem;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--text-dim, #9aa3ad);
    opacity: 0.8;
  }

  /* A TOGGLE cell in the LANE. The shared `.switch` is 52px wide but a lane
     knob column is capped at 46px (--kcol-max), so it scales to the column
     instead of clipping — the no-clip rule laneBodyPlan exists to guarantee.
     Every faced module ranks its switches dock-only today (kickdrum `hard` is
     rank 19, snaredrum's 22), so this paints nothing yet; it keeps the
     guarantee true the day a face promotes one into the lane. */
  .rl-tile:not(.dock-full) [data-cell-control='toggle'] :global(.switch) {
    width: 40px;
    height: 20px;
    padding: 2px;
  }
  .rl-tile:not(.dock-full) [data-cell-control='toggle'] :global(.thumb) {
    width: 14px;
    height: 14px;
  }
  .rl-tile:not(.dock-full) [data-cell-control='toggle'] :global(.switch.on .thumb) {
    margin-left: 20px;
  }
</style>
