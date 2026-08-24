<script lang="ts">
  // KriaGridPanel — kria's step editor as a PF-14 panel cell.
  //
  // ⚠ WHY A PANEL AND NOT A SHELL EXTENSION, because the spec left it open and
  // the ladder says take the earliest rung that fits. A 7×16 step grid is "ONE
  // picture-you-edit inside the generic face", which is rung 2's description
  // almost word for word. Both of kria's views fit here, so this module ships
  // NO `face.extension` at all — no lazy chunk, no new render site, and the
  // clicked-grid half of the sequencer cohort turns out to need no platform
  // seam whatsoever.
  //
  // ⚠ AND WHY IT IS `face.hero.cell`. A panel declares its own `minWidth` and a
  // lane knob column is 46 px, so `module-face-lint` refuses a panel SELECTED
  // at a lane tier — which used to mean a panel's first legal rank was 7, a
  // floor kria could never reach (two params + one family = three rankable
  // keys). PF-22 is exactly that fix: `laneOrder` drops `face.hero.cell`, so a
  // hero picture costs no lane rank and MAY rank first. kria is named in
  // PF-22's own doc comment as one of the two modules the old arithmetic
  // excluded from having a faceplate at all; this is that comment being
  // discharged.
  //
  // ⚠ NO RESTING DERIVED TEXT. Every string here is a control CAPTION or an
  // option NAME (track numbers, lane tags, slot numbers) — never a value, a
  // measurement or a state word. Per-step state lives in the cell's ACCESSIBLE
  // NAME via `laneCellAriaLabel` — speakable, assertable, unpainted — which is
  // what the face specs read. (Not `aria-valuetext`: that is only meaningful on
  // a RANGE role and these cells are `role="gridcell"`. Panels have no
  // resting-text roster gate, so this complies with the rule by construction
  // rather than because something checks it.)
  //
  // ⚠ NO `control-<paramId>` TESTID (shell-cells rule 1) — everything this
  // panel edits is `node.data`, which is precisely why it is a panel.
  //
  // ⚠ DOM, NOT CANVAS. 112 <button>s keep the accessible names, hit-testing and
  // focus for free — and a WebGL surface would enrol this module in the attest
  // basis (rule 2 is derived from CONTENT), making every future edit here cost
  // a real-GPU re-attest window. kria costs ZERO attest today.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { onMeterFrame } from '$lib/ui/meter-frame';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import {
    activePattern,
    coerceLane,
    coerceTrack,
    defaultPattern,
    slotOccupied,
    applyLaneEdit,
    laneCellAriaLabel,
    laneRowActive,
    laneRowLit,
    KRIA_EDIT_ROWS,
    KRIA_LANES,
    KRIA_PATTERNS,
    KRIA_STEPS,
    KRIA_TRACKS,
    type KriaData,
    type KriaPattern,
    type KriaTrack,
  } from '$lib/audio/modules/kria-types';
  import {
    editKriaTrack,
    readSelTrack,
    selectKriaLane,
    selectKriaPattern,
    selectKriaTrack,
    showKriaPatterns,
  } from '$lib/audio/modules/kria-writes';
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

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();
  let live = $derived.by(() => ({ v: nodeVersion(nodeId), n: patch.nodes[nodeId] as ModuleNode | undefined }));
  let dataObj = $derived((live.n?.data ?? {}) as KriaData);

  let selTrack = $derived(readSelTrack(dataObj));
  let selLane = $derived(coerceLane((dataObj as { selLane?: string }).selLane));
  let showPatterns = $derived(!!(dataObj as { showPatterns?: boolean }).showPatterns);

  let pattern = $derived.by<KriaPattern>(() => activePattern(dataObj) ?? defaultPattern());
  let track = $derived.by<KriaTrack>(() => coerceTrack(pattern.tracks[selTrack]));
  let activeSlot = $derived(dataObj.active ?? 0);
  let cuedSlot = $derived(dataObj.cued ?? null);
  let occupied = $derived.by<boolean[]>(() =>
    Array.from({ length: KRIA_PATTERNS }, (_, i) => slotOccupied(dataObj, i)),
  );

  // ⚠ THE HARDWARE GESTURE LIVES INSIDE THE PANEL, and that is a decision the
  // loopback face made first (its ACQUIRE is in a module-owned surface for the
  // same reason). A monome connect is an ACTION whose observable is a WebSerial
  // port — and `faces-parity` drives every declared `action` CELL unconditionally
  // and demands a real effect, which on a runner with no WebSerial can never
  // happen. Declaring it as a cell would therefore red the sweep in the one
  // environment that gates. Inside the panel the affordance is preserved for a
  // player with hardware and the sweep is not asked a question the machine
  // cannot answer.
  const gridSupported = gridSerialAvailable();
  let gridBoundHere = $derived((bindingRune(), gridConnectedRune(), boundKriaNode() === nodeId));
  async function toggleGrid() {
    if (boundKriaNode() === nodeId) {
      unbindKriaGrid();
      return;
    }
    const ok = await gridConnect();
    if (ok || gridIsConnected()) bindGridToKria(nodeId);
  }

  function onCell(step: number, row: number) {
    editKriaTrack(nodeId, selTrack, (t) => applyLaneEdit(selLane, t, step, row));
  }

  // The playhead, on the SHARED frame pump (never a private rAF), and only
  // while the step view is on screen — there is no playhead to draw over the
  // pattern strip. `useEngine` degrades to a null getter when the shell has not
  // provided the context, so this simply does not move rather than throwing.
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
      const n = patch.nodes[nodeId] as ModuleNode | undefined;
      if (!e || !n) return;
      const cs = e.read(n, `currentStep:${t}`);
      if (typeof cs === 'number') playStep = cs;
    });
    return () => h.stop();
  });
