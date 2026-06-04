<script lang="ts">
  // ToyboxCard — UI for the TOYBOX 4-layer compositor (P2).
  //
  // Card layout:
  //   - Live output preview (blitOutputToDrawingBuffer + drawImage from the
  //     video engine canvas — the MANDELBULB / ACIDWARP pattern).
  //   - 4 LAYER rows. Each row: a KIND selector (Shader/Gen/Video/Off) + a
  //     CONTENT dropdown (for shader/gen kinds) + a fader per declared param of
  //     the selected content. Writing a row mutates node.data.layers[i]; it
  //     rides Y.Doc out to rack-mates and is read live by the factory.
  //   - COMBINE section: knobs for the fixed default chain's exposed params —
  //     fade t, map mode/mix, lumakey threshold/softness. (P4 replaces this
  //     with a node editor; the math + defaults already live in the factory.)
  //
  // VRT: exposes window.__toyboxFreeze(time) which pins the engine-side iTime
  // to a constant (pixel-stable shader render) AND pauses the on-card preview
  // pull so the captured canvas matches the frozen FBO.

  import { onMount, onDestroy } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import { patch } from '$lib/graph/store';
  import {
    DEFAULT_CONTENT_ID,
    LAYER_COUNT,
    TOYBOX_BLEND_MODES,
    COMBINE_OP_DEFAULTS,
    ensureToyboxCatalog,
    getContentMeta,
    listAllContent,
    makeDefaultLayers,
    makeDefaultCombine,
    type ToyboxContent,
    type ToyboxLayer,
    type ToyboxLayerKind,
    type ToyboxCombine,
  } from '$lib/video/toybox-content';
  import type { VideoEngine } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  const ENGINE_W = 640;
  const ENGINE_H = 480;
  const CANVAS_W = 200;
  const CANVAS_H = Math.round(CANVAS_W * (ENGINE_H / ENGINE_W)); // 150

  const LAYER_INDICES = Array.from({ length: LAYER_COUNT }, (_, i) => i);
  const KINDS: Array<{ value: ToyboxLayerKind; label: string }> = [
    { value: 'gen', label: 'Gen' },
    { value: 'shader', label: 'Shader' },
    { value: 'video', label: 'Video' },
    { value: 'off', label: 'Off' },
  ];

  // ----- Content catalog (loaded from the static manifest) -----
  let catalog: ToyboxContent[] = $state([]);
  onMount(() => {
    void (async () => {
      await ensureToyboxCatalog();
      catalog = await listAllContent();
      // Seed defaults so the factory + card agree from first paint.
      const t = patch.nodes[id];
      if (t) {
        if (!t.data) t.data = {};
        const d = t.data as { layers?: unknown; combine?: unknown };
        if (!Array.isArray(d.layers)) (t.data as { layers: ToyboxLayer[] }).layers = makeDefaultLayers();
        if (!d.combine) (t.data as { combine: ToyboxCombine }).combine = makeDefaultCombine();
      }
    })();
  });

  /** Live layers array (factory + card share this). */
  function layers(): ToyboxLayer[] | undefined {
    return node?.data?.layers as ToyboxLayer[] | undefined;
  }
  function layerAt(i: number): ToyboxLayer | undefined {
    return layers()?.[i];
  }

  /** Ensure node.data.layers exists + return layer i (mutable, store-backed). */
  function ensureLayer(i: number): ToyboxLayer | null {
    const t = patch.nodes[id];
    if (!t) return null;
    if (!t.data) t.data = {};
    const d = t.data as { layers?: ToyboxLayer[] };
    if (!Array.isArray(d.layers) || d.layers.length < LAYER_COUNT) d.layers = makeDefaultLayers();
    return d.layers[i]!;
  }

  /** Ensure node.data.combine exists + return it (mutable, store-backed). */
  function ensureCombine(): ToyboxCombine | null {
    const t = patch.nodes[id];
    if (!t) return null;
    if (!t.data) t.data = {};
    const d = t.data as { combine?: ToyboxCombine };
    if (!d.combine || !Array.isArray(d.combine.nodes)) d.combine = makeDefaultCombine();
    return d.combine;
  }

  function metaFor(i: number): ToyboxContent | undefined {
    const cid = layerAt(i)?.contentId;
    if (!cid) return undefined;
    return catalog.find((c) => c.id === cid);
  }

  function paramVal(i: number, pid: string): number {
    const v = layerAt(i)?.params?.[pid];
    if (typeof v === 'number') return v;
    return metaFor(i)?.params.find((p) => p.id === pid)?.default ?? 0;
  }

  function onKindChange(i: number, ev: Event) {
    const sel = (ev.target as HTMLSelectElement).value as ToyboxLayerKind;
    const l = ensureLayer(i);
    if (!l) return;
    l.kind = sel;
    if (sel === 'shader' || sel === 'gen') {
      // Seed a content id if none yet (default content).
      if (!l.contentId) {
        l.contentId = DEFAULT_CONTENT_ID;
        const meta = getContentMeta(DEFAULT_CONTENT_ID);
        const params: Record<string, number> = {};
        if (meta) for (const p of meta.params) params[p.id] = p.default;
        l.params = params;
      }
    }
  }

  function onContentChange(i: number, ev: Event) {
    const sel = (ev.target as HTMLSelectElement).value;
    if (!sel) return;
    const meta = getContentMeta(sel);
    if (!meta) return;
    const l = ensureLayer(i);
    if (!l) return;
    l.kind = meta.family === 'GEN' ? 'gen' : 'shader';
    l.contentId = sel;
    const params: Record<string, number> = {};
    for (const p of meta.params) params[p.id] = p.default;
    l.params = params;
  }

  const setLayerParam = (i: number, pid: string) => (v: number) => {
    const l = ensureLayer(i);
    if (!l) return;
    if (!l.params) l.params = {};
    l.params[pid] = v;
  };

  // ----- Combine-op params (fixed default chain) -----
  function combineNode(opId: string): { params?: Record<string, number> } | undefined {
    const c = node?.data?.combine as ToyboxCombine | undefined;
    return c?.nodes.find((n) => n.id === opId);
  }
  function combineParam(opId: string, pid: string, fallback: number): number {
    const v = combineNode(opId)?.params?.[pid];
    return typeof v === 'number' ? v : fallback;
  }
  const setCombineParam = (opId: string, pid: string) => (v: number) => {
    const c = ensureCombine();
    if (!c) return;
    const n = c.nodes.find((nn) => nn.id === opId);
    if (!n) return;
    if (!n.params) n.params = {};
    n.params[pid] = v;
  };
  function onMapModeChange(ev: Event) {
    const idx = Number((ev.target as HTMLSelectElement).value);
    setCombineParam('map', 'mode')(idx);
  }
  let mapMode = $derived(Math.round(combineParam('map', 'mode', 0)));

  // ----- Live preview pull (MANDELBULB pattern) -----
  let canvasEl: HTMLCanvasElement | null = $state(null);
  let rafId: number | null = null;
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
    if (frozen) return;
    blitOnce();
  }

  onMount(() => {
    rafId = requestAnimationFrame(draw);
    const g = globalThis as unknown as {
      __toyboxFreeze?: (time?: number) => void;
      __toyboxFreezeTime?: number | null;
    };
    g.__toyboxFreeze = (time?: number) => {
      if (typeof time === 'number') {
        g.__toyboxFreezeTime = time;
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

  <!-- Video INPUT ports (one per layer). -->
  {#each LAYER_INDICES as i (i)}
    <Handle
      type="target"
      position={Position.Left}
      id={`layer${i}_in`}
      style={`top: ${56 + i * 18}px; --handle-color: var(--cable-video);`}
    />
    <span class="port-label left" style={`top: ${50 + i * 18}px;`}>L{i}</span>
  {/each}

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

  <!-- Per-layer rows. -->
  <div class="layers" data-testid="toybox-layers">
    {#each LAYER_INDICES as i (i)}
      {@const l = layerAt(i)}
      {@const meta = metaFor(i)}
      <div class="layer-row" data-testid={`toybox-layer-${i}`}>
        <div class="layer-head">
          <span class="layer-idx">L{i}</span>
          <select
            class="kind-select"
            data-testid={`toybox-layer-${i}-kind`}
            value={l?.kind ?? 'off'}
            onchange={(ev) => onKindChange(i, ev)}
          >
            {#each KINDS as k (k.value)}
              <option value={k.value}>{k.label}</option>
            {/each}
          </select>
          {#if l?.kind === 'shader' || l?.kind === 'gen'}
            <select
              class="content-select"
              data-testid={`toybox-layer-${i}-content`}
              value={l?.contentId ?? DEFAULT_CONTENT_ID}
              onchange={(ev) => onContentChange(i, ev)}
            >
              {#each catalog as c (c.id)}
                <option value={c.id}>{c.family} · {c.label}</option>
              {/each}
            </select>
          {/if}
        </div>
        {#if (l?.kind === 'shader' || l?.kind === 'gen') && meta}
          <div class="knob-grid">
            {#each meta.params as p (p.id)}
              <Knob
                value={paramVal(i, p.id)}
                min={p.min} max={p.max} defaultValue={p.default}
                label={p.label} curve={p.curve}
                onchange={setLayerParam(i, p.id)} moduleId={id} paramId={`l${i}.${p.id}`}
              />
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <!-- Combine section (fixed default chain). -->
  <div class="combine" data-testid="toybox-combine">
    <div class="combine-title">COMBINE</div>
    <div class="combine-op">
      <span class="op-name">FADE</span>
      <div class="knob-grid">
        <Knob
          value={combineParam('fade', 't', COMBINE_OP_DEFAULTS.fade.t)}
          min={0} max={1} defaultValue={COMBINE_OP_DEFAULTS.fade.t}
          label="T" curve="linear"
          onchange={setCombineParam('fade', 't')} moduleId={id} paramId="fade.t"
        />
      </div>
    </div>
    <div class="combine-op">
      <span class="op-name">MAP</span>
      <select
        class="content-select map-mode"
        data-testid="toybox-map-mode"
        value={String(mapMode)}
        onchange={onMapModeChange}
      >
        {#each TOYBOX_BLEND_MODES as m, idx (m)}
          <option value={String(idx)}>{m}</option>
        {/each}
      </select>
      <div class="knob-grid">
        <Knob
          value={combineParam('map', 'mix', COMBINE_OP_DEFAULTS.map.mix)}
          min={0} max={1} defaultValue={COMBINE_OP_DEFAULTS.map.mix}
          label="MIX" curve="linear"
          onchange={setCombineParam('map', 'mix')} moduleId={id} paramId="map.mix"
        />
      </div>
    </div>
    <div class="combine-op">
      <span class="op-name">LUMAKEY</span>
      <div class="knob-grid">
        <Knob
          value={combineParam('key', 'threshold', COMBINE_OP_DEFAULTS.lumakey.threshold)}
          min={0} max={1} defaultValue={COMBINE_OP_DEFAULTS.lumakey.threshold}
          label="THR" curve="linear"
          onchange={setCombineParam('key', 'threshold')} moduleId={id} paramId="key.threshold"
        />
        <Knob
          value={combineParam('key', 'softness', COMBINE_OP_DEFAULTS.lumakey.softness)}
          min={0} max={0.5} defaultValue={COMBINE_OP_DEFAULTS.lumakey.softness}
          label="SOFT" curve="linear"
          onchange={setCombineParam('key', 'softness')} moduleId={id} paramId="key.softness"
        />
      </div>
    </div>
  </div>
</div>

<style>
  .mod-card {
    width: 250px;
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
    font-size: 0.55rem;
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
  .layers { padding: 0 12px; }
  .layer-row {
    border-top: 1px solid var(--border);
    padding: 6px 0;
  }
  .layer-head {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .layer-idx {
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
    color: var(--text-dim);
    width: 16px;
  }
  .kind-select, .content-select {
    background: var(--module-bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 3px;
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
    padding: 2px 3px;
  }
  .kind-select { flex: 0 0 auto; }
  .content-select { flex: 1; min-width: 0; }
  .kind-select:hover, .content-select:hover { border-color: var(--accent-dim); }
  .knob-grid {
    margin-top: 4px;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px 4px;
    justify-items: center;
  }
  .combine {
    margin-top: 6px;
    padding: 0 12px;
    border-top: 2px solid var(--cable-video);
  }
  .combine-title {
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
    color: var(--cable-video);
    letter-spacing: 0.08em;
    margin: 6px 0 2px;
  }
  .combine-op { padding: 4px 0; }
  .op-name {
    font-family: ui-monospace, monospace;
    font-size: 0.55rem;
    color: var(--text-dim);
    letter-spacing: 0.05em;
  }
  .map-mode { width: 100%; margin-top: 3px; }
</style>
