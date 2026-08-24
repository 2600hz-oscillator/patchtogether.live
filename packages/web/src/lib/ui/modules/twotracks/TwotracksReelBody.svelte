<script lang="ts">
  // TwotracksReelBody — the faceplate's two reel pictures.
  //
  // See `shell-extension.ts` beside this file for WHY this is a body rather
  // than a panel, why it shows both reels rather than the active tab's, and why
  // the SCREEN switch is here and unguarded.
  //
  // ⚠ THE TWO GESTURES ON ONE CANVAS GO TO DIFFERENT SEAMS, and preserving that
  // split exactly is the point of this component:
  //
  //   * dragging a START / END marker writes `start_*` / `end_*` through
  //     `setNodeParam` — a DURABLE SETTING, so it is undoable and synced;
  //   * dragging anywhere else scrubs the PLAYHEAD via a `{type:'seek'}` engine
  //     message — TRANSIENT PERFORMANCE STATE, in neither the Y.Doc nor the
  //     undo stack.
  //
  // Collapsing them would put a frame-rate cursor into the document, which is
  // the CV write-storm class this repo has a standing rule against. The card
  // got this right and the face must not lose it.

  import { patch } from '$lib/graph/store';
  import { setNodeParam, mutateNode } from '$lib/graph/mutate';
  import { useEngine } from '$lib/audio/engine-context';
  import type { ModuleNode } from '$lib/graph/types';
  import { onMeterFrame } from '$lib/ui/meter-frame';
  import {
    twotracksDef,
    clampLoopStart,
    clampLoopEnd,
    type TwoTracksData,
  } from '$lib/audio/modules/twotracks';
  import {
    drawTwotracksReel,
    twotracksHandleHit,
    twotracksPosToFrac,
    type TwotracksReelView,
  } from '../twotracks-waveform-draw';
  import { twotracksSeek, twotracksScrubVelocity, type TwotracksReel } from '../twotracks-face-actions';

  interface Props {
    /** The graph node this faceplate is showing — the ONLY prop the slot gets
     *  (`ShellExtensionFullViewBodyProps`). It is also the reason this body
     *  cannot follow the active tab; see shell-extension.ts. */
    nodeId: string;
  }
  let { nodeId }: Props = $props();

  const engineCtx = useEngine();

  let node = $derived(patch.nodes[nodeId] as ModuleNode | undefined);
  let data = $derived(node?.data as TwoTracksData | undefined);

  const defaultFor = (k: string): number =>
    twotracksDef.params.find((p) => p.id === k)?.defaultValue ?? 0;

  // ⚠ ABSENT ⇒ false ⇒ the picture is ON, so a rack saved before this face
  // existed opens exactly as it did. On `node.data` and never component
  // `$state`: a dock LRU eviction or a pane close unmounts this component, and
  // component state would silently re-open the picture the player shut.
  //
  // ⚠ READ IN ONE EXPRESSION STRAIGHT OFF THE STORE, exactly as scope's body
  // does, and NOT through the `data` derived above. Routing it through an
  // intermediate `$derived` made the switch DEAD ON A FRESH SPAWN: a bare
  // twotracks has no `node.data` at all (the engine creates it only when the
  // worklet first posts a transport message, which needs a running context), so
  // the intermediate memoised `undefined` and never re-ran when the toggle
  // created the object. The click wrote through and the button never moved.
  // Caught by `face-screen-render.spec.ts`, which is the only thing that could
  // have: every source-level assertion about this switch passed the whole time.
  let previewCollapsed = $derived<boolean>(
    (patch.nodes[nodeId]?.data?.previewCollapsed as boolean | undefined) ?? false,
  );

  function togglePreview(): void {
    const next = !previewCollapsed;
    mutateNode(nodeId, (live) => {
      if (!live.data) live.data = {};
      (live.data as TwoTracksData).previewCollapsed = next;
    });
  }

  // ── Per-frame engine state ────────────────────────────────────────────────
  // Peaks and playhead are volatile render state pulled off the engine, exactly
  // as the card pulls them. They are NEVER written to the node.
  let peaksA = $state<Float32Array | null>(null);
  let peaksB = $state<Float32Array | null>(null);
  let playheadA = $state(0);
  let playheadB = $state(0);

  let wrapEl: HTMLDivElement | null = $state(null);
  let canvasElA: HTMLCanvasElement | null = $state(null);
  let canvasElB: HTMLCanvasElement | null = $state(null);

  // ⚠ THE GATE ELEMENT IS THE WRAPPER, NOT A CANVAS, and that is deliberate:
  // when the picture is collapsed the canvases are not in the DOM, and an
  // IntersectionObserver watching a removed element would never report — the
  // read would stop for the wrong reason and the picture would be stale on
  // re-open. The wrapper is always mounted.
  //
  // ⚠ AND THE READ IS UNCONDITIONAL WHILE THE COLLAPSE SKIPS ONLY THE PAINT.
  // That ORDER is the whole SCREEN-OFF contract — the module goes on rendering
  // while the picture is off, so switching it back on shows the LIVE tape
  // rather than the frame it was wearing when it shut.
  $effect(() => {
    const gateEl = wrapEl;
    const handle = onMeterFrame(gateEl, () => {
      const eng = engineCtx.get();
      const n = node;
      if (!eng || !n) return;
      const pA = eng.read(n, 'peaksA') as Float32Array | null;
      const pB = eng.read(n, 'peaksB') as Float32Array | null;
      if (pA !== peaksA) peaksA = pA;
      if (pB !== peaksB) peaksB = pB;
      const hA = eng.read(n, 'playheadA') as number | undefined;
      const hB = eng.read(n, 'playheadB') as number | undefined;
      if (typeof hA === 'number' && hA !== playheadA) playheadA = hA;
      if (typeof hB === 'number' && hB !== playheadB) playheadB = hB;
    });
    return () => handle.stop();
  });

  // ── Params ────────────────────────────────────────────────────────────────
  let startA = $derived(node?.params.start_a ?? defaultFor('start_a'));
  let endA = $derived(node?.params.end_a ?? defaultFor('end_a'));
  let startB = $derived(node?.params.start_b ?? defaultFor('start_b'));
  let endB = $derived(node?.params.end_b ?? defaultFor('end_b'));

  let bufLenA = $derived(data?.bufLenA ?? 0);
  let bufLenB = $derived(data?.bufLenB ?? 0);

  // While a reel is rolling AND has tape, a loop handle cannot be dragged past
  // the playhead — it must stay inside [start,end]. Idle, the playhead resets to
  // the window start on the next PLAY, so dragging is free (clamp arg = null).
  // Same rule the card applies, through the same two pure clamps.
  let rollingA = $derived((data?.transportState_a ?? 'idle') !== 'idle' && bufLenA > 0);
  let rollingB = $derived((data?.transportState_b ?? 'idle') !== 'idle' && bufLenB > 0);

  // ── Drag state ────────────────────────────────────────────────────────────
  let dragA = $state<'start' | 'end' | 'playhead' | null>(null);
  let dragB = $state<'start' | 'end' | 'playhead' | null>(null);
  let localPlayheadA = $state(0);
  let localPlayheadB = $state(0);
  let prevXA = 0;
  let prevXB = 0;

  let shownPlayheadA = $derived(dragA === 'playhead' ? localPlayheadA : playheadA);
  let shownPlayheadB = $derived(dragB === 'playhead' ? localPlayheadB : playheadB);

  function viewFor(reel: TwotracksReel): TwotracksReelView {
    return reel === 'a'
      ? { peaks: peaksA, bufLen: bufLenA, playheadFrac: shownPlayheadA, startFrac: startA, endFrac: endA }
      : { peaks: peaksB, bufLen: bufLenB, playheadFrac: shownPlayheadB, startFrac: startB, endFrac: endB };
  }

  function setStart(reel: TwotracksReel, frac: number): void {
    if (reel === 'a') setNodeParam(nodeId, 'start_a', clampLoopStart(frac, endA, rollingA ? shownPlayheadA : null));
    else setNodeParam(nodeId, 'start_b', clampLoopStart(frac, endB, rollingB ? shownPlayheadB : null));
  }
  function setEnd(reel: TwotracksReel, frac: number): void {
    if (reel === 'a') setNodeParam(nodeId, 'end_a', clampLoopEnd(frac, startA, rollingA ? shownPlayheadA : null));
    else setNodeParam(nodeId, 'end_b', clampLoopEnd(frac, startB, rollingB ? shownPlayheadB : null));
  }

  function canvasFor(reel: TwotracksReel): HTMLCanvasElement | null {
    return reel === 'a' ? canvasElA : canvasElB;
  }

  function onDown(reel: TwotracksReel, e: PointerEvent): void {
    e.stopPropagation();
    const el = canvasFor(reel);
    if (!el) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const wpx = el.clientWidth || el.width;
    const frac = twotracksPosToFrac(e.offsetX, wpx);
    const v = viewFor(reel);
    const hit = twotracksHandleHit(frac, v.startFrac, v.endFrac, wpx);
    if (reel === 'a') { dragA = hit; prevXA = e.offsetX; } else { dragB = hit; prevXB = e.offsetX; }
    if (hit === 'start') { setStart(reel, frac); return; }
    if (hit === 'end') { setEnd(reel, frac); return; }
    if (reel === 'a') localPlayheadA = frac; else localPlayheadB = frac;
  }

  function onMove(reel: TwotracksReel, e: PointerEvent): void {
    const drag = reel === 'a' ? dragA : dragB;
    if (!drag) return;
    e.stopPropagation();
    const el = canvasFor(reel);
    if (!el) return;
    const wpx = el.clientWidth || el.width;
    const frac = twotracksPosToFrac(e.offsetX, wpx);
    if (drag === 'start') { setStart(reel, frac); return; }
    if (drag === 'end') { setEnd(reel, frac); return; }
    // Scrubbing: keep the cursor local and tell the worklet how fast the hand
    // is moving, so it pitches the tape the way a hand on a reel would.
    const prevX = reel === 'a' ? prevXA : prevXB;
    const velocity = Math.min(10, (Math.abs(e.offsetX - prevX) / Math.max(1, wpx)) * 50);
    if (reel === 'a') { localPlayheadA = frac; prevXA = e.offsetX; } else { localPlayheadB = frac; prevXB = e.offsetX; }
    twotracksScrubVelocity(nodeId, reel, velocity);
  }

  function onUp(reel: TwotracksReel, e: PointerEvent): void {
    const drag = reel === 'a' ? dragA : dragB;
    if (!drag) return;
    e.stopPropagation();
    if (reel === 'a') dragA = null; else dragB = null;
    if (drag !== 'playhead') return;
    const el = canvasFor(reel);
    const wpx = (el?.clientWidth || el?.width) ?? 1;
    const frac = twotracksPosToFrac(e.offsetX, wpx);
    if (reel === 'a') localPlayheadA = frac; else localPlayheadB = frac;
    // ⚠ A SEEK, NOT A PARAM. The playhead never enters the document.
    twotracksSeek(nodeId, reel, frac);
    twotracksScrubVelocity(nodeId, reel, 0);
  }

  // ── The paint ─────────────────────────────────────────────────────────────
  // ⚠ THE COLLAPSE BAIL IS HERE AND ONLY HERE — the engine read above runs
  // whatever the switch says. Reversing that would make SCREEN OFF stop the
  // module's picture from tracking, and re-opening would show a stale tape.
  $effect(() => {
    if (previewCollapsed) return;
    drawTwotracksReel(canvasElA, viewFor('a'));
    drawTwotracksReel(canvasElB, viewFor('b'));
  });
