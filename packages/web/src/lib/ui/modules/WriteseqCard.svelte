<script lang="ts">
  // WriteseqCard — a RECORDING step-sequencer card. The base sequencer grid
  // (per-step note + gate toggle) PLUS a RECORD (arm) button and an OVERDUB
  // button. The cv/gate inputs are recorded into the nearest step while armed
  // and pass through live to the outputs at all times (see writeseq.ts).
  //
  // Layout:
  //   header   : title + PLAY/STOP + RECORD + OVERDUB
  //   grid     : PAGE_SIZE per-step cells (note entry + gate toggle)
  //   faders   : BPM / Len / Oct / Gate
  //   quicksave: 8-slot quicksave controls

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
    type WriteseqStep,
  } from '$lib/audio/modules/writeseq';
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
  let recArm     = $derived((void cardVersion, (node?.params.recArm   ?? 0) >= 0.5));
  let overdub    = $derived((void cardVersion, (node?.params.overdub  ?? 0) >= 0.5));

  let steps = $derived.by<WriteseqStep[]>(() => {
    void cardVersion;
    const raw = (node?.data as Record<string, unknown> | undefined)?.steps;
    return coerceSteps(raw);
  });

  const set = (k: string) => (v: number) => setNodeParam(id, k, v);

  function togglePlay() { set('isPlaying')(isPlaying ? 0 : 1); }
  function toggleRecArm() { set('recArm')(recArm ? 0 : 1); }
  function toggleOverdub() { set('overdub')(overdub ? 0 : 1); }

  const live = (k: string) => () => {
    const e = engineCtx.get();
    if (!e || !node) return undefined;
    return e.readParam(node, k);
  };

  // Visual playhead (sounding now, not next-to-be-scheduled) + record state.
  let currentStep = $state(0);
  let recordingActive = $state(false);
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
        const ra = e.read(node, 'recordingActive');
        if (typeof ra === 'number') recordingActive = ra >= 0.5;
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

  function readStepsCopy(): WriteseqStep[] {
    const t = patch.nodes[id];
    const raw = (t?.data as Record<string, unknown> | undefined)?.steps;
    return coerceSteps(raw);
  }

  function writeSteps(arr: WriteseqStep[]) {
    const target = patch.nodes[id];
    if (!target) return;
    ydoc.transact(() => {
      if (!target.data) target.data = {};
      (target.data as Record<string, unknown>).steps = arr.map((s) =>
        s.shift !== undefined
          ? { on: s.on, midi: s.midi, shift: s.shift }
          : { on: s.on, midi: s.midi },
      );
    });
  }

  function toggleGate(i: number) {
    const arr = readStepsCopy();
    const cur = arr[i] ?? { on: false, midi: null };
    arr[i] = cur.shift !== undefined
      ? { on: !cur.on, midi: cur.midi, shift: cur.shift }
      : { on: !cur.on, midi: cur.midi };
    writeSteps(arr);
  }
  function commitPitch(i: number, input: string) {
    const arr = readStepsCopy();
    const cur = arr[i] ?? { on: false, midi: null };
    const trimmed = input.trim();
    const parsed = trimmed === '' ? null : parseNoteName(trimmed);
    arr[i] = cur.shift !== undefined
      ? { on: cur.on, midi: parsed, shift: cur.shift }
      : { on: cur.on, midi: parsed };
    writeSteps(arr);
  }

  // ---------------- Quicksave + transport ----------------
  //
  // Parity with the base Sequencer's 8-slot quicksave. The snapshot captures
  // WRITESEQ's per-step {on, midi} grid + bpm/length/octave/gateLength.

  const transportDeps: TransportCardDeps = {
    nodeId: id,
    patch,
    transact: (fn) => ydoc.transact(fn),
    snapshot: (): Snapshot => {
      const t = patch.nodes[id];
      return {
        steps: readStepsCopy().map((s) => ({ on: s.on, midi: s.midi })),
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
          (t.data as Record<string, unknown>).steps = coerceSteps(snap.steps).map((s) => ({
            on: s.on,
            midi: s.midi,
          }));
        }
        for (const k of ['bpm', 'length', 'octave', 'gateLength'] as const) {
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
    const wasPlaying = isPlaying;
    setQueuedSlot(transportDeps, null);
    set('isPlaying')(0);
    if (wasPlaying) {
      requestAnimationFrame(() => set('isPlaying')(1));
    }
  }

  // ---------------- Test hooks (gated on testHooksEnabled) ----------------
  //
  // The Playwright suite drives WRITESEQ via these globals — see
  // e2e/tests/writeseq.spec.ts. Shape mirrors the MACSEQ hooks.

  $effect(() => {
    if (!testHooksEnabled() || typeof window === 'undefined') return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    w.__writeseqStepAt = (nodeId: string, step: number): WriteseqStep | null => {
      const target = patch.nodes[nodeId];
      const raw = (target?.data as Record<string, unknown> | undefined)?.steps;
      const all = coerceSteps(raw);
      return all[step] ?? null;
    };
    w.__writeseqSetStep = (
      nodeId: string,
      step: number,
      cell: { on?: boolean; midi?: number | null },
    ) => {
      const target = patch.nodes[nodeId];
      if (!target) return false;
      const raw = (target.data as Record<string, unknown> | undefined)?.steps;
      const arr = coerceSteps(raw);
      const cur = arr[step] ?? { on: false, midi: null };
      arr[step] = {
        on: cell.on ?? cur.on,
        midi: 'midi' in cell ? (cell.midi ?? null) : cur.midi,
      };
      ydoc.transact(() => {
        if (!target.data) target.data = {};
        (target.data as Record<string, unknown>).steps = arr.map((s) => ({ on: s.on, midi: s.midi }));
      });
      return true;
    };
  });

  const inputs: PortDescriptor[] = [
    { id: 'cv',    label: 'CV IN',      cable: 'pitch' },
    { id: 'gate',  label: 'GATE IN',    cable: 'gate' },
    { id: 'clock', label: 'CLOCK IN',   cable: 'gate' },
    { id: 'rec',   label: 'REC GATE',   cable: 'gate' },
    { id: 'play_cv',   label: 'PLAY GATE',    cable: 'gate' },
    { id: 'reset_cv',  label: 'RESET GATE',   cable: 'gate' },
    { id: 'queue1_cv', label: 'PLAY QUEUE 1', cable: 'gate' },
    { id: 'queue2_cv', label: 'PLAY QUEUE 2', cable: 'gate' },
    { id: 'queue3_cv', label: 'PLAY QUEUE 3', cable: 'gate' },
    { id: 'queue4_cv', label: 'PLAY QUEUE 4', cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'pitch', label: 'PITCH', cable: 'pitch' },
    { id: 'gate',  label: 'GATE',  cable: 'gate' },
    { id: 'clock', label: 'CLOCK', cable: 'gate' },
  ];

  let displayedSteps = $derived(steps.length === STEP_COUNT ? steps : defaultSteps());
</script>

<div class="mod-card writeseq-card">
  <div class="stripe" style="background: var(--cable-gate);"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="WRITESEQ" inline />
    <button
      class="play-btn"
      class:playing={isPlaying}
      onclick={togglePlay}
      title={isPlaying ? 'Stop' : 'Play'}
      data-testid={`writeseq-play-${id}`}
    >
      {isPlaying ? '■' : '▶'}
    </button>
    <button
      class="rec-btn nodrag"
      class:on={recArm}
      class:armed={recordingActive}
      onclick={toggleRecArm}
      data-testid={`writeseq-record-${id}`}
      title={recordingActive
        ? 'Recording NOW'
        : 'RECORD: arm; an incoming gate (or play-from-start) records the nearest step'}
    >{recordingActive ? '◉ REC' : 'REC'}</button>
    <button
      class="ovd-btn nodrag"
      class:on={overdub}
      onclick={toggleOverdub}
      data-testid={`writeseq-overdub-${id}`}
      title="OVERDUB: keep looping + layer newly-recorded events on top"
    >OVD</button>
  </header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="page-nav-row">
      <SequencerPageNav
        length={length}
        currentStep={currentStep}
        userPage={userPage}
        hold={hold}
        testIdPrefix={`writeseq-${id}`}
        onUserPageChange={(p) => (userPage = p)}
        onHoldChange={(h) => (hold = h)}
      />
    </div>
    <div class="grid-area">
      <div class="grid" data-testid={`writeseq-grid-${id}`}>
        {#each Array.from({ length: PAGE_SIZE }, (_, c) => pageStart + c) as i (i)}
          <div class="cell" data-step={i} class:active={i === currentStep && isPlaying}>
            <div class="step-num">{i + 1}</div>
            <NoteEntry
              midi={displayedSteps[i]?.midi ?? null}
              on={displayedSteps[i]?.on ?? false}
              isActive={i === currentStep && isPlaying}
              dim={i >= length}
              testId={`writeseq-pitch-${id}-${i}`}
              gateTestId={`writeseq-gate-${id}-${i}`}
              onCommit={(input) => commitPitch(i, input)}
              onGateToggle={() => toggleGate(i)}
            />
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
  .writeseq-card {
    width: 880px;
    padding-right: 0;
    padding-left: 0;
  }
  .writeseq-card > .title {
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
  .rec-btn, .ovd-btn {
    height: 22px;
    padding: 0 8px;
    background: #2a2f3a;
    border: 1px solid #404652;
    color: var(--text);
    border-radius: 3px;
    font-size: 0.6rem;
    font-family: ui-monospace, monospace;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
  }
  .rec-btn.on  { background: #ff3030; color: #fff; border-color: #ff3030; }
  .rec-btn.armed { animation: pulse 0.5s steps(2) infinite; }
  .ovd-btn.on  { background: #ff8800; color: #000; border-color: #ff8800; }
  @keyframes pulse {
    0%   { opacity: 1; }
    100% { opacity: 0.4; }
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
    color: var(--cable-gate);
  }
  .fader-row {
    margin-top: 6px;
    padding: 0 22px;
    gap: 8px;
    display: flex;
  }
</style>
