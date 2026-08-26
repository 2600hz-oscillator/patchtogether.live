<script lang="ts">
  // NumpadStepGrid — NUMPAD+'s sixteen steps as a PF-14 panel cell, promoted
  // into the dock's hero slot.
  //
  // ⚠ WHY A PANEL AND NOT A SHELL EXTENSION. The ladder says take the earliest
  // rung that fits, and a 4x4 step grid is "ONE picture-you-edit inside the
  // generic face" — rung 2's description almost word for word, and the call
  // `KriaGridPanel` already made for the same cohort. So this module ships NO
  // `face.extension`: no lazy chunk, no new render site, no platform PR.
  //
  // ⚠ DOM, NOT CANVAS. Sixteen <button>s keep the accessible names, hit-testing
  // and focus for free — and a WebGL surface would enrol numpadPlus in the
  // attest basis, making every future edit here cost a real-GPU re-attest
  // window. numpadPlus costs ZERO attest today (measured: the basis holds
  // exactly two files under audio/modules/, and neither is this one).
  //
  // ⚠ THE CELL PAINTS ITS NOTE, AND THAT IS THE ONE PLACE THIS FACE DIFFERS
  // FROM KRIA'S. kria's note is POSITIONAL — its NOTE lane is a column of rows
  // and WHICH ROW IS LIT is the pitch — so kria's grid can paint zero text and
  // lose nothing. numpadPlus stores an ABSOLUTE MIDI int per step and its grid
  // is one cell per step, so there is no position that encodes the pitch:
  // remove the text and a recorded pattern becomes sixteen indistinguishable
  // lit squares. Against the resting-text ruling's own three questions, `c#4`
  // is not a quantity (it is a pitch NAME, the same category as TRI or WET), it
  // restates no dial position (there is no dial), and it is the ONLY thing
  // separating sixteen otherwise-identical cells. That is the tidyVco A/D/S/R
  // argument applied to a roster of pitches.
  //
  // ⚠ AND WHAT IS REFUSED INSIDE THE SAME PANEL, so the ruling has a boundary
  // rather than an escape hatch: no step NUMBER (a count — the grid's shape
  // already says where you are), no playhead index (the moving highlight IS the
  // picture), no REC/PLAY word, no bar/beat readout, no tick count.
  //
  // ⚠ NO `control-<paramId>` TESTID (shell-cells rule 1) — everything this
  // panel edits is `node.data`, which is precisely why it is a panel.

  import { patch } from '$lib/graph/store';
  import { nodeVersion } from '$lib/graph/node-versions.svelte';
  import { onMeterFrame } from '$lib/ui/meter-frame';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import { noteNameForMidi } from '$lib/audio/note-entry';
  import {
    coerceLayers,
    defaultLayers,
    resolveActiveLayer,
    NUMPAD_PLUS_STEPS,
    type NumpadLayer,
  } from '$lib/audio/modules/numpad-plus';
  import {
    nudgeNumpadStepNote,
    toggleNumpadStep,
  } from '$lib/audio/modules/numpad-plus-writes';

  interface Props {
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  // ⚠ KEYED ON `nodeVersion`. The live Yjs node is a proxy whose IDENTITY never
  // changes, so a `$derived` reading straight off it would recompute never —
  // the graph would be correct and this panel frozen.
  let live = $derived.by(() => ({ v: nodeVersion(nodeId), n: patch.nodes[nodeId] as ModuleNode | undefined }));
  let layers = $derived.by<NumpadLayer[]>(() => {
    const raw = (live.n?.data as Record<string, unknown> | undefined)?.layers;
    return raw ? coerceLayers(raw) : defaultLayers();
  });
  let octave = $derived.by(() => {
    const v = live.n?.params?.octave;
    return typeof v === 'number' ? v : 4;
  });

  // The ACTIVE layer follows the same priority the engine uses: the layer CV
  // wins while patched, otherwise the param. The engine is the authority (it is
  // the only thing that samples the CV), and the param is the fallback when no
  // engine is mounted — a doc sandbox, or a dock opened before the audio gate.
  let paramLayer = $derived.by(() => {
    const v = live.n?.params?.activeLayer;
    return typeof v === 'number' ? v : 0;
  });
  let activeLayer = $state(0);
  $effect(() => {
    activeLayer = resolveActiveLayer(paramLayer, null);
  });

  // The PLAYHEAD and the ACTIVE LAYER, on the SHARED frame pump (never a
  // private rAF). `useEngine` degrades to a null getter when the shell has not
  // provided the context, so with no engine this simply does not move rather
  // than throwing.
  //
  // ⚠ DETERMINISTIC AT REST BY CONSTRUCTION, which is what lets this face be
  // baselined: `isPlaying` defaults to 0, so a fresh spawn is STOPPED and
  // `stepIndex` holds at 0. The highlight is gated on the transport, so nothing
  // on this panel moves until a player presses PLAY.
  let playStep = $state(-1);
  let gridEl = $state<HTMLElement | null>(null);
  $effect(() => {
    const h = onMeterFrame(gridEl, () => {
      const e = engineCtx.get();
      const n = patch.nodes[nodeId] as ModuleNode | undefined;
      if (!e || !n) return;
      const al = e.read(n, 'activeLayer');
      if (typeof al === 'number' && al !== activeLayer) activeLayer = al;
      const running = typeof n.params?.isPlaying === 'number' && n.params.isPlaying >= 0.5;
      const si = e.read(n, 'stepIndex');
      playStep = running && typeof si === 'number' ? si : -1;
    });
    return () => h.stop();
  });

  function stepAt(s: number) {
    return layers[activeLayer]?.[s] ?? { on: false, midi: null };
  }
  /** The painted note: a pitch NAME when the step is lit, a dot when it is not. */
  function cellLabel(s: number): string {
    const step = stepAt(s);
    if (!step.on) return '·';
    return step.midi === null ? '—' : noteNameForMidi(step.midi);
  }
  /** The step's state as an ACCESSIBLE NAME — an addition, not a weakening. The
   *  legacy card's cell was `Step 3` and the note lived in the painted text and
   *  NOWHERE else, so a spec proving this face tracks the graph could not read
   *  it. Now it can. */
  function cellName(s: number): string {
    const step = stepAt(s);
    if (!step.on) return `step ${s + 1} — off`;
    if (step.midi === null) return `step ${s + 1} — no note`;
    const voices = step.midis && step.midis.length > 1
      ? ` (${step.midis.length} voices)`
      : '';
    return `step ${s + 1} — ${noteNameForMidi(step.midi)}${voices}`;
  }

  // ── CLICK toggles; DRAG up/down changes the note ─────────────────────────
  //
  // ⚠ THE DRAG IS AN ADDITION, NOT A RESTORATION. The def's own
  // `docs.controls['numpad-cell-{n}']` promised "click-and-dragging up/down on
  // the cell changes its note by hand" and the legacy card's header said the
  // same — and the cell had `onclick` and nothing else. `module-docs-lint` reads
  // the DEF, so a def promising what its card does not implement was invisible
  // to it in exactly the direction that matters.
  const DRAG_PX_PER_SEMITONE = 6;
  let drag = $state<{ step: number; y0: number; applied: number } | null>(null);

  function onPointerDown(ev: PointerEvent, s: number) {
    if (ev.button !== 0) return;
    (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
    drag = { step: s, y0: ev.clientY, applied: 0 };
  }
  function onPointerMove(ev: PointerEvent) {
    if (!drag) return;
    const want = Math.round((drag.y0 - ev.clientY) / DRAG_PX_PER_SEMITONE);
    if (want === drag.applied) return;
    const delta = want - drag.applied;
    drag.applied = want;
    nudgeNumpadStepNote(nodeId, activeLayer, drag.step, delta, octave);
  }
  function onPointerUp(ev: PointerEvent, s: number) {
    (ev.currentTarget as HTMLElement).releasePointerCapture?.(ev.pointerId);
    const moved = drag?.applied ?? 0;
    drag = null;
    // A press that never moved is a CLICK — toggle. A press that moved has
    // already written its note, and toggling it off again would undo the edit
    // the player just made.
    if (moved === 0) toggleNumpadStep(nodeId, activeLayer, s, octave);
  }
</script>

<div class="np-grid-panel" data-testid="numpad-step-grid-panel">
  <div
    class="grid"
    bind:this={gridEl}
    data-testid="numpad-step-grid"
    role="grid"
    aria-label={`layer ${activeLayer + 1} steps`}
  >
    {#each Array(NUMPAD_PLUS_STEPS) as _s, s (s)}
      <button
        type="button"
        class="cell nodrag"
        class:on={stepAt(s).on}
        class:head={s === playStep}
        role="gridcell"
        data-step={s}
        data-testid={`numpad-cell-${s}`}
        aria-label={cellName(s)}
        onpointerdown={(e) => onPointerDown(e, s)}
        onpointermove={onPointerMove}
        onpointerup={(e) => onPointerUp(e, s)}
        onpointercancel={() => { drag = null; }}
      >{cellLabel(s)}</button>
    {/each}
  </div>
</div>

<style>
  .np-grid-panel { display: flex; flex-direction: column; gap: 5px; width: max-content; }
  .grid {
    display: grid;
    grid-template-columns: repeat(4, 36px);
    gap: 3px;
    border: 1px solid var(--border, #3a4048);
    border-radius: 6px;
    background: var(--control-bg, #151a21);
    padding: 4px;
    width: max-content;
  }
  .cell {
    appearance: none;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 26px;
    padding: 0;
    border-radius: 2px;
    background: #0a0d11;
    border: 1px solid #262c34;
    color: var(--text-dim, #4d545e);
    font-family: ui-monospace, monospace;
    font-size: 8.6px;
    letter-spacing: -0.01em;
    cursor: ns-resize;
    touch-action: none;
  }
  .cell:hover { border-color: var(--accent, #6cf); }
  .cell.on {
    background: var(--cable-gate, #ffd000);
    border-color: var(--cable-gate, #ffd000);
    color: #0b0d11;
    font-weight: 700;
  }
  .cell.head { outline: 2px solid var(--accent, #6cf); outline-offset: -1px; }
</style>
