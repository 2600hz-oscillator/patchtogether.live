<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import NoteEntry from '$lib/ui/controls/NoteEntry.svelte';
  import { patch, ydoc } from '$lib/graph/store';
  import {
    sequencerDef,
    defaultSteps,
    STEP_COUNT,
    coerceToSequencerStep,
    type Step,
  } from '$lib/audio/modules/sequencer';
  import { type ChordQuality, nextChordQuality } from '$lib/audio/poly';
  import { useEngine } from '$lib/audio/engine-context';
  import { parseNoteName } from '$lib/audio/note-entry';
  import type { ModuleNode } from '$lib/graph/types';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // Bridge SyncedStore (Yjs) mutations into Svelte 5 reactivity.
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
    if (Array.isArray(raw)) return (raw as unknown[]).map(coerceToSequencerStep);
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

  // --- Step mutation helpers ---

  function readStepsCopy(): Step[] {
    const t = patch.nodes[id];
    if (!t?.data) return defaultSteps();
    const raw = (t.data as Record<string, unknown>).steps;
    if (Array.isArray(raw)) return (raw as unknown[]).map(coerceToSequencerStep);
    return defaultSteps();
  }

  function writeSteps(arr: Step[]) {
    const t = patch.nodes[id];
    if (!t) return;
    ydoc.transact(() => {
      if (!t.data) t.data = {};
      // Replace the whole steps array (in-place index assignment doesn't
      // reliably propagate through SyncedStore for nested arrays-of-objects).
      (t.data as Record<string, unknown>).steps = arr.map((s) => ({
        on: s.on,
        midi: s.midi,
        chord: s.chord ?? 'mono',
      }));
    });
  }

  function commitPitch(i: number, input: string) {
    const arr = readStepsCopy();
    const cur = arr[i] ?? { on: false, midi: null, chord: 'mono' as ChordQuality };
    const trimmed = input.trim();
    const parsed = trimmed === '' ? null : parseNoteName(trimmed);
    arr[i] = { on: cur.on, midi: parsed, chord: cur.chord ?? 'mono' };
    writeSteps(arr);
  }

  function toggleGate(i: number) {
    const arr = readStepsCopy();
    const cur = arr[i] ?? { on: false, midi: null, chord: 'mono' as ChordQuality };
    arr[i] = { on: !cur.on, midi: cur.midi, chord: cur.chord ?? 'mono' };
    writeSteps(arr);
  }

  /** Cycle a single step's chord quality: mono → maj → min → mono. */
  function cycleChord(i: number) {
    const arr = readStepsCopy();
    const cur = arr[i] ?? { on: false, midi: null, chord: 'mono' as ChordQuality };
    const next = nextChordQuality(cur.chord);
    arr[i] = { on: cur.on, midi: cur.midi, chord: next };
    writeSteps(arr);
  }

  /** UI label for the per-step chord badge. mono → blank circle ('—'), maj → 'M', min → 'm'. */
  function chordLabel(c: ChordQuality | undefined): string {
    if (c === 'maj') return 'M';
    if (c === 'min') return 'm';
    return '—';
  }

  // --- Keyboard navigation ---

  let gridEl: HTMLElement | undefined = $state();

  function findCell(stepIdx: number, role: 'pitch' | 'gate'): HTMLElement | null {
    if (!gridEl) return null;
    return gridEl.querySelector<HTMLElement>(
      `[data-step="${stepIdx}"][data-role="${role}"]`,
    );
  }

  function focusCell(stepIdx: number, role: 'pitch' | 'gate'): boolean {
    const target = findCell(stepIdx, role);
    if (!target) return false;
    target.focus();
    if (target.tagName === 'INPUT') (target as HTMLInputElement).select();
    return true;
  }

  // Navigation behavior is shared across all cells. Returns true if the parent
  // handled the event (caller suppresses default). Sequencer is linear: arrows
  // do NOT wrap by row — they clamp at the edges.
  function handleNav(e: KeyboardEvent, stepIdx: number, role: 'pitch' | 'gate'): boolean {
    const max = STEP_COUNT - 1;
    if (e.key === 'ArrowLeft') {
      const next = Math.max(0, stepIdx - 1);
      return focusCell(next, role);
    }
    if (e.key === 'ArrowRight') {
      const next = Math.min(max, stepIdx + 1);
      return focusCell(next, role);
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      // Swap pitch <-> gate within the same step.
      const otherRole = role === 'pitch' ? 'gate' : 'pitch';
      return focusCell(stepIdx, otherRole);
    }
    if (e.key === 'Enter' && role === 'pitch') {
      // Commit happens in NoteEntry; advance to next pitch.
      tick().then(() => focusCell(Math.min(max, stepIdx + 1), 'pitch'));
      return true;
    }
    if (e.key === 'Tab') {
      // Let parent decide: if shift, prev; else next. Skip to same-role cell.
      const dir = e.shiftKey ? -1 : 1;
      const next = stepIdx + dir;
      if (next < 0 || next > max) return false; // let browser tab out
      return focusCell(next, role);
    }
    return false;
  }
