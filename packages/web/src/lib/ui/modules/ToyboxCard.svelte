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
    DEFAULT_CONTENT_ID,
    DEFAULT_MODEL_ID,
    LAYER_COUNT,
    MATCAP_STYLES,
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
    patchToOutput,
    clearCombineEdges,
    resetCombineToDefault,
    duplicateCombineNode,
  } from '$lib/graph/toybox-combine';
  import ToyboxNodeMenu from './ToyboxNodeMenu.svelte';
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
  import {
    clampLayerIndex,
    setLayerKind,
    setLayerContent,
    setLayerParam,
    setLayerModel,
    setLayerMatcap,
    setLayerSurfaceSource,
    setLayerMaterialField,
  } from '$lib/graph/toybox-layers';

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
  }

  function onContentChange(ev: Event) {
    const sel = (ev.target as HTMLSelectElement).value;
    if (!sel) return;
    setLayerContent(id, activeLayer, sel);
    bumpRev();
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
    if (!res.ok) showConnectError(res.error);
    else clearConnectMsg();
  }

  /** Remove EVERY edge touching `gid` (in or out). */
  function doDisconnect(gid: string): void {
    for (const eid of edgesTouching(graph, gid)) deleteCombineEdge(id, eid);
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
    clearConnectMsg();
  }

  function doDuplicate(gid: string): void {
    const newId = duplicateCombineNode(id, gid);
    if (newId) selectedNodeId = newId;
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
    clearConnectMsg();
  }

  function doClearNodeMap(): void {
    clearCombineEdges(id);
    selectedNodeId = null;
    clearConnectMsg();
  }

  function doResetToDefault(): void {
    resetCombineToDefault(id);
    selectedNodeId = null;
    pendingFrom = null;
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
      value={currentKind}
      onchange={onKindChange}
    >
      <option value="gen">SHADER</option>
      <option value="obj">OBJ</option>
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
