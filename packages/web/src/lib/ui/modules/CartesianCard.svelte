<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import NoteEntry from '$lib/ui/controls/NoteEntry.svelte';
  import { patch, ydoc } from '$lib/graph/store';
  import {
    cartesianDef,
    defaultCells,
    CELL_COUNT,
    GRID_DIM,
    coerceToCartesianCell,
    type Cell,
  } from '$lib/audio/modules/cartesian';
  import { type ChordQuality, nextChordQuality } from '$lib/audio/poly';
  import { useEngine } from '$lib/audio/engine-context';
  import { parseNoteName } from '$lib/audio/note-entry';
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
    if (Array.isArray(raw)) return (raw as unknown[]).map(coerceToCartesianCell);
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
    function tickFrame() {
      const e = engineCtx.get();
      if (e && node) {
        const cs = e.read(node, 'currentStep');
        if (typeof cs === 'number') currentStep = cs;
      }
      raf = requestAnimationFrame(tickFrame);
    }
    raf = requestAnimationFrame(tickFrame);
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
    if (Array.isArray(raw)) return (raw as unknown[]).map(coerceToCartesianCell);
    return defaultCells();
  }
  function writeCells(arr: Cell[]) {
    const t = patch.nodes[id];
    if (!t) return;
    ydoc.transact(() => {
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).cells = arr.map((c) => ({
        on: c.on,
        midi: c.midi,
        chord: c.chord ?? 'mono',
      }));
    });
  }
  function commitPitch(i: number, input: string) {
    const arr = readCellsCopy();
    const cur = arr[i] ?? { on: false, midi: null, chord: 'mono' as ChordQuality };
    const trimmed = input.trim();
    const parsed = trimmed === '' ? null : parseNoteName(trimmed);
    arr[i] = { on: cur.on, midi: parsed, chord: cur.chord ?? 'mono' };
    writeCells(arr);
  }
  function toggleGate(i: number) {
    const arr = readCellsCopy();
    const cur = arr[i] ?? { on: false, midi: null, chord: 'mono' as ChordQuality };
    arr[i] = { on: !cur.on, midi: cur.midi, chord: cur.chord ?? 'mono' };
    writeCells(arr);
  }
  function cycleChord(i: number) {
    const arr = readCellsCopy();
    const cur = arr[i] ?? { on: false, midi: null, chord: 'mono' as ChordQuality };
    arr[i] = { on: cur.on, midi: cur.midi, chord: nextChordQuality(cur.chord) };
    writeCells(arr);
  }
  function chordLabel(c: ChordQuality | undefined): string {
    if (c === 'maj') return 'M';
    if (c === 'min') return 'm';
    return '—';
  }

  // --- Keyboard navigation (4x4 with row-wrap) ---

  let gridEl: HTMLElement | undefined = $state();

  function findCell(idx: number, role: 'pitch' | 'gate'): HTMLElement | null {
    if (!gridEl) return null;
    return gridEl.querySelector<HTMLElement>(`[data-step="${idx}"][data-role="${role}"]`);
  }

  function focusCell(idx: number, role: 'pitch' | 'gate'): boolean {
    const target = findCell(idx, role);
    if (!target) return false;
    target.focus();
    if (target.tagName === 'INPUT') (target as HTMLInputElement).select();
    return true;
  }

  function handleNav(e: KeyboardEvent, idx: number, role: 'pitch' | 'gate'): boolean {
    const max = CELL_COUNT - 1;
    const col = idx % GRID_DIM;
    const row = Math.floor(idx / GRID_DIM);
    if (e.key === 'ArrowLeft') {
      // Left wraps to previous row's last col.
      const next = idx === 0 ? max : idx - 1;
      return focusCell(next, role);
    }
    if (e.key === 'ArrowRight') {
      const next = idx === max ? 0 : idx + 1;
      return focusCell(next, role);
    }
    if (e.key === 'ArrowUp') {
      // Up moves to the same column in the row above (linear semantics across
      // the grid). For pitch row, allow swap to gate within the same cell on
      // the *first* row only? Per spec: "swap row (pitch ↔ gate of same step
      // index)" — i.e., toggle role, NOT move grid row. So Up/Down toggle role.
      const otherRole = role === 'pitch' ? 'gate' : 'pitch';
      return focusCell(idx, otherRole);
    }
    if (e.key === 'ArrowDown') {
      const otherRole = role === 'pitch' ? 'gate' : 'pitch';
      return focusCell(idx, otherRole);
    }
    if (e.key === 'Enter' && role === 'pitch') {
      const next = idx === max ? 0 : idx + 1;
      Promise.resolve().then(() => focusCell(next, 'pitch'));
      return true;
    }
    if (e.key === 'Tab') {
      const dir = e.shiftKey ? -1 : 1;
      const next = idx + dir;
      if (next < 0 || next > max) return false;
      return focusCell(next, role);
    }
    // Suppress unused-var warning from row/col (kept for readability).
    void col; void row;
    return false;
  }
