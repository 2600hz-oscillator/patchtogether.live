<script lang="ts">
  // KRIA card — the standalone (no-grid) face of the KRIA grid sequencer.
  // A clean-room reimagining of monome Kria's UX: 4 tracks, a TRIG/NOTE/OCTAVE/
  // DURATION page selector, a 16-step editor for the selected track+page, a
  // 16-slot pattern strip with quantized cueing, and BPM/RUN transport. A
  // monome grid drives the SAME edits via lib/grid/kria-grid (capability-gated).
  //
  // All ports live in the shared yellow drill-down <PatchPanel> (post-#767 hard
  // standard — NO raw side <Handle> jacks). Port ids are byte-identical to
  // kriaDef so the CV bridge + persisted edges route unchanged.
  import type { NodeProps } from '@xyflow/svelte';
  import Knob from '$lib/ui/controls/Knob.svelte';
  import PatchPanel from '$lib/ui/PatchPanel.svelte';
  import type { PortDescriptor } from '$lib/ui/patch-panel-labels';
  import { patch, ydoc } from '$lib/graph/store';
  import { setNodeParam } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import { kriaDef } from '$lib/audio/modules/kria';
  import {
    activePattern,
    defaultKriaData,
    defaultPattern,
    slotOccupied,
    coerceTrack,
    toggleTrig,
    setNote,
    setOctave,
    setDuration,
    KRIA_TRACKS,
    KRIA_STEPS,
    KRIA_PATTERNS,
    type KriaData,
    type KriaPattern,
    type KriaPatternBank,
    type KriaTrack,
  } from '$lib/audio/modules/kria-types';
  import ModuleTitle from './ModuleTitle.svelte';
  import {
    serialAvailable as gridSerialAvailable,
    connect as gridConnect,
    isConnected as gridIsConnected,
    connectedRune as gridConnectedRune,
  } from '$lib/grid/grid-device.svelte';
  import {
    bindGridToKria,
    unbindKriaGrid,
    boundKriaNode,
    bindingRune,
  } from '$lib/grid/kria-grid.svelte';

  let { id, data }: NodeProps = $props();
  let node = $derived(data?.node as ModuleNode);
  const engineCtx = useEngine();

  type Page = 'trig' | 'note' | 'octave' | 'duration';
  const PAGES: { id: Page; label: string }[] = [
    { id: 'trig', label: 'TRG' },
    { id: 'note', label: 'NTE' },
    { id: 'octave', label: 'OCT' },
    { id: 'duration', label: 'DUR' },
  ];
  let selTrack = $state(0);
  let selPage = $state<Page>('trig');
  let showPatterns = $state(false);

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

  let cardVersion = $state(0);
  $effect(() => {
    const h = () => { cardVersion = cardVersion + 1; };
    ydoc.on('update', h);
    return () => ydoc.off('update', h);
  });

  function pdef(pid: string) {
    return kriaDef.params.find((p) => p.id === pid)!;
  }
  let bpm = $derived((void cardVersion, node?.params.bpm ?? pdef('bpm').defaultValue));
  let running = $derived((void cardVersion, (node?.params.running ?? 0) >= 0.5));

  function dataObj(): KriaData {
    return (node?.data ?? {}) as KriaData;
  }
  let pattern = $derived.by<KriaPattern>(() => {
    void cardVersion;
    return activePattern(dataObj()) ?? defaultPattern();
  });
  let track = $derived.by<KriaTrack>(() => pattern.tracks[selTrack] ?? pattern.tracks[0]!);
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

  function writeData(mut: (d: KriaData) => void) {
    const target = patch.nodes[id];
    if (!target) return;
    ydoc.transact(() => {
      if (!target.data) target.data = { ...defaultKriaData() } as Record<string, unknown>;
      mut(target.data as KriaData);
    });
  }

  /** Replace the active pattern's selected track with a NEW track (deep-cloned
   *  so we never reassign a live Y type at two paths). */
  function commitTrack(next: KriaTrack) {
    writeData((d) => {
      if (!d.patterns || typeof d.patterns !== 'object') d.patterns = {} as KriaPatternBank;
      const slot = d.active ?? 0;
      const base = activePattern(d) ?? defaultPattern();
      const tracks = base.tracks.map((tr, i) =>
        i === selTrack ? cloneTrack(next) : cloneTrack(coerceTrack(tr)),
      );
      d.patterns[String(slot)] = { scale: base.scale, root: base.root, tracks };
    });
  }
  function cloneTrack(t: KriaTrack): KriaTrack {
    return {
      trig: t.trig.slice(), ratchet: t.ratchet.slice(), note: t.note.slice(),
      octave: t.octave.slice(), duration: t.duration.slice(),
      probability: t.probability.slice(), glide: t.glide.slice(),
      loopStart: t.loopStart, loopLength: t.loopLength,
      timeDivision: t.timeDivision, direction: t.direction, muted: t.muted,
    };
  }

  // --- Step-grid editing per page ---
  // Editor uses 7 rows. Each page interprets a click differently.
  const EDIT_ROWS = 7;
  function onCell(step: number, row: number) {
    // row 0 = top, row 6 = bottom.
    switch (selPage) {
      case 'trig':
        commitTrack(toggleTrig(track, step));
        break;
      case 'note': {
        const degree = EDIT_ROWS - 1 - row; // bottom row = degree 0
        commitTrack(setNote(track, step, degree));
        break;
      }
      case 'octave': {
        const oct = Math.min(5, EDIT_ROWS - 1 - row); // bottom = +0
        commitTrack(setOctave(track, step, oct));
        break;
      }
      case 'duration': {
        const filled = row + 1; // top row = shortest, lower = longer
        commitTrack(setDuration(track, step, filled / EDIT_ROWS));
        break;
      }
    }
  }
  /** Is cell (step,row) lit for the current page? */
  function cellOn(step: number, row: number): boolean {
    switch (selPage) {
      case 'trig':
        return row === EDIT_ROWS - 1 && track.trig[step]!;
      case 'note': {
        // Bottom row (row 6) = degree 0; the 7-row editor caps at degree 6.
        const deg = Math.max(0, Math.min(EDIT_ROWS - 1, track.note[step] ?? 0));
        return EDIT_ROWS - 1 - row === deg;
      }
      case 'octave': {
        const oct = Math.min(5, track.octave[step] ?? 0);
        return EDIT_ROWS - 1 - row <= oct;
      }
      case 'duration': {
        const filled = Math.max(1, Math.round((track.duration[step] ?? 0.5) * EDIT_ROWS));
        return row < filled;
      }
    }
  }

  function selectPattern(slot: number) {
    writeData((d) => {
      if (!d.patterns || typeof d.patterns !== 'object') d.patterns = {} as KriaPatternBank;
      if (!slotOccupied(d, slot)) {
        // Empty slot → seed a fresh pattern and activate it immediately.
        d.patterns[String(slot)] = defaultPattern();
        d.active = slot;
        d.cued = null;
        return;
      }
      if ((d.active ?? 0) === slot) {
        d.cued = null; // re-tap active clears a cue
      } else {
        d.cued = slot; // cue → quantized switch in the engine
      }
    });
  }

  // Playhead column (selected track) from the engine.
  let playStep = $state(-1);
  $effect(() => {
    let raf = 0;
    const frame = () => {
      const e = engineCtx.get();
      if (e && node) {
        const cs = e.read(node, `currentStep:${selTrack}`);
        if (typeof cs === 'number') playStep = cs;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  });

  const inputs: PortDescriptor[] = [
    { id: 'clock', label: 'CLOCK IN', cable: 'gate' },
    { id: 'reset', label: 'RESET IN', cable: 'gate' },
  ];
  const outputs: PortDescriptor[] = [
    { id: 'pitch1', label: 'PITCH 1', cable: 'pitch' },
    { id: 'gate1', label: 'GATE 1', cable: 'gate' },
    { id: 'pitch2', label: 'PITCH 2', cable: 'pitch' },
    { id: 'gate2', label: 'GATE 2', cable: 'gate' },
    { id: 'pitch3', label: 'PITCH 3', cable: 'pitch' },
    { id: 'gate3', label: 'GATE 3', cable: 'gate' },
    { id: 'pitch4', label: 'PITCH 4', cable: 'pitch' },
    { id: 'gate4', label: 'GATE 4', cable: 'gate' },
  ];
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
              onclick={() => (selTrack = t)}
              data-testid={`kria-track-${t}`}
              aria-label={`track ${t + 1}`}
            >{t + 1}</button>
          {/each}
        </div>
        <div class="page-sel" role="group" aria-label="page select">
          {#each PAGES as p (p.id)}
            <button
              class="sel-btn page"
              class:active={selPage === p.id && !showPatterns}
              onclick={() => { selPage = p.id; showPatterns = false; }}
              data-testid={`kria-page-${p.id}`}
            >{p.label}</button>
          {/each}
          <button
            class="sel-btn pat"
            class:active={showPatterns}
            onclick={() => (showPatterns = !showPatterns)}
            data-testid="kria-pattern-toggle"
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
              aria-label={`pattern ${s + 1}`}
              onclick={() => selectPattern(s)}
            >{s + 1}</button>
          {/each}
        </div>
      {:else}
        <!-- Step editor for the selected track + page -->
        <div class="step-grid" data-testid="kria-step-grid" role="grid" aria-label={`${selPage} editor track ${selTrack + 1}`}>
          {#each Array(EDIT_ROWS) as _r, row (row)}
            <div class="grid-row" role="row">
              {#each Array(KRIA_STEPS) as _c, step (step)}
                <button
                  class="cell"
                  class:on={cellOn(step, row)}
                  class:playhead={step === playStep}
                  role="gridcell"
                  data-step={step}
                  data-row={row}
                  aria-label={`step ${step} row ${row}`}
                  onclick={() => onCell(step, row)}
                ></button>
              {/each}
            </div>
          {/each}
        </div>
      {/if}

      <!-- Transport -->
      <div class="knob-row">
        <Knob value={bpm} min={pdef('bpm').min} max={pdef('bpm').max} defaultValue={pdef('bpm').defaultValue}
          label="BPM" curve="linear" onchange={setParam('bpm')} moduleId={id} paramId="bpm" readLive={readLive('bpm')} />
        <span class="scale-tag" data-testid="kria-scale">scale: {pattern.scale}</span>
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
  .selectors { display: flex; justify-content: space-between; gap: 8px; }
  .track-sel, .page-sel { display: flex; gap: 3px; }
  .sel-btn {
    background: var(--control-bg, #222);
    color: var(--text-dim, #999);
    border: 1px solid var(--border);
    border-radius: 2px;
    font-size: 9px;
    padding: 3px 5px;
    cursor: pointer;
    min-width: 20px;
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
  .scale-tag { font-size: 10px; color: var(--text-dim, #999); }
</style>
