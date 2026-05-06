<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch, ydoc } from '$lib/graph/store';
  import { cartesianDef, defaultCells, CELL_COUNT, GRID_DIM, type Cell } from '$lib/audio/modules/cartesian';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  let cardVersion = $state(0);
  $effect(() => {
    const h = () => { cardVersion = cardVersion + 1; };
    ydoc.on('update', h);
    return () => ydoc.off('update', h);
  });

  let mode       = $derived((void cardVersion, (node?.params.mode ?? 0) >= 0.5 ? 1 : 0));
  let octave     = $derived((void cardVersion, node?.params.octave ?? 0));
  let gateLength = $derived((void cardVersion, node?.params.gateLength ?? 0.5));

  let cells = $derived.by<Cell[]>(() => {
    void cardVersion;
    const raw = (node?.data as Record<string, unknown> | undefined)?.cells;
    if (Array.isArray(raw)) return (raw as Cell[]).map((c) => ({ on: !!c.on, pitch: c.pitch ?? 0 }));
    return defaultCells();
  });

  const set = (k: string) => (v: number) => {
    const t = patch.nodes[id]; if (t) t.params[k] = v;
  };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };
  function toggleMode() {
    set('mode')(mode === 1 ? 0 : 1);
  }

  let currentStep = $state(0);
  let raf: number | null = null;
  $effect(() => {
    function tick() {
      const e = engineCtx.get();
      if (e && node) {
        const cs = e.read(node, 'currentStep');
        if (typeof cs === 'number') currentStep = cs;
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    };
  });
  onDestroy(() => {
    if (raf !== null) cancelAnimationFrame(raf);
  });

  function readCellsCopy(): Cell[] {
    const t = patch.nodes[id];
    if (!t?.data) return defaultCells();
    const raw = (t.data as Record<string, unknown>).cells;
    if (Array.isArray(raw)) return (raw as Cell[]).map((c) => ({ on: !!c.on, pitch: c.pitch ?? 0 }));
    return defaultCells();
  }
  function writeCells(arr: Cell[]) {
    const t = patch.nodes[id];
    if (!t) return;
    ydoc.transact(() => {
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).cells = arr;
    });
  }
  function toggleCell(i: number) {
    const arr = readCellsCopy();
    const cur = arr[i] ?? { on: false, pitch: 0 };
    arr[i] = { ...cur, on: !cur.on };
    writeCells(arr);
  }

  let dragging: { idx: number; startY: number; startPitch: number } | null = $state(null);

  function cellPointerDown(e: PointerEvent, i: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const cur = cells[i] ?? { on: false, pitch: 0 };
    dragging = { idx: i, startY: e.clientY, startPitch: cur.pitch };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function cellPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const dy = dragging.startY - e.clientY;
    const delta = Math.round(dy / 8);
    const newPitch = Math.max(-24, Math.min(24, dragging.startPitch + delta));
    const arr = readCellsCopy();
    const cur = arr[dragging.idx] ?? { on: false, pitch: 0 };
    if (cur.pitch !== newPitch) {
      arr[dragging.idx] = { ...cur, pitch: newPitch };
      writeCells(arr);
    }
  }
  function cellPointerUp(e: PointerEvent, i: number) {
    if (!dragging) return;
    const moved = Math.abs(e.clientY - dragging.startY);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    if (moved < 4) toggleCell(i);
    dragging = null;
  }
</script>

<div class="mod-card cartesian-card" onpointermove={cellPointerMove}>
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">
    Cartesian
    <button class="mode-btn" class:cart={mode === 1} onclick={toggleMode} title={mode === 1 ? 'Cartesian (X/Y)' : 'Linear'}>
      {mode === 1 ? 'X/Y' : 'LIN'}
    </button>
  </header>

  <Handle type="target" position={Position.Left} id="clock" style="top: 56px;  --handle-color: var(--cable-gate);" />
  <Handle type="target" position={Position.Left} id="x_cv"  style="top: 92px;  --handle-color: var(--cable-cv);" />
  <Handle type="target" position={Position.Left} id="y_cv"  style="top: 128px; --handle-color: var(--cable-cv);" />
  <span class="port-label left" style="top: 50px;">clk</span>
  <span class="port-label left" style="top: 86px;">x cv</span>
  <span class="port-label left" style="top: 122px;">y cv</span>

  <Handle type="source" position={Position.Right} id="pitch" style="top: 56px;  --handle-color: var(--cable-pitch);" />
  <Handle type="source" position={Position.Right} id="gate"  style="top: 92px;  --handle-color: var(--cable-gate);" />
  <Handle type="source" position={Position.Right} id="clock" style="top: 128px; --handle-color: var(--cable-gate);" />
  <span class="port-label right" style="top: 50px;">pitch</span>
  <span class="port-label right" style="top: 86px;">gate</span>
  <span class="port-label right" style="top: 122px;">clk</span>

  <div class="grid">
    {#each cells.slice(0, CELL_COUNT) as cell, i (i)}
      <button
        class="cell"
        class:on={cell.on}
        class:active={i === currentStep}
        title={`cell ${i} (row ${Math.floor(i / GRID_DIM)}, col ${i % GRID_DIM}) · pitch ${cell.pitch >= 0 ? '+' : ''}${cell.pitch}`}
        onpointerdown={(e) => cellPointerDown(e, i)}
        onpointerup={(e) => cellPointerUp(e, i)}
      >
        <div class="pitch-bar" style:height="{Math.min(100, Math.abs(cell.pitch) * 4 + 10)}%"></div>
        <div class="cell-num">{i}</div>
      </button>
    {/each}
  </div>

  <div class="fader-row">
    <Fader value={octave}     min={-2}  max={2}    defaultValue={0}   label="Oct"  curve="discrete" onchange={set('octave')}     readLive={live('octave')} />
    <Fader value={gateLength} min={0.1} max={0.95} defaultValue={0.5} label="Gate" curve="linear"   onchange={set('gateLength')} readLive={live('gateLength')} />
  </div>
</div>

<style>
  .cartesian-card { width: 320px; min-height: 320px; padding-right: 0; padding-left: 0; }
  .cartesian-card .title {
    padding-right: 22px;
    padding-left: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .mode-btn {
    width: 32px;
    height: 22px;
    background: #2a2f3a;
    border: 1px solid #404652;
    color: var(--text);
    border-radius: 3px;
    font-size: 0.6rem;
    cursor: pointer;
    line-height: 1;
    padding: 0;
    font-family: ui-monospace, monospace;
  }
  .mode-btn.cart {
    background: var(--cable-pitch);
    color: #1a1d23;
    border-color: var(--cable-pitch);
  }
  .grid {
    margin: 30px 22px 12px;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 6px;
  }
  .cell {
    position: relative;
    aspect-ratio: 1;
    background: #14171c;
    border: 1px solid #2a2f3a;
    border-radius: 3px;
    padding: 0;
    cursor: ns-resize;
    overflow: hidden;
    user-select: none;
    touch-action: none;
  }
  .cell.on {
    background: #2a2f3a;
    border-color: var(--cable-gate);
  }
  .cell.active {
    box-shadow: 0 0 0 1px var(--cable-cv);
  }
  .pitch-bar {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    background: var(--cable-pitch);
    opacity: 0.4;
    pointer-events: none;
  }
  .cell.on .pitch-bar { opacity: 0.85; }
  .cell-num {
    position: absolute;
    top: 2px;
    right: 4px;
    font-size: 0.6rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    pointer-events: none;
    line-height: 1;
  }
  .cartesian-card .fader-row {
    margin-top: 6px;
    padding: 0 50px;
    gap: 12px;
  }
</style>
