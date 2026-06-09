<script lang="ts">
  // MacseqCard — 16-step sequencer with per-step MACROOSCILLATOR voice
  // (model) picker. Pitch + gate behave like the base sequencer; the new
  // MODELCV output emits the current step's modelIndex.
  //
  // Per-step UI (one row):
  //   [ NoteEntry (midi + gate toggle) ] [ <select> model dropdown ]
  // Model dropdown has a default "—" / unset option that emits null →
  // HOLD-LAST MODELCV (see macseq.ts file header for the rationale).

  import { onDestroy } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import NoteEntry from '$lib/ui/controls/NoteEntry.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import QuicksaveControls from '$lib/ui/QuicksaveControls.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch, ydoc } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import {
    STEP_COUNT,
    PAGE_SIZE,
    coerceSteps,
    defaultSteps,
    MODEL_NAMES,
    MACRO_MAX_MODEL,
    type MacseqStep,
  } from '$lib/audio/modules/macseq';
  import SequencerPageNav from '$lib/ui/modules/SequencerPageNav.svelte';
  import { visiblePageFor, pageRange } from '$lib/audio/modules/sequencer-pages';
  import { useEngine } from '$lib/audio/engine-context';
  import { parseNoteName } from '$lib/audio/note-entry';
  import { testHooksEnabled } from '$lib/dev/test-hooks';
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

  // Force re-derive on every Yjs update — matches the other sequencer cards.
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
  let isPlaying  = $derived((void cardVersion, (node?.params.isPlaying ?? 0) >= 0.5));

  let steps = $derived.by<MacseqStep[]>(() => {
    void cardVersion;
    const raw = (node?.data as Record<string, unknown> | undefined)?.steps;
    return coerceSteps(raw);
  });

  const set = (k: string) => (v: number) => setNodeParam(id, k, v);

  function togglePlay() {
    set('isPlaying')(isPlaying ? 0 : 1);
  }
  const live = (k: string) => () => {
    const e = engineCtx.get();
    if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  // Visual playhead (sounding now, not next-to-be-scheduled).
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

  function readStepsCopy(): MacseqStep[] {
    const t = patch.nodes[id];
    const raw = (t?.data as Record<string, unknown> | undefined)?.steps;
    return coerceSteps(raw);
  }

  function writeSteps(arr: MacseqStep[]) {
    const target = patch.nodes[id];
    if (!target) return;
    ydoc.transact(() => {
      if (!target.data) target.data = {};
      (target.data as Record<string, unknown>).steps = arr.map((s) => ({
        on: s.on,
        midi: s.midi,
        model: s.model,
      }));
    });
  }

  function toggleGate(i: number) {
    const arr = readStepsCopy();
    const cur = arr[i] ?? { on: false, midi: null, model: null };
    arr[i] = { on: !cur.on, midi: cur.midi, model: cur.model };
    writeSteps(arr);
  }
  function commitPitch(i: number, input: string) {
    const arr = readStepsCopy();
    const cur = arr[i] ?? { on: false, midi: null, model: null };
    const trimmed = input.trim();
    const parsed = trimmed === '' ? null : parseNoteName(trimmed);
    arr[i] = { on: cur.on, midi: parsed, model: cur.model };
    writeSteps(arr);
  }
  function setStepModel(i: number, raw: string) {
    // '' = unset → null; otherwise an integer index in MODEL_NAMES.
    const arr = readStepsCopy();
    const cur = arr[i] ?? { on: false, midi: null, model: null };
    let model: number | null = null;
    if (raw !== '') {
      const idx = Number.parseInt(raw, 10);
      if (Number.isFinite(idx) && idx >= 0 && idx <= MACRO_MAX_MODEL) model = idx;
    }
    arr[i] = { on: cur.on, midi: cur.midi, model };
    writeSteps(arr);
  }

  // ---------------- Quicksave + transport ----------------
  //
  // Parity with the base Sequencer's 8-slot quicksave. The snapshot captures
  // MACSEQ's per-step {on, midi, model} grid + bpm/length/octave/gateLength.

  const transportDeps: TransportCardDeps = {
    nodeId: id,
    patch,
    transact: (fn) => ydoc.transact(fn),
    snapshot: (): Snapshot => {
      const t = patch.nodes[id];
      return {
        steps: readStepsCopy().map((s) => ({ on: s.on, midi: s.midi, model: s.model })),
        bpm: t?.params.bpm ?? 120,
        length: t?.params.length ?? 16,
        octave: t?.params.octave ?? 0,
        gateLength: t?.params.gateLength ?? 0.5,
      };
    },
    applySnapshot: (snap: Snapshot) => {
      const t = patch.nodes[id];
      if (!t) return;
      ydoc.transact(() => {
        if (Array.isArray(snap.steps)) {
          if (!t.data) t.data = {};
          // Deep-clone via coerceSteps so the same Y.Map doesn't land at two
          // paths (the snap usually still lives inside slots[N]).
          (t.data as Record<string, unknown>).steps = coerceSteps(snap.steps).map((s) => ({
            on: s.on,
            midi: s.midi,
            model: s.model,
          }));
        }
        for (const k of ['bpm', 'length', 'octave', 'gateLength'] as const) {
          const v = snap[k];
          if (typeof v === 'number') t.params[k] = v; // guard:allow-raw-write
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
    // RESET: clear any pending queue + nudge the engine's prev/cur transition
    // (which resets stepIndex to 0). Mirrors SequencerCard.onReset.
    const wasPlaying = isPlaying;
    setQueuedSlot(transportDeps, null);
    set('isPlaying')(0);
    if (wasPlaying) {
      requestAnimationFrame(() => set('isPlaying')(1));
    }
  }

  // ---------------- Test hooks (gated on testHooksEnabled) ----------------
  //
  // The Playwright suite drives MACSEQ via these globals — see
  // e2e/tests/macseq.spec.ts. The shape mirrors the DRUMSEQZ hooks so
  // anyone reading both tests sees one pattern.

  $effect(() => {
    if (!testHooksEnabled() || typeof window === 'undefined') return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    w.__macseqStepAt = (nodeId: string, step: number): MacseqStep | null => {
      const target = patch.nodes[nodeId];
      const raw = (target?.data as Record<string, unknown> | undefined)?.steps;
      const all = coerceSteps(raw);
      return all[step] ?? null;
    };
    w.__macseqSetStep = (
      nodeId: string,
      step: number,
      cell: { on?: boolean; midi?: number | null; model?: number | null },
    ) => {
      const target = patch.nodes[nodeId];
      if (!target) return false;
      const raw = (target.data as Record<string, unknown> | undefined)?.steps;
      const arr = coerceSteps(raw);
      const cur = arr[step] ?? { on: false, midi: null, model: null };
      arr[step] = {
        on: cell.on ?? cur.on,
        midi: 'midi' in cell ? (cell.midi ?? null) : cur.midi,
        model: 'model' in cell ? (cell.model ?? null) : cur.model,
      };
      ydoc.transact(() => {
        if (!target.data) target.data = {};
        (target.data as Record<string, unknown>).steps = arr.map((s) => ({
          on: s.on,
          midi: s.midi,
          model: s.model,
        }));
      });
      return true;
    };
    // Convenience: replace all 16 steps in one call. Used by the E2E to
    // program a multi-model pattern atomically.
    w.__macseqWriteAllSteps = (nodeId: string, arr: MacseqStep[]) => {
      const target = patch.nodes[nodeId];
      if (!target) return false;
      const canon = coerceSteps(arr);
      ydoc.transact(() => {
        if (!target.data) target.data = {};
        (target.data as Record<string, unknown>).steps = canon.map((s) => ({
          on: s.on,
          midi: s.midi,
          model: s.model,
        }));
      });
      return true;
    };
    w.__macseqModelNames = () => [...MODEL_NAMES];
  });

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
    { id: 'pitch',   label: 'PITCH',    cable: 'pitch' },
    { id: 'gate',    label: 'GATE',     cable: 'gate' },
    { id: 'modelcv', label: 'MODEL CV', cable: 'cv' },
    { id: 'clock',   label: 'CLOCK',    cable: 'gate' },
  ];

  // Default steps for when the data slot has not yet been populated. The
  // length check tolerates legacy short arrays — coerceSteps will pad them
  // out to STEP_COUNT on read.
  let displayedSteps = $derived(steps.length === STEP_COUNT ? steps : defaultSteps());
</script>

<div class="mod-card macseq-card">
  <div class="stripe" style="background: var(--cable-cv);"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="MACSEQ" inline />
    <button
      class="play-btn"
      class:playing={isPlaying}
      onclick={togglePlay}
      title={isPlaying ? 'Stop' : 'Play'}
      data-testid={`macseq-play-${id}`}
    >
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
        testIdPrefix={`macseq-${id}`}
        onUserPageChange={(p) => (userPage = p)}
        onHoldChange={(h) => (hold = h)}
      />
    </div>
    <div class="grid-area">
      <div class="grid" data-testid={`macseq-grid-${id}`}>
        {#each Array.from({ length: PAGE_SIZE }, (_, c) => pageStart + c) as i (i)}
          <div class="cell" data-step={i} class:active={i === currentStep && isPlaying}>
            <div class="step-num">{i + 1}</div>
            <NoteEntry
              midi={displayedSteps[i]?.midi ?? null}
              on={displayedSteps[i]?.on ?? false}
              isActive={i === currentStep && isPlaying}
              dim={i >= length}
              testId={`macseq-pitch-${id}-${i}`}
              gateTestId={`macseq-gate-${id}-${i}`}
              onCommit={(input) => commitPitch(i, input)}
              onGateToggle={() => toggleGate(i)}
            />
            <select
              class="model-select"
              data-testid={`macseq-model-${id}-${i}`}
              value={displayedSteps[i]?.model === null || displayedSteps[i]?.model === undefined
                ? ''
                : String(displayedSteps[i]!.model)}
              onchange={(e) => setStepModel(i, (e.currentTarget as HTMLSelectElement).value)}
            >
              <option value="">—</option>
              {#each MODEL_NAMES as name, idx (idx)}
                <option value={String(idx)}>{name}</option>
              {/each}
            </select>
          </div>
        {/each}
      </div>
    </div>

    <div class="fader-row">
      <Fader value={bpm}        min={30}  max={300}  defaultValue={120} label="BPM"  curve="linear"   onchange={set('bpm')} moduleId={id} paramId="bpm"        readLive={live('bpm')} />
      <Fader value={length}     min={1}   max={STEP_COUNT}  defaultValue={16}          label="Len"  curve="discrete" onchange={set('length')} moduleId={id} paramId="length"     readLive={live('length')} />
      <Fader value={octave}     min={-2}  max={2}    defaultValue={0}   label="Oct"  curve="discrete" onchange={set('octave')} moduleId={id} paramId="octave"     readLive={live('octave')} />
      <Fader value={gateLength} min={0.1} max={0.95} defaultValue={0.5} label="Gate" curve="linear"   onchange={set('gateLength')} moduleId={id} paramId="gateLength" readLive={live('gateLength')} />
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
  .macseq-card {
    width: 880px;
    padding-right: 0;
    padding-left: 0;
  }
  .macseq-card > .title {
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
    background: var(--cable-cv);
    color: #1a1d23;
    border-color: var(--cable-cv);
  }
  .grid-area {
    margin: 6px 22px 8px;
  }
  .page-nav-row {
    margin: 12px 22px 0;
    display: flex;
    justify-content: flex-end;
    align-items: center;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(16, 1fr);
    gap: 4px;
  }
  .cell {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    align-items: stretch;
  }
  .cell .step-num {
    font-size: 0.55rem;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    text-align: center;
  }
  .cell.active .step-num {
    color: var(--cable-cv);
  }
  .model-select {
    background: #14171c;
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    font-family: ui-monospace, monospace;
    font-size: 0.6rem;
    padding: 2px 0;
    height: 18px;
    outline: none;
    width: 100%;
    min-width: 0;
  }
  .model-select:focus-visible {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent);
  }
  .fader-row {
    margin-top: 6px;
    padding: 0 22px;
    gap: 8px;
    display: flex;
  }
</style>