</script>

<div class="mod-card cartesian-card">
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

  <Handle type="source" position={Position.Right} id="pitch" style="top: 56px;  --handle-color: var(--cable-polyPitchGate);" />
  <Handle type="source" position={Position.Right} id="gate"  style="top: 92px;  --handle-color: var(--cable-gate);" />
  <Handle type="source" position={Position.Right} id="clock" style="top: 128px; --handle-color: var(--cable-gate);" />
  <span class="port-label right" style="top: 50px;">pitch</span>
  <span class="port-label right" style="top: 86px;">gate</span>
  <span class="port-label right" style="top: 122px;">clk</span>

  <div class="grid" bind:this={gridEl} data-testid={`cart-grid-${id}`}>
    {#each cells.slice(0, CELL_COUNT) as cell, i (i)}
      <div class="cell-slot" data-step={i}>
        <div class="cell-num">{i}</div>
        <NoteEntry
          midi={cell.midi}
          on={cell.on}
          isActive={i === currentStep}
          testId={`cart-pitch-${id}-${i}`}
          gateTestId={`cart-gate-${id}-${i}`}
          onCommit={(input) => commitPitch(i, input)}
          onGateToggle={() => toggleGate(i)}
          onNavKey={(e) => {
            const role = (e.target as HTMLElement)?.dataset?.role === 'gate' ? 'gate' : 'pitch';
            return handleNav(e, i, role as 'pitch' | 'gate');
          }}
        />
        <button
          class="chord-badge"
          class:mono={(cell.chord ?? 'mono') === 'mono'}
          class:maj={cell.chord === 'maj'}
          class:min={cell.chord === 'min'}
          type="button"
          data-testid={`cart-chord-${id}-${i}`}
          data-step={i}
          data-role="chord"
          data-chord={cell.chord ?? 'mono'}
          title={`Chord: ${cell.chord ?? 'mono'} (click to cycle)`}
          onclick={() => cycleChord(i)}
        >{chordLabel(cell.chord)}</button>
      </div>
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
  .cell-slot {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .cell-num {
    font-size: 0.6rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    text-align: center;
    line-height: 1.4;
  }
  .chord-badge {
    width: 100%;
    height: 14px;
    margin-top: 1px;
    background: #14171c;
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
    line-height: 1;
    padding: 0;
    cursor: pointer;
  }
  .chord-badge.maj {
    color: var(--cable-pitch);
    border-color: var(--cable-pitch);
  }
  .chord-badge.min {
    color: #c084fc;
    border-color: #c084fc;
  }
  .chord-badge:focus-visible {
    outline: 1px solid var(--cable-cv);
    outline-offset: -1px;
  }
  .cartesian-card .fader-row {
    margin-top: 6px;
    padding: 0 50px;
    gap: 12px;
  }
</style>
