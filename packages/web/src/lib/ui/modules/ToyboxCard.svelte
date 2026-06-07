<script lang="ts">
  // ToyboxCard — UI for the TOYBOX swappable fragment-shader source (P1).
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
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import {
    downscaleAndEncode,
    base64ToImageBitmap,
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
  import type { VideoEngine } from '$lib/video/engine';
  import { liveEngineAspect } from '$lib/ui/modules/video-card-aspect';
  import HdBufferResSelect from '$lib/ui/modules/HdBufferResSelect.svelte';
  import { BUFFER_RES_SD } from '$lib/video/buffer-res';
  import {
    canvasToEnginePx,
    makeMouseState,
    mouseDown,
    mouseMove,
    mouseUp,
    mouseToVec4,
  } from '$lib/video/toybox-shadertoy';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import {
    OP_KINDS,
    OP_PARAMS,
    inPortsFor,
    hasOutPort,
    isCombineGraph,
    makeDefaultCombineGraph,
    combineDisplayNames,
    edgesTouching,
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
  } from '$lib/graph/toybox-combine';
  import { FEEDBACK_MODES } from '$lib/video/toybox-feedback';
  import ToyboxNodeMenu from './ToyboxNodeMenu.svelte';
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
  import { loadToyboxPreset, applyDataBlobToNode } from '$lib/graph/toybox-presets';
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
  } from '$lib/graph/toybox-layers';

  // The two VIDEO input ports (handles on the card's left edge). Ids match the
  // def's inA/inB; the label is the human-facing VID A / VID B.
  const VIDEO_IN_PORTS: ReadonlyArray<{ id: 'inA' | 'inB'; label: string }> = [
    { id: 'inA', label: 'VID A' },
    { id: 'inB', label: 'VID B' },
  ];

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // Engine render resolution (VIDEO_RES) — letterbox the 4:3 render.
  const ENGINE_W = 640;
  const ENGINE_H = 480;
  const CANVAS_W = 200;
  const CANVAS_H = Math.round(CANVAS_W * (ENGINE_H / ENGINE_W)); // 150

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
    void node; // dep: external/remote writes (snapshot pushes a new node wrapper)
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
    void node;
    void layersRev;
    const live = patch.nodes[id]?.data as { combine?: unknown } | undefined;
    return live?.combine ?? (node?.data as { combine?: unknown } | undefined)?.combine;
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
  let currentMeta = $derived(catalog.find((c) => c.id === currentContentId));

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

  // Node-level param setter (NOT per-layer) — used by the HD bufferRes dropdown,
  // which is a single module param sizing the float feedback/history rings.
  const setNodeParam = (pid: string) => (v: number) => {
    const t = patch.nodes[id];
    if (t) t.params[pid] = v;
    bumpRev();
  };

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

  // ---- IMAGE: decode persisted bytes → upload into the engine per layer ----
  //
  // Watch EVERY layer's imageBytes (not just the active one) so a remote peer's
  // write to any image layer is applied locally. We track the last-applied bytes
  // per layer so a snapshot-bus re-fire with unchanged bytes doesn't re-decode,
  // and retry while the engine node hasn't materialised yet (PICTUREBOX pattern).
  const lastAppliedImage = new Map<number, string | null>();
  let imageApplyTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleImageRetry(): void {
    if (imageApplyTimer) return;
    imageApplyTimer = setTimeout(() => {
      imageApplyTimer = null;
      // Clear the cache so applyImagesToEngine re-evaluates every layer.
      lastAppliedImage.clear();
      void applyImagesToEngine();
    }, 100);
  }

  async function applyImagesToEngine(): Promise<void> {
    const extras = getExtras();
    const layers = patch.nodes[id]?.data?.layers as ToyboxLayer[] | undefined;
    if (!layers) return;
    let pendingNode = false;
    for (let i = 0; i < LAYER_COUNT; i++) {
      const layer = layers[i];
      if (!layer || layer.kind !== 'image') {
        // Non-image layer → ensure any prior image is cleared once.
        if (lastAppliedImage.get(i) !== undefined && extras) {
          extras.setLayerImage(i, null);
          lastAppliedImage.set(i, undefined as unknown as string | null);
        }
        continue;
      }
      const bytes = layer.imageBytes ?? null;
      if (bytes === lastAppliedImage.get(i)) continue;
      if (!extras) { pendingNode = true; continue; }
      lastAppliedImage.set(i, bytes);
      if (!bytes) { extras.setLayerImage(i, null); continue; }
      try {
        const bitmap = await base64ToImageBitmap(bytes);
        extras.setLayerImage(i, bitmap);
      } catch (err) {
        console.warn('[toybox] image decode failed:', err);
      }
    }
    // The engine node wasn't ready for at least one image layer — retry.
    if (pendingNode) scheduleImageRetry();
  }

  // Re-run whenever ANY layer's imageBytes changes (the readLiveLayers triggers
  // fire on local + remote writes). Reading every layer's bytes registers them.
  $effect(() => {
    const ls = readLiveLayers();
    for (let i = 0; i < LAYER_COUNT; i++) void ls?.[i]?.imageBytes;
    void applyImagesToEngine();
  });

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

  // ---- VIDEO: card-owned <video> element per video layer ----
  //
  // The element + object-URL are LOCAL (never synced). Created on file pick for a
  // layer, attached to the engine's per-layer frame uploader, looped + muted +
  // autoplaying so the layer animates. Only the filename rides the Y.Doc.
  const videoEls = new Map<number, HTMLVideoElement>();
  const videoUrls = new Map<number, string>();
  // Webcam MediaStreams per layer (source='camera') — stopped on swap/destroy.
  const videoStreams = new Map<number, MediaStream>();
  let videoAttachTimer: ReturnType<typeof setTimeout> | null = null;

  /** Get (or create) layer `i`'s card-owned <video> element. */
  function ensureVideoEl(i: number): HTMLVideoElement {
    let el = videoEls.get(i);
    if (!el) {
      el = document.createElement('video');
      el.muted = true;
      el.loop = true;
      el.playsInline = true;
      videoEls.set(i, el);
    }
    return el;
  }

  /** Attach layer `i`'s card-owned <video> element to the engine (retry until
   *  the engine node exists). */
  function ensureVideoAttached(i: number, attempt = 0): void {
    const el = videoEls.get(i);
    if (!el) return;
    const extras = getExtras();
    if (extras) { extras.attachLayerVideo(i, el); return; }
    if (attempt >= 50) return;
    videoAttachTimer = setTimeout(() => ensureVideoAttached(i, attempt + 1), 100);
  }

  /** Tear down layer `i`'s LOCAL video source (file object-URL OR webcam
   *  stream) + detach it from the engine. Used when a layer switches to a
   *  PATCHED feed (inA/inB) — the cable provides the texture, so we shouldn't
   *  keep a decoder/camera open — and on destroy. */
  function releaseVideoLayer(i: number): void {
    const stream = videoStreams.get(i);
    if (stream) {
      for (const t of stream.getTracks()) { try { t.stop(); } catch { /* */ } }
      videoStreams.delete(i);
    }
    const url = videoUrls.get(i);
    if (url) { try { URL.revokeObjectURL(url); } catch { /* */ } videoUrls.delete(i); }
    const el = videoEls.get(i);
    if (el) {
      try { el.pause(); } catch { /* */ }
      try { el.srcObject = null; } catch { /* */ }
      try { el.removeAttribute('src'); el.load(); } catch { /* */ }
    }
    try { getExtras()?.attachLayerVideo(i, null); } catch { /* */ }
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
    // Free any prior local source for this layer first.
    const prevUrl = videoUrls.get(i);
    if (prevUrl) { try { URL.revokeObjectURL(prevUrl); } catch { /* */ } videoUrls.delete(i); }
    const prevStream = videoStreams.get(i);
    if (prevStream) { for (const t of prevStream.getTracks()) { try { t.stop(); } catch { /* */ } } }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      videoStreams.set(i, stream);
      const el = ensureVideoEl(i);
      el.removeAttribute('src');
      el.srcObject = stream;
      try { await el.play(); } catch { /* a user gesture (the select change) should permit it */ }
      ensureVideoAttached(i);
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
    // Free a prior object URL for this layer + stop any webcam stream (a file
    // pick implies source='file', overriding a prior camera capture).
    const prevUrl = videoUrls.get(layerIdx);
    if (prevUrl) { try { URL.revokeObjectURL(prevUrl); } catch { /* */ } }
    const prevStream = videoStreams.get(layerIdx);
    if (prevStream) {
      for (const t of prevStream.getTracks()) { try { t.stop(); } catch { /* */ } }
      videoStreams.delete(layerIdx);
    }
    const url = URL.createObjectURL(file);
    videoUrls.set(layerIdx, url);
    // Reuse (or create) a card-owned <video> for this layer.
    const el = ensureVideoEl(layerIdx);
    el.srcObject = null;
    el.src = url;
    try { await el.play(); } catch { /* autoplay may be blocked until a gesture; the picker click IS one */ }
    ensureVideoAttached(layerIdx);
    // Picking a file selects the 'file' source + persists the filename (bytes
    // stay local, VIDEOBOX-style; only the name rides the Y.Doc).
    setLayerVideoSource(id, layerIdx, 'file');
    setLayerVideoName(id, layerIdx, file.name);
    bumpRev();
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
    return isCombineGraph(c) ? (c as ToyboxCombineGraph) : makeDefaultCombineGraph();
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
    void node; void layersRev;
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

  // Editor interaction state. Default OPEN: the wide 3-column card has a dedicated
  // CENTER column for the combine graph, so it shows by default (no longer a
  // space-saving collapse in the old single-column card).
  let editorOpen = $state(true);
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
    void node; void layersRev;
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
    void layersRev; void node;
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

  // Default OPEN: the 6-input CV/MOD section is the headline of the wide card +
  // lives in its own RIGHT column, so it shows by default (the always-on scopes
  // are only useful when visible).
  let cvOpen = $state(true);

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
    void node; void layersRev;
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
    void node; void layersRev; // deps: remote snapshot + local mutation
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
    void node;
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
    void node; void layersRev; // #60: recompute on layer/combine structural change
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
   * nukes the preview loop. Gated on the CV section being open (scopes only draw
   * when visible).
   */
  function tickScopes(): void {
    if (!cvOpen || frozen) return;
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

  /** Resolve a layer's loaded video bytes from its card-owned object URL. Skips
   *  layers with no local file source (patched feeds / camera / no video). */
  async function resolveLayerVideos(
    blob: Record<string, unknown>,
  ): Promise<ToyboxPresetVideo[]> {
    const out: ToyboxPresetVideo[] = [];
    const layers = (blob.layers as Array<Record<string, unknown>> | undefined) ?? [];
    for (let i = 0; i < layers.length; i++) {
      const url = videoUrls.get(i);
      if (!url) continue; // no LOADED local video for this layer
      try {
        const resp = await fetch(url);
        const ab = await (await resp.blob()).arrayBuffer();
        const bytes = new Uint8Array(ab);
        const name = (layers[i]?.videoName as string | undefined) || `layer-${i}.mp4`;
        out.push({ layer: i, name, bytes });
      } catch {
        // A torn-down / revoked URL: skip (the preset still exports without it).
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
    // Free any prior local source for this layer first.
    const prevUrl = videoUrls.get(i);
    if (prevUrl) { try { URL.revokeObjectURL(prevUrl); } catch { /* */ } }
    const prevStream = videoStreams.get(i);
    if (prevStream) {
      for (const t of prevStream.getTracks()) { try { t.stop(); } catch { /* */ } }
      videoStreams.delete(i);
    }
    const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
    videoUrls.set(i, url);
    const el = ensureVideoEl(i);
    el.srcObject = null;
    el.src = url;
    void el.play().catch(() => { /* autoplay may need a gesture; the import click was one */ });
    ensureVideoAttached(i);
    // Persist the source + filename (the data blob already carried videoName, but
    // be explicit so the layer's File source is selected + named consistently).
    setLayerVideoSource(id, i, 'file');
    setLayerVideoName(id, i, name);
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

  // ----- Live preview pull (MANDELBULB pattern) -----
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;
  // When frozen for VRT, stop pulling so the on-card canvas matches the
  // engine's pinned-iTime FBO exactly.
  let frozen = false;

  /** Live video-engine render res (follows HD mode). Falls back to the SD
   *  ENGINE_W×ENGINE_H constant when the engine isn't up yet. Used both for the
   *  letterbox aspect and the iMouse canvas→engine-px mapping. */
  function liveEngineRes(): { width: number; height: number } {
    const e = engineCtx.get();
    if (e) {
      try {
        const ve = e.getDomain<VideoEngine>('video');
        const w = ve?.canvas?.width ?? 0;
        const h = ve?.canvas?.height ?? 0;
        if (w > 0 && h > 0) return { width: w, height: h };
      } catch {
        /* engine not ready — fall through to SD default */
      }
    }
    return { width: ENGINE_W, height: ENGINE_H };
  }

  function fitRect(
    cw: number,
    ch: number,
    srcAspect: number = ENGINE_W / ENGINE_H,
  ): { x: number; y: number; w: number; h: number } {
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
    // Use the LIVE engine res so iMouse maps correctly in HD (the FBO may be
    // 1920×1080 etc., not the SD 640×480 constant).
    const eng = liveEngineRes();
    const rect = fitRect(canvasEl.width, canvasEl.height, eng.width / eng.height);
    return canvasToEnginePx(cx, cy, rect, eng.width, eng.height);
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

  function blitOnce(): void {
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
    try {
      videoEngine.blitOutputToDrawingBuffer(id);
    } catch {
      // Don't let engine errors nuke the rAF loop.
    }
    const src = videoEngine.canvas as CanvasImageSource;
    const cw = canvasEl.width;
    const ch = canvasEl.height;
    ctx2d.fillStyle = '#050608';
    ctx2d.fillRect(0, 0, cw, ch);
    const r = fitRect(cw, ch, liveEngineAspect(videoEngine));
    ctx2d.drawImage(src, r.x, r.y, r.w, r.h);
  }

  function draw() {
    rafId = requestAnimationFrame(draw);
    if (frozen) return; // hold the last frame (VRT)
    // Advance + push the iMouse vec4 each frame so the Shadertoy .w click-frame
    // sign is consumed (and a held .z sign keeps refreshing) even with no events.
    pushMouse();
    blitOnce();
    // Drive all 6 inline scopes from ONE batched read('cvScope') — joined to
    // THIS rAF (after blitOnce), no separate loop, no per-knob readLive.
    tickScopes();
  }

  onMount(() => {
    rafId = requestAnimationFrame(draw);
    // VRT debug hook: pin the engine-side iTime to `time` (constant) so the
    // shader render is deterministic, blit once with the new frozen frame,
    // then pause the preview pull. Call with no/undefined arg to resume.
    const g = globalThis as unknown as {
      __toyboxFreeze?: (time?: number, seed?: number) => void;
      __toyboxFreezeTime?: number | null;
      __toyboxLoadPreset?: (presetId: string) => Promise<boolean>;
    };
    // VRT/e2e determinism hook: load a bundled preset by id into THIS node's
    // data (in place) + prefetch its assets. Returns the apply verdict.
    g.__toyboxLoadPreset = (presetId: string) => loadPreset(presetId);
    g.__toyboxFreeze = (time?: number, seed?: number) => {
      if (typeof time === 'number') {
        g.__toyboxFreezeTime = time;
        // Force the engine to render one frame at the pinned time, then
        // pull it into the on-card canvas, then freeze the preview.
        const e = engineCtx.get();
        try { e?.getDomain<VideoEngine>('video')?.step(); } catch { /* */ }
        blitOnce();
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
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (imageApplyTimer) { clearTimeout(imageApplyTimer); imageApplyTimer = null; }
    if (videoAttachTimer) { clearTimeout(videoAttachTimer); videoAttachTimer = null; }
    // Detach + release every card-owned video element / object URL so we don't
    // leak blobs or leave the engine pumping a torn-down element.
    const extras = getExtras();
    for (const [i, el] of videoEls) {
      try { extras?.attachLayerVideo(i, null); } catch { /* */ }
      try { el.pause(); el.srcObject = null; el.removeAttribute('src'); el.load(); } catch { /* */ }
    }
    for (const url of videoUrls.values()) { try { URL.revokeObjectURL(url); } catch { /* */ } }
    // Stop any live webcam capture (source='camera') so the camera light goes off.
    for (const stream of videoStreams.values()) {
      for (const t of stream.getTracks()) { try { t.stop(); } catch { /* */ } }
    }
    videoEls.clear();
    videoUrls.clear();
    videoStreams.clear();
  });
</script>

<div class="mod-card toybox-card" data-testid="toybox-card" data-node-id={id}>
  <div class="stripe"></div>
  <ModuleTitle {id} {data} defaultLabel="TOYBOX" />

  <!-- Video output. -->
  <Handle
    type="source"
    position={Position.Right}
    id="out"
    style="top: 56px; --handle-color: var(--cable-video);"
  />
  <span class="port-label right" style="top: 50px;">OUT</span>

  <!-- The 6 generic modulation input ports (port ids cv1..cv6; LABELLED IN1..
       IN6 in the UI). Real input handles — the outer canvas draws cables to
       them; each is shaped (SCALE/OFFSET) + routed to a param in the CV section.
       Stacked down the left edge. Typed `modsignal` so cv/gate/audio connect. -->
  {#each CV_PORT_IDS as cvId, i (cvId)}
    <Handle
      type="target"
      position={Position.Left}
      id={cvId}
      style={`top: ${44 + i * 22}px; --handle-color: var(--cable-cv);`}
    />
    <span class="port-label left" style={`top: ${38 + i * 22}px;`}>IN{i + 1}</span>
  {/each}

  <!-- Two VIDEO input ports (ids inA / inB; LABELLED VID A / VID B). A patched
       feed (e.g. ACIDWARP / CAMERA / another module's video out) reaches a
       VIDEO-kind layer that selects 'In A'/'In B' as its source. Stacked below
       the 6 cv ports; the video cable colour distinguishes them. -->
  {#each VIDEO_IN_PORTS as vp, i (vp.id)}
    <Handle
      type="target"
      position={Position.Left}
      id={vp.id}
      style={`top: ${44 + (CV_PORT_IDS.length + i) * 22 + 8}px; --handle-color: var(--cable-video);`}
    />
    <span class="port-label left" style={`top: ${38 + (CV_PORT_IDS.length + i) * 22 + 8}px;`}>{vp.label}</span>
  {/each}

  <!-- 3-COLUMN BODY: LEFT = preview + layer editor, CENTER = combine graph,
       RIGHT = the 6-input CV/modulation section. -->
  <div class="toybox-cols" data-testid="toybox-cols">
  <div class="toybox-col toybox-col-left" data-testid="toybox-col-left">

  <div class="screen-wrap">
    <canvas
      bind:this={canvasEl}
      width={CANVAS_W}
      height={CANVAS_H}
      data-testid="toybox-canvas"
      data-node-id={id}
      style="touch-action: none;"
      onpointerdown={onCanvasPointerDown}
      onpointermove={onCanvasPointerMove}
      onpointerup={onCanvasPointerUp}
      onpointercancel={onCanvasPointerUp}
    ></canvas>
  </div>

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
    <div class="hd-res-row" data-testid="toybox-hd-res-row">
      <HdBufferResSelect
        moduleId={id}
        value={node?.params?.bufferRes ?? BUFFER_RES_SD}
        onchange={setNodeParam('bufferRes')}
      />
    </div>
  </div>

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
              label="POS X" curve="linear" onchange={setMat('projPosX')} moduleId={id} paramId="projPosX" />
            <Knob value={matVal('projPosY')} min={-5} max={5} defaultValue={0}
              label="POS Y" curve="linear" onchange={setMat('projPosY')} moduleId={id} paramId="projPosY" />
            <Knob value={matVal('projPosZ')} min={-5} max={5} defaultValue={2.5}
              label="POS Z" curve="linear" onchange={setMat('projPosZ')} moduleId={id} paramId="projPosZ" />
            <Knob value={matVal('projDirX')} min={-1} max={1} defaultValue={0}
              label="DIR X" curve="linear" onchange={setMat('projDirX')} moduleId={id} paramId="projDirX" />
            <Knob value={matVal('projDirY')} min={-1} max={1} defaultValue={0}
              label="DIR Y" curve="linear" onchange={setMat('projDirY')} moduleId={id} paramId="projDirY" />
            <Knob value={matVal('projDirZ')} min={-1} max={1} defaultValue={-1}
              label="DIR Z" curve="linear" onchange={setMat('projDirZ')} moduleId={id} paramId="projDirZ" />
            <Knob value={matVal('projFov') || 0.8726646} min={0.2} max={2.6} defaultValue={0.8726646}
              label="FOV" curve="linear" onchange={setMat('projFov')} moduleId={id} paramId="projFov" />
          </div>
        {/if}
      {/if}
    {/if}

    <div class="knob-grid" data-testid="toybox-controls">
      <Knob value={matVal('rotX')} min={-3.14159} max={3.14159} defaultValue={0.3}
        label="ROT X" curve="linear" onchange={setMat('rotX')} moduleId={id} paramId="rotX" />
      <Knob value={matVal('rotY')} min={-3.14159} max={3.14159} defaultValue={0.6}
        label="ROT Y" curve="linear" onchange={setMat('rotY')} moduleId={id} paramId="rotY" />
      <Knob value={matVal('rotZ')} min={-3.14159} max={3.14159} defaultValue={0}
        label="ROT Z" curve="linear" onchange={setMat('rotZ')} moduleId={id} paramId="rotZ" />
      <Knob value={matVal('scale')} min={0.25} max={3} defaultValue={1}
        label="SCALE" curve="linear" onchange={setMat('scale')} moduleId={id} paramId="scale" />
      <Knob value={matVal('spin')} min={0} max={3} defaultValue={0.4}
        label="SPIN" curve="linear" onchange={setMat('spin')} moduleId={id} paramId="spin" />
      <Knob value={matVal('tintR')} min={0} max={1} defaultValue={1}
        label="TINT R" curve="linear" onchange={setMat('tintR')} moduleId={id} paramId="tintR" />
      <Knob value={matVal('tintG')} min={0} max={1} defaultValue={1}
        label="TINT G" curve="linear" onchange={setMat('tintG')} moduleId={id} paramId="tintG" />
      <Knob value={matVal('tintB')} min={0} max={1} defaultValue={1}
        label="TINT B" curve="linear" onchange={setMat('tintB')} moduleId={id} paramId="tintB" />
      <Knob value={surfaceMixVal()} min={0} max={1} defaultValue={1}
        label="SURF MIX" curve="linear" onchange={setMat('surfaceMix')} moduleId={id} paramId="surfaceMix" />
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
            onchange={setParam(p.id)} moduleId={id} paramId={p.id}
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
        <div class="sync-hint" data-testid="toybox-image-synced">synced (640×480)</div>
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
          <div class="filename" title={currentVideoName} data-testid="toybox-video-filename">{currentVideoName}</div>
          <div class="sync-hint" data-testid="toybox-video-local">local file (not synced)</div>
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
  </div><!-- /toybox-col-left -->

  <div class="toybox-col toybox-col-center" data-testid="toybox-col-center">
  <!-- ───────── COMBINE GRAPH EDITOR (Phase 4) ───────── -->
  <div class="combine-section" data-testid="toybox-combine-section">
    <button
      type="button"
      class="combine-toggle"
      data-testid="toybox-combine-toggle"
      aria-expanded={editorOpen}
      onclick={() => (editorOpen = !editorOpen)}
    >
      {editorOpen ? '▾' : '▸'} COMBINE GRAPH
    </button>

    {#if editorOpen}
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

              <!-- input ports (left) -->
              {#each inPortsFor(n.kind) as port (port)}
                {@const p = inPortXY(n, port)}
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
  </div><!-- /toybox-col-center -->

  <div class="toybox-col toybox-col-right" data-testid="toybox-col-right">
  <!-- ───────── CV / MODULATION SECTION (6 inputs) ───────── -->
  <div class="cv-section" data-testid="toybox-cv-section">
    <button
      type="button"
      class="combine-toggle"
      data-testid="toybox-cv-toggle"
      aria-expanded={cvOpen}
      onclick={() => (cvOpen = !cvOpen)}
    >
      {cvOpen ? '▾' : '▸'} CV / MOD
    </button>

    {#if cvOpen}
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
  </div><!-- /toybox-col-right -->
  </div><!-- /toybox-cols -->
</div>

<style>
  .mod-card {
    /* Wide 3-column card (preview + layer editor | combine graph | CV section). */
    width: 860px;
    min-height: 300px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  /* ── 3-column body ── */
  .toybox-cols {
    display: flex;
    align-items: flex-start;
    gap: 1px;
    /* clear the left input-port labels (IN1..IN6 down the edge). */
    padding-left: 30px;
  }
  .toybox-col {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .toybox-col-left { width: 250px; flex: 0 0 250px; }
  .toybox-col-center {
    width: 320px;
    flex: 0 0 320px;
    border-left: 1px solid var(--border);
    border-right: 1px solid var(--border);
    padding: 0 4px;
  }
  .toybox-col-right { width: 256px; flex: 0 0 256px; padding-left: 4px; }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--cable-video);
  }
  .port-label {
    position: absolute;
    font-size: 0.6rem;
    color: var(--text-dim);
    pointer-events: none;
    font-family: ui-monospace, monospace;
  }
  .port-label.right { right: 14px; }
  .port-label.left { left: 14px; }
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
  .combine-toggle {
    width: 100%;
    text-align: left;
    background: transparent;
    color: var(--text-dim);
    border: none;
    font-family: ui-monospace, monospace;
    font-size: 0.62rem;
    letter-spacing: 0.06em;
    cursor: pointer;
    padding: 2px 0;
  }
  .combine-toggle:hover { color: var(--text); }
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
