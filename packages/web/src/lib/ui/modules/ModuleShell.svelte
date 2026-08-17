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
  import { Button, ColorField, Fader, KnobConic, NeonFader, ParamGrid, ScopeScreen, Segmented, Selector, Toggle, VuMeter, XyPad } from '$lib/ui/controls';
  import {
    curatedFace,
    dockFacePlan,
    type DockFaceBand,
    type FaceControl,
    type FaceTier,
  } from '$lib/ui/workflow/curated-face';
  import {
    bandHeaderPlan,
    facePageHeader,
    heroFacePlan,
    readoutText,
    type FaceplateDefLike,
  } from '$lib/ui/workflow/dock-faceplate-model';
  import { isAnnotating } from '$lib/ui/annotate-mode.svelte';
  import { shellCellFor, type ShellCellEnv } from '$lib/ui/workflow/shell-cells';
  import { shellParamWrite } from '$lib/ui/workflow/shell-param-writes';
  import { dockBandVisible, dockTabPlan } from '$lib/ui/workflow/dock-tabs-model';
  import { consoleGridCols } from '$lib/ui/workflow/console-grid';
  import { dockRowPlan, type RowPlanDefLike } from '$lib/ui/workflow/dock-row-plan';
  import {
    declaredParamCells,
    momentaryParamIds,
    momentaryValue,
    paramCellKind,
    xyPadsByAnchor,
    bareCaptionParamIds,
    type DeclaringDefLike,
  } from '$lib/ui/workflow/shell-control-kind';
  import type { MomentaryDefLike } from '$lib/audio/momentary-params';
  import { clearStuckMomentaryParams, setMomentaryParam } from './manual-strike-actions';
  import OssAttribution from '$lib/ui/modules/OssAttribution.svelte';
  import {
    spineCableVar,
    laneFaceTier,
    laneBodyPlan,
    dockFullViewHeadPlan,
    isFaceplateView,
    roleLineForDef,
    DOCK_HERO_GLYPH_W,
    PLATE_ROW_H,
    hasVideoSurface,
    type ShellDefLike,
    type ShellView,
  } from '$lib/ui/workflow/module-shell-model';
  import {
    glyphBinding,
    createShellGlyphTap,
    createLiveWaveSource,
    waveMorphGlyphAmp,
    type ShellGlyphTap,
  } from '$lib/ui/workflow/shell-glyph-live';
  import { loadShellExtension, type ShellExtension } from '$lib/ui/workflow/shell-extensions';
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
      /** Which SURFACE this shell is mounted on — 'lane' (default),
       *  'dock-full' (a DockFullView pane) or 'drawer' (a DockCardHost rail
       *  card, i.e. the pinned `m`/`e` tray). See `ShellView`; the drawer is
       *  the full faceplate PLUS the lane PatchPanel, because its host has no
       *  flip-to-RearCard of its own (#1739). */
      view?: ShellView;
      /** Test/dock override of the LOD tier; else the getLodTier() context. */
      tier?: Tier;
      /**
       * PF-16 — the ACTIVE dock tab (a `face.pages` page id), owned by the
       * faceplate that paints the rail (DockFullView). Ignored unless the face
       * is tabbed at all (`dockTabPlan`), and a stale id falls back to the
       * first tab rather than hiding every band.
       */
      activePage?: string;
    };
  }
  let { id, data }: Props = $props();

  let node = $derived(data.node);
  let view: ShellView = $derived(data.view ?? 'lane');

  /**
   * Is this the FULL FACEPLATE (every control, every page, dock cell sizes)?
   *
   * ⚠ THE ONE PLACE THE VIEW UNION IS COLLAPSED TO THAT QUESTION, and it is
   * `view !== 'lane'` — never `view === 'dock-full'` (#1739). Every band, tier,
   * hero and cell-size decision below is really asking "faceplate or tile?",
   * and BOTH dock hosts answer "faceplate". A re-typed `=== 'dock-full'` at any
   * of those ~30 sites is a silent default: the drawer would take the LANE
   * branch and paint six of mixmstrs' ninety-one controls. `module-face-lint`
   * anchors that to this file's source in both directions.
   */
  let faceplateView = $derived(isFaceplateView(view));

  /**
   * Does the JACK RAIL (`PatchPanel`, lane-rail variant) render?
   *
   * LANE **and** DRAWER, but not the full view — and the asymmetry is about
   * what the HOST provides, not about how big the face is. `DockFullView` owns
   * a better patch surface (the flip-to-`RearCard` jack field on its title
   * bar), so down there the rail was a duplicate. `DockCardHost` has no title
   * bar and no RearCard, so for a tray occupant this rail — and the
   * `.card-back-panel` PatchPanel puts in the tile, which the canvas-wide rear
   * view reveals — is the ONLY patch surface there is.
   */
  let jackRail = $derived(view !== 'dock-full');

  // LOD tier: the shared context store (falls back to the singleton when no
  // provider — e.g. a fixture/VRT mount), or an explicit override on `data`.
  const lodTierStore = getLodTier();
  let effTier: FaceTier = $derived(
    faceplateView ? 'dock' : laneFaceTier(data.tier ?? $lodTierStore),
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
  // `params` is a GETTER for the same reason `getId`/`getNode` are thunks:
  // cardParams is built ONCE at init but its closures run for the life of the
  // shell, and `def` is a prop that changes when the shell is re-used for a
  // different node. A plain `{ params: def?.params }` would pin defaultFor()
  // to the def this instance happened to mount with.
  const params = cardParams(
    {
      get params() {
        return (def?.params ?? []) as readonly ParamDef[];
      },
    },
    () => id,
    () => node,
  );

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

  // ── THE EXTENSION SEAM (#1512) — def-declared bespoke components ──
  // A def may declare `face.extension: '<id>'`; the registry resolves it to a
  // LAZILY-loaded slot map (glyph today — see WIRED_SHELL_EXTENSION_SLOTS).
  // This is the shell's ONLY route to module-specific components: no module
  // name appears in this file's imports, and module-shell-import-guard keeps
  // it that way. Until the chunk resolves the slot renders nothing (a
  // microtask + one chunk fetch on first mount, settled long before any
  // screenshot or interaction); an undeclared/unknown id stays null and the
  // generic shell is unchanged.
  let ext = $state<ShellExtension | null>(null);
  $effect(() => {
    const extId = (def as FaceplateDefLike | undefined)?.face?.extension;
    if (!extId) {
      ext = null;
      return;
    }
    let cancelled = false;
    void loadShellExtension(extId).then((resolved) => {
      if (!cancelled) ext = resolved;
    });
    return () => {
      cancelled = true;
    };
  });

  // VIDEO-domain module → the glyph slot shows a LIVE THUMBNAIL of its actual
  // output (the legacy preview seam via VideoTileThumb), never a static trace:
  // a migrated video face gets the same live picture the placeholder tiles do.
  let videoThumb = $derived(hasVideoSurface(def));
  let hasGlyph = $derived(glyphKind !== 'none' || videoThumb);

  // The LANE body plan — the no-clip guarantee (fixed 192×180 tile ⇒ fit is a
  // design-time constant): which layout (row/plate), how many WHOLE cells, and
  // whether the glyph fits. Lane views only — the dock faceplate wraps freely
  // and always shows everything.
  // `face.cellHeights` — the height of EVERY lane cell this face paints, in
  // rank order. Passed rather than assumed: the plate's grid tracks are FIXED,
  // so a cell taller than its track paints OVER the row below instead of being
  // clipped (marbles, 2026-08-11: 50.0 CSS px per column, three columns; the
  // earned-readout knob, 2026-08-12: 9.0 px on seven faces). A LIST rather than
  // a max, because only a cell with a row BENEATH it can collide — see
  // `plateRowTracks`.
  let lanePlan = $derived(
    view === 'lane' ? laneBodyPlan(face?.cellHeights ?? [], hasGlyph, effTier) : null,
  );

  // Whether the glyph cell RENDERS in the current view/tier — the dock hero
  // always shows it; the lane obeys the fit plan. Mirrors the render branches
  // below; the live tap's lifecycle is keyed to this (mount face → mount tap).
  let glyphShown = $derived(glyphKind !== 'none' && (faceplateView || (lanePlan?.glyph ?? true)));

  // DUAL glyph (owner spec — tidyVco): the param-derived STATIC CORE WAVEFORM
  // is the identity and renders EVERYWHERE the glyph fits; the live analyser
  // trace rides ALONGSIDE it only where BOTH panes fit WHOLE — the dock hero
  // band (split inside the 4-knob-column cap) and the full-in-lane plate's
  // full-width strip. A lane ROW cell shows just the morph (the compact tile
  // prefers the identity; two 40px-floor wells can't both fit next to the
  // knob columns — the no-clip rule).
  let dualShowsTrace = $derived(
    binding.kind === 'dual' && (faceplateView || lanePlan?.layout === 'plate'),
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
          // (`depthGain`, declared by the def's `face.glyphDepthGain`) rather
          // than re-typed here — the shell has no business knowing a particular
          // worklet's multiplier. The ±1 screen clamp is `waveMorphGlyphAmp`,
          // NOT an inline Math.min: the module-side `lfoGlyphAmp` resolves
          // through the SAME function, so the test that pins the saturation
          // (the whole DEPTH-outranks-SHAPE argument) pins what renders here.
          b.depthParamId ? waveMorphGlyphAmp(liveParam(b.depthParamId), b.depthGain) : 1,
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
  let allDockBands = $derived(faceplateView && def ? dockFacePlan(def) : null);

  // PF-20 — THE HERO SPLIT. `face.hero` PROMOTES a ranked key out of its band
  // into the hero rail; it never copies it (a duplicated key would emit a
  // second `control-<paramId>` and fail faces-parity's exact param multiset).
  // The move is arithmetic, so it lives in the pure model and its TOTALITY —
  // hero + bands === the plan that went in, exactly once each — is asserted on
  // every faced module by module-face-lint, not discovered in a browser.
  let heroSplit = $derived(heroFacePlan(def as FaceplateDefLike | undefined, allDockBands));
  let dockBands = $derived(allDockBands ? heroSplit.bands : null);
  let hero = $derived(heroSplit.hero);

  /**
   * ANNOTATIONS ON for this node? (owner, 2026-08-02: the section prose
   * "belongs as annotation text but not on the card unless annotation is
   * turned on".)
   *
   * ⚠ IT IS THE EXISTING PER-NODE ANNOTATE MODE, deliberately — not a second
   * switch. `annotate-mode.svelte.ts` already is a personal lens onto ONE
   * user's view of ONE module: a reactive `SvelteSet` of node ids, keyed by
   * nodeId, NOT in `node.data` and NOT in the Y.Doc, for the reason it states
   * and the dx7 operator-selection precedent repeats — a rack-mate turning it
   * on must not change what you see, and it is not worth a collab message.
   * Inventing a `faceAnnotations` singleton beside it would have shipped TWO
   * personal annotation switches for one concept, so the faceplate's authored
   * prose is simply more of what that one switch reveals (the on-card
   * AnnotateLayer hover popover is the other). `clearAnnotate` on node delete
   * already stops the set leaking an entry per spawned-and-deleted node.
   *
   * DOCK-ONLY, like every other `face` structure field: a 192×180 lane tile has
   * no room for a sentence, so annotating a node changes nothing in the lane.
   */
  let annotations = $derived(faceplateView && isAnnotating(id));

  /** PF-20 — the faceplate's TITLE + HINT rows, and BOTH are annotation prose
   *  (owner, 2026-08-02): at rest the faceplate carries NO section title and no
   *  description — the module's name is the dock TITLE BAR's job and it is
   *  untouched. `null` for a face that declares neither, and `null` for every
   *  face while annotations are off, so the resting card is clean. */
  let pageHeader = $derived(
    faceplateView ? facePageHeader(def as FaceplateDefLike | undefined, annotations) : null,
  );

  /**
   * PF-20 — does the DOCK hero band paint the shell's `glyph`?
   *
   * ⚠ NOT when the face brought its own picture. The glyph is a LIVE trace of
   * the output; a `hero.cell` is a picture of the PATCH. Both together is what
   * the owner rejected: the kick's `scope` glyph flatlines with no audio, so a
   * faceplate opened on a silent rack painted an EMPTY BLACK RECTANGLE in the
   * exact place the mock puts the envelope graph — beside the graph itself.
   * The glyph is untouched at every other tier (the compact lane tile genuinely
   * wants a live trace, and that is the only place it has room to be one), so
   * this suppresses nothing a lane baseline can see.
   *
   * #1726 — the extension's `fullViewBody` claims the head the same way and for
   * the same reason: a module that mounts its own full-width surface does not
   * also want the shell's four-column thumbnail of the identical picture. The
   * precedence lives in `dockFullViewHeadPlan` (pure, unit-tested both ways);
   * with no extension body it returns EXACTLY the expression above.
   */
  let headPlan = $derived(
    dockFullViewHeadPlan({
      view,
      hasGlyph,
      heroCell: !!hero?.cell,
      hasExtensionBody: !!ext?.fullViewBody,
    }),
  );
  let heroGlyph = $derived(headPlan.heroGlyph);
  /** The resolved bespoke body component, or null. Read through the plan so
   *  the "dock only" half of the policy cannot be forgotten at the call site. */
  let extBody = $derived(headPlan.extBody ? (ext?.fullViewBody ?? null) : null);

  /**
   * The value a hero/sidebar READOUT prints.
   *
   * ⚠ READS THE DURABLE PARAM, deliberately — the same call the topology
   * caption makes and for the same reason. `params.live` asks the ENGINE, and
   * an engine reader polled from MARKUP is not reactive: Svelte tracks the
   * signals read during render, and `readParam` is a plain function call, so
   * the readout would freeze at whatever the first render happened to see.
   * Worse, with no audio engine booted it hands back a construction-time shadow
   * that is a NUMBER, so the `??` fallback never fires and the panel prints a
   * value the patch abandoned. The durable param re-derives on `nodeVersion`,
   * which is what a local edit, a remote edit and MIDI-learn all bump.
   */
  function readoutValue(pid: string): number | undefined {
    void nodeVersion(id);
    return params.paramVal(pid);
  }

  /** PF-16 — the tab roster (null for a face that renders as one column), and
   *  the SAME pure answer DockFullView's rail computes. A rail without the
   *  matching hide (or a hide without the rail) is a blank faceplate.
   *
   *  ⚠ `view` GOES IN (#1739). The pinned tray's host paints NO rail, so a
   *  `'drawer'` face is never tabbed — the plan answers that, this file does not
   *  re-test it. Passing the view rather than `null`-ing the result here is what
   *  keeps ONE authority for "is this face tabbed". */
  let dockTabs = $derived(dockTabPlan(dockBands, view));

  /**
   * PF-21 — the ROW PLAN: which section bands share a horizontal row.
   *
   * ⚠ THE DOM IS UNCHANGED FOR AN UNPACKED FACE. A row holding ONE band renders
   * the `<section>` as a direct child of `.dock-pages`, exactly as it always
   * has — no wrapper element, no extra class. So every faceplate the rule does
   * not pack (a single-band face, a face of solo bands, and every TABBED face)
   * is byte-identical to before this landed, and its VRT baseline does not move.
   * Only a genuinely packed row gets the `.dock-row` flex wrapper.
   */
  let rowPlanDef: RowPlanDefLike = $derived({
    type: node.type,
    params: def?.params,
    face: (def as FaceplateDefLike | undefined)?.face,
  });
  let dockRows = $derived(dockRowPlan(dockBands, rowPlanDef));

  function paramDef(pid: string): ParamDef | undefined {
    return (def?.params ?? []).find((p) => p.id === pid);
  }

  /**
   * The durable commit for a param cell: the module's declared OVERRIDE
   * (PF-13 — a MACRO param whose write means more than its own key) or the
   * ordinary `setNodeParam`. Only the COMMIT is redirected — the primitive,
   * MIDI-learn, the motorized readback and the parity drive are untouched.
   */
  function paramWrite(pid: string): (v: number) => void {
    const override = shellParamWrite(node.type, pid);
    return override ? (v: number) => override(id, v) : params.set(pid);
  }

  /** What a family/static ACTION cell can reach beyond the graph. */
  function cellEnv(): ShellCellEnv {
    return { engine: params.engineCtx.get(), node: (patch.nodes[id] as ModuleNode | undefined) ?? node };
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

  /** Declared param cells (`'grid'` / `'color'`) — see ModuleFace.paramCells. */
  let declaredCells = $derived(declaredParamCells(def as DeclaringDefLike | undefined));
  /**
   * The params whose DOCK cell paints NO caption (`face.bareCells`).
   *
   * ⚠ `faceplateView &&` IS PART OF THE RULE, NOT AN OPTIMISATION. The
   * declaration means "a section heading already says this" (owner, 2026-08-17:
   * *"the low/mid/high labels above the knob rows convey that fine"*), and a
   * LANE TILE HAS NO SECTION HEADINGS — the cluster caption that makes `1LO`
   * redundant is a dock band header. Hiding it in the lane would remove the
   * label and leave nothing in its place, which is the opposite of the ruling.
   */
  let bareCaptions = $derived(
    faceplateView
      ? bareCaptionParamIds(def as { face?: { bareCells?: readonly string[] } } | undefined)
      : new Set<string>(),
  );
  /** The declared 2-D pads, keyed by their ANCHOR (x) param id. */
  let xyPads = $derived(xyPadsByAnchor(def as DeclaringDefLike | undefined));

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
   * Fire a MOMENTARY press-param: high on press, back to REST on release —
   * through the shared audition seam, which pushes the ENGINE and writes
   * NOTHING to the Y.Doc.
   *
   * ⚠ IT USED TO ALSO WRITE THE DURABLE PARAM, on the reasoning stated here
   * verbatim: *"Because the release always writes REST back, nothing latched
   * survives in the Y.Doc."* That is false whenever the release edge does not
   * arrive — this button unmounts mid-hold when the dock closes, the module is
   * deleted or the tab is hidden, and pointer capture protects a MOVING
   * pointer, not a DELETED element. The pressed value then persisted, synced
   * and survived reload; on tomtom it masked `trigger_in` permanently, because
   * the worklet ORs pad and jack as LEVELS. `setMomentaryParam` registers the
   * pad with the same window-level panic listeners the held-gate audition
   * already uses, so a release this button never sees still reaches the
   * engine. See $lib/audio/momentary-params for the whole argument.
   */
  function firePressParam(pd: ParamDef, high: boolean): void {
    // The pad's own lit state is <Button>'s internal `pressed` — local to this
    // surface, which is what a finger is. `momentaryValue(false, …)` names the
    // REST value through the same helper the render side uses.
    setMomentaryParam(id, pd.id, high, momentaryValue(false, pd.defaultValue));
  }

  // Repair a rack saved with a pad stuck down. `AudioEngine.addNode` already
  // refuses to apply such a value; this clears the dead number from the
  // document, under an untracked origin so it is not an undo entry.
  $effect(() => {
    if (def) clearStuckMomentaryParams(id, def as MomentaryDefLike);
  });

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

<!-- `dock-full` is the FACEPLATE-LAYOUT class, and it is now stamped on BOTH
     dock surfaces (#1739) — its CSS is about "this is the full faceplate, not a
     192×180 tile", which is equally true in the pinned tray. `data-shell-view`
     is what distinguishes the two HOSTS, for the gates and for any rule that
     genuinely needs one and not the other. -->
<div
  class="module-shell rl-tile"
  class:dock-full={faceplateView}
  data-testid="module-shell"
  data-shell-node={id}
  data-shell-type={node.type}
  data-shell-tier={effTier}
  data-shell-view={view}
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

  {#snippet controlCell(ctl: FaceControl, knobSize: 'sm' | 'md' | 'lg' | 'xl' = 'md')}
    {#if ctl.kind === 'param'}
      {@const pd = paramDef(ctl.paramId ?? ctl.key)}
      {#if pd}
        {@const cellKind = paramCellKind(pd, momentary, faceplateView ? 'dock' : 'lane', declaredCells)}
        {#if cellKind === 'momentary'}
          <!-- MOMENTARY press-pad (declared on face.momentary): fires on the
               press edge and RETURNS TO REST on release. It must never be a
               rotary — dragging a latching knob to 1 held the pad down, masked
               the module's own TRIG jack and persisted the stuck value. -->
          <div class="kcol ms-cell-act" data-cell-kind="param" data-cell-control="momentary" data-cell-key={ctl.key}>
            <Button
              label={pd.label}
              momentary
              variant={faceplateView ? 'accent' : 'sm'}
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
              onchange={paramWrite(pd.id)}
              readLive={params.live(pd.id)}
              moduleId={id}
              paramId={pd.id}
              hideCaption={bareCaptions.has(pd.id)}
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
              onchange={(v) => paramWrite(pd.id)(Number(v))}
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
              onchange={paramWrite(pd.id)}
              readLive={params.live(pd.id)}
              moduleId={id}
              paramId={pd.id}
              hero={faceplateView}
              compact={!faceplateView}
              cell={binding.kind === 'algorithm' && pd.id === binding.paramId && ext?.glyph
                ? algorithmCell
                : undefined}
            />
          </div>
        {:else if cellKind === 'color'}
          <!-- DECLARED PACKED-RGB (`face.paramCells['x'] = 'color'`): a native
               colour swatch. Without this branch a `0..16777215 discrete`
               param resolves to a KnobConic — a dial over 16.7 MILLION states
               printing `4292546867`, whose every drag step lands on an
               unpredictable hue — and faces-parity PASSES it, because dragging
               that knob does move the param. A green gate over an unusable
               control.

               The RANGE comes from the DEF (`pd.min`/`pd.max`), never re-typed
               in the primitive: ColorField clamps to what it is handed, and
               module-face-lint separately asserts the def's span IS the packed
               space, so the two cannot drift. TIER-INDEPENDENT like `grid` —
               a 40 px swatch fits a lane knob column, and the knob it replaces
               is exactly as wrong there as at the dock. -->
          <div class="kcol ms-cell-color" data-cell-kind="param" data-cell-control="color" data-cell-key={ctl.key}>
            <ColorField
              value={params.paramVal(pd.id)}
              min={pd.min}
              max={pd.max}
              label={pd.label}
              onchange={paramWrite(pd.id)}
              paramId={pd.id}
              hero={faceplateView}
              compact={!faceplateView}
            />
          </div>
        {:else if cellKind === 'xy' && xyPads.get(pd.id) && paramDef(xyPads.get(pd.id)!.y)}
          <!-- A DECLARED 2-D PAD (face.xyPads) — ONE cell over TWO params.
               The kind exists because two dials can reach every value the pad
               can and cannot reach them TOGETHER: a camera tilt is one gesture,
               and splitting it into two sequential drags is a lost CAPABILITY,
               not a lost look. That is what separates it from `fader` beside it.

               ⚠ BOTH RANGES COME FROM THE DEF, per axis, never re-typed here —
               and this control is the reason that rule exists at all.
               BackdraftCard passed literal `xMin={-1} xMax={1}` to two XyPads
               against a def declaring ±0.2 and ±0.5, so the pads WROTE VALUES
               THE CONTRACT FORBIDS, the model clamped them, and most of the
               stick's travel did nothing. Every def-reading gate was green.

               DOCK-ONLY: `laneOrder` withholds the anchor from every lane tier
               (the pad is square, a lane knob column is 46px), which since
               PF-22 costs it no rank — so a module whose pad IS its main
               control may rank it FIRST and still keep a legal face. -->
          {@const pad = xyPads.get(pd.id)!}
          {@const py = paramDef(pad.y)!}
          <div class="kcol ms-cell-xy" data-cell-kind="param" data-cell-control="xy" data-cell-key={ctl.key}>
            <XyPad
              xValue={params.paramVal(pd.id)}
              yValue={params.paramVal(py.id)}
              xMin={pd.min}
              xMax={pd.max}
              yMin={py.min}
              yMax={py.max}
              xDefault={pd.defaultValue}
              yDefault={py.defaultValue}
              xLabel={pd.label}
              yLabel={py.label}
              onXChange={paramWrite(pd.id)}
              onYChange={paramWrite(py.id)}
              title={pad.label ?? `${pd.label} / ${py.label}`}
              size={faceplateView ? 96 : 64}
              moduleId={id}
              xParamId={pd.id}
              yParamId={py.id}
            />
          </div>
        {:else if cellKind === 'fader'}
          <!-- A LEVEL the module says is a THROW, not a dial. Declared rather
               than sniffed: nothing in a ParamDef distinguishes a level from
               any other continuous scalar, so only the module knows. 1-D → 1-D,
               so no gesture is lost either way — but a card that draws a fader
               and a face that draws a knob are not the same control, and
               "preserve today's look" is the owner's constraint on the modules
               this exists for (noise, and clouds/mixer/vca behind it).
               `Fader.svelte` derives `control-<paramId>` itself, exactly like
               KnobConic, so the parity multiset is unchanged by the swap. -->
          <div class="kcol ms-cell-fader" data-cell-kind="param" data-cell-control="fader" data-cell-key={ctl.key}>
            <Fader
              value={params.paramVal(pd.id)}
              min={pd.min}
              max={pd.max}
              defaultValue={pd.defaultValue}
              label={pd.label}
              units={pd.units ?? ''}
              curve={pd.curve}
              onchange={paramWrite(pd.id)}
              readLive={params.live(pd.id)}
              moduleId={id}
              paramId={pd.id}
              formatValue={pd.format}
            />
          </div>
        {:else if cellKind === 'neon-fader'}
          <!-- THE SAME THROW, drawn in the conic knob's language (owner review
               of #1738: *"a new UI control for faders that matches our blue
               neon controls"*). A separate KIND rather than a prop on `fader`,
               because `Fader.svelte` is mounted by 93 cards and 8 other faced
               modules whose baselines must not move for one face's look — the
               module opts in, one declaration at a time.

               ⚠ NO RESTING READOUT — not here, not on the knob beside it, not
               on any face. The tier-bound `persistentReadout` this cell used to
               pass is DELETED, and deliberately not replaced by a hidden one
               (owner, 2026-08-17: *"i want the data gone, not there but hidden
               or something"*). The value reaches `aria-valuetext` and the
               drag/hover tag; nothing paints it at rest. -->
          <div class="kcol ms-cell-fader" data-cell-kind="param" data-cell-control="neon-fader" data-cell-key={ctl.key}>
            <NeonFader
              value={params.paramVal(pd.id)}
              min={pd.min}
              max={pd.max}
              defaultValue={pd.defaultValue}
              label={pd.label}
              units={pd.units ?? ''}
              curve={pd.curve}
              onchange={paramWrite(pd.id)}
              readLive={params.live(pd.id)}
              moduleId={id}
              paramId={pd.id}
              formatValue={pd.format}
              hideCaption={bareCaptions.has(pd.id)}
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
              onchange={(v) => paramWrite(pd.id)(Number(v))}
              readLive={params.live(pd.id)}
              moduleId={id}
              paramId={pd.id}
              hero={faceplateView}
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
              onchange={paramWrite(pd.id)}
              readLive={params.live(pd.id)}
              moduleId={id}
              paramId={pd.id}
              size={effTier === 'mini' ? 'lg' : knobSize}
              accent={spine}
              options={pd.options}
              landmarks={pd.landmarks}
              format={pd.format}
              hideCaption={bareCaptions.has(pd.id)}
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
            label={faceplateView ? cell.tag : ctl.label}
            compact={!faceplateView}
            hero={faceplateView}
            testid={cellTestId(ctl)}
          />
          {#if faceplateView}<span class="cell-cap">{ctl.label}</span>{/if}
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
        <!-- ACTION cell, in the two shapes the repo's port vocabulary already
             distinguishes (ShellActionCell): a one-shot TRIGGER (fires on the
             press edge, ignores the release) or a MOMENTARY GATE pad (high
             while held). The primitive is the same <Button> either way — it
             already carries `momentary` / `onGate` / `aria-pressed` for the
             face.momentary press-pad path — so a HELD audition needs a
             declaration, not a new control. Button dispatches exactly one of
             the two handlers per `momentary`, so passing both is safe. -->
        <div class="kcol ms-cell-act" data-cell-kind={ctl.kind} data-cell-control="action" data-cell-key={ctl.key}>
          <Button
            label={faceplateView ? cell.label : '▸'}
            title={cell.title ?? cell.label}
            variant={faceplateView ? 'default' : 'sm'}
            momentary={cell.mode === 'gate'}
            onTrigger={() => cell.onFire?.(id, cellEnv())}
            onGate={(high) => cell.onGate?.(id, high, cellEnv())}
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
            <span>{faceplateView ? cell.label : '⇩'}</span>
          </label>
          {#if faceplateView && cellStatus[ctl.key]}
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
          {#if faceplateView}<span class="cell-cap">{cell.label}</span>{/if}
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
          orientation={faceplateView ? 'horizontal' : 'vertical'}
          length={faceplateView ? DOCK_HERO_GLYPH_W : 84}
          thickness={faceplateView ? 16 : 12}
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
          height={faceplateView ? 64 : 40}
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
              height={faceplateView ? 64 : 40}
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
                height={faceplateView ? 64 : 40}
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
            style:height="{faceplateView ? 64 : 40}px"
          >
            <!-- The diagram component is the module's OWN, resolved through
                 the extension seam (`face.extension` → the `glyph` slot) —
                 same props as when it was a direct import, so the rendered
                 SVG is identical once the lazy chunk lands. -->
            {#if ext?.glyph}
              {@const TopologyGlyph = ext.glyph}
              <TopologyGlyph num={topologyValue} testid="shell-glyph-algorithm" />
            {/if}
          </div>
          <span class="topo-val">{topologyLabel}</span>
        </div>
      {:else if binding.kind === 'live-audio'}
        <ScopeScreen
          mode="waveform"
          getSamples={tap ? tap.getSamples : undefined}
          fluid
          height={faceplateView ? 64 : 40}
          color={spine}
          testid="shell-glyph"
        />
      {:else}
        <ScopeScreen
          mode="wave"
          getWaveform={liveWave ?? undefined}
          waveform={liveWave ? undefined : glyphKind === 'waveform' ? SINE_TRACE : BURST_TRACE}
          fluid
          height={faceplateView ? 64 : 40}
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
    <!-- PF-20 — the PAGE HEADER: a category word + a sentence that says what
         the instrument IS. ANNOTATION IN FULL (owner, 2026-08-02) — the title
         is NOT the module's name (the dock title bar paints that, always), it
         is a description of the page, so it is out of the DOM at rest along
         with the sentence. Only paints for a face that declares one, so the
         ~19 pre-PF-20 faceplates are byte-identical here in every state. -->
    {#if pageHeader}
      <div class="face-head" data-testid="face-head">
        {#if pageHeader.title}<h3 class="face-title">{pageHeader.title}</h3>{/if}
        {#if pageHeader.hint}<p class="face-hint">{pageHeader.hint}</p>{/if}
      </div>
    {/if}

    <!-- #1726 — THE EXTENSION'S FULL-VIEW BODY: the module's own full-width
         surface, at the head of the faceplate. The ONE render site for
         `ShellExtension.fullViewBody`; before this the slot was declared and
         inert, which is why the wired list is anchored to this file's source in
         BOTH directions (shell-extensions.test.ts) rather than described.

         It sits ABOVE the bands and BESIDE nothing: a video module's picture is
         the thing the player steers by, and it is also the only surface that
         can carry the output-opening affordances (Full Frame / Full Screen /
         Present), which no ParamCellKind can mount. The bands below are
         UNCHANGED — the face still owes a cell per param.

         `extBody` is already dock-gated by dockFullViewHeadPlan, so there is no
         second copy of that policy here; and while the lazy chunk is still in
         flight `ext` is null and the generic hero paints, exactly as it does
         for a def that declares no extension at all. -->
    {#if extBody}
      {@const ExtFullViewBody = extBody}
      <div class="dock-ext-body" data-testid="face-full-view-body">
        <ExtFullViewBody nodeId={id} />
      </div>
    {/if}

    <!-- PF-20 — the HERO RAIL: the module's own PICTURE + the promoted control
         beside it (a big dial with a big readout) and its audition, then the
         labelled readouts UNDER them as a full-width strip. Every piece is
         optional and the rail only renders when at least one is present — a
         face that declares no hero keeps the bare capped glyph band it has
         today.

         ⚠ THE READOUTS ARE A ROW BELOW THE STAGE, NOT A COLUMN BESIDE IT
         (owner, 2026-08-02: "generally this row of controls should be below
         the graphic"). They were the tail of `.hero-side`, so a face's derived
         values competed with its own picture for horizontal room and dropped
         to a second line at exactly the widths where the graph mattered most.
         Below, they get the full faceplate width — which is also the reading
         order the numbers want: the graphic states what the voice IS, the
         strip states what it MEASURES. -->
    {#if heroGlyph || hero}
      <div
        class="tile-body dock-hero"
        class:has-hero={!!hero}
        class:has-hero-cell={!!hero?.cell}
        style={`--dock-hero-glyph-w:${DOCK_HERO_GLYPH_W}px`}
      >
        {#if heroGlyph}{@render glyphCell()}{/if}
        {#if hero}
          <div class="hero-rail" data-testid="face-hero">
            {#if hero.cell || hero.control || hero.action}
              <!-- THE STAGE: the picture and the big control side by side. A
                   hero that is READOUTS ONLY (a bare measurement strip) skips
                   it entirely rather than painting an empty 0px flex row. -->
              <div class="hero-stage">
                {#if hero.cell}
                  <!-- THE MODULE'S OWN PICTURE, at the top of the faceplate
                       where the mock puts it. MOVED out of its band, not
                       copied — see heroFacePlan — so the cell multiset is
                       unchanged. -->
                  <div class="hero-vis">{@render controlCell(hero.cell)}</div>
                {/if}
                {#if hero.control || hero.action}
                  <div class="hero-side">
                    {#if hero.control}
                      <!-- The hero CONTROL is the same cell the band would have
                           rendered, at hero size, with a hero-size readout. -->
                      <div class="hero-ctl">{@render controlCell(hero.control, 'xl')}</div>
                    {/if}
                    {#if hero.action}
                      <div class="hero-ctl">{@render controlCell(hero.action)}</div>
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}
            {#if hero.readouts.length}
              <dl class="hero-readouts" data-testid="face-hero-readouts">
                {#each hero.readouts as r (r.label)}
                  <div class="hero-ro" data-hero-readout={r.paramId ?? r.valueId ?? r.label}>
                    <dt>{r.label}</dt>
                    <dd>{readoutText(r, (def?.params ?? []), readoutValue)}</dd>
                  </div>
                {/each}
              </dl>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
    <div class="dock-pages" data-testid="face-pages">
      <!-- PF-16 — a TABBED face hides its inactive bands with CSS; it NEVER
           unmounts them. faces-parity asserts one `control-<paramId>` per def
           param and one cell per curated control across the whole faceplate
           (`evaluateAll`, which matches hidden elements), so unmounting would
           make a tabbed face read as a face that LOST forty controls. Hiding
           also keeps knob/scroll state alive across a flip. -->
      <!-- PF-21 — THE ROW PLAN. A row of ONE band renders the `<section>` as a
           DIRECT child of `.dock-pages`, with no wrapper and no extra class —
           byte-identical to the layout every faceplate had before packing
           landed, which is what keeps an unpacked face's VRT baseline still. A
           row of TWO OR MORE gets the `.dock-row` flex wrapper, and each
           section keeps its own visible `.page-label`: the label is what makes
           two sections on one row legible rather than a jumble, and since the
           hints became annotation-only it is the ONLY thing naming a band at
           rest. -->
      {#each dockRows as row (row.id)}
        {#if row.bands.length > 1}
          <div class="dock-row" data-testid="face-row" data-face-row={row.id}>
            {#each row.bands as band (band.id)}{@render bandSection(band)}{/each}
          </div>
        {:else}
          {@render bandSection(row.bands[0])}
        {/if}
      {/each}
    </div>
    {#snippet bandSection(band: DockFaceBand)}
        <!-- THE BAND HEADER, as TWO independent questions (bandHeaderPlan).
             The LABEL answers "is there a tab rail already naming this band?";
             the HINT answers "are annotations on?" — and nothing else. Asking
             them together (the old `{#if band.label && !dockTabs}` with the
             hint nested inside) made the hint answer to the RAIL, so a tabbed
             face could not paint its prose in any state. See the model. -->
        {@const head = bandHeaderPlan(band, { tabbed: !!dockTabs, annotations })}
        <!-- THE CONSOLE GRID (owner review of #1738). When every cluster in this
             band holds the same number of cells, the band is a TABLE, not N
             independent flex rows — so it becomes ONE grid and each cluster a
             SUBGRID of it. Column j then has the same centre in every cluster by
             construction (measured Δ = 0.00 px), which is what "the level
             settings need to be above the rows of dials perfectly" asks for, and
             the band's width becomes its real content instead of the widest
             unwrapped flex packing, which is what "all the unused negative space
             on the side needs to go away" asks for. `null` for every other band
             in the roster, which keeps their layout byte-identical. -->
        {@const consoleCols = consoleGridCols(band)}
        <!-- On a TABBED face the band IS the tab's panel, so it says so: the
             rail's buttons carry `aria-controls={face-page-<id>}` and this
             carries the matching id + `aria-labelledby`. Without the pair a
             screen reader announced N tabs controlling nothing. On an untabbed
             face there is no tab to point at, so neither attribute is emitted
             (a dangling `aria-labelledby` is worse than none). -->
        <!-- CLUSTERS SIDE BY SIDE (`ModuleFacePage.clusterFlow: 'row'`, owner
             2026-08-17: *"return 1 and return 2 can sit next to each other,
             too, saving on vertical space and reducing unused horizontal
             space"*). Mutually exclusive with the console grid by construction
             — `consoleGridCols` returns null for a 'row' band — so the two
             layouts can never both apply to one section. -->
        <section
          class="dock-page"
          class:cluster-row={band.clusterFlow === 'row' && band.clusters.length > 1}
          class:console-band={consoleCols != null}
          style:--console-cols={consoleCols ?? undefined}
          data-testid="face-page"
          data-console-cols={consoleCols ?? undefined}
          data-face-page={band.id}
          id={dockTabs ? `face-page-${band.id}` : undefined}
          role={dockTabs ? 'tabpanel' : undefined}
          aria-labelledby={dockTabs ? `faceplate-tab-${band.id}` : undefined}
          hidden={!dockBandVisible(band.id, dockTabs, data.activePage)}
        >
          <!-- The LABEL is suppressed on a tabbed face: the active tab already
               names the band, in the same words, ~14px above it, and printing
               both spends the vertical space the rail exists to buy.

               THE BAND LABEL IS NOT ANNOTATION and stays at rest. It is a
               fieldset legend — the structural name of the group — and with the
               hints gone it is the ONLY thing that says what the row of knobs
               under it belongs to. (Flagged to the owner: if "no text on the
               module" is meant to reach the legends too, this is the line.)

               ⚠ THE HINT IS ANNOTATION and is NOT IN THE DOM at rest (owner,
               2026-08-02). `display:none` would have been the smaller diff and
               the wrong one: the VRT baseline would show a card the
               accessibility tree disagrees with, and a screen reader would read
               every band a sentence the sighted user was never shown. So the
               annotate switch controls the MARKUP, and the two surfaces cannot
               drift.

               With a rail up there is no `<h4>` to hang the hint inside, so it
               paints as its own quiet line ('page-hint-solo') — the tabbed
               face's prose has to land SOMEWHERE, and nowhere was the bug. -->
          {#if head.label}
            <h4 class="page-label">
              {head.label}{#if head.hint}<span class="page-hint">{head.hint}</span>{/if}
            </h4>
          {:else if head.hint}
            <p class="page-hint page-hint-solo">{head.hint}</p>
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
    {/snippet}
    <!-- PF-17 — the OSS ATTRIBUTION footer. A module whose DSP is a port of
         someone else's open-source work says so on its faceplate, and the
         legacy card always did (`CloudseedCard.svelte`); the migrated shell
         dropped the line on the floor. Licence attribution is not decoration,
         and the dock is the surface with the room for it. Dock-only: it is a
         credit, not a control, and a 192px lane tile has no space to spend. -->
    {#if def?.ossAttribution?.author}
      <OssAttribution author={def.ossAttribution.author} />
    {/if}
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
      data-plate-row-h={lanePlan?.layout === 'plate' ? lanePlan.rowTracks.join(' ') : undefined}
      style:grid-template-rows={lanePlan?.layout === 'plate'
        ? lanePlan.rowTracks.map((h) => `${h}px`).join(' ')
        : undefined}
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
       LANE and DRAWER, never the full view. The dock FULL VIEW has its OWN,
       better patch surface — the RearCard jack field on the flip key
       (DockFullView.svelte) — so down there the rail was a duplicate: a second,
       dot-only patch affordance with its EXPAND button already suppressed
       (onExpand is undefined at view 'dock-full'), eating ~23px off the
       faceplate's fold budget and printing a "▶ out" flow label the title bar
       already says.

       ⚠ THE PINNED DRAWER IS THE OPPOSITE CASE, and it is why `jackRail` is
       `view !== 'dock-full'` rather than `view === 'lane'` (#1739).
       `DockCardHost` has NO title bar, so it has no flip chip and no RearCard.
       This PatchPanel is therefore the tray's ONLY patch surface — both the
       front rail AND the `.card-back-panel` the canvas-wide rear view (Tab)
       reveals through `.rear-view .rl-tile:has(> .patch-panel-host >
       .card-back-panel)`. Drop it and the tray loses `masterL` and `ch1L`,
       which is the owner's ES-9 send/return rack.

       ⚠ NO `sections` HERE, AND IT IS A MEASURED DELTA (#1762). This mounts
       `groupingStrategy: 'auto'` (group by cable type), so a module whose ports
       are all one type drills into ONE list: mixmstrs' legacy card opened on
       `Ch1 (11) … Master (3)`, the face opens on `INPUT (101)`. Every port is
       still reachable (here and on the back panel), so nothing is lost but the
       grouping — and the fix is not `sections={…}` on a whim, because in
       sectioned mode PatchPanel derives the HANDLE STACK from the sections, so
       a section list that drops a port drops its cables. -->
  {#if jackRail}
    <!-- ⚠ NO EXPAND PILL IN THE DRAWER. `expand()` calls
         `dockStore.openFullView(id)`, and the store keeps the bottom drawer and
         the full view MUTUALLY EXCLUSIVE (pinned XOR full-view) — so the pill
         would CLOSE the tray the user is looking at and re-open the same face in
         a different host. That is a new interaction with new occupancy
         semantics, not parity, so the tray keeps the affordance set it shipped
         with and the pill stays a LANE affordance. -->
    <PatchPanel
      nodeId={id}
      inputs={ports.inputs}
      outputs={ports.outputs}
      variant="lane-rail"
      {flowLabel}
      onExpand={view === 'lane' ? expand : undefined}
      expanded={isExpanded}
    />
  {/if}
</div>

<!-- The 32-entry algorithm picker's per-cell picture. ParamGrid exists because
     this roster's entries ARE diagrams — rendering them as the numbers 1..32
     would make the grid a worse Selector. Operator numbers are suppressed at
     this size: a cell is ~26px, so the digits would be sub-2px mush.
     Only reachable when the shell already resolved an 'algorithm' binding AND
     the extension's glyph slot (the pass site guards on `ext?.glyph`, so a
     not-yet-loaded extension renders ParamGrid's default labelled cells for a
     frame instead of 32 empty boxes). -->
{#snippet algorithmCell(c: { value: number; label: string; selected: boolean })}
  <span class="grid-alg" class:selected={c.selected}>
    {#if ext?.glyph}
      {@const CellGlyph = ext.glyph}
      <CellGlyph num={c.value} numbers={false} />
    {/if}
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

  /* #1726 — the EXTENSION'S FULL-VIEW BODY. Unlike the hero glyph this is NOT
     capped to four knob columns: the whole point is that the module brought a
     surface rather than a thumbnail, so it gets the faceplate's full width on
     the same 10px grid edge as the bands under it. Height is the component's
     own business (a video surface sizes to its aspect); the shell only reserves
     the row and forbids it pushing the faceplate sideways. */
  .dock-ext-body {
    flex: 0 0 auto;
    width: 100%;
    min-width: 0;
    padding: 4px 10px 0;
    box-sizing: border-box;
    overflow-x: auto;
  }

  /* PF-20 — THE PAGE HEADER (mock `.page-title` + `.page-hint`). A faceplate
     that opens with a category word and one sentence reads as an instrument;
     one that opens with a knob reads as a settings dialog. */
  .face-head {
    padding: 10px 10px 0;
  }
  .face-title {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    color: var(--text, #eef1f5);
  }
  .face-hint {
    margin: 3px 0 0;
    font-size: 0.66rem;
    line-height: 1.45;
    letter-spacing: 0.02em;
    color: var(--text-dim, #9aa3ad);
    max-width: 62ch;
  }

  /* PF-20 — THE HERO RAIL: the glyph, then the promoted control + audition,
     then the readout strip. It WRAPS rather than compressing — a half-width
     split pane must drop the hero dial below the picture instead of squeezing
     a 64px dial. */
  .dock-hero.has-hero {
    /* ⚠ A COLUMN, NOT A WRAPPING ROW — and the RENDER is unchanged by this.
     *
     * `.hero-rail` below is `width: 100%`, so in a wrapping ROW it can never
     * share a line with the glyph: it always wrapped onto its own. The picture
     * has therefore always sat ABOVE the rail, which is what the comment above
     * asks for. But a wrapping row's MAX-CONTENT is the sum of its items, and
     * `.faceplate-body` is `width: max-content` — so the plate reserved
     * `glyph + gap + rail` of width for a side-by-side arrangement it never
     * drew, and then painted the difference as blank plate.
     *
     * MEASURED on the six faces this hit (owner ruling 2026-08-17, *"we do not
     * want useless gray horizontal space on cards, ever"*): destroy reserved
     * 670 px for 409 px of ink, wavetableVco 436 for 250, vca 348 for 247 —
     * every one of them a face with BOTH a hero glyph and a readout strip,
     * which is exactly the pair that made the sum large. As a column the
     * intrinsic width is the MAX of the two instead of their sum, which is what
     * the layout was already drawing.
     *
     * `align-items` flips axis with the direction, so it is restated: in a row
     * `flex-end` was the vertical baseline of a line box; in a column it would
     * right-align the picture. */
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
    padding-bottom: 6px;
  }
  /* With a promoted picture the rail is the full width of the editor, not a
     capped glyph band, so the row must not centre-shrink around it. */
  .dock-hero.has-hero-cell {
    align-items: stretch;
  }
  /* The rail is a COLUMN: the STAGE (picture | control · audition), then the
     readout strip beneath it (owner 2026-08-02 — see the markup note). The
     strip therefore spans the whole faceplate instead of queueing behind the
     graph for the leftover width. */
  .hero-rail {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    min-width: 0;
    width: 100%;
  }
  /* The stage is PICTURE | (control · audition). The picture takes the room it
     needs and the side column is intrinsically sized, which is what keeps a
     420px graph legible in a half-width split pane instead of both halves
     squeezing. */
  .hero-stage {
    display: flex;
    align-items: stretch;
    gap: 16px;
    flex-wrap: wrap;
    min-width: 0;
    width: 100%;
  }
  .hero-vis {
    flex: 1 1 380px;
    min-width: 0;
  }
  /* A promoted PANEL keeps its own design floor (`--panel-min-w`) but must not
     inherit the lane's 46px knob-column cap — `.dock-hero` IS a `.tile-body`,
     whose `.kcol` rule caps width. */
  .hero-vis :global(.kcol) {
    max-width: none;
    width: 100%;
  }
  .hero-side {
    display: flex;
    align-items: flex-end;
    gap: 16px;
    flex-wrap: wrap;
    min-width: 0;
  }
  /* The hero cell keeps its own natural width — the lane's 46px `--kcol-max`
     is scoped to `.tile-body .kcol` and `.dock-hero` IS a `.tile-body`, so
     without this the xl dial would be capped to a lane column. */
  .hero-ctl :global(.kcol) {
    max-width: none;
  }
  /* ⚠ THE HERO DIAL'S VALUE IS TYPESET AS A HERO VALUE. The dial is `xl`
     (64px), and the readout under it inherited the 9px `.readout` rule every
     46px lane dial uses — a big dial with a lane-sized caption, which is not
     "a big dial with a big readout" however the comment beside it read. The
     label stays small: it is a name, and the NUMBER is the thing being read. */
  .hero-ctl :global(.readout) {
    font-size: 17px;
    line-height: 1.05;
    letter-spacing: 0.01em;
  }
  .hero-ctl :global(.label) {
    font-size: 10px;
  }
  /* Labelled hero values. A <dl> because that is what a label→value list is;
     the visual is a row of caption-over-number pairs, at the same typographic
     weight as the hero dial's own readout.
     A FULL-WIDTH STRIP under the stage: it starts at the faceplate's left edge
     and gets the whole width, so a three-value strip reads as one line of
     instrumentation rather than as the overflow of the row above it. The
     hairline is the same 1px `--border` rule `.dock-page` uses to separate a
     band — this strip is the hero's own footer in that same vocabulary. */
  .hero-readouts {
    display: flex;
    align-items: flex-end;
    gap: 22px;
    margin: 0;
    width: 100%;
    min-width: 0;
    flex-wrap: wrap;
  }
  /* ⚠ THE HAIRLINE IS CONDITIONAL, and it has to be: a hero may be READOUTS
     ONLY (no picture, no promoted control — a bare measurement strip, which
     `heroFacePlan` explicitly supports and the batch-3 mocks propose). Then the
     strip IS the whole hero and a rule above it would separate it from the page
     header — i.e. draw a line under the title. The adjacent-sibling combinator
     says exactly what is meant: the hairline belongs BETWEEN the stage and the
     strip, so no stage means no hairline. */
  .hero-stage + .hero-readouts {
    padding-top: 8px;
    border-top: 1px solid var(--border, #2c3037);
  }
  .hero-ro {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .hero-ro dt {
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 9px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-dim, #9aa3ad);
  }
  .hero-ro dd {
    margin: 0;
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 17px;
    line-height: 1.05;
    font-weight: 700;
    letter-spacing: 0.01em;
    color: var(--domain, var(--accent));
    white-space: nowrap;
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
  /* PF-21 — TWO OR MORE SECTIONS ON ONE ROW (the owner's "make better use of
     horizontal space" direction). Only a PACKED row gets this element at all,
     so a faceplate the rule leaves alone has the DOM it always had.

     `flex-wrap: wrap` is load-bearing, not defensive. The row plan's ceiling is
     a CONTROL COUNT, not a width — so the browser is what decides whether the
     sections physically fit, and a pane too narrow for them degrades into the
     stacked column this faceplate has today instead of overflowing. That keeps
     the whole change safe at any pane width without a px constant anywhere in
     the model (see dock-row-plan.ts).

     `align-items: flex-start` rather than `stretch`: a 1-knob section beside a
     6-knob one must not grow a 90px empty box under its label. */
  .dock-row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 10px 18px;
  }
  .dock-row > .dock-page {
    flex: 0 1 auto;
    min-width: 0;
  }
  /* THE SECTION DIVIDER. Each section already carries its own top rule over its
     OWN width, which is what reads as "two groups" rather than one long row;
     the hairline between them is what stops the second section's knobs looking
     like a continuation of the first's. It rides the section AFTER the break so
     a row of one never paints one. */
  .dock-row > .dock-page + .dock-page {
    border-left: 1px solid var(--border, #2c3037);
    padding-left: 18px;
  }
  /* PF-16 — an INACTIVE tab's band. Explicit rather than relying on the UA's
     `[hidden] { display: none }`, because `.dock-pages` is a flex container
     and any `display:` on the child would beat it. Still MOUNTED (see the
     markup note) — hidden, not gone. */
  .dock-page[hidden] {
    display: none;
  }
  .page-label {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
    margin: 0 0 6px;
    font-size: 0.62rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-dim, #9aa3ad);
  }
  /* PF-20 — the band DESCRIPTION beside its label. Quieter and NOT uppercased:
     the label is a name, the hint is a sentence, and typesetting them alike
     would make the header read as one long shouted string. */
  .page-hint {
    font-size: 0.6rem;
    font-weight: 500;
    letter-spacing: 0.02em;
    text-transform: none;
    color: var(--text-dim, #9aa3ad);
    opacity: 0.75;
  }
  /* …and the same hint with NO label to sit beside it — a TABBED face, where
     the rail carries the name. It becomes its own block line and takes over the
     `.page-label` bottom margin, so the band's controls sit exactly where they
     do with a header above them. */
  .page-hint-solo {
    display: block;
    margin: 0 0 6px;
    max-width: 62ch;
    line-height: 1.45;
  }
  .page-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 8px 10px;
  }

  /* ── THE CONSOLE GRID (owner review of #1738) ──────────────────────────────
   *
   * A band whose clusters all hold the same number of cells is a TABLE. It
   * becomes ONE grid whose columns are `max-content` over the WHOLE band, and
   * each cluster is a SUBGRID of it — so a 22 px fader cell and a 41.7 px knob
   * cell land on the same centre instead of packing independently.
   *
   * ⚠ `max-content` COLUMNS, NOT A FIXED RULER. A fixed `--kcol-w` track would
   * align the columns and then CLIP any cell wider than it (a selector, an XY
   * pad, a panel), which is the no-clip rule `laneBodyPlan` exists to protect
   * in the lane. Sizing the track to the widest cell IN THE BAND keeps the
   * alignment exact AND cannot clip, at the cost of nothing: a band of narrow
   * cells gets narrow columns.
   *
   * ⚠ `width: max-content` on the band is the negative-space half. Before this
   * the band STRETCHED to the shell's max-content (783.1 px on mixmstrs) while
   * its cells occupied ~414 px; the surplus was blank. Now the band is its
   * content and the shell shrinks to the widest band.
   *
   * Two levels of `subgrid` (band → cluster → its `.page-controls`) — verified
   * supported and pixel-exact in this repo's Playwright chromium before it was
   * relied on. */
  /* ⚠ `display: grid` FROM A CLASS BEATS THE UA'S `[hidden] { display: none }`,
   * and that is not a theoretical hazard — it was measured. A TABBED face hides
   * its inactive bands with the `hidden` attribute (PF-16: hidden, never
   * unmounted, so faces-parity can still count their cells). Without this
   * clause, pentemelodica's `mix` band — a console grid, and its THIRD page —
   * kept painting 240 px wide underneath the active `filter` tab, while every
   * other hidden band measured 0. A rail whose hide does not hide is the exact
   * inverse of the blank-faceplate failure `dock-tabs-model` exists to prevent.
   * Restated here at higher specificity rather than relying on the UA sheet. */
  .dock-page.console-band[hidden] {
    display: none;
  }
  .dock-page.console-band {
    display: grid;
    grid-template-columns: repeat(var(--console-cols), max-content);
    justify-content: start;
    align-content: start;
    gap: 8px 10px;
    width: max-content;
    max-width: 100%;
  }
  /* Band-level children (the label, the un-clustered row, each cluster) span
     the whole ruler; only CELLS occupy single columns. */
  .dock-page.console-band > :global(*) {
    grid-column: 1 / -1;
  }
  .console-band :global(.page-cluster) {
    display: grid;
    grid-template-columns: subgrid;
  }
  .console-band :global(.page-cluster) > :global(*) {
    grid-column: 1 / -1;
  }
  .console-band :global(.page-controls) {
    display: grid;
    grid-template-columns: subgrid;
    gap: 8px 10px;
  }
  .console-band :global(.page-controls) > :global(*) {
    grid-column: auto;
    justify-self: center;
  }

  /* ── CLUSTERS SIDE BY SIDE (`clusterFlow: 'row'`) ──────────────────────────
   *
   * Two cluster groups that are PEERS, laid across instead of down. `wrap` is
   * the physics escape hatch the row plan relies on everywhere else: a pane too
   * narrow to hold both degrades to the stacked layout it had before rather
   * than overflowing the faceplate, so no width budget is written here.
   *
   * ⚠ `align-items: flex-start`. The two groups are not the same height — a
   * return strip's fader track is taller than the knobs beside it — and
   * stretching them would centre one group's caption against the other's
   * controls. `width: max-content` keeps the band its content, the same
   * negative-space rule `.console-band` states above; the `[hidden]` clause is
   * restated for the same UA-specificity reason it is there. */
  .dock-page.cluster-row[hidden] {
    display: none;
  }
  .dock-page.cluster-row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 8px 18px;
    width: max-content;
    max-width: 100%;
  }
  /* The band header and any un-clustered row still own a full line. */
  .dock-page.cluster-row > :global(.page-label),
  .dock-page.cluster-row > :global(.page-hint-solo),
  .dock-page.cluster-row > :global(.page-controls) {
    flex: 1 0 100%;
  }
  /* The stacked layout's 6px inter-cluster gutter is the flex `gap` here, so
     the margin rule below must not also apply. */
  .dock-page.cluster-row :global(.page-cluster) {
    margin-top: 0;
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