</script>

<div class="mod-card seq-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">
    Sequencer
    <button class="play-btn" class:playing={isPlaying} onclick={togglePlay} title={isPlaying ? 'Stop' : 'Play'}>
      {isPlaying ? '■' : '▶'}
    </button>
  </header>

  <Handle type="target" position={Position.Left}  id="clock" style="top: 56px; --handle-color: var(--cable-gate);" />
  <span class="port-label left" style="top: 50px;">clk in</span>

  <Handle type="source" position={Position.Right} id="pitch" style="top: 56px; --handle-color: var(--cable-polyPitchGate);" />
  <Handle type="source" position={Position.Right} id="gate"  style="top: 92px; --handle-color: var(--cable-gate);" />
  <Handle type="source" position={Position.Right} id="clock" style="top: 128px; --handle-color: var(--cable-gate);" />
  <span class="port-label right" style="top: 50px;">pitch</span>
  <span class="port-label right" style="top: 86px;">gate</span>
  <span class="port-label right" style="top: 122px;">clk out</span>

  <div class="grid" bind:this={gridEl} data-testid={`seq-grid-${id}`}>
    {#each steps.slice(0, STEP_COUNT) as step, i (i)}
      <div class="cell-slot" data-step={i}>
        <div class="cell-num">{i + 1}</div>
        <NoteEntry
          midi={step.midi}
          on={step.on}
          isActive={i === currentStep}
          dim={i >= length}
          testId={`seq-pitch-${id}-${i}`}
          gateTestId={`seq-gate-${id}-${i}`}
          onCommit={(input) => commitPitch(i, input)}
          onGateToggle={() => toggleGate(i)}
          onNavKey={(e) => {
            // We get a bare keyboardevent; figure out which role from the target.
            const role = (e.target as HTMLElement)?.dataset?.role === 'gate' ? 'gate' : 'pitch';
            return handleNav(e, i, role as 'pitch' | 'gate');
          }}
        />
        <button
          class="chord-badge"
          class:mono={(step.chord ?? 'mono') === 'mono'}
          class:maj={step.chord === 'maj'}
          class:min={step.chord === 'min'}
          type="button"
          data-testid={`seq-chord-${id}-${i}`}
          data-step={i}
          data-role="chord"
          data-chord={step.chord ?? 'mono'}
          title={`Chord: ${step.chord ?? 'mono'} (click to cycle mono → maj → min)`}
          onclick={() => cycleChord(i)}
        >{chordLabel(step.chord)}</button>
      </div>
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
  .cell-slot {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    min-width: 0;
  }
  .cell-num {
    font-size: 0.55rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    text-align: center;
    line-height: 1.4;
  }
  .chord-badge {
    width: 100%;
    height: 12px;
    margin-top: 1px;
    background: #14171c;
    border: 1px solid #2a2f3a;
    border-radius: 2px;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    font-size: 0.55rem;
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
  .fader-row {
    margin-top: 6px;
    padding: 0 22px;
    gap: 8px;
  }
</style>
