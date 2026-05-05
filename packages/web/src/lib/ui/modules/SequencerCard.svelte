<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import { patch, ydoc } from '$lib/graph/store';
  import { sequencerDef, defaultSteps, STEP_COUNT, type Step } from '$lib/audio/modules/sequencer';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // Bridge SyncedStore (Yjs) mutations into Svelte 5 reactivity. Same pattern
  // Canvas uses for flowNodes — bump a counter on ydoc updates and reference
  // it inside $derived so they refire when underlying patch state changes.
  let cardVersion = $state(0);
  $effect(() => {
    const h = () => {
      cardVersion = cardVersion + 1;
    };
    ydoc.on('update', h);
    return () => ydoc.off('update', h);
  });

  let bpm        = $derived((void cardVersion, node?.params.bpm        ?? 120));
  let length     = $derived((void cardVersion, node?.params.length     ?? 16));
  let octave     = $derived((void cardVersion, node?.params.octave     ?? 0));
  let gateLength = $derived((void cardVersion, node?.params.gateLength ?? 0.5));
  let swing      = $derived((void cardVersion, node?.params.swing      ?? 0));
  let isPlaying  = $derived((void cardVersion, (node?.params.isPlaying ?? 0) >= 0.5));

  let steps = $derived.by<Step[]>(() => {
    void cardVersion;
    const raw = (node?.data as Record<string, unknown> | undefined)?.steps;
    if (Array.isArray(raw)) return (raw as Step[]).map((s) => ({ on: !!s.on, pitch: s.pitch ?? 0 }));
    return defaultSteps();
  });

  const set = (k: string) => (v: number) => {
    const t = patch.nodes[id]; if (t) t.params[k] = v;
  };

  function togglePlay() {
    set('isPlaying')(isPlaying ? 0 : 1);
  }
  const live = (k: string) => () => {
    const e = engineCtx.get(); if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  // --- Visual current step indicator (polled from engine) ---
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

  // --- Step interaction: click to toggle, drag to set pitch ---

  function readStepsCopy(): Step[] {
    const t = patch.nodes[id];
    if (!t?.data) return defaultSteps();
    const raw = (t.data as Record<string, unknown>).steps;
    if (Array.isArray(raw)) {
      // Deep-copy so we can mutate freely without touching the proxy.
      return (raw as Step[]).map((s) => ({ on: !!s.on, pitch: s.pitch ?? 0 }));
    }
    return defaultSteps();
  }

  function writeSteps(arr: Step[]) {
    const t = patch.nodes[id];
    if (!t) return;
    ydoc.transact(() => {
      if (!t.data) t.data = {};
      // Replace the whole steps array (in-place index assignment doesn't
      // reliably propagate through SyncedStore for nested arrays-of-objects).
      (t.data as Record<string, unknown>).steps = arr;
    });
  }

  function toggleStep(i: number) {
    const arr = readStepsCopy();
    const cur = arr[i] ?? { on: false, pitch: 0 };
    arr[i] = { ...cur, on: !cur.on };
    writeSteps(arr);
  }

  let dragging: { idx: number; startY: number; startPitch: number } | null = $state(null);

  function stepPointerDown(e: PointerEvent, i: number) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const arr = steps;
    const cur = arr[i] ?? { on: false, pitch: 0 };
    dragging = { idx: i, startY: e.clientY, startPitch: cur.pitch };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function stepPointerMove(e: PointerEvent) {
    if (!dragging) return;
    const dy = dragging.startY - e.clientY;
    const delta = Math.round(dy / 8); // 8 px per semitone
    const newPitch = Math.max(-24, Math.min(24, dragging.startPitch + delta));
    const arr = readStepsCopy();
    const cur = arr[dragging.idx] ?? { on: false, pitch: 0 };
    if (cur.pitch !== newPitch) {
      arr[dragging.idx] = { ...cur, pitch: newPitch };
      writeSteps(arr);
    }
  }

  function stepPointerUp(e: PointerEvent, i: number) {
    if (!dragging) return;
    const moved = Math.abs(e.clientY - dragging.startY);
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    // If user didn't really drag (< 4 px), treat as a click → toggle.
    if (moved < 4) {
      toggleStep(i);
    }
    dragging = null;
  }
</script>

<div class="mod-card seq-card" onpointermove={stepPointerMove}>
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">
    Sequencer
    <button class="play-btn" class:playing={isPlaying} onclick={togglePlay} title={isPlaying ? 'Stop' : 'Play'}>
      {isPlaying ? '■' : '▶'}
    </button>
  </header>

  <Handle type="source" position={Position.Right} id="pitch" style="top: 56px; --handle-color: var(--cable-pitch);" />
  <Handle type="source" position={Position.Right} id="gate"  style="top: 92px; --handle-color: var(--cable-gate);" />
  <span class="port-label right" style="top: 50px;">pitch</span>
  <span class="port-label right" style="top: 86px;">gate</span>

  <div class="grid">
    {#each steps.slice(0, STEP_COUNT) as step, i (i)}
      <button
        class="cell"
        class:on={step.on}
        class:active={i === currentStep}
        class:dim={i >= length}
        title={`step ${i + 1} · pitch ${step.pitch >= 0 ? '+' : ''}${step.pitch}`}
        onpointerdown={(e) => stepPointerDown(e, i)}
        onpointerup={(e) => stepPointerUp(e, i)}
      >
        <div class="pitch-bar" style:height="{Math.min(100, Math.abs(step.pitch) * 4 + 10)}%"></div>
        <div class="cell-num">{i + 1}</div>
      </button>
    {/each}
  </div>

  <div class="fader-row">
    <Fader value={bpm}        min={30}  max={300} defaultValue={120} label="BPM"  curve="linear" onchange={set('bpm')}        readLive={live('bpm')} />
    <Fader value={length}     min={1}   max={32}  defaultValue={16}  label="Len"  curve="discrete" onchange={set('length')}   readLive={live('length')} />
    <Fader value={octave}     min={-2}  max={2}   defaultValue={0}   label="Oct"  curve="discrete" onchange={set('octave')}   readLive={live('octave')} />
    <Fader value={gateLength} min={0.1} max={0.95} defaultValue={0.5} label="Gate" curve="linear" onchange={set('gateLength')} readLive={live('gateLength')} />
    <Fader value={swing}      min={0}   max={0.75} defaultValue={0}  label="Sw"   curve="linear" onchange={set('swing')}     readLive={live('swing')} />
  </div>
</div>

<style>
  .seq-card {
    width: 540px;
    min-height: 280px;
    padding-right: 0;
    padding-left: 0;
  }
  .seq-card > .title {
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
    margin: 30px 22px 12px;
    display: grid;
    grid-template-columns: repeat(16, 1fr);
    gap: 3px;
  }
  .cell {
    position: relative;
    aspect-ratio: 1;
    background: #14171c;
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    padding: 0;
    cursor: ns-resize;
    overflow: hidden;
    user-select: none;
    touch-action: none;
  }
  .cell.dim {
    opacity: 0.35;
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
    top: 1px;
    right: 2px;
    font-size: 0.55rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    pointer-events: none;
    line-height: 1;
  }
  .fader-row {
    margin-top: 0;
    padding: 0 22px;
    gap: 8px;
  }
</style>
