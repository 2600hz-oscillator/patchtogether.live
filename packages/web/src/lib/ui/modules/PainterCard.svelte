<script lang="ts">
  // PainterCard — the card face for PAINTER: a tiny Windows-95 Paint.
  //
  // A toolbar of tools (pencil / brush / eraser / line / rect / ellipse / fill /
  // eyedropper / text), the 28-colour Win95 palette (left-click = foreground,
  // right-click = background), a brush-size selector, and an engine-resolution
  // drawing canvas (shown scaled). Whatever you paint is the single video OUT in
  // real time: the card binds its live canvas to the PAINTER module ONCE via
  // read('extras').setPaintCanvas(canvas) and the engine uploads that canvas
  // every frame — no per-stroke push needed.
  //
  // The drawing is a Y.Doc-synced op log (node.data.ops): each committed
  // stroke/shape/fill/text appends one PaintOp; on mount + remote update the card
  // replays the log onto the canvas (deterministic, see painter-draw.ts). So
  // every peer paints the same picture. Tool / colour / brush-size are LOCAL
  // (per-collaborator) — only the drawing syncs.

  import { onMount, onDestroy } from 'svelte';
  import { type NodeProps } from '@xyflow/svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { useEngine } from '$lib/audio/engine-context';
  import { mutateNode } from '$lib/graph/mutate';
  import { painterDef, type PainterHandleExtras } from '$lib/video/modules/painter';
  import {
    type PaintOp,
    type Tool,
    WIN95_PALETTE,
    PAINT_BG,
    DEFAULT_FG,
    DEFAULT_BRUSH,
    MIN_BRUSH,
    MAX_BRUSH,
    MAX_OPS,
    coerceOps,
    applyVectorOp,
    floodFill,
    hexToRgba,
  } from '$lib/video/modules/painter-draw';
  import type { VideoEngine } from '$lib/video/engine';
  import { VIDEO_RES } from '$lib/video/engine';
  import type { ModuleNode } from '$lib/graph/types';
  import ModuleTitle from './ModuleTitle.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // Canvas = engine resolution (the OUT frame is this canvas, 1:1). v1 sizes to
  // the 4:3 default; 16:9 (1366×768) dynamic resize is a follow-up.
  const ENGINE_W = VIDEO_RES.width;
  const ENGINE_H = VIDEO_RES.height;

  let canvasEl: HTMLCanvasElement | null = $state(null);
  let ctx2d: CanvasRenderingContext2D | null = null;

  // ── Local tool state (per-collaborator — NOT synced) ──────────────────────
  let tool = $state<Tool>('pencil');
  let fg = $state(DEFAULT_FG);
  let bg = $state(PAINT_BG);
  let brush = $state(DEFAULT_BRUSH);
  let fillShapes = $state(false); // rect/ellipse: outline only vs filled
  let textValue = $state('TEXT');

  const TOOLS: { id: Tool; label: string; glyph: string }[] = [
    { id: 'pencil', label: 'Pencil', glyph: '✏️' },
    { id: 'brush', label: 'Brush', glyph: '🖌️' },
    { id: 'eraser', label: 'Eraser', glyph: '🧽' },
    { id: 'fill', label: 'Fill', glyph: '🪣' },
    { id: 'eyedropper', label: 'Pick', glyph: '💧' },
    { id: 'line', label: 'Line', glyph: '╱' },
    { id: 'rect', label: 'Rect', glyph: '▭' },
    { id: 'ellipse', label: 'Ellipse', glyph: '◯' },
    { id: 'text', label: 'Text', glyph: 'A' },
  ];

  // ── Op log (node.data.ops, Y.Doc-synced) ──────────────────────────────────
  function readOps(): PaintOp[] {
    return coerceOps((node?.data as { ops?: unknown } | undefined)?.ops);
  }

  /** Append a committed op to the synced log (in place — Yjs-safe; never reassign
   *  live.data). The local canvas is already drawn; this persists + syncs it. */
  function commitOp(op: PaintOp) {
    mutateNode(id, (live) => {
      const d = live.data as Record<string, unknown>;
      const ops = Array.isArray(d.ops) ? (d.ops as unknown[]).slice() : [];
      if (ops.length >= MAX_OPS) return; // soft cap — drawing still shows locally
      ops.push(op);
      d.ops = ops;
    });
  }

  function clearAll() {
    mutateNode(id, (live) => {
      (live.data as Record<string, unknown>).ops = [];
    });
    // syncFromOps (effect) repaints to a blank page.
  }

  function undo() {
    mutateNode(id, (live) => {
      const d = live.data as Record<string, unknown>;
      const ops = Array.isArray(d.ops) ? (d.ops as unknown[]).slice() : [];
      ops.pop();
      d.ops = ops;
    });
  }

  // ── Repaint the canvas from the op log ────────────────────────────────────
  function fillBackground() {
    if (!ctx2d) return;
    ctx2d.fillStyle = PAINT_BG;
    ctx2d.fillRect(0, 0, ENGINE_W, ENGINE_H);
  }

  function applyOpToCanvas(op: PaintOp) {
    if (!ctx2d) return;
    if (op.kind === 'fill') {
      try {
        const img = ctx2d.getImageData(0, 0, ENGINE_W, ENGINE_H);
        floodFill(img, op.x, op.y, hexToRgba(op.color));
        ctx2d.putImageData(img, 0, 0);
      } catch {
        /* getImageData can throw on a tainted/headless ctx — skip */
      }
      return;
    }
    if (op.kind === 'snapshot') return; // v1 generates none; future raster checkpoints
    applyVectorOp(ctx2d, op);
  }

  /** Full repaint from the synced op log. Cheap for vector ops; called on mount +
   *  remote/undo/clear changes (guarded so it never fights an active local draw). */
  function syncFromOps() {
    if (!ctx2d || isDrawing) return;
    fillBackground();
    for (const op of readOps()) applyOpToCanvas(op);
  }

  // Re-sync whenever the synced op log changes (local commit, remote edit, undo).
  $effect(() => {
    const ops = (node?.data as { ops?: unknown } | undefined)?.ops;
    void ops; // track
    syncFromOps();
  });

  // ── Bind the live canvas to the engine module (once, with retry) ──────────
  function getExtras(): PainterHandleExtras | null {
    const e = engineCtx.get();
    if (!e) return null;
    try {
      const ve = e.getDomain<VideoEngine>('video');
      return (ve.read(id, 'extras') as PainterHandleExtras | undefined) ?? null;
    } catch {
      return null;
    }
  }
  let bindRetry: ReturnType<typeof setTimeout> | null = null;
  function bindCanvasToEngine(attempt = 0) {
    const extras = getExtras();
    if (!extras) {
      if (attempt >= 50) return;
      if (bindRetry) clearTimeout(bindRetry);
      bindRetry = setTimeout(() => { bindRetry = null; bindCanvasToEngine(attempt + 1); }, 100);
      return;
    }
    if (canvasEl) extras.setPaintCanvas(canvasEl);
  }

  // ── Pointer drawing ────────────────────────────────────────────────────────
  let isDrawing = false;
  let strokePts: number[] = [];
  let startX = 0;
  let startY = 0;
  // Snapshot of the committed canvas (for shape-drag preview without corrupting).
  let committed: HTMLCanvasElement | null = null;

  function toCanvasXY(e: PointerEvent): [number, number] {
    if (!canvasEl) return [0, 0];
    const r = canvasEl.getBoundingClientRect();
    const x = (e.clientX - r.left) * (canvasEl.width / r.width);
    const y = (e.clientY - r.top) * (canvasEl.height / r.height);
    return [x, y];
  }

  function snapshotCommitted() {
    if (!canvasEl) return;
    if (!committed) committed = document.createElement('canvas');
    committed.width = ENGINE_W;
    committed.height = ENGINE_H;
    committed.getContext('2d')?.drawImage(canvasEl, 0, 0);
  }
  function restoreCommitted() {
    if (!ctx2d || !committed) return;
    ctx2d.clearRect(0, 0, ENGINE_W, ENGINE_H);
    ctx2d.drawImage(committed, 0, 0);
  }

  function onPointerDown(e: PointerEvent) {
    if (!ctx2d || !canvasEl) return;
    canvasEl.setPointerCapture?.(e.pointerId);
    const [x, y] = toCanvasXY(e);
    startX = x; startY = y;

    if (tool === 'eyedropper') {
      try {
        const px = ctx2d.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
        const hex = `#${[px[0], px[1], px[2]].map((n) => (n ?? 0).toString(16).padStart(2, '0')).join('')}`;
        fg = hex;
      } catch { /* headless */ }
      return;
    }
    if (tool === 'fill') {
      const op: PaintOp = { kind: 'fill', color: fg, x, y };
      applyOpToCanvas(op);
      commitOp(op);
      return;
    }
    if (tool === 'text') {
      if (textValue.length > 0) {
        const op: PaintOp = { kind: 'text', color: fg, size: Math.max(12, brush * 6), x, y, font: 'sans-serif', text: textValue };
        applyOpToCanvas(op);
        commitOp(op);
      }
      return;
    }

    isDrawing = true;
    if (tool === 'pencil' || tool === 'brush' || tool === 'eraser') {
      strokePts = [x, y];
      // draw the initial dot
      drawLiveStroke();
    } else {
      // line / rect / ellipse — snapshot so we can preview without committing
      snapshotCommitted();
    }
  }

  function strokeColor(): string {
    return tool === 'eraser' ? bg : fg;
  }

  function drawLiveStroke() {
    if (!ctx2d) return;
    applyVectorOp(ctx2d, {
      kind: 'stroke',
      tool: tool === 'eraser' ? 'eraser' : tool === 'brush' ? 'brush' : 'pencil',
      color: strokeColor(),
      size: tool === 'pencil' ? 1 : brush,
      points: strokePts,
    });
  }

  function onPointerMove(e: PointerEvent) {
    if (!isDrawing || !ctx2d) return;
    const [x, y] = toCanvasXY(e);
    if (tool === 'pencil' || tool === 'brush' || tool === 'eraser') {
      strokePts.push(x, y);
      // redraw the whole stroke (cheap; keeps round joins smooth)
      drawLiveStroke();
    } else {
      // shape preview: restore committed + draw the in-progress shape
      restoreCommitted();
      applyVectorOp(ctx2d, {
        kind: 'shape',
        tool: tool === 'line' ? 'line' : tool === 'rect' ? 'rect' : 'ellipse',
        color: fg,
        size: brush,
        fill: tool !== 'line' && fillShapes ? bg : null,
        x0: startX, y0: startY, x1: x, y1: y,
      });
    }
  }

  function onPointerUp(e: PointerEvent) {
    if (!isDrawing) return;
    isDrawing = false;
    const [x, y] = toCanvasXY(e);
    if (tool === 'pencil' || tool === 'brush' || tool === 'eraser') {
      if (strokePts.length === 0) strokePts = [startX, startY];
      commitOp({
        kind: 'stroke',
        tool: tool === 'eraser' ? 'eraser' : tool === 'brush' ? 'brush' : 'pencil',
        color: strokeColor(),
        size: tool === 'pencil' ? 1 : brush,
        points: strokePts.slice(),
      });
      strokePts = [];
    } else {
      commitOp({
        kind: 'shape',
        tool: tool === 'line' ? 'line' : tool === 'rect' ? 'rect' : 'ellipse',
        color: fg,
        size: brush,
        fill: tool !== 'line' && fillShapes ? bg : null,
        x0: startX, y0: startY, x1: x, y1: y,
      });
    }
  }

  // Palette: left = fg, right (contextmenu) = bg.
  function pickFg(hex: string) { fg = hex; }
  function pickBg(e: Event, hex: string) { e.preventDefault(); bg = hex; }

  onMount(() => {
    if (canvasEl) {
      canvasEl.width = ENGINE_W;
      canvasEl.height = ENGINE_H;
      ctx2d = canvasEl.getContext('2d');
    }
    fillBackground();
    syncFromOps();
    bindCanvasToEngine();
  });
  onDestroy(() => {
    if (bindRetry) clearTimeout(bindRetry);
  });

  const inputs: PortDescriptor[] = [];
  const outputs: PortDescriptor[] = [
    { id: 'out', label: 'OUT', cable: 'video' },
  ];
