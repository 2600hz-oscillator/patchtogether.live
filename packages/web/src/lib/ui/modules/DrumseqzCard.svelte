<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import NoteEntry from '$lib/ui/controls/NoteEntry.svelte';
  import { patch, ydoc } from '$lib/graph/store';
  import {
    applyEuclidean,
    coerceToDrumseqzTracks,
    defaultTracks,
    DEFAULT_TRACK_ROOT,
    STEP_COUNT,
    TRACK_COUNT,
    type DrumCell,
    type DrumTrack,
  } from '$lib/audio/modules/drumseqz';
  import { useEngine } from '$lib/audio/engine-context';
  import { parseNoteName } from '$lib/audio/note-entry';
  import { resolveArrowNav, type ArrowKey } from '$lib/audio/grid-nav';
  import { testHooksEnabled } from '$lib/dev/test-hooks';
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

  let bpm        = $derived((void cardVersion, node?.params.bpm        ?? 120));
  let length     = $derived((void cardVersion, node?.params.length     ?? 16));
  let octave     = $derived((void cardVersion, node?.params.octave     ?? 0));
  let gateLength = $derived((void cardVersion, node?.params.gateLength ?? 0.5));
  let swing      = $derived((void cardVersion, node?.params.swing      ?? 0));
  let isPlaying  = $derived((void cardVersion, (node?.params.isPlaying ?? 0) >= 0.5));

  let tracks = $derived.by<DrumTrack[]>(() => {
    void cardVersion;
    const raw = (node?.data as Record<string, unknown> | undefined)?.tracks;
    return coerceToDrumseqzTracks(raw);
  });

  const set = (k: string) => (v: number) => {
    const t = patch.nodes[id]; if (t) t.params[k] = v;
  };
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };
  function togglePlay() { set('isPlaying')(isPlaying ? 0 : 1); }

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
  onDestroy(() => { if (raf !== null) cancelAnimationFrame(raf); });

  // --- Track / cell mutation helpers ---

  function readTracksCopy(): DrumTrack[] {
    const t = patch.nodes[id];
    if (!t?.data) return defaultTracks();
    const raw = (t.data as Record<string, unknown>).tracks;
    return coerceToDrumseqzTracks(raw);
  }

  function writeTracks(arr: DrumTrack[]) {
    const t = patch.nodes[id];
    if (!t) return;
    ydoc.transact(() => {
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).tracks = arr.map((tr) => ({
        cells: tr.cells.map((c) => ({ on: c.on, midi: c.midi })),
      }));
    });
  }

  function writeTrackCells(trackIdx: number, cells: DrumCell[]) {
    const arr = readTracksCopy();
    arr[trackIdx] = { cells };
    writeTracks(arr);
  }

  function commitPitch(t: number, i: number, input: string) {
    const arr = readTracksCopy();
    const cur = arr[t]?.cells[i] ?? { on: false, midi: null };
    const trimmed = input.trim();
    const parsed = trimmed === '' ? null : parseNoteName(trimmed);
    const cells = (arr[t]?.cells ?? []).slice();
    cells[i] = { on: cur.on, midi: parsed };
    writeTrackCells(t, cells);
  }

  function toggleGate(t: number, i: number) {
    const arr = readTracksCopy();
    const cur = arr[t]?.cells[i] ?? { on: false, midi: null };
    const cells = (arr[t]?.cells ?? []).slice();
    cells[i] = { on: !cur.on, midi: cur.midi };
    writeTrackCells(t, cells);
  }

  // Eucl slider handler. Single ydoc.transact: writes the new euclid param
  // AND rewrites the track's cells in one Yjs commit so collaborators see
  // both sides of the change atomically.
  function setEuclid(t: number, k: number) {
    const target = patch.nodes[id];
    if (!target) return;
    const arr = readTracksCopy();
    const cells = applyEuclidean(arr[t]?.cells ?? [], k);
    ydoc.transact(() => {
      target.params[`trk${t + 1}_euclid`] = k;
      if (!target.data) target.data = {};
      const next = arr.map((tr, idx) => ({
        cells: (idx === t ? cells : tr.cells).map((c) => ({ on: c.on, midi: c.midi })),
      }));
      (target.data as Record<string, unknown>).tracks = next;
    });
  }

  // --- Keyboard navigation: 4 cell rows × 16 cols ---

  let gridEl: HTMLElement | undefined = $state();

  function findCell(t: number, i: number, role: 'pitch' | 'gate'): HTMLElement | null {
    if (!gridEl) return null;
    const idx = t * STEP_COUNT + i;
    return gridEl.querySelector<HTMLElement>(`[data-step="${idx}"] [data-role="${role}"]`);
  }
  function focusCell(t: number, i: number, role: 'pitch' | 'gate'): boolean {
    const target = findCell(t, i, role);
    if (!target) return false;
    target.focus();
    if (target.tagName === 'INPUT') (target as HTMLInputElement).select();
    return true;
  }

  const NAV_SPEC = { cols: STEP_COUNT, cellRows: TRACK_COUNT };

  function handleNav(e: KeyboardEvent, t: number, i: number, role: 'pitch' | 'gate'): boolean {
    const idx = t * STEP_COUNT + i;
    const max = TRACK_COUNT * STEP_COUNT - 1;
    if (
      e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
      e.key === 'ArrowUp'   || e.key === 'ArrowDown'
    ) {
      const next = resolveArrowNav({ index: idx, role }, e.key as ArrowKey, NAV_SPEC);
      if (!next) return false;
      const nt = Math.floor(next.index / STEP_COUNT);
      const ni = next.index % STEP_COUNT;
      return focusCell(nt, ni, next.role);
    }
    if (e.key === 'Enter' && role === 'pitch') {
      const ni = Math.min(STEP_COUNT - 1, i + 1);
      tick().then(() => focusCell(t, ni, 'pitch'));
      return true;
    }
    if (e.key === 'Tab') {
      const dir = e.shiftKey ? -1 : 1;
      const nextIdx = idx + dir;
      if (nextIdx < 0 || nextIdx > max) return false;
      const nt = Math.floor(nextIdx / STEP_COUNT);
      const ni = nextIdx % STEP_COUNT;
      return focusCell(nt, ni, role);
    }
    return false;
  }

  // --- Test hooks (gated on $lib/dev/test-hooks). Exposed for E2E ---
  // __drumseqzCellAt(id, track, step) -> { on, midi } | null
  // __drumseqzSetCell(id, track, step, partial) -> void

  $effect(() => {
    if (!testHooksEnabled()) return;
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const w = globalThis as any;
    if (!w.__drumseqzCellAt) {
      w.__drumseqzCellAt = (nodeId: string, track: number, step: number) => {
        const n = patch.nodes[nodeId];
        const raw = (n?.data as Record<string, unknown> | undefined)?.tracks;
        const trks = coerceToDrumseqzTracks(raw);
        return trks[track]?.cells[step] ?? null;
      };
    }
    if (!w.__drumseqzSetCell) {
      w.__drumseqzSetCell = (
        nodeId: string,
        track: number,
        step: number,
        partial: { on?: boolean; midi?: number | null },
      ) => {
        const n = patch.nodes[nodeId];
        if (!n) return;
        const raw = (n?.data as Record<string, unknown> | undefined)?.tracks;
        const trks = coerceToDrumseqzTracks(raw);
        const cur = trks[track]?.cells[step] ?? { on: false, midi: null };
        const cells = (trks[track]?.cells ?? []).slice();
        cells[step] = {
          on: partial.on ?? cur.on,
          midi: partial.midi !== undefined ? partial.midi : cur.midi,
        };
        const next = trks.map((tr, idx) => ({
          cells: (idx === track ? cells : tr.cells).map((c) => ({ on: c.on, midi: c.midi })),
        }));
        ydoc.transact(() => {
          if (!n.data) n.data = {};
          (n.data as Record<string, unknown>).tracks = next;
        });
      };
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });

  // Per-track Eucl slider value reads.
  function trkEucl(t: number): number {
    void cardVersion;
    return node?.params[`trk${t + 1}_euclid`] ?? 0;
  }
  function trkRoot(t: number): number {
    void cardVersion;
    return node?.params[`trk${t + 1}_root`] ?? (DEFAULT_TRACK_ROOT[t] ?? 48);
  }
  function trkOct(t: number): number {
    void cardVersion;
    return node?.params[`trk${t + 1}_octave`] ?? 0;
  }
</script>

<div class="mod-card drumseqz-card" data-testid={`drumseqz-${id}`}>
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">
    DRUMSEQZ
    <button class="play-btn" class:playing={isPlaying} onclick={togglePlay} title={isPlaying ? 'Stop' : 'Play'}>
      {isPlaying ? '■' : '▶'}
    </button>
  </header>

  <Handle type="target" position={Position.Left} id="clock" style="top: 56px; --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 50px;">clk in</span>

  <!-- Right-side ports: gate1/pitch1, gate2/pitch2, ... pairs, then chained clk out. -->
  {#each Array.from({ length: TRACK_COUNT }, (_, t) => t) as t (t)}
    <Handle
      type="source"
      position={Position.Right}
      id={`gate${t + 1}`}
      style={`top: ${56 + t * 64}px; --handle-color: var(--cable-gate);`}
    />
    <Handle
      type="source"
      position={Position.Right}
      id={`pitch${t + 1}`}
      style={`top: ${88 + t * 64}px; --handle-color: var(--cable-pitch);`}
    />
    <span class="port-label right" style={`top: ${50 + t * 64}px;`}>gate{t + 1}</span>
    <span class="port-label right" style={`top: ${82 + t * 64}px;`}>pch{t + 1}</span>
  {/each}
  <Handle type="source" position={Position.Right} id="clock" style="top: 312px; --handle-color: var(--cable-gate);" />
  <span class="port-label right" style="top: 306px;">clk out</span>

  <div class="grid" bind:this={gridEl} data-testid={`drumseqz-grid-${id}`}>
    {#each tracks.slice(0, TRACK_COUNT) as track, t (t)}
      <div class="track-row" data-track={t}>
        <div class="track-label">{t + 1}</div>
        <div class="cells">
          {#each track.cells.slice(0, STEP_COUNT) as cell, i (i)}
            <div class="cell-slot" data-step={t * STEP_COUNT + i} data-track={t} data-stepidx={i}>
              <NoteEntry
                midi={cell.midi}
                on={cell.on}
                isActive={i === currentStep}
                dim={i >= length}
                testId={`drumseqz-pitch-${id}-${t}-${i}`}
                gateTestId={`drumseqz-gate-${id}-${t}-${i}`}
                onCommit={(input) => commitPitch(t, i, input)}
                onGateToggle={() => toggleGate(t, i)}
                onNavKey={(e) => {
                  const role = (e.target as HTMLElement)?.dataset?.role === 'gate' ? 'gate' : 'pitch';
                  return handleNav(e, t, i, role as 'pitch' | 'gate');
                }}
              />
            </div>
          {/each}
        </div>
        <div class="track-knobs">
          <Fader
            value={trkEucl(t)}
            min={0}
            max={16}
            defaultValue={0}
            label={`E${t + 1}`}
            curve="discrete"
            onchange={(v) => setEuclid(t, Math.round(v))}
          />
          <Fader
            value={trkRoot(t)}
            min={33}
            max={114}
            defaultValue={DEFAULT_TRACK_ROOT[t] ?? 48}
            label={`R${t + 1}`}
            curve="discrete"
            onchange={set(`trk${t + 1}_root`)}
            readLive={live(`trk${t + 1}_root`)}
          />
          <Fader
            value={trkOct(t)}
            min={-2}
            max={2}
            defaultValue={0}
            label={`O${t + 1}`}
            curve="discrete"
            onchange={set(`trk${t + 1}_octave`)}
            readLive={live(`trk${t + 1}_octave`)}
          />
        </div>
      </div>
    {/each}
  </div>

  <div class="fader-row">
    <Fader value={bpm}        min={30}  max={300}  defaultValue={120} label="BPM"  curve="linear"   onchange={set('bpm')}        readLive={live('bpm')} />
    <Fader value={length}     min={1}   max={16}   defaultValue={16}  label="Len"  curve="discrete" onchange={set('length')}     readLive={live('length')} />
    <Fader value={octave}     min={-2}  max={2}    defaultValue={0}   label="Oct"  curve="discrete" onchange={set('octave')}     readLive={live('octave')} />
    <Fader value={gateLength} min={0.1} max={0.95} defaultValue={0.5} label="Gate" curve="linear"   onchange={set('gateLength')} readLive={live('gateLength')} />
    <Fader value={swing}      min={0}   max={0.75} defaultValue={0}   label="Sw"   curve="linear"   onchange={set('swing')}      readLive={live('swing')} />
  </div>
</div>

<style>
  .drumseqz-card {
    width: 820px;
    min-height: 360px;
    padding-right: 0;
    padding-left: 0;
  }
  .drumseqz-card > .title {
    padding-right: 22px;
    padding-left: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .play-btn {
    width: 22px;
    height: 22px;
    background: #2a2f3a;
    border: 1px solid #404652;
    color: var(--text);
    border-radius: 3px;
    font-size: 0.7rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    padding: 0;
  }
  .play-btn.playing {
    background: var(--cable-gate);
    color: #1a1d23;
    border-color: var(--cable-gate);
  }
  .grid {
    margin: 16px 64px 8px 28px;
    display: grid;
    grid-template-columns: 1fr;
    gap: 4px;
  }
  .track-row {
    display: grid;
    grid-template-columns: 18px 1fr 168px;
    gap: 6px;
    align-items: center;
  }
  .track-label {
    font-size: 0.7rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    text-align: center;
  }
  .cells {
    display: grid;
    grid-template-columns: repeat(16, 1fr);
    gap: 2px;
    min-width: 0;
  }
  .cell-slot {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    min-width: 0;
  }
  .track-knobs {
    display: flex;
    flex-direction: row;
    gap: 4px;
    align-items: flex-end;
    justify-content: center;
  }
  .track-knobs :global(.fader-shell) {
    transform: scale(0.78);
    transform-origin: bottom center;
  }
  .fader-row {
    margin-top: 10px;
    padding: 0 28px;
    gap: 8px;
    border-top: 1px solid #2a2f3a;
    padding-top: 10px;
  }
</style>
