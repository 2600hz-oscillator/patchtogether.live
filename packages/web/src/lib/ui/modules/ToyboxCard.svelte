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
    ensureToyboxCatalog,
    getContentMeta,
    listAllContent,
    makeDefaultLayers,
    type ToyboxContent,
    type ToyboxLayer,
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

  // ----- Content catalog (loaded from the static manifest) -----
  let catalog: ToyboxContent[] = $state([]);
  onMount(() => {
    void (async () => {
      await ensureToyboxCatalog();
      catalog = await listAllContent();
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

  /** Layer 0 from the live store (P1 renders only this layer). */
  function layer0(): ToyboxLayer | undefined {
    const layers = (node?.data?.layers as ToyboxLayer[] | undefined);
    return layers?.[0];
  }
  let currentContentId = $derived(layer0()?.contentId ?? DEFAULT_CONTENT_ID);
  // Derive from the reactive `catalog` (not the module-level lookup) so the
  // faders appear as soon as the manifest loads, and re-derive when the
  // selected content changes.
  let currentMeta = $derived(catalog.find((c) => c.id === currentContentId));

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