</script>

<div class="mod-card painter-card" data-testid="painter-card">
  <div class="stripe" style="background: var(--cable-video);"></div>
  <ModuleTitle {id} {data} defaultLabel="painter" />

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <!-- Toolbar: tools + brush size + actions -->
    <div class="toolbar nodrag" data-testid="painter-toolbar">
      <div class="tools">
        {#each TOOLS as t (t.id)}
          <button
            type="button"
            class="tool"
            class:active={tool === t.id}
            title={t.label}
            data-testid={`painter-tool-${t.id}`}
            aria-pressed={tool === t.id}
            onclick={() => (tool = t.id)}
          >{t.glyph}</button>
        {/each}
      </div>

      <div class="opts">
        <label class="opt" title="Brush / line size">
          <span class="lbl">SIZE</span>
          <input
            type="range" class="nodrag" min={MIN_BRUSH} max={MAX_BRUSH} step="1" value={brush}
            data-testid="painter-size"
            oninput={(e) => (brush = Number((e.currentTarget as HTMLInputElement).value))} />
        </label>
        <label class="opt chk" title="Fill rectangles / ellipses with the background colour">
          <input type="checkbox" class="nodrag" checked={fillShapes}
            data-testid="painter-fill-shapes"
            onchange={(e) => (fillShapes = (e.currentTarget as HTMLInputElement).checked)} />
          <span class="lbl">FILL</span>
        </label>
      </div>

      {#if tool === 'text'}
        <input
          type="text" class="text-input nodrag" value={textValue}
          data-testid="painter-text-input" placeholder="text to stamp"
          oninput={(e) => (textValue = (e.currentTarget as HTMLInputElement).value)} />
      {/if}

      <div class="actions">
        <button type="button" class="act" data-testid="painter-undo" title="Undo" onclick={undo}>↶ Undo</button>
        <button type="button" class="act" data-testid="painter-clear" title="Clear the canvas" onclick={clearAll}>Clear</button>
      </div>
    </div>

    <!-- Drawing canvas (engine resolution, shown scaled). The video OUT is this. -->
    <div class="canvas-wrap nodrag">
      <canvas
        bind:this={canvasEl}
        class="paint"
        data-testid="painter-canvas"
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        oncontextmenu={(e) => e.preventDefault()}
      ></canvas>
    </div>

    <!-- Win95 colour palette: left = foreground, right-click = background -->
    <div class="palette-row nodrag">
      <div class="current" title="Foreground / background">
        <span class="sw bg" style={`background:${bg}`}></span>
        <span class="sw fg" style={`background:${fg}`}></span>
      </div>
      <div class="palette" data-testid="painter-palette">
        {#each WIN95_PALETTE as c (c)}
          <button
            type="button"
            class="swatch"
            style={`background:${c}`}
            title={c}
            data-testid={`painter-swatch-${c}`}
            aria-label={`colour ${c}`}
            onclick={() => pickFg(c)}
            oncontextmenu={(e) => pickBg(e, c)}
          ></button>
        {/each}
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .mod-card {
    width: 300px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 12px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .mod-card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .mod-card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe { position: absolute; top: 0; left: 0; right: 0; height: 2px; border-radius: 2px 2px 0 0; }

  .toolbar { padding: 8px 8px 4px; }
  .tools { display: grid; grid-template-columns: repeat(9, 1fr); gap: 2px; }
  .tool {
    height: 24px;
    font-size: 0.82rem;
    line-height: 1;
    display: flex; align-items: center; justify-content: center;
    color: var(--text);
    background: var(--control-bg, #1c1c22);
    border: 1px solid var(--border);
    border-radius: 3px;
    cursor: pointer;
    padding: 0;
  }
  .tool:hover { border-color: var(--accent-dim); }
  .tool.active { border-color: var(--accent); background: var(--accent-glow, #2a2a40); }

  .opts { display: flex; align-items: center; gap: 12px; padding: 6px 2px 2px; }
  .opt { display: inline-flex; align-items: center; gap: 4px; }
  .opt .lbl { font-size: 0.5rem; color: var(--text-dim); letter-spacing: 0.06em; }
  .opt input[type='range'] { width: 110px; }
  .opt.chk { gap: 3px; }

  .text-input {
    margin: 4px 2px 0;
    width: calc(100% - 4px);
    height: 22px;
    font-size: 0.72rem;
    color: var(--text);
    background: var(--control-bg, #1c1c22);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0 6px;
  }

  .actions { display: flex; gap: 6px; padding: 6px 2px 0; }
  .act {
    flex: 1;
    height: 22px;
    font-size: 0.62rem;
    color: var(--text);
    background: var(--control-bg, #1c1c22);
    border: 1px solid var(--border);
    border-radius: 3px;
    cursor: pointer;
  }
  .act:hover { border-color: var(--accent-dim); }

  .canvas-wrap {
    margin: 8px 8px 6px;
    border: 1px solid #000;
    background: #fff;
    box-shadow: inset 0 0 6px rgba(0, 0, 0, 0.35);
    line-height: 0;
  }
  .paint {
    width: 100%;
    height: auto;
    display: block;
    cursor: crosshair;
    touch-action: none;
    image-rendering: auto;
  }

  .palette-row { display: flex; align-items: center; gap: 8px; padding: 0 8px; }
  .current { position: relative; width: 28px; height: 28px; flex: 0 0 auto; }
  .current .sw { position: absolute; width: 18px; height: 18px; border: 1px solid #000; border-radius: 2px; }
  .current .bg { right: 0; bottom: 0; }
  .current .fg { left: 0; top: 0; }
  .palette { display: grid; grid-template-columns: repeat(14, 1fr); gap: 1px; flex: 1; }
  .swatch {
    aspect-ratio: 1;
    border: 1px solid rgba(0, 0, 0, 0.5);
    border-radius: 0;
    cursor: pointer;
    padding: 0;
    min-width: 0;
  }
  .swatch:hover { outline: 1px solid var(--accent); outline-offset: -1px; }
</style>
