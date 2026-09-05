<script lang="ts">
  // ToyboxConsole — THE TOYBOX CONSOLE, and the ONLY one.
  //
  // ⚠ ONE COMPONENT TREE, HOSTED. This file is the whole of TOYBOX's operable
  // surface: the screen, the layer band, the combine-graph editor, the CV rail
  // and the preset store. `./ToyboxConsoleBody.svelte` (the faceplate's
  // `fullViewBody`) is a THIN HOST around it — it owns no control, no mutator
  // call, and no frame of the preview pull.
  //
  // That is structural rather than tidy. TOYBOX is the deepest module in the
  // rack — a layer editor over six kinds, a 17-op EDITABLE node graph, six
  // routed modulation inputs with live scopes, and a preset store with
  // per-layer and per-node randomize locks — and a FORK of it would be two
  // consoles sharing one Y.Doc and drifting: every bug fixed on whichever
  // surface the reporter happened to be looking at. There is one console, so
  // there is one behaviour, and `toybox-face-model.test.ts` pins that both
  // hosts render THIS component and nothing else.
  //
  // `layout` is the ONLY difference between the two mounts, and it moves
  // ARRANGEMENT, never capability:
  //
  //   (A second arrangement — a three-column body with per-section collapses —
  //   was kept byte-identical through the extraction for the surface this
  //   module had before its face. Nothing mounts that host, so it is gone.)
  //   * 'face' — the owner-ruled dock layout (2026-08-28): *"i'd want to
  //     generally keep what we have while migrating to our new look&feel. and
  //     putting cv-mod, combine graph, preset controls on 3 tabs, all below a
  //     screen that turns on and off."* Screen → persistent LAYER band → a
  //     three-tab rail. The two section-collapse buttons ARE that rail here: a
  //     tab IS the collapse, restyled, so no affordance is lost.
  //
  // Every zone is a SNIPPET, so both arrangements render the SAME markup in a
  // different order. A zone cannot exist on one surface and not the other.
  //
  // Card layout:
  //   - LAYER selector: a row of LAYER_COUNT tabs (1-indexed labels, 0-indexed
  //     state). Picks which layer (node.data.layers[activeLayer]) every control
  //     below edits. A populated layer (kind !== 'off') shows a dot.
  //   - LAYER-KIND dropdown: shader/gen (content) vs OBJ (3D mesh) vs OFF.
  //   - CONTENT dropdown: pick a shader/gen from the bundled bank. Writing
  //     the selection mutates node.data.layers[activeLayer] (kind + contentId +
  //     resets params to the content's manifest defaults), which rides Y.Doc out
  //     to rack-mates and is read live by the factory.
  //   - One fader per declared float-uniform param of the selected content
  //     (the manifest is the single source of truth). Faders write to
  //     node.data.layers[activeLayer].params[<id>].
  //   - Live output preview (blitOutputToDrawingBuffer + drawImage from the
  //     video engine canvas — the MANDELBULB / ACIDWARP pattern).
  //
  // All per-layer mutations go through graph/toybox-layers.ts (Yjs in-place;
  // never spread-reassign a live Y type — repo standard).
  //
  // VRT: exposes window.__toyboxFreeze(time) which pins the engine-side
  // iTime to a constant (so the shader render is pixel-stable) AND pauses
  // the on-card preview pull so the captured canvas matches the frozen FBO.

  import { onMount, onDestroy } from 'svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch, undoManager } from '$lib/graph/store';
  import {
    downscaleAndEncode,
    TARGET_W as SYNC_IMG_W,
    TARGET_H as SYNC_IMG_H,
  } from '$lib/video/modules/picturebox-encode';
  import type { ToyboxHandleExtras } from '$lib/video/modules/toybox';
  import {
    DEFAULT_CONTENT_ID,
    DEFAULT_MODEL_ID,
    LAYER_COUNT,
    MATCAP_STYLES,
    MAX_CUSTOM_SOURCE_BYTES,
    utf8ByteLength,
    ensureToyboxCatalog,
    getContent,
    getModelMeta,
    getModelObj,
    listAllContent,
    listModels,
    listPresets,
    makeDefaultLayers,
    makeDefaultObjMaterial,
    type ToyboxContent,
    type ToyboxLayer,
    type ToyboxLayerKind,
    type ToyboxModel,
    type ToyboxObjMaterial,
    type ToyboxPreset,
    type ToyboxSurfaceMode,
    type ToyboxVideoSource,
  } from '$lib/video/toybox-content';
  import { resolveLayerContent } from '$lib/video/toybox-custom-assets';
  import type { VideoEngine, PreviewBlitOptions } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import {
    canvasToEnginePx,
    makeMouseState,
    mouseDown,
    mouseMove,
    mouseUp,
    mouseToVec4,
  } from '$lib/video/toybox-shadertoy';
  import type { ModuleNode } from '$lib/graph/types';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import {
    OP_KINDS,
    OP_PARAMS,
    inPortsFor,
    hasOutPort,
    isCombineGraph,
    makeDefaultCombineGraph,
    combineDisplayNames,
    edgesTouching,
    LAYER_INPUT_SOURCE,
    type ToyboxCombineGraph,
    type ToyboxGraphNode,
    type ToyboxInPort,
    type ToyboxNodeKind,
    type ToyboxOpKind,
  } from '$lib/video/toybox-combine-graph';
  import {
    addCombineNode,
    connectCombine,
    deleteCombineEdge,
    deleteCombineNode,
    setCombineNodeParam,
    setCombineNodePosition,
    setCombineViewSize,
    patchToOutput,
    clearCombineEdges,
    resetCombineToDefault,
    duplicateCombineNode,
    resetFeedbackNode,
    setCombineNodeLocked,
  } from '$lib/graph/toybox-combine';
  import { FEEDBACK_MODES } from '$lib/video/toybox-feedback';
  import ToyboxNodeMenu from '../ToyboxNodeMenu.svelte';
  import {
    CV_PORT_IDS,
    listCvTargets,
    listCvParams,
    encodeTargetValue,
    decodeTargetValue,
    getCvInput,
    findOrphanedRoutes,
    DEFAULT_INPUT_SCALE,
    DEFAULT_INPUT_OFFSET,
    type CvRoutes,
    type CvRouteTarget,
    type CvInputs,
  } from '$lib/video/toybox-cv-routes';
  import { setCvRoute, clearCvRoute } from '$lib/graph/toybox-cv-routes';
  import { setCvScale, setCvOffset } from '$lib/graph/toybox-cv-inputs';
  import type { ToyboxScopeSnapshot, ToyboxScopeState } from '$lib/video/modules/toybox';
  import {
    drawToyboxInputScope,
    type ToyboxScopeColors,
  } from '$lib/video/toybox-scope-draw';
  import {
    loadToyboxPreset,
    applyDataBlobToNode,
    restoreToyboxRollScope,
  } from '$lib/graph/toybox-presets';
  import {
    ANTI_REPEAT_MEMORY,
    DIM_GEN_CONTENT,
    mergeRevertWithLocks,
    rollToyboxPatch,
    type ToyboxCurrentState,
    type ToyboxRandomContext,
    type ToyboxRollResult,
  } from '$lib/video/toybox-random';
  import {
    listUserPresets,
    saveUserPreset,
    getUserPreset,
    deleteUserPreset,
    type ToyboxUserPreset,
  } from '$lib/video/toybox-user-presets';
  import {
    exportToyboxPreset,
    importToyboxPreset,
    MAX_VIDEO_BYTES,
    type ToyboxPresetVideo,
  } from '$lib/video/toybox-preset-io';
  import {
    clampLayerIndex,
    setLayerKind,
    setLayerContent,
    setLayerParam,
    setLayerModel,
    setLayerMatcap,
    setLayerSurfaceSource,
    setLayerSurfaceMode,
    setLayerMaterialField,
    setLayerImage as setLayerImageData,
    setLayerShaderSource,
    setLayerObjSource,
    setLayerVideoName,
    setLayerVideoSource,
    setLayerLocked,
  } from '$lib/graph/toybox-layers';
  import { nodeMedia } from '$lib/ui/media/node-media-registry';
  import { drawPreviewDownscaled } from '../preview-downscale';
  import {
    expectedVideoLayers,
    exportRefusalMessage,
    layerVideoName,
    missingVideoLayers,
  } from '../toybox-export-guard';

  /** Which host is mounting this console. See the header — ARRANGEMENT only.
   *
   *  ⚠ ONE MEMBER TODAY. A second arm rendered a three-column body for the
   *  surface this module had before its face; nothing mounts that host any
   *  more. The union stays a union because the console is designed to be
   *  arranged by its host, and the next host declares itself here. */
  type ToyboxConsoleLayout = 'face';

  interface Props {
    /** The TOYBOX node id. Stable for this component's whole lifetime. */
    nodeId: string;
    /** The legacy card's xyflow snapshot wrapper. ⚠ THE CARD PASSES IT AND THE
     *  FACE CANNOT, and that asymmetry is the reason `extRev` below exists
     *  rather than a preference: the card's reactivity has always keyed off
     *  this wrapper's FRESH IDENTITY per snapshot, and a faceplate body is not
     *  rendered by xyflow so no such wrapper reaches it. */
    nodeSnapshot?: ModuleNode | undefined;
    /** 'card' (legacy 3-column) or 'face' (screen + layer band + tab rail). */
    layout?: ToyboxConsoleLayout;
    /**
     * Is the SCREEN switched ON? Owned by the HOST, because the fleet's video
     * screen ruling puts the toggle on the faceplate and `node.data
     * .previewCollapsed` is the shared key (see ToyboxConsoleBody).
     *
     * ⚠ IT GATES THE BLIT AND NOTHING ELSE. `draw()` goes on renewing the
     * node's WATCH MARK every frame while it is false, so the engine keeps
     * advancing the composite — feedback/framedelay/exquisite ops carry HISTORY
     * across frames, and letting the mark lapse would bring the picture back
     * black or stale when the screen came on again (the collapse-kills-the-
     * producer class, #1721/#1728). Off changes what is PAINTED, never what is
     * PRODUCED.
     *
     * Defaults TRUE so the legacy card is unchanged: it has no switch.
     */
    screenOn?: boolean;
  }

  let {
    nodeId,
    nodeSnapshot = undefined,
    layout = 'face',
    screenOn = true,
  }: Props = $props();

  /** The node id, under the name every call site below already uses. */
  let id = $derived(nodeId);

  /**
   * The reactive trigger for an EXTERNAL/remote write, per host.
   *
   * The card gets a fresh `nodeSnapshot` wrapper on every xyflow snapshot, which
   * is a genuine Svelte dependency. The face gets none, so it reads the
   * per-node signal instead — `nodeVersion(id)` is bumped by the same store
   * mutations, and reading it subscribes to that ONE key.
   *
   * ⚠ NOT `patch.nodes[id]` AS THE DEP. That proxy's identity is STABLE across
   * every write (the repo's Y.Doc-proxy trap), so a derived that depended on it
   * would never re-run — which is the exact bug the card's comment below
   * describes and works around.
   */
  let extRev = $derived(nodeSnapshot ? 0 : nodeVersion(id));
  let node = $derived(nodeSnapshot ?? (patch.nodes[id] as unknown as ModuleNode | undefined));
  const engineCtx = useEngine();

  // Engine render resolution (VIDEO_RES) — letterbox the 4:3 render.
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  // The SCREEN's backing store. Card 200×150 (UNCHANGED — its VRT baselines
  // are pinned to that plate); face 480×360, because the dock body is the
  // module's own full-width surface and upscaling a 200 px buffer across it
  // would paint a soft picture of a sharp render.
  //
  // ⚠ BOTH ARE WHOLE PIXELS AT THE ENGINE'S OWN 4:3, deliberately: a
  // fractional-width picture box is a VRT settle hazard (a half-pixel box
  // rounds one way on one boot and the other way on the next), so the face's
  // screen is a FIXED 480×360 rather than a percentage of a pane whose width is
  // itself `max-content`.
  const CANVAS_W = 480;
  const CANVAS_H = Math.round(CANVAS_W * (ENGINE_H / ENGINE_W)); // 360

  // ----- Content + model catalogs (loaded from the static manifest) -----
  let catalog: ToyboxContent[] = $state([]);
  let models: ToyboxModel[] = $state([]);
  let presets: ToyboxPreset[] = $state([]);
  const MATCAP_LABELS = ['CHROME', 'CLAY', 'NEON'];
  onMount(() => {
    void (async () => {
      await ensureToyboxCatalog();
      catalog = await listAllContent();
      models = await listModels();
      presets = await listPresets();
      // Seed a fully-defaulted layer array if the node has none yet, so the
      // factory + card agree on layer 0's content from first paint.
      const t = patch.nodes[id];
      if (t) {
        if (!t.data) t.data = {};
        if (!Array.isArray((t.data as { layers?: unknown }).layers)) {
          (t.data as { layers: ToyboxLayer[] }).layers = makeDefaultLayers();
        }
      }
    })();
  });

  // ───────────────────── PER-LAYER EDITING (the LAYER selector) ─────────────────────
  //
  // The card edits ANY of the LAYER_COUNT layers; `activeLayer` (0-indexed) is
  // the currently-selected one. Every per-layer control below targets
  // node.data.layers[activeLayer] via the graph/toybox-layers.ts mutators
  // (Yjs in-place). The combine DAG composites all 4 layers regardless.
  let activeLayer = $state(0);

  // Per-layer reads must reflect BOTH (a) a LOCAL mutation immediately after the
  // control fires AND (b) an EXTERNAL/remote write (a rack-mate, a preset, or a
  // test seeding via __ydoc.transact). Two codebase facts make that non-trivial:
  //   1. The snapshot `node` prop keeps node.data as the LIVE Y proxy (a STABLE
  //      reference across snapshots — only node.params is fresh-copied). So the
  //      layers ARRAY ref never changes: a derived that only depends on it would
  //      short-circuit (=== unchanged) and not re-run on a nested-scalar write.
  //   2. The bus→xyflow re-render lags the local onchange by a tick, so reading
  //      off `node` right after a local mutation sees the OLD value.
  // Fix: every per-layer derived calls readLiveLayers(), which reads BOTH
  // triggers so the derived re-runs on either:
  //   - `node` (whose wrapper identity is fresh each snapshot) → external/remote
  //     writes (rack-mate / preset / __ydoc.transact), and
  //   - `layersRev` (each control bumps it after mutating) → the immediate
  //     post-onchange read; we then read the LIVE patch proxy (not the lagging
  //     snapshot) so the new value is visible the instant the bump lands.
  // (Mirrors the combine editor bumping selectedNodeId after each mutate.)
  let layersRev = $state(0);
  function bumpRev(): void {
    layersRev++;
  }

  /** Read the live layers array, registering BOTH reactive triggers as deps:
   *  `node` (a fresh wrapper each snapshot → external/remote writes) and
   *  `layersRev` (bumped by each local control → the immediate post-onchange
   *  read). Returns the LIVE patch proxy (reflects a local transact write the
   *  instant the bump lands; the snapshot lags a tick), falling back to the
   *  snapshot prop for the initial paint. Called from every per-layer derived so
   *  each re-runs on either trigger — the proxy array's reference is stable, so a
   *  derived depending only on a memoised `liveLayers` would short-circuit. */
  function readLiveLayers(): ToyboxLayer[] | undefined {
    void node; void extRev; // dep: external/remote writes (snapshot pushes a new node wrapper)
    void layersRev; // dep: local mutation (control bumps after the transact)
    const live = patch.nodes[id]?.data?.layers as ToyboxLayer[] | undefined;
    return live ?? (node?.data?.layers as ToyboxLayer[] | undefined);
  }

  /** Read the live combine field the SAME way (#60): the LIVE patch proxy +
   *  BOTH reactive triggers, so the CV section's derived target/param lists
   *  recompute the instant a combine node is added / removed / retyped (a local
   *  mutation bumps `layersRev`; a remote write pushes a fresh `node` wrapper).
   *  Adding/retyping a node mutates the array IN PLACE, so a derived that read a
   *  memoised reference would short-circuit — hence the explicit bump dep. */
  function readLiveCombine(): unknown {
    void node; void extRev;
    void layersRev;
    const live = patch.nodes[id]?.data as { combine?: unknown } | undefined;
    return live?.combine ?? (node?.data as { combine?: unknown } | undefined)?.combine;
  }

  /** Is a combine op node LOCKED against randomize (#1576 ws3)? Drives the
   *  right-click menu's toggle label + the SVG badge state. */
  function combineNodeIsLocked(nodeId: string | undefined): boolean {
    if (!nodeId) return false;
    const c = readLiveCombine() as { nodes?: Array<{ id: string; locked?: boolean }> } | undefined;
    if (!c || !Array.isArray(c.nodes)) return false;
    return c.nodes.find((n) => n.id === nodeId)?.locked === true;
  }

  /** Which layers are populated (kind !== 'off') — drives the tab dots. Read
   *  every entry so adding content to any layer re-evaluates the badges. */
  let layerPopulated = $derived.by<boolean[]>(() => {
    const ls = readLiveLayers();
    const out: boolean[] = [];
    for (let i = 0; i < LAYER_COUNT; i++) {
      const k = ls?.[i]?.kind;
      out.push(!!k && k !== 'off');
    }
    return out;
  });

  /** Which layers are LOCKED against randomize (#1576 ws3) — drives the tab
   *  padlock toggles + badges. */
  let layerLocked = $derived.by<boolean[]>(() => {
    const ls = readLiveLayers();
    const out: boolean[] = [];
    for (let i = 0; i < LAYER_COUNT; i++) out.push(ls?.[i]?.locked === true);
    return out;
  });

  // The layer's kind selects which control cluster shows: shader/gen → content
  // dropdown + param faders; obj → model dropdown + transform/matcap controls.
  let currentKind = $derived.by<ToyboxLayerKind>(() => readLiveLayers()?.[activeLayer]?.kind ?? 'off');
  let isObj = $derived(currentKind === 'obj');
  let currentContentId = $derived.by<string>(
    () => readLiveLayers()?.[activeLayer]?.contentId ?? DEFAULT_CONTENT_ID,
  );
  // Derive from the reactive `catalog` (not the module-level lookup) so the
  // faders appear as soon as the manifest loads, and re-derive when the
  // selected content changes.
  //
  // #1708: an inline disk-loaded source OVERRIDES the dropdown selection in the
  // engine, so the faders must follow the same precedence — otherwise the card
  // shows the bundled shader's controls while the custom one renders. The custom
  // branch resolves (and, on first observation, registers) derived metadata for
  // the SYNCED source bytes, so a rack-mate who never touched the file picker
  // gets the identical fader list from the identical derivation.
  // ⚠ Reads the live layer through readLiveLayers() rather than the
  // `currentShaderSrc` derived below: that one is declared later in this script,
  // and a `let … = $derived` is in its TDZ until then. readLiveLayers is a
  // hoisted function and registers the same two reactive triggers.
  let currentMeta = $derived.by<ToyboxContent | undefined>(() => {
    const layer = readLiveLayers()?.[activeLayer];
    if (layer && typeof layer.shaderSrc === 'string' && layer.shaderSrc.length > 0) {
      return resolveLayerContent(layer).meta;
    }
    void catalog.length; // dep: faders appear the moment the manifest lands
    return catalog.find((c) => c.id === currentContentId);
  });

  // The content dropdown is filtered by the active KIND:
  //   - GEN (and legacy 'shader'): all NO-scene-input shaders (GEN + FX families)
  //     — generative content that ignores the composite below.
  //   - FRAG: FRAG-family shaders, which receive the composite below as
  //     iChannel0 (recolour / displace / feedback FX).
  // This keeps the GEN | FRAG split honest while legacy FX content stays reachable.
  let contentChoices = $derived.by<ToyboxContent[]>(() => {
    if (currentKind === 'frag') return catalog.filter((c) => c.family === 'FRAG');
    if (currentKind === 'gen' || currentKind === 'shader')
      return catalog.filter((c) => c.family === 'GEN' || c.family === 'FX');
    return catalog;
  });

  /** The KIND selector value: collapse the legacy 'shader' kind onto 'gen' so a
   *  pre-split FX layer still shows a selected option (both are no-scene-input
   *  shader content under the GEN bucket). */
  let kindSelectValue = $derived(currentKind === 'shader' ? 'gen' : currentKind);

  // ----- OBJ-layer derived state -----
  let currentMaterial = $derived.by<ToyboxObjMaterial>(
    () => readLiveLayers()?.[activeLayer]?.material ?? makeDefaultObjMaterial(),
  );
  let currentModelId = $derived(currentMaterial.modelId ?? DEFAULT_MODEL_ID);

  /** Read a live param value for the selected content, defaulting to the
   *  manifest default when the layer hasn't set it. */
  function paramVal(pid: string): number {
    const v = readLiveLayers()?.[activeLayer]?.params?.[pid];
    if (typeof v === 'number') return v;
    return currentMeta?.params.find((p) => p.id === pid)?.default ?? 0;
  }

  /** Switch the active layer index (clamped to a valid index). */
  function selectLayer(i: number): void {
    activeLayer = clampLayerIndex(i);
  }

  // The layer-KIND selector: 'gen'/'shader' route through content; 'obj' is the
  // 3D mesh layer; 'off' renders nothing. Seeds the kind's default content for
  // an empty layer (toybox-layers.setLayerKind mirrors the original init).
  function onKindChange(ev: Event) {
    setLayerKind(id, activeLayer, (ev.target as HTMLSelectElement).value as ToyboxLayerKind);
    bumpRev();
    pruneOrphanRoutes(); // #60: retyping a layer (e.g. → off) orphans its routes
  }

  function onContentChange(ev: Event) {
    const sel = (ev.target as HTMLSelectElement).value;
    if (!sel) return;
    setLayerContent(id, activeLayer, sel);
    bumpRev();
    pruneOrphanRoutes(); // #60: new content → a routed uniform may no longer exist
  }

  function onModelChange(ev: Event) {
    const sel = (ev.target as HTMLSelectElement).value;
    if (!sel) return;
    setLayerModel(id, activeLayer, sel);
    bumpRev();
  }

  function onMatcapChange(ev: Event) {
    setLayerMatcap(id, activeLayer, parseInt((ev.target as HTMLSelectElement).value, 10) || 0);
    bumpRev();
  }

  /** Pick the OBJ's SURFACE source: 'MATCAP' (-1) or another layer's rendered
   *  output (a layer INDEX 0..LAYER_COUNT-1) UV-mapped onto the mesh. */
  function onSurfaceChange(ev: Event) {
    setLayerSurfaceSource(id, activeLayer, parseInt((ev.target as HTMLSelectElement).value, 10));
    bumpRev();
  }

  /** Setter for one numeric OBJ-material field (transform/spin/tint). */
  const setMat = (key: keyof ToyboxObjMaterial) => (v: number) => {
    setLayerMaterialField(id, activeLayer, key, v);
    bumpRev();
  };

  function matVal(key: keyof ToyboxObjMaterial): number {
    const v = currentMaterial[key];
    return typeof v === 'number' ? v : 0;
  }

  /** surfaceMix defaults to 1 (full texture) when unset — the engine's default. */
  function surfaceMixVal(): number {
    const v = currentMaterial.surfaceMix;
    return typeof v === 'number' ? v : 1;
  }

  const setParam = (pid: string) => (v: number) => {
    setLayerParam(id, activeLayer, pid, v);
    bumpRev();
  };

  // ───── MIDI / control-surface paramId: pin per-layer knobs to the ACTIVE layer
  //
  // Material fields ('scale'/'rotX'/…) and content uniforms live PER LAYER, but a
  // BARE paramId carries no index. resolveToyboxParam (the surface/MIDI adapter)
  // resolves a bare material id against the FIRST OBJ layer / first owning content
  // layer — so a model the user has on layer 2/3/4 (or when the active layer is
  // not the first OBJ layer) was driven on the WRONG layer, i.e. "toybox scale on
  // a model assigned to a control surface doesn't work". We emit the LAYER-
  // QUALIFIED id ('layer:<activeLayer>:<param>') for these knobs so the binding
  // sticks to the layer it was learned on (resolveLayerQualified, audit M4). The
  // adapter keeps the bare→first-layer fallback, so older saved bindings still
  // resolve. (Combine + cvN:scale/offset knobs are already qualified by their own
  // schemes and are unaffected.)
  function layerParam(param: string): string {
    return `layer:${activeLayer}:${param}`;
  }

  /**
   * The `data-testid` a MIDI-assignable Knob emits — HOST-DEPENDENT, and this
   * is not cosmetic.
   *
   * `Knob.svelte` derives `control-<paramId>` whenever a MIDI-learn key is
   * passed, and `faces-parity` asserts EXACT MULTISET EQUALITY between the dock
   * full view's `[data-testid^="control-"]` elements and the live def's
   * `ParamDef` ids. `toyboxDef.params` is `[]`, so the faceplate must render
   * ZERO of them — otherwise every knob on this console reads as "an unbacked
   * extra control" and the promotion is refused.
   *
   * ⚠ AND DROPPING `paramId` IS NOT THE FIX — that is the trap `Knob`'s own
   * `testid` prop was added to avoid. `paramId` is also the MIDI-learn binding
   * key (`makeMidiAssignable`), so suppressing the testid by omitting it would
   * silently make twenty controls un-learnable on the surface that replaced the
   * card. The override changes the NAME and keeps the binding.
   *
   * ⚠ THE MIDI BINDING IS UNAFFECTED. `bindingKey` is `${moduleId}:${paramId}`,
   * so the override changes the NAME a locator uses and nothing a saved binding
   * addresses.
   */
  function knobTestid(paramId: string): string {
    return `toybox-dial-${paramId}`;
  }

  // ───────────────────── IMAGE / VIDEO INPUT LAYERS (#39) ─────────────────────
  //
  // An IMAGE layer is PICTUREBOX-style: the picked file is downscaled + JPEG-
  // encoded + base64-stored on the LAYER (layer.imageBytes), which rides the
  // Y.Doc so rack-mates see the same picture; each peer decodes the bytes into an
  // ImageBitmap and uploads it into the layer's FBO via the TOYBOX handle extras.
  //
  // A VIDEO layer is VIDEOBOX-style: the file stays LOCAL (a card-owned <video>
  // element via object-URL, looping + muted). Only the FILENAME rides the Y.Doc
  // (layer.videoMeta.name) so rack-mates see "{name}" + pick their own copy. The
  // engine's per-layer frame uploader pumps decoded frames into the layer FBO.

  let inputError = $state<string | null>(null);
  let inputLoading = $state(false);

  /** Reactive trigger for reads of the NODE-owned media registry (#1589).
   *  `nodeMedia` is a plain module singleton, not a rune, and the only writer for
   *  THIS node while this card is mounted is this card — so a version counter
   *  bumped beside every write is the honest way to publish "the local bytes
   *  changed" to `$derived`. (Node deletion also mutates it, via Canvas's sweep,
   *  but that unmounts the card in the same breath.) */
  let mediaRev = $state(0);
  function bumpMediaRev(): void {
    mediaRev++;
  }

  /** The TOYBOX node's handle extras (per-layer image/video upload bridge), or
   *  null while the engine hasn't materialised this node yet. */
  function getExtras(): ToyboxHandleExtras | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      const ve = e.getDomain<VideoEngine>('video');
      return (ve.read(id, 'extras') as ToyboxHandleExtras | undefined) ?? null;
    } catch {
      return null;
    }
  }

  // The active layer's persisted image/video metadata (reactive over both the
  // local-mutation + remote-write triggers, like every per-layer read).
  let currentImageName = $derived.by<string | null>(
    () => readLiveLayers()?.[activeLayer]?.imageName ?? null,
  );
  let currentImageBytes = $derived.by<string | null>(
    () => readLiveLayers()?.[activeLayer]?.imageBytes ?? null,
  );
  let currentVideoName = $derived.by<string | null>(
    () => readLiveLayers()?.[activeLayer]?.videoMeta?.name ?? null,
  );
  // The active layer's CUSTOM disk-loaded shader / OBJ source metadata (both ride
  // the Y.Doc, so reading them registers the per-layer triggers like the others).
  let currentShaderName = $derived.by<string | null>(
    () => readLiveLayers()?.[activeLayer]?.shaderName ?? null,
  );
  let currentShaderSrc = $derived.by<string | null>(
    () => readLiveLayers()?.[activeLayer]?.shaderSrc ?? null,
  );
  let currentObjName = $derived.by<string | null>(
    () => readLiveLayers()?.[activeLayer]?.objName ?? null,
  );
  let currentObjSrc = $derived.by<string | null>(
    () => readLiveLayers()?.[activeLayer]?.objSrc ?? null,
  );
  // The active layer's VIDEO source ('inA'|'inB'|'file'|'camera'). Absent →
  // 'file' (the #603 default, so existing video layers read unchanged).
  let currentVideoSource = $derived.by<ToyboxVideoSource>(
    () => readLiveLayers()?.[activeLayer]?.videoSource ?? 'file',
  );
  /** Does the ACTIVE layer have live local bytes in this session? The filename
   *  alone does not answer that — it rides the Y.Doc and survives a reload, a
   *  localStorage preset and a rack-mate's write, none of which carry bytes.
   *  Showing the name with no bytes is what made the card "look loaded while
   *  rendering nothing" (#1589), so the two states are now distinguishable. */
  let activeVideoLoaded = $derived.by<boolean>(() => {
    void mediaRev;
    return hasLocalVideo(activeLayer);
  });

  /** Change the active VIDEO layer's source. Selecting a patched feed
   *  ('inA'/'inB') tears down any local <video>/webcam for the layer so we
   *  don't hold a camera/decoder open while the feed comes off the cable. */
  function onVideoSourceChange(ev: Event): void {
    const next = (ev.target as HTMLSelectElement).value as ToyboxVideoSource;
    const i = activeLayer;
    setLayerVideoSource(id, i, next);
    bumpRev();
    if (next === 'inA' || next === 'inB') {
      releaseVideoLayer(i);
    } else if (next === 'camera') {
      void startCamera(i);
    }
  }

  // ---- IMAGE layers are NODE-OWNED, not card-owned (#1720) -----------------
  //
  // This card used to decode every layer's persisted `imageBytes` and push it
  // with `extras.setLayerImage(i, bitmap)`, retrying while the engine node had
  // not materialised. It was the ONLY decoder — and toybox.ts's own
  // `renderImageLayer` paints its idle pattern until `hasImage`, which is set
  // ONLY inside `setLayerImage`. So under the faceplate shell, where an
  // un-migrated module's card exists only inside the dock full-view, an image
  // layer of a SAVED rack showed the idle pattern instead of the picture, on
  // LOAD, before anything was touched.
  //
  // Same defect, same bytes-on-the-Y.Doc mechanism as PICTUREBOX —
  // toybox-content.ts said so all along ("base64-encoded JPEG bytes
  // (PICTUREBOX-style, synced over Y.Doc) … The card decodes + uploads"). The
  // decode+upload MOVED to $lib/ui/media/extras-producers, driven by
  // $lib/ui/media/node-extras-registry and swept from Canvas against the live
  // node set, so it is now keyed to GRAPH lifetime and is the ONLY writer.
  //
  // ⚠ The VIDEO half of this channel (`attachLayerVideo`, below) deliberately
  // did NOT move and is not a defect: those bytes are a user-picked LOCAL FILE
  // that no peer and no reload can reconstruct, and within a session the attach
  // already survives a card unmount because nothing detaches it (#1589 removed
  // that teardown, and card-media-lifetime.test.ts forbids it returning).

  async function onImageFileChange(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    inputLoading = true;
    inputError = null;
    try {
      const base64 = await downscaleAndEncode(file);
      setLayerImageData(id, activeLayer, base64, file.name);
      bumpRev();
      // The $effect picks up the new bytes + uploads on the next microtask —
      // same path a remote peer's write takes (no special-casing).
    } catch (err) {
      inputError = err instanceof Error ? err.message : String(err);
    } finally {
      inputLoading = false;
      try { input.value = ''; } catch { /* */ }
    }
  }

  // ---- CUSTOM SHADER / OBJ: disk-loaded text sources (ride the Y.Doc) ----
  //
  // A shader/gen/frag layer can load a custom GLSL (.glsl/.frag/.txt) from disk;
  // an OBJ layer can load a custom .obj. The text is read with file.text(), size-
  // capped (MAX_CUSTOM_SOURCE_BYTES — a sanity cap; the source rides the Y.Doc),
  // and persisted on the layer via the same in-place Yjs mutator pattern the image
  // path uses. The engine prefers the inline source over the bundled id.

  async function readCappedText(file: File): Promise<string> {
    const text = await file.text();
    const bytes = utf8ByteLength(text);
    if (bytes > MAX_CUSTOM_SOURCE_BYTES) {
      throw new Error(
        `File too large (${(bytes / 1024).toFixed(0)}KB > ${(MAX_CUSTOM_SOURCE_BYTES / 1024 / 1024).toFixed(0)}MB cap)`,
      );
    }
    if (text.trim().length === 0) throw new Error('File is empty');
    return text;
  }

  async function onShaderFileChange(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    inputLoading = true;
    inputError = null;
    try {
      const src = await readCappedText(file);
      // #1708: NOTHING is registered here on purpose. Registering where the file
      // is PICKED is precisely the bug — a rack-mate receives this layer over the
      // Y.Doc, never runs this handler, and would show no faders for a shader it
      // is rendering. Derived metadata is now registered wherever a layer with an
      // inline source is OBSERVED (resolveLayerContent), which this peer reaches
      // through the very same path the receiving peer does: `currentMeta` below,
      // and the engine's own per-frame resolve.
      //
      // ⚠ Do not "helpfully" re-add a register call here. It would make this
      // peer pass a fader test that the receiving peer fails, i.e. it would make
      // the test blind to the exact defect the mechanism exists to prevent.
      setLayerShaderSource(id, activeLayer, src, file.name);
      bumpRev();
    } catch (err) {
      inputError = err instanceof Error ? err.message : String(err);
    } finally {
      inputLoading = false;
      try { input.value = ''; } catch { /* */ }
    }
  }

  function onClearShader(): void {
    setLayerShaderSource(id, activeLayer, null, null);
    bumpRev();
    inputError = null;
  }

  async function onObjFileChange(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    inputLoading = true;
    inputError = null;
    try {
      const src = await readCappedText(file);
      setLayerObjSource(id, activeLayer, src, file.name);
      bumpRev();
    } catch (err) {
      inputError = err instanceof Error ? err.message : String(err);
    } finally {
      inputLoading = false;
      try { input.value = ''; } catch { /* */ }
    }
  }

  function onClearObj(): void {
    setLayerObjSource(id, activeLayer, null, null);
    bumpRev();
    inputError = null;
  }

  // ---- VIDEO: NODE-OWNED <video> element per video layer (#1589) ----
  //
  // These elements, their object URLs and their webcam MediaStreams belong to
  // the NODE, not to this card. They live in $lib/ui/media/node-media-registry
  // under one slot per layer, and they are torn down by `nodeMedia.sweep(...)`
  // from Canvas when the node leaves the GRAPH — never when the card unmounts.
  //
  // WHAT WENT WRONG BEFORE (#1589, P0): this card minted the elements with
  // `document.createElement('video')`, held their urls in a card-local Map, and
  // `onDestroy` detached every layer, revoked every url, ran
  // `pause()/srcObject=null/removeAttribute('src')/load()` and stopped every
  // camera track. TOYBOX is un-migrated, so under the faceplate shell its card
  // exists ONLY inside the dock full-view — collapsing it, ESC, or the dock
  // LRU-evicting the pane when a third module is expanded produced that unmount.
  // Every video layer went dark, the layer row kept showing the filename (that
  // rides the Y.Doc), and Export then wrote a preset with ZERO video bytes and
  // said "Exported".
  //
  // The IMAGE path is unaffected and deliberately unchanged: `imageBytes` rides
  // the Y.Doc, so an image layer is reconstructed from the graph on any remount.
  //
  // Retry timers are keyed BY LAYER: a single shared handle could only cancel
  // the last one scheduled, so three of four pending retries leaked past unmount.
  const videoAttachTimers = new Map<number, ReturnType<typeof setTimeout>>();

  /** The registry slot for layer `i`'s media. Stable for the node's whole life. */
  function layerVideoSlot(i: number): string {
    return `layer-video-${i}`;
  }

  /** Layer `i`'s node-owned <video>, created (PARKED off-screen, decoding) on
   *  first use. `init` runs exactly once per node+slot, so the muted/loop/
   *  playsinline stamp survives every remount without being re-applied.
   *
   *  HISTORY worth keeping: `setObjectUrl`/`setStream` also create an entry when
   *  a load races the mount, and that path takes no `init` — so the first cut of
   *  this fix wrote the url first and got a <video> with no `muted`/`loop`/
   *  `playsinline`. Measured: it never autoplayed and the layer stayed silently
   *  black, i.e. a bug in the fix for a bug about layers staying silently black.
   *  The registry now applies a LATE INIT so the order cannot matter; the call
   *  sites below still mint the element first, which is simply clearer. */
  function ensureVideoEl(i: number): HTMLVideoElement {
    return nodeMedia.ensure(id, layerVideoSlot(i), {
      kind: 'video',
      init: (raw) => {
        const el = raw as HTMLVideoElement;
        el.muted = true;
        el.loop = true;
        el.playsInline = true;
        el.setAttribute('data-testid', `toybox-layer-video-${i}`);
        el.setAttribute('data-node-id', id);
      },
    }) as HTMLVideoElement;
  }

  /** Layer `i`'s element if the node already has one — never creates. */
  function peekVideoEl(i: number): HTMLVideoElement | null {
    return nodeMedia.peek(id, layerVideoSlot(i)) as HTMLVideoElement | null;
  }

  /** Does layer `i` have LIVE local bytes/stream in THIS session? The Y.Doc's
   *  filename cannot answer this — that is the exact lie #1589 was about. */
  function hasLocalVideo(i: number): boolean {
    const slot = layerVideoSlot(i);
    return !!nodeMedia.objectUrl(id, slot) || !!nodeMedia.stream(id, slot);
  }

  /** Attach layer `i`'s node-owned <video> element to the engine (retry until
   *  the engine node exists). Idempotent — re-attaching the same element is a
   *  no-op in the uploader, so a remount can safely re-run it for every layer. */
  function ensureVideoAttached(i: number, attempt = 0): void {
    const el = peekVideoEl(i);
    if (!el) return;
    const extras = getExtras();
    if (extras) { extras.attachLayerVideo(i, el); return; }
    if (attempt >= 50) return;
    videoAttachTimers.set(i, setTimeout(() => ensureVideoAttached(i, attempt + 1), 100));
  }

  /** Tear down layer `i`'s LOCAL video source (file object-URL OR webcam
   *  stream) + detach it from the engine.
   *
   *  ⚠ USER INTENT ONLY. The one caller is switching the layer to a PATCHED feed
   *  (inA/inB): the cable provides the texture, so holding a decoder or a camera
   *  open would be wrong. It is NOT reachable from `onDestroy` — that is the
   *  #1589 regression, and `card-media-lifetime.test.ts` fails the build if a
   *  revoke/stop/detach ever re-appears in an unmount path.
   *
   *  The revoke + the track stop happen INSIDE the registry (setObjectUrl(null)
   *  / setStream(null)), so there is exactly one owner of each. */
  function releaseVideoLayer(i: number): void {
    const slot = layerVideoSlot(i);
    nodeMedia.setStream(id, slot, null);
    nodeMedia.setObjectUrl(id, slot, null);
    const el = peekVideoEl(i);
    if (el) {
      try { el.pause(); } catch { /* */ }
      try { el.srcObject = null; } catch { /* */ }
      try { el.removeAttribute('src'); el.load(); } catch { /* */ }
    }
    try { getExtras()?.attachLayerVideo(i, null); } catch { /* */ }
    bumpMediaRev();
  }

  /** Start the device webcam into layer `i`'s card-owned <video> (source=
   *  'camera'). The stream feeds the SAME per-layer uploader as the file path.
   *  NOTE: the dedicated CAMERA module also uses getUserMedia; a browser allows
   *  only so many concurrent captures, so this can fail with NotReadableError
   *  if a camera is already in use elsewhere — surfaced as inputError. */
  async function startCamera(i: number): Promise<void> {
    inputError = null;
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      inputError = 'Browser does not support camera capture';
      return;
    }
    // Free any prior local source for this layer first — through the registry,
    // which owns the revoke + the track stop. The PRIOR stream must be released
    // BEFORE the request, not after: a platform that allows only one open handle
    // on a device answers the second getUserMedia with NotReadableError.
    const slot = layerVideoSlot(i);
    const el = ensureVideoEl(i); // mint first — see ensureVideoEl.
    nodeMedia.setObjectUrl(id, slot, null);
    nodeMedia.setStream(id, slot, null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      nodeMedia.setStream(id, slot, stream);
      el.removeAttribute('src');
      el.srcObject = stream;
      try { await el.play(); } catch { /* a user gesture (the select change) should permit it */ }
      ensureVideoAttached(i);
      bumpMediaRev();
    } catch (err) {
      inputError = err instanceof Error ? err.message : String(err);
    }
  }

  async function onVideoFileChange(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    inputError = null;
    if (!file.type.startsWith('video/')) {
      inputError = `Not a video file: ${file.type || file.name}`;
      try { input.value = ''; } catch { /* */ }
      return;
    }
    // Reject oversized videos before attaching (matches the import cap so a clip
    // that can't EXPORT is rejected at upload, not silently truncated later).
    if (file.size > MAX_VIDEO_BYTES) {
      inputError = `Video is ${(file.size / 1048576).toFixed(0)} MB — exceeds the ${(MAX_VIDEO_BYTES / 1048576).toFixed(0)} MB limit`;
      try { input.value = ''; } catch { /* */ }
      return;
    }
    const layerIdx = activeLayer;
    const slot = layerVideoSlot(layerIdx);
    const el = ensureVideoEl(layerIdx);
    // A file pick implies source='file', overriding a prior camera capture. Hand
    // BOTH the new url and the stream-clear to the registry: it revokes the
    // previous url and stops the previous tracks, so this card never does.
    nodeMedia.setStream(id, slot, null);
    const url = URL.createObjectURL(file);
    nodeMedia.setObjectUrl(id, slot, url, file.name);
    el.srcObject = null;
    el.src = url;
    try { await el.play(); } catch { /* autoplay may be blocked until a gesture; the picker click IS one */ }
    ensureVideoAttached(layerIdx);
    // Picking a file selects the 'file' source + persists the filename (bytes
    // stay local, VIDEOBOX-style; only the name rides the Y.Doc).
    setLayerVideoSource(id, layerIdx, 'file');
    setLayerVideoName(id, layerIdx, file.name);
    bumpRev();
    bumpMediaRev();
    try { input.value = ''; } catch { /* */ }
  }

  // ───────────────────── PROJECTIVE SURFACE MODE (#45) ─────────────────────
  //
  // When an OBJ layer has a SURFACE source set, it can map that source onto the
  // mesh by UV (the default) or PROJECTIVELY (project from a viewpoint). The
  // projector either rides the render camera (projUseCamera) or uses an explicit
  // pos/dir/fov. All material fields ride the Y.Doc + are read live by the engine.

  /** True iff the active OBJ layer has a valid surface source (projective mode is
   *  only meaningful then — with no source there is nothing to project). */
  let hasSurfaceSource = $derived.by<boolean>(() => {
    const s = currentMaterial.surfaceSource;
    return typeof s === 'number' && s >= 0 && s < LAYER_COUNT && s !== activeLayer;
  });
  let surfaceMode = $derived.by<ToyboxSurfaceMode>(
    () => (currentMaterial.surfaceMode === 'projective' ? 'projective' : 'uv'),
  );
  let projUseCamera = $derived.by<boolean>(
    () => (currentMaterial.projUseCamera ?? 0) > 0.5,
  );

  function onSurfaceModeChange(ev: Event): void {
    setLayerSurfaceMode(id, activeLayer, (ev.target as HTMLSelectElement).value as ToyboxSurfaceMode);
    bumpRev();
  }

  function onProjUseCameraChange(ev: Event): void {
    setLayerMaterialField(id, activeLayer, 'projUseCamera', (ev.target as HTMLInputElement).checked ? 1 : 0);
    bumpRev();
  }

  // ───────────────────── COMBINE GRAPH EDITOR (Phase 4) ─────────────────────
  //
  // The card edits node.data.combine — a small DAG of source/op/output nodes
  // reduced by the video factory each frame. We render a bespoke SVG mini-editor
  // (NOT a nested @xyflow/svelte): node boxes + port dots + bezier cables. Every
  // mutation rides the Yjs patch proxy (graph/toybox-combine.ts), triggers the
  // factory's reconcile, and updates the live preview above.

  // Editor canvas geometry (SVG user units). Op nodes tile a wrapping 2-column
  // middle grid (see opSlotXY) so adding many ops stays inside this box; the SVG
  // scales to the card width via width:100% (viewBox is the coordinate system).
  const G_W = 356;
  const G_H = 230;
  const NODE_W = 64;
  const NODE_H = 34;
  const PORT_R = 4;

  /** Live combine graph from the store (default graph until the card edits it).
   *  Reads via readLiveCombine so it tracks BOTH triggers (#60): a local combine
   *  mutation bumps `layersRev`, a remote write pushes a fresh `node` wrapper —
   *  so the editor + node names + CV target/param lists all refresh in lockstep
   *  when nodes are added/removed/retyped. */
  let graph = $derived.by<ToyboxCombineGraph>(() => {
    const c = readLiveCombine();
    // ⚠ MINT A FRESH PLAIN CLONE per evaluation — never return the live store
    // proxy. Returning the proxy shipped the 2026-08-20 owner-black-editor
    // bug: a RANDOMIZE roll replaces combine.nodes/edges IN PLACE, so the
    // proxy reference never changes, `graph` "re-evaluates" to an Object.is-
    // equal value, and NOTHING downstream invalidates — in the dock the
    // each-block kept rendering the spliced-out node objects, which are
    // DETACHED Yjs proxies whose every read returns undefined (measured:
    // six `toybox-gnode-undefined` boxes with blank labels over an 8-node
    // data graph, and a selection panel frozen until F5). A fresh clone is a
    // fresh reference on every layersRev/node trigger, so the editor, the
    // labels map, and the selection panel all re-derive in lockstep with the
    // data. Cost: one small JSON round-trip per bump (the combine graph is a
    // few KB; the CV target lists already re-derive at the same cadence).
    return isCombineGraph(c)
      ? (JSON.parse(JSON.stringify(c)) as ToyboxCombineGraph)
      : makeDefaultCombineGraph();
  });

  /** Node ids LOCKED against randomize (#1576 ws3) — a FRESH Set per
   *  evaluation, deliberately, with the reactive triggers read DIRECTLY
   *  (readLiveCombine inside this body, the layerPopulated pattern): `graph`
   *  above returns the live store proxy, so its reference never changes and a
   *  deep property ADD (`n.locked = true`) invalidates nothing that hangs off
   *  it — the lock badge never painted (measured on this exact bug during
   *  review round 2). A new Set is a new reference on every trigger, so
   *  `lockedNodeIds.has(n.id)` re-renders. */
  let lockedNodeIds = $derived.by<Set<string>>(() => {
    const c = readLiveCombine();
    const ids = new Set<string>();
    if (isCombineGraph(c)) {
      for (const n of (c as ToyboxCombineGraph).nodes) if (n.locked === true) ids.add(n.id);
    }
    return ids;
  });

  // ── Resizable node-graph view (persisted in node.data.combineView.h) ──────
  // The graph panel is user-resizable (CSS `resize: vertical` on .graph-wrap).
  // We persist the dragged height in node.data.combineView so it survives reload
  // + preset round-trip + multiplayer (mirrors setCombineNodePosition). The SVG
  // viewBox stays the fixed G_W:G_H coordinate space, so a taller wrap scales the
  // content (more room for the node map) via preserveAspectRatio.
  const GRAPH_MIN_H = 120;
  const GRAPH_MAX_H = 600;
  const GRAPH_DEFAULT_H = 230;
  /** The persisted view height (CSS px), defaulting when unset. */
  let combineViewH = $derived.by<number>(() => {
    void node; void extRev; void layersRev;
    const live = (patch.nodes[id]?.data ?? node?.data) as { combineView?: { h?: number } } | undefined;
    const h = live?.combineView?.h;
    return typeof h === 'number' && Number.isFinite(h)
      ? Math.min(GRAPH_MAX_H, Math.max(GRAPH_MIN_H, h))
      : GRAPH_DEFAULT_H;
  });
  /** Svelte action: observe the .graph-wrap height + persist user resizes
   *  (debounced). Only writes when the height actually changed beyond a px, so a
   *  programmatic restore (the derived feeding the inline style) doesn't loop. */
  function persistResize(el: HTMLElement) {
    let last = el.getBoundingClientRect().height;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      const h = Math.round(el.getBoundingClientRect().height);
      if (Math.abs(h - last) < 2) return;
      last = h;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const clamped = Math.min(GRAPH_MAX_H, Math.max(GRAPH_MIN_H, h));
        setCombineViewSize(id, clamped);
        layersRev++; // bump the reactive trigger so combineViewH re-reads the write
      }, 200);
    });
    ro.observe(el);
    return {
      destroy() {
        if (timer) clearTimeout(timer);
        ro.disconnect();
      },
    };
  }

  // ───────────────────── THE FACE'S TAB RAIL (layout === 'face') ─────────────
  //
  // Owner ruling 2026-08-28: "putting cv-mod, combine graph, preset controls on
  // 3 tabs, all below a screen that turns on and off".
  //
  // ⚠ THIS IS BODY-INTERNAL CHROME AND INVOKES NO SHELL ARITHMETIC. The dock's
  // own tab rail is for param BANDS and is gated by `DOCK_TAB_MIN_BANDS` via
  // `dockTabPlan`; this face declares ZERO params and therefore zero bands, so
  // that machinery is untouched. These three tabs are module-owned markup
  // inside `fullViewBody` — they adopt the rail's LOOK and import no shell tab
  // model.
  //
  // ⚠ THE TAB RAIL *IS* THE SECTION COLLAPSE. COMBINE GRAPH and CV/MOD used to
  // carry a ▸/▾ toggle each; a tab shows one and hides the others, which is the
  // same capability with one control instead of two. `editorVisible` /
  // `cvVisible` below are what the rest of this file reads, so no zone has to
  // know how it was reached.
  //
  // LOCAL per collaborator, exactly like `activeLayer`: which tab you are on is
  // not something a rack-mate should be able to change under your hands, and it
  // is not part of the patch.
  type ToyboxFaceTab = 'cv' | 'combine' | 'presets';
  // CV-MOD is the default because it is the PERFORMANCE tab — the one a player
  // lives on once the patch is built. (A fresh node opening on COMBINE GRAPH
  // instead was considered and rejected as too clever: a per-state default is a
  // surface that moves under you.)
  let faceTab = $state<ToyboxFaceTab>('cv');

  /** Is the COMBINE GRAPH editor on screen right now? */
  let editorVisible = $derived(faceTab === 'combine');
  /** Is the PRESET store on screen right now? */
  let presetsVisible = $derived(faceTab === 'presets');
  // (`cvVisible` is declared further down, beside the scope tick it gates.)
  /** A pending output port we clicked first (click-port-then-port connect). */
  let pendingFrom = $state<string | null>(null);
  /** The currently-selected op node (its params show in the side strip). */
  let selectedNodeId = $state<string | null>(null);
  /** Transient connect-rejection message for the user. */
  let connectMsg = $state<string | null>(null);

  function nodeById(gid: string): ToyboxGraphNode | undefined {
    return graph.nodes.find((n) => n.id === gid);
  }

  /** The live combine graph's nodes (post-mutation): reads the LIVE patch proxy
   *  so it reflects an in-place node splice the INSTANT it lands (the `graph`
   *  derived lags until its reactive trigger re-runs). Used by the delete
   *  auto-select so it picks from the graph AFTER the deletion, not before. */
  function liveNodes(): ToyboxGraphNode[] {
    const c = readLiveCombine();
    return isCombineGraph(c) ? (c as ToyboxCombineGraph).nodes : graph.nodes;
  }
  /** True if a node id still exists in the live graph. */
  function liveNodeExists(gid: string): boolean {
    return liveNodes().some((n) => n.id === gid);
  }
  /** The first OP node (not source/output) in the live graph, or null. The
   *  delete auto-select target so the bottom control pane keeps showing a node's
   *  controls after a delete. */
  function firstOpNodeId(): string | null {
    const n = liveNodes().find((x) => x.kind !== 'source' && x.kind !== 'output');
    return n?.id ?? null;
  }

  /** Layout: SOURCE col on the left, ops in the middle (their own x/y), OUTPUT
   *  on the right. We honour each node's stored x/y for ops; source/output get a
   *  fixed column so they're always findable. */
  function nodeXY(n: ToyboxGraphNode): { x: number; y: number } {
    return { x: n.x, y: n.y };
  }

  /** Centre of a node's OUTPUT port (right edge mid). */
  function outPortXY(n: ToyboxGraphNode): { x: number; y: number } {
    const { x, y } = nodeXY(n);
    return { x: x + NODE_W, y: y + NODE_H / 2 };
  }

  /** Centre of a node's input port `port`. Op nodes stack in0 (upper) + in1
   *  (lower) on the left edge; output has the single in0 mid-left. */
  function inPortXY(n: ToyboxGraphNode, port: ToyboxInPort): { x: number; y: number } {
    const { x, y } = nodeXY(n);
    const ports = inPortsFor(n.kind);
    if (ports.length <= 1) return { x, y: y + NODE_H / 2 };
    const idx = ports.indexOf(port);
    const frac = (idx + 1) / (ports.length + 1);
    return { x, y: y + NODE_H * frac };
  }

  /** Bezier path string between two points (horizontal control handles). */
  function cablePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
    const dx = Math.max(24, Math.abs(b.x - a.x) * 0.5);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }

  /** Unique per-node display names (#56 1-based sources + #58 ordinal ops),
   *  derived live so they recompute when nodes are added/removed/retyped. The
   *  bump deps are explicit: `graph` returns the SAME live proxy reference after
   *  an in-place node push, so a derived keyed only on `graph` would short-
   *  circuit (it didn't change by ===) — read the bump triggers to force a
   *  recompute on every structural mutation. */
  let nodeNames = $derived.by(() => {
    void node; void extRev; void layersRev;
    return combineDisplayNames(graph);
  });

  /** A short glyph/label for a node box — the node's UNIQUE display name
   *  ("L1".."L4", "LUMA 1", "CHROMA 2", "OUT") so two same-kind nodes are
   *  distinguishable in BOTH the node map and the CV-target label (#58). */
  function nodeLabel(n: ToyboxGraphNode): string {
    return nodeNames.get(n.id) ?? n.id;
  }

  function clearConnectMsg(): void {
    connectMsg = null;
  }

  // ---- interactions ----

  function onAddOp(kind: ToyboxOpKind): void {
    const newId = addCombineNode(id, kind);
    if (newId) selectedNodeId = newId;
    bumpRev(); // #60: refresh node names + CV target/param lists immediately
    clearConnectMsg();
  }

  /** Click a node's OUTPUT port → arm it as the connect source. */
  function onOutPortClick(gid: string): void {
    const n = nodeById(gid);
    if (!n || !hasOutPort(n.kind)) return;
    pendingFrom = pendingFrom === gid ? null : gid; // toggle off if re-clicked
    clearConnectMsg();
  }

  /** Click a node's INPUT port → if a source is armed, create the edge. */
  function onInPortClick(gid: string, port: ToyboxInPort): void {
    if (!pendingFrom) {
      connectMsg = 'pick an output dot first';
      return;
    }
    const from = pendingFrom;
    const res = connectCombine(id, from, gid, port);
    pendingFrom = null;
    bumpRev(); // #60
    if (!res.ok) {
      connectMsg =
        res.error === 'cycle' ? 'rejected: would create a cycle'
        : res.error === 'occupied' ? 'that input is already wired'
        : res.error === 'self-loop' ? 'cannot wire a node to itself'
        : res.error === 'no-out-port' ? 'that node has no output'
        : 'cannot connect';
    } else {
      connectMsg = null;
    }
  }

  function onNodeClick(gid: string): void {
    const n = nodeById(gid);
    if (!n) return;
    // Source/output have no params; op nodes open the side strip.
    selectedNodeId = n.kind === 'source' || n.kind === 'output' ? null : gid;
    clearConnectMsg();
  }

  function onDeleteNode(gid: string): void {
    const wasSelected = selectedNodeId === gid;
    deleteCombineNode(id, gid);
    bumpRev(); // #60: refresh node names + CV lists (also re-runs `graph`/liveNodes)
    // AUTO-SELECT after a delete so the bottom control pane keeps showing a
    // node's controls (an empty pane after a delete reads as "the controls just
    // vanished"). Re-target only when the DELETED node was the selection (or the
    // current selection is now stale) → the first remaining OP node, else null
    // (no op nodes left → the pane hides, as intended). An unrelated delete
    // leaves the selection untouched.
    if (wasSelected || (selectedNodeId !== null && !liveNodeExists(selectedNodeId))) {
      selectedNodeId = firstOpNodeId();
    }
    pruneOrphanRoutes(); // #60: unmap any CV route to the deleted node
    clearConnectMsg();
  }

  function onDeleteEdge(edgeId: string): void {
    deleteCombineEdge(id, edgeId);
    bumpRev(); // #60 (edges never orphan a route — routes target nodes/params)
    clearConnectMsg();
  }

  // ───────── CONTEXTUAL RIGHT-CLICK MENU (node / port / edge / canvas) ─────────
  //
  // A single oncontextmenu handler on the <svg> classifies what was right-clicked
  // (via e.target.closest() reading the data-* attributes already on the rendered
  // elements) and opens ONE $state-driven menu (ToyboxNodeMenu). Right-click is
  // purely additive — the existing click-to-wire UX is untouched.

  interface ToyboxMenuState {
    open: boolean;
    x: number;
    y: number;
    kind: 'node' | 'port' | 'edge' | 'canvas';
    nodeId?: string;
    nodeKind?: ToyboxNodeKind;
    port?: ToyboxInPort;
    dir?: 'in' | 'out';
    edgeId?: string;
    /** SVG-user-unit click point (canvas target → "Add node here"). */
    ux?: number;
    uy?: number;
  }
  let toyboxMenu = $state<ToyboxMenuState | null>(null);

  /** Map a screen-px point to SVG user units via the live screen CTM inverse. */
  function svgUserPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const u = pt.matrixTransform(ctm.inverse());
    return { x: u.x, y: u.y };
  }

  /** The single contextmenu handler on the combine SVG. Classifies the target
   *  (port > edge > node > canvas) and opens the contextual menu. ALWAYS
   *  suppresses the native menu + any bubbling to xyflow's onnodecontextmenu /
   *  Canvas's port-menu listener. */
  function onGraphCtx(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const target = e.target as Element | null;
    const svg = e.currentTarget as SVGSVGElement;
    if (!target) return;

    // PORT (output dot) — testid `toybox-outport-${nodeId}`.
    const outEl = target.closest('[data-testid^="toybox-outport-"]');
    if (outEl) {
      const gid = outEl.getAttribute('data-testid')!.slice('toybox-outport-'.length);
      toyboxMenu = { open: true, x: e.clientX, y: e.clientY, kind: 'port', nodeId: gid, dir: 'out', nodeKind: nodeById(gid)?.kind };
      return;
    }
    // PORT (input dot) — testid `toybox-inport-${nodeId}-${port}`.
    const inEl = target.closest('[data-testid^="toybox-inport-"]');
    if (inEl) {
      const rest = inEl.getAttribute('data-testid')!.slice('toybox-inport-'.length);
      const lastDash = rest.lastIndexOf('-');
      const gid = rest.slice(0, lastDash);
      const port = rest.slice(lastDash + 1) as ToyboxInPort;
      toyboxMenu = { open: true, x: e.clientX, y: e.clientY, kind: 'port', nodeId: gid, dir: 'in', port, nodeKind: nodeById(gid)?.kind };
      return;
    }
    // EDGE — testid `toybox-edge-${edgeId}`.
    const edgeEl = target.closest('[data-testid^="toybox-edge-"]');
    if (edgeEl) {
      const edgeId = edgeEl.getAttribute('data-testid')!.slice('toybox-edge-'.length);
      toyboxMenu = { open: true, x: e.clientX, y: e.clientY, kind: 'edge', edgeId };
      return;
    }
    // NODE — testid `toybox-gnode-${nodeId}`; kind read off data-kind on the <g>.
    const nodeEl = target.closest('[data-testid^="toybox-gnode-"]');
    if (nodeEl) {
      const gid = nodeEl.getAttribute('data-testid')!.slice('toybox-gnode-'.length);
      const nodeKind = (nodeEl.getAttribute('data-kind') as ToyboxNodeKind | null) ?? nodeById(gid)?.kind;
      toyboxMenu = { open: true, x: e.clientX, y: e.clientY, kind: 'node', nodeId: gid, nodeKind };
      return;
    }
    // CANVAS (empty background) — capture the SVG-user-unit click point.
    const u = svgUserPoint(svg, e.clientX, e.clientY);
    toyboxMenu = { open: true, x: e.clientX, y: e.clientY, kind: 'canvas', ux: u.x, uy: u.y };
  }

  function closeToyboxMenu(): void {
    toyboxMenu = null;
  }

  // NOTE: the per-op CONTROL surface is the card's always-visible bottom pane
  // (select a node → its knobs/selectors show — see selectedNode + the
  // .combine-params block below). The old right-click "Configure keyer…" /
  // "Configure feedback…" popovers were removed in favour of that single,
  // consistent surface so EVERY node type is edited the same way (the keyer
  // colour is now its keyR/keyG/keyB knobs; the feedback MODE is the bottom
  // pane's <select>). setFeedbackMode / doResetFeedback below still serve the
  // bottom pane + the structural Reset menu action.

  /** Surface a connect/patch rejection through the existing connectMsg banner. */
  function showConnectError(error: string | undefined): void {
    connectMsg =
      error === 'cycle' ? 'rejected: would create a cycle'
      : error === 'occupied' ? 'that input is already wired'
      : error === 'self-loop' ? 'cannot wire a node to itself'
      : error === 'no-out-port' ? 'that node has no output'
      : 'cannot connect';
  }

  function doPatchToOutput(gid: string): void {
    const res = patchToOutput(id, gid);
    bumpRev(); // #60
    if (!res.ok) showConnectError(res.error);
    else clearConnectMsg();
  }

  /** Remove EVERY edge touching `gid` (in or out). */
  function doDisconnect(gid: string): void {
    for (const eid of edgesTouching(graph, gid)) deleteCombineEdge(id, eid);
    bumpRev(); // #60
    clearConnectMsg();
  }

  /** Remove only the edges at one specific port of a node. For an output dot,
   *  that's every edge leaving the node; for an input dot, the single edge into
   *  that port. */
  function doDisconnectPort(gid: string, dir: 'in' | 'out', port?: ToyboxInPort): void {
    const toRemove =
      dir === 'out'
        ? graph.edges.filter((e) => e.from === gid)
        : graph.edges.filter((e) => e.to === gid && e.toPort === port);
    for (const e of toRemove) deleteCombineEdge(id, e.id);
    bumpRev(); // #60
    clearConnectMsg();
  }

  function doDuplicate(gid: string): void {
    const newId = duplicateCombineNode(id, gid);
    if (newId) selectedNodeId = newId;
    bumpRev(); // #60
    clearConnectMsg();
  }

  /** Add an op node at the right-clicked SVG-user-unit point (centred on it). */
  function doAddNodeAt(kind: ToyboxOpKind, ux?: number, uy?: number): void {
    const newId = addCombineNode(id, kind);
    if (newId) {
      if (typeof ux === 'number' && typeof uy === 'number') {
        setCombineNodePosition(id, newId, ux - NODE_W / 2, uy - NODE_H / 2);
      }
      selectedNodeId = newId;
    }
    bumpRev(); // #60
    clearConnectMsg();
  }

  function doClearNodeMap(): void {
    clearCombineEdges(id);
    selectedNodeId = null;
    bumpRev(); // #60
    clearConnectMsg();
  }

  function doResetToDefault(): void {
    resetCombineToDefault(id);
    selectedNodeId = null;
    pendingFrom = null;
    bumpRev(); // #60
    pruneOrphanRoutes(); // #60: reset replaces every op node → unmap stale routes
    clearConnectMsg();
  }

  /** Arm a node's output as the connect source (reuses click-to-wire). */
  function doBeginWire(gid: string): void {
    const n = nodeById(gid);
    if (!n || !hasOutPort(n.kind)) return;
    pendingFrom = gid;
    clearConnectMsg();
  }

  /** Live param value for the selected op node (manifest default fallback). */
  function combineParamVal(n: ToyboxGraphNode, pid: string): number {
    const v = n.params?.[pid];
    if (typeof v === 'number') return v;
    const def = OP_PARAMS[n.kind as ToyboxOpKind]?.find((p) => p.id === pid);
    return def?.default ?? 0;
  }

  const setCombineParam = (gid: string, pid: string) => (v: number) => {
    setCombineNodeParam(id, gid, pid, v);
    bumpRev(); // refresh the side-strip / keyer-popover live readback
  };

  // A fresh SNAPSHOT (not the live proxy) keyed on layersRev + node — the SAME
  // trap the feedback-config popover already dodged. The bottom-pane control
  // strip below feeds `combineParamVal(selectedNode, p.id)` into each Knob's
  // `value` prop. A param edit mutates node.params IN PLACE, so `graph`'s derived
  // returns the SAME proxy reference (=== unchanged) and Svelte short-circuits —
  // `selectedNode` (and thus the Knob's value) would NEVER re-read the write. On
  // pointer-up the Knob syncs its visible tick back to the stale `value` prop, so
  // the knob SNAPS BACK to the old value ("knobs don't stick when turned"). By
  // reading both reactive triggers + returning a fresh object whose reference
  // changes on every bump, the value prop re-reads the live write and the knob
  // sticks. (Spread params into a new object so a per-key read is fresh too.)
  let selectedNode = $derived.by<ToyboxGraphNode | undefined>(() => {
    void layersRev; void node; void extRev;
    if (!selectedNodeId) return undefined;
    const n = nodeById(selectedNodeId);
    return n
      ? { id: n.id, kind: n.kind, x: n.x, y: n.y, layer: n.layer, params: { ...(n.params ?? {}) } }
      : undefined;
  });
  let selectedParams = $derived(
    selectedNode && selectedNode.kind !== 'source' && selectedNode.kind !== 'output'
      ? OP_PARAMS[selectedNode.kind as ToyboxOpKind] ?? []
      : [],
  );
  // FEEDBACK exposes a discrete MODE param rendered as a <select> (not a knob),
  // so we filter `mode` out of the auto-rendered knob grid for a feedback node
  // (the other floats still knob-render). Non-feedback nodes are unaffected.
  let selectedIsFeedback = $derived(selectedNode?.kind === 'feedback');
  let selectedKnobParams = $derived(
    selectedIsFeedback ? selectedParams.filter((p) => p.id !== 'mode') : selectedParams,
  );

  /** The selected FEEDBACK node's current mode id (clamped to 0..11). */
  let selectedFeedbackMode = $derived.by<number>(() => {
    if (!selectedIsFeedback || !selectedNode) return 0;
    const v = selectedNode.params?.mode;
    const m = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
    return m < 0 ? 0 : m >= FEEDBACK_MODES.length ? FEEDBACK_MODES.length - 1 : m;
  });

  /** Set the selected feedback node's mode (writes the `mode` op param). */
  function setFeedbackMode(gid: string, mode: number): void {
    setCombineNodeParam(id, gid, 'mode', mode);
    bumpRev();
  }

  /** Clear a feedback node's ping-pong buffers ("Reset feedback" menu action). */
  function doResetFeedback(gid: string): void {
    resetFeedbackNode(id, gid);
    bumpRev();
    clearConnectMsg();
  }

  // ───────────────────── CV ROUTING TAB (Phase 5) ─────────────────────
  //
  // A FIXED pool of 8 generic CV input ports (cv1..cv8) routed to addressed
  // params via node.data.cvRoutes. Each row is a two-dropdown selector:
  //   [target ▾ = layer0..3 / a combine op] [param ▾ = that target's params].
  // The available targets/params are derived LIVE from the layers' content
  // params + the combine op nodes (toybox-cv-routes.ts). Selecting writes the
  // route through the Yjs mutator (graph/toybox-cv-routes.ts); the factory's
  // setParam(cvN) resolves + re-scales each sample into the live param.

  /**
   * Is the CV/MOD rail on screen right now?
   *
   * ⚠ IT GATES `tickScopes()`, so the six inline scopes stop their per-frame
   * work whenever the rail is not showing — an inactive tab costs nothing,
   * which is the one behaviour a tab rail owes over a collapse.
   * `freezeScopes()` (VRT) is unaffected: it draws once, on demand.
   */
  let cvVisible = $derived(faceTab === 'cv');

  /** The live layers + combine the dropdowns enumerate targets/params from.
   *  Read through the live-proxy readers (#60) so the target/param OPTIONS
   *  reactively recompute when a layer or combine node is added / removed /
   *  retyped / recontented — `node?.data.*` alone lags a tick on a local edit
   *  and doesn't invalidate on an in-place array push. */
  let liveLayersForCv = $derived(readLiveLayers());
  let liveCombineForCv = $derived(readLiveCombine());

  /** Target options (layers + combine ops), live. The live readers return the
   *  SAME proxy reference after an in-place layer/node mutation, so a derived
   *  keyed only on them would short-circuit (=== unchanged) and go STALE — the
   *  exact bug the user hit adding a 3rd layer. Read the bump triggers directly
   *  (#60) so this recomputes on every structural change. */
  let cvTargets = $derived.by(() => {
    void node; void extRev; void layersRev;
    return listCvTargets(liveLayersForCv, liveCombineForCv);
  });

  // Per-port reactive maps. We iterate ALL ports inside ONE $derived.by so every
  // route key is READ (and thus tracked) every recompute — without this, adding
  // a 2nd route to the in-place-mutated cvRoutes Y-proxy wouldn't invalidate a
  // per-port helper that only read its own key (the Y-proxy object reference
  // doesn't change on a key add). cvRoutesView is read first so the whole map is
  // a dependency. Reads through the live proxy + bump triggers (#60) so it
  // refreshes the instant a local re-route lands (not a tick later).
  let cvRoutesView = $derived.by<Record<string, CvRouteTarget | null>>(() => {
    void node; void extRev; void layersRev; // deps: remote snapshot + local mutation
    const live = (patch.nodes[id]?.data as { cvRoutes?: CvRoutes } | undefined)?.cvRoutes
      ?? (node?.data as { cvRoutes?: CvRoutes } | undefined)?.cvRoutes;
    const out: Record<string, CvRouteTarget | null> = {};
    for (const p of CV_PORT_IDS) {
      const r = live && typeof live === 'object' ? live[p] : undefined;
      // Copy to a plain object so the snapshot is stable + every field is read.
      out[p] = r ? { target: r.target, layer: r.layer, nodeId: r.nodeId, param: r.param } : null;
    }
    return out;
  });

  // ── AUTO-UNMAP orphaned CV routes (#60) ──
  // When a layer/combine-node/param a route targets stops existing (layer
  // retyped to 'off', combine node deleted, content swapped so a uniform is
  // gone, …), the route is ORPHANED: it resolves to nothing + shows an invalid
  // selection. We CLEAR such routes so a stale mapping is forgotten rather than
  // lingering. Done IMPERATIVELY after each local structural mutation (below) +
  // reactively off the `node` snapshot for remote/preset changes — the raw
  // syncedStore proxy is NOT a Svelte source, so a deep-proxy read in a $derived
  // can't observe an in-place node splice (verified: it goes stale). We skip the
  // prune until the catalog has loaded so a route to a shader uniform isn't
  // false-pruned merely because getContentMeta hasn't resolved yet.
  /** Clear every CV route that no longer resolves against the LIVE layers +
   *  combine (#60 auto-unmap). Called IMPERATIVELY right after each structural
   *  mutation (combine node/edge add/delete/retype, layer kind/content change) —
   *  the raw syncedStore proxy is NOT a Svelte reactive source, so a reactive
   *  $effect can't reliably observe an in-place node splice; an explicit call
   *  after the mutation is deterministic. Reads the LIVE patch proxy (current
   *  contents). Returns the ports it cleared. */
  function pruneOrphanRoutes(): string[] {
    const data = patch.nodes[id]?.data as
      | { layers?: ToyboxLayer[]; combine?: unknown; cvRoutes?: CvRoutes }
      | undefined;
    if (!data?.cvRoutes) return [];
    const orphans = findOrphanedRoutes(data.cvRoutes, data.layers, data.combine);
    for (const portId of orphans) clearCvRoute(id, portId);
    if (orphans.length) bumpRev();
    return orphans;
  }
  // Safety net for EXTERNAL (remote / preset) changes: when a fresh `node`
  // snapshot arrives (a rack-mate edited the tree, or a preset loaded), re-run
  // the prune. `node` is the svelte-flow snapshot wrapper — a genuine Svelte dep
  // — so this DOES fire on remote writes (unlike a deep-proxy read).
  $effect(() => {
    void node; void extRev;
    if (catalog.length === 0) return; // manifest not loaded → don't false-prune
    pruneOrphanRoutes();
  });

  /** The current route for a generic cv port (or null). */
  function routeFor(portId: string): CvRouteTarget | null {
    return cvRoutesView[portId] ?? null;
  }

  /** The selected target dropdown value for a port (encoded), '' if unrouted. */
  function targetValueFor(portId: string): string {
    const r = routeFor(portId);
    if (!r) return '';
    return encodeTargetValue(r);
  }

  /** Param options per port for its currently-selected target (live). Derived
   *  over the full route view + live layers/combine so each row updates when any
   *  route OR the underlying target's param set changes. */
  let cvParamOptionsView = $derived.by<Record<string, ReturnType<typeof listCvParams>>>(() => {
    void node; void extRev; void layersRev; // #60: recompute on layer/combine structural change
    const out: Record<string, ReturnType<typeof listCvParams>> = {};
    for (const p of CV_PORT_IDS) {
      const r = cvRoutesView[p];
      out[p] = r ? listCvParams(r, liveLayersForCv, liveCombineForCv) : [];
    }
    return out;
  });

  /** Param options for a port's currently-selected target (live). */
  function paramOptionsFor(portId: string) {
    return cvParamOptionsView[portId] ?? [];
  }

  /** Pick a target for a generic cv port. Clears the port when '' (none);
   *  otherwise sets the target + auto-selects its FIRST param so the route is
   *  immediately live (a target with no param wouldn't drive anything). */
  function onCvTargetChange(portId: string, ev: Event): void {
    const value = (ev.target as HTMLSelectElement).value;
    if (!value) {
      setCvRoute(id, portId, null);
      return;
    }
    const decoded = decodeTargetValue(value);
    if (!decoded) return;
    const params = listCvParams(decoded, liveLayersForCv, liveCombineForCv);
    const param = routeKeepParam(portId, decoded, params) ?? params[0]?.id;
    if (!param) {
      // Target has no params (e.g. an OFF layer) → clear rather than route to nothing.
      setCvRoute(id, portId, null);
      return;
    }
    setCvRoute(id, portId, { ...decoded, param });
  }

  /** If the port's existing route already targets `decoded` with a param that
   *  the new param set still contains, keep it (avoids resetting on a no-op). */
  function routeKeepParam(
    portId: string,
    decoded: { target: 'layer' | 'combine'; layer?: number; nodeId?: string },
    params: { id: string }[],
  ): string | undefined {
    const r = routeFor(portId);
    if (
      r &&
      r.target === decoded.target &&
      r.layer === decoded.layer &&
      r.nodeId === decoded.nodeId &&
      params.some((p) => p.id === r.param)
    ) {
      return r.param;
    }
    return undefined;
  }

  /** Pick a param for a generic cv port (within its current target). */
  function onCvParamChange(portId: string, ev: Event): void {
    const param = (ev.target as HTMLSelectElement).value;
    const r = routeFor(portId);
    if (!r || !param) return;
    setCvRoute(id, portId, { ...r, param });
  }

  // ── Per-input SCALE (attenuverter) + OFFSET (the modulation-shaping knobs) ──
  //
  // These live in node.data.cvInputs (a SIBLING of cvRoutes), so the OFFSET acts
  // as a manual control value even with NO route. Read live (same dependency
  // trick as cvRoutesView: iterate ALL ports in one $derived.by so every key is
  // tracked). Defaults: scale +1, offset 0 (a fresh cable modulates at once).
  let cvInputsView = $derived.by<Record<string, { scale: number; offset: number }>>(() => {
    const live = (node?.data as { cvInputs?: CvInputs } | undefined)?.cvInputs;
    const out: Record<string, { scale: number; offset: number }> = {};
    for (const p of CV_PORT_IDS) out[p] = getCvInput(live, p);
    return out;
  });
  function scaleFor(portId: string): number {
    return cvInputsView[portId]?.scale ?? DEFAULT_INPUT_SCALE;
  }
  function offsetFor(portId: string): number {
    return cvInputsView[portId]?.offset ?? DEFAULT_INPUT_OFFSET;
  }
  function onCvScaleChange(portId: string, v: number): void {
    setCvScale(id, portId, v);
  }
  function onCvOffsetChange(portId: string, v: number): void {
    setCvOffset(id, portId, v);
  }

  // ── Always-on inline scopes ──
  //
  // The CARD owns one ring buffer of recent NORMALIZED values per input. ONE
  // batched read('cvScope') per rAF (joined to the preview pull below — NO new
  // rAF loops) fills all 6 rings, then we draw each visible scope canvas. The
  // scope is always-on: when a port is unpatched it shows the OFFSET level (kind
  // 'idle'); a cv/gate/audio source shows its modulation trace (audio adds a
  // raw-waveform overlay). The kind drives the AUDIO/CV badge + the trace color.
  const SCOPE_RING = 64;
  const SCOPE_W = 84;
  const SCOPE_H = 22;
  const scopeRings = new Map<string, Float32Array>();
  const scopeCanvases = new Map<string, HTMLCanvasElement>();
  // Per-port kind, surfaced for the badge (updated each scope tick from cvScope).
  let scopeKinds = $state<Record<string, ToyboxScopeState['kind']>>({});

  function ringFor(portId: string): Float32Array {
    let r = scopeRings.get(portId);
    if (!r) { r = new Float32Array(SCOPE_RING); scopeRings.set(portId, r); }
    return r;
  }

  /** Push one normalized 0..1 sample into a port's ring (oldest→newest). */
  function pushRing(portId: string, norm: number): void {
    const r = ringFor(portId);
    r.copyWithin(0, 1);
    r[SCOPE_RING - 1] = Number.isFinite(norm) ? Math.max(0, Math.min(1, norm)) : 0;
  }

  /** Resolve a CSS custom property to a concrete color off an element (canvas
   *  strokeStyle can't take a `var()`), with a hardcoded fallback that matches
   *  the cable-color fallbacks used across the cards. */
  function resolveColor(el: HTMLElement, varName: string, fallback: string): string {
    try {
      const v = getComputedStyle(el).getPropertyValue(varName).trim();
      return v || fallback;
    } catch {
      return fallback;
    }
  }

  /** Scope colors per kind, resolved off the canvas element so they track the
   *  theme (cv, gate, audio each key off their cable color; idle is dim). */
  function scopeColorsFor(el: HTMLElement, kind: ToyboxScopeState['kind']): ToyboxScopeColors {
    const trace =
      kind === 'audio' ? resolveColor(el, '--cable-audio', '#22c55e')
      : kind === 'gate' ? resolveColor(el, '--cable-gate', '#f87171')
      : kind === 'cv' ? resolveColor(el, '--cable-cv', '#4aa')
      : resolveColor(el, '--text-dim', '#7a8a99');
    return {
      trace,
      fill: kind === 'idle' ? 'rgba(120,120,120,0.10)' : 'rgba(120,200,255,0.12)',
      wave: 'rgba(120,200,255,0.35)',
      grid: 'rgba(255,255,255,0.07)',
      bg: '#070a0e',
    };
  }

  /** The video engine's TOYBOX handle for THIS node (or null). */
  function videoHandle(): { read?: (k: string) => unknown } | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      const ve = e.getDomain<VideoEngine>('video');
      const h = (ve as unknown as { nodes?: Map<string, { read?: (k: string) => unknown }> }).nodes?.get(id);
      return h ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Drive ALL 6 scopes from ONE batched read('cvScope'): push each port's
   * normalized effective value into its ring + redraw its visible canvas. Joined
   * to the preview rAF (see draw()) — adds NO new rAF loops, no per-knob
   * readLive. Honors `frozen` (the freeze hook fills rings deterministically).
   * Guards null engine/handle + try/catch so a transient engine error never
   * nukes the preview loop. Gated on the CV rail being VISIBLE — the card's ▾
   * collapse or the face's active tab, one predicate (`cvVisible`) so a scope
   * never paints into a canvas the host has taken off screen.
   */
  function tickScopes(): void {
    if (!cvVisible || frozen) return;
    const h = videoHandle();
    let snap: ToyboxScopeSnapshot | undefined;
    try {
      snap = h?.read?.('cvScope') as ToyboxScopeSnapshot | undefined;
    } catch {
      return;
    }
    const kinds: Record<string, ToyboxScopeState['kind']> = {};
    for (const portId of CV_PORT_IDS) {
      const s = snap?.[portId];
      const kind = s?.kind ?? 'idle';
      kinds[portId] = kind;
      // Normalize `effective` back into 0..1 against the param's [min,max] so the
      // scope plots exactly like the param sweeps (matches the engine's mapping).
      let norm = offsetFor(portId);
      if (s) {
        const span = s.max - s.min;
        norm = span !== 0 ? (s.effective - s.min) / span : 0;
      }
      pushRing(portId, norm);
      drawScopeCanvas(portId, kind, s?.wave);
    }
    scopeKinds = kinds;
  }

  function drawScopeCanvas(
    portId: string,
    kind: ToyboxScopeState['kind'],
    wave?: Float32Array,
  ): void {
    const cvs = scopeCanvases.get(portId);
    if (!cvs) return;
    const ctx2d = cvs.getContext('2d', { alpha: false });
    if (!ctx2d) return;
    try {
      drawToyboxInputScope(ctx2d, {
        width: cvs.width,
        height: cvs.height,
        values: ringFor(portId),
        wave: kind === 'audio' ? wave ?? null : null,
        colors: scopeColorsFor(cvs, kind),
      });
    } catch { /* never let a draw error break the loop */ }
  }

  function registerScopeCanvas(portId: string, el: HTMLCanvasElement | null): void {
    if (el) scopeCanvases.set(portId, el);
    else scopeCanvases.delete(portId);
  }

  /** Svelte action: register a scope canvas for a port + clean up on destroy
   *  (the canvases live in an {#each}, so a plain bind:this can't key by port). */
  function registerScope(el: HTMLCanvasElement, portId: string) {
    registerScopeCanvas(portId, el);
    return {
      destroy() { registerScopeCanvas(portId, null); },
    };
  }

  /** The kind badge label for a port (drives the AUDIO/CV chip). */
  function kindBadge(portId: string): string {
    const k = scopeKinds[portId] ?? 'idle';
    return k === 'audio' ? 'AUDIO' : k === 'gate' ? 'GATE' : k === 'cv' ? 'CV' : '—';
  }

  /** VRT determinism: fill each scope ring with a deterministic sine (phase by
   *  port index + seed) so the frozen card screenshot is pixel-stable, then draw
   *  each once. Independent of any live engine signal. */
  function freezeScopes(seed: number): void {
    const kinds: Record<string, ToyboxScopeState['kind']> = {};
    CV_PORT_IDS.forEach((portId, idx) => {
      const r = ringFor(portId);
      const phase = (idx + 1) * 0.7 + seed;
      for (let i = 0; i < SCOPE_RING; i++) {
        r[i] = 0.5 + 0.4 * Math.sin((i / SCOPE_RING) * Math.PI * 2 * (idx + 1) + phase);
      }
      kinds[portId] = idx % 2 === 0 ? 'cv' : 'audio';
      drawScopeCanvas(portId, kinds[portId]);
    });
    scopeKinds = kinds;
  }

  // ───────────────────── PRESETS (Phase 6) ─────────────────────
  //
  // A dropdown of the bundled presets (manifest `presets[]`). Selecting one
  // writes its layers/combine/cvRoutes into node.data IN PLACE (the Yjs mutator
  // graph/toybox-presets.ts) so the factory renders the preset's composite next
  // frame, then PREFETCHES any GLSL/OBJ the preset references so the first paint
  // is snappy (the factory's fetch is lazy, but warming the cache avoids a black
  // flash). Exposes a debug __toyboxLoadPreset(id) hook for VRT/e2e determinism.

  let presetSel = $state('');

  // ── USER presets (#61): SAVE the live node.data to a localStorage registry, so
  // saved patches appear in the PRESET dropdown ALONGSIDE the bundled ones (the
  // `user:<id>` prefix on the option value tells onPresetChange which loader to
  // use). EXPORT/IMPORT carry the FULL state — incl. loaded videos — as a .zip.
  let userPresets = $state<ToyboxUserPreset[]>([]);
  let savingPreset = $state(false); // SAVE name input is showing
  let saveName = $state('');
  let presetError = $state<string | null>(null);
  let presetNotice = $state<string | null>(null);
  let importInputEl: HTMLInputElement | null = $state(null);

  function refreshUserPresets(): void {
    userPresets = listUserPresets();
  }

  /** Read THIS node's live data blob as PLAIN JSON (off the Yjs proxy), for save
   *  / export. Returns null if the node has no data yet. */
  function readLiveDataBlob(): Record<string, unknown> | null {
    const live = patch.nodes[id]?.data ?? node?.data;
    if (!live || typeof live !== 'object') return null;
    try {
      return JSON.parse(JSON.stringify(live)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** The node's display name (user-set node.data.name) or 'TOYBOX' — used as the
   *  default SAVE name + the EXPORT filename. */
  function nodeDisplayName(): string {
    const nm = (patch.nodes[id]?.data?.name ?? node?.data?.name) as string | undefined;
    return (typeof nm === 'string' ? nm.trim() : '') || 'TOYBOX';
  }

  /** Open the inline name input for a SAVE (defaults to the node's name). */
  function beginSavePreset(): void {
    presetError = null;
    presetNotice = null;
    saveName = nodeDisplayName();
    savingPreset = true;
  }
  function cancelSavePreset(): void {
    savingPreset = false;
    saveName = '';
  }

  /** Commit the SAVE: serialise live node.data into the localStorage registry. */
  function commitSavePreset(): void {
    const blob = readLiveDataBlob();
    if (!blob) { presetError = 'Nothing to save yet'; return; }
    const entry = saveUserPreset(saveName, blob);
    if (!entry) {
      presetError = 'Could not save (storage full or blocked)';
      return;
    }
    refreshUserPresets();
    savingPreset = false;
    saveName = '';
    presetError = null;
    presetNotice = `Saved "${entry.label}" (videos export-only)`;
  }

  /** Delete a saved user preset by id (from the SAVED list under the dropdown). */
  function removeUserPreset(presetId: string): void {
    deleteUserPreset(presetId);
    refreshUserPresets();
  }

  /** Apply a SAVED user preset by id: restore its full node.data blob in place
   *  (cvInputs incl.). Note: a saved preset has NO video bytes (localStorage
   *  can't hold them) — the layer keeps its videoName but the user must re-pick
   *  the file (or IMPORT a .zip) to see the clip again. */
  function loadUserPreset(presetId: string): boolean {
    const up = getUserPreset(presetId);
    if (!up) return false;
    return applyDataBlobToNode(id, up.data);
  }

  // ── EXPORT (#61): bundle node.data + each layer's LOADED video bytes into a
  // `.toybox.zip` and trigger a browser download.
  let exporting = $state(false);

  /** Resolve a layer's loaded video bytes from its NODE-OWNED object URL. Skips
   *  layers with no local file source (patched feeds / camera / no video).
   *
   *  Skipping is the RIGHT behaviour for a layer that has nothing to embed and
   *  the WRONG behaviour for a layer whose bytes are missing — the two are
   *  indistinguishable here by construction, which is why the caller consults
   *  `expectedVideoLayers` instead of trusting this function's silence (#1589).
   *  A ZERO-LENGTH read is treated as unresolved: an empty entry in the zip is
   *  the same lie as no entry. */
  async function resolveLayerVideos(
    blob: Record<string, unknown>,
  ): Promise<ToyboxPresetVideo[]> {
    const out: ToyboxPresetVideo[] = [];
    const layers = (blob.layers as Array<Record<string, unknown>> | undefined) ?? [];
    for (let i = 0; i < layers.length; i++) {
      const url = nodeMedia.objectUrl(id, layerVideoSlot(i));
      if (!url) continue; // no LOADED local video for this layer
      try {
        const resp = await fetch(url);
        const ab = await (await resp.blob()).arrayBuffer();
        const bytes = new Uint8Array(ab);
        if (bytes.byteLength === 0) continue;
        const name =
          layerVideoName(layers[i]) ??
          nodeMedia.mediaName(id, layerVideoSlot(i)) ??
          `layer-${i}.mp4`;
        out.push({ layer: i, name, bytes });
      } catch {
        // A torn-down / revoked URL: unresolved. The guard below turns this into
        // a LOUD refusal instead of a silently-incomplete preset.
      }
    }
    return out;
  }

  async function exportPreset(): Promise<void> {
    presetError = null;
    presetNotice = null;
    const blob = readLiveDataBlob();
    if (!blob) { presetError = 'Nothing to export yet'; return; }
    exporting = true;
    try {
      const videos = await resolveLayerVideos(blob);
      // REFUSE TO WRITE AN INCOMPLETE PRESET (#1589). Every layer the Y.Doc says
      // is a local-file video must have produced bytes; if one did not, the zip
      // would open black on the other side and the user would be told it worked.
      const missing = missingVideoLayers(
        expectedVideoLayers(blob.layers),
        videos.map((v) => v.layer),
      );
      const refusal = exportRefusalMessage(missing);
      if (refusal) { presetError = refusal; return; }
      const label = nodeDisplayName();
      const bytes = exportToyboxPreset({ data: blob, videos, label, savedAt: Date.now() });
      // Trigger a browser download of the .zip.
      const fileBlob = new Blob([bytes as unknown as BlobPart], { type: 'application/zip' });
      const url = URL.createObjectURL(fileBlob);
      const safe = label.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60) || 'TOYBOX';
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safe}.toybox.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke after the click has had a chance to start the download.
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* */ } }, 4000);
      presetNotice = `Exported ${safe}.toybox.zip${videos.length ? ` (+${videos.length} video${videos.length === 1 ? '' : 's'})` : ''}`;
    } catch (err) {
      presetError = err instanceof Error ? err.message : String(err);
    } finally {
      exporting = false;
    }
  }

  // ── IMPORT (#61): read a `.toybox.zip`, restore node.data in place, and
  // re-attach each imported video as a fresh object URL on its layer.
  let importing = $state(false);

  function triggerImport(): void {
    presetError = null;
    presetNotice = null;
    importInputEl?.click();
  }

  /** Attach imported video bytes to layer `i` as a fresh card-owned <video>
   *  (mirrors onVideoFileChange's attach path). */
  function attachImportedVideo(i: number, bytes: Uint8Array, name: string): void {
    // Prior source (url AND camera stream) is freed BY THE REGISTRY, which owns
    // the revoke + the track stop — see the VIDEO section header (#1589).
    const slot = layerVideoSlot(i);
    const el = ensureVideoEl(i); // mint first — see ensureVideoEl.
    nodeMedia.setStream(id, slot, null);
    const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
    nodeMedia.setObjectUrl(id, slot, url, name);
    el.srcObject = null;
    el.src = url;
    void el.play().catch(() => { /* autoplay may need a gesture; the import click was one */ });
    ensureVideoAttached(i);
    // Persist the source + filename (the data blob already carried videoName, but
    // be explicit so the layer's File source is selected + named consistently).
    setLayerVideoSource(id, i, 'file');
    setLayerVideoName(id, i, name);
    bumpMediaRev();
  }

  async function onImportFileChange(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    presetError = null;
    presetNotice = null;
    importing = true;
    try {
      const ab = await file.arrayBuffer();
      const bundle = importToyboxPreset(ab); // throws clear msgs on corrupt/foreign/oversized
      // Restore the data blob IN PLACE (cvInputs incl.), then re-attach videos.
      const ok = applyDataBlobToNode(id, bundle.data);
      if (!ok) { presetError = 'Could not apply imported preset'; return; }
      for (const v of bundle.videos) attachImportedVideo(v.layer, v.bytes, v.name);
      bumpRev();
      presetNotice = `Imported "${bundle.label ?? 'preset'}"${bundle.videos.length ? ` (+${bundle.videos.length} video${bundle.videos.length === 1 ? '' : 's'})` : ''}`;
    } catch (err) {
      presetError = err instanceof Error ? err.message : String(err);
    } finally {
      importing = false;
      try { input.value = ''; } catch { /* */ }
    }
  }

  onMount(() => {
    refreshUserPresets();
  });

  /** Prefetch every content shader / OBJ a preset references (warm the cache).
   *  Best-effort: failures are swallowed (the factory retries on its own). */
  function prefetchPresetAssets(preset: ToyboxPreset): void {
    for (const layer of preset.layers ?? []) {
      if ((layer.kind === 'shader' || layer.kind === 'gen' || layer.kind === 'frag') && layer.contentId) {
        void getContent(layer.contentId).catch(() => {});
      } else if (layer.kind === 'obj' && layer.material) {
        const modelId = layer.material.modelId;
        const meta = modelId ? getModelMeta(modelId) : undefined;
        // Built-in primitives have no OBJ to fetch (the factory builds them).
        if (meta?.obj) void getModelObj(modelId).catch(() => {});
      }
      // Multi-buffer project: warm each pass GLSL file (+ the Common chunk) so
      // the first compile after load doesn't stall on the network fetch.
      const ref = (layer as ToyboxLayer).projectRef;
      if (ref && Array.isArray(ref.passes)) {
        if (ref.common) void fetch(ref.common).catch(() => {});
        for (const p of ref.passes) void fetch(p.url).catch(() => {});
      }
    }
  }

  /** Load a preset by id: mutate node.data in place + prefetch its assets.
   *  Resolves true if the preset existed + applied. */
  async function loadPreset(presetId: string): Promise<boolean> {
    const ok = await loadToyboxPreset(id, presetId);
    if (ok) {
      const p = presets.find((x) => x.id === presetId);
      if (p) prefetchPresetAssets(p);
    }
    return ok;
  }

  function onPresetChange(ev: Event): void {
    const value = (ev.target as HTMLSelectElement).value;
    if (!value) return;
    presetError = null;
    presetNotice = null;
    if (value.startsWith('user:')) {
      // A SAVED user preset — restore its full node.data blob (videos export-only).
      const ok = loadUserPreset(value.slice('user:'.length));
      if (ok) bumpRev();
      else presetError = 'Saved preset not found';
    } else {
      void loadPreset(value);
    }
    // Reset the dropdown to the placeholder so re-selecting the same preset
    // re-fires (presets are "apply" actions, not a persisted selection).
    presetSel = '';
  }

  // ── RANDOMIZE (#1576, workstream 5): the dice button ──────────────────────
  // One gesture, no dialog (R15): probe what the user has patched → generate a
  // curated random patch (pure seeded engine, toybox-random.ts) → apply it in
  // ONE LOCAL_ORIGIN transact (applyDataBlobToNode), split into its own undo
  // capture so ONE Cmd-Z reverts ONE roll (R18). A session RESTORE point is
  // captured before the first roll (R22) and re-applied by the REVERT button.

  /** Archetype ids of the most recent rolls — the anti-repeat memory (R7). */
  let recentArchetypes: string[] = [];
  /** node.data as it stood BEFORE the first roll of this session (R22).
   *  null until the first roll; survives across rolls (session restore point,
   *  NOT a per-roll undo — that is the undo manager's job). */
  let preRollBlob: Record<string, unknown> | null = null;
  /** True once the restore point was captured (even if it captured null — a
   *  node with no data yet restores to "no data"; the SECOND roll must not
   *  mistake the FIRST roll's output for the pre-session state). Drives the
   *  REVERT button's visibility. */
  let preRollCaptured = $state(false);

  /** Read what the user has patched into THIS node off the live rack graph —
   *  the same inbound-edge predicate the engine factory uses (kindFor at
   *  modules/toybox.ts). READ-ONLY: a roll never creates/moves/severs cables. */
  function probeRandomContext(): ToyboxRandomContext {
    const ctx: ToyboxRandomContext = { videoIn: { inA: false, inB: false }, cv: {} };
    const edges = patch.edges as
      | Record<string, { target?: { nodeId?: string; portId?: string }; sourceType?: string } | undefined>
      | undefined;
    if (!edges) return ctx;
    for (const eid of Object.keys(edges)) {
      const e = edges[eid];
      if (!e || e.target?.nodeId !== id) continue;
      const port = e.target?.portId;
      if (port === 'inA') ctx.videoIn.inA = true;
      else if (port === 'inB') ctx.videoIn.inB = true;
      else if (port && CV_PORT_IDS.includes(port)) {
        const st = e.sourceType;
        ctx.cv[port] = st === 'audio' ? 'audio' : st === 'gate' ? 'gate' : 'cv';
      }
    }
    return ctx;
  }

  /** The node.data slice the ENGINE may read: lock flags ride the layer/node
   *  objects in here, and existing routes to locked targets are preserved
   *  from here. Plain JSON clones (never the live Y proxies). */
  function readRollCurrent(): ToyboxCurrentState {
    const live = (patch.nodes[id]?.data ?? node?.data) as
      | { layers?: unknown; combine?: unknown; cvRoutes?: unknown }
      | undefined;
    if (!live) return {};
    try {
      return JSON.parse(
        JSON.stringify({ layers: live.layers, combine: live.combine, cvRoutes: live.cvRoutes }),
      ) as ToyboxCurrentState;
    } catch {
      return {};
    }
  }

  /** Roll a new random patch and apply it atomically. `seed` is for tests /
   *  replay (__toyboxRoll); a live press mints its own. Returns the roll result
   *  (or null when the node vanished / assets are unavailable). */
  async function rollRandom(seed?: number): Promise<ToyboxRollResult | null> {
    presetError = null;
    presetNotice = null;
    // The card awaits the catalog at mount, but the button can be pressed
    // earlier; the roll needs the provider lists populated.
    try {
      await ensureToyboxCatalog();
    } catch {
      // Offline / non-browser: the registry may still hold runtime assets.
    }
    if (!preRollCaptured) {
      preRollBlob = readLiveDataBlob();
      preRollCaptured = true;
    }
    let result: ToyboxRollResult;
    try {
      result = rollToyboxPatch({
        seed,
        context: probeRandomContext(),
        // A SEEDED roll is a REPLAY (R19): it must not depend on this card's
        // press history, or a shared seed reproduces a different patch here
        // than it did for the person who shared it. Anti-repeat memory shapes
        // live presses only. (Locks DO apply to seeded rolls — a replay under
        // different locks is a different, documented, patch.)
        exclude: seed === undefined ? recentArchetypes : [],
        // Locks + preserved routes come off the CURRENT state (#1576 ws3).
        current: readRollCurrent(),
      });
    } catch {
      presetError = 'Randomize needs the content catalog (still loading?)';
      return null;
    }
    // Split the undo capture so this roll is ITS OWN Cmd-Z step, then apply in
    // one LOCAL_ORIGIN transaction (atomic: a roll lands fully or not at all).
    undoManager.stopCapturing();
    const ok = applyDataBlobToNode(id, result.blob as Record<string, unknown>);
    if (!ok) return null;
    recentArchetypes = [result.archetypeId, ...recentArchetypes].slice(0, ANTI_REPEAT_MEMORY);
    bumpRev();
    return result;
  }

  /** Re-apply the pre-session state (R22) — SCOPED to the fields a roll
   *  writes (layers/combine/cvRoutes), deleting a key that did not exist
   *  pre-roll. name/combineView/cvInputs are untouched in both directions
   *  (honest scope, R25). LOCKS are honored exactly like a roll honors them:
   *  a locked layer/node keeps its CURRENT state through the revert — locks
   *  constrain the whole dice loop, not just its forward direction. Applied
   *  as its own undo step; the restore point is KEPT so the user can roll on
   *  and come back again. */
  function revertToPreRoll(): void {
    if (!preRollCaptured) return;
    undoManager.stopCapturing();
    const merged = mergeRevertWithLocks(preRollBlob, readRollCurrent());
    const ok = restoreToyboxRollScope(id, merged);
    if (ok) {
      bumpRev();
      presetNotice = 'Restored the pre-randomize patch (locked parts kept)';
    }
  }

  // ----- Live preview pull (MANDELBULB pattern) -----
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;
  // When frozen for VRT, stop pulling so the on-card canvas matches the
  // engine's pinned-iTime FBO exactly.
  let frozen = false;

  function fitRect(cw: number, ch: number): { x: number; y: number; w: number; h: number } {
    const srcAspect = ENGINE_W / ENGINE_H;
    const dstAspect = cw / ch;
    if (dstAspect > srcAspect) {
      const h = ch;
      const w = Math.round(h * srcAspect);
      return { x: Math.round((cw - w) / 2), y: 0, w, h };
    }
    const w = cw;
    const h = Math.round(w / srcAspect);
    return { x: 0, y: Math.round((ch - h) / 2), w, h };
  }

  // ----- iMouse routing (Shadertoy click-to-paint etc.) -----
  // The preview canvas's pointer events are mapped CLIENT px → ENGINE px (via the
  // letterbox inverse, with the GL bottom-origin Y-flip) into a Shadertoy-style
  // press state machine, then pushed to the engine each frame as the iMouse vec4.
  const mouse = makeMouseState();

  /** Map a pointer event on the preview canvas to engine px (or null if it
   *  landed on the letterbox bars). Uses the canvas's CSS box → its intrinsic
   *  pixel size → the engine letterbox rect. */
  function pointerEnginePx(ev: PointerEvent): { x: number; y: number } | null {
    if (!canvasEl) return null;
    const box = canvasEl.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return null;
    // Pointer in the canvas's INTRINSIC pixel space (CANVAS_W × CANVAS_H).
    const cx = ((ev.clientX - box.left) / box.width) * canvasEl.width;
    const cy = ((ev.clientY - box.top) / box.height) * canvasEl.height;
    const rect = fitRect(canvasEl.width, canvasEl.height);
    return canvasToEnginePx(cx, cy, rect, ENGINE_W, ENGINE_H);
  }

  /** Push the current iMouse vec4 to the engine for THIS node (called each rAF
   *  + on every pointer event so a click is never missed between frames). */
  function pushMouse(): void {
    const e = engineCtx.get();
    if (!e) return;
    let ve: VideoEngine | undefined;
    try { ve = e.getDomain<VideoEngine>('video'); } catch { return; }
    if (!ve || typeof ve.setMouse !== 'function') return;
    const v = mouseToVec4(mouse);
    ve.setMouse(id, v[0], v[1], v[2], v[3]);
  }

  function onCanvasPointerDown(ev: PointerEvent): void {
    const p = pointerEnginePx(ev);
    if (!p) return;
    try { canvasEl?.setPointerCapture(ev.pointerId); } catch { /* */ }
    mouseDown(mouse, p.x, p.y);
    pushMouse();
  }
  function onCanvasPointerMove(ev: PointerEvent): void {
    const p = pointerEnginePx(ev);
    if (!p) return;
    mouseMove(mouse, p.x, p.y);
    pushMouse();
  }
  function onCanvasPointerUp(ev: PointerEvent): void {
    try { canvasEl?.releasePointerCapture(ev.pointerId); } catch { /* */ }
    mouseUp(mouse);
    pushMouse();
  }

  /**
   * Pull this node's output into the on-card 2D canvas.
   *
   * `immediate` distinguishes the TWO callers, and the distinction is
   * load-bearing (#1836):
   *
   *   * `draw()` — the free-running rAF loop. A refused repaint costs nothing:
   *     the next rAF is 8-16 ms away and carries the picture. THROTTLED.
   *   * `__toyboxFreeze(t)` — render ONE pinned frame and present THAT frame.
   *     There is no next rAF (the hook sets `frozen = true`, which is what
   *     stops `draw()`), so a refused repaint does not defer the frame, it
   *     LOSES it and the canvas keeps showing an older render indefinitely.
   *     MEASURED: with the cap applied here, the LAYER INPUT feedback tap
   *     presented 2 of 12 rendered frames and the card showed feedback
   *     iteration 2 while the engine was on iteration 12. IMMEDIATE.
   */
  function blitOnce(opts?: PreviewBlitOptions): void {
    const e = engineCtx.get();
    if (!e || !canvasEl) return;
    let videoEngine: VideoEngine | undefined;
    try {
      videoEngine = e.getDomain<VideoEngine>('video');
    } catch {
      return;
    }
    if (!videoEngine) return;
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (!ctx2d) return;
    // #1802 — gated preview blit (see VideoEngine.blitOutputForPreview). This
    // is `blitOnce()`, called from draw() AFTER pushMouse(); returning here
    // therefore skips only the paint, never the iMouse push (which must run
    // every frame so a Shadertoy click-frame sign is consumed) and never the
    // scope tick that follows.
    let blitted = false;
    try {
      blitted = videoEngine.blitOutputForPreview(id, opts);
    } catch {
      // Don't let engine errors nuke the rAF loop.
    }
    if (!blitted) return;
    const src = videoEngine.canvas as CanvasImageSource;
    const cw = canvasEl.width;
    const ch = canvasEl.height;
    ctx2d.fillStyle = '#050608';
    ctx2d.fillRect(0, 0, cw, ch);
    const r = fitRect(cw, ch);
    drawPreviewDownscaled(ctx2d, src, r.x, r.y, r.w, r.h);
  }

  /**
   * Renew this node's WATCH MARK, whatever the screen is doing.
   *
   * ⚠ THE LOAD-BEARING HALF OF THE SCREEN SWITCH (#2015 / the fleet ruling).
   * On the blit path the mark is a SIDE EFFECT of painting: `blitOutputForPreview`
   * calls `markWatched` only when it decides to blit. So a face whose screen is
   * OFF — which skips the blit — would let the mark lapse, `computePullActiveSet`
   * would drop the node, and the engine would stop advancing the composite.
   *
   * That is not merely "no picture while it is off". TOYBOX's combine roster
   * includes FEEDBACK, FRAMEDELAY, EXQUISITE and DATAMOSH, every one of which
   * carries HISTORY between frames, and `out` is a real cable other modules
   * sample. A lapsed mark would freeze what every downstream consumer sees and
   * bring the picture back black or stale when the screen came on again — the
   * collapse-kills-the-producer class (#1721, #1728).
   *
   * Card layout does NOT call this, deliberately: the legacy card has no screen
   * switch, always blits, and its lane visibility is what `setCardVisibility`
   * is for. Marking unconditionally there would put a scrolled-away card's node
   * back into the pull set and change engine behaviour the extraction has no
   * business changing.
   */
  function renewWatchMark(): void {
    const e = engineCtx.get();
    if (!e) return;
    try {
      e.getDomain<VideoEngine>('video')?.markWatched?.(id);
    } catch {
      // Engine not ready / no video domain — the next rAF tries again.
    }
  }

  function draw() {
    rafId = requestAnimationFrame(draw);
    if (frozen) return; // hold the last frame (VRT)
    // Advance + push the iMouse vec4 each frame so the Shadertoy .w click-frame
    // sign is consumed (and a held .z sign keeps refreshing) even with no events.
    pushMouse();
    // SCREEN OFF skips the BLIT — a GL readback into a surface nobody can see —
    // and nothing else. See `renewWatchMark`: the node stays a pull root.
    renewWatchMark();
    if (screenOn) blitOnce();
    // Drive all 6 inline scopes from ONE batched read('cvScope') — joined to
    // THIS rAF (after blitOnce), no separate loop, no per-knob readLive.
    // (Its own `cvVisible` guard is what makes an inactive tab cost nothing.)
    tickScopes();
  }

  // Fix E Phase 2 — reactive data sync to the render worker.
  // When node.data changes (layers/combine/cvRoutes edited in the UI), send a
  // serialized snapshot to the worker-side TOYBOX handler via
  // VideoEngine.syncNodeData → bridge.sendToyboxSync → MsgToyboxSync.
  // The effect re-runs whenever patch.nodes[id]?.data changes (Svelte 5 tracks
  // the reactive read). A no-op when the worker flag is off or the worker isn't
  // active for this node (syncNodeData is safe to call unconditionally).
  $effect(() => {
    const liveData = patch.nodes[id]?.data;
    if (!liveData) return;
    // Serialize to plain JSON so the structured-clone in postMessage is
    // deterministic and Y.Doc proxies are stripped out.
    let plain: unknown;
    try { plain = JSON.parse(JSON.stringify(liveData)); } catch { return; }
    const e = engineCtx.get();
    if (!e) return;
    try {
      const ve = e.getDomain<VideoEngine>('video');
      ve.syncNodeData(id, plain);
    } catch { /* engine not ready yet */ }
  });

  onMount(() => {
    rafId = requestAnimationFrame(draw);
    // ADOPT WHAT THE NODE ALREADY HAS (#1589). A remount — re-expand, an LRU
    // eviction reversing, a navigation back — finds every layer's <video> still
    // parked and still playing. Re-assert the engine attachment for each one
    // (idempotent) so the uploader is wired even if the engine node was itself
    // rebuilt while no card was mounted, and rehydrate the reactive
    // "are the bytes loaded?" read from the registry rather than from $state
    // this instance never had.
    for (let i = 0; i < LAYER_COUNT; i++) {
      if (peekVideoEl(i)) ensureVideoAttached(i);
    }
    bumpMediaRev();
    // VRT debug hook: pin the engine-side iTime to `time` (constant) so the
    // shader render is deterministic, blit once with the new frozen frame,
    // then pause the preview pull. Call with no/undefined arg to resume.
    const g = globalThis as unknown as {
      __toyboxFreeze?: (time?: number, seed?: number) => void;
      __toyboxFreezeTime?: number | null;
      __toyboxLoadPreset?: (presetId: string) => Promise<boolean>;
      __toyboxRoll?: (seed?: number) => Promise<ToyboxRollResult | null>;
    };
    // VRT/e2e determinism hook: load a bundled preset by id into THIS node's
    // data (in place) + prefetch its assets. Returns the apply verdict.
    g.__toyboxLoadPreset = (presetId: string) => loadPreset(presetId);
    // e2e determinism hook (#1576): roll the dice with an explicit seed so CI
    // and bug reports can replay a roll exactly (R19/R24). Same code path as
    // the button — probe, generate, one-transact apply.
    g.__toyboxRoll = (seed?: number) => rollRandom(seed);
    // e2e audit hook: the engine's DIM content list, so the catalog audit in
    // toybox-randomize.spec.ts can assert BOTH directions (every under-floor
    // GEN is listed; every listed entry is actually under floor) against the
    // ONE list the dice actually consult.
    (g as { __toyboxDimGen?: string[] }).__toyboxDimGen = [...DIM_GEN_CONTENT.keys()];
    g.__toyboxFreeze = (time?: number, seed?: number) => {
      if (typeof time === 'number') {
        g.__toyboxFreezeTime = time;
        // Force the engine to render one frame at the pinned time, then
        // pull it into the on-card canvas, then freeze the preview.
        const e = engineCtx.get();
        try { e?.getDomain<VideoEngine>('video')?.step(); } catch { /* */ }
        // ONE-SHOT PRESENT: we just rendered THIS frame and `frozen = true`
        // below stops the rAF loop, so nothing will repaint after us. The
        // preview cadence cap must not eat it (#1836).
        blitOnce({ immediate: true });
        // Fill the 6 scope rings DETERMINISTICALLY from `seed` so the scopes are
        // pixel-stable for VRT (a sine per port, phase-offset by the port index
        // + seed). Then draw each once. frozen=true stops tickScopes after this.
        freezeScopes(seed ?? 0);
        frozen = true;
      } else {
        g.__toyboxFreezeTime = null;
        frozen = false;
      }
    };
  });
  onDestroy(() => {
    // CARD-LOCAL MACHINERY ONLY. This runs on a COLLAPSE, an ESC, a dock LRU
    // eviction and a navigation just as much as on a node deletion, and it
    // cannot tell them apart — so nothing whose lifetime is the NODE's may be
    // touched here.
    //
    // What is deliberately ABSENT, and was the whole of #1589: no
    // `attachLayerVideo(i, null)`, no `URL.revokeObjectURL`, no
    // `pause()/srcObject=null/removeAttribute('src')/load()`, and no
    // `track.stop()`. The elements, urls and camera streams belong to
    // $lib/ui/media/node-media-registry and are freed by `nodeMedia.sweep(...)`
    // from Canvas when the node leaves the GRAPH — by ANY route: the menu, a
    // lasso delete, undo, a peer's CRDT delete, Clear, a patch load.
    // `card-media-lifetime.test.ts` fails the build if any of them returns.
    if (rafId !== null) cancelAnimationFrame(rafId);
    for (const t of videoAttachTimers.values()) clearTimeout(t);
    videoAttachTimers.clear();
  });
