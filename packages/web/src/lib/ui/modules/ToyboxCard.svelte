<script lang="ts">
  // ToyboxCard — UI for the TOYBOX swappable fragment-shader source (P1).
  //
  // Card layout:
  //   - CONTENT dropdown: pick a shader/gen from the bundled bank. Writing
  //     the selection mutates node.data.layers[0] (kind + contentId + resets
  //     params to the content's manifest defaults), which rides Y.Doc out to
  //     rack-mates and is read live by the factory.
  //   - One fader per declared float-uniform param of the selected content
  //     (the manifest is the single source of truth). Faders write to
  //     node.data.layers[0].params[<id>].
  //   - Live output preview (blitOutputToDrawingBuffer + drawImage from the
  //     video engine canvas — the MANDELBULB / ACIDWARP pattern).
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
    DEFAULT_CONTENT_ID,
    DEFAULT_MODEL_ID,
    MATCAP_STYLES,
    ensureToyboxCatalog,
    getContent,
    getContentMeta,
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
  } from '$lib/video/toybox-content';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';
  import {
    OP_KINDS,
    OP_PARAMS,
    inPortsFor,
    hasOutPort,
    isCombineGraph,
    makeDefaultCombineGraph,
    type ToyboxCombineGraph,
    type ToyboxGraphNode,
    type ToyboxInPort,
    type ToyboxOpKind,
  } from '$lib/video/toybox-combine-graph';
  import {
    addCombineNode,
    connectCombine,
    deleteCombineEdge,
    deleteCombineNode,
    setCombineNodeParam,
  } from '$lib/graph/toybox-combine';
  import {
    CV_PORT_IDS,
    listCvTargets,
    listCvParams,
    encodeTargetValue,
    decodeTargetValue,
    type CvRoutes,
    type CvRouteTarget,
  } from '$lib/video/toybox-cv-routes';
  import { setCvRoute } from '$lib/graph/toybox-cv-routes';
  import { loadToyboxPreset } from '$lib/graph/toybox-presets';

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

  /** Layer 0 from the live store (the card edits layer 0; the combine DAG +
   *  layers 1-3 are programmatic for now). */
  function layer0(): ToyboxLayer | undefined {
    const layers = (node?.data?.layers as ToyboxLayer[] | undefined);
    return layers?.[0];
  }
  // The layer's kind selects which control cluster shows: shader/gen → content
  // dropdown + param faders; obj → model dropdown + transform/matcap controls.
  let currentKind = $derived<ToyboxLayerKind>(layer0()?.kind ?? 'gen');
  let isObj = $derived(currentKind === 'obj');
  let currentContentId = $derived(layer0()?.contentId ?? DEFAULT_CONTENT_ID);
  // Derive from the reactive `catalog` (not the module-level lookup) so the
  // faders appear as soon as the manifest loads, and re-derive when the
  // selected content changes.
  let currentMeta = $derived(catalog.find((c) => c.id === currentContentId));

  // ----- OBJ-layer derived state -----
  let currentMaterial = $derived(layer0()?.material ?? makeDefaultObjMaterial());
  let currentModelId = $derived(currentMaterial.modelId ?? DEFAULT_MODEL_ID);

  /** Read a live param value for the selected content, defaulting to the
   *  manifest default when the layer hasn't set it. */
  function paramVal(pid: string): number {
    const v = layer0()?.params?.[pid];
    if (typeof v === 'number') return v;
    return currentMeta?.params.find((p) => p.id === pid)?.default ?? 0;
  }

  /** Ensure node.data.layers[0] exists + return it (mutable, store-backed). */
  function ensureLayer0(): ToyboxLayer | null {
    const t = patch.nodes[id];
    if (!t) return null;
    if (!t.data) t.data = {};
    const d = t.data as { layers?: ToyboxLayer[] };
    if (!Array.isArray(d.layers) || d.layers.length === 0) d.layers = makeDefaultLayers();
    return d.layers[0]!;
  }

  /** Ensure layer 0 has a material object + return it (mutable). */
  function ensureMaterial(): ToyboxObjMaterial | null {
    const l0 = ensureLayer0();
    if (!l0) return null;
    if (!l0.material) l0.material = makeDefaultObjMaterial();
    return l0.material;
  }

  // The layer-KIND selector: 'gen'/'shader' route through content; 'obj' is the
  // 3D mesh layer; 'off' renders nothing.
  function onKindChange(ev: Event) {
    const sel = (ev.target as HTMLSelectElement).value as ToyboxLayerKind;
    const l0 = ensureLayer0();
    if (!l0) return;
    l0.kind = sel;
    if (sel === 'obj') {
      // Seed a material (+ default model + its preferred matcap) if missing.
      if (!l0.material) {
        const mat = makeDefaultObjMaterial(DEFAULT_MODEL_ID);
        const mm = getModelMeta(DEFAULT_MODEL_ID);
        if (mm && typeof mm.matcap === 'number') mat.matcap = mm.matcap;
        l0.material = mat;
      }
    } else if (sel === 'gen' || sel === 'shader') {
      // Make sure there's a content id to render.
      if (!l0.contentId) {
        const meta = getContentMeta(DEFAULT_CONTENT_ID);
        l0.contentId = DEFAULT_CONTENT_ID;
        l0.kind = meta?.family === 'GEN' ? 'gen' : 'shader';
        const params: Record<string, number> = {};
        if (meta) for (const p of meta.params) params[p.id] = p.default;
        l0.params = params;
      }
    }
  }

  function onContentChange(ev: Event) {
    const sel = (ev.target as HTMLSelectElement).value;
    if (!sel) return;
    const meta = getContentMeta(sel);
    if (!meta) return;
    const l0 = ensureLayer0();
    if (!l0) return;
    l0.kind = meta.family === 'GEN' ? 'gen' : 'shader';
    l0.contentId = sel;
    // Reset params to the new content's defaults so faders start sensibly.
    const params: Record<string, number> = {};
    for (const p of meta.params) params[p.id] = p.default;
    l0.params = params;
  }

  function onModelChange(ev: Event) {
    const sel = (ev.target as HTMLSelectElement).value;
    if (!sel) return;
    const mat = ensureMaterial();
    if (!mat) return;
    mat.modelId = sel;
    const mm = getModelMeta(sel);
    if (mm && typeof mm.matcap === 'number') mat.matcap = mm.matcap;
  }

  function onMatcapChange(ev: Event) {
    const mat = ensureMaterial();
    if (!mat) return;
    mat.matcap = parseInt((ev.target as HTMLSelectElement).value, 10) || 0;
  }

  /** Setter for one numeric OBJ-material field (transform/spin/tint). */
  const setMat = (key: keyof ToyboxObjMaterial) => (v: number) => {
    const mat = ensureMaterial();
    if (!mat) return;
    (mat as unknown as Record<string, number>)[key as string] = v;
  };

  function matVal(key: keyof ToyboxObjMaterial): number {
    const v = currentMaterial[key];
    return typeof v === 'number' ? v : 0;
  }

  const setParam = (pid: string) => (v: number) => {
    const l0 = ensureLayer0();
    if (!l0) return;
    if (!l0.params) l0.params = {};
    l0.params[pid] = v;
  };

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

  /** Live combine graph from the store (default graph until the card edits it). */
  let graph = $derived.by<ToyboxCombineGraph>(() => {
    const c = (node?.data as { combine?: unknown } | undefined)?.combine;
    return isCombineGraph(c) ? (c as ToyboxCombineGraph) : makeDefaultCombineGraph();
  });

  // Editor interaction state.
  let editorOpen = $state(false);
  /** A pending output port we clicked first (click-port-then-port connect). */
  let pendingFrom = $state<string | null>(null);
  /** The currently-selected op node (its params show in the side strip). */
  let selectedNodeId = $state<string | null>(null);
  /** Transient connect-rejection message for the user. */
  let connectMsg = $state<string | null>(null);

  function nodeById(gid: string): ToyboxGraphNode | undefined {
    return graph.nodes.find((n) => n.id === gid);
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

  /** A short glyph/label for a node box. */
  function nodeLabel(n: ToyboxGraphNode): string {
    if (n.kind === 'source') return `L${n.layer ?? 0}`;
    if (n.kind === 'output') return 'OUT';
    return n.kind.toUpperCase().slice(0, 5);
  }

  function clearConnectMsg(): void {
    connectMsg = null;
  }

  // ---- interactions ----

  function onAddOp(kind: ToyboxOpKind): void {
    const newId = addCombineNode(id, kind);
    if (newId) selectedNodeId = newId;
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
    deleteCombineNode(id, gid);
    if (selectedNodeId === gid) selectedNodeId = null;
    clearConnectMsg();
  }

  function onDeleteEdge(edgeId: string): void {
    deleteCombineEdge(id, edgeId);
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
  };

  let selectedNode = $derived(selectedNodeId ? nodeById(selectedNodeId) : undefined);
  let selectedParams = $derived(
    selectedNode && selectedNode.kind !== 'source' && selectedNode.kind !== 'output'
      ? OP_PARAMS[selectedNode.kind as ToyboxOpKind] ?? []
      : [],
  );

  // ───────────────────── CV ROUTING TAB (Phase 5) ─────────────────────
  //
  // A FIXED pool of 8 generic CV input ports (cv1..cv8) routed to addressed
  // params via node.data.cvRoutes. Each row is a two-dropdown selector:
  //   [target ▾ = layer0..3 / a combine op] [param ▾ = that target's params].
  // The available targets/params are derived LIVE from the layers' content
  // params + the combine op nodes (toybox-cv-routes.ts). Selecting writes the
  // route through the Yjs mutator (graph/toybox-cv-routes.ts); the factory's
  // setParam(cvN) resolves + re-scales each sample into the live param.

  let cvOpen = $state(false);

  /** The live layers + combine the dropdowns enumerate targets/params from. */
  let liveLayersForCv = $derived(node?.data?.layers as ToyboxLayer[] | undefined);
  let liveCombineForCv = $derived((node?.data as { combine?: unknown } | undefined)?.combine);

  /** Target options (layers + combine ops), live. */
  let cvTargets = $derived(listCvTargets(liveLayersForCv, liveCombineForCv));

  // Per-port reactive maps. We iterate ALL ports inside ONE $derived.by so every
  // route key is READ (and thus tracked) every recompute — without this, adding
  // a 2nd route to the in-place-mutated cvRoutes Y-proxy wouldn't invalidate a
  // per-port helper that only read its own key (the Y-proxy object reference
  // doesn't change on a key add). cvRoutesView is read first so the whole map is
  // a dependency.
  let cvRoutesView = $derived.by<Record<string, CvRouteTarget | null>>(() => {
    const live = (node?.data as { cvRoutes?: CvRoutes } | undefined)?.cvRoutes;
    const out: Record<string, CvRouteTarget | null> = {};
    for (const p of CV_PORT_IDS) {
      const r = live && typeof live === 'object' ? live[p] : undefined;
      // Copy to a plain object so the snapshot is stable + every field is read.
      out[p] = r ? { target: r.target, layer: r.layer, nodeId: r.nodeId, param: r.param } : null;
    }
    return out;
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

  // ───────────────────── PRESETS (Phase 6) ─────────────────────
  //
  // A dropdown of the bundled presets (manifest `presets[]`). Selecting one
  // writes its layers/combine/cvRoutes into node.data IN PLACE (the Yjs mutator
  // graph/toybox-presets.ts) so the factory renders the preset's composite next
  // frame, then PREFETCHES any GLSL/OBJ the preset references so the first paint
  // is snappy (the factory's fetch is lazy, but warming the cache avoids a black
  // flash). Exposes a debug __toyboxLoadPreset(id) hook for VRT/e2e determinism.

  let presetSel = $state('');

  /** Prefetch every content shader / OBJ a preset references (warm the cache).
   *  Best-effort: failures are swallowed (the factory retries on its own). */
  function prefetchPresetAssets(preset: ToyboxPreset): void {
    for (const layer of preset.layers ?? []) {
      if ((layer.kind === 'shader' || layer.kind === 'gen') && layer.contentId) {
        void getContent(layer.contentId).catch(() => {});
      } else if (layer.kind === 'obj' && layer.material) {
        const modelId = layer.material.modelId;
        const meta = modelId ? getModelMeta(modelId) : undefined;
        // Built-in primitives have no OBJ to fetch (the factory builds them).
        if (meta?.obj) void getModelObj(modelId).catch(() => {});
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
    void loadPreset(value);
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
    const r = fitRect(cw, ch);
    ctx2d.drawImage(src, r.x, r.y, r.w, r.h);
  }

  function draw() {
    rafId = requestAnimationFrame(draw);
    if (frozen) return; // hold the last frame (VRT)
    blitOnce();
  }

  onMount(() => {
    rafId = requestAnimationFrame(draw);
    // VRT debug hook: pin the engine-side iTime to `time` (constant) so the
    // shader render is deterministic, blit once with the new frozen frame,
    // then pause the preview pull. Call with no/undefined arg to resume.
    const g = globalThis as unknown as {
      __toyboxFreeze?: (time?: number) => void;
      __toyboxFreezeTime?: number | null;
      __toyboxLoadPreset?: (presetId: string) => Promise<boolean>;
    };
    // VRT/e2e determinism hook: load a bundled preset by id into THIS node's
    // data (in place) + prefetch its assets. Returns the apply verdict.
    g.__toyboxLoadPreset = (presetId: string) => loadPreset(presetId);
    g.__toyboxFreeze = (time?: number) => {
      if (typeof time === 'number') {
        g.__toyboxFreezeTime = time;
        // Force the engine to render one frame at the pinned time, then
        // pull it into the on-card canvas, then freeze the preview.
        const e = engineCtx.get();
        try { e?.getDomain<VideoEngine>('video')?.step(); } catch { /* */ }
        blitOnce();
        frozen = true;
      } else {
        g.__toyboxFreezeTime = null;
        frozen = false;
      }
    };
  });
  onDestroy(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
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

  <!-- PHASE 5: the 8 generic CV input ports (cv1..cv8). Real input handles —
       the outer canvas draws CV cables to them; each is routed to a param via
       the CV tab below. Stacked down the left edge. -->
  {#each CV_PORT_IDS as cvId, i (cvId)}
    <Handle
      type="target"
      position={Position.Left}
      id={cvId}
      style={`top: ${44 + i * 22}px; --handle-color: var(--cable-cv);`}
    />
    <span class="port-label left" style={`top: ${38 + i * 22}px;`}>{cvId.toUpperCase()}</span>
  {/each}

  <div class="screen-wrap">
    <canvas
      bind:this={canvasEl}
      width={CANVAS_W}
      height={CANVAS_H}
      data-testid="toybox-canvas"
      data-node-id={id}
    ></canvas>
  </div>

  <!-- PRESETS (Phase 6): pick a bundled preset → writes layers/combine/cvRoutes
       into node.data in place. An "apply" action (resets to placeholder). -->
  {#if presets.length > 0}
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
        {#each presets as p (p.id)}
          <option value={p.id}>{p.label}</option>
        {/each}
      </select>
    </div>
  {/if}

  <!-- LAYER KIND selector: shader/gen (content) vs OBJ (3D mesh). -->
  <div class="content-row">
    <label class="content-label" for={`toybox-kind-${id}`}>LAYER</label>
    <select
      id={`toybox-kind-${id}`}
      class="content-select"
      data-testid="toybox-kind-select"
      value={currentKind}
      onchange={onKindChange}
    >
      <option value="gen">SHADER</option>
      <option value="obj">OBJ</option>
      <option value="off">OFF</option>
    </select>
  </div>

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
    </div>
  {:else if currentKind === 'gen' || currentKind === 'shader'}
    <div class="content-row">
      <label class="content-label" for={`toybox-content-${id}`}>CONTENT</label>
      <select
        id={`toybox-content-${id}`}
        class="content-select"
        data-testid="toybox-content-select"
        value={currentContentId}
        onchange={onContentChange}
      >
        {#each catalog as c (c.id)}
          <option value={c.id}>{c.family} · {c.label}</option>
        {/each}
      </select>
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
  {/if}

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

      <!-- Bespoke SVG node editor: boxes + port dots + bezier cables. -->
      <div class="graph-wrap">
        <svg
          class="graph-svg"
          viewBox={`0 0 ${G_W} ${G_H}`}
          preserveAspectRatio="xMidYMid meet"
          data-testid="toybox-graph-svg"
        >
          <!-- Edges (cables) drawn under the nodes. -->
          {#each graph.edges as e (e.id)}
            {@const fromN = nodeById(e.from)}
            {@const toN = nodeById(e.to)}
            {#if fromN && toN}
              <path
                class="cable"
                data-testid={`toybox-edge-${e.id}`}
                d={cablePath(outPortXY(fromN), inPortXY(toN, e.toPort))}
                onclick={() => onDeleteEdge(e.id)}
                role="button"
                tabindex="-1"
                aria-label={`delete edge ${e.id}`}
              />
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

      <!-- Selected op node → its params in a side strip. -->
      {#if selectedNode && selectedParams.length > 0}
        <div class="combine-params" data-testid="toybox-combine-params" data-node={selectedNode.id}>
          <div class="combine-params-title">{selectedNode.kind.toUpperCase()} · {selectedNode.id}</div>
          <div class="knob-grid">
            {#each selectedParams as p (p.id)}
              <Knob
                value={combineParamVal(selectedNode, p.id)}
                min={p.min} max={p.max} defaultValue={p.default}
                label={p.label} curve="linear"
                onchange={setCombineParam(selectedNode.id, p.id)}
                moduleId={id} paramId={`combine:${selectedNode.id}:${p.id}`}
              />
            {/each}
          </div>
        </div>
      {/if}
    {/if}
  </div>

  <!-- ───────── CV ROUTING (Phase 5) ───────── -->
  <div class="cv-section" data-testid="toybox-cv-section">
    <button
      type="button"
      class="combine-toggle"
      data-testid="toybox-cv-toggle"
      aria-expanded={cvOpen}
      onclick={() => (cvOpen = !cvOpen)}
    >
      {cvOpen ? '▾' : '▸'} CV
    </button>

    {#if cvOpen}
      <div class="cv-rows" data-testid="toybox-cv-rows">
        {#each CV_PORT_IDS as cvId (cvId)}
          {@const paramOpts = paramOptionsFor(cvId)}
          <div class="cv-row" data-testid={`toybox-cv-row-${cvId}`}>
            <span class="cv-port">{cvId.toUpperCase()}</span>
            <select
              class="cv-select"
              data-testid={`toybox-cv-target-${cvId}`}
              value={targetValueFor(cvId)}
              onchange={(e) => onCvTargetChange(cvId, e)}
              aria-label={`${cvId} target`}
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
              aria-label={`${cvId} param`}
            >
              {#if paramOpts.length === 0}
                <option value="">—</option>
              {/if}
              {#each paramOpts as p (p.id)}
                <option value={p.id}>{p.label}</option>
              {/each}
            </select>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .mod-card {
    width: 240px;
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
  .knob-grid {
    margin-top: 4px;
    padding: 0 14px;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px 4px;
    justify-items: center;
  }

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
    overflow: hidden;
    margin: 4px 0;
  }
  .graph-svg {
    display: block;
    width: 100%;
    height: auto;
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
    cursor: pointer;
  }
  .cable:hover { stroke: #e05050; opacity: 1; }
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

  /* ───────── CV ROUTING (Phase 5) ───────── */
  .cv-section {
    margin-top: 8px;
    padding: 8px 12px 0;
    border-top: 1px solid var(--border);
  }
  .cv-rows {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 6px 0 2px;
  }
  .cv-row {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .cv-port {
    font-family: ui-monospace, monospace;
    font-size: 0.55rem;
    color: var(--cable-cv, var(--text-dim));
    width: 26px;
    flex: 0 0 auto;
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
