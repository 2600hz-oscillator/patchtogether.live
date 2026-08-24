<script lang="ts">
  // KRIA card — the standalone (no-grid) face of the KRIA grid sequencer.
  // A clean-room reimagining of monome Kria's UX: 4 tracks, a per-lane page
  // selector, a 16-step editor for the selected track+page, a 16-slot pattern
  // strip with quantized cueing, and BPM/RUN transport. A monome grid drives
  // the SAME edits via lib/control/monome/kria-grid (capability-gated).
  //
  // All ports live in the shared yellow drill-down <PatchPanel> (post-#767 hard
  // standard — NO raw side <Handle> jacks). Port ids are byte-identical to
  // kriaDef so the CV bridge + persisted edges route unchanged.
  //
  // ⚠ THIS CARD OWNS NO WRITE PATH AND NO ROW ARITHMETIC. Both moved out, and
  // the move is the point rather than tidiness:
  //   • every edit goes through `kria-writes.ts`, so it is origin-tagged
  //     (undoable) and GRANULAR (one step, not the whole pattern) — and the
  //     monome bridge, which had its own copy of both defects, now shares the
  //     same seam instead of a second implementation of it;
  //   • every row↔value decision comes from `kria-types.ts`'s lane model, which
  //     exists because this file used to state that mapping TWICE (a click
  //     handler and a lit test) and the two disagreed on the OCTAVE page.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { setNodeParam } from '$lib/graph/mutate';
  import { onMeterFrame } from '$lib/ui/meter-frame';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import { kriaDef } from '$lib/audio/modules/kria';
  import {
    activePattern,
    defaultPattern,
    slotOccupied,
    coerceTrack,
    coerceLane,
    applyLaneEdit,
    laneCellAriaLabel,
    laneRowActive,
    laneRowLit,
    KRIA_EDIT_ROWS,
    KRIA_LANES,
    KRIA_TRACKS,
    KRIA_STEPS,
    KRIA_PATTERNS,
    type KriaData,
    type KriaPattern,
    type KriaTrack,
  } from '$lib/audio/modules/kria-types';
  import {
    editKriaTrack,
    selectKriaPattern,
    selectKriaTrack,
    selectKriaLane,
    showKriaPatterns,
    readSelTrack,
  } from '$lib/audio/modules/kria-writes';
  // ⚠ THE SAME HELPERS THE FACEPLATE'S BAND CELLS CALL. Sharing them is what
  // keeps the card and the face from disagreeing about a roster, a clamp or a
  // write path — the two-surfaces-one-contract rule, applied before it can be
  // broken rather than after.
  import {
    kriaDirectionOptions,
    kriaDirectionValue,
    kriaLoopLengthOptions,
    kriaLoopLengthValue,
    kriaLoopStartOptions,
    kriaLoopStartValue,
    kriaMuteValue,
    kriaRootOptions,
    kriaRootValue,
    kriaScaleOptions,
    kriaScaleValue,
    kriaSetDirection,
    kriaSetLoopLength,
    kriaSetLoopStart,
    kriaSetMute,
    kriaSetRoot,
    kriaSetScale,
    kriaSetTimeDivision,
    kriaTimeDivisionOptions,
    kriaTimeDivisionValue,
  } from './kria-cell-actions';
  import ModuleTitle from './ModuleTitle.svelte';
  import {
    serialAvailable as gridSerialAvailable,
    connect as gridConnect,
    isConnected as gridIsConnected,
    connectedRune as gridConnectedRune,
  } from '$lib/control/monome/monome-device.svelte';
  import {
    bindGridToKria,
    unbindKriaGrid,
    boundKriaNode,
    bindingRune,
  } from '$lib/control/monome/kria-grid.svelte';
  import { portsFromDef } from './card-kit';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  // Monome grid — WebSerial connect + bind THIS KRIA to the grid.
  const gridSupported = gridSerialAvailable();
  let gridBoundHere = $derived((bindingRune(), gridConnectedRune(), boundKriaNode() === id));
  async function toggleGrid() {
    if (boundKriaNode() === id) {
      unbindKriaGrid();
      return;
    }
    const ok = await gridConnect();
    if (ok || gridIsConnected()) bindGridToKria(id);
  }

  // Node-scoped re-derive (phase-2 CC perf fix): subscribe to THIS node's
  // version from the shared registry (nodes.observeDeep) instead of a
  // per-component whole-doc ydoc.on('update') pump — a commit on another
  // module no longer re-runs this card's derived chain.
  let cardVersion = $derived(nodeVersion(id));

  function pdef(pid: string) {
    return kriaDef.params.find((p) => p.id === pid)!;
  }
  let bpm = $derived((void cardVersion, node?.params.bpm ?? pdef('bpm').defaultValue));
  let running = $derived((void cardVersion, (node?.params.running ?? 0) >= 0.5));

  function dataObj(): KriaData {
    return (node?.data ?? {}) as KriaData;
  }
  // ⚠ THE SELECTION LIVES IN node.data, not in component $state. A dock
  // collapse or an LRU eviction destroys this component (#1531 / #1574 / #1583)
  // and the faceplate's band cells read the selection from the node alone — a
  // cell's `value(node)` receives nothing else. It is written with a NON-tracked
  // origin, so navigating does not land on the Cmd-Z stack.
  let selTrack = $derived((void cardVersion, readSelTrack(dataObj())));
  let selLane = $derived((void cardVersion, coerceLane((dataObj() as { selLane?: string }).selLane)));
  let showPatterns = $derived(
    (void cardVersion, !!(dataObj() as { showPatterns?: boolean }).showPatterns),
  );

  let pattern = $derived.by<KriaPattern>(() => {
    void cardVersion;
    return activePattern(dataObj()) ?? defaultPattern();
  });
  let track = $derived.by<KriaTrack>(() => coerceTrack(pattern.tracks[selTrack]));
  let activeSlot = $derived((void cardVersion, dataObj().active ?? 0));
  let cuedSlot = $derived((void cardVersion, dataObj().cued ?? null));
  let occupied = $derived.by<boolean[]>(() => {
    void cardVersion;
    const d = dataObj();
    return Array.from({ length: KRIA_PATTERNS }, (_, i) => slotOccupied(d, i));
  });
  const setParam = (pid: string) => (v: number) => setNodeParam(id, pid, v);
  const readLive = (pid: string) => () => {
    const e = engineCtx.get();
    if (!e || !node) return undefined;
    return e.readParam(node, pid);
  };

  /** One grid cell click. `applyLaneEdit` returns null for an INERT row, and
   *  the seam then writes nothing at all — no undo entry for a dead click. */
  function onCell(step: number, row: number) {
    editKriaTrack(id, selTrack, (t) => applyLaneEdit(selLane, t, step, row));
  }

  // Playhead column (selected track) from the engine.
  //
  // ⚠ THE SHARED FRAME PUMP, and this card already imported it. It ran a
  // hand-rolled uncapped rAF beside an unused `onMeterFrame` import — the one
  // mechanism that exists to replace exactly that loop (~60 cards each running
  // their own rAF starves the audio render thread). It also ran while the
  // PATTERN view was showing, where there is no playhead to draw.
  let playStep = $state(-1);
  let gridEl = $state<HTMLElement | null>(null);
  $effect(() => {
    if (showPatterns) {
      playStep = -1;
      return;
    }
    const t = selTrack;
    const h = onMeterFrame(gridEl, () => {
      const e = engineCtx.get();
      if (!e || !node) return;
      const cs = e.read(node, `currentStep:${t}`);
      if (typeof cs === 'number') playStep = cs;
    });
    return () => h.stop();
  });

  const inputs = portsFromDef(kriaDef.inputs, { clock: 'CLOCK IN', reset: 'RESET IN' });
  const outputs = portsFromDef(kriaDef.outputs, {
    pitch1: 'PITCH 1', gate1: 'GATE 1', pitch2: 'PITCH 2', gate2: 'GATE 2',
    pitch3: 'PITCH 3', gate3: 'GATE 3', pitch4: 'PITCH 4', gate4: 'GATE 4',
  });
