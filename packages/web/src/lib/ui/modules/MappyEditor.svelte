<script lang="ts">
  // MappyEditor — the full-window MAP editor for MAPPY: a large composite
  // preview with big, precise corner-pin handles for every LIVE surface, plus
  // surface tabs, +/−, the GRID override, and snap-to-grid. Opened from the
  // card's "MAP" button. All edits go through the shared $lib/ui/modules/
  // mappy-edit helpers (Yjs in-place discipline).

  import { onMount, onDestroy } from 'svelte';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import {
    MAPPY_SURFACE_COUNT,
    MAPPY_MIN_SURFACES,
    MAPPY_SURFACE_COLORS,
    normalizeSurfaces,
    surfaceFitOn,
    type MappySurfaceState,
  } from '$lib/video/modules/mappy';
  import {
    getSurfaceCount,
    addSurface,
    removeSurface,
    setCorner,
    moveSurface,
    resetSurface,
    toggleGrid,
    toggleSurfaceFit,
  } from './mappy-edit';
  import { hitTestSurfaces } from './mappy-hit';

  let {
    id,
    node,
    connected,
    onClose,
  }: {
    id: string;
    node: ModuleNode | undefined;
    connected: boolean[];
    onClose: () => void;
  } = $props();

  // ───────── derived state from the live node ─────────
  let surfaces = $derived<MappySurfaceState[]>(
    normalizeSurfaces((node?.data as { surfaces?: unknown } | undefined)?.surfaces),
  );
  let surfaceCount = $derived<number>(getSurfaceCount(node));
  let showGrid = $derived<boolean>(
    ((node?.data as { showGrid?: unknown } | undefined)?.showGrid as boolean) ?? false,
  );
  /** A surface is editable if it's within the count OR has a connected input. */
  let live = $derived<boolean[]>(
    Array.from({ length: MAPPY_SURFACE_COUNT }, (_, i) => i < surfaceCount || !!connected[i]),
  );
  let liveCount = $derived(live.filter(Boolean).length);
  // per-surface FIT (true = zoom-fit default, false = crop/window), independent.
  let fits = $derived<boolean[]>(surfaces.map((s) => surfaceFitOn(s)));

  let selected = $state(0);
  let snap = $state(false);

  // internal SVG coordinate system (4:3, matches the engine aspect)
  const VW = 1000;
  const VH = Math.round((VW * VIDEO_RES.height) / VIDEO_RES.width); // 750

  function snapUv(v: number): number {
    return snap ? Math.round(v * 32) / 32 : v;
  }

  // ───────── pointer drag (corner OR whole-surface move) ─────────
  // ONE SVG-level pointer-down runs the shared hit-test (mappy-hit): within
  // grab range of a corner → corner-pin; else inside a surface → whole-surface
  // move. The overlay shapes are pointer-events:none so this handler decides.
  let svgEl: SVGSVGElement | null = $state(null);
  // grab radius in uv space. The editor handles draw at r≈16 over a VW-wide SVG;
  // a slightly generous threshold keeps a big handle easy to grab.
  const GRAB_UV = 18 / VW;
  let drag = $state<
    | { kind: 'corner'; surface: number; corner: number }
    | { kind: 'move'; surface: number; lastX: number; lastY: number }
    | null
  >(null);

  function uvFromPointer(ev: PointerEvent): { x: number; y: number } | null {
    if (!svgEl) return null;
    const rect = svgEl.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: (ev.clientX - rect.left) / rect.width,
      // y FLIPPED — corners are y-UP (engine vUv space, v=1 = canvas top).
      y: 1 - (ev.clientY - rect.top) / rect.height,
    };
  }

  function onOverlayDown(ev: PointerEvent): void {
    if (ev.button !== 0) return;
    const uv = uvFromPointer(ev);
    if (!uv) return;
    const hit = hitTestSurfaces(surfaces, live, [uv.x, uv.y], GRAB_UV, selected);
    if (!hit) return;
    selected = hit.surface;
    if (hit.kind === 'corner') {
      drag = { kind: 'corner', surface: hit.surface, corner: hit.corner };
    } else {
      drag = { kind: 'move', surface: hit.surface, lastX: uv.x, lastY: uv.y };
    }
    svgEl?.setPointerCapture?.(ev.pointerId);
    ev.preventDefault();
    ev.stopPropagation();
  }
  function onMove(ev: PointerEvent): void {
    if (!drag) return;
    const uv = uvFromPointer(ev);
    if (!uv) return;
    if (drag.kind === 'corner') {
      setCorner(id, drag.surface, drag.corner, snapUv(uv.x), snapUv(uv.y));
    } else {
      moveSurface(id, drag.surface, uv.x - drag.lastX, uv.y - drag.lastY);
      drag.lastX = uv.x;
      drag.lastY = uv.y;
    }
  }
  function onUp(ev: PointerEvent): void {
    if (!drag) return;
    try { svgEl?.releasePointerCapture?.(ev.pointerId); } catch { /* */ }
    drag = null;
  }

  function onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') { ev.preventDefault(); onClose(); }
  }

  // ───────── live composite preview ─────────
  let canvasEl: HTMLCanvasElement | null = $state(null);
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;
  const engineCtx = useEngine();
  let drawRaf: number | null = null;

  function draw(): void {
    drawRaf = null;
    const e = engineCtx.get();
    if (!e || !canvasEl) { drawRaf = requestAnimationFrame(draw); return; }
    let videoEngine: VideoEngine | undefined;
    try { videoEngine = e.getDomain<VideoEngine>('video'); } catch { drawRaf = requestAnimationFrame(draw); return; }
    if (!videoEngine) { drawRaf = requestAnimationFrame(draw); return; }
    const ctx2d = canvasEl.getContext('2d', { alpha: false });
    if (ctx2d) {
      try { videoEngine.blitOutputToDrawingBuffer(id); } catch { /* never nuke the loop */ }
      const src = videoEngine.canvas as CanvasImageSource;
      ctx2d.fillStyle = '#050608';
      ctx2d.fillRect(0, 0, canvasEl.width, canvasEl.height);
      ctx2d.drawImage(src, 0, 0, canvasEl.width, canvasEl.height);
    }
    drawRaf = requestAnimationFrame(draw);
  }

  onMount(() => {
    drawRaf = requestAnimationFrame(draw);
    window.addEventListener('keydown', onKey);
  });
  onDestroy(() => {
    if (drawRaf !== null) cancelAnimationFrame(drawRaf);
    window.removeEventListener('keydown', onKey);
  });

  // ───────── geometry helpers (uv [0,1] → svg units) ─────────
  const sx = (u: number): number => u * VW;
  // y-UP: v=1 draws at the TOP (matches engine vUv + the flipped pointer), so
  // handles sit exactly where the surface renders.
  const sy = (v: number): number => (1 - v) * VH;
  function quadPoints(s: MappySurfaceState): string {
    return s.corners.map((c) => `${sx(c[0])},${sy(c[1])}`).join(' ');
  }
  function centroid(s: MappySurfaceState): { x: number; y: number } {
    const cx = s.corners.reduce((a, c) => a + c[0], 0) / 4;
    const cy = s.corners.reduce((a, c) => a + c[1], 0) / 4;
    return { x: sx(cx), y: sy(cy) };
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="editor-overlay nodrag nowheel"
  data-testid="mappy-editor"
  role="dialog"
  aria-label="MAPPY mapping editor"
  onpointerdown={(e) => { if (e.target === e.currentTarget) onClose(); }}
>
  <div class="editor-panel">
    <div class="editor-bar">
      <span class="title">MAP · mappy</span>

      <div class="tabs" data-testid="mappy-editor-tabs">
        {#each surfaces as _s, i (i)}
          {#if live[i]}
            <button
              type="button"
              class="tab"
              class:sel={selected === i}
              style="--c: {MAPPY_SURFACE_COLORS[i]};"
              onclick={() => (selected = i)}
              data-testid={`mappy-editor-tab-${i + 1}`}
              title={connected[i] ? `Surface ${i + 1} — IN${i + 1} connected` : `Surface ${i + 1} — grid (connect IN${i + 1})`}
            >
              <span class="dot"></span>{i + 1}{connected[i] ? '' : '·'}
            </button>
          {/if}
        {/each}
        <button
          type="button"
          class="tab add"
          onclick={() => { selected = addSurface(id) - 1; }}
          disabled={surfaceCount >= MAPPY_SURFACE_COUNT}
          data-testid="mappy-editor-add"
          title="Add a surface (up to 6)"
        >+</button>
        <button
          type="button"
          class="tab rm"
          onclick={() => { removeSurface(id); }}
          disabled={surfaceCount <= MAPPY_MIN_SURFACES}
          data-testid="mappy-editor-remove"
          title="Remove the last surface"
        >−</button>
      </div>

      <div class="spacer"></div>

      <button
        type="button"
        class="bar-btn"
        class:on={showGrid}
        onclick={() => toggleGrid(id, showGrid)}
        data-testid="mappy-editor-grid"
        title="Force the calibration grid on every surface"
      >GRID {showGrid ? 'ON' : 'OFF'}</button>
      <button
        type="button"
        class="bar-btn fit"
        class:on={fits[selected]}
        onclick={() => toggleSurfaceFit(id, selected)}
        data-testid="mappy-editor-fit"
        title={fits[selected]
          ? `Surface ${selected + 1}: FIT ON — zoom-fits the whole source into the box. Click for CROP (window at native scale).`
          : `Surface ${selected + 1}: CROP — windows the source at native scale (move to pan, resize to crop). Click for FIT (zoom-fit).`}
      >{fits[selected] ? `FIT ${selected + 1}` : `CROP ${selected + 1}`}</button>
      <button
        type="button"
        class="bar-btn"
        class:on={snap}
        onclick={() => (snap = !snap)}
        data-testid="mappy-editor-snap"
        title="Snap dragged corners to a 1/32 grid"
      >SNAP {snap ? 'ON' : 'OFF'}</button>
      <button
        type="button"
        class="bar-btn reset"
        onclick={() => resetSurface(id, selected)}
        data-testid="mappy-editor-reset"
        title="Reset the selected surface to full-frame"
      >RESET</button>
      <button
        type="button"
        class="bar-btn close"
        onclick={onClose}
        data-testid="mappy-editor-close"
        title="Close (Esc)"
      >✕</button>
    </div>

    <div class="editor-stage">
      <div class="stage-inner" style="aspect-ratio: {ENGINE_W} / {ENGINE_H};">
        <canvas
          bind:this={canvasEl}
          width={ENGINE_W}
          height={ENGINE_H}
          data-testid="mappy-editor-canvas"
        ></canvas>
        <svg
          bind:this={svgEl}
          class="overlay"
          viewBox={`0 0 ${VW} ${VH}`}
          preserveAspectRatio="none"
          onpointerdown={onOverlayDown}
          onpointermove={onMove}
          onpointerup={onUp}
          onpointercancel={onUp}
          data-testid="mappy-editor-overlay"
        >
          {#each surfaces as surf, i (i)}
            {#if live[i]}
              {@const color = MAPPY_SURFACE_COLORS[i]}
              {@const isSel = selected === i}
              {@const c = centroid(surf)}
              <!-- whole-surface move target (interior) — visual only; the SVG
                   owns pointer-down hit-testing (corner-pin vs. interior move) -->
              <polygon
                points={quadPoints(surf)}
                fill={color}
                fill-opacity={isSel ? 0.1 : 0.04}
                stroke={color}
                stroke-width={isSel ? 3 : 1.5}
                stroke-opacity={isSel ? 0.95 : 0.45}
                data-testid={`mappy-editor-quad-${i + 1}`}
              />
              <text
                x={c.x}
                y={c.y}
                class="surf-num"
                fill={color}
                opacity={isSel ? 0.9 : 0.5}
                style="font-size: {isSel ? 46 : 34}px;"
              >{i + 1}{connected[i] ? '' : '·'}</text>
              {#each surf.corners as cc, ci (ci)}
                <circle
                  class="handle"
                  cx={sx(cc[0])}
                  cy={sy(cc[1])}
                  r={isSel ? 16 : 11}
                  fill={color}
                  fill-opacity={isSel ? 0.95 : 0.5}
                  stroke="#000a"
                  stroke-width="2"
                  data-testid={`mappy-editor-handle-${i + 1}-${ci}`}
                />
              {/each}
            {/if}
          {/each}
        </svg>
      </div>
      <p class="hint">
        Drag a corner to warp · drag inside a surface to move it · FIT zoom-fits
        the source, CROP windows it at native scale · {liveCount}
        surface{liveCount === 1 ? '' : 's'} live · connect INn to fill surface n
      </p>
    </div>
  </div>
</div>

<style>
  .editor-overlay {
    position: fixed;
    inset: 0;
    z-index: 9000;
    background: rgba(4, 6, 8, 0.86);
    backdrop-filter: blur(3px);
    display: flex;
    align-items: stretch;
    justify-content: center;
  }
  .editor-panel {
    flex: 1;
    display: flex;
    flex-direction: column;
    margin: 24px;
    border: 1px solid var(--cable-video, #4adfff);
    border-radius: 10px;
    background: #0a0d12;
    overflow: hidden;
    box-shadow: 0 18px 60px #000a;
  }
  .editor-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid #1c2430;
    background: #11161f;
    flex-wrap: wrap;
  }
  .title {
    font: 600 0.8rem/1 ui-monospace, monospace;
    letter-spacing: 0.08em;
    color: var(--cable-video, #4adfff);
  }
  .spacer { flex: 1; }
  .tabs { display: flex; gap: 4px; align-items: center; }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: #1b2230;
    border: 1px solid #2c3545;
    border-radius: 4px;
    color: var(--text, #d7dde6);
    padding: 3px 9px;
    font: 0.74rem/1 ui-monospace, monospace;
    cursor: pointer;
  }
  .tab .dot {
    width: 9px; height: 9px; border-radius: 2px;
    background: var(--c); border: 1px solid #0006;
  }
  .tab.sel { border-color: var(--c); box-shadow: inset 0 0 0 1px var(--c); }
  .tab.add, .tab.rm { font-weight: 700; padding: 3px 10px; }
  .tab:disabled { opacity: 0.4; cursor: not-allowed; }
  .bar-btn {
    background: #1b2230;
    border: 1px solid #2c3545;
    border-radius: 4px;
    color: var(--text, #d7dde6);
    padding: 3px 10px;
    font: 0.68rem/1 ui-monospace, monospace;
    letter-spacing: 0.05em;
    cursor: pointer;
  }
  .bar-btn.on {
    background: rgba(255, 220, 0, 0.16);
    border-color: var(--yellow, #ffd24a);
    color: var(--yellow, #ffd24a);
  }
  /* FIT is on by default — use the video cyan (info), not the yellow alarm tint */
  .bar-btn.fit.on {
    background: rgba(74, 223, 255, 0.14);
    border-color: var(--cable-video, #4adfff);
    color: var(--cable-video, #4adfff);
  }
  .bar-btn.close { color: #ff8a8a; border-color: #5a2c2c; }
  .editor-stage {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 16px;
    min-height: 0;
  }
  .stage-inner {
    position: relative;
    max-width: 100%;
    max-height: 100%;
    width: min(100%, calc((100vh - 180px) * 4 / 3));
    border: 1px solid #1c2430;
    background: #050608;
    line-height: 0;
  }
  .stage-inner canvas {
    display: block;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
  }
  .overlay {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    touch-action: none;
    /* the SVG owns pointer-down hit-testing; `move` is the interior affordance */
    cursor: move;
  }
  /* shapes are visual only — the SVG element handles all pointer events */
  .overlay polygon,
  .overlay .handle { pointer-events: none; }
  .surf-num {
    text-anchor: middle;
    dominant-baseline: central;
    font-family: ui-monospace, monospace;
    font-weight: 700;
    pointer-events: none;
    paint-order: stroke;
    stroke: #000a;
    stroke-width: 4px;
  }
  .hint {
    margin: 0;
    color: var(--text-dim, #8b97a6);
    font: 0.72rem/1.4 ui-monospace, monospace;
    text-align: center;
  }
</style>
