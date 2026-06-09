<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import Fader from '$lib/ui/controls/Fader.svelte';
  import NoteEntry from '$lib/ui/controls/NoteEntry.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import QuicksaveControls from '$lib/ui/QuicksaveControls.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch, ydoc } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import {
    defaultChordSteps,
    STEP_COUNT,
    coerceToChordStep,
    type ChordStep,
  } from '$lib/audio/modules/polyseqz';
  import SequencerPageNav from '$lib/ui/modules/SequencerPageNav.svelte';
  import {
    PAGE_SIZE,
    visiblePageFor,
    pageRange,
    ensureCapacity,
  } from '$lib/audio/modules/sequencer-pages';
  import {
    type ChordQualityName,
    type ChordInversion,
    type ChordVoicingName,
    nextChordQualityName,
    nextChordVoicingName,
    nextInversion,
  } from '$lib/audio/chord-tables';
  import { useEngine } from '$lib/audio/engine-context';
  import { parseNoteName } from '$lib/audio/note-entry';
  import { resolveArrowNav, type ArrowKey, type GridSpec } from '$lib/audio/grid-nav';
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

  let cardVersion = $state(0);
  $effect(() => {
    const h = () => { cardVersion = cardVersion + 1; };
    ydoc.on('update', h);
    return () => ydoc.off('update', h);
  });

  let bpm        = $derived((void cardVersion, node?.params.bpm        ?? 90));
  let length     = $derived((void cardVersion, node?.params.length     ?? 8));
  let octave     = $derived((void cardVersion, node?.params.octave     ?? 0));
  let gateLength = $derived((void cardVersion, node?.params.gateLength ?? 0.6));
  let humanize   = $derived((void cardVersion, node?.params.humanize   ?? 0));
  let isPlaying  = $derived((void cardVersion, (node?.params.isPlaying ?? 0) >= 0.5));

  // POLYSEQZ readers historically returned a variable-length array (mirrors
  // the persisted steps[] length verbatim). After pages-PR the card wants a
  // STEP_COUNT-wide capacity so the page-nav can address page 1..7 even on
  // freshly-loaded patches with shorter saved arrays.
  let steps = $derived.by<ChordStep[]>(() => {
    void cardVersion;
    const raw = (node?.data as Record<string, unknown> | undefined)?.steps;
    if (!Array.isArray(raw)) return defaultChordSteps();
    return ensureCapacity<ChordStep>(
      (raw as unknown[]).map(coerceToChordStep),
      () => coerceToChordStep(null),
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

  // Visual current step indicator polled from engine.
  let currentStep = $state(0);
  // Per-user view state. Local Svelte state — see sequencer-pages.ts.
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

  // Step mutation helpers.

  function readStepsCopy(): ChordStep[] {
    const t = patch.nodes[id];
    if (!t?.data) return defaultChordSteps();
    const raw = (t.data as Record<string, unknown>).steps;
    if (Array.isArray(raw)) return (raw as unknown[]).map(coerceToChordStep);
    return defaultChordSteps();
  }

  function writeSteps(arr: ChordStep[]) {
    const t = patch.nodes[id];
    if (!t) return;
    ydoc.transact(() => {
      if (!t.data) t.data = {};
      (t.data as Record<string, unknown>).steps = arr.map((s) => ({
        on: s.on,
        root: s.root,
        quality: s.quality,
        inversion: s.inversion,
        voicing: s.voicing,
      }));
    });
  }

  function commitRoot(i: number, input: string) {
    const arr = readStepsCopy();
    const cur = arr[i] ?? {
      on: false, root: null, quality: 'maj' as ChordQualityName,
      inversion: 0 as ChordInversion, voicing: 'closed' as ChordVoicingName,
    };
    const trimmed = input.trim();
    const parsed = trimmed === '' ? null : parseNoteName(trimmed);
    arr[i] = { ...cur, root: parsed };
    writeSteps(arr);
  }

  function toggleGate(i: number) {
    const arr = readStepsCopy();
    const cur = arr[i] ?? {
      on: false, root: null, quality: 'maj' as ChordQualityName,
      inversion: 0 as ChordInversion, voicing: 'closed' as ChordVoicingName,
    };
    arr[i] = { ...cur, on: !cur.on };
    writeSteps(arr);
  }

  function cycleQuality(i: number) {
    const arr = readStepsCopy();
    const cur = arr[i];
    if (!cur) return;
    arr[i] = { ...cur, quality: nextChordQualityName(cur.quality) };
    writeSteps(arr);
  }

  function cycleInversion(i: number) {
    const arr = readStepsCopy();
    const cur = arr[i];
    if (!cur) return;
    arr[i] = { ...cur, inversion: nextInversion(cur.inversion) };
    writeSteps(arr);
  }

  function cycleVoicing(i: number) {
    const arr = readStepsCopy();
    const cur = arr[i];
    if (!cur) return;
    arr[i] = { ...cur, voicing: nextChordVoicingName(cur.voicing) };
    writeSteps(arr);
  }

  // --- Keyboard navigation ---
  //
  // POLYSEQZ matches Sequencer/DRUMSEQZ/SCORE: arrow keys never move the caret
  // inside the pitch input; they navigate the focus grid. POLYSEQZ extends the
  // 2-role (gate/pitch) model with three extra roles for the per-step chord
  // sub-fields: quality, inversion, voicing. Up/Down cycles through all five
  // roles within a step (gate → pitch → quality → inversion → voicing);
  // Left/Right moves across steps in the same role.
  //
  // Why this model (not Tab-cycles-sub-fields, not Up/Down=root only):
  //   1. Keeps gate/pitch nav identical to Sequencer so muscle memory carries.
  //   2. Every chord sub-field is reachable from the keyboard without modifier
  //      keys (consistency with the click-to-cycle UI).
  //   3. Tab also still moves between steps in the same role (same as Sequencer).

  type PolyRole = 'gate' | 'pitch' | 'quality' | 'inversion' | 'voicing';
  const POLY_ROLES: readonly PolyRole[] = ['gate', 'pitch', 'quality', 'inversion', 'voicing'] as const;
  // The grid now renders one page (PAGE_SIZE columns). Keyboard nav stays
  // within the visible page — the < / > nav buttons are the page-cross UX.
  const NAV_SPEC: GridSpec<PolyRole> = { cols: PAGE_SIZE, cellRows: 1, roles: POLY_ROLES };

  let gridEl: HTMLElement | undefined = $state();

  function findCell(stepIdx: number, role: PolyRole): HTMLElement | null {
    if (!gridEl) return null;
    return gridEl.querySelector<HTMLElement>(
      `[data-step="${stepIdx}"] [data-role="${role}"]`,
    );
  }

  function focusCell(stepIdx: number, role: PolyRole): boolean {
    const target = findCell(stepIdx, role);
    if (!target) return false;
    target.focus();
    if (target.tagName === 'INPUT') (target as HTMLInputElement).select();
    return true;
  }

  function handleNav(e: KeyboardEvent, stepIdx: number, role: PolyRole): boolean {
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
      tick().then(() => focusCell(Math.min(maxStep, stepIdx + 1), 'pitch'));
      return true;
    }
    if (e.key === 'Tab') {
      const dir = e.shiftKey ? -1 : 1;
      const nextIdx = stepIdx + dir;
      if (nextIdx < minStep || nextIdx > maxStep) return false;
      return focusCell(nextIdx, role);
    }
    return false;
  }

  /** Keydown handler for the chord sub-field badges (quality / inversion /
   *  voicing). Space + Enter cycle the value (matching click semantics);
   *  arrow keys + Tab navigate via handleNav. */
  function onBadgeKeydown(
    e: KeyboardEvent,
    stepIdx: number,
    role: 'quality' | 'inversion' | 'voicing',
  ) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (role === 'quality')   cycleQuality(stepIdx);
      else if (role === 'inversion') cycleInversion(stepIdx);
      else                       cycleVoicing(stepIdx);
      return;
    }
    if (
      e.key === 'ArrowLeft' || e.key === 'ArrowRight' ||
      e.key === 'ArrowUp'   || e.key === 'ArrowDown' ||
      e.key === 'Tab'
    ) {
      const handled = handleNav(e, stepIdx, role);
      if (handled) e.preventDefault();
    }
  }

  function qualityLabel(q: ChordQualityName): string {
    // 4-char compact glyph for the badge. Lower-case for non-major qualities.
    const map: Record<ChordQualityName, string> = {
      maj: 'M', min: 'm',
      maj7: 'M7', min7: 'm7', dom7: '7',
      sus2: 's2', sus4: 's4',
      dim: 'o',  aug: '+',
    };
    return map[q] ?? q;
  }

  function voicingLabel(v: ChordVoicingName): string {
    return v === 'closed' ? 'C' : v === 'open' ? 'O' : 'S';
  }

  // ---------------- Quicksave + transport ----------------
  //
  // POLYSEQZ snapshot shape: per-step {root, quality, inversion, voicing}
  // array + length + bpm + octave + gateLength + humanize. We deep-clone
  // every step when applying a snapshot back to data.steps — without the
  // clone Yjs throws "reassigning object that already occurs in the tree"
  // because the snap usually still lives at slots[N] in the same Y.Doc.

  const transportDeps: TransportCardDeps = {
    nodeId: id,
    patch,
    transact: (fn) => ydoc.transact(fn),
    snapshot: (): Snapshot => {
      const t = patch.nodes[id];
      return {
        steps: readStepsCopy().map((s) => ({
          on: s.on,
          root: s.root,
          quality: s.quality,
          inversion: s.inversion,
          voicing: s.voicing,
        })),
        bpm: t?.params.bpm ?? 90,
        length: t?.params.length ?? 8,
        octave: t?.params.octave ?? 0,
        gateLength: t?.params.gateLength ?? 0.6,
        humanize: t?.params.humanize ?? 0,
      };
    },
    applySnapshot: (snap: Snapshot) => {
      const t = patch.nodes[id];
      if (!t) return;
      ydoc.transact(() => {
        if (Array.isArray(snap.steps)) {
          if (!t.data) t.data = {};
          // Coerce + deep-clone each step so the same Y-Map doesn't end up at
          // two paths in the Y.Doc tree (slots[N] AND data.steps).
          (t.data as Record<string, unknown>).steps = (snap.steps as unknown[]).map((s) => {
            const cs = coerceToChordStep(s);
            return {
              on: cs.on,
              root: cs.root,
              quality: cs.quality,
              inversion: cs.inversion,
              voicing: cs.voicing,
            };
          });
        }
        for (const k of ['bpm', 'length', 'octave', 'gateLength', 'humanize'] as const) {
          const v = snap[k];
          if (typeof v === 'number') t.params[k] = v;
        }
      });
    },
  };

  let slotsState = $derived((void cardVersion, readSlots(node)));
  let pendingMode = $derived<PendingMode>((void cardVersion, readPendingMode(node)));
  let queuedSlot = $derived<SlotKey | null>((void cardVersion, readQueuedSlot(node)));
  let lastLoadedSlot = $derived<SlotKey | null>((void cardVersion, readLastLoadedSlot(node)));

  function onSetMode(m: PendingMode) { setPendingMode(transportDeps, m); }
  function onSlotClick(k: SlotKey) { handleSlotClick(transportDeps, k); }
  function onPlayToggle() { togglePlay(); }
  function onReset() {
    // RESET clears any pending queue and forces step counter back to 0. The
    // engine resets stepIndex on a play=off→on transition, so toggle play
    // off (and back on if we were playing) to nudge the prev/cur edge.
    const wasPlaying = isPlaying;
    setQueuedSlot(transportDeps, null);
    set('isPlaying')(0);
    if (wasPlaying) requestAnimationFrame(() => set('isPlaying')(1));
  }

  const inputs: PortDescriptor[] = [
    { id: 'clock',       label: 'CLOCK IN', cable: 'gate' },
    // Shared transport CV — replaces the old POLYSEQZ play_cv (cv→param) +
    // reset_cv (gate). Same labels as Sequencer / DRUMSEQZ / SCORE for muscle
    // memory across modules.
    { id: 'play_cv',     label: 'PLAY GATE',    cable: 'gate' },
    { id: 'reset_cv',    label: 'RESET GATE',   cable: 'gate' },
    { id: 'queue1_cv',   label: 'PLAY QUEUE 1', cable: 'gate' },
    { id: 'queue2_cv',   label: 'PLAY QUEUE 2', cable: 'gate' },
    { id: 'queue3_cv',   label: 'PLAY QUEUE 3', cable: 'gate' },
    { id: 'queue4_cv',   label: 'PLAY QUEUE 4', cable: 'gate' },
    { id: 'humanize_cv', label: 'HUMAN CV',     cable: 'cv' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'poly',  label: 'POLY OUT',  cable: 'polyPitchGate' },
    { id: 'gate',  label: 'GATE',      cable: 'gate' },
    { id: 'clock', label: 'CLOCK OUT', cable: 'gate' },
  ];
