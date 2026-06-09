<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import NoteEntry from '$lib/ui/controls/NoteEntry.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import QuicksaveControls from '$lib/ui/QuicksaveControls.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch, ydoc } from '$lib/graph/store';
  import { mutateNode, setNodeParam } from '$lib/graph/mutate';
  import {
    sequencerDef,
    defaultSteps,
    STEP_COUNT,
    coerceToSequencerStep,
    type Step,
  } from '$lib/audio/modules/sequencer';
  import SequencerPageNav from '$lib/ui/modules/SequencerPageNav.svelte';
  import {
    PAGE_SIZE,
    visiblePageFor,
    pageRange,
    ensureCapacity,
  } from '$lib/audio/modules/sequencer-pages';
  import { type ChordQuality, nextChordQuality } from '$lib/audio/poly';
  import { useEngine } from '$lib/audio/engine-context';
  import { parseNoteName } from '$lib/audio/note-entry';
  import { resolveArrowNav, type ArrowKey } from '$lib/audio/grid-nav';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    handleSlotClick,
    readSlots,
    readPendingMode,
    readQueuedSlot,
    readLastLoadedSlot,
    setPendingMode,
    setQueuedSlot,
    type TransportCardDeps,
  } from '$lib/audio/modules/transport-card';
  import type { PendingMode, SlotKey, Snapshot } from '$lib/audio/modules/transport-helpers';
  import ModuleTitle from './ModuleTitle.svelte';

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

  // Widen to STEP_COUNT capacity on read so the page-nav can address page
  // 1..7 even when the persisted steps[] array is shorter (e.g. legacy
  // 32-cell saves). Backward-compat: legacy slots 0..N preserved; tail
  // padded with empty {on:false, midi:C3, chord:'mono'} steps.
  let steps = $derived.by<Step[]>(() => {
    void cardVersion;
    const raw = (node?.data as Record<string, unknown> | undefined)?.steps;
    if (!Array.isArray(raw)) return defaultSteps();
    return ensureCapacity<Step>(
      (raw as unknown[]).map(coerceToSequencerStep),
      () => coerceToSequencerStep(null),
    );
  });

  const set = (k: string) => (v: number) => {
    setNodeParam(id, k, v);
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
  // Per-user view state. Local Svelte state — see sequencer-pages.ts header.
  let userPage = $state(0);
  let hold = $state(false);
  let visiblePage = $derived(visiblePageFor(userPage, currentStep, length, hold));
  let pageStart = $derived(pageRange(visiblePage).start);

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
    // Route through the origin-tagged mutation seam (graph/mutate.ts) so the
    // write is tagged LOCAL_ORIGIN and lands on the UndoManager — every step
    // edit (toggle gate, set pitch, cycle chord, clear) flows through here, so
    // this is what makes those edits Cmd-Z-able (Phase 4b). The mutator re-reads
    // the live node inside the transaction; setting the `steps` KEY on
    // `live.data` to a fresh plain array is the established safe write (we never
    // reassign an already-integrated Y type — see [[yjs-save-load-real-ydoc]]).
    // Whole-array replace is deliberate: in-place index assignment doesn't
    // reliably propagate through SyncedStore for nested arrays-of-objects.
    mutateNode(id, (live) => {
      if (!live.data) live.data = {};
      (live.data as Record<string, unknown>).steps = arr.map((s) => ({
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
    // The .cell-slot wrapper carries data-step; the inner input/button carries
    // data-role. Use a descendant selector to find the role inside the slot.
    return gridEl.querySelector<HTMLElement>(
      `[data-step="${stepIdx}"] [data-role="${role}"]`,
    );
  }

  function focusCell(stepIdx: number, role: 'pitch' | 'gate'): boolean {
    const target = findCell(stepIdx, role);
    if (!target) return false;
    target.focus();
    if (target.tagName === 'INPUT') (target as HTMLInputElement).select();
    return true;
  }

  // Sequencer is linear: cellRows=1, cols=PAGE_SIZE. Arrows clamp at the
  // edges of the visible page (no wrap, no page-cross — use the < / > nav
  // buttons for that). Up from a pitch input lands on the gate of the same
  // step (gate is rendered above pitch). Up from a gate clamps (top of grid).
  const NAV_SPEC = { cols: PAGE_SIZE, cellRows: 1 };

  function handleNav(e: KeyboardEvent, stepIdx: number, role: 'pitch' | 'gate'): boolean {
    const col = stepIdx - pageStart;
    const minStep = pageStart;
    const maxStep = pageStart + PAGE_SIZE - 1;
    if (
      e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
      e.key === 'ArrowUp'   || e.key === 'ArrowDown'
    ) {
      const next = resolveArrowNav({ index: col, role }, e.key as ArrowKey, NAV_SPEC);
      if (!next) return false;
      return focusCell(pageStart + next.index, next.role);
    }
    if (e.key === 'Enter' && role === 'pitch') {
      // Commit happens in NoteEntry; advance to next pitch.
      tick().then(() => focusCell(Math.min(maxStep, stepIdx + 1), 'pitch'));
      return true;
    }
    if (e.key === 'Tab') {
      const dir = e.shiftKey ? -1 : 1;
      const next = stepIdx + dir;
      if (next < minStep || next > maxStep) return false; // let browser tab out
      return focusCell(next, role);
    }
    return false;
  }

  // ---------------- Quicksave + transport ----------------

  const transportDeps: TransportCardDeps = {
    nodeId: id,
    patch,
    transact: (fn) => ydoc.transact(fn),
    snapshot: (): Snapshot => {
      const t = patch.nodes[id];
      return {
        steps: readStepsCopy().map((s) => ({ on: s.on, midi: s.midi, chord: s.chord ?? 'mono' })),
        bpm: t?.params.bpm ?? 120,
        length: t?.params.length ?? 16,
        octave: t?.params.octave ?? 0,
        gateLength: t?.params.gateLength ?? 0.5,
        swing: t?.params.swing ?? 0,
      };
    },
    applySnapshot: (snap: Snapshot) => {
      const t = patch.nodes[id];
      if (!t) return;
      // Deep-clone steps before reassigning so the same Y.Map doesn't end
      // up at two paths in the Y.Doc tree (Yjs throws "reassigning object
      // that already occurs in the tree" otherwise — the snap usually lives
      // inside slots[N] still).
      ydoc.transact(() => {
        if (Array.isArray(snap.steps)) {
          if (!t.data) t.data = {};
          (t.data as Record<string, unknown>).steps = (snap.steps as unknown[]).map((s) => {
            const ns = coerceToSequencerStep(s);
            return { on: ns.on, midi: ns.midi, chord: ns.chord ?? 'mono' };
          });
        }
        for (const k of ['bpm', 'length', 'octave', 'gateLength', 'swing'] as const) {
          const v = snap[k];
          if (typeof v === 'number') t.params[k] = v;
        }
      });
    },
  };

  let slots = $derived((void cardVersion, readSlots(node)));
  let pendingMode = $derived<PendingMode>((void cardVersion, readPendingMode(node)));
  let queuedSlot = $derived<SlotKey | null>((void cardVersion, readQueuedSlot(node)));
  let lastLoadedSlot = $derived<SlotKey | null>((void cardVersion, readLastLoadedSlot(node)));

  function onSetMode(m: PendingMode) { setPendingMode(transportDeps, m); }
  function onSlotClick(k: SlotKey) { handleSlotClick(transportDeps, k); }
  function onPlayToggle() { togglePlay(); }
  function onReset() {
    // RESET: clear any pending queue, force the engine to step 0 by writing
    // node.data.queuedSlot=null (no swap) and signaling reset via... the
    // engine doesn't have a direct "reset" param, but the wrapping logic
    // observes data.queuedSlot. We toggle isPlaying off→on to nudge the
    // engine's prevPlaying transition (which resets stepIndex to 0).
    // Simpler: write isPlaying=0, then back to whatever it was.
    const wasPlaying = isPlaying;
    setQueuedSlot(transportDeps, null);
    set('isPlaying')(0);
    if (wasPlaying) {
      // Re-arm play next tick so the engine sees the prev/cur transition
      // and resets the step counter.
      requestAnimationFrame(() => set('isPlaying')(1));
    }
  }

  const inputs: PortDescriptor[] = [
    { id: 'clock', label: 'CLOCK IN', cable: 'gate' },
    { id: 'play_cv',   label: 'PLAY GATE',     cable: 'gate' },
    { id: 'reset_cv',  label: 'RESET GATE',    cable: 'gate' },
    { id: 'queue1_cv', label: 'PLAY QUEUE 1',  cable: 'gate' },
    { id: 'queue2_cv', label: 'PLAY QUEUE 2',  cable: 'gate' },
    { id: 'queue3_cv', label: 'PLAY QUEUE 3',  cable: 'gate' },
    { id: 'queue4_cv', label: 'PLAY QUEUE 4',  cable: 'gate' },
    { id: 'queue5_cv', label: 'PLAY QUEUE 5',  cable: 'gate' },
    { id: 'queue6_cv', label: 'PLAY QUEUE 6',  cable: 'gate' },
    { id: 'queue7_cv', label: 'PLAY QUEUE 7',  cable: 'gate' },
    { id: 'queue8_cv', label: 'PLAY QUEUE 8',  cable: 'gate' },
    { id: 'next_cv',   label: 'NEXT',          cable: 'gate' },
    { id: 'prev_cv',   label: 'PREV',          cable: 'gate' },
    { id: 'random_cv', label: 'RANDOM',        cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'pitch', cable: 'polyPitchGate' },
    { id: 'gate',  cable: 'gate' },
    { id: 'clock', label: 'CLOCK OUT', cable: 'gate' },
  ];
</script>

<div class="mod-card seq-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="Sequencer" inline />
    <button class="play-btn" class:playing={isPlaying} onclick={togglePlay} title={isPlaying ? 'Stop' : 'Play'}>
      {isPlaying ? '■' : '▶'}
    </button>
  </header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
  <div class="page-nav-row">
    <SequencerPageNav
      length={length}
      currentStep={currentStep}
      userPage={userPage}
      hold={hold}
      testIdPrefix={`sequencer-${id}`}
      onUserPageChange={(p) => (userPage = p)}
      onHoldChange={(h) => (hold = h)}
    />
  </div>
  <div class="grid" bind:this={gridEl} data-testid={`seq-grid-${id}`}>
    {#each steps.slice(pageStart, pageStart + PAGE_SIZE) as step, c (pageStart + c)}
      {@const i = pageStart + c}
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
    <Fader value={bpm}        min={30}  max={300} defaultValue={120} label="BPM"  curve="linear" onchange={set('bpm')} moduleId={id} paramId="bpm"        readLive={live('bpm')} />
    <Fader value={length}     min={1}   max={128} defaultValue={16}  label="Len"  curve="discrete" onchange={set('length')} moduleId={id} paramId="length"   readLive={live('length')} />
    <Fader value={octave}     min={-2}  max={2}   defaultValue={0}   label="Oct"  curve="discrete" onchange={set('octave')} moduleId={id} paramId="octave"   readLive={live('octave')} />
    <Fader value={gateLength} min={0.1} max={0.95} defaultValue={0.5} label="Gate" curve="linear" onchange={set('gateLength')} moduleId={id} paramId="gateLength" readLive={live('gateLength')} />
    <Fader value={swing}      min={0}   max={0.75} defaultValue={0}  label="SWG"  curve="linear" onchange={set('swing')} moduleId={id} paramId="swing"     readLive={live('swing')} />
  </div>

  <QuicksaveControls
    nodeId={id}
    {slots}
    {pendingMode}
    {queuedSlot}
    {lastLoadedSlot}
    {isPlaying}
    {onSetMode}
    {onSlotClick}
    {onPlayToggle}
    {onReset}
  />
  </PatchPanel>
</div>

<style>
  .seq-card {
    width: 540px;
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
  .page-nav-row {
    margin: 12px 22px 0;
    display: flex;
    justify-content: flex-end;
    align-items: center;
  }
  .grid {
    margin: 8px 22px 12px;
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
    border: 1px solid var(--border);
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
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
  .fader-row {
    margin-top: 6px;
    padding: 0 22px;
    gap: 8px;
  }
</style>