</script>

<div class="card audio kria-card" data-testid="kria-card">
  <div class="stripe"></div>
  <header class="title">
    <ModuleTitle {id} {data} defaultLabel="KRIA" inline />
    <span class="title-btns">
      <button
        class="run-btn"
        class:on={running}
        onclick={() => setParam('running')(running ? 0 : 1)}
        title="Play / stop (locks to TIMELORDE when present)"
        data-testid={`kria-run-${id}`}
      >{running ? '■' : '▶'}</button>
      <button
        class="grid-btn"
        class:on={gridBoundHere}
        disabled={!gridSupported}
        onclick={toggleGrid}
        title={!gridSupported
          ? 'monome grid needs WebSerial (Chromium only)'
          : gridBoundHere
            ? 'Disconnect monome grid'
            : 'Connect a monome grid to drive KRIA'}
        data-testid={`kria-grid-${id}`}
      >GRID</button>
    </span>
  </header>

  <PatchPanel nodeId={id} {inputs} {outputs}>
    <div class="body">
      <!-- Track + page selectors (Kria's nav row) -->
      <div class="selectors">
        <div class="track-sel" role="group" aria-label="track select">
          {#each Array(KRIA_TRACKS) as _t, t (t)}
            <button
              class="sel-btn track"
              class:active={selTrack === t}
              onclick={() => selectKriaTrack(id, t)}
              data-testid={`kria-track-${t}`}
              aria-label={`track ${t + 1}`}
              aria-pressed={selTrack === t}
            >{t + 1}</button>
          {/each}
        </div>
        <div class="page-sel" role="group" aria-label="page select">
          {#each KRIA_LANES as p (p.id)}
            <button
              class="sel-btn page"
              class:active={selLane === p.id && !showPatterns}
              onclick={() => selectKriaLane(id, p.id)}
              data-testid={`kria-page-${p.id}`}
              aria-pressed={selLane === p.id && !showPatterns}
            >{p.label}</button>
          {/each}
          <button
            class="sel-btn pat"
            class:active={showPatterns}
            onclick={() => showKriaPatterns(id, !showPatterns)}
            data-testid="kria-pattern-toggle"
            aria-pressed={showPatterns}
          >PAT</button>
        </div>
      </div>

      {#if showPatterns}
        <!-- Pattern slots (16) with quantized cueing -->
        <div class="patterns" data-testid="kria-patterns" role="grid" aria-label="pattern slots">
          {#each Array(KRIA_PATTERNS) as _s, s (s)}
            <button
              class="pat-slot"
              class:occupied={occupied[s]}
              class:active={activeSlot === s}
              class:cued={cuedSlot === s}
              role="gridcell"
              data-slot={s}
              aria-label={`pattern ${s + 1} — ${cuedSlot === s
                 ? 'cued'
                 : activeSlot === s
                   ? 'playing'
                   : occupied[s]
                     ? 'stored'
                     : 'empty'}`}
              onclick={() => selectKriaPattern(id, s)}
            >{s + 1}</button>
          {/each}
        </div>
      {:else}
        <!-- Step editor for the selected track + page -->
        <div
          class="step-grid"
          bind:this={gridEl}
          data-testid="kria-step-grid"
          role="grid"
          aria-label={`${selLane} editor track ${selTrack + 1}`}
        >
          {#each Array(KRIA_EDIT_ROWS) as _r, row (row)}
            <div class="grid-row" role="row">
              {#each Array(KRIA_STEPS) as _c, step (step)}
                <button
                  class="cell"
                  class:on={laneRowLit(selLane, track, step, row)}
                  class:inert={!laneRowActive(selLane, row)}
                  class:playhead={step === playStep}
                  role="gridcell"
                  data-step={step}
                  data-row={row}
                  data-testid={`kria-cell-${step}-${row}`}
                  aria-label={laneCellAriaLabel(selLane, track, step, row)}
                  aria-disabled={!laneRowActive(selLane, row)}
                  onclick={() => onCell(step, row)}
                ></button>
              {/each}
            </div>
          {/each}
        </div>
      {/if}

      <!-- PER-TRACK CONTROLS.
           ⚠ These are the controls the manifest's "fully usable from the card
           with a mouse" was describing and the card did not have: LOOP (start +
           length), TIME (division + direction) and MUTE were implemented in the
           engine, documented in `docs.controls`, and reachable from exactly ONE
           place — an attached monome grid over WebSerial.

           They read and write through the SAME helpers the faceplate's band
           cells call (`kria-cell-actions`), so the two surfaces cannot drift:
           one roster, one clamp, one write path. Their literal testids are also
           what `module-docs-lint` greps to prove each declared controlFamily
           exists. -->
      <div class="track-ctl" role="group" aria-label={`track ${selTrack + 1} controls`}>
        <label class="pick">
          <span class="cap">FROM</span>
          <select
            data-testid="kria-loop-start"
            aria-label="loop start step"
            value={kriaLoopStartValue(node)}
            onchange={(e) => kriaSetLoopStart(id, (e.currentTarget as HTMLSelectElement).value)}
          >
            {#each kriaLoopStartOptions() as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
          </select>
        </label>
        <label class="pick">
          <span class="cap">LEN</span>
          <select
            data-testid="kria-loop-length"
            aria-label="loop length"
            value={kriaLoopLengthValue(node)}
            onchange={(e) => kriaSetLoopLength(id, (e.currentTarget as HTMLSelectElement).value)}
          >
            {#each kriaLoopLengthOptions() as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
          </select>
        </label>
        <label class="pick">
          <span class="cap">DIV</span>
          <select
            data-testid="kria-time-division"
            aria-label="clock division"
            value={kriaTimeDivisionValue(node)}
            onchange={(e) => kriaSetTimeDivision(id, (e.currentTarget as HTMLSelectElement).value)}
          >
            {#each kriaTimeDivisionOptions() as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
          </select>
        </label>
        <label class="pick">
          <span class="cap">DIR</span>
          <select
            data-testid="kria-direction"
            aria-label="play direction"
            value={kriaDirectionValue(node)}
            onchange={(e) => kriaSetDirection(id, (e.currentTarget as HTMLSelectElement).value)}
          >
            {#each kriaDirectionOptions() as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
          </select>
        </label>
        <button
          class="sel-btn mute"
          class:active={kriaMuteValue(node)}
          data-testid="kria-mute"
          aria-label="mute track"
          aria-pressed={kriaMuteValue(node)}
          onclick={() => kriaSetMute(id, !kriaMuteValue(node))}
        >MUTE</button>
      </div>

      <!-- Transport + the pattern-level scale/root -->
      <div class="knob-row">
        <Knob value={bpm} min={pdef('bpm').min} max={pdef('bpm').max} defaultValue={pdef('bpm').defaultValue}
          label="BPM" curve="linear" onchange={setParam('bpm')} moduleId={id} paramId="bpm" readLive={readLive('bpm')} />
        <!-- SCALE was a read-only TEXT TAG: the card PRINTED the active scale
             and offered no way to change it, so the only editor for it was a
             monome grid. ROOT was not on the card at all. -->
        <label class="pick">
          <span class="cap">scale</span>
          <select
            data-testid="kria-scale"
            aria-label="scale"
            value={kriaScaleValue(node)}
            onchange={(e) => kriaSetScale(id, (e.currentTarget as HTMLSelectElement).value)}
          >
            {#each kriaScaleOptions() as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
          </select>
        </label>
        <label class="pick">
          <span class="cap">root</span>
          <select
            data-testid="kria-root"
            aria-label="root note"
            value={kriaRootValue(node)}
            onchange={(e) => kriaSetRoot(id, (e.currentTarget as HTMLSelectElement).value)}
          >
            {#each kriaRootOptions() as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
          </select>
        </label>
      </div>
    </div>
  </PatchPanel>
</div>

<style>
  .card {
    width: 420px;
    background: var(--module-bg);
    border: 1px solid var(--border);
    border-radius: 2px;
    color: var(--text);
    padding-top: 18px;
    padding-bottom: 14px;
    position: relative;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  :global(.svelte-flow__node:hover) .card { border-color: var(--accent-dim); }
  :global(.svelte-flow__node.selected) .card {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-glow), 0 2px 8px rgba(0, 0, 0, 0.3);
  }
  .stripe {
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
    border-radius: 2px 2px 0 0;
    background: var(--cable-pitch, var(--cable-audio));
  }
  .title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 10px 4px;
  }
  .title-btns { display: flex; align-items: center; gap: 4px; }
  .run-btn, .grid-btn {
    background: var(--control-bg, #222);
    color: var(--text-dim, #999);
    border: 1px solid var(--border);
    border-radius: 2px;
    font-size: 10px;
    line-height: 1;
    padding: 3px 6px;
    cursor: pointer;
  }
  .run-btn.on, .grid-btn.on { color: var(--accent, #6cf); border-color: var(--accent, #6cf); }
  .grid-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .body {
    margin-top: 24px;
    padding: 0 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .selectors { display: flex; justify-content: space-between; gap: 6px; }
  .track-sel, .page-sel { display: flex; gap: 2px; }
  .sel-btn {
    background: var(--control-bg, #222);
    color: var(--text-dim, #999);
    border: 1px solid var(--border);
    border-radius: 2px;
    font-size: 9px;
    padding: 3px 4px;
    cursor: pointer;
    min-width: 18px;
  }
  .sel-btn.active { color: var(--accent, #6cf); border-color: var(--accent, #6cf); background: #1c2630; }
  .step-grid { display: flex; flex-direction: column; gap: 2px; }
  .grid-row { display: flex; gap: 2px; }
  .cell {
    flex: 1;
    height: 11px;
    border: 1px solid var(--border);
    border-radius: 1px;
    background: #161616;
    cursor: pointer;
    padding: 0;
  }
  /* An INERT row is a row this lane has no value for (the octave page has six
     octaves and seven rows). It used to accept clicks and could never show the
     state it wrote. */
  .cell.inert {
    background: #0d0d0d;
    border-color: #1e1e1e;
    cursor: default;
  }
  .cell.on { background: var(--accent, #6cf); }
  .cell.playhead { border-color: var(--accent, #6cf); }
  .cell.on.playhead { background: var(--accent, #9df); }
  .patterns {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 3px;
  }
  .pat-slot {
    aspect-ratio: 1;
    border: 1px solid var(--border);
    border-radius: 2px;
    background: #1a1a1a;
    color: var(--text-dim, #777);
    font-size: 9px;
    cursor: pointer;
    padding: 0;
  }
  .pat-slot.occupied { background: #243; color: var(--text); }
  .pat-slot.active { background: var(--accent, #6f9); color: #000; box-shadow: 0 0 4px var(--accent-glow, #6f9); }
  .pat-slot.cued { background: var(--accent, #6c9); animation: blink 0.4s steps(2) infinite; }
  @keyframes blink { 50% { opacity: 0.35; } }
  .knob-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding-top: 4px;
  }
  .track-ctl {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    flex-wrap: wrap;
  }
  .sel-btn.mute { padding: 3px 5px; }
  .pick { display: flex; align-items: center; gap: 3px; }
  .cap { font-size: 9px; color: var(--text-dim, #999); }
  .pick select {
    background: var(--control-bg, #222);
    color: var(--text, #ddd);
    border: 1px solid var(--border);
    border-radius: 2px;
    font-size: 10px;
    padding: 2px 4px;
  }
</style>