</script>


<!-- ═══════════════════════════════════════════════════════════════════════
     ZONE SNIPPETS — the five parts of the console, defined ONCE.

     Both hosts render THESE. `layout` chooses the order and the wrappers and
     nothing else, so a control cannot exist on the card and be missing from
     the faceplate (or the reverse) without deleting it from this file.
     ═══════════════════════════════════════════════════════════════════════ -->

{#snippet screenZone()}
  <div class="screen-wrap face">
    <!-- The fleet-conventional `<prefix>-face-canvas`, which is what
         face-screen-render-suite looks for when it proves the SCREEN switch
         REMOVES the picture and reclaims the space. -->
    <canvas
      bind:this={canvasEl}
      width={CANVAS_W}
      height={CANVAS_H}
      data-testid="toybox-face-canvas"
      data-node-id={id}
      style="touch-action: none;"
      onpointerdown={onCanvasPointerDown}
      onpointermove={onCanvasPointerMove}
      onpointerup={onCanvasPointerUp}
      onpointercancel={onCanvasPointerUp}
    ></canvas>
  </div>
{/snippet}

{#snippet presetZone()}
  <!-- PRESETS (Phase 6 + #61): pick a BUNDLED or a SAVED user preset → writes
       node.data in place. SAVE the live patch to a localStorage registry;
       EXPORT/IMPORT carry the FULL patch (incl. loaded videos) as a .toybox.zip.
       Loading a preset is an "apply" action (the select resets to placeholder). -->
  <div class="preset-section" data-testid="toybox-preset-section">
    <div class="content-row">
      <label class="content-label" for={`toybox-preset-${id}`}>PRESET</label>
      <select
        id={`toybox-preset-${id}`}
        class="content-select"
        data-testid="toybox-preset-select"
        value={presetSel}
        onchange={onPresetChange}
      >
        <option value="">— load preset… —</option>
        {#if userPresets.length > 0}
          <optgroup label="Saved">
            {#each userPresets as up (up.id)}
              <option value={`user:${up.id}`}>★ {up.label}</option>
            {/each}
          </optgroup>
        {/if}
        {#if presets.length > 0}
          <optgroup label="Bundled">
            {#each presets as p (p.id)}
              <option value={p.id}>{p.label}</option>
            {/each}
          </optgroup>
        {/if}
      </select>
    </div>

    <!-- SAVE / EXPORT / IMPORT actions -->
    {#if savingPreset}
      <div class="preset-save-row" data-testid="toybox-preset-save-row">
        <input
          class="preset-name-input"
          type="text"
          data-testid="toybox-preset-name-input"
          placeholder="Preset name"
          bind:value={saveName}
          onkeydown={(e) => { if (e.key === 'Enter') commitSavePreset(); else if (e.key === 'Escape') cancelSavePreset(); }}
        />
        <button
          type="button"
          class="preset-btn"
          data-testid="toybox-preset-save-confirm"
          onclick={commitSavePreset}
        >OK</button>
        <button
          type="button"
          class="preset-btn ghost"
          data-testid="toybox-preset-save-cancel"
          onclick={cancelSavePreset}
        >✕</button>
      </div>
    {:else}
      <div class="preset-actions" data-testid="toybox-preset-actions">
        <button
          type="button"
          class="preset-btn"
          data-testid="toybox-randomize"
          aria-label="randomize patch"
          title="Roll a new random patch (uses whatever you have patched in; Cmd-Z undoes a roll)"
          onclick={() => void rollRandom()}
        >🎲 RANDOM</button>
        {#if preRollCaptured}
          <button
            type="button"
            class="preset-btn"
            data-testid="toybox-randomize-revert"
            aria-label="restore pre-randomize patch"
            title="Restore the patch as it was before the first roll of this session"
            onclick={revertToPreRoll}
          >REVERT</button>
        {/if}
        <button
          type="button"
          class="preset-btn"
          data-testid="toybox-preset-save"
          onclick={beginSavePreset}
        >SAVE</button>
        <button
          type="button"
          class="preset-btn"
          data-testid="toybox-preset-export"
          disabled={exporting}
          onclick={() => void exportPreset()}
        >{exporting ? 'EXPORT…' : 'EXPORT'}</button>
        <button
          type="button"
          class="preset-btn"
          data-testid="toybox-preset-import"
          disabled={importing}
          onclick={triggerImport}
        >{importing ? 'IMPORT…' : 'IMPORT'}</button>
        <input
          bind:this={importInputEl}
          type="file"
          accept=".zip"
          class="visually-hidden"
          data-testid="toybox-preset-import-input"
          onchange={onImportFileChange}
        />
      </div>
    {/if}

    {#if presetError}
      <div class="input-error" data-testid="toybox-preset-error">{presetError}</div>
    {/if}
    {#if presetNotice}
      <div class="sync-hint" data-testid="toybox-preset-notice">{presetNotice}</div>
    {/if}

    <!-- Saved-preset manage list (delete) — only when the user has saved some. -->
    {#if userPresets.length > 0}
      <ul class="preset-saved-list" data-testid="toybox-preset-saved-list">
        {#each userPresets as up (up.id)}
          <li class="preset-saved-item" data-testid={`toybox-preset-saved-${up.id}`}>
            <span class="preset-saved-name" title={up.label}>★ {up.label}</span>
            <button
              type="button"
              class="preset-btn ghost preset-del"
              data-testid={`toybox-preset-delete-${up.id}`}
              title={`Delete "${up.label}"`}
              onclick={() => removeUserPreset(up.id)}
            >✕</button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/snippet}

{#snippet layerZone()}
  <!-- LAYER-INDEX selector: a tab per layer (1-indexed labels, 0-indexed state).
       Picks which of node.data.layers[] every control below edits. A populated
       layer (kind !== 'off') shows a dot so empties are visible at a glance. -->
  <div class="layer-tabs" data-testid="toybox-layer-tabs" role="tablist" aria-label="layer selector">
    {#each Array(LAYER_COUNT) as _, i (i)}
      <button
        type="button"
        class="layer-tab {activeLayer === i ? 'active' : ''}"
        data-testid={`toybox-layer-tab-${i}`}
        data-active={activeLayer === i}
        data-populated={layerPopulated[i]}
        role="tab"
        aria-selected={activeLayer === i}
        title={`LAYER ${i + 1}${layerPopulated[i] ? ' (populated)' : ' (empty)'}`}
        onclick={() => selectLayer(i)}
      >
        L{i + 1}
        {#if layerPopulated[i]}<span class="layer-dot" data-testid={`toybox-layer-dot-${i}`}></span>{/if}
      </button>
      <!-- LOCK toggle (#1576 ws3): randomize treats a locked layer as a fixed
           constraint (byte-identical across rolls, kept through REVERT).
           Locks the DICE only — manual edits and cv modulation stay allowed. -->
      <button
        type="button"
        class="layer-lock {layerLocked[i] ? 'locked' : ''}"
        data-testid={`toybox-layer-lock-${i}`}
        aria-pressed={layerLocked[i]}
        aria-label={`lock layer ${i + 1} against randomize`}
        title={layerLocked[i]
          ? `LAYER ${i + 1} is LOCKED — randomize and revert keep it as-is`
          : `Lock LAYER ${i + 1} so randomize cannot change it`}
        onclick={() => { setLayerLocked(id, i, !layerLocked[i]); bumpRev(); }}
      >{layerLocked[i] ? '🔒' : '🔓'}</button>
    {/each}
  </div>

  <!-- LAYER KIND selector: shader/gen (content) vs OBJ (3D mesh) vs OFF. Edits
       the kind of the ACTIVE layer (the tab selected above). -->
  <div class="content-row">
    <label class="content-label" for={`toybox-kind-${id}`}>KIND</label>
    <select
      id={`toybox-kind-${id}`}
      class="content-select"
      data-testid="toybox-kind-select"
      value={kindSelectValue}
      onchange={onKindChange}
    >
      <option value="gen">GEN</option>
      <option value="frag">FRAG</option>
      <option value="obj">OBJ</option>
      <option value="image">IMAGE</option>
      <option value="video">VIDEO</option>
      <option value="off">OFF</option>
    </select>
  </div>

  {#if currentKind === 'off'}
    <!-- Empty layer: prompt the user to pick a kind (choosing one initialises
         the layer's content via setLayerKind). -->
    <div class="layer-empty" data-testid="toybox-layer-empty">
      LAYER {activeLayer + 1} is empty — pick a KIND above
    </div>
  {/if}

  {#if isObj}
    <!-- OBJ layer: model dropdown + matcap + transform/spin/tint controls. -->
    <div class="content-row">
      <label class="content-label" for={`toybox-model-${id}`}>MODEL</label>
      <select
        id={`toybox-model-${id}`}
        class="content-select"
        data-testid="toybox-model-select"
        value={currentModelId}
        onchange={onModelChange}
      >
        {#each models as m (m.id)}
          <option value={m.id}>{m.label}</option>
        {/each}
      </select>
    </div>
    <!-- CUSTOM OBJ: load a Wavefront .obj from disk. The text rides the Y.Doc
         (survives reload + exports + rack-mates parse it); the engine prefers it
         over the MODEL dropdown above. -->
    <div class="input-picker" data-testid="toybox-obj-picker">
      <label class="pick-btn">
        <input
          type="file"
          accept=".obj,text/plain"
          data-testid="toybox-obj-input"
          onchange={onObjFileChange}
        />
        <span>{inputLoading ? 'Loading…' : 'Load OBJ…'}</span>
      </label>
      {#if currentObjName}
        <div class="filename" title={currentObjName} data-testid="toybox-obj-filename">{currentObjName}</div>
      {/if}
      {#if currentObjSrc}
        <div class="sync-hint" data-testid="toybox-obj-synced">custom OBJ active (synced)</div>
        <button
          type="button"
          class="clear-btn"
          data-testid="toybox-obj-clear"
          onclick={onClearObj}
        >Use bundled model</button>
      {/if}
      {#if inputError}
        <div class="input-error" data-testid="toybox-input-error">{inputError}</div>
      {/if}
    </div>
    <div class="content-row">
      <label class="content-label" for={`toybox-matcap-${id}`}>MATCAP</label>
      <select
        id={`toybox-matcap-${id}`}
        class="content-select"
        data-testid="toybox-matcap-select"
        value={String(currentMaterial.matcap)}
        onchange={onMatcapChange}
      >
        {#each Array(MATCAP_STYLES) as _, i (i)}
          <option value={String(i)}>{MATCAP_LABELS[i] ?? `STYLE ${i}`}</option>
        {/each}
      </select>
    </div>
    <!-- SURFACE source: MATCAP (default) or another layer's rendered output
         UV-mapped onto the mesh. We offer every layer EXCEPT the active one (a
         layer can't texture itself — the engine guards self/cycle anyway). The
         option VALUE is the 0-indexed layer index; the LABEL is 1-indexed to
         match the LAYER tabs. -->
    <div class="content-row">
      <label class="content-label" for={`toybox-surface-${id}`}>SURFACE</label>
      <select
        id={`toybox-surface-${id}`}
        class="content-select"
        data-testid="toybox-surface-select"
        value={String(currentMaterial.surfaceSource ?? -1)}
        onchange={onSurfaceChange}
      >
        <option value="-1">MATCAP</option>
        <!-- LAYER INPUT (-2): UV-map whatever node output is wired into this
             layer's combine source (the feedback tap). The engine supports the
             LAYER_INPUT_SOURCE sentinel (toybox-surface.ts surfaceTextureSource);
             this is the UI affordance that lets an OBJ select it. -->
        <option value={String(LAYER_INPUT_SOURCE)}>LAYER INPUT</option>
        {#each Array(LAYER_COUNT) as _, i (i)}
          {#if i !== activeLayer}
            <option value={String(i)}>LAYER {i + 1}</option>
          {/if}
        {/each}
      </select>
    </div>

    {#if hasSurfaceSource}
      <!-- SURFACE MODE: how the source maps onto the mesh — UV (sample by the
           mesh's own UVs, the default) vs PROJECTIVE (project from a viewpoint:
           the "video projector aimed at geometry" / projection-mapping look). -->
      <div class="content-row">
        <label class="content-label" for={`toybox-surfmode-${id}`}>MAP</label>
        <select
          id={`toybox-surfmode-${id}`}
          class="content-select"
          data-testid="toybox-surfmode-select"
          value={surfaceMode}
          onchange={onSurfaceModeChange}
        >
          <option value="uv">UV</option>
          <option value="projective">PROJECTIVE</option>
        </select>
      </div>

      {#if surfaceMode === 'projective'}
        <!-- Projector controls: USE CAMERA pins the projector to the render
             viewpoint ("painted on from the viewer"); otherwise the explicit
             pos/dir/fov knobs aim a projector at the mesh. -->
        <div class="content-row">
          <label class="proj-camera-label">
            <input
              type="checkbox"
              data-testid="toybox-proj-usecamera"
              checked={projUseCamera}
              onchange={onProjUseCameraChange}
            />
            <span>USE CAMERA</span>
          </label>
        </div>
        {#if !projUseCamera}
          <div class="knob-grid" data-testid="toybox-proj-controls">
            <Knob value={matVal('projPosX')} min={-5} max={5} defaultValue={0}
              label="POS X" curve="linear" onchange={setMat('projPosX')} moduleId={id} paramId={layerParam('projPosX')} testid={knobTestid(layerParam('projPosX'))} />
            <Knob value={matVal('projPosY')} min={-5} max={5} defaultValue={0}
              label="POS Y" curve="linear" onchange={setMat('projPosY')} moduleId={id} paramId={layerParam('projPosY')} testid={knobTestid(layerParam('projPosY'))} />
            <Knob value={matVal('projPosZ')} min={-5} max={5} defaultValue={2.5}
              label="POS Z" curve="linear" onchange={setMat('projPosZ')} moduleId={id} paramId={layerParam('projPosZ')} testid={knobTestid(layerParam('projPosZ'))} />
            <Knob value={matVal('projDirX')} min={-1} max={1} defaultValue={0}
              label="DIR X" curve="linear" onchange={setMat('projDirX')} moduleId={id} paramId={layerParam('projDirX')} testid={knobTestid(layerParam('projDirX'))} />
            <Knob value={matVal('projDirY')} min={-1} max={1} defaultValue={0}
              label="DIR Y" curve="linear" onchange={setMat('projDirY')} moduleId={id} paramId={layerParam('projDirY')} testid={knobTestid(layerParam('projDirY'))} />
            <Knob value={matVal('projDirZ')} min={-1} max={1} defaultValue={-1}
              label="DIR Z" curve="linear" onchange={setMat('projDirZ')} moduleId={id} paramId={layerParam('projDirZ')} testid={knobTestid(layerParam('projDirZ'))} />
            <Knob value={matVal('projFov') || 0.8726646} min={0.2} max={2.6} defaultValue={0.8726646}
              label="FOV" curve="linear" onchange={setMat('projFov')} moduleId={id} paramId={layerParam('projFov')} testid={knobTestid(layerParam('projFov'))} />
          </div>
        {/if}
      {/if}
    {/if}

    <div class="knob-grid" data-testid="toybox-controls">
      <Knob value={matVal('rotX')} min={-3.14159} max={3.14159} defaultValue={0.3}
        label="ROT X" curve="linear" onchange={setMat('rotX')} moduleId={id} paramId={layerParam('rotX')} testid={knobTestid(layerParam('rotX'))} />
      <Knob value={matVal('rotY')} min={-3.14159} max={3.14159} defaultValue={0.6}
        label="ROT Y" curve="linear" onchange={setMat('rotY')} moduleId={id} paramId={layerParam('rotY')} testid={knobTestid(layerParam('rotY'))} />
      <Knob value={matVal('rotZ')} min={-3.14159} max={3.14159} defaultValue={0}
        label="ROT Z" curve="linear" onchange={setMat('rotZ')} moduleId={id} paramId={layerParam('rotZ')} testid={knobTestid(layerParam('rotZ'))} />
      <Knob value={matVal('scale')} min={0.25} max={3} defaultValue={1}
        label="SCALE" curve="linear" onchange={setMat('scale')} moduleId={id} paramId={layerParam('scale')} testid={knobTestid(layerParam('scale'))} />
      <Knob value={matVal('spin')} min={0} max={3} defaultValue={0.4}
        label="SPIN" curve="linear" onchange={setMat('spin')} moduleId={id} paramId={layerParam('spin')} testid={knobTestid(layerParam('spin'))} />
      <Knob value={matVal('tintR')} min={0} max={1} defaultValue={1}
        label="TINT R" curve="linear" onchange={setMat('tintR')} moduleId={id} paramId={layerParam('tintR')} testid={knobTestid(layerParam('tintR'))} />
      <Knob value={matVal('tintG')} min={0} max={1} defaultValue={1}
        label="TINT G" curve="linear" onchange={setMat('tintG')} moduleId={id} paramId={layerParam('tintG')} testid={knobTestid(layerParam('tintG'))} />
      <Knob value={matVal('tintB')} min={0} max={1} defaultValue={1}
        label="TINT B" curve="linear" onchange={setMat('tintB')} moduleId={id} paramId={layerParam('tintB')} testid={knobTestid(layerParam('tintB'))} />
      <Knob value={surfaceMixVal()} min={0} max={1} defaultValue={1}
        label="SURF MIX" curve="linear" onchange={setMat('surfaceMix')} moduleId={id} paramId={layerParam('surfaceMix')} testid={knobTestid(layerParam('surfaceMix'))} />
    </div>
  {:else if currentKind === 'gen' || currentKind === 'shader' || currentKind === 'frag'}
    <div class="content-row">
      <label class="content-label" for={`toybox-content-${id}`}>CONTENT</label>
      <select
        id={`toybox-content-${id}`}
        class="content-select"
        data-testid="toybox-content-select"
        value={currentContentId}
        onchange={onContentChange}
      >
        {#each contentChoices as c (c.id)}
          <option value={c.id}>{c.family} · {c.label}</option>
        {/each}
      </select>
    </div>
    {#if currentKind === 'frag'}
      <div class="frag-hint" data-testid="toybox-frag-hint">
        FRAG receives the layer below as iChannel0
      </div>
    {/if}

    <!-- CUSTOM SHADER: load a GLSL (.glsl/.frag/.txt) from disk. The source rides
         the Y.Doc (survives reload + exports + rack-mates compile it); the engine
         prefers it over the CONTENT dropdown above. -->
    <div class="input-picker" data-testid="toybox-shader-picker">
      <label class="pick-btn">
        <input
          type="file"
          accept=".glsl,.frag,.txt,text/plain"
          data-testid="toybox-shader-input"
          onchange={onShaderFileChange}
        />
        <span>{inputLoading ? 'Loading…' : 'Load shader…'}</span>
      </label>
      {#if currentShaderName}
        <div class="filename" title={currentShaderName} data-testid="toybox-shader-filename">{currentShaderName}</div>
      {/if}
      {#if currentShaderSrc}
        <div class="sync-hint" data-testid="toybox-shader-synced">custom shader active (synced)</div>
        <button
          type="button"
          class="clear-btn"
          data-testid="toybox-shader-clear"
          onclick={onClearShader}
        >Use bundled shader</button>
      {/if}
      {#if inputError}
        <div class="input-error" data-testid="toybox-input-error">{inputError}</div>
      {/if}
    </div>

    <div class="knob-grid" data-testid="toybox-controls">
      {#if currentMeta}
        {#each currentMeta.params as p (p.id)}
          <Knob
            value={paramVal(p.id)}
            min={p.min} max={p.max} defaultValue={p.default}
            label={p.label} curve={p.curve}
            onchange={setParam(p.id)} moduleId={id} paramId={layerParam(p.id)} testid={knobTestid(layerParam(p.id))}
          />
        {/each}
      {/if}
    </div>
  {:else if currentKind === 'image'}
    <!-- IMAGE layer: file picker (PICTUREBOX-style). Bytes ride the Y.Doc so
         rack-mates see the same picture; each peer decodes + uploads. -->
    <div class="input-picker" data-testid="toybox-image-picker">
      <label class="pick-btn">
        <input
          type="file"
          accept="image/*"
          data-testid="toybox-image-input"
          onchange={onImageFileChange}
        />
        <span>{inputLoading ? 'Loading…' : 'Choose image…'}</span>
      </label>
      {#if currentImageName}
        <div class="filename" title={currentImageName} data-testid="toybox-image-filename">{currentImageName}</div>
      {/if}
      {#if currentImageBytes}
        <div class="sync-hint" data-testid="toybox-image-synced">synced ({SYNC_IMG_W}×{SYNC_IMG_H})</div>
      {/if}
      {#if inputError}
        <div class="input-error" data-testid="toybox-input-error">{inputError}</div>
      {/if}
    </div>
  {:else if currentKind === 'video'}
    <!-- VIDEO layer. The SOURCE selector picks where the texture comes from:
         In A / In B = a PATCHED FEED off the inA/inB video input ports (the
         cable provides it — no local file); File = a card-owned local <video>
         (VIDEOBOX-style; only the filename rides the Y.Doc); Camera = the
         device webcam streamed into the same per-layer uploader. -->
    <div class="input-picker" data-testid="toybox-video-picker">
      <div class="content-row">
        <label class="content-label" for={`toybox-video-source-${id}`}>SOURCE</label>
        <select
          id={`toybox-video-source-${id}`}
          class="content-select"
          data-testid="toybox-video-source-select"
          value={currentVideoSource}
          onchange={onVideoSourceChange}
        >
          <option value="inA">In A</option>
          <option value="inB">In B</option>
          <option value="file">File</option>
          <option value="camera">Camera</option>
        </select>
      </div>

      {#if currentVideoSource === 'file'}
        <label class="pick-btn">
          <input
            type="file"
            accept="video/*"
            data-testid="toybox-video-input"
            onchange={onVideoFileChange}
          />
          <span>Choose video…</span>
        </label>
        {#if currentVideoName}
          <div
            class="filename"
            title={currentVideoName}
            data-testid="toybox-video-filename"
            data-has-local-file={activeVideoLoaded ? 'true' : 'false'}
          >{currentVideoName}</div>
          <!-- The NAME rides the Y.Doc; the BYTES do not. A reload, a saved
               preset or a rack-mate's write gives you the first without the
               second, and #1589 showed that a card claiming "loaded" while
               rendering nothing is worse than one that says what it needs. -->
          {#if activeVideoLoaded}
            <div class="sync-hint" data-testid="toybox-video-local">local file (not synced)</div>
          {:else}
            <div class="input-error" data-testid="toybox-video-relink">
              not loaded in this session — re-pick the file to see it (export is blocked until you do)
            </div>
          {/if}
        {/if}
      {:else if currentVideoSource === 'camera'}
        <button
          type="button"
          class="pick-btn cam-btn"
          data-testid="toybox-video-camera"
          onclick={() => startCamera(activeLayer)}
        >Start camera</button>
        <div class="sync-hint" data-testid="toybox-video-camera-hint">webcam (local, not synced)</div>
      {:else}
        <!-- In A / In B: the patch cable provides the feed; nothing to pick. -->
        <div class="sync-hint" data-testid="toybox-video-patched">
          patched feed — wire a video source into {currentVideoSource === 'inA' ? 'VID A' : 'VID B'}
        </div>
      {/if}

      {#if inputError}
        <div class="input-error" data-testid="toybox-input-error">{inputError}</div>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet combineZone()}
  <!-- ───────── COMBINE GRAPH EDITOR (Phase 4) ───────── -->
  <div class="combine-section" data-testid="toybox-combine-section">
    <!-- ⚠ NO PER-SECTION COLLAPSE HERE. The TAB RAIL is this control — a tab
         shows one section and hides the others, which is what a ▾ toggle does
         with one press instead of two — and two hide-controls for one panel
         would strand each other. `editorVisible` is the ONE predicate. -->

    {#if editorVisible}
      <!-- Add-node menu: insert a fade / lumakey / chromakey / map op. -->
      <div class="add-row" data-testid="toybox-add-row">
        <span class="add-label">ADD</span>
        {#each OP_KINDS as k (k)}
          <button
            type="button"
            class="add-btn"
            data-testid={`toybox-add-${k}`}
            onclick={() => onAddOp(k)}
          >{k}</button>
        {/each}
      </div>

      {#if connectMsg}
        <div class="connect-msg" data-testid="toybox-connect-msg">{connectMsg}</div>
      {/if}
      {#if pendingFrom}
        <div class="connect-msg armed" data-testid="toybox-pending">
          armed: {pendingFrom} → click an input dot
        </div>
      {/if}

      <!-- Bespoke SVG node editor: boxes + port dots + bezier cables. The wrap is
           user-resizable (drag the bottom edge); the height persists in
           node.data.combineView so it survives reload + preset round-trip. -->
      <div
        class="graph-wrap"
        data-testid="toybox-graph-wrap"
        style={`height: ${combineViewH}px;`}
        use:persistResize
      >
        <!-- svelte-ignore a11y_no_static_element_interactions — the combine-graph editor is
             pointer-only by construction and making it keyboard-operable is interaction-design
             work, tracked as #1550. A role here without a focus/selection model would be a trap,
             so this stays declared-and-tracked rather than half-fixed. -->
        <svg
          class="graph-svg"
          viewBox={`0 0 ${G_W} ${G_H}`}
          preserveAspectRatio="xMidYMid meet"
          data-testid="toybox-graph-svg"
          oncontextmenu={onGraphCtx}
        >
          <!-- Edges (cables) drawn under the nodes. -->
          {#each graph.edges as e (e.id)}
            {@const fromN = nodeById(e.from)}
            {@const toN = nodeById(e.to)}
            {#if fromN && toN}
              {@const d = cablePath(outPortXY(fromN), inPortXY(toN, e.toPort))}
              <!-- Wide transparent hit-path (drawn FIRST, under the visible
                   cable) carries the edge's identity (testid) + interactions, so
                   both click-to-delete and the contextual right-click land
                   reliably on a thin diagonal bezier. Being the previous sibling
                   lets :hover tint the visible cable via `+ .cable`. -->
              <!-- svelte-ignore a11y_click_events_have_key_events — click-to-delete an edge; no
                   keyboard path to select an edge exists yet. #1550. -->
              <path
                class="cable-hit"
                data-testid={`toybox-edge-${e.id}`}
                d={d}
                onclick={() => onDeleteEdge(e.id)}
                role="button"
                tabindex="-1"
                aria-label={`delete edge ${e.id}`}
              />
              <!-- Visible cosmetic cable (no pointer events; the hit-path above
                   catches interactions). -->
              <path class="cable" d={d} />
            {/if}
          {/each}

          <!-- Nodes (boxes + ports). -->
          {#each graph.nodes as n (n.id)}
            {@const xy = nodeXY(n)}
            <g
              class="gnode {n.kind} {selectedNodeId === n.id ? 'sel' : ''}"
              data-testid={`toybox-gnode-${n.id}`}
              data-kind={n.kind}
            >
              <!-- svelte-ignore a11y_click_events_have_key_events — click-to-select a graph node;
                   focus traversal between nodes is undesigned. #1550. -->
              <rect
                x={xy.x}
                y={xy.y}
                width={NODE_W}
                height={NODE_H}
                rx="4"
                class="gnode-rect"
                onclick={() => onNodeClick(n.id)}
                role="button"
                tabindex="-1"
                aria-label={`node ${n.id}`}
              />
              <text x={xy.x + NODE_W / 2} y={xy.y + NODE_H / 2 + 3} class="gnode-label">
                {nodeLabel(n)}
              </text>
              {#if lockedNodeIds.has(n.id)}
                <!-- LOCK badge (#1576 ws3): this node is immune from randomize
                     (toggled via the right-click menu). Driven off the
                     lockedNodeIds derived, NOT n.locked — see its comment. -->
                <text
                  x={xy.x + NODE_W - 6}
                  y={xy.y + 9}
                  class="gnode-lock"
                  data-testid={`toybox-gnode-lock-${n.id}`}
                  aria-label={`node ${n.id} locked against randomize`}
                >🔒</text>
              {/if}

              <!-- input ports (left) -->
              {#each inPortsFor(n.kind) as port (port)}
                {@const p = inPortXY(n, port)}
                <!-- svelte-ignore a11y_click_events_have_key_events — patching inside the graph
                     is click-port-then-click-port; there is no keyboard way to make a connection
                     yet. #1550. -->
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={PORT_R}
                  class="port in"
                  data-testid={`toybox-inport-${n.id}-${port}`}
                  onclick={() => onInPortClick(n.id, port)}
                  role="button"
                  tabindex="-1"
                  aria-label={`input ${port} of ${n.id}`}
                />
              {/each}

              <!-- output port (right) -->
              {#if hasOutPort(n.kind)}
                {@const op = outPortXY(n)}
                <!-- svelte-ignore a11y_click_events_have_key_events — output half of the same
                     click-to-patch gesture. #1550. -->
                <circle
                  cx={op.x}
                  cy={op.y}
                  r={PORT_R}
                  class="port out {pendingFrom === n.id ? 'armed' : ''}"
                  data-testid={`toybox-outport-${n.id}`}
                  onclick={() => onOutPortClick(n.id)}
                  role="button"
                  tabindex="-1"
                  aria-label={`output of ${n.id}`}
                />
              {/if}

              <!-- delete affordance (op nodes only) -->
              {#if n.kind !== 'source' && n.kind !== 'output'}
                <!-- svelte-ignore a11y_click_events_have_key_events — click-to-delete a graph
                     node; same missing focus model as the node body. #1550. -->
                <text
                  x={xy.x + NODE_W - 7}
                  y={xy.y + 10}
                  class="gnode-del"
                  data-testid={`toybox-delnode-${n.id}`}
                  onclick={() => onDeleteNode(n.id)}
                  role="button"
                  tabindex="-1"
                  aria-label={`delete node ${n.id}`}
                >×</text>
              {/if}
            </g>
          {/each}
        </svg>
      </div>

      <!-- Selected op node → its params in a side strip. EVERY `selectedNode.`
           deref below is OPTIONAL-CHAINED: when the selected node is DELETED,
           `selectedNode` becomes undefined and Svelte re-evaluates this block's
           child expressions (incl. each Knob's `paramId`/`value`) ONE more time
           during teardown — a raw `selectedNode.id` there threw "reading 'id' of
           undefined" and crashed the whole card (the reported delete crash). The
           `selId` const + the guards make teardown a harmless no-op. -->
      {#if selectedNode && selectedParams.length > 0}
        {@const selId = selectedNode?.id ?? ''}
        <div class="combine-params" data-testid="toybox-combine-params" data-node={selId}>
          <div class="combine-params-title" data-testid="toybox-combine-params-title">{(selectedNode?.kind ?? '').toUpperCase()} · {selectedNode ? nodeLabel(selectedNode) : ''}</div>
          <!-- FEEDBACK: a discrete MODE selector (12 labelled modes). The other
               floats auto-render as knobs below (the `mode` knob is filtered out
               via selectedKnobParams). -->
          {#if selectedIsFeedback}
            <label class="fb-mode-row" data-testid="toybox-feedback-mode">
              <span class="fb-mode-label">MODE</span>
              <select
                class="fb-mode-select"
                data-testid="toybox-feedback-mode-select"
                value={selectedFeedbackMode}
                onchange={(e) => { if (selId) setFeedbackMode(selId, Number((e.currentTarget as HTMLSelectElement).value)); }}
              >
                {#each FEEDBACK_MODES as m (m.id)}
                  <option value={m.id}>{m.id}. {m.label}</option>
                {/each}
              </select>
            </label>
          {/if}
          <!-- EVERY `p.` deref below is OPTIONAL-CHAINED: when the selected node is
               deleted this {#each} tears down, and Svelte 5 re-evaluates each
               child's reactive props (the Knob's `paramId`/`value` getters) ONE
               more time with the item `p` already set to `undefined` (the each-
               item-undefined-on-teardown footgun). A raw `p.id` there threw
               "reading 'id' of undefined" and crashed the card under load — the
               (intermittent) reported delete crash. `p?.…` makes teardown a no-op. -->
          <div class="knob-grid">
            {#each selectedKnobParams as p (p.id)}
              <!-- Wrapper carries a per-param testid so e2e can target + drive
                   THIS node's THIS param's knob (the controls-persistence test). -->
              <span class="combine-knob-cell" data-testid={`toybox-combine-knob-${p?.id ?? ''}`} data-param={p?.id}>
                <Knob
                  value={selectedNode && p ? combineParamVal(selectedNode, p.id) : (p?.default ?? 0)}
                  min={p?.min ?? 0} max={p?.max ?? 1} defaultValue={p?.default ?? 0}
                  label={p?.label ?? ''} curve="linear"
                  onchange={setCombineParam(selId, p?.id ?? '')}
                  moduleId={id} paramId={`combine:${selId}:${p?.id ?? ''}`}
                  testid={knobTestid(`combine:${selId}:${p?.id ?? ''}`)}
                />
              </span>
            {/each}
          </div>
        </div>
      {/if}
    {/if}
  </div>

  <!-- Contextual right-click menu for the combine-graph editor. -->
  <ToyboxNodeMenu
    open={!!toyboxMenu?.open}
    x={toyboxMenu?.x ?? 0}
    y={toyboxMenu?.y ?? 0}
    kind={toyboxMenu?.kind ?? 'canvas'}
    nodeKind={toyboxMenu?.nodeKind}
    dir={toyboxMenu?.dir}
    port={toyboxMenu?.port}
    nodeLocked={combineNodeIsLocked(toyboxMenu?.nodeId)}
    ontogglelock={() => {
      if (toyboxMenu?.nodeId) {
        setCombineNodeLocked(id, toyboxMenu.nodeId, !combineNodeIsLocked(toyboxMenu.nodeId));
        bumpRev();
      }
    }}
    onpatchtooutput={() => { if (toyboxMenu?.nodeId) doPatchToOutput(toyboxMenu.nodeId); }}
    onresetfeedback={() => { if (toyboxMenu?.nodeId) doResetFeedback(toyboxMenu.nodeId); }}
    ondisconnect={() => { if (toyboxMenu?.nodeId) doDisconnect(toyboxMenu.nodeId); }}
    onduplicate={() => { if (toyboxMenu?.nodeId) doDuplicate(toyboxMenu.nodeId); }}
    ondeletenode={() => { if (toyboxMenu?.nodeId) onDeleteNode(toyboxMenu.nodeId); }}
    ondisconnectport={() => { if (toyboxMenu?.nodeId && toyboxMenu.dir) doDisconnectPort(toyboxMenu.nodeId, toyboxMenu.dir, toyboxMenu.port); }}
    onbeginwire={() => { if (toyboxMenu?.nodeId) doBeginWire(toyboxMenu.nodeId); }}
    ondeleteedge={() => { if (toyboxMenu?.edgeId) onDeleteEdge(toyboxMenu.edgeId); }}
    onaddnode={(k) => doAddNodeAt(k, toyboxMenu?.ux, toyboxMenu?.uy)}
    onclear={doClearNodeMap}
    onreset={doResetToDefault}
    onclose={closeToyboxMenu}
  />
{/snippet}

{#snippet cvZone()}
  <!-- ───────── CV / MODULATION SECTION (6 inputs) ───────── -->
  <div class="cv-section" data-testid="toybox-cv-section">
    <!-- No per-section collapse, for the reason the COMBINE note gives. -->

    {#if cvVisible}
      <div class="cv-rows" data-testid="toybox-cv-rows">
        {#each CV_PORT_IDS as cvId, i (cvId)}
          {@const paramOpts = paramOptionsFor(cvId)}
          {@const kind = scopeKinds[cvId] ?? 'idle'}
          <div class="cv-row" data-testid={`toybox-cv-row-${cvId}`}>
            <!-- row head: input label + auto-detected source-kind badge -->
            <div class="cv-row-head">
              <span class="cv-port">IN{i + 1}</span>
              <span
                class="cv-badge cv-badge-{kind}"
                data-testid={`toybox-cv-badge-${cvId}`}
                data-kind={kind}
                title="auto-detected source type"
              >{kindBadge(cvId)}</span>
            </div>

            <!-- target + param routing -->
            <div class="cv-route">
              <select
                class="cv-select"
                data-testid={`toybox-cv-target-${cvId}`}
                value={targetValueFor(cvId)}
                onchange={(e) => onCvTargetChange(cvId, e)}
                aria-label={`IN${i + 1} target`}
              >
                <option value="">— none —</option>
                {#each cvTargets as t (t.value)}
                  <option value={t.value}>{t.label}</option>
                {/each}
              </select>
              <select
                class="cv-select"
                data-testid={`toybox-cv-param-${cvId}`}
                value={routeFor(cvId)?.param ?? ''}
                onchange={(e) => onCvParamChange(cvId, e)}
                disabled={paramOpts.length === 0}
                aria-label={`IN${i + 1} param`}
              >
                {#if paramOpts.length === 0}
                  <option value="">—</option>
                {/if}
                {#each paramOpts as p (p.id)}
                  <option value={p.id}>{p.label}</option>
                {/each}
              </select>
            </div>

            <!-- attenuverter (SCALE) + OFFSET + always-on inline scope -->
            <div class="cv-shape">
              <div class="cv-knob" data-testid={`toybox-cv-scale-${cvId}`}>
                <Knob
                  value={scaleFor(cvId)}
                  min={-1}
                  max={1}
                  defaultValue={DEFAULT_INPUT_SCALE}
                  label="SCALE"
                  onchange={(v) => onCvScaleChange(cvId, v)}
                  moduleId={id}
                  paramId={`${cvId}:scale`}
                  testid={knobTestid(`${cvId}:scale`)}
                />
              </div>
              <div class="cv-knob" data-testid={`toybox-cv-offset-${cvId}`}>
                <Knob
                  value={offsetFor(cvId)}
                  min={0}
                  max={1}
                  defaultValue={DEFAULT_INPUT_OFFSET}
                  label="OFFSET"
                  onchange={(v) => onCvOffsetChange(cvId, v)}
                  moduleId={id}
                  paramId={`${cvId}:offset`}
                  testid={knobTestid(`${cvId}:offset`)}
                />
              </div>
              <canvas
                class="cv-scope"
                width={SCOPE_W}
                height={SCOPE_H}
                data-testid={`toybox-cv-scope-${cvId}`}
                data-kind={kind}
                use:registerScope={cvId}
              ></canvas>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

  <!-- ── THE FACEPLATE BODY — the owner-ruled stack (2026-08-28) ──────────

       SCREEN → persistent LAYER band → three-tab rail. Read the header for
       why the band is persistent rather than a fourth tab: every tab
       REFERENCES layers and none OWNS them (the graph's L1..L4 source nodes
       emit what the band configures, the CV rail addresses layer params, and
       a preset captures and locks them), so putting the band inside any one
       tab would leave the other two pointing at something off screen. -->
  <div class="tb-face" data-testid="toybox-face-console" data-node-id={id}>
    <!-- ⚠ REMOVED, not hidden, when the screen is off — the space is
         RECLAIMED, which is the whole point of the switch. The engine keeps
         rendering: see `renewWatchMark`. -->
    {#if screenOn}
      {@render screenZone()}
    {/if}

    <div class="tb-band" data-testid="toybox-face-layer-band">
      {@render layerZone()}
    </div>

    <div class="tb-tabs" role="tablist" aria-label="console sections">
      <button
        type="button"
        class="tb-tab"
        class:active={faceTab === 'cv'}
        role="tab"
        aria-selected={faceTab === 'cv'}
        data-testid="toybox-face-tab-cv"
        onclick={() => (faceTab = 'cv')}
      >cv-mod</button>
      <button
        type="button"
        class="tb-tab"
        class:active={faceTab === 'combine'}
        role="tab"
        aria-selected={faceTab === 'combine'}
        data-testid="toybox-face-tab-combine"
        onclick={() => (faceTab = 'combine')}
      >combine graph</button>
      <button
        type="button"
        class="tb-tab"
        class:active={faceTab === 'presets'}
        role="tab"
        aria-selected={faceTab === 'presets'}
        data-testid="toybox-face-tab-presets"
        onclick={() => (faceTab = 'presets')}
      >presets</button>
    </div>

    <div class="tb-pane" data-testid="toybox-face-pane" data-tab={faceTab}>
      {#if faceTab === 'cv'}
        {@render cvZone()}
      {:else if faceTab === 'combine'}
        {@render combineZone()}
      {:else}
        {@render presetZone()}
      {/if}
    </div>
  </div>

<style>
  /* The picture box's base. `.screen-wrap.face` overrides margin/width/height
     and inherits the border, radius, overflow, background and line-height from
     here — so this rule is load-bearing, not a survivor of the three-column
     body that used to sit above it. */
  .screen-wrap {
    margin: 12px auto 8px;
    width: 200px;
    height: 150px;
    border: 1px solid var(--cable-video);
    border-radius: 2px;
    overflow: hidden;
    background: #050608;
    line-height: 0;
  }

  /* ═══ THE FACEPLATE BODY (layout === 'face') ═══════════════════════════════
   *
   * Every rule below is scoped by a `.tb-*` class or by `.screen-wrap.face`, so
   * NOTHING here can reach the legacy card — its baselines stay pinned to the
   * plate they were captured on.
   *
   * ⚠ WHOLE-PIXEL WIDTHS THROUGHOUT. The dock faceplate is `max-content`
   * clamped to the pane, so THIS stack's natural width IS the plate width;
   * a percentage or a fractional box would make the plate re-round between
   * boots, which is the settle class the VRT roster warns about. 512 px =
   * the 480 px screen plus 16 px of padding a side. Well under the legacy
   * card's 900 px, which was a RACK-GRID rounding of a three-column layout
   * and never a statement about content. */
  .screen-wrap.face {
    margin: 0 auto 10px;
    width: 480px;
    height: 360px;
  }
  /* ⚠ DERIVED, not a magic number: the 480 px screen plus 16 px of padding a
   * side. Written as `max-content` so it stays derived — a hard 512 would go
   * stale the day the screen changes size and would read as a floor to the
   * plate-width gate, which is the tidyVco shape. */
  /* ⚠ NO HORIZONTAL PADDING, AND THAT IS A MEASUREMENT RATHER THAN A TASTE.
   * The shell already insets an extension body: `.editor` pads 22 CSS px a
   * side, and `.dock-ext-body` adds its own. A further 16 px here was DOUBLE
   * padding, and `workflow-shell-faces`' geometry leg is what named it —
   * "50 CSS px of EMPTY PLATE to the right of the content … against a 40 px
   * ceiling", the tidyVco ruling ("we do not want useless gray horizontal
   * space on cards, ever").
   *
   * MEASURED in the unfolded dock, CSS px, before -> after:
   *
   *   .faceplate-body   578 -> 546      ← the plate (bodyW)
   *     .editor         578 -> 546        padL/R 22, the shell's own inset
   *       .module-shell 534 -> 502
   *         .dock-ext-body 532 -> 500
   *           .tb-face  512 -> 480      ← this box
   *             .tb-pane 480 -> 480     ← unchanged: the console's real width
   *
   * The console's own content never moved; what went was 32 px of plate the
   * shell had already provided. `width: auto` keeps the box derived from that
   * content rather than pinned to a number that would go stale — a hard width
   * here reads to the same gate as the `min-width` floor the ruling was about.
   *
   * ⚠ THE SCREEN STAYS A FIXED 480x360 AND CENTRES. It is the one box whose
   * size must not drift with the plate: a fractional or per-viewport picture
   * width is a VRT settle hazard, which is the same reason its backing store is
   * whole pixels at the engine's own 4:3. */
  .tb-face {
    width: auto;
    padding: 10px 0 12px;
    box-sizing: border-box;
    color: var(--text);
  }
  /* The persistent LAYER band: always visible, under the screen and above the
   * rail, because every tab REFERENCES layers and none owns them. */
  .tb-band {
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 6px 0 2px;
    margin-bottom: 8px;
    background: rgba(255, 255, 255, 0.015);
  }
  .tb-tabs {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid var(--border);
  }
  .tb-tab {
    appearance: none;
    background: transparent;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: 3px 3px 0 0;
    color: var(--text-dim);
    font: inherit;
    font-size: 0.62rem;
    letter-spacing: 0.06em;
    padding: 4px 10px 3px;
    cursor: pointer;
  }
  .tb-tab:hover { color: var(--text); }
  .tb-tab.active {
    color: var(--text);
    border-color: var(--border);
    background: var(--module-bg, rgba(255, 255, 255, 0.04));
    box-shadow: inset 0 2px 0 var(--cable-video);
  }
  /* ⚠ THE PANE SCROLLS INSIDE ITSELF rather than widening the plate: a tab
   * whose content outgrows the stack must never push the faceplate wider
   * (the `hiddenX === 0` leg of the dock geometry check). */
  .tb-pane {
    border: 1px solid var(--border);
    border-top: none;
    border-radius: 0 0 3px 3px;
    padding: 8px 0;
    overflow-x: auto;
    /* ⚠ RESERVE THE SCROLLBAR'S GUTTER. With `overflow-x: auto` alone, content
     * sitting within a pixel of the pane's width makes the scrollbar appear and
     * disappear as the six always-on CV scopes repaint — and every appearance
     * shifts the layout beside it. That is invisible to a person and fatal to a
     * machine: Playwright's actionability check requires a box unchanged across
     * two consecutive animation frames, so a jittering pane leaves every control
     * inside it permanently "visible, enabled and NOT stable". A reserved gutter
     * is the same picture with a fixed geometry. */
    scrollbar-gutter: stable;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    background: #050608;
  }
  .content-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 14px;
    margin-bottom: 8px;
  }
  .content-label {
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
    color: var(--text-dim);
    letter-spacing: 0.05em;
  }
  .content-select {
    flex: 1;
    background: var(--module-bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-family: ui-monospace, monospace;
    font-size: 0.65rem;
    padding: 3px 4px;
  }
  .content-select:hover { border-color: var(--accent-dim); }

  /* ───────── LAYER-INDEX selector (tabs) ───────── */
  .layer-tabs {
    display: flex;
    gap: 4px;
    padding: 0 14px;
    margin-bottom: 8px;
  }
  /* LOCK toggle beside each layer tab (#1576 ws3). Dimmed until locked so the
     strip stays quiet; the padlock glyph is the state, aria-pressed speaks it. */
  .layer-lock {
    flex: 0 0 auto;
    background: var(--module-bg);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-size: 0.55rem;
    line-height: 1;
    padding: 3px 4px;
    opacity: 0.45;
    cursor: pointer;
  }
  .layer-lock.locked {
    opacity: 1;
    color: var(--text);
    border-color: var(--cable-video);
  }
  .layer-tab {
    position: relative;
    flex: 1;
    background: var(--module-bg);
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
    letter-spacing: 0.04em;
    padding: 3px 0;
    cursor: pointer;
  }
  .layer-tab:hover { border-color: var(--accent-dim); color: var(--text); }
  .layer-tab.active {
    color: var(--accent);
    border-color: var(--accent);
    background: var(--accent-glow, rgba(255, 255, 255, 0.04));
  }
  /* Populated badge: a small dot in the top-right of the tab. */
  .layer-dot {
    position: absolute;
    top: 2px;
    right: 3px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--cable-video);
  }
  .layer-empty {
    margin: 0 14px 8px;
    padding: 6px 8px;
    border: 1px dashed var(--border);
    border-radius: 3px;
    font-family: ui-monospace, monospace;
    font-size: 0.58rem;
    color: var(--text-dim);
    text-align: center;
  }

  .knob-grid {
    margin-top: 4px;
    padding: 0 14px;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px 4px;
    justify-items: center;
  }

  /* ───────── IMAGE / VIDEO input pickers (#39) ───────── */
  .input-picker {
    margin: 4px 14px 8px;
    text-align: center;
  }
  .pick-btn {
    display: inline-block;
    padding: 4px 10px;
    background: var(--cable-video);
    color: #000;
    border-radius: 2px;
    font-size: 0.65rem;
    font-family: ui-monospace, monospace;
    cursor: pointer;
    user-select: none;
  }
  .pick-btn:hover { filter: brightness(1.1); }
  .pick-btn input { display: none; }
  /* The camera affordance reuses .pick-btn but is a real <button>; reset its
     native chrome so it matches the file label. */
  .cam-btn { border: none; margin-top: 6px; }
  .input-picker .filename {
    margin-top: 6px;
    font-size: 0.58rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .input-picker .sync-hint {
    margin-top: 2px;
    font-size: 0.52rem;
    color: var(--cable-video);
    font-family: ui-monospace, monospace;
    opacity: 0.6;
  }
  .frag-hint {
    margin-top: 2px;
    font-size: 0.52rem;
    color: var(--cable-cv);
    font-family: ui-monospace, monospace;
    opacity: 0.6;
  }
  .input-picker .input-error {
    margin-top: 6px;
    font-size: 0.58rem;
    color: #f87171;
    font-family: ui-monospace, monospace;
  }
  /* ───────── user presets: SAVE / EXPORT / IMPORT (#61) ───────── */
  .preset-section { margin-bottom: 6px; }
  .preset-actions,
  .preset-save-row {
    display: flex;
    gap: 4px;
    margin-top: 4px;
    align-items: center;
  }
  .preset-btn {
    flex: 1 1 auto;
    padding: 3px 6px;
    background: transparent;
    color: var(--text-dim);
    border: 1px solid var(--text-dim);
    border-radius: 2px;
    font-size: 0.55rem;
    font-family: ui-monospace, monospace;
    cursor: pointer;
    user-select: none;
  }
  .preset-btn:hover:not(:disabled) { color: var(--text); border-color: var(--text); }
  .preset-btn:disabled { opacity: 0.5; cursor: default; }
  .preset-btn.ghost { flex: 0 0 auto; padding: 3px 7px; }
  .preset-name-input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 3px 6px;
    background: var(--surface, #111);
    color: var(--text);
    border: 1px solid var(--text-dim);
    border-radius: 2px;
    font-size: 0.6rem;
    font-family: ui-monospace, monospace;
  }
  .preset-section .input-error {
    margin-top: 4px;
    font-size: 0.55rem;
    color: #f87171;
    font-family: ui-monospace, monospace;
  }
  .preset-section .sync-hint {
    margin-top: 4px;
    font-size: 0.52rem;
    color: var(--cable-video);
    font-family: ui-monospace, monospace;
    opacity: 0.7;
  }
  .preset-saved-list {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .preset-saved-item {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .preset-saved-name {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 0.55rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .preset-del { color: #f87171; border-color: transparent; }
  .preset-del:hover { color: #fff; background: #f87171; }
  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
  /* "Use bundled …" reset for a custom disk-loaded shader/OBJ. */
  .input-picker .clear-btn {
    display: inline-block;
    margin-top: 6px;
    padding: 2px 8px;
    background: transparent;
    color: var(--text-dim);
    border: 1px solid var(--text-dim);
    border-radius: 2px;
    font-size: 0.55rem;
    font-family: ui-monospace, monospace;
    cursor: pointer;
  }
  .input-picker .clear-btn:hover { color: var(--text); border-color: var(--text); }
  /* ───────── projective surface controls (#45) ───────── */
  .proj-camera-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
    color: var(--text-dim);
    cursor: pointer;
  }
  .proj-camera-label input { cursor: pointer; }

  /* ───────── COMBINE GRAPH EDITOR (Phase 4) ───────── */
  .combine-section {
    margin-top: 10px;
    padding: 0 12px;
    border-top: 1px solid var(--border);
    padding-top: 8px;
  }
  .add-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    margin: 6px 0;
  }
  .add-label {
    font-family: ui-monospace, monospace;
    font-size: 0.55rem;
    color: var(--text-dim);
  }
  .add-btn {
    background: var(--module-bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-family: ui-monospace, monospace;
    font-size: 0.55rem;
    text-transform: uppercase;
    padding: 2px 5px;
    cursor: pointer;
  }
  .add-btn:hover { border-color: var(--accent-dim); color: var(--accent); }
  .connect-msg {
    font-family: ui-monospace, monospace;
    font-size: 0.55rem;
    color: var(--text-dim);
    margin: 2px 0;
  }
  .connect-msg.armed { color: var(--accent); }
  .graph-wrap {
    width: 100%;
    background: #06080c;
    border: 1px solid var(--cable-video);
    border-radius: 3px;
    /* User-resizable height (drag the bottom edge). overflow:auto is required for
       the native CSS resize grip to appear; the persisted height feeds the inline
       style so it round-trips. min/max keep the panel usable. */
    resize: vertical;
    overflow: auto;
    min-height: 120px;
    max-height: 600px;
    margin: 4px 0;
  }
  .graph-svg {
    display: block;
    width: 100%;
    height: 100%;
  }
  /* nodes */
  .gnode-rect {
    fill: #11161f;
    stroke: var(--border);
    stroke-width: 1;
    cursor: pointer;
  }
  .gnode.source .gnode-rect { fill: #0f1a14; stroke: #2f6b4a; }
  .gnode.output .gnode-rect { fill: #1a1410; stroke: #8a5a2f; }
  /* FEEDBACK (the stateful op) — a distinct purple so it reads as special. */
  .gnode.feedback .gnode-rect { fill: #18121f; stroke: #7a4fb0; }
  .gnode.sel .gnode-rect { stroke: var(--accent); stroke-width: 2; }
  .gnode-rect:hover { stroke: var(--accent-dim); }
  .gnode-label {
    fill: var(--text);
    font-family: ui-monospace, monospace;
    font-size: 9px;
    text-anchor: middle;
    pointer-events: none;
    user-select: none;
  }
  /* LOCK badge on a randomize-immune node (#1576 ws3). */
  .gnode-lock {
    font-size: 8px;
    text-anchor: end;
    pointer-events: none;
    user-select: none;
  }
  .gnode-del {
    fill: var(--text-dim);
    font-family: ui-monospace, monospace;
    font-size: 11px;
    text-anchor: middle;
    cursor: pointer;
  }
  .gnode-del:hover { fill: #e05050; }
  .port {
    fill: #0a0d12;
    stroke: var(--cable-video);
    stroke-width: 1.5;
    cursor: pointer;
  }
  .port.in:hover { fill: var(--accent-dim); }
  .port.out:hover { fill: var(--accent-dim); }
  .port.out.armed { fill: var(--accent); stroke: var(--accent); }
  .cable {
    fill: none;
    stroke: var(--cable-video);
    stroke-width: 1.5;
    opacity: 0.85;
    pointer-events: none; /* the wide hit-path below catches interactions */
  }
  /* Wide transparent hit-path: easy to click / right-click despite the
     hairline visible cable. It's the PREVIOUS sibling of its visible cable, so
     hovering it tints the cable via `+ .cable`. */
  .cable-hit {
    fill: none;
    stroke: transparent;
    stroke-width: 10;
    cursor: pointer;
  }
  .cable-hit:hover + .cable { stroke: #e05050; opacity: 1; }
  .combine-params {
    margin-top: 6px;
    border-top: 1px dashed var(--border);
    padding-top: 6px;
  }
  .combine-params-title {
    font-family: ui-monospace, monospace;
    font-size: 0.55rem;
    color: var(--text-dim);
    margin-bottom: 4px;
    letter-spacing: 0.05em;
  }
  .combine-params .knob-grid { padding: 0; }

  /* FEEDBACK node MODE selector (discrete; the other params are knobs). */
  .fb-mode-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
  }
  .fb-mode-label {
    font-family: ui-monospace, monospace;
    font-size: 0.55rem;
    color: var(--text-dim);
    letter-spacing: 0.05em;
  }
  .fb-mode-select {
    flex: 1 1 auto;
    min-width: 0;
    background: var(--input-bg, #1a1d24);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
    padding: 2px 4px;
  }

  /* ───────── CV / MODULATION SECTION (6 inputs) ───────── */
  .cv-section {
    padding: 2px 4px 0;
  }
  .cv-rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 6px 0 2px;
  }
  .cv-row {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 4px 5px;
    border: 1px solid var(--border);
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.015);
  }
  .cv-row-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .cv-port {
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
    color: var(--cable-cv, var(--text-dim));
    font-weight: 600;
  }
  .cv-badge {
    font-family: ui-monospace, monospace;
    font-size: 0.5rem;
    letter-spacing: 0.04em;
    padding: 1px 4px;
    border-radius: 2px;
    border: 1px solid var(--border);
    color: var(--text-dim);
  }
  .cv-badge-cv { color: var(--cable-cv, #4aa); border-color: var(--cable-cv, #4aa); }
  .cv-badge-gate { color: var(--cable-gate, #f87171); border-color: var(--cable-gate, #f87171); }
  .cv-badge-audio { color: var(--cable-audio, #22c55e); border-color: var(--cable-audio, #22c55e); }
  .cv-badge-idle { opacity: 0.55; }
  .cv-route {
    display: flex;
    gap: 3px;
  }
  .cv-shape {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .cv-knob { flex: 0 0 auto; transform: scale(0.82); transform-origin: left center; }
  .cv-scope {
    flex: 1 1 auto;
    min-width: 0;
    height: 22px;
    border: 1px solid var(--border);
    border-radius: 2px;
    background: #070a0e;
    image-rendering: pixelated;
  }
  .cv-select {
    flex: 1 1 0;
    min-width: 0;
    background: var(--module-bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-family: ui-monospace, monospace;
    font-size: 0.55rem;
    padding: 2px 3px;
  }
  .cv-select:hover { border-color: var(--accent-dim); }
  .cv-select:disabled { opacity: 0.5; }
</style>