</script>

<div class="tt-body" bind:this={wrapEl} data-testid="twotracks-reel-body" data-node-id={nodeId}>
  <button
    type="button"
    class="tt-screen nodrag"
    class:on={!previewCollapsed}
    data-testid="twotracks-face-screen-toggle"
    aria-pressed={!previewCollapsed}
    title={previewCollapsed
      ? 'SCREEN is OFF — the reel pictures are collapsed and their space reclaimed. Both reels go on recording and playing: switching it back on shows the LIVE tape, not a stale frame.'
      : 'SCREEN — turn the reel pictures off to collapse them and reclaim the vertical space. Both reels go on running either way.'}
    onclick={togglePreview}
  >{previewCollapsed ? 'SCREEN OFF' : 'SCREEN ON'}</button>

  {#if !previewCollapsed}
    <!-- ⚠ `twotracks-face-reels` IS THE ELEMENT THE SCREEN SWITCH REMOVES, and
         it is named for `face-screen-render.spec.ts`'s `canvas` override. There
         is deliberately no `twotracks-face-canvas` for that spec's default to
         find: this body paints TWO reels, so a single conventionally-named
         canvas would have to be one of them and the assertion would go blind to
         the other. This container is what the `{#if}` actually adds and
         removes. -->
    <div class="tt-reels" data-testid="twotracks-face-reels">
      <div class="tt-reel">
        <span class="tt-reel-label">A</span>
        <canvas
          bind:this={canvasElA}
          class="tt-canvas nodrag"
          width={512}
          height={56}
          data-testid="twotracks-face-canvas-a"
          data-node-id={nodeId}
          aria-label="Reel A tape — drag the START or END marker to set the loop window, drag elsewhere to scrub the playhead"
          onpointerdown={(e) => onDown('a', e)}
          onpointermove={(e) => onMove('a', e)}
          onpointerup={(e) => onUp('a', e)}
          onpointercancel={(e) => onUp('a', e)}
        ></canvas>
      </div>
      <div class="tt-reel">
        <span class="tt-reel-label">B</span>
        <canvas
          bind:this={canvasElB}
          class="tt-canvas nodrag"
          width={512}
          height={56}
          data-testid="twotracks-face-canvas-b"
          data-node-id={nodeId}
          aria-label="Reel B tape — drag the START or END marker to set the loop window, drag elsewhere to scrub the playhead"
          onpointerdown={(e) => onDown('b', e)}
          onpointermove={(e) => onMove('b', e)}
          onpointerup={(e) => onUp('b', e)}
          onpointercancel={(e) => onUp('b', e)}
        ></canvas>
      </div>
    </div>
  {/if}
</div>

<style>
  .tt-body {
    display: flex;
    flex-direction: column;
    gap: 4px;
    width: 100%;
  }
  .tt-screen {
    align-self: flex-end;
    font: 600 8px/1 ui-monospace, monospace;
    letter-spacing: 0.08em;
    padding: 2px 6px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.04);
    color: #7d8598;
    cursor: pointer;
  }
  .tt-screen.on {
    color: #cfd6e6;
    border-color: rgba(255, 160, 60, 0.5);
  }
  .tt-reels {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .tt-reel {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  /* The reel NAME. A caption on the surface it labels — it disambiguates two
     otherwise-identical pictures, which is exactly the permitted role. */
  .tt-reel-label {
    font: 600 9px/1 ui-monospace, monospace;
    color: #7d8598;
    width: 8px;
    flex: 0 0 auto;
  }
  .tt-canvas {
    flex: 1 1 auto;
    min-width: 0;
    height: 56px;
    display: block;
    border-radius: 2px;
    touch-action: none;
    cursor: ew-resize;
  }
</style>