</script>

<div class="kria-panel" data-testid="kria-grid-panel">
  <div class="nav">
    <div class="track-sel" role="group" aria-label="track select">
      {#each Array(KRIA_TRACKS) as _t, t (t)}
        <button
          class="sel-btn"
          class:active={selTrack === t}
          onclick={() => selectKriaTrack(nodeId, t)}
          data-testid={`kria-track-${t}`}
          aria-label={`track ${t + 1}`}
          aria-pressed={selTrack === t}
        >{t + 1}</button>
      {/each}
    </div>

    <div class="page-sel" role="group" aria-label="lane select">
      {#each KRIA_LANES as p (p.id)}
        <button
          class="sel-btn"
          class:active={selLane === p.id && !showPatterns}
          onclick={() => selectKriaLane(nodeId, p.id)}
          data-testid={`kria-page-${p.id}`}
          aria-label={`${p.id} lane`}
          aria-pressed={selLane === p.id && !showPatterns}
        >{p.label}</button>
      {/each}
      <button
        class="sel-btn"
        class:active={showPatterns}
        onclick={() => showKriaPatterns(nodeId, !showPatterns)}
        data-testid="kria-pattern-toggle"
        aria-label="pattern slots"
        aria-pressed={showPatterns}
      >PAT</button>
    </div>

    <button
      class="sel-btn grid-btn"
      class:active={gridBoundHere}
      disabled={!gridSupported}
      onclick={toggleGrid}
      data-testid="kria-grid-connect"
      aria-label="connect a monome grid"
      aria-pressed={gridBoundHere}
      title={!gridSupported
        ? 'monome grid needs WebSerial (Chromium only)'
        : gridBoundHere
          ? 'Disconnect monome grid'
          : 'Connect a monome grid to drive KRIA'}
    >GRID</button>
  </div>

  {#if showPatterns}
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
          onclick={() => selectKriaPattern(nodeId, s)}
        >{s + 1}</button>
      {/each}
    </div>
  {:else}
    <div
      class="step-grid"
      bind:this={gridEl}
      data-testid="kria-step-grid"
      role="grid"
      aria-label={`${selLane} lane, track ${selTrack + 1}`}
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
</div>

<style>
  .kria-panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
  }
  .nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    flex-wrap: wrap;
  }
  .track-sel, .page-sel { display: flex; gap: 2px; }
  .sel-btn {
    background: var(--control-bg, #222);
    color: var(--text-dim, #999);
    border: 1px solid var(--border);
    border-radius: 2px;
    font-size: 9px;
    line-height: 1;
    padding: 3px 4px;
    cursor: pointer;
    min-width: 18px;
  }
  .sel-btn.active { color: var(--accent, #6cf); border-color: var(--accent, #6cf); background: #1c2630; }
  .grid-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .step-grid { display: flex; flex-direction: column; gap: 2px; }
  .grid-row { display: flex; gap: 2px; }
  .cell {
    flex: 1;
    min-width: 0;
    height: 12px;
    border: 1px solid var(--border);
    border-radius: 1px;
    background: #161616;
    cursor: pointer;
    padding: 0;
  }
  /* An INERT row is one this lane has no value for — the octave lane has six
     octaves and the grid has seven rows. It used to take clicks and could never
     show the state it wrote. */
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
</style>
