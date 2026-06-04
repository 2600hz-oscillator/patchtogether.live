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
    getContentMeta,
    getModelMeta,
    listAllContent,
    listModels,
    makeDefaultLayers,
    makeDefaultObjMaterial,
    type ToyboxContent,
    type ToyboxLayer,
    type ToyboxLayerKind,
    type ToyboxModel,
    type ToyboxObjMaterial,
  } from '$lib/video/toybox-content';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

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
  const MATCAP_LABELS = ['CHROME', 'CLAY', 'NEON'];
  onMount(() => {
    void (async () => {
      await ensureToyboxCatalog();
      catalog = await listAllContent();
      models = await listModels();
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
    };
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

  <div class="screen-wrap">
    <canvas
      bind:this={canvasEl}
      width={CANVAS_W}
      height={CANVAS_H}
      data-testid="toybox-canvas"
      data-node-id={id}
    ></canvas>
  </div>

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
</style>