</script>

<div class="mod-card poly-card">
  <div class="stripe" style="background: var(--cable-pitch);"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="POLYSEQZ" inline />
    <button
      class="play-btn"
      class:playing={isPlaying}
      onclick={togglePlay}
      data-testid={`polyseqz-play-${id}`}
      title={isPlaying ? 'Stop' : 'Play'}
    >{isPlaying ? '■' : '▶'}</button>
  </header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="page-nav-row">
      <SequencerPageNav
        length={length}
        currentStep={currentStep}
        userPage={userPage}
        hold={hold}
        testIdPrefix={`polyseqz-${id}`}
        onUserPageChange={(p) => (userPage = p)}
        onHoldChange={(h) => (hold = h)}
      />
    </div>
    <div class="grid" bind:this={gridEl} data-testid={`polyseqz-grid-${id}`}>
      {#each steps.slice(pageStart, pageStart + PAGE_SIZE) as step, c (pageStart + c)}
        {@const i = pageStart + c}
        <div class="cell-slot" data-step={i}>
          <div class="cell-num">{i + 1}</div>
          <NoteEntry
            midi={step.root}
            on={step.on}
            isActive={i === currentStep}
            dim={i >= length}
            testId={`polyseqz-root-${id}-${i}`}
            gateTestId={`polyseqz-gate-${id}-${i}`}
            onCommit={(input) => commitRoot(i, input)}
            onGateToggle={() => toggleGate(i)}
            onNavKey={(e) => {
              const role = (e.target as HTMLElement)?.dataset?.role === 'gate' ? 'gate' : 'pitch';
              return handleNav(e, i, role as PolyRole);
            }}
          />
          <button
            class="quality-badge"
            type="button"
            data-testid={`polyseqz-quality-${id}-${i}`}
            data-step={i}
            data-role="quality"
            data-quality={step.quality}
            title={`Quality: ${step.quality} (click or Space/Enter to cycle)`}
            onclick={() => cycleQuality(i)}
            onkeydown={(e) => onBadgeKeydown(e, i, 'quality')}
          >{qualityLabel(step.quality)}</button>
          <div class="meta-row">
            <button
              class="inv-badge"
              type="button"
              data-testid={`polyseqz-inv-${id}-${i}`}
              data-step={i}
              data-role="inversion"
              data-inversion={step.inversion}
              title={`Inversion: ${step.inversion} (click or Space/Enter to cycle)`}
              onclick={() => cycleInversion(i)}
              onkeydown={(e) => onBadgeKeydown(e, i, 'inversion')}
            >{step.inversion}</button>
            <button
              class="voicing-badge"
              type="button"
              data-testid={`polyseqz-voicing-${id}-${i}`}
              data-step={i}
              data-role="voicing"
              data-voicing={step.voicing}
              title={`Voicing: ${step.voicing} (click or Space/Enter to cycle)`}
              onclick={() => cycleVoicing(i)}
              onkeydown={(e) => onBadgeKeydown(e, i, 'voicing')}
            >{voicingLabel(step.voicing)}</button>
          </div>
        </div>
      {/each}
    </div>

    <div class="fader-row">
      <Fader value={bpm}        min={30}  max={300} defaultValue={90}  label="BPM"  curve="linear"   onchange={set('bpm')} moduleId={id} paramId="bpm"        readLive={live('bpm')} />
      <Fader value={length}     min={1}   max={128} defaultValue={8}   label="Len"  curve="discrete" onchange={set('length')} moduleId={id} paramId="length"     readLive={live('length')} />
      <Fader value={octave}     min={-2}  max={2}   defaultValue={0}   label="Oct"  curve="discrete" onchange={set('octave')} moduleId={id} paramId="octave"     readLive={live('octave')} />
      <Fader value={gateLength} min={0.1} max={0.95} defaultValue={0.6} label="Gate" curve="linear"  onchange={set('gateLength')} moduleId={id} paramId="gateLength" readLive={live('gateLength')} />
      <Fader value={humanize}   min={0}   max={1}   defaultValue={0}   label="Hum"  curve="linear"   onchange={set('humanize')} moduleId={id} paramId="humanize"   readLive={live('humanize')} />
    </div>

    <QuicksaveControls
      nodeId={id}
      slots={slotsState}
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
  .poly-card {
    width: 540px;
    padding-right: 0;
    padding-left: 0;
  }
  .poly-card > .title {
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
  .quality-badge {
    width: 100%;
    height: 14px;
    margin-top: 1px;
    background: #14171c;
    border: 1px solid var(--cable-pitch);
    border-radius: 2px;
    color: var(--cable-pitch);
    font-family: ui-monospace, monospace;
    font-size: 0.55rem;
    line-height: 1;
    padding: 0;
    cursor: pointer;
  }
  .quality-badge:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
  .meta-row {
    margin-top: 1px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
  }
  .inv-badge,
  .voicing-badge {
    height: 11px;
    background: #14171c;
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text-dim);
    font-family: ui-monospace, monospace;
    font-size: 0.5rem;
    line-height: 1;
    padding: 0;
    cursor: pointer;
  }
  .voicing-badge {
    color: #c084fc;
    border-color: #2a2f3a;
  }
  .fader-row {
    margin-top: 6px;
    padding: 0 22px;
    gap: 8px;
  }
</style>
