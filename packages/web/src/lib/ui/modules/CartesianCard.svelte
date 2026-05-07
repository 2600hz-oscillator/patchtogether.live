<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import NoteEntry from '$lib/ui/controls/NoteEntry.svelte';
  import { patch, ydoc } from '$lib/graph/store';
  import { cartesianDef, defaultCells, CELL_COUNT, GRID_DIM, LFO_DIVISIONS, type Cell } from '$lib/audio/modules/cartesian';
  import { useEngine } from '$lib/audio/engine-context';
  import { parseNoteName, coerceToNoteStep } from '$lib/audio/note-entry';
  import { resolveArrowNav, type ArrowKey } from '$lib/audio/grid-nav';
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
  let lfoDiv     = $derived((void cardVersion, node?.params.lfoDiv ?? 3));
  let lfoShape   = $derived((void cardVersion, node?.params.lfoShape ?? 0));

  // Glyph rail for the LFO waveform slider: sine/tri/saw/square at the four
  // morph anchor points (frac 0/1/3, 1/3, 2/3, 1). Active glyph is the one
  // closest to the current shape value.
  const LFO_SHAPE_GLYPHS: Array<{ frac: number; kind: 'sine' | 'tri' | 'saw' | 'square' }> = [
    { frac: 0,         kind: 'sine'   },
    { frac: 1 / 3,     kind: 'tri'    },
    { frac: 2 / 3,     kind: 'saw'    },
    { frac: 1,         kind: 'square' },
  ];

  // Tick rail for the LFO division slider — text labels at each snap point.
  const LFO_DIV_TICKS = LFO_DIVISIONS.map((d, i) => ({
    frac: i / (LFO_DIVISIONS.length - 1),
    label: d.label,
  }));

  function formatLfoDiv(v: number): string {
    const i = Math.max(0, Math.min(LFO_DIVISIONS.length - 1, Math.round(v)));
    return LFO_DIVISIONS[i]?.label ?? '';
  }

  let cells = $derived.by<Cell[]>(() => {
    void cardVersion;
    const raw = (node?.data as Record<string, unknown> | undefined)?.cells;
    if (Array.isArray(raw)) return (raw as unknown[]).map(coerceToNoteStep);
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
    if (Array.isArray(raw)) return (raw as unknown[]).map(coerceToNoteStep);
    return defaultCells();
  }
  function writeCells(arr: Cell[]) {
    const t = patch.nodes[id];
    if (!t) return;
    ydoc.transact(() => {
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).cells = arr.map((c) => ({ on: c.on, midi: c.midi }));
    });
  }
  function commitPitch(i: number, input: string) {
    const arr = readCellsCopy();
    const cur = arr[i] ?? { on: false, midi: null };
    const trimmed = input.trim();
    const parsed = trimmed === '' ? null : parseNoteName(trimmed);
    arr[i] = { on: cur.on, midi: parsed };
    writeCells(arr);
  }
  function toggleGate(i: number) {
    const arr = readCellsCopy();
    const cur = arr[i] ?? { on: false, midi: null };
    arr[i] = { on: !cur.on, midi: cur.midi };
    writeCells(arr);
  }

  // --- Keyboard navigation (4x4 with row-wrap) ---

  let gridEl: HTMLElement | undefined = $state();

  function findCell(idx: number, role: 'pitch' | 'gate'): HTMLElement | null {
    if (!gridEl) return null;
    return gridEl.querySelector<HTMLElement>(`[data-step="${idx}"] [data-role="${role}"]`);
  }

  function focusCell(idx: number, role: 'pitch' | 'gate'): boolean {
    const target = findCell(idx, role);
    if (!target) return false;
    target.focus();
    if (target.tagName === 'INPUT') (target as HTMLInputElement).select();
    return true;
  }

  // Cartesian is a 4x4 cell grid. Each cell renders gate-on-top + pitch-below,
  // so the conceptual keyboard grid is 8 rows x 4 cols. Up from pitch jumps to
  // gate of the same cell; Up from a top-row gate clamps (no wrap). Same for
  // Down at the bottom + Left/Right at row edges.
  const NAV_SPEC = { cols: GRID_DIM, cellRows: GRID_DIM };

  function handleNav(e: KeyboardEvent, idx: number, role: 'pitch' | 'gate'): boolean {
    const max = CELL_COUNT - 1;
    if (
      e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
      e.key === 'ArrowUp'   || e.key === 'ArrowDown'
    ) {
      const next = resolveArrowNav({ index: idx, role }, e.key as ArrowKey, NAV_SPEC);
      if (!next) return false;
      return focusCell(next.index, next.role);
    }
    if (e.key === 'Enter' && role === 'pitch') {
      const next = idx === max ? max : idx + 1;
      Promise.resolve().then(() => focusCell(next, 'pitch'));
      return true;
    }
    if (e.key === 'Tab') {
      const dir = e.shiftKey ? -1 : 1;
      const next = idx + dir;
      if (next < 0 || next > max) return false;
      return focusCell(next, role);
    }
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

  <Handle type="target" position={Position.Left} id="clock"     style="top: 56px;  --handle-color: var(--cable-gate);" />
  <Handle type="target" position={Position.Left} id="x_cv"      style="top: 92px;  --handle-color: var(--cable-cv);" />
  <Handle type="target" position={Position.Left} id="y_cv"      style="top: 128px; --handle-color: var(--cable-cv);" />
  <Handle type="target" position={Position.Left} id="lfo_clock" style="top: 164px; --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 50px;">clk</span>
  <span class="port-label left" style="top: 86px;">x cv</span>
  <span class="port-label left" style="top: 122px;">y cv</span>
  <span class="port-label left" style="top: 158px;">lfo clk</span>

  <Handle type="source" position={Position.Right} id="pitch" style="top: 56px;  --handle-color: var(--cable-pitch);" />
  <Handle type="source" position={Position.Right} id="gate"  style="top: 92px;  --handle-color: var(--cable-gate);" />
  <Handle type="source" position={Position.Right} id="clock" style="top: 128px; --handle-color: var(--cable-gate);" />
  <Handle type="source" position={Position.Right} id="lfo_x" style="top: 164px; --handle-color: var(--cable-cv);" />
  <Handle type="source" position={Position.Right} id="lfo_y" style="top: 200px; --handle-color: var(--cable-cv);" />
  <span class="port-label right" style="top: 50px;">pitch</span>
  <span class="port-label right" style="top: 86px;">gate</span>
  <span class="port-label right" style="top: 122px;">clk</span>
  <span class="port-label right" style="top: 158px;">lfo x</span>
  <span class="port-label right" style="top: 194px;">lfo y</span>

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
      </div>
    {/each}
  </div>

  <div class="fader-row">
    <Fader value={octave}     min={-2}  max={2}    defaultValue={0}   label="Oct"  curve="discrete" onchange={set('octave')}     readLive={live('octave')} />
    <Fader value={gateLength} min={0.1} max={0.95} defaultValue={0.5} label="Gate" curve="linear"   onchange={set('gateLength')} readLive={live('gateLength')} />
  </div>

  <div class="lfo-row" data-testid={`cart-lfo-${id}`}>
    <div class="lfo-label">LFO</div>
    <Fader
      value={lfoDiv}
      min={0}
      max={LFO_DIVISIONS.length - 1}
      defaultValue={3}
      label="Div"
      curve="discrete"
      onchange={set('lfoDiv')}
      readLive={live('lfoDiv')}
      ticks={LFO_DIV_TICKS}
      formatValue={formatLfoDiv}
    />
    <Fader
      value={lfoShape}
      min={0}
      max={3}
      defaultValue={0}
      label="Wave"
      curve="linear"
      onchange={set('lfoShape')}
      readLive={live('lfoShape')}
      glyphs={LFO_SHAPE_GLYPHS}
    />
  </div>
</div>

<style>
  .cartesian-card { width: 360px; min-height: 460px; padding-right: 0; padding-left: 0; }
  .lfo-row {
    margin-top: 8px;
    padding: 0 22px 12px;
    display: flex;
    flex-direction: row;
    align-items: flex-end;
    gap: 16px;
    border-top: 1px solid #2a2f3a;
    padding-top: 10px;
  }
  .lfo-label {
    font-size: 0.62rem;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    align-self: center;
    margin-right: 4px;
  }
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
  .cartesian-card .fader-row {
    margin-top: 6px;
    padding: 0 50px;
    gap: 12px;
  }
</style>
